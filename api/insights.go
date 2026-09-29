package api

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// =====================================================================
// Insights Page: Critical Technology Tracker (CTT) Types & Handlers
// =====================================================================

type CTTOutputFile struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	Category  string `json:"category"` // "dashboard", "bibliometrics", "verification"
	SizeBytes int64  `json:"size_bytes"`
	SizeHuman string `json:"size_human"`
	ModTime   string `json:"mod_time"`
}

type CTTStatus struct {
	Running     bool              `json:"running"`
	Progress    int               `json:"progress"`
	Logs        []string          `json:"logs"`
	Stats       map[string]string `json:"stats,omitempty"`
	OutputFiles []CTTOutputFile   `json:"output_files,omitempty"`
	OutputDir   string            `json:"output_dir,omitempty"`
	CompletedAt string            `json:"completed_at,omitempty"`
	Error       string            `json:"error,omitempty"`
}

type CTTRunRequest struct {
	InputDir    string `json:"input_dir"`
	OutputDir   string `json:"output_dir"`
	CountryFile string `json:"country_file"`
	Deduplicate *bool  `json:"deduplicate"`
	Workers     int    `json:"workers"`
	SpecificDB  string `json:"specific_db"`
	TechID      int    `json:"tech_id"`
	SubTechID   int    `json:"sub_tech_id"`
	Label       string `json:"label"`
}

type CTTFilesResponse struct {
	InputDir       string             `json:"input_dir"`
	OutputDir      string             `json:"output_dir"`
	CountryFile    string             `json:"country_file"`
	HasCountryFile bool               `json:"has_country_file"`
	Databases      []DiscoveredDBItem `json:"databases"`
	OutputFiles    []CTTOutputFile    `json:"output_files"`
	LastStatus     *CTTStatus         `json:"last_status,omitempty"`
}

func findCTTScript() string {
	candidates := []string{
		"run_ctt.py",
		filepath.Join(".", "run_ctt.py"),
		"/run/media/krishnakumar/New Volume/IISC/stratum-core/run_ctt.py",
	}
	for _, p := range candidates {
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return p
		}
	}
	return "run_ctt.py"
}

func (s *APIServer) getCTTStatus(project string) *CTTStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.cttStatuses[project]
	if !ok {
		st = &CTTStatus{
			Running:  false,
			Progress: 0,
			Logs:     []string{},
			Stats:    make(map[string]string),
		}
		s.cttStatuses[project] = st
	}
	return st
}

func (s *APIServer) addCTTLog(project string, msg string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.cttStatuses[project]
	if !ok {
		st = &CTTStatus{
			Running:  false,
			Progress: 0,
			Logs:     []string{},
			Stats:    make(map[string]string),
		}
		s.cttStatuses[project] = st
	}
	clean := stripANSI(msg)
	st.Logs = append(st.Logs, clean)
	if len(st.Logs) > 5000 {
		st.Logs = st.Logs[len(st.Logs)-5000:]
	}
}

func (s *APIServer) resolveCTTDir(dirName string) string {
	if dirName == "" {
		dirName = "ctt_outputs"
	}
	if filepath.IsAbs(dirName) {
		return dirName
	}
	if fi, err := os.Stat(dirName); err == nil && fi.IsDir() {
		if abs, err := filepath.Abs(dirName); err == nil {
			return abs
		}
		return dirName
	}
	baseDir := s.workspaceDir
	if baseDir != "" {
		cand := filepath.Join(baseDir, dirName)
		if fi, err := os.Stat(cand); err == nil && fi.IsDir() {
			return cand
		}
	}
	if abs, err := filepath.Abs(dirName); err == nil {
		return abs
	}
	return dirName
}

