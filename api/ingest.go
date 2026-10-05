package api

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"stratum/config"
	"stratum/db"
	"stratum/openalex"
)

// =====================================================================
// Ingest Page: Paper Collection, Downloads, and Ingestion Pipeline
// =====================================================================

// PipelineStatus tracks the state and log output of the active ingestion pipeline.
type PipelineStatus struct {
	Syncing  bool     `json:"syncing"`
	Progress int      `json:"progress"`
	Logs     []string `json:"logs"`
}

type downloadPapersRequest struct {
	Output    string   `json:"output"`
	NoTopics  bool     `json:"no_topics"`
	Overwrite bool     `json:"overwrite"`
	Query     string   `json:"query"`
	DateFrom  string   `json:"date_from"`
	DateTo    string   `json:"date_to"`
	DocTypes  []string `json:"doc_types"`
	Topics    []string `json:"topics"`
}

type downloadInfoRequest struct {
	Output   string   `json:"output"`
	NoTopics bool     `json:"no_topics"`
	Query    string   `json:"query"`
	DateFrom string   `json:"date_from"`
	DateTo   string   `json:"date_to"`
	DocTypes []string `json:"doc_types"`
	Topics   []string `json:"topics"`
}

func (s *APIServer) getPipelineStatus(project string) *PipelineStatus {
	s.mu.Lock()
	defer s.mu.Unlock()

	if project == "" {
		project = "default"
	}
	project = sanitizeProjectName(project)

	status, ok := s.pipelineStatuses[project]
	if !ok {
		status = &PipelineStatus{
			Syncing:  false,
			Progress: 0,
			Logs:     []string{},
		}
		s.pipelineStatuses[project] = status
	}
	return status
}

func (s *APIServer) addLog(project string, msg string) {
	status := s.getPipelineStatus(project)
	s.mu.Lock()
	defer s.mu.Unlock()
	timestamp := time.Now().Format("15:04:05")
	status.Logs = append(status.Logs, fmt.Sprintf("[%s] %s", timestamp, msg))
}

func (s *APIServer) updateProgress(project string, p int) {
	status := s.getPipelineStatus(project)
	s.mu.Lock()
	defer s.mu.Unlock()
	status.Progress = p
	if status.Progress > 95 {
		status.Progress = 95
	}
	timestamp := time.Now().Format("15:04:05")
	status.Logs = append(status.Logs, fmt.Sprintf("[%s] [INFO] Download progress: %d papers fetched.", timestamp, p))
}

func (s *APIServer) updateStatus(project string, syncing bool, progress int, msg string) {
	status := s.getPipelineStatus(project)
	s.mu.Lock()
	defer s.mu.Unlock()
	status.Syncing = syncing
	status.Progress = progress
	timestamp := time.Now().Format("15:04:05")
	status.Logs = append(status.Logs, fmt.Sprintf("[%s] %s", timestamp, msg))
}

