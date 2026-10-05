package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"stratum/config"
	"stratum/impute"
	"stratum/openalex"
	"stratum/tfidf"

	"github.com/extrame/xls"
	"github.com/xuri/excelize/v2"
)

// =====================================================================
// Search, Topic Exploration, Query Generation, and Configuration
// =====================================================================

// ConfigRevision represents a versioned snapshot of keywords, topics, and anchors.
type ConfigRevision struct {
	Version   int    `json:"version"`
	Timestamp string `json:"timestamp"`
	Label     string `json:"label"`
	Keywords  string `json:"keywords"`
	Topics    string `json:"topics"`
	Anchors   string `json:"anchors"`
}

func loadConfigHistory(dbConn *sql.DB) ([]ConfigRevision, error) {
	rows, err := dbConn.Query(`SELECT version, timestamp, label, keywords, topics, anchors 
		FROM config_history ORDER BY version ASC`)
	if err != nil {
		return []ConfigRevision{}, nil
	}
	defer rows.Close()

	var list []ConfigRevision
	for rows.Next() {
		var rev ConfigRevision
		err = rows.Scan(&rev.Version, &rev.Timestamp, &rev.Label, &rev.Keywords, &rev.Topics, &rev.Anchors)
		if err != nil {
			return []ConfigRevision{}, nil
		}
		list = append(list, rev)
	}
	if list == nil {
		list = []ConfigRevision{}
	}
	return list, nil
}

func (s *APIServer) appendConfigRevision(dbConn *sql.DB, keywords, topics, anchors, label string) error {
	list, err := loadConfigHistory(dbConn)
	if err != nil {
		list = []ConfigRevision{}
	}

	nextVersion := 1
	if len(list) > 0 {
		nextVersion = list[len(list)-1].Version + 1
	}

	if label == "" {
		label = fmt.Sprintf("Revision #%d", nextVersion)
	}

	timestamp := time.Now().Format(time.RFC3339)

	_, err = dbConn.Exec(`INSERT INTO config_history (version, timestamp, label, keywords, topics, anchors) 
		VALUES (?, ?, ?, ?, ?, ?)`,
		nextVersion, timestamp, label, keywords, topics, anchors)
	return err
}

func (s *APIServer) handleConfig(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	if r.Method == http.MethodGet {
		project := r.URL.Query().Get("project")
		configDBPath, _, jsonlDir, dbDir, _ := s.getProjectPaths(project)
		s.ensureProjectDirs(project)

		configDB, err := s.getConfigDB(project)
		if err != nil {
			http.Error(w, "Failed to connect to config DB: "+err.Error(), http.StatusInternalServerError)
			return
		}

		historyList, _ := loadConfigHistory(configDB)
		if historyList == nil {
			historyList = []ConfigRevision{}
		}

		versionStr := r.URL.Query().Get("version")
		if versionStr != "" {
			var version int
			if _, err := fmt.Sscanf(versionStr, "%d", &version); err == nil {
				var keywords, topics, anchors string
				row := configDB.QueryRow(`SELECT keywords, topics, anchors FROM config_history 
					WHERE version = ?`, version)
				err := row.Scan(&keywords, &topics, &anchors)
				if err == nil {
					cfg, err := config.LoadConfig(configDBPath)
					if err == nil {
						cfg.Keywords = keywords
						cfg.Topics = strings.Split(topics, "\n")
						cfg.Anchors = strings.Split(anchors, "\n")
						cfg.Output.JSONLDir = jsonlDir
						cfg.Output.DBDir = dbDir

						response := map[string]interface{}{
							"config":   cfg,
							"keywords": keywords,
							"topics":   topics,
							"anchors":  anchors,
							"history":  historyList,
						}
						json.NewEncoder(w).Encode(response)
						return
					}
				}
			}
		}

		cfg, err := config.LoadConfig(configDBPath)
		if err != nil {
			http.Error(w, "Failed to load config: "+err.Error(), http.StatusInternalServerError)
			return
		}

		cfg.Output.JSONLDir = jsonlDir
		cfg.Output.DBDir = dbDir

		topicsStr := strings.Join(cfg.Topics, "\n")
		anchorsStr := strings.Join(cfg.Anchors, "\n")

		response := map[string]interface{}{
			"config":   cfg,
			"keywords": cfg.Keywords,
			"topics":   topicsStr,
			"anchors":  anchorsStr,
			"history":  historyList,
		}
		json.NewEncoder(w).Encode(response)
		return
	}

	if r.Method == http.MethodPost {
		var payload struct {
			Config   config.AppConfig `json:"config"`
			Keywords string           `json:"keywords"`
			Topics   string           `json:"topics"`
			Anchors  string           `json:"anchors"`
			Label    string           `json:"label"`
		}

		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			http.Error(w, "Invalid request body: "+err.Error(), http.StatusBadRequest)
			return
		}

		// Strictly validate search keywords query
		errs := openalex.ValidateKeywords(payload.Keywords)
		if len(errs) > 0 {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]interface{}{
				"error":  "Strict keyword validation failed",
				"errors": errs,
			})
			return
		}

		project := r.URL.Query().Get("project")
		configDBPath, _, jsonlDir, dbDir, _ := s.getProjectPaths(project)
		s.ensureProjectDirs(project)

		configDB, err := s.getConfigDB(project)
		if err != nil {
			http.Error(w, "Failed to connect to config DB: "+err.Error(), http.StatusInternalServerError)
			return
		}

		// Parse newline-separated topics/anchors into slices
		var topicsList []string
		for _, t := range strings.Split(payload.Topics, "\n") {
			t = strings.TrimSpace(t)
			if t != "" {
				topicsList = append(topicsList, t)
			}
		}

		var anchorsList []string
		for _, a := range strings.Split(payload.Anchors, "\n") {
			a = strings.TrimSpace(a)
			if a != "" {
				anchorsList = append(anchorsList, a)
			}
		}

		// Constrain anchors to max 385
		if len(anchorsList) > 385 {
			anchorsList = anchorsList[:385]
			payload.Anchors = strings.Join(anchorsList, "\n")
		}

		payload.Config.Keywords = payload.Keywords
		payload.Config.Topics = topicsList
		payload.Config.Anchors = anchorsList
		payload.Config.Output.JSONLDir = jsonlDir
		payload.Config.Output.DBDir = dbDir

		// Save config to DB
		if err := config.SaveConfig(configDBPath, &payload.Config); err != nil {
			http.Error(w, "Failed to save config to DB: "+err.Error(), http.StatusInternalServerError)
			return
		}

		// Append revision to history in DB
		_ = s.appendConfigRevision(configDB, payload.Keywords, payload.Topics, payload.Anchors, payload.Label)

		// Sync physical keywords.txt and topics.txt to disk
		s.exportProjectMetadataFiles(project)

		w.Write([]byte(`{"status": "success"}`))
		return
	}

	http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
}