func (s *APIServer) scanCTTOutputs(outputDir string) []CTTOutputFile {
	outputDir = s.resolveCTTDir(outputDir)

	var results []CTTOutputFile

	// 1. Master dashboard Excel
	dashPath := filepath.Join(outputDir, "CTT_dashboard_overall.xlsx")
	if fi, err := os.Stat(dashPath); err == nil && !fi.IsDir() {
		results = append(results, CTTOutputFile{
			Name:      fi.Name(),
			Path:      "CTT_dashboard_overall.xlsx",
			Category:  "dashboard",
			SizeBytes: fi.Size(),
			SizeHuman: formatBytesHuman(fi.Size()),
			ModTime:   fi.ModTime().Format("2006-01-02 15:04:05"),
		})
	}

	// 2. Bibliometric indicator files
	bibDir := filepath.Join(outputDir, "CTT_bibliometrics")
	if entries, err := os.ReadDir(bibDir); err == nil {
		for _, e := range entries {
			if !e.IsDir() && strings.HasSuffix(strings.ToLower(e.Name()), ".xlsx") {
				if fi, err := e.Info(); err == nil {
					results = append(results, CTTOutputFile{
						Name:      e.Name(),
						Path:      filepath.Join("CTT_bibliometrics", e.Name()),
						Category:  "bibliometrics",
						SizeBytes: fi.Size(),
						SizeHuman: formatBytesHuman(fi.Size()),
						ModTime:   fi.ModTime().Format("2006-01-02 15:04:05"),
					})
				}
			}
		}
	}

	// 3. Verification check files
	verDir := filepath.Join(outputDir, "CTT_verification")
	if entries, err := os.ReadDir(verDir); err == nil {
		for _, e := range entries {
			if !e.IsDir() && strings.HasSuffix(strings.ToLower(e.Name()), ".xlsx") {
				if fi, err := e.Info(); err == nil {
					results = append(results, CTTOutputFile{
						Name:      e.Name(),
						Path:      filepath.Join("CTT_verification", e.Name()),
						Category:  "verification",
						SizeBytes: fi.Size(),
						SizeHuman: formatBytesHuman(fi.Size()),
						ModTime:   fi.ModTime().Format("2006-01-02 15:04:05"),
					})
				}
			}
		}
	}

	return results
}

func (s *APIServer) findAvailableCTTDatabases(inputDir string) []DiscoveredDBItem {
	var items []DiscoveredDBItem
	seenPaths := make(map[string]bool)

	baseDir := s.workspaceDir
	if baseDir == "" {
		baseDir = "."
	}

	searchDirs := []struct {
		dir    string
		source string
	}{
		{inputDir, "Custom Input"},
		{"ctt_inputfiles", "CTT Input"},
		{filepath.Join(baseDir, "ctt_inputfiles"), "CTT Input"},
		{filepath.Join(baseDir, "data", "db"), "Stratum DB"},
		{"/run/media/krishnakumar/New Volume/IISC/openAlex_data_collection/data/db", "OpenAlex DB"},
	}

	for _, sd := range searchDirs {
		if sd.dir == "" {
			continue
		}
		if _, err := os.Stat(sd.dir); os.IsNotExist(err) {
			continue
		}

		_ = filepath.Walk(sd.dir, func(p string, fi os.FileInfo, err error) error {
			if err != nil || fi == nil || fi.IsDir() {
				return nil
			}
			ext := strings.ToLower(filepath.Ext(fi.Name()))
			if ext == ".duckdb" {
				abs, _ := filepath.Abs(p)
				if !seenPaths[abs] {
					seenPaths[abs] = true
					items = append(items, DiscoveredDBItem{
						Name:      fi.Name(),
						Path:      abs,
						Source:    sd.source,
						Type:      "DuckDB",
						SizeBytes: fi.Size(),
						SizeHuman: formatBytesHuman(fi.Size()),
						ModTime:   fi.ModTime().Format("2006-01-02 15:04"),
					})
				}
			}
			return nil
		})
	}

	return items
}

func (s *APIServer) handleCTTFiles(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	project := r.URL.Query().Get("project")
	if project == "" {
		project = "default"
	}
	project = sanitizeProjectName(project)

	inputDir := "ctt_inputfiles"
	outputDir := "ctt_outputs"

	baseDir := s.workspaceDir
	if baseDir == "" {
		baseDir = "."
	}

	countryFile := filepath.Join(baseDir, "ctt_inputfiles", "Country_List_CTT_final.xlsx")
	hasCountry := false
	if _, err := os.Stat(countryFile); err == nil {
		hasCountry = true
	} else if _, err := os.Stat(filepath.Join(baseDir, "Country_List_CTT_final.xlsx")); err == nil {
		hasCountry = true
	} else if _, err := os.Stat("ctt_inputfiles/Country_List_CTT_final.xlsx"); err == nil {
		hasCountry = true
	} else if _, err := os.Stat("Country_List_CTT_final.xlsx"); err == nil {
		hasCountry = true
	} else if _, err := os.Stat("/run/media/krishnakumar/New Volume/IISC/stratum-core/ctt_inputfiles/Country_List_CTT_final.xlsx"); err == nil {
		hasCountry = true
	}

	dbs := s.findAvailableCTTDatabases(inputDir)
	outFiles := s.scanCTTOutputs(outputDir)
	status := s.getCTTStatus(project)

	resp := CTTFilesResponse{
		InputDir:       inputDir,
		OutputDir:      outputDir,
		CountryFile:    "Country_List_CTT_final.xlsx",
		HasCountryFile: hasCountry,
		Databases:      dbs,
		OutputFiles:    outFiles,
		LastStatus:     status,
	}

	json.NewEncoder(w).Encode(resp)
}