func (s *APIServer) handleImportJSONL(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		http.Error(w, `{"error": "Method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	project := r.URL.Query().Get("project")
	if project == "" {
		project = "default"
	}
	project = sanitizeProjectName(project)

	var req struct {
		Filename string `json:"filename"`
	}
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&req)
	}

	_, _, jsonlDir, _, _ := s.getProjectPaths(project)

	filename := strings.TrimSpace(req.Filename)
	if filename == "" {
		candidates := []string{
			fmt.Sprintf("%s_imputed.jsonl", project),
			fmt.Sprintf("%s.jsonl", project),
			"collected_papers_imputed.jsonl",
			"collected_papers.jsonl",
		}
		for _, c := range candidates {
			p := filepath.Join(jsonlDir, c)
			if fi, err := os.Stat(p); err == nil && fi.Size() > 0 {
				filename = c
				break
			}
		}
	}

	if filename == "" {
		entries, _ := os.ReadDir(jsonlDir)
		for _, e := range entries {
			if !e.IsDir() && strings.HasSuffix(strings.ToLower(e.Name()), ".jsonl") {
				filename = e.Name()
				break
			}
		}
	}

	if filename == "" {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{"error": "No JSONL paper files found in " + jsonlDir})
		return
	}

	jsonlPath := filepath.Join(jsonlDir, filename)
	if _, err := os.Stat(jsonlPath); err != nil {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{"error": "File not found: " + filename})
		return
	}

	dbMgr, err := s.getDBMgr(project)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": "Failed to open database: " + err.Error()})
		return
	}

	_ = dbMgr.CreateSchema()

	stats, err := dbMgr.LoadJSONL(jsonlPath, nil)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": "Failed to import JSONL into DuckDB: " + err.Error()})
		return
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":        "success",
		"file":          filename,
		"papers":        stats.Papers,
		"authors":       stats.Authors,
		"institutions":  stats.Institutions,
		"contributions": stats.Contributions,
		"countries":     stats.Countries,
	})
}

func (s *APIServer) handleRunPipeline(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	project := r.URL.Query().Get("project")
	configDBPath, dbPath, jsonlDir, dbDir, _ := s.getProjectPaths(project)

	// Validate configuration and query before starting pipeline
	cfg, err := config.LoadConfig(configDBPath)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "Failed to load config: " + err.Error()})
		return
	}

	if errs := openalex.ValidateKeywords(cfg.Keywords); len(errs) > 0 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "Query validation failed: " + strings.Join(errs, "; ")})
		return
	}

	status := s.getPipelineStatus(project)

	s.mu.Lock()
	if status.Syncing {
		s.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		w.Write([]byte(`{"error": "pipeline already running"}`))
		return
	}
	status.Syncing = true
	status.Progress = 0
	status.Logs = []string{}
	ctx, cancel := context.WithCancel(context.Background())
	s.pipelineCancelFuncs[project] = cancel
	s.mu.Unlock()

	s.addLog(project, "[INFO] Pipeline synchronization initiated by web client.")

	go func() {
		defer func() {
			s.mu.Lock()
			delete(s.pipelineCancelFuncs, project)
			status.Syncing = false
			s.mu.Unlock()
		}()

		cfg.Output.JSONLDir = jsonlDir
		cfg.Output.DBDir = dbDir

		s.addLog(project, "[INFO] Initializing openalex.DownloadPapers worker pool...")
		client := openalex.NewClient(cfg.API.Keys, cfg.API.Email, cfg.Collection.PerPage, cfg.Collection.ConcurrentRequests, cfg.Collection.MaxRetries, cfg.Collection.RetryDelay)

		outputJSONL := filepath.Join(cfg.Output.JSONLDir, "collected_papers.jsonl")
		s.addLog(project, "[INFO] Starting paper download to "+outputJSONL+"...")

		progressChan := make(chan int, 100)
		errChan := make(chan error, 1)

		go func() {
			errChan <- client.DownloadPapers(ctx, cfg, outputJSONL, progressChan)
		}()

		// Read progress events
		for {
			select {
			case p, ok := <-progressChan:
				if !ok {
					progressChan = nil
				} else {
					s.updateProgress(project, p)
				}
			case err := <-errChan:
				if err != nil {
					if ctx.Err() == context.Canceled {
						s.updateStatus(project, false, 0, "[WARNING] Pipeline cancelled by user.")
					} else {
						s.updateStatus(project, false, 0, "[ERROR] Download failed: "+err.Error())
					}
					return
				}

				s.addLog(project, "[SUCCESS] Ingestion completed. Ingested papers stored in JSONL.")
				s.addLog(project, "[INFO] Starting DB conversion. Running dbMgr.CreateSchema...")

				dbMgr, err := db.NewDBManager(dbPath)
				if err != nil {
					s.updateStatus(project, false, 0, "[ERROR] Failed to open DuckDB: "+err.Error())
					return
				}
				defer dbMgr.Close()

				if err := dbMgr.CreateSchema(); err != nil {
					s.updateStatus(project, false, 0, "[ERROR] Failed to create database schema: "+err.Error())
					return
				}

				s.addLog(project, "[INFO] Importing collected_papers.jsonl into DuckDB dynamic schema...")
				stats, err := dbMgr.LoadJSONL(outputJSONL, nil)
				if err != nil {
					s.updateStatus(project, false, 0, "[ERROR] Failed to load JSONL: "+err.Error())
					return
				}

				s.addLog(project, fmt.Sprintf("[SUCCESS] Finished DuckDB load. Papers: %d, Authors: %d, Contributions: %d.", stats.Papers, stats.Authors, stats.Contributions))
				s.updateStatus(project, false, 100, "[SUCCESS] Sync cycle complete. Database is stable and query-ready.")
				return
			}
		}
	}()

	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"status": "started"}`))
}