func (s *APIServer) handleUpload(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		http.Error(w, `{"error": "Method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	// Limit upload size to 10MB
	r.ParseMultipartForm(10 << 20)

	file, handler, err := r.FormFile("file")
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "Failed to retrieve file from form: " + err.Error()})
		return
	}
	defer file.Close()

	ext := strings.ToLower(filepath.Ext(handler.Filename))
	if ext != ".csv" && ext != ".xlsx" && ext != ".xls" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "Unsupported file format. Please upload a .csv, .xlsx, or .xls file."})
		return
	}

	project := r.URL.Query().Get("project")
	_, _, _, _, uploadDir := s.getProjectPaths(project)
	if err := os.MkdirAll(uploadDir, 0755); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": "Failed to create uploads directory: " + err.Error()})
		return
	}

	// Save file to disk
	safeName := fmt.Sprintf("upload_%d%s", time.Now().UnixNano(), ext)
	filePath := filepath.Join(uploadDir, safeName)
	dst, err := os.Create(filePath)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": "Failed to create destination file: " + err.Error()})
		return
	}
	defer dst.Close()

	if _, err := io.Copy(dst, file); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": "Failed to write file to disk: " + err.Error()})
		return
	}

	// Extract headers and row count
	var headers []string
	var rowCount int
	if ext == ".csv" {
		headers, rowCount, err = parseCSVHeadersAndCount(filePath)
	} else {
		headers, rowCount, err = parseExcelHeadersAndCount(filePath)
	}

	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "Failed to parse file headers: " + err.Error()})
		return
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"filename":  safeName,
		"columns":   headers,
		"row_count": rowCount,
	})
}

func parseCSVHeadersAndCount(filePath string) ([]string, int, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()

	reader := csv.NewReader(f)
	reader.LazyQuotes = true
	reader.FieldsPerRecord = -1

	rows, err := reader.ReadAll()
	if err != nil {
		return nil, 0, err
	}
	if len(rows) == 0 {
		return nil, 0, fmt.Errorf("empty file")
	}
	return rows[0], len(rows) - 1, nil // subtract header row
}

func parseExcelHeadersAndCount(filePath string) ([]string, int, error) {
	if strings.HasSuffix(strings.ToLower(filePath), ".xls") {
		rows, err := parseXLSRows(filePath)
		if err != nil {
			return nil, 0, err
		}
		if len(rows) == 0 {
			return nil, 0, fmt.Errorf("empty sheet")
		}
		return rows[0], len(rows) - 1, nil
	}

	f, err := excelize.OpenFile(filePath)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()

	sheets := f.GetSheetList()
	if len(sheets) == 0 {
		return nil, 0, fmt.Errorf("no sheets found in Excel file")
	}
	rows, err := f.GetRows(sheets[0])
	if err != nil {
		return nil, 0, err
	}
	if len(rows) == 0 {
		return nil, 0, fmt.Errorf("empty sheet")
	}
	return rows[0], len(rows) - 1, nil
}

func parseCSVHeaders(filePath string) ([]string, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	reader := csv.NewReader(f)
	reader.LazyQuotes = true
	reader.FieldsPerRecord = -1
	headers, err := reader.Read()
	if err != nil {
		return nil, err
	}
	return headers, nil
}

func parseXLSRows(filePath string) ([][]string, error) {
	xlFile, err := xls.Open(filePath, "utf-8")
	if err != nil {
		return nil, err
	}
	sheet := xlFile.GetSheet(0)
	if sheet == nil {
		return nil, fmt.Errorf("no sheets found in Excel file")
	}

	var rows [][]string
	for i := 0; i <= int(sheet.MaxRow); i++ {
		row := sheet.Row(i)
		if row == nil {
			rows = append(rows, []string{})
			continue
		}
		colsCount := row.LastCol()
		rowCells := make([]string, colsCount)
		for j := 0; j < colsCount; j++ {
			rowCells[j] = row.Col(j)
		}
		rows = append(rows, rowCells)
	}
	return rows, nil
}

func parseExcelHeaders(filePath string) ([]string, error) {
	if strings.HasSuffix(strings.ToLower(filePath), ".xls") {
		rows, err := parseXLSRows(filePath)
		if err != nil {
			return nil, err
		}
		if len(rows) == 0 {
			return nil, fmt.Errorf("empty sheet")
		}
		return rows[0], nil
	}

	f, err := excelize.OpenFile(filePath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	sheets := f.GetSheetList()
	if len(sheets) == 0 {
		return nil, fmt.Errorf("no sheets found in Excel file")
	}
	rows, err := f.GetRows(sheets[0])
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("empty sheet")
	}
	return rows[0], nil
}

func (s *APIServer) handleTFIDF(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		http.Error(w, `{"error": "Method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Filename       string   `json:"filename"`
		TitleColumn    string   `json:"title_column"`
		AbstractColumn string   `json:"abstract_column"`
		DOIColumn      string   `json:"doi_column"`
		TopN           int      `json:"top_n"`
		NgramMin       int      `json:"ngram_min"`
		NgramMax       int      `json:"ngram_max"`
		MinDF          int      `json:"min_df"`
		MaxDF          float64  `json:"max_df"`
		UseKeyBERT     bool     `json:"use_keybert"`
		KeyBERTModel   string   `json:"keybert_model"`
		CandidatePool  int      `json:"candidate_pool"`
		Alpha          *float64 `json:"alpha"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid request body: " + err.Error()})
		return
	}

	if req.Filename == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "filename parameter is required"})
		return
	}

	// Apply defaults if empty
	if req.TopN <= 0 {
		req.TopN = 50
	}
	if req.NgramMin <= 0 {
		req.NgramMin = 2
	}
	if req.NgramMax <= 0 {
		req.NgramMax = 3
	}
	if req.MinDF <= 0 {
		req.MinDF = 2
	}
	if req.MaxDF <= 0.0 {
		req.MaxDF = 0.85
	}

	project := r.URL.Query().Get("project")
	configDBPath, _, _, _, uploadsDir := s.getProjectPaths(project)

	filePath := filepath.Join(uploadsDir, req.Filename)
	ext := strings.ToLower(filepath.Ext(filePath))

	var docs []string
	var err error
	if ext == ".csv" {
		docs, err = loadCSVDocuments(filePath, req.TitleColumn, req.AbstractColumn)
	} else {
		docs, err = loadExcelDocuments(filePath, req.TitleColumn, req.AbstractColumn)
	}

	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "Failed to extract documents: " + err.Error()})
		return
	}

	// Extract DOIs if DOI column is provided
	var dois []string
	if req.DOIColumn != "" {
		if ext == ".csv" {
			dois, err = extractDOIsFromCSV(filePath, req.DOIColumn)
		} else {
			dois, err = extractDOIsFromExcel(filePath, req.DOIColumn)
		}
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{"error": "Failed to extract DOIs: " + err.Error()})
			return
		}

		if len(dois) > 0 {
			if len(dois) > 385 {
				dois = dois[:385]
			}
			cfg, err := config.LoadConfig(configDBPath)
			if err == nil {
				cfg.Anchors = dois
				_ = config.SaveConfig(configDBPath, cfg)
			}
		}
	}

	var keywords []tfidf.ScoredTerm
	if req.UseKeyBERT {
		poolSize := req.CandidatePool
		if poolSize <= 0 {
			poolSize = 20
		}
		if req.TopN <= 0 {
			req.TopN = poolSize
		}
		if req.TopN > poolSize {
			req.TopN = poolSize
		}
		candidates := tfidf.ExtractKeywords(docs, req.NgramMin, req.NgramMax, req.MinDF, req.MaxDF, poolSize)
		kbModel := strings.TrimSpace(req.KeyBERTModel)
		if kbModel == "" {
			kbModel = "allenai-specter"
		}
		alpha := 0.1
		if req.Alpha != nil {
			if *req.Alpha >= 0.0 && *req.Alpha <= 1.0 {
				alpha = *req.Alpha
			}
		}
		reRanked, err := runKeyBERTReRanking(r.Context(), docs, candidates, kbModel, alpha)
		if err == nil && len(reRanked) > 0 {
			if len(reRanked) > req.TopN {
				keywords = reRanked[:req.TopN]
			} else {
				keywords = reRanked
			}
		} else {
			if len(candidates) > req.TopN {
				keywords = candidates[:req.TopN]
			} else {
				keywords = candidates
			}
		}
	} else {
		n := req.TopN
		if n <= 0 {
			n = req.CandidatePool
		}
		if n <= 0 {
			n = 20
		}
		keywords = tfidf.ExtractKeywords(docs, req.NgramMin, req.NgramMax, req.MinDF, req.MaxDF, n)
	}

	if keywords == nil {
		keywords = []tfidf.ScoredTerm{}
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"keywords":      keywords,
		"anchors_count": len(dois),
		"use_keybert":   req.UseKeyBERT,
	})
}

func runKeyBERTReRanking(ctx context.Context, docs []string, candidates []tfidf.ScoredTerm, modelName string, alpha float64) ([]tfidf.ScoredTerm, error) {
	pythonBin := findPythonInterpreter()
	scriptPath := filepath.Join("scripts", "keybert_score.py")
	if _, err := os.Stat(scriptPath); err != nil {
		scriptPath = "/run/media/krishnakumar/New Volume/IISC/stratum-core/scripts/keybert_score.py"
	}

	payload := map[string]interface{}{
		"docs":       docs,
		"candidates": candidates,
		"model_name": modelName,
		"alpha":      alpha,
	}

	inputBytes, err := json.Marshal(payload)
	if err != nil {
		return candidates, err
	}

	cmd := exec.CommandContext(ctx, pythonBin, scriptPath)
	cmd.Stdin = bytes.NewReader(inputBytes)
	var outBuf, errBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf

	if err := cmd.Run(); err != nil {
		log.Printf("[KeyBERT] Warning: Python execution failed (%v): %s", err, errBuf.String())
		return candidates, fmt.Errorf("keybert execution failed: %v", err)
	}

	var res struct {
		Keywords []tfidf.ScoredTerm `json:"keywords"`
		Error    string             `json:"error,omitempty"`
	}

	if err := json.Unmarshal(outBuf.Bytes(), &res); err != nil {
		log.Printf("[KeyBERT] Failed to unmarshal JSON output: %v", err)
		return candidates, err
	}

	if len(res.Keywords) > 0 {
		return res.Keywords, nil
	}

	return candidates, nil
}

func loadCSVDocuments(filePath, titleCol, abstractCol string) ([]string, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	reader := csv.NewReader(f)
	reader.LazyQuotes = true
	reader.FieldsPerRecord = -1
	rows, err := reader.ReadAll()
	if err != nil {
		return nil, err
	}
	if len(rows) < 2 {
		return nil, fmt.Errorf("empty file or no data rows")
	}

	headers := rows[0]
	titleIdx, abstractIdx := -1, -1
	for idx, h := range headers {
		if strings.EqualFold(h, titleCol) {
			titleIdx = idx
		}
		if strings.EqualFold(h, abstractCol) {
			abstractIdx = idx
		}
	}

	if titleIdx == -1 && abstractIdx == -1 {
		return nil, fmt.Errorf("neither title column %q nor abstract column %q was found in headers", titleCol, abstractCol)
	}

	var docs []string
	for _, row := range rows[1:] {
		var title, abstract string
		if titleIdx != -1 && titleIdx < len(row) {
			title = strings.TrimSpace(row[titleIdx])
		}
		if abstractIdx != -1 && abstractIdx < len(row) {
			abstract = strings.TrimSpace(row[abstractIdx])
		}
		combined := strings.TrimSpace(title + ". " + abstract)
		if len(combined) >= 20 {
			docs = append(docs, combined)
		}
	}
	return docs, nil
}

func loadExcelDocuments(filePath, titleCol, abstractCol string) ([]string, error) {
	var rows [][]string
	var err error
	if strings.HasSuffix(strings.ToLower(filePath), ".xls") {
		rows, err = parseXLSRows(filePath)
	} else {
		f, errOpen := excelize.OpenFile(filePath)
		if errOpen != nil {
			return nil, errOpen
		}
		defer f.Close()

		sheets := f.GetSheetList()
		if len(sheets) == 0 {
			return nil, fmt.Errorf("no sheets found in Excel file")
		}
		rows, err = f.GetRows(sheets[0])
	}
	if err != nil {
		return nil, err
	}
	if len(rows) < 2 {
		return nil, fmt.Errorf("empty sheet or no data rows")
	}

	headers := rows[0]
	titleIdx, abstractIdx := -1, -1
	for idx, h := range headers {
		if strings.EqualFold(h, titleCol) {
			titleIdx = idx
		}
		if strings.EqualFold(h, abstractCol) {
			abstractIdx = idx
		}
	}

	if titleIdx == -1 && abstractIdx == -1 {
		return nil, fmt.Errorf("neither title column %q nor abstract column %q was found in headers", titleCol, abstractCol)
	}

	var docs []string
	for _, row := range rows[1:] {
		var title, abstract string
		if titleIdx != -1 && titleIdx < len(row) {
			title = strings.TrimSpace(row[titleIdx])
		}
		if abstractIdx != -1 && abstractIdx < len(row) {
			abstract = strings.TrimSpace(row[abstractIdx])
		}
		combined := strings.TrimSpace(title + ". " + abstract)
		if len(combined) >= 20 {
			docs = append(docs, combined)
		}
	}
	return docs, nil
}

func (s *APIServer) handleQueryValidate(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		http.Error(w, `{"error": "Method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Query string `json:"query"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid request body: " + err.Error()})
		return
	}

	errors := openalex.ValidateKeywords(req.Query)
	if len(errors) > 0 {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"valid":  false,
			"errors": errors,
		})
		return
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"valid":  true,
		"errors": []string{},
	})
}

