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
	"sort"
	"strconv"
	"strings"
	"time"
)

// =====================================================================
// Country Imputation Types & Handlers
// =====================================================================

// ImputeStatus tracks the state and log output of the JSONL country imputation process.
type ImputeStatus struct {
	Running    bool              `json:"running"`
	Progress   int               `json:"progress"`
	Logs       []string          `json:"logs"`
	OutputFile string            `json:"output_file,omitempty"`
	Stats      map[string]string `json:"stats,omitempty"`
	Error      string            `json:"error,omitempty"`
}

// ImputeFileItem describes a JSONL file available for imputation.
type ImputeFileItem struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	SizeBytes int64  `json:"size_bytes"`
	SizeHuman string `json:"size_human"`
	ModTime   string `json:"mod_time"`
	IsImputed bool   `json:"is_imputed"`
}

type imputeRunRequest struct {
	InputPath  string `json:"input_path"`
	OutputPath string `json:"output_path"`
	Limit      *int   `json:"limit"`
	UseROR     *bool  `json:"use_ror"`
}

func (s *APIServer) getImputeStatus(project string) *ImputeStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	if st, exists := s.imputeStatuses[project]; exists {
		return st
	}
	st := &ImputeStatus{
		Running:  false,
		Progress: 0,
		Logs:     []string{},
		Stats:    make(map[string]string),
	}
	s.imputeStatuses[project] = st
	return st
}

func (s *APIServer) addImputeLog(project string, msg string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, exists := s.imputeStatuses[project]
	if !exists {
		st = &ImputeStatus{
			Running:  false,
			Progress: 0,
			Logs:     []string{},
			Stats:    make(map[string]string),
		}
		s.imputeStatuses[project] = st
	}
	st.Logs = append(st.Logs, msg)
	if len(st.Logs) > 1500 {
		st.Logs = st.Logs[len(st.Logs)-1500:]
	}
}