func (s *APIServer) handleCTTRun(w http.ResponseWriter, r *http.Request) {
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

	var reqBody CTTRunRequest
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&reqBody)
	}

	inputDir := strings.TrimSpace(reqBody.InputDir)
	if inputDir == "" {
		inputDir = "ctt_inputfiles"
	}

	outputDir := strings.TrimSpace(reqBody.OutputDir)
	if outputDir == "" {
		outputDir = "ctt_outputs"
	}

	countryFile := strings.TrimSpace(reqBody.CountryFile)
	if countryFile == "" {
		countryFile = "Country_List_CTT_final.xlsx"
	}

	status := s.getCTTStatus(project)
	s.mu.Lock()
	if status.Running {
		s.mu.Unlock()
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "A CTT bibliometrics pipeline job is already running.",
		})
		return
	}
	status.Running = true
	status.Progress = 0
	status.Logs = []string{}
	status.Stats = make(map[string]string)
	status.OutputDir = outputDir
	status.CompletedAt = ""
	status.Error = ""
	status.OutputFiles = nil

	ctx, cancel := context.WithCancel(context.Background())
	s.cttCancelFuncs[project] = cancel
	s.mu.Unlock()

	s.addCTTLog(project, fmt.Sprintf("[%s] [INFO] Launching Critical Technology Tracker pipeline (run_ctt.py)...", time.Now().Format("15:04:05")))
	s.addCTTLog(project, fmt.Sprintf("[INFO] Input Directory:  %s", inputDir))
	s.addCTTLog(project, fmt.Sprintf("[INFO] Output Directory: %s", outputDir))
	s.addCTTLog(project, fmt.Sprintf("[INFO] Country Master:   %s", countryFile))

	go func() {
		defer func() {
			s.mu.Lock()
			delete(s.cttCancelFuncs, project)
			status.Running = false
			s.mu.Unlock()
		}()

		pythonBin := findPythonInterpreter()
		scriptPath := findCTTScript()
		if abs, err := filepath.Abs(scriptPath); err == nil {
			scriptPath = abs
		}

		var args []string
		args = append(args, scriptPath)
		args = append(args, "--input-dir", inputDir)
		args = append(args, "--output-dir", outputDir)
		args = append(args, "--country-file", countryFile)

		if reqBody.Deduplicate != nil && !*reqBody.Deduplicate {
			args = append(args, "--no-dedup")
		} else {
			args = append(args, "--dedup")
		}

		workers := reqBody.Workers
		if workers <= 0 {
			workers = 4
		}
		args = append(args, "--workers", fmt.Sprintf("%d", workers))

		if reqBody.SpecificDB != "" {
			args = append(args, "--db", reqBody.SpecificDB)
			if reqBody.TechID > 0 {
				args = append(args, "--tech-id", fmt.Sprintf("%d", reqBody.TechID))
			}
			if reqBody.SubTechID > 0 {
				args = append(args, "--sub-tech-id", fmt.Sprintf("%d", reqBody.SubTechID))
			}
			if reqBody.Label != "" {
				args = append(args, "--label", reqBody.Label)
			}
		}

		cmd := exec.CommandContext(ctx, pythonBin, args...)
		cmd.Dir = filepath.Dir(scriptPath)
		cmd.Env = append(os.Environ(), "PYTHONUNBUFFERED=1")

		stdoutPipe, err := cmd.StdoutPipe()
		if err != nil {
			s.addCTTLog(project, "[ERROR] Failed to obtain stdout pipe: "+err.Error())
			s.mu.Lock()
			status.Error = err.Error()
			s.mu.Unlock()
			return
		}
		stderrPipe, err := cmd.StderrPipe()
		if err != nil {
			s.addCTTLog(project, "[ERROR] Failed to obtain stderr pipe: "+err.Error())
			s.mu.Lock()
			status.Error = err.Error()
			s.mu.Unlock()
			return
		}

		if err := cmd.Start(); err != nil {
			s.addCTTLog(project, "[ERROR] Failed to start run_ctt.py: "+err.Error())
			s.mu.Lock()
			status.Error = err.Error()
			s.mu.Unlock()
			return
		}

		scanner := bufio.NewScanner(io.MultiReader(stdoutPipe, stderrPipe))
		progressRegex := regexp.MustCompile(`\[PROGRESS\]\s*(\d+)%`)

		for scanner.Scan() {
			line := scanner.Text()
			s.addCTTLog(project, line)

			// Parse progress percentage
			if matches := progressRegex.FindStringSubmatch(line); len(matches) == 2 {
				var p int
				if _, err := fmt.Sscanf(matches[1], "%d", &p); err == nil {
					s.mu.Lock()
					status.Progress = p
					s.mu.Unlock()
				}
			}

			// Capture metrics into stats map
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "Dashboard:") {
				s.mu.Lock()
				status.Stats["dashboard"] = strings.TrimPrefix(trimmed, "Dashboard:")
				s.mu.Unlock()
			} else if strings.HasPrefix(trimmed, "Results:") {
				s.mu.Lock()
				status.Stats["indicators"] = strings.TrimPrefix(trimmed, "Results:")
				s.mu.Unlock()
			} else if strings.HasPrefix(trimmed, "Verification:") {
				s.mu.Lock()
				status.Stats["verification"] = strings.TrimPrefix(trimmed, "Verification:")
				s.mu.Unlock()
			}
		}

		if err := cmd.Wait(); err != nil {
			if ctx.Err() == context.Canceled {
				s.addCTTLog(project, "[CANCEL] CTT execution cancelled by user.")
			} else {
				s.addCTTLog(project, "[ERROR] CTT execution failed: "+err.Error())
				s.mu.Lock()
				status.Error = err.Error()
				s.mu.Unlock()
			}
		} else {
			s.mu.Lock()
			status.Progress = 100
			status.CompletedAt = time.Now().Format("2006-01-02 15:04:05")
			s.mu.Unlock()
			s.addCTTLog(project, fmt.Sprintf("[%s] [SUCCESS] Critical Technology Tracker run completed!", time.Now().Format("15:04:05")))
		}

		// Rescan outputs
		files := s.scanCTTOutputs(outputDir)
		s.mu.Lock()
		status.OutputFiles = files
		s.mu.Unlock()
	}()

	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":     "started",
		"input_dir":  inputDir,
		"output_dir": outputDir,
	})
}