// formatQueryTerm wraps multi-token / hyphenated terms in quotes and trims whitespace.
func formatQueryTerm(term string) string {
	t := strings.TrimSpace(term)
	if t == "" {
		return ""
	}
	t = strings.Trim(t, `"`)
	if strings.Contains(t, " ") || strings.Contains(t, "-") {
		return fmt.Sprintf(`"%s"`, t)
	}
	return t
}

// formatQueryGroup creates a parenthesized OR group of terms.
func formatQueryGroup(terms []string) string {
	if len(terms) == 0 {
		return ""
	}
	var formatted []string
	seen := make(map[string]bool)
	for _, term := range terms {
		t := formatQueryTerm(term)
		lower := strings.ToLower(t)
		if t == "" || seen[lower] {
			continue
		}
		seen[lower] = true
		formatted = append(formatted, t)
	}
	if len(formatted) == 0 {
		return ""
	}
	if len(formatted) == 1 {
		return formatted[0]
	}
	return "(\n    " + strings.Join(formatted, " OR\n    ") + "\n  )"
}

// CompileCategorizedQuery builds the bounded boolean query: (Core OR Methods) OR (Mechanisms AND Applications)
func CompileCategorizedQuery(core, methods, mechanisms, apps []string) string {
	coreGroup := formatQueryGroup(core)
	methodsGroup := formatQueryGroup(methods)
	mechGroup := formatQueryGroup(mechanisms)
	appsGroup := formatQueryGroup(apps)

	var standalone []string
	if coreGroup != "" {
		standalone = append(standalone, coreGroup)
	}
	if methodsGroup != "" {
		standalone = append(standalone, methodsGroup)
	}

	var parts []string
	if len(standalone) > 0 {
		if len(standalone) == 1 {
			parts = append(parts, standalone[0])
		} else {
			parts = append(parts, "(\n  "+strings.Join(standalone, "\n  OR\n  ")+"\n)")
		}
	}

	if mechGroup != "" && appsGroup != "" {
		parts = append(parts, fmt.Sprintf("(\n  %s\n  AND\n  %s\n)", mechGroup, appsGroup))
	}

	if len(parts) == 0 {
		return ""
	}
	if len(parts) == 1 {
		return parts[0]
	}
	return "(\n" + strings.Join(parts, "\nOR\n") + "\n)"
}

func cleanJSONCodeBlock(s string) string {
	s = strings.TrimSpace(s)
	// Remove <think>...</think> tags if present
	if strings.Contains(s, "<think>") && strings.Contains(s, "</think>") {
		re := regexp.MustCompile(`(?s)<think>.*?</think>`)
		s = re.ReplaceAllString(s, "")
		s = strings.TrimSpace(s)
	}
	// Remove markdown code fence if present
	if strings.Contains(s, "```") {
		reCodeFence := regexp.MustCompile("(?s)```(?:json)?(.*?)```")
		if matches := reCodeFence.FindStringSubmatch(s); len(matches) > 1 {
			s = strings.TrimSpace(matches[1])
		}
	}
	// Extract outermost JSON object {...}
	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start != -1 && end != -1 && end > start {
		s = s[start : end+1]
	}
	return strings.TrimSpace(s)
}

func recoverPartialCategories(text string, originalTerms []string) (core, methods, mechanisms, apps []string) {
	extractBucket := func(bucketName string) []string {
		re := regexp.MustCompile(`"` + bucketName + `"\s*:\s*\[(.*?)(\]|$)`)
		matches := re.FindStringSubmatch(text)
		if len(matches) > 1 {
			reItems := regexp.MustCompile(`"([^"]+)"`)
			itemMatches := reItems.FindAllStringSubmatch(matches[1], -1)
			var items []string
			for _, im := range itemMatches {
				t := strings.TrimSpace(im[1])
				if len(im) > 1 && t != "..." && t != "term1" && t != "term2" && t != "term3" && t != "term4" {
					items = append(items, t)
				}
			}
			return items
		}
		return nil
	}

	core = extractBucket("1_core_technology")
	methods = extractBucket("2_methods_tools")
	mechanisms = extractBucket("3_mechanisms")
	apps = extractBucket("4_applications")

	categorized := make(map[string]bool)
	for _, t := range append(append(append(core, methods...), mechanisms...), apps...) {
		categorized[strings.ToLower(strings.TrimSpace(t))] = true
	}

	for _, term := range originalTerms {
		t := strings.TrimSpace(term)
		if t == "" {
			continue
		}
		lower := strings.ToLower(t)
		if categorized[lower] {
			continue
		}
		if containsAnySubstring(lower, "method", "algorithm", "protocol", "circuit", "gate", "platform", "transmon", "cavity", "detector", "architecture", "technique", "tool", "solver", "vqe", "qaoa", "code") {
			methods = append(methods, t)
		} else if containsAnySubstring(lower, "application", "crypto", "security", "sensing", "simulation", "finance", "discovery", "optimization", "communication", "imaging", "radar", "metrology", "routing") {
			apps = append(apps, t)
		} else if containsAnySubstring(lower, "entangle", "coheren", "superpos", "phase", "spin", "fidel", "decay", "relax", "interfer", "tunnel", "polariz", "magnet", "squeez", "noise", "dissipat") {
			mechanisms = append(mechanisms, t)
		} else {
			core = append(core, t)
		}
	}

	return core, methods, mechanisms, apps
}