func (s *APIServer) handlePipelineStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	project := r.URL.Query().Get("project")
	status := s.getPipelineStatus(project)
	s.mu.Lock()
	defer s.mu.Unlock()
	json.NewEncoder(w).Encode(status)
}

// handleDownloadInfo provides pre-flight checks (paper count, size estimate, disk space) matching openalex download.
func (s *APIServer) handleDownloadInfo(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		http.Error(w, `{"error": "Method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	project := r.URL.Query().Get("project")
	configDBPath, _, jsonlDir, _, _ := s.getProjectPaths(project)

	cfg, err := config.LoadConfig(configDBPath)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "Failed to load config: " + err.Error()})
		return
	}

	var reqBody downloadInfoRequest
	if r.Method == http.MethodPost && r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&reqBody)
	}

	noTopics := r.URL.Query().Get("no_topics") == "true" || reqBody.NoTopics
	defaultFile := "collected_papers.jsonl"
	if project != "" && project != "default" {
		defaultFile = project + ".jsonl"
	}
	if customOut := r.URL.Query().Get("output"); customOut != "" {
		defaultFile = filepath.Base(customOut)
	} else if reqBody.Output != "" {
		defaultFile = filepath.Base(reqBody.Output)
	}
	if !strings.HasSuffix(strings.ToLower(defaultFile), ".jsonl") {
		defaultFile += ".jsonl"
	}

	var topics []string
	if !noTopics {
		topicsList := cfg.Topics
		if len(reqBody.Topics) > 0 {
			topicsList = reqBody.Topics
		}
		for _, tp := range topicsList {
			if openalex.ValidateTopicFormat(tp) {
				topics = append(topics, tp)
			}
		}
	}

	keywords := cfg.Keywords
	if strings.TrimSpace(reqBody.Query) != "" {
		keywords = strings.TrimSpace(reqBody.Query)
	}
	dateFrom := cfg.Filters.DateFrom
	if reqBody.DateFrom != "" {
		dateFrom = reqBody.DateFrom
	}
	dateTo := cfg.Filters.DateTo
	if reqBody.DateTo != "" {
		dateTo = reqBody.DateTo
	}
	docTypes := cfg.Filters.DocTypes
	if len(reqBody.DocTypes) > 0 {
		docTypes = reqBody.DocTypes
	}

	filterStr := openalex.BuildFilter(keywords, topics, dateFrom, dateTo, docTypes)
	client := openalex.NewClient(cfg.API.Keys, cfg.API.Email, cfg.Collection.PerPage, cfg.Collection.ConcurrentRequests, cfg.Collection.MaxRetries, cfg.Collection.RetryDelay)

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	totalCount, err := client.GetTotalCount(ctx, filterStr)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": "Failed to get paper count: " + err.Error()})
		return
	}

	estimatedMB := (float64(totalCount) * 8700.0) / (1024.0 * 1024.0)

	var freeGB float64
	var stat syscall.Statfs_t
	if err := syscall.Statfs(jsonlDir, &stat); err == nil {
		freeGB = float64(stat.Bavail*uint64(stat.Bsize)) / (1024 * 1024 * 1024)
	}

	targetPath := filepath.Join(jsonlDir, defaultFile)
	var existingPapers int
	var isResumable bool

	if fi, err := os.Stat(targetPath); err == nil && fi.Size() > 0 {
		progressPath := targetPath + ".download_progress.json"
		if _, pErr := os.Stat(progressPath); pErr == nil {
			isResumable = true
		}
		if f, err := os.Open(targetPath); err == nil {
			scanner := bufio.NewScanner(f)
			for scanner.Scan() {
				if strings.TrimSpace(scanner.Text()) != "" {
					existingPapers++
				}
			}
			f.Close()
		}
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"total":                  totalCount,
		"estimated_mb":          estimatedMB,
		"free_space_gb":         freeGB,
		"topics_count":          len(topics),
		"no_topics":              noTopics,
		"default_filename":       defaultFile,
		"jsonl_dir":              jsonlDir,
		"existing_papers":        existingPapers,
		"is_resumable":           isResumable,
		"needs_overwrite_choice": existingPapers > 0 && !isResumable,
	})
}

// handleDownloadPapers initiates concurrent download of matching papers to a JSONL file (matching openalex download).
func (s *APIServer) handleDownloadPapers(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		http.Error(w, `{"error": "Method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	project := r.URL.Query().Get("project")
	configDBPath, _, jsonlDir, _, _ := s.getProjectPaths(project)

	cfg, err := config.LoadConfig(configDBPath)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "Failed to load config: " + err.Error()})
		return
	}

	var reqBody downloadPapersRequest
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&reqBody)
	}

	if strings.TrimSpace(reqBody.Query) != "" {
		cfg.Keywords = strings.TrimSpace(reqBody.Query)
	}
	if reqBody.DateFrom != "" {
		cfg.Filters.DateFrom = reqBody.DateFrom
	}
	if reqBody.DateTo != "" {
		cfg.Filters.DateTo = reqBody.DateTo
	}
	if len(reqBody.DocTypes) > 0 {
		cfg.Filters.DocTypes = reqBody.DocTypes
	}
	if len(reqBody.Topics) > 0 {
		cfg.Topics = reqBody.Topics
	}

	if errs := openalex.ValidateKeywords(cfg.Keywords); len(errs) > 0 {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "Query validation failed: " + strings.Join(errs, "; ")})
		return
	}

	outFilename := strings.TrimSpace(reqBody.Output)
	if outFilename == "" {
		if project != "" && project != "default" {
			outFilename = project + ".jsonl"
		} else {
			outFilename = "collected_papers.jsonl"
		}
	}
	outFilename = filepath.Base(outFilename)
	if !strings.HasSuffix(strings.ToLower(outFilename), ".jsonl") {
		outFilename += ".jsonl"
	}

	if err := os.MkdirAll(jsonlDir, 0755); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": "Failed to create jsonl directory: " + err.Error()})
		return
	}
	targetPath := filepath.Join(jsonlDir, outFilename)

	if reqBody.Overwrite {
		_ = os.Remove(targetPath)
		_ = os.Remove(targetPath + ".download_progress.json")
	}

	status := s.getPipelineStatus(project)

	s.mu.Lock()
	if status.Syncing {
		s.mu.Unlock()
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(map[string]string{"error": "A pipeline or download task is already running"})
		return
	}
	status.Syncing = true
	status.Progress = 0
	status.Logs = []string{}

	ctx, cancel := context.WithCancel(context.Background())
	s.pipelineCancelFuncs[project] = cancel
	s.mu.Unlock()

	s.addLog(project, "[INFO] OpenAlex Download Papers process initiated (following openalex download).")
	s.addLog(project, fmt.Sprintf("[INFO] Destination: %s", targetPath))

	go func() {
		defer func() {
			s.mu.Lock()
			delete(s.pipelineCancelFuncs, project)
			status.Syncing = false
			s.mu.Unlock()
		}()

		var topics []string
		if !reqBody.NoTopics {
			for _, tp := range cfg.Topics {
				if openalex.ValidateTopicFormat(tp) {
					topics = append(topics, tp)
				}
			}
		}

		filterStr := openalex.BuildFilter(cfg.Keywords, topics, cfg.Filters.DateFrom, cfg.Filters.DateTo, cfg.Filters.DocTypes)
		client := openalex.NewClient(cfg.API.Keys, cfg.API.Email, cfg.Collection.PerPage, cfg.Collection.ConcurrentRequests, cfg.Collection.MaxRetries, cfg.Collection.RetryDelay)

		// Pre-flight estimation
		totalCount, err := client.GetTotalCount(ctx, filterStr)
		if err != nil {
			s.updateStatus(project, false, 0, "[ERROR] Pre-flight estimation failed: "+err.Error())
			return
		}

		estimatedMB := (float64(totalCount) * 8700.0) / (1024.0 * 1024.0)
		topicDesc := fmt.Sprintf("%d topic IDs", len(topics))
		if reqBody.NoTopics || len(topics) == 0 {
			topicDesc = "None (keywords only --no-topics)"
		}

		var freeGB float64
		var stat syscall.Statfs_t
		if err := syscall.Statfs(jsonlDir, &stat); err == nil {
			freeGB = float64(stat.Bavail*uint64(stat.Bsize)) / (1024 * 1024 * 1024)
		}

		s.addLog(project, fmt.Sprintf("[INFO] [Pre-flight] Total matching papers: %d (~%.1f MB estimated)", totalCount, estimatedMB))
		s.addLog(project, fmt.Sprintf("[INFO] [Pre-flight] Topics filter: %s", topicDesc))
		if freeGB > 0 {
			s.addLog(project, fmt.Sprintf("[INFO] [Pre-flight] Available disk space: %.1f GB free", freeGB))
		}

		opts := openalex.DownloadOptions{
			NoTopics:        reqBody.NoTopics,
			Deduplicate:     true,
			TotalExpected:   totalCount,
			BatchSizeTopics: cfg.Collection.BatchSizeTopics,
		}

		progressChan := make(chan int, 100)
		logChan := make(chan string, 100)
		errChan := make(chan error, 1)

		go func() {
			stats, err := client.DownloadPapersWithOptions(ctx, cfg, targetPath, opts, progressChan, logChan)
			if err != nil {
				errChan <- err
			} else {
				errChan <- nil
				if stats != nil {
					s.addLog(project, fmt.Sprintf("[SUCCESS] Download complete! %d unique papers collected (+%d new, %d existing). %d duplicates skipped.",
						stats.Collected, stats.NewPapers, stats.ExistingPapers, stats.DuplicatesSkipped))
					fileMB := float64(stats.FileSize) / (1024 * 1024)
					s.addLog(project, fmt.Sprintf("[INFO] Saved to: %s (%.2f MB). Time elapsed: %s.",
						targetPath, fileMB, stats.Duration.Round(time.Second)))
				}
			}
		}()

		lastLogTime := time.Now()
		var lastLoggedCount int64 = -1

		for {
			select {
			case logMsg, ok := <-logChan:
				if ok {
					s.addLog(project, logMsg)
				}
			case p, ok := <-progressChan:
				if !ok {
					progressChan = nil
				} else {
					var pct int
					if totalCount > 0 {
						pct = int(float64(p) / float64(totalCount) * 100)
						if pct > 99 {
							pct = 99
						}
					}
					s.mu.Lock()
					status.Progress = pct
					s.mu.Unlock()

					if time.Since(lastLogTime) >= 3*time.Second || int64(p)-lastLoggedCount >= 500 {
						lastLogTime = time.Now()
						lastLoggedCount = int64(p)
						s.addLog(project, fmt.Sprintf("[INFO] Download progress: %d papers collected (%d%%).", p, pct))
					}
				}
			case err := <-errChan:
				if err != nil {
					if ctx.Err() == context.Canceled {
						s.updateStatus(project, false, 0, "[WARNING] Download was cancelled by user. Cursor state preserved for resume.")
					} else {
						s.updateStatus(project, false, 0, "[ERROR] Download failed: "+err.Error())
					}
					return
				}
				s.updateStatus(project, false, 100, fmt.Sprintf("[SUCCESS] Download Papers complete! Output stored in %s.", outFilename))
				return
			}
		}
	}()

	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":   "started",
		"output":   targetPath,
		"filename": outFilename,
	})
}