func (s *APIServer) handleCTTStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	project := r.URL.Query().Get("project")
	if project == "" {
		project = "default"
	}
	project = sanitizeProjectName(project)

	status := s.getCTTStatus(project)
	s.mu.Lock()
	if len(status.OutputFiles) == 0 {
		outDir := status.OutputDir
		if outDir == "" {
			outDir = "ctt_outputs"
		}
		status.OutputFiles = s.scanCTTOutputs(outDir)
	}
	statusCopy := *status
	statusCopy.Logs = make([]string, len(status.Logs))
	copy(statusCopy.Logs, status.Logs)
	s.mu.Unlock()

	json.NewEncoder(w).Encode(statusCopy)
}

func (s *APIServer) handleCTTCancel(w http.ResponseWriter, r *http.Request) {
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
	cancel, ok := s.cttCancelFuncs[project]
	if ok && cancel != nil {
		cancel()
		delete(s.cttCancelFuncs, project)
		s.mu.Unlock()
		s.addCTTLog(project, "[WARNING] Cancellation requested by user.")
		json.NewEncoder(w).Encode(map[string]string{"status": "cancelling"})
		return
	}
	s.mu.Unlock()

	json.NewEncoder(w).Encode(map[string]string{"status": "not_running"})
}

func (s *APIServer) handleCTTDownload(w http.ResponseWriter, r *http.Request) {
	fileParam := r.URL.Query().Get("file")
	if fileParam == "" {
		http.Error(w, "Missing file parameter", http.StatusBadRequest)
		return
	}

	cleanRel := filepath.Clean(fileParam)
	if strings.Contains(cleanRel, "..") {
		http.Error(w, "Invalid file path", http.StatusBadRequest)
		return
	}

	outputDir := s.resolveCTTDir("ctt_outputs")
	fullPath := filepath.Join(outputDir, cleanRel)
	if fi, err := os.Stat(fullPath); os.IsNotExist(err) || fi.IsDir() {
		fullPath = filepath.Join("ctt_outputs", cleanRel)
	}

	fi, err := os.Stat(fullPath)
	if os.IsNotExist(err) || fi.IsDir() {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filepath.Base(cleanRel)))
	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	http.ServeFile(w, r, fullPath)
}