func containsAnySubstring(s string, substrs ...string) bool {
	for _, sub := range substrs {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}

func (s *APIServer) handleQueryGenerate(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		http.Error(w, `{"error": "Method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Project       string   `json:"project"`
		Terms         []string `json:"terms"`
		Provider      string   `json:"provider"` // "gemini" or "ollama"
		APIKey        string   `json:"api_key"`
		Model         string   `json:"model"`
		OllamaURL     string   `json:"ollama_url"`
		DomainContext string   `json:"domain_context"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid request body: " + err.Error()})
		return
	}

	if len(req.Terms) == 0 {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "No keywords provided to categorize."})
		return
	}

	provider := strings.ToLower(strings.TrimSpace(req.Provider))
	if provider == "" {
		provider = "gemini"
	}

	var llm impute.LLMClient
	if provider == "gemini" {
		apiKey := strings.TrimSpace(req.APIKey)
		if apiKey == "" {
			apiKey = os.Getenv("GEMINI_API_KEY")
		}
		if apiKey == "" {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{
				"error": "Gemini API key is required. Please provide it in Settings or set GEMINI_API_KEY in your environment.",
			})
			return
		}
		model := strings.TrimSpace(req.Model)
		if model == "" || strings.Contains(model, ":") || !strings.HasPrefix(strings.ToLower(model), "gemini") {
			model = "gemini-3.6-flash"
		}
		llm = &impute.GeminiClient{APIKey: apiKey, Model: model}
	} else if provider == "ollama" {
		baseURL := strings.TrimSpace(req.OllamaURL)
		if baseURL == "" {
			baseURL = "http://localhost:11434"
		}
		model := strings.ReplaceAll(strings.TrimSpace(req.Model), " ", "")
		if model == "" {
			model = "qwen3:4b"
		}
		llm = &impute.OllamaClient{BaseURL: baseURL, Model: model}
	} else {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "Unsupported provider: " + provider})
		return
	}

	domainHint := strings.TrimSpace(req.DomainContext)
	if domainHint == "" {
		domainHint = "academic literature retrieval and bibliometric data collection"
	}

	termsJSON, _ := json.Marshal(req.Terms)

	prompt := fmt.Sprintf(`You are an expert bibliometric researcher optimizing a precision-bounded Boolean search query for literature databases (OpenAlex, Web of Science, Scopus).

Optimization Goal:
1. MAXIMIZE ANCHOR RECALL: Cover all domain-relevant ground-truth literature (100%% recall target).
2. MINIMIZE CORPUS VOLUME: Strictly minimize background noise, false positives, and topic drift into adjacent disciplines.

Domain context: %s

Your task is to classify the provided list of keywords/phrases into exactly 4 categories based on standard bibliometric bounding methodology:

1. "1_core_technology": High-precision, unambiguous multi-word domain phrases that stand alone as primary identifiers of the field. NEVER place generic single words here.
2. "2_methods_tools": Specific techniques, algorithms, architectures, physical hardware platforms, or experimental protocols that stand alone. NEVER place generic single words here.
3. "3_mechanisms": Fundamental phenomena, theoretical mechanisms, or physical properties that are essential to the domain but TOO BROAD or generic on their own without context.
4. "4_applications": Specific downstream tasks, use cases, target domains, or applications that are broad on their own.

Input terms to classify:
%s

Rules:
- Categorize every single provided term into one of the 4 buckets.
- Generic terms that match millions of papers when searched alone MUST be assigned to "3_mechanisms" or "4_applications" so they are constrained by intersection (Mechanisms AND Applications).
- Do not add, remove, or modify the spelling of any terms.
- Multi-word terms must keep their exact wording.
- Return ONLY valid JSON matching this exact structure:
{
  "1_core_technology": ["term1", ...],
  "2_methods_tools": ["term2", ...],
  "3_mechanisms": ["term3", ...],
  "4_applications": ["term4", ...]
}`, domainHint, string(termsJSON))

	ctx, cancel := context.WithTimeout(r.Context(), 180*time.Second)
	defer cancel()

	respText, err := llm.Complete(ctx, prompt)
	var coreList, methodsList, mechList, appsList []string

	if err != nil {
		log.Printf("[handleQueryGenerate] LLM completed with warning/fallback: %v", err)
		// Fallback gracefully to smart semantic heuristic bucketer
		coreList, methodsList, mechList, appsList = recoverPartialCategories("", req.Terms)
	} else {
		cleaned := cleanJSONCodeBlock(respText)

		var buckets struct {
			CoreTechnology []string `json:"1_core_technology"`
			MethodsTools   []string `json:"2_methods_tools"`
			Mechanisms     []string `json:"3_mechanisms"`
			Applications   []string `json:"4_applications"`
		}

		if err := json.Unmarshal([]byte(cleaned), &buckets); err == nil && (len(buckets.CoreTechnology) > 0 || len(buckets.MethodsTools) > 0 || len(buckets.Mechanisms) > 0 || len(buckets.Applications) > 0) {
			coreList = buckets.CoreTechnology
			methodsList = buckets.MethodsTools
			mechList = buckets.Mechanisms
			appsList = buckets.Applications
		} else {
			// Fallback: recover partial arrays via regex and smart semantic heuristic
			coreList, methodsList, mechList, appsList = recoverPartialCategories(respText, req.Terms)
		}
	}

	compiledQuery := CompileCategorizedQuery(
		coreList,
		methodsList,
		mechList,
		appsList,
	)

	errors := openalex.ValidateKeywords(compiledQuery)
	isValid := len(errors) == 0

	json.NewEncoder(w).Encode(map[string]interface{}{
		"query": compiledQuery,
		"categories": map[string][]string{
			"1_core_technology": coreList,
			"2_methods_tools":   methodsList,
			"3_mechanisms":       mechList,
			"4_applications":     appsList,
		},
		"valid":  isValid,
		"errors": errors,
	})
}