// handleImputeFiles lists all JSONL files in the active project's jsonl directory.
func (s *APIServer) handleImputeFiles(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodGet {
		http.Error(w, `{"error": "Method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	project := r.URL.Query().Get("project")
	if project == "" {
		project = "default"
	}
	project = sanitizeProjectName(project)
	_, _, jsonlDir, _, _ := s.getProjectPaths(project)

	files := make([]ImputeFileItem, 0)
	entries, err := os.ReadDir(jsonlDir)
	if err == nil {
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			name := e.Name()
			if strings.HasSuffix(strings.ToLower(name), ".jsonl") {
				info, err := e.Info()
				var sizeBytes int64
				var modTime string
				var sizeHuman string
				if err == nil {
					sizeBytes = info.Size()
					modTime = info.ModTime().Format("2006-01-02 15:04:05")
					if sizeBytes < 1024 {
						sizeHuman = fmt.Sprintf("%d B", sizeBytes)
					} else if sizeBytes < 1024*1024 {
						sizeHuman = fmt.Sprintf("%.1f KB", float64(sizeBytes)/1024.0)
					} else {
						sizeHuman = fmt.Sprintf("%.1f MB", float64(sizeBytes)/(1024.0*1024.0))
					}
				}
				isImputed := strings.Contains(strings.ToLower(name), "imputed")
				files = append(files, ImputeFileItem{
					Name:      name,
					Path:      filepath.Join(jsonlDir, name),
					SizeBytes: sizeBytes,
					SizeHuman: sizeHuman,
					ModTime:   modTime,
					IsImputed: isImputed,
				})
			}
		}
	}

	sort.Slice(files, func(i, j int) bool {
		return files[i].ModTime > files[j].ModTime
	})

	json.NewEncoder(w).Encode(map[string]interface{}{
		"files":     files,
		"jsonl_dir": jsonlDir,
	})
}

// handleJSONLPreview streams and parses sample paper records from a JSONL file for UI preview.
func (s *APIServer) handleJSONLPreview(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodGet {
		http.Error(w, `{"error": "Method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	project := r.URL.Query().Get("project")
	if project == "" {
		project = "default"
	}
	project = sanitizeProjectName(project)
	_, _, jsonlDir, _, _ := s.getProjectPaths(project)

	fileName := filepath.Base(r.URL.Query().Get("file"))
	if fileName == "" || fileName == "." {
		if project != "" && project != "default" {
			if _, err := os.Stat(filepath.Join(jsonlDir, project+".jsonl")); err == nil {
				fileName = project + ".jsonl"
			} else if _, err := os.Stat(filepath.Join(jsonlDir, project+"_imputed.jsonl")); err == nil {
				fileName = project + "_imputed.jsonl"
			} else {
				fileName = "collected_papers.jsonl"
			}
		} else {
			fileName = "collected_papers.jsonl"
		}
	}
	if !strings.HasSuffix(strings.ToLower(fileName), ".jsonl") {
		fileName += ".jsonl"
	}

	targetPath := filepath.Join(jsonlDir, fileName)
	file, err := os.Open(targetPath)
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{"error": fmt.Sprintf("File %q not found in project %q", fileName, project)})
		return
	}
	defer file.Close()

	limit := 25
	if lStr := r.URL.Query().Get("limit"); lStr != "" {
		if parsed, err := strconv.Atoi(lStr); err == nil && parsed > 0 && parsed <= 100 {
			limit = parsed
		}
	}
	offset := 0
	if oStr := r.URL.Query().Get("offset"); oStr != "" {
		if parsed, err := strconv.Atoi(oStr); err == nil && parsed >= 0 {
			offset = parsed
		}
	}

	type authorPreview struct {
		Name           string   `json:"name"`
		Institutions   []string `json:"institutions"`
		Countries      []string `json:"countries"`
		RawAffiliation string   `json:"raw_affiliation,omitempty"`
	}

	type paperPreview struct {
		ID              string          `json:"id"`
		Title           string          `json:"title"`
		PublicationYear int             `json:"publication_year"`
		DOI             string          `json:"doi"`
		CitedByCount    int             `json:"cited_by_count"`
		PrimaryTopic    string          `json:"primary_topic"`
		Authors         []authorPreview `json:"authors"`
		HasMissingCodes bool            `json:"has_missing_codes"`
	}

	var papers []paperPreview
	scanner := bufio.NewScanner(file)
	buf := make([]byte, 1024*1024)
	scanner.Buffer(buf, 10*1024*1024)

	lineIdx := 0
	totalCount := 0
	for scanner.Scan() {
		text := strings.TrimSpace(scanner.Text())
		if text == "" {
			continue
		}
		totalCount++
		if lineIdx >= offset && len(papers) < limit {
			var raw map[string]interface{}
			if json.Unmarshal([]byte(text), &raw) == nil {
				p := paperPreview{
					ID:    fmt.Sprintf("%v", raw["id"]),
					Title: fmt.Sprintf("%v", raw["title"]),
				}
				if yr, ok := raw["publication_year"].(float64); ok {
					p.PublicationYear = int(yr)
				}
				if doi, ok := raw["doi"].(string); ok {
					p.DOI = doi
				}
				if cb, ok := raw["cited_by_count"].(float64); ok {
					p.CitedByCount = int(cb)
				}
				if pt, ok := raw["primary_topic"].(map[string]interface{}); ok {
					if dn, ok := pt["display_name"].(string); ok {
						p.PrimaryTopic = dn
					}
				}

				if authorships, ok := raw["authorships"].([]interface{}); ok {
					for _, aItem := range authorships {
						if aMap, ok := aItem.(map[string]interface{}); ok {
							ap := authorPreview{}
							if authObj, ok := aMap["author"].(map[string]interface{}); ok {
								ap.Name = fmt.Sprintf("%v", authObj["display_name"])
							}
							if instList, ok := aMap["institutions"].([]interface{}); ok {
								for _, inst := range instList {
									if instMap, ok := inst.(map[string]interface{}); ok {
										ap.Institutions = append(ap.Institutions, fmt.Sprintf("%v", instMap["display_name"]))
										if cc, ok := instMap["country_code"].(string); ok && cc != "" {
											ap.Countries = append(ap.Countries, cc)
										}
									}
								}
							}
							if len(ap.Countries) == 0 {
								if cList, ok := aMap["countries"].([]interface{}); ok {
									for _, c := range cList {
										if cs, ok := c.(string); ok && cs != "" {
											ap.Countries = append(ap.Countries, cs)
										}
									}
								}
							}
							if len(ap.Institutions) > 0 && len(ap.Countries) == 0 {
								p.HasMissingCodes = true
							}
							if rawAffs, ok := aMap["raw_affiliation_strings"].([]interface{}); ok && len(rawAffs) > 0 {
								ap.RawAffiliation = fmt.Sprintf("%v", rawAffs[0])
							}
							p.Authors = append(p.Authors, ap)
						}
					}
				}
				papers = append(papers, p)
			}
		}
		lineIdx++
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"project":      project,
		"filename":     fileName,
		"total_papers": totalCount,
		"offset":       offset,
		"limit":        limit,
		"papers":       papers,
	})
}