// handlePipelineCancel cancels an ongoing download or pipeline sync.
func (s *APIServer) handlePipelineCancel(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		http.Error(w, `{"error": "Method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	project := r.URL.Query().Get("project")
	if project == "" {
		project = "default"
	}
	project = sanitizeProjectName(project)

	s.mu.Lock()
	cancel, ok := s.pipelineCancelFuncs[project]
	if ok && cancel != nil {
		cancel()
		delete(s.pipelineCancelFuncs, project)
		s.mu.Unlock()
		s.addLog(project, "[WARNING] Pipeline cancellation requested by user.")
		json.NewEncoder(w).Encode(map[string]string{"status": "cancelled"})
		return
	}
	s.mu.Unlock()

	json.NewEncoder(w).Encode(map[string]string{"status": "not_running"})
}

// handleDownloadFile serves a downloaded JSONL file for browser download.
func (s *APIServer) handleDownloadFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	project := r.URL.Query().Get("project")
	_, _, jsonlDir, _, _ := s.getProjectPaths(project)

	fileName := r.URL.Query().Get("file")
	if fileName == "" {
		if project != "" && project != "default" {
			fileName = project + ".jsonl"
		} else {
			fileName = "collected_papers.jsonl"
		}
	}
	fileName = filepath.Base(fileName)
	targetPath := filepath.Join(jsonlDir, fileName)

	if fi, err := os.Stat(targetPath); err != nil || fi.IsDir() {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, fileName))
	w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
	http.ServeFile(w, r, targetPath)
}