func (s *APIServer) handleQueryGenerateFromAnchors(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		http.Error(w, `{"error": "Method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Project        string   `json:"project"`
		Filename       string   `json:"filename"`
		TitleColumn    string   `json:"title_column"`
		AbstractColumn string   `json:"abstract_column"`
		Anchors        []string `json:"anchors"`
		Terms          []string `json:"terms"` // Candidate KeyBERT + TF-IDF keywords
		Provider       string   `json:"provider"`
		APIKey         string   `json:"api_key"`
		Model          string   `json:"model"`
		OllamaURL      string   `json:"ollama_url"`
		DomainContext  string   `json:"domain_context"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid request body: " + err.Error()})
		return
	}

	configDBPath, _, _, _, uploadsDir := s.getProjectPaths(req.Project)

	// Step 1: Gather Anchor Documents (Titles and Abstracts)
	var anchorDocs []string

	// Source A: Uploaded Seed File
	if req.Filename != "" {
		filePath := filepath.Join(uploadsDir, req.Filename)
		ext := strings.ToLower(filepath.Ext(filePath))
		var docs []string
		var err error
		if ext == ".csv" {
			docs, err = loadCSVDocuments(filePath, req.TitleColumn, req.AbstractColumn)
		} else {
			docs, err = loadExcelDocuments(filePath, req.TitleColumn, req.AbstractColumn)
		}
		if err == nil && len(docs) > 0 {
			anchorDocs = append(anchorDocs, docs...)
		}
	}

	// Source B: Read DOIs from req.Anchors or config
	var dois []string
	if len(req.Anchors) > 0 {
		dois = req.Anchors
	} else {
		cfg, err := config.LoadConfig(configDBPath)
		if err == nil && len(cfg.Anchors) > 0 {
			dois = cfg.Anchors
		}
	}

	// If no seed file docs were found, but we have DOIs, fetch OpenAlex metadata for DOIs
	if len(anchorDocs) == 0 && len(dois) > 0 {
		var cleanDOIs []string
		for _, d := range dois {
			d = strings.TrimSpace(d)
			if d != "" {
				d = strings.TrimPrefix(d, "https://doi.org/")
				d = strings.TrimPrefix(d, "http://doi.org/")
				d = strings.TrimPrefix(d, "doi:")
				if d != "" {
					cleanDOIs = append(cleanDOIs, "https://doi.org/"+d)
				}
			}
		}

		if len(cleanDOIs) > 25 {
			cleanDOIs = cleanDOIs[:25]
		}

		if len(cleanDOIs) > 0 {
			cfg, _ := config.LoadConfig(configDBPath)
			var apiKeys []string
			var email string
			if cfg != nil {
				apiKeys = cfg.API.Keys
				email = cfg.API.Email
			}
			client := openalex.NewClient(apiKeys, email, 25, 5, 2, 1)
			filter := "doi:" + strings.Join(cleanDOIs, "|")
			page, err := client.FetchPage(r.Context(), filter, "*")
			if err == nil && page != nil {
				for _, work := range page.Results {
					abs := reconstructAbstract(work.AbstractInvertedIndex)
					title := strings.TrimSpace(work.Title)
					if title != "" {
						doc := title
						if abs != "" {
							doc += ". " + abs
						}
						if work.PrimaryTopic.DisplayName != "" {
							doc += fmt.Sprintf(" [Topic: %s]", work.PrimaryTopic.DisplayName)
						}
						anchorDocs = append(anchorDocs, doc)
					}
				}
			}
		}
	}

	if len(anchorDocs) == 0 {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "No anchor papers found. Please upload a seed CSV/Excel file or add Anchor DOIs in Step 1.",
		})
		return
	}

	// Limit to top 25 anchor papers to fit comfortably in model context window
	if len(anchorDocs) > 25 {
		anchorDocs = anchorDocs[:25]
	}

	// Step 2: Initialize LLM Client
	provider := strings.ToLower(strings.TrimSpace(req.Provider))
	if provider == "" {
		provider = "gemini"
	}

	var llm impute.LLMClient
	if provider == "gemini" {
		apiKey := strings.TrimSpace(req.APIKey)
		if apiKey == "" {
			apiKey = os.Getenv("GEMINI_API_KEY")
		}
		if apiKey == "" {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{
				"error": "Gemini API key is required. Please provide it in Settings or set GEMINI_API_KEY in your environment.",
			})
			return
		}
		model := strings.TrimSpace(req.Model)
		if model == "" || strings.Contains(model, ":") || !strings.HasPrefix(strings.ToLower(model), "gemini") {
			model = "gemini-3.6-flash"
		}
		llm = &impute.GeminiClient{APIKey: apiKey, Model: model}
	} else if provider == "ollama" {
		baseURL := strings.TrimSpace(req.OllamaURL)
		if baseURL == "" {
			baseURL = "http://localhost:11434"
		}
		model := strings.ReplaceAll(strings.TrimSpace(req.Model), " ", "")
		if model == "" {
			model = "qwen3:4b"
		}
		llm = &impute.OllamaClient{BaseURL: baseURL, Model: model}
	} else {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "Unsupported provider: " + provider})
		return
	}

	domainHint := strings.TrimSpace(req.DomainContext)
	if domainHint == "" {
		domainHint = "academic literature retrieval and precision bibliometric boundary definition"
	}

	var paperSnippets strings.Builder
	for i, doc := range anchorDocs {
		paperSnippets.WriteString(fmt.Sprintf("--- Anchor Paper %d ---\n%s\n\n", i+1, doc))
	}

	// Format Candidate KeyBERT + TF-IDF Keywords if provided
	var keywordsSnippet string
	if len(req.Terms) > 0 {
		termsJSON, _ := json.Marshal(req.Terms)
		keywordsSnippet = fmt.Sprintf("Candidate KeyBERT + TF-IDF Extracted Keywords:\n%s\n\n", string(termsJSON))
	}

	prompt := fmt.Sprintf(`You are a world-class bibliometric research scientist creating the optimal precision-bounded Boolean search query for literature databases (OpenAlex, Web of Science, Scopus).

CORE OPTIMIZATION OBJECTIVES:
1. MAXIMIZE ANCHOR RECALL (Target: 100%%): Every single seed/anchor paper provided below MUST be matched by at least one clause in the generated query.
2. MINIMIZE CORPUS VOLUME (Target: Minimal Works): The total number of papers retrieved from OpenAlex MUST be as small as possible. Strictly eliminate background noise, broad academic clutter, and topic drift into adjacent disciplines.

Domain context: %s

Below is the ground-truth set of %d Seed / Anchor Papers that define the exact research core and boundary of this field:

%s
%s
How to achieve Maximum Anchor Recall with Minimum OpenAlex Volume:
- NEVER place broad single-word terms in "1_core_technology" or "2_methods_tools" (e.g. NEVER use single words like "quantum", "error", "code", "algorithm", "qubit", "circuit", "platform", "model", "learning"). Single words return hundreds of thousands of irrelevant papers.
- ALWAYS use tight, highly specific 2-word, 3-word, or 4-word compound phrases in "1_core_technology" and "2_methods_tools" that are directly observed in or representative of the anchor papers (e.g. "surface code quantum error correction", "superconducting transmon qubit", "fault-tolerant quantum computing", "neutral atom quantum processor", "quantum approximate optimization algorithm").
- Broad mechanisms (e.g. "entanglement", "decoherence", "superposition", "phase estimation") MUST ONLY be placed in "3_mechanisms".
- Broad application areas (e.g. "cryptography", "drug discovery", "quantum sensing", "materials simulation", "portfolio optimization") MUST ONLY be placed in "4_applications".
- The search engine will evaluate the query as: (Core OR Methods) OR (Mechanisms AND Applications). This forces broad mechanisms to intersect with broad applications, eliminating false positives and keeping total OpenAlex volume to a minimum while ensuring all anchor papers are captured.

Categorize your synthesized keywords into the 4 standard bibliometric bounding buckets:
- "1_core_technology": 3 to 10 high-precision, unambiguous compound phrases that stand alone as primary identifiers.
- "2_methods_tools": 3 to 10 specific techniques, architectures, physical hardware platforms, protocols, or algorithms that stand alone.
- "3_mechanisms": 3 to 10 fundamental physical phenomena, theoretical mechanisms, or properties that are broad on their own.
- "4_applications": 3 to 10 specific downstream use cases, target domains, or impact areas.

Rules:
- Ensure that for EVERY anchor paper listed above, at least one of its key concepts is covered by your chosen terms.
- You may use and classify terms from the KeyBERT/TF-IDF list as well as terms directly extracted from the anchor papers.
- Multi-word phrases should be lowercase and exact.
- Do NOT include generic filler words like "paper", "method", "results", "analysis", "system", "performance".
- Return ONLY valid JSON matching this exact structure:
{
  "1_core_technology": ["term1", "term2", ...],
  "2_methods_tools": ["term3", "term4", ...],
  "3_mechanisms": ["term5", "term6", ...],
  "4_applications": ["term7", "term8", ...]
}`, domainHint, len(anchorDocs), paperSnippets.String(), keywordsSnippet)

	ctx, cancel := context.WithTimeout(r.Context(), 180*time.Second)
	defer cancel()

	respText, err := llm.Complete(ctx, prompt)
	var coreList, methodsList, mechList, appsList []string

	if err != nil {
		log.Printf("[handleQueryGenerateFromAnchors] LLM completed with warning/fallback: %v", err)
		// Fallback: extract terms from anchorDocs using TF-IDF and heuristic categorize
		tfidfTerms := tfidf.ExtractKeywords(anchorDocs, 2, 3, 1, 1.0, 30)
		var rawTerms []string
		for _, t := range tfidfTerms {
			rawTerms = append(rawTerms, t.Term)
		}
		coreList, methodsList, mechList, appsList = recoverPartialCategories("", rawTerms)
	} else {
		cleaned := cleanJSONCodeBlock(respText)

		var buckets struct {
			CoreTechnology []string `json:"1_core_technology"`
			MethodsTools   []string `json:"2_methods_tools"`
			Mechanisms     []string `json:"3_mechanisms"`
			Applications   []string `json:"4_applications"`
		}

		if err := json.Unmarshal([]byte(cleaned), &buckets); err == nil && (len(buckets.CoreTechnology) > 0 || len(buckets.MethodsTools) > 0 || len(buckets.Mechanisms) > 0 || len(buckets.Applications) > 0) {
			coreList = buckets.CoreTechnology
			methodsList = buckets.MethodsTools
			mechList = buckets.Mechanisms
			appsList = buckets.Applications
		} else {
			// Fallback: recover partial JSON
			coreList, methodsList, mechList, appsList = recoverPartialCategories(respText, nil)
		}
	}

	compiledQuery := CompileCategorizedQuery(
		coreList,
		methodsList,
		mechList,
		appsList,
	)

	errors := openalex.ValidateKeywords(compiledQuery)
	isValid := len(errors) == 0

	json.NewEncoder(w).Encode(map[string]interface{}{
		"query": compiledQuery,
		"categories": map[string][]string{
			"1_core_technology": coreList,
			"2_methods_tools":   methodsList,
			"3_mechanisms":       mechList,
			"4_applications":     appsList,
		},
		"anchor_count": len(anchorDocs),
		"valid":        isValid,
		"errors":       errors,
	})
}