// handleImputeStatus returns the status and logs of the active country imputation job.
func (s *APIServer) handleImputeStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodGet {
		http.Error(w, `{"error": "Method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	project := r.URL.Query().Get("project")
	if project == "" {
		project = "default"
	}
	project = sanitizeProjectName(project)

	status := s.getImputeStatus(project)
	s.mu.Lock()
	defer s.mu.Unlock()
	json.NewEncoder(w).Encode(status)
}

// handleImputeCancel cancels the running country imputation process.
func (s *APIServer) handleImputeCancel(w http.ResponseWriter, r *http.Request) {
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
	cancel, ok := s.imputeCancelFuncs[project]
	if ok && cancel != nil {
		cancel()
		delete(s.imputeCancelFuncs, project)
		s.mu.Unlock()
		s.addImputeLog(project, "[WARNING] Country imputation cancellation requested by user.")
		json.NewEncoder(w).Encode(map[string]string{"status": "cancelling"})
		return
	}
	s.mu.Unlock()

	json.NewEncoder(w).Encode(map[string]string{"status": "not_running"})
}

// handleImputeRun launches openalex impute-country in background.
func (s *APIServer) handleImputeRun(w http.ResponseWriter, r *http.Request) {
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
	_, _, jsonlDir, _, _ := s.getProjectPaths(project)

	var reqBody imputeRunRequest
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&reqBody)
	}

	inPath := strings.TrimSpace(reqBody.InputPath)
	if inPath == "" {
		projJSONL := filepath.Join(jsonlDir, project+".jsonl")
		if _, err := os.Stat(projJSONL); err == nil {
			inPath = projJSONL
		} else {
			inPath = filepath.Join(jsonlDir, "collected_papers.jsonl")
		}
	} else if !filepath.IsAbs(inPath) {
		inPath = filepath.Join(jsonlDir, inPath)
	}

	if _, err := os.Stat(inPath); os.IsNotExist(err) {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{
			"error": fmt.Sprintf("Input JSONL file not found at %s", inPath),
		})
		return
	}

	outPath := strings.TrimSpace(reqBody.OutputPath)
	if outPath == "" {
		ext := filepath.Ext(inPath)
		stem := strings.TrimSuffix(filepath.Base(inPath), ext)
		outPath = filepath.Join(filepath.Dir(inPath), stem+"_imputed"+ext)
	} else if !filepath.IsAbs(outPath) {
		outPath = filepath.Join(jsonlDir, outPath)
	}
	if !strings.HasSuffix(strings.ToLower(outPath), ".jsonl") {
		outPath += ".jsonl"
	}

	status := s.getImputeStatus(project)
	s.mu.Lock()
	if status.Running {
		s.mu.Unlock()
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "A country imputation job is already running for this project.",
		})
		return
	}
	status.Running = true
	status.Progress = 0
	status.Logs = []string{}
	status.Stats = make(map[string]string)
	status.OutputFile = filepath.Base(outPath)
	status.Error = ""

	ctx, cancel := context.WithCancel(context.Background())
	s.imputeCancelFuncs[project] = cancel
	s.mu.Unlock()

	s.addImputeLog(project, fmt.Sprintf("[%s] [INFO] Starting OpenAlex JSONL country imputation (impute_country.py)...", time.Now().Format("15:04:05")))
	s.addImputeLog(project, fmt.Sprintf("[INFO] Input file:  %s", inPath))
	s.addImputeLog(project, fmt.Sprintf("[INFO] Output file: %s", outPath))
	if reqBody.Limit != nil && *reqBody.Limit > 0 {
		s.addImputeLog(project, fmt.Sprintf("[INFO] Record limit: %d", *reqBody.Limit))
	}
	rorEnabled := reqBody.UseROR == nil || *reqBody.UseROR
	s.addImputeLog(project, fmt.Sprintf("[INFO] ROR lookups: %v", rorEnabled))

	go func() {
		defer func() {
			s.mu.Lock()
			delete(s.imputeCancelFuncs, project)
			status.Running = false
			s.mu.Unlock()
		}()

		pythonBin := findPythonInterpreter()
		openalexDir := findOpenAlexDir()
		openalexBin := findOpenAlexBinary()

		var args []string
		args = append(args, inPath, "-o", outPath)
		if reqBody.Limit != nil && *reqBody.Limit > 0 {
			args = append(args, "--limit", fmt.Sprintf("%d", *reqBody.Limit))
		}
		if reqBody.UseROR != nil && !*reqBody.UseROR {
			args = append(args, "--no-ror")
		} else {
			args = append(args, "--ror")
		}

		var cmd *exec.Cmd
		if openalexBin != "" {
			cmdArgs := append([]string{"impute-country"}, args...)
			cmd = exec.CommandContext(ctx, openalexBin, cmdArgs...)
		} else {
			pyArgs := []string{
				"-u",
				"-c",
				"import sys; from openalex.commands.impute_country import impute_country_command; impute_country_command.main(args=sys.argv[1:])",
			}
			pyArgs = append(pyArgs, args...)
			cmd = exec.CommandContext(ctx, pythonBin, pyArgs...)
		}

		if openalexDir != "" {
			cmd.Dir = openalexDir
		}
		cmd.Env = append(os.Environ(), "PYTHONUNBUFFERED=1")

		stdoutPipe, err := cmd.StdoutPipe()
		if err != nil {
			s.addImputeLog(project, "[ERROR] Failed to obtain stdout pipe: "+err.Error())
			s.mu.Lock()
			status.Error = err.Error()
			s.mu.Unlock()
			return
		}
		stderrPipe, err := cmd.StderrPipe()
		if err != nil {
			s.addImputeLog(project, "[ERROR] Failed to obtain stderr pipe: "+err.Error())
			s.mu.Lock()
			status.Error = err.Error()
			s.mu.Unlock()
			return
		}

		if err := cmd.Start(); err != nil {
			s.addImputeLog(project, "[ERROR] Failed to start command: "+err.Error())
			s.mu.Lock()
			status.Error = err.Error()
			s.mu.Unlock()
			return
		}

		scanner := bufio.NewScanner(io.MultiReader(stdoutPipe, stderrPipe))
		for scanner.Scan() {
			line := scanner.Text()
			s.addImputeLog(project, line)

			trimmed := strings.TrimSpace(line)
			if strings.Contains(trimmed, ":") && !strings.HasPrefix(trimmed, "http") && !strings.HasPrefix(trimmed, "[") && !strings.HasPrefix(trimmed, "=") && !strings.HasPrefix(trimmed, "-") {
				parts := strings.SplitN(trimmed, ":", 2)
				if len(parts) == 2 {
					k := strings.TrimSpace(parts[0])
					v := strings.TrimSpace(parts[1])
					s.mu.Lock()
					if status.Stats != nil && k != "" && v != "" {
						status.Stats[k] = v
					}
					s.mu.Unlock()
				}
			}
		}

		if err := cmd.Wait(); err != nil {
			if ctx.Err() == context.Canceled {
				s.addImputeLog(project, "[CANCEL] Country imputation cancelled by user.")
			} else {
				s.addImputeLog(project, "[ERROR] Imputation process failed: "+err.Error())
				s.mu.Lock()
				status.Error = err.Error()
				s.mu.Unlock()
			}
		} else {
			s.mu.Lock()
			status.Progress = 100
			s.mu.Unlock()
			s.addImputeLog(project, fmt.Sprintf("[%s] [SUCCESS] Imputation complete! Imputed JSONL written to: %s", time.Now().Format("15:04:05"), outPath))
		}
	}()

	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":      "started",
		"input_path":  inPath,
		"output_path": outPath,
		"output_file": filepath.Base(outPath),
	})
}