func (s *APIServer) handleOpenAlexCount(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		http.Error(w, `{"error": "Method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Query        string   `json:"query"`
		Keys         []string `json:"keys"`
		Email        string   `json:"email"`
		DateFrom     string   `json:"date_from"`
		DateTo       string   `json:"date_to"`
		DocTypes     []string `json:"doc_types"`
		Topics       []string `json:"topics"`
		CheckAnchors bool     `json:"check_anchors"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid request body: " + err.Error()})
		return
	}

	// Validate query keywords
	if errs := openalex.ValidateKeywords(req.Query); len(errs) > 0 {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "Query validation failed: " + strings.Join(errs, "; ")})
		return
	}

	if req.Email == "" {
		req.Email = "your@email.com"
	}
	if req.DateFrom == "" {
		req.DateFrom = "2003-01-01"
	}
	if req.DateTo == "" {
		req.DateTo = "2024-12-31"
	}

	// Instantiate client
	client := openalex.NewClient(req.Keys, req.Email, 200, 1, 3, 1)

	// Build the API filter query
	parts := []string{"title_and_abstract.search:" + req.Query}
	var validTopics []string
	for _, t := range req.Topics {
		if openalex.ValidateTopicFormat(t) {
			validTopics = append(validTopics, t)
		}
	}
	if len(validTopics) > 0 {
		parts = append(parts, "primary_topic.id:"+strings.Join(validTopics, "|"))
	}
	parts = append(parts, "from_publication_date:"+req.DateFrom)
	parts = append(parts, "to_publication_date:"+req.DateTo)
	if len(req.DocTypes) > 0 {
		parts = append(parts, "type:"+strings.Join(req.DocTypes, "|"))
	}
	filter := strings.Join(parts, ",")

	count, err := client.GetTotalCount(r.Context(), filter)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "OpenAlex request failed: " + err.Error()})
		return
	}

	// Load anchors from config
	var anchors []string
	var matchedCount int
	var missingDOIs []string

	if req.CheckAnchors {
		project := r.URL.Query().Get("project")
		configDBPath, _, _, _, _ := s.getProjectPaths(project)

		cfg, err := config.LoadConfig(configDBPath)
		if err == nil {
			for _, a := range cfg.Anchors {
				norm := normalizeDOI(a)
				if norm != "" {
					anchors = append(anchors, norm)
				}
			}
		}

		// Run anchor check coverage
		if len(anchors) > 0 {
			batchSize := 10
			matchedSet := make(map[string]bool)

			for i := 0; i < len(anchors); i += batchSize {
				end := i + batchSize
				if end > len(anchors) {
					end = len(anchors)
				}
				batch := anchors[i:end]
				batchFilter := strings.Join(batch, "|")

				// Combine filter: queryFilter + ",doi:" + batchFilter
				combinedFilter := filter + ",doi:" + batchFilter

				// Query OpenAlex works for matching DOIs in this batch
				resp, err := client.FetchPage(r.Context(), combinedFilter, "*")
				if err == nil && resp != nil {
					for _, w := range resp.Results {
						norm := normalizeDOI(w.DOI)
						if norm != "" {
							matchedSet[norm] = true
						}
					}
				}
			}

			for _, doi := range anchors {
				if matchedSet[doi] {
					matchedCount++
				} else {
					missingDOIs = append(missingDOIs, doi)
				}
			}
		}
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"count":           count,
		"filter":          filter,
		"anchors_total":   len(anchors),
		"anchors_matched": matchedCount,
		"anchors_missing": missingDOIs,
	})
}

func (s *APIServer) handleOpenAlexSample(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Content-Type", "application/json")
		http.Error(w, `{"error": "Method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Query      string   `json:"query"`
		Keys       []string `json:"keys"`
		Email      string   `json:"email"`
		DateFrom   string   `json:"date_from"`
		DateTo     string   `json:"date_to"`
		DocTypes   []string `json:"doc_types"`
		Topics     []string `json:"topics"`
		SampleSize int      `json:"sample_size"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid request body: " + err.Error()})
		return
	}

	// Validate query keywords
	if errs := openalex.ValidateKeywords(req.Query); len(errs) > 0 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "Query validation failed: " + strings.Join(errs, "; ")})
		return
	}

	if req.Email == "" {
		req.Email = "your@email.com"
	}
	if req.DateFrom == "" {
		req.DateFrom = "2003-01-01"
	}
	if req.DateTo == "" {
		req.DateTo = "2024-12-31"
	}
	if req.SampleSize <= 0 {
		req.SampleSize = 385
	}

	// Instantiate client
	client := openalex.NewClient(req.Keys, req.Email, 200, 5, 3, 1)

	// Build the API filter query
	parts := []string{"title_and_abstract.search:" + req.Query}
	var validTopics []string
	for _, t := range req.Topics {
		if openalex.ValidateTopicFormat(t) {
			validTopics = append(validTopics, t)
		}
	}
	if len(validTopics) > 0 {
		parts = append(parts, "primary_topic.id:"+strings.Join(validTopics, "|"))
	}
	parts = append(parts, "from_publication_date:"+req.DateFrom)
	parts = append(parts, "to_publication_date:"+req.DateTo)
	if len(req.DocTypes) > 0 {
		parts = append(parts, "type:"+strings.Join(req.DocTypes, "|"))
	}
	filter := strings.Join(parts, ",")

	// Fetch sample works (passing 0 for seed triggers automatic generation of a time-based random seed)
	works, err := client.FetchSample(r.Context(), filter, req.SampleSize, 0)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "OpenAlex sample request failed: " + err.Error()})
		return
	}

	// Format as CSV
	project := r.URL.Query().Get("project")
	if project == "" {
		project = "openalex"
	}
	filename := fmt.Sprintf("%s_sample_%d.csv", project, req.SampleSize)
	w.Header().Set("Content-Type", "text/csv")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	w.WriteHeader(http.StatusOK)

	writer := csv.NewWriter(w)
	defer writer.Flush()

	header := []string{
		"id", "doi", "title", "publication_year", "type",
		"topic_id", "topic_name", "abstract_text",
		"cited_by_count", "fwci", "institutions_count", "countries_count",
	}
	if err := writer.Write(header); err != nil {
		return
	}

	for _, p := range works {
		topicID := p.PrimaryTopic.ID
		if idx := strings.LastIndex(topicID, "/"); idx != -1 {
			topicID = topicID[idx+1:]
		}

		abstractText := reconstructAbstract(p.AbstractInvertedIndex)

		row := []string{
			p.ID,
			p.DOI,
			p.Title,
			fmt.Sprintf("%d", p.PublicationYear),
			p.Type,
			topicID,
			p.PrimaryTopic.DisplayName,
			abstractText,
			fmt.Sprintf("%d", p.CitedByCount),
			fmt.Sprintf("%g", p.FWCI),
			fmt.Sprintf("%d", p.InstitutionsDistinctCount),
			fmt.Sprintf("%d", p.CountriesDistinctCount),
		}
		if err := writer.Write(row); err != nil {
			return
		}
	}
}

func reconstructAbstract(inverted map[string][]int) string {
	if len(inverted) == 0 {
		return ""
	}
	maxIdx := -1
	for _, positions := range inverted {
		for _, pos := range positions {
			if pos > maxIdx {
				maxIdx = pos
			}
		}
	}
	if maxIdx < 0 {
		return ""
	}

	words := make([]string, maxIdx+1)
	for word, positions := range inverted {
		for _, pos := range positions {
			if pos >= 0 && pos <= maxIdx {
				words[pos] = word
			}
		}
	}

	var filtered []string
	for _, w := range words {
		if w != "" {
			filtered = append(filtered, w)
		}
	}
	return strings.Join(filtered, " ")
}

func (s *APIServer) handleOpenAlexTopics(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		http.Error(w, `{"error": "Method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Query       string   `json:"query"`
		Keys        []string `json:"keys"`
		Email       string   `json:"email"`
		DateFrom    string   `json:"date_from"`
		DateTo      string   `json:"date_to"`
		DocTypes    []string `json:"doc_types"`
		Topics      []string `json:"topics"`
		Details     bool     `json:"details"`
		FromAnchors bool     `json:"from_anchors"`
		Anchors     []string `json:"anchors"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid request body: " + err.Error()})
		return
	}

	if req.Email == "" {
		req.Email = "your@email.com"
	}

	// If fetching topics from anchor files / DOIs (matching openalex/commands/topic_search.py)
	if req.FromAnchors {
		anchorsList := req.Anchors
		if len(anchorsList) == 0 {
			project := r.URL.Query().Get("project")
			configDBPath, _, _, _, _ := s.getProjectPaths(project)
			cfg, err := config.LoadConfig(configDBPath)
			if err == nil {
				anchorsList = cfg.Anchors
			}
		}

		// Extract all valid DOIs from anchor entries (matching re.search(r"10\.\S+", line))
		var dois []string
		seenDOI := make(map[string]bool)
		for _, line := range anchorsList {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			match := doiExtractorRe.FindString(line)
			if match != "" {
				doi := strings.TrimRight(match, ".,;)]}>\"'")
				doi = strings.TrimSpace(doi)
				lower := strings.ToLower(doi)
				if doi != "" && !seenDOI[lower] {
					seenDOI[lower] = true
					dois = append(dois, doi)
				}
			}
		}

		if len(dois) == 0 {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{"error": "No valid DOIs found in anchor papers (anchor.txt). DOIs must begin with 10.xxxx/..."})
			return
		}

		// Load current topics set to compute "Already Present" vs "NEW" status
		currentTopicsSet := make(map[string]bool)
		for _, t := range req.Topics {
			t = strings.TrimSpace(t)
			if t != "" {
				if idx := strings.LastIndex(t, "/"); idx != -1 {
					t = t[idx+1:]
				}
				currentTopicsSet[t] = true
			}
		}

		client := openalex.NewClient(req.Keys, req.Email, 200, 4, 3, 1)

		type anchorJobResult struct {
			doi  string
			work *openalex.Work
			err  error
		}

		jobs := make(chan string, len(dois))
		resChan := make(chan anchorJobResult, len(dois))
		var wg sync.WaitGroup

		workerCount := 8
		if len(dois) < workerCount {
			workerCount = len(dois)
		}
		if workerCount < 1 {
			workerCount = 1
		}

		for w := 0; w < workerCount; w++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for d := range jobs {
					if r.Context().Err() != nil {
						return
					}
					work, err := client.FetchWorkByDOI(r.Context(), d)
					resChan <- anchorJobResult{doi: d, work: work, err: err}
				}
			}()
		}

		for _, d := range dois {
			jobs <- d
		}
		close(jobs)

		wg.Wait()
		close(resChan)

		if r.Context().Err() != nil {
			return
		}

		type topicAccumulator struct {
			topicID     string
			displayName string
			subfield    string
			field       string
			domain      string
			frequency   int
			exampleDOI  string
		}

		topicMap := make(map[string]*topicAccumulator)
		var resolvedCount int

		for res := range resChan {
			if res.err != nil || res.work == nil {
				continue
			}
			resolvedCount++

			// Extract all candidate topics from work.Topics and work.PrimaryTopic
			candidateTopics := res.work.Topics
			if res.work.PrimaryTopic.ID != "" {
				hasPrimary := false
				for _, ct := range candidateTopics {
					if ct.ID == res.work.PrimaryTopic.ID {
						hasPrimary = true
						break
					}
				}
				if !hasPrimary {
					candidateTopics = append([]openalex.TopicInfo{res.work.PrimaryTopic}, candidateTopics...)
				}
			}

			seenInThisWork := make(map[string]bool)
			for _, t := range candidateTopics {
				topicID := t.ID
				if topicID == "" {
					continue
				}
				if idx := strings.LastIndex(topicID, "/"); idx != -1 {
					topicID = topicID[idx+1:]
				}
				if !openalex.ValidateTopicFormat(topicID) {
					continue
				}
				if seenInThisWork[topicID] {
					continue
				}
				seenInThisWork[topicID] = true

				if accum, exists := topicMap[topicID]; exists {
					accum.frequency++
				} else {
					topicMap[topicID] = &topicAccumulator{
						topicID:     topicID,
						displayName: t.DisplayName,
						subfield:    t.Subfield.DisplayName,
						field:       t.Field.DisplayName,
						domain:      t.Domain.DisplayName,
						frequency:   1,
						exampleDOI:  res.doi,
					}
				}
			}
		}

		type EnrichedTopic struct {
			TopicID     string   `json:"topic_id"`
			DisplayName string   `json:"display_name"`
			Subfield    string   `json:"subfield"`
			Field       string   `json:"field"`
			Domain      string   `json:"domain"`
			Description string   `json:"description"`
			Keywords    []string `json:"keywords"`
			Count       int      `json:"paper_count"`
			Frequency   int      `json:"frequency"`
			Percentage  float64  `json:"percentage"`
			Coverage    float64  `json:"coverage"`
			Importance  string   `json:"importance"`
			Status      string   `json:"status"`
			ExampleDOI  string   `json:"example_doi"`
		}

		var enriched []EnrichedTopic
		for _, accum := range topicMap {
			cov := 0.0
			if len(dois) > 0 {
				cov = float64(accum.frequency) / float64(len(dois)) * 100.0
			}
			imp := getTopicImportance(cov)
			status := "NEW"
			if currentTopicsSet[accum.topicID] {
				status = "Already Present"
			}

			enriched = append(enriched, EnrichedTopic{
				TopicID:     accum.topicID,
				DisplayName: accum.displayName,
				Subfield:    accum.subfield,
				Field:       accum.field,
				Domain:      accum.domain,
				Count:       accum.frequency,
				Frequency:   accum.frequency,
				Percentage:  cov,
				Coverage:    cov,
				Importance:  imp,
				Status:      status,
				ExampleDOI:  accum.exampleDOI,
			})
		}

		// Sort by frequency descending (most common first, exactly as in topic_search.py)
		sort.Slice(enriched, func(i, j int) bool {
			return enriched[i].Frequency > enriched[j].Frequency
		})

		// Optionally enrich topic descriptions if requested
		if req.Details && len(enriched) > 0 {
			var enrichWg sync.WaitGroup
			for i := range enriched {
				enrichWg.Add(1)
				go func(idx int) {
					defer enrichWg.Done()
					details, err := client.FetchTopicDetails(r.Context(), enriched[idx].TopicID)
					if err == nil && details != nil {
						if details.DisplayName != "" {
							enriched[idx].DisplayName = details.DisplayName
						}
						enriched[idx].Description = details.Description
						enriched[idx].Keywords = details.Keywords
						if details.Domain.DisplayName != "" {
							enriched[idx].Domain = details.Domain.DisplayName
						}
						if details.Field.DisplayName != "" {
							enriched[idx].Field = details.Field.DisplayName
						}
						if details.Subfield.DisplayName != "" {
							enriched[idx].Subfield = details.Subfield.DisplayName
						}
					}
				}(i)
			}
			enrichWg.Wait()
		}

		json.NewEncoder(w).Encode(map[string]interface{}{
			"source":          "anchors",
			"total_topics":    len(enriched),
			"total_papers":    resolvedCount,
			"anchors_total":   len(dois),
			"anchors_found":   resolvedCount,
			"anchors_missing": len(dois) - resolvedCount,
			"topics":          enriched,
		})
		return
	}

	// Validate query keywords for standard keyword topic discovery
	if errs := openalex.ValidateKeywords(req.Query); len(errs) > 0 {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "Query validation failed: " + strings.Join(errs, "; ")})
		return
	}

	if req.DateFrom == "" {
		req.DateFrom = "2003-01-01"
	}
	if req.DateTo == "" {
		req.DateTo = "2024-12-31"
	}

	// Instantiate client
	client := openalex.NewClient(req.Keys, req.Email, 200, 4, 3, 1)

	// Build the API filter query
	parts := []string{"title_and_abstract.search:" + req.Query}
	var validTopics []string
	for _, t := range req.Topics {
		if openalex.ValidateTopicFormat(t) {
			validTopics = append(validTopics, t)
		}
	}
	if len(validTopics) > 0 {
		parts = append(parts, "primary_topic.id:"+strings.Join(validTopics, "|"))
	}
	parts = append(parts, "from_publication_date:"+req.DateFrom)
	parts = append(parts, "to_publication_date:"+req.DateTo)
	if len(req.DocTypes) > 0 {
		parts = append(parts, "type:"+strings.Join(req.DocTypes, "|"))
	}
	filter := strings.Join(parts, ",")

	// Fetch topic groups using cursor pagination (capped to top 200)
	var allGroups []openalex.GroupByItem
	cursor := "*"
	for len(allGroups) < 200 {
		if r.Context().Err() != nil {
			return
		}
		resp, err := client.FetchGroupBy(r.Context(), filter, "primary_topic.id", cursor)
		if err != nil {
			if r.Context().Err() != nil {
				return
			}
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{"error": "OpenAlex request failed: " + err.Error()})
			return
		}
		if resp == nil || len(resp.GroupBy) == 0 {
			break
		}
		allGroups = append(allGroups, resp.GroupBy...)
		if resp.Meta.NextCursor == "" || resp.Meta.NextCursor == cursor {
			break
		}
		cursor = resp.Meta.NextCursor
	}

	if r.Context().Err() != nil {
		return
	}

	// Sort groups by count descending
	sort.Slice(allGroups, func(i, j int) bool {
		return allGroups[i].Count > allGroups[j].Count
	})

	// Keep only top 200 topics
	if len(allGroups) > 200 {
		allGroups = allGroups[:200]
	}

	// Calculate total papers
	var totalPapers int
	for _, g := range allGroups {
		totalPapers += g.Count
	}

	type EnrichedTopic struct {
		TopicID     string   `json:"topic_id"`
		DisplayName string   `json:"display_name"`
		Description string   `json:"description"`
		Keywords    []string `json:"keywords"`
		Domain      string   `json:"domain"`
		Field       string   `json:"field"`
		Subfield    string   `json:"subfield"`
		Count       int      `json:"paper_count"`
		Percentage  float64  `json:"percentage"`
	}

	enriched := make([]EnrichedTopic, len(allGroups))
	var wg sync.WaitGroup

	for i, g := range allGroups {
		if r.Context().Err() != nil {
			break
		}
		wg.Add(1)
		go func(idx int, item openalex.GroupByItem) {
			defer wg.Done()
			if r.Context().Err() != nil {
				return
			}

			percentage := 0.0
			if totalPapers > 0 {
				percentage = float64(item.Count) / float64(totalPapers) * 100
			}

			topicID := item.Key
			if lastSlash := strings.LastIndex(topicID, "/"); lastSlash != -1 {
				topicID = topicID[lastSlash+1:]
			}

			eTopic := EnrichedTopic{
				TopicID:     topicID,
				DisplayName: item.KeyDisplayName,
				Count:       item.Count,
				Percentage:  percentage,
			}

			if req.Details {
				details, err := client.FetchTopicDetails(r.Context(), topicID)
				if err == nil && details != nil {
					if details.DisplayName != "" {
						eTopic.DisplayName = details.DisplayName
					}
					eTopic.Description = details.Description
					eTopic.Keywords = details.Keywords
					eTopic.Domain = details.Domain.DisplayName
					eTopic.Field = details.Field.DisplayName
					eTopic.Subfield = details.Subfield.DisplayName
				}
			}

			enriched[idx] = eTopic
		}(i, g)
	}
	wg.Wait()

	if r.Context().Err() != nil {
		return
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"total_topics": len(allGroups),
		"total_papers": totalPapers,
		"topics":       enriched,
	})
}

var doiExtractorRe = regexp.MustCompile(`(?i)10\.\d{4,9}/\S+`)

func getTopicImportance(pct float64) string {
	if pct >= 20.0 {
		return "★★★★★ Critical"
	} else if pct >= 10.0 {
		return "★★★★ High"
	} else if pct >= 5.0 {
		return "★★★ Medium"
	} else if pct >= 2.0 {
		return "★★ Low"
	} else if pct >= 1.0 {
		return "★ Very Low"
	}
	return "✩ Negligible"
}

var doiPrefixRe = regexp.MustCompile(`(?i)^(?:https?://(?:dx\.)?doi\.org/|doi:)`)
var doiRe = regexp.MustCompile(`(?i)^10\.\d{4,9}/\S+$`)

func normalizeDOI(val string) string {
	candidate := strings.TrimSpace(val)
	if candidate == "" {
		return ""
	}
	candidate = doiPrefixRe.ReplaceAllString(candidate, "")
	candidate = strings.TrimSpace(candidate)
	candidate = strings.ToLower(candidate)
	if doiRe.MatchString(candidate) {
		return candidate
	}
	return ""
}

func extractDOIsFromCSV(filePath, doiCol string) ([]string, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	reader := csv.NewReader(f)
	reader.LazyQuotes = true
	reader.FieldsPerRecord = -1
	rows, err := reader.ReadAll()
	if err != nil {
		return nil, err
	}
	if len(rows) < 2 {
		return nil, nil
	}

	headers := rows[0]
	doiIdx := -1
	for idx, h := range headers {
		if strings.EqualFold(h, doiCol) {
			doiIdx = idx
			break
		}
	}
	if doiIdx == -1 {
		return nil, fmt.Errorf("doi column %q not found in headers", doiCol)
	}

	var dois []string
	seen := make(map[string]bool)
	for _, row := range rows[1:] {
		found := false
		if doiIdx < len(row) {
			rawDOI := strings.TrimSpace(row[doiIdx])
			norm := normalizeDOI(rawDOI)
			if norm != "" {
				if !seen[norm] {
					seen[norm] = true
					dois = append(dois, norm)
				}
				found = true
			}
		}
		if !found {
			for _, cell := range row {
				norm := normalizeDOI(cell)
				if norm != "" {
					if !seen[norm] {
						seen[norm] = true
						dois = append(dois, norm)
					}
					break
				}
			}
		}
	}
	return dois, nil
}

func extractDOIsFromExcel(filePath, doiCol string) ([]string, error) {
	var rows [][]string
	var err error
	if strings.HasSuffix(strings.ToLower(filePath), ".xls") {
		rows, err = parseXLSRows(filePath)
	} else {
		f, errOpen := excelize.OpenFile(filePath)
		if errOpen != nil {
			return nil, errOpen
		}
		defer f.Close()

		sheets := f.GetSheetList()
		if len(sheets) == 0 {
			return nil, fmt.Errorf("no sheets found in Excel file")
		}
		rows, err = f.GetRows(sheets[0])
	}
	if err != nil {
		return nil, err
	}
	if len(rows) < 2 {
		return nil, nil
	}

	headers := rows[0]
	doiIdx := -1
	for idx, h := range headers {
		if strings.EqualFold(h, doiCol) {
			doiIdx = idx
			break
		}
	}
	if doiIdx == -1 {
		return nil, fmt.Errorf("doi column %q not found in headers", doiCol)
	}

	var dois []string
	seen := make(map[string]bool)
	for _, row := range rows[1:] {
		found := false
		if doiIdx < len(row) {
			rawDOI := strings.TrimSpace(row[doiIdx])
			norm := normalizeDOI(rawDOI)
			if norm != "" {
				if !seen[norm] {
					seen[norm] = true
					dois = append(dois, norm)
				}
				found = true
			}
		}
		if !found {
			for _, cell := range row {
				norm := normalizeDOI(cell)
				if norm != "" {
					if !seen[norm] {
						seen[norm] = true
						dois = append(dois, norm)
					}
					break
				}
			}
		}
	}
	return dois, nil
}
