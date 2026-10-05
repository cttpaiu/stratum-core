package api

import (
	"archive/zip"
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
	"strings"
	"time"

	"stratum/config"
)

// =====================================================================
// Export Page: Data Conversion, Artifact Bundles, and File Downloads
// =====================================================================

// ExportStatus tracks the state and log output of the json_to_csv export process.
type ExportStatus struct {
	Running     bool              `json:"running"`
	Mode        string            `json:"mode"`
	Progress    int               `json:"progress"`
	Logs        []string          `json:"logs"`
	Stats       map[string]string `json:"stats,omitempty"`
	OutputFiles []string          `json:"output_files,omitempty"`
	CSVFolder   string            `json:"csv_folder,omitempty"`
	DuckDBFile  string            `json:"duckdb_file,omitempty"`
	SQLiteFile  string            `json:"sqlite_file,omitempty"`
	SQLFile     string            `json:"sql_file,omitempty"`
	CompletedAt string            `json:"completed_at,omitempty"`
	Error       string            `json:"error,omitempty"`
}

type CSVFileItem struct {
	Name      string `json:"name"`
	SizeBytes int64  `json:"size_bytes"`
	SizeHuman string `json:"size_human"`
	ModTime   string `json:"mod_time"`
}

type CSVFolderItem struct {
	Name           string        `json:"name"`
	Path           string        `json:"path"`
	Files          []CSVFileItem `json:"files"`
	TotalSizeBytes int64         `json:"total_size_bytes"`
	TotalSizeHuman string        `json:"total_size_human"`
	ModTime        string        `json:"mod_time"`
}

type DuckDBFileItem struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	SizeBytes int64  `json:"size_bytes"`
	SizeHuman string `json:"size_human"`
	ModTime   string `json:"mod_time"`
}

type SQLiteFileItem struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	SizeBytes int64  `json:"size_bytes"`
	SizeHuman string `json:"size_human"`
	ModTime   string `json:"mod_time"`
}

type SQLFileItem struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	SizeBytes int64  `json:"size_bytes"`
	SizeHuman string `json:"size_human"`
	ModTime   string `json:"mod_time"`
}

type DiscoveredDBItem struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	Source    string `json:"source"`
	Type      string `json:"type"`
	SizeBytes int64  `json:"size_bytes"`
	SizeHuman string `json:"size_human"`
	ModTime   string `json:"mod_time"`
}

type ExportFilesResponse struct {
	Project             string             `json:"project"`
	JSONLFiles          []ImputeFileItem   `json:"jsonl_files"`
	CSVFolders          []CSVFolderItem    `json:"csv_folders"`
	DuckDBFiles         []DuckDBFileItem   `json:"duckdb_files"`
	SQLiteFiles         []SQLiteFileItem   `json:"sqlite_files"`
	SQLFiles            []SQLFileItem      `json:"sql_files"`
	DiscoveredDatabases []DiscoveredDBItem `json:"discovered_databases,omitempty"`
	LastStatus          *ExportStatus      `json:"last_status,omitempty"`
	HasSQLiteBrowser    bool               `json:"has_sqlitebrowser"`
}

type exportRunRequest struct {
	Mode         string `json:"mode"`          // "pipeline", "jsonl-to-csv", "csv-to-duckdb", "csv-to-sqlite", "csv-to-sql"
	JSONLPath    string `json:"jsonl_path"`     // relative to jsonlDir or custom
	CSVFolder    string `json:"csv_folder"`     // folder name under data/csv/
	DuckDBName   string `json:"duckdb_name"`    // filename under data/db/
	SQLiteName   string `json:"sqlite_name"`    // filename under data/db/
	SQLName      string `json:"sql_name"`       // filename under data/sql/
	CreateDuckDB bool   `json:"create_duckdb"`  // for pipeline mode
	CreateSQLite bool   `json:"create_sqlite"`  // for pipeline mode
	CreateSQL    bool   `json:"create_sql"`     // for pipeline mode
}

func findJsonToCsvScript() string {
	openalexDir := findOpenAlexDir()
	candidates := []string{
		"/run/media/krishnakumar/New Volume/IISC/openAlex_data_collection/json_to_csv.py",
		filepath.Join(openalexDir, "json_to_csv.py"),
		filepath.Join("..", "openAlex_data_collection", "json_to_csv.py"),
		"json_to_csv.py",
	}
	for _, p := range candidates {
		if p != "" {
			if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
				return p
			}
		}
	}
	return ""
}

func (s *APIServer) getExportStatus(project string) *ExportStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	if st, exists := s.exportStatuses[project]; exists {
		return st
	}
	st := &ExportStatus{
		Running:     false,
		Progress:    0,
		Logs:        []string{},
		Stats:       make(map[string]string),
		OutputFiles: []string{},
	}
	s.exportStatuses[project] = st
	return st
}

func (s *APIServer) addExportLog(project string, msg string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, exists := s.exportStatuses[project]
	if !exists {
		st = &ExportStatus{
			Running:     false,
			Progress:    0,
			Logs:        []string{},
			Stats:       make(map[string]string),
			OutputFiles: []string{},
		}
		s.exportStatuses[project] = st
	}
	st.Logs = append(st.Logs, msg)
	if len(st.Logs) > 1500 {
		st.Logs = st.Logs[len(st.Logs)-1500:]
	}
}

func (s *APIServer) getProjectExportDirs(project string) (projBaseDir, jsonlDir, csvBaseDir, dbBaseDir, sqlBaseDir string) {
	baseDir := s.workspaceDir
	if baseDir == "" {
		baseDir = "."
	}
	if project == "" || project == "default" {
		projBaseDir = baseDir
		dataDir := filepath.Join(baseDir, "data")
		jsonlDir = filepath.Join(dataDir, "jsonl")
		csvBaseDir = filepath.Join(dataDir, "csv")
		dbBaseDir = filepath.Join(dataDir, "db")
		sqlBaseDir = filepath.Join(dataDir, "sql")
		return
	}
	project = sanitizeProjectName(project)
	projBaseDir = filepath.Join(baseDir, "projects", project)
	dataDir := filepath.Join(projBaseDir, "data")
	jsonlDir = filepath.Join(dataDir, "jsonl")
	csvBaseDir = filepath.Join(dataDir, "csv")
	dbBaseDir = filepath.Join(dataDir, "db")
	sqlBaseDir = filepath.Join(dataDir, "sql")
	return
}

func (s *APIServer) ensureExportDirs(project string) error {
	baseDir := s.workspaceDir
	if baseDir == "" {
		baseDir = "."
	}
	var dataDir string
	if project == "" || project == "default" {
		dataDir = filepath.Join(baseDir, "data")
	} else {
		project = sanitizeProjectName(project)
		dataDir = filepath.Join(baseDir, "projects", project, "data")
	}
	_ = os.MkdirAll(filepath.Join(dataDir, "jsonl"), 0755)
	_ = os.MkdirAll(filepath.Join(dataDir, "csv"), 0755)
	_ = os.MkdirAll(filepath.Join(dataDir, "db"), 0755)
	_ = os.MkdirAll(filepath.Join(dataDir, "sql"), 0755)
	return nil
}

// handleExportFiles lists all JSONL, CSV folders, DuckDB databases, and SQL dumps.
func (s *APIServer) handleExportFiles(w http.ResponseWriter, r *http.Request) {
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
	projBaseDir, jsonlDir, csvBaseDir, dbBaseDir, sqlBaseDir := s.getProjectExportDirs(project)
	_ = s.ensureExportDirs(project)

	resp := ExportFilesResponse{
		Project:     project,
		JSONLFiles:  make([]ImputeFileItem, 0),
		CSVFolders:  make([]CSVFolderItem, 0),
		DuckDBFiles: make([]DuckDBFileItem, 0),
		SQLiteFiles: make([]SQLiteFileItem, 0),
		SQLFiles:    make([]SQLFileItem, 0),
	}

	// 1. JSONL Files
	if entries, err := os.ReadDir(jsonlDir); err == nil {
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
					sizeHuman = formatBytesHuman(sizeBytes)
				}
				isImputed := strings.Contains(strings.ToLower(name), "imputed")
				resp.JSONLFiles = append(resp.JSONLFiles, ImputeFileItem{
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
	sort.Slice(resp.JSONLFiles, func(i, j int) bool {
		return resp.JSONLFiles[i].ModTime > resp.JSONLFiles[j].ModTime
	})

	// 2. CSV Folders
	if entries, err := os.ReadDir(csvBaseDir); err == nil {
		directCSVFiles := make([]CSVFileItem, 0)
		var directTotalBytes int64
		var directLatestModTime string

		for _, e := range entries {
			if e.IsDir() {
				subDir := filepath.Join(csvBaseDir, e.Name())
				folderFiles := make([]CSVFileItem, 0)
				var folderTotalBytes int64
				var folderLatestModTime string

				if subEntries, err := os.ReadDir(subDir); err == nil {
					for _, se := range subEntries {
						if !se.IsDir() && strings.HasSuffix(strings.ToLower(se.Name()), ".csv") {
							info, err := se.Info()
							var sBytes int64
							var sMod string
							var sHuman string
							if err == nil {
								sBytes = info.Size()
								sMod = info.ModTime().Format("2006-01-02 15:04:05")
								sHuman = formatBytesHuman(sBytes)
								if sMod > folderLatestModTime {
									folderLatestModTime = sMod
								}
							}
							folderTotalBytes += sBytes
							folderFiles = append(folderFiles, CSVFileItem{
								Name:      se.Name(),
								SizeBytes: sBytes,
								SizeHuman: sHuman,
								ModTime:   sMod,
							})
						}
					}
				}
				sort.Slice(folderFiles, func(i, j int) bool {
					return folderFiles[i].Name < folderFiles[j].Name
				})

				folderModTime := folderLatestModTime
				if folderModTime == "" {
					if info, err := e.Info(); err == nil {
						folderModTime = info.ModTime().Format("2006-01-02 15:04:05")
					}
				}

				resp.CSVFolders = append(resp.CSVFolders, CSVFolderItem{
					Name:           e.Name(),
					Path:           subDir,
					Files:          folderFiles,
					TotalSizeBytes: folderTotalBytes,
					TotalSizeHuman: formatBytesHuman(folderTotalBytes),
					ModTime:        folderModTime,
				})
			} else if strings.HasSuffix(strings.ToLower(e.Name()), ".csv") {
				info, err := e.Info()
				var sBytes int64
				var sMod string
				var sHuman string
				if err == nil {
					sBytes = info.Size()
					sMod = info.ModTime().Format("2006-01-02 15:04:05")
					sHuman = formatBytesHuman(sBytes)
					if sMod > directLatestModTime {
						directLatestModTime = sMod
					}
				}
				directTotalBytes += sBytes
				directCSVFiles = append(directCSVFiles, CSVFileItem{
					Name:      e.Name(),
					SizeBytes: sBytes,
					SizeHuman: sHuman,
					ModTime:   sMod,
				})
			}
		}

		if len(directCSVFiles) > 0 {
			sort.Slice(directCSVFiles, func(i, j int) bool {
				return directCSVFiles[i].Name < directCSVFiles[i].Name
			})
			resp.CSVFolders = append(resp.CSVFolders, CSVFolderItem{
				Name:           "openalex_csv",
				Path:           csvBaseDir,
				Files:          directCSVFiles,
				TotalSizeBytes: directTotalBytes,
				TotalSizeHuman: formatBytesHuman(directTotalBytes),
				ModTime:        directLatestModTime,
			})
		}
	}
	sort.Slice(resp.CSVFolders, func(i, j int) bool {
		return resp.CSVFolders[i].ModTime > resp.CSVFolders[j].ModTime
	})

	// 3. Database Files (SQLite & DuckDB)
	seenDB := make(map[string]bool)
	scanDBDir := func(dir string) {
		if entries, err := os.ReadDir(dir); err == nil {
			for _, e := range entries {
				if e.IsDir() {
					continue
				}
				name := e.Name()
				lower := strings.ToLower(name)
				if strings.HasSuffix(lower, ".duckdb") || strings.HasSuffix(lower, ".sqlite") || (strings.HasSuffix(lower, ".db") && !strings.HasPrefix(lower, "config")) {
					fullPath := filepath.Join(dir, name)
					if seenDB[fullPath] {
						continue
					}
					seenDB[fullPath] = true
					info, err := e.Info()
					var sBytes int64
					var sMod string
					var sHuman string
					if err == nil {
						sBytes = info.Size()
						sMod = info.ModTime().Format("2006-01-02 15:04:05")
						sHuman = formatBytesHuman(sBytes)
					}

					// Detect if SQLite
					isSQLite := strings.HasSuffix(lower, ".sqlite")
					if !isSQLite && strings.HasSuffix(lower, ".db") {
						if f, err := os.Open(fullPath); err == nil {
							hdr := make([]byte, 16)
							if n, _ := f.Read(hdr); n >= 15 && string(hdr[:15]) == "SQLite format 3" {
								isSQLite = true
							}
							f.Close()
						}
					}

					if isSQLite {
						resp.SQLiteFiles = append(resp.SQLiteFiles, SQLiteFileItem{
							Name:      name,
							Path:      fullPath,
							SizeBytes: sBytes,
							SizeHuman: sHuman,
							ModTime:   sMod,
						})
					} else {
						resp.DuckDBFiles = append(resp.DuckDBFiles, DuckDBFileItem{
							Name:      name,
							Path:      fullPath,
							SizeBytes: sBytes,
							SizeHuman: sHuman,
							ModTime:   sMod,
						})
					}
				}
			}
		}
	}
	scanDBDir(dbBaseDir)
	if projBaseDir != "" {
		scanDBDir(filepath.Join(projBaseDir, "data"))
	}
	sort.Slice(resp.SQLiteFiles, func(i, j int) bool {
		return resp.SQLiteFiles[i].ModTime > resp.SQLiteFiles[j].ModTime
	})
	sort.Slice(resp.DuckDBFiles, func(i, j int) bool {
		return resp.DuckDBFiles[i].ModTime > resp.DuckDBFiles[j].ModTime
	})
	if _, err := exec.LookPath("sqlitebrowser"); err == nil {
		resp.HasSQLiteBrowser = true
	}

	// 4. SQL Files
	seenSQL := make(map[string]bool)
	scanSQLDir := func(dir string) {
		if entries, err := os.ReadDir(dir); err == nil {
			for _, e := range entries {
				if e.IsDir() {
					continue
				}
				name := e.Name()
				if strings.HasSuffix(strings.ToLower(name), ".sql") {
					fullPath := filepath.Join(dir, name)
					if seenSQL[fullPath] {
						continue
					}
					seenSQL[fullPath] = true
					info, err := e.Info()
					var sBytes int64
					var sMod string
					var sHuman string
					if err == nil {
						sBytes = info.Size()
						sMod = info.ModTime().Format("2006-01-02 15:04:05")
						sHuman = formatBytesHuman(sBytes)
					}
					resp.SQLFiles = append(resp.SQLFiles, SQLFileItem{
						Name:      name,
						Path:      fullPath,
						SizeBytes: sBytes,
						SizeHuman: sHuman,
						ModTime:   sMod,
					})
				}
			}
		}
	}
	scanSQLDir(sqlBaseDir)
	if projBaseDir != "" {
		scanSQLDir(filepath.Join(projBaseDir, "data"))
	}
	sort.Slice(resp.SQLFiles, func(i, j int) bool {
		return resp.SQLFiles[i].ModTime > resp.SQLFiles[j].ModTime
	})

	// Unified discovered databases list across active project, other projects, and openalex_data_collection
	resp.DiscoveredDatabases = make([]DiscoveredDBItem, 0)
	for _, d := range resp.DuckDBFiles {
		resp.DiscoveredDatabases = append(resp.DiscoveredDatabases, DiscoveredDBItem{
			Name:      d.Name,
			Path:      d.Path,
			Source:    fmt.Sprintf("Current Project (%s)", project),
			Type:      "DuckDB",
			SizeBytes: d.SizeBytes,
			SizeHuman: d.SizeHuman,
			ModTime:   d.ModTime,
		})
	}
	for _, d := range resp.SQLiteFiles {
		resp.DiscoveredDatabases = append(resp.DiscoveredDatabases, DiscoveredDBItem{
			Name:      d.Name,
			Path:      d.Path,
			Source:    fmt.Sprintf("Current Project (%s)", project),
			Type:      "SQLite",
			SizeBytes: d.SizeBytes,
			SizeHuman: d.SizeHuman,
			ModTime:   d.ModTime,
		})
	}

	// Scan other projects
	projectsDir := filepath.Join(s.workspaceDir, "projects")
	if pEntries, err := os.ReadDir(projectsDir); err == nil {
		for _, pe := range pEntries {
			if !pe.IsDir() || pe.Name() == project {
				continue
			}
			otherProj := pe.Name()
			otherDBDirs := []string{
				filepath.Join(projectsDir, otherProj, "data", "db"),
				filepath.Join(projectsDir, otherProj, "data"),
			}
			for _, od := range otherDBDirs {
				if dEntries, err := os.ReadDir(od); err == nil {
					for _, de := range dEntries {
						if de.IsDir() {
							continue
						}
						dLower := strings.ToLower(de.Name())
						if (strings.HasSuffix(dLower, ".duckdb") || strings.HasSuffix(dLower, ".sqlite") || strings.HasSuffix(dLower, ".db")) && !strings.HasPrefix(dLower, "config") {
							fPath := filepath.Join(od, de.Name())
							if seenDB[fPath] {
								continue
							}
							seenDB[fPath] = true
							var sBytes int64
							var sMod string
							var sHuman string
							if info, err := de.Info(); err == nil {
								sBytes = info.Size()
								sMod = info.ModTime().Format("2006-01-02 15:04:05")
								sHuman = formatBytesHuman(sBytes)
							}
							dbType := "DuckDB"
							if strings.HasSuffix(dLower, ".sqlite") || strings.HasSuffix(dLower, ".db") {
								dbType = "SQLite"
							}
							resp.DiscoveredDatabases = append(resp.DiscoveredDatabases, DiscoveredDBItem{
								Name:      de.Name(),
								Path:      fPath,
								Source:    fmt.Sprintf("Project: %s", otherProj),
								Type:      dbType,
								SizeBytes: sBytes,
								SizeHuman: sHuman,
								ModTime:   sMod,
							})
						}
					}
				}
			}
		}
	}

	// Scan openAlex_data_collection
	if oDir := findOpenAlexDir(); oDir != "" {
		oDBDir := filepath.Join(oDir, "data", "db")
		if oEntries, err := os.ReadDir(oDBDir); err == nil {
			for _, oe := range oEntries {
				if oe.IsDir() {
					continue
				}
				oLower := strings.ToLower(oe.Name())
				if strings.HasSuffix(oLower, ".duckdb") || strings.HasSuffix(oLower, ".sqlite") || strings.HasSuffix(oLower, ".db") {
					fPath := filepath.Join(oDBDir, oe.Name())
					if seenDB[fPath] {
						continue
					}
					seenDB[fPath] = true
					var sBytes int64
					var sMod string
					var sHuman string
					if info, err := oe.Info(); err == nil {
						sBytes = info.Size()
						sMod = info.ModTime().Format("2006-01-02 15:04:05")
						sHuman = formatBytesHuman(sBytes)
					}
					dbType := "DuckDB"
					if strings.HasSuffix(oLower, ".sqlite") || strings.HasSuffix(oLower, ".db") {
						dbType = "SQLite"
					}
					resp.DiscoveredDatabases = append(resp.DiscoveredDatabases, DiscoveredDBItem{
						Name:      oe.Name(),
						Path:      fPath,
						Source:    "OpenAlex Data Collection",
						Type:      dbType,
						SizeBytes: sBytes,
						SizeHuman: sHuman,
						ModTime:   sMod,
					})
				}
			}
		}
	}

	sort.Slice(resp.DiscoveredDatabases, func(i, j int) bool {
		return resp.DiscoveredDatabases[i].ModTime > resp.DiscoveredDatabases[j].ModTime
	})

	resp.LastStatus = s.getExportStatus(project)

	json.NewEncoder(w).Encode(resp)
}

// handleExportStatus returns current export execution status and logs.
func (s *APIServer) handleExportStatus(w http.ResponseWriter, r *http.Request) {
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

	status := s.getExportStatus(project)
	s.mu.Lock()
	defer s.mu.Unlock()
	json.NewEncoder(w).Encode(status)
}

// handleExportCancel cancels the active export background job.
func (s *APIServer) handleExportCancel(w http.ResponseWriter, r *http.Request) {
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
	cancel, ok := s.exportCancelFuncs[project]
	if ok && cancel != nil {
		cancel()
		delete(s.exportCancelFuncs, project)
		s.mu.Unlock()
		s.addExportLog(project, "[WARNING] Export execution cancellation requested by user.")
		json.NewEncoder(w).Encode(map[string]string{"status": "cancelling"})
		return
	}
	s.mu.Unlock()

	json.NewEncoder(w).Encode(map[string]string{"status": "not_running"})
}

// handleExportRun launches json_to_csv.py with the requested parameters.
func (s *APIServer) handleExportRun(w http.ResponseWriter, r *http.Request) {
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
	_, jsonlDir, csvBaseDir, dbBaseDir, sqlBaseDir := s.getProjectExportDirs(project)
	_ = s.ensureExportDirs(project)

	var reqBody exportRunRequest
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&reqBody)
	}

	mode := strings.TrimSpace(reqBody.Mode)
	if mode == "" {
		mode = "pipeline"
	}
	if mode != "pipeline" && mode != "jsonl-to-csv" && mode != "csv-to-duckdb" && mode != "csv-to-sqlite" && mode != "csv-to-sql" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{
			"error": fmt.Sprintf("Invalid export mode %q. Allowed modes: pipeline, jsonl-to-csv, csv-to-duckdb, csv-to-sqlite, csv-to-sql", mode),
		})
		return
	}

	csvFolderName := strings.TrimSpace(reqBody.CSVFolder)
	if csvFolderName == "" {
		csvFolderName = "openalex_csv"
	}
	csvFolderName = filepath.Clean(csvFolderName)
	csvDir := filepath.Join(csvBaseDir, csvFolderName)

	sqliteName := strings.TrimSpace(reqBody.SQLiteName)
	if sqliteName == "" {
		sqliteName = project + ".db"
	}
	sqliteName = filepath.Base(sqliteName)
	if !strings.HasSuffix(sqliteName, ".db") && !strings.HasSuffix(sqliteName, ".sqlite") {
		sqliteName += ".db"
	}
	sqlitePath := filepath.Join(dbBaseDir, sqliteName)

	duckdbName := strings.TrimSpace(reqBody.DuckDBName)
	if duckdbName == "" {
		duckdbName = project + ".duckdb"
	}
	duckdbName = filepath.Base(duckdbName)
	if !strings.HasSuffix(duckdbName, ".duckdb") && !strings.HasSuffix(duckdbName, ".db") {
		duckdbName += ".duckdb"
	}
	duckdbPath := filepath.Join(dbBaseDir, duckdbName)

	sqlName := strings.TrimSpace(reqBody.SQLName)
	if sqlName == "" {
		sqlName = project + "_dump.sql"
	}
	sqlName = filepath.Base(sqlName)
	if !strings.HasSuffix(sqlName, ".sql") {
		sqlName += ".sql"
	}
	sqlPath := filepath.Join(sqlBaseDir, sqlName)

	var inPath string
	if mode == "pipeline" || mode == "jsonl-to-csv" {
		inPath = strings.TrimSpace(reqBody.JSONLPath)
		if inPath == "" {
			if entries, err := os.ReadDir(jsonlDir); err == nil {
				var jsonlFiles []string
				for _, e := range entries {
					if !e.IsDir() && strings.HasSuffix(strings.ToLower(e.Name()), ".jsonl") {
						jsonlFiles = append(jsonlFiles, e.Name())
					}
				}
				if len(jsonlFiles) > 0 {
					inPath = filepath.Join(jsonlDir, jsonlFiles[0])
					for _, f := range jsonlFiles {
						if strings.Contains(strings.ToLower(f), "imputed") {
							inPath = filepath.Join(jsonlDir, f)
							break
						}
					}
				}
			}
		} else if !filepath.IsAbs(inPath) {
			inPath = filepath.Join(jsonlDir, inPath)
		}

		if inPath == "" {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{
				"error": fmt.Sprintf("No JSONL file specified and none found in %s", jsonlDir),
			})
			return
		}

		if _, err := os.Stat(inPath); os.IsNotExist(err) {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{
				"error": fmt.Sprintf("Input JSONL file not found at %s", inPath),
			})
			return
		}
	} else {
		if fi, err := os.Stat(csvDir); os.IsNotExist(err) || !fi.IsDir() {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{
				"error": fmt.Sprintf("CSV folder not found at %s", csvDir),
			})
			return
		}
	}

	status := s.getExportStatus(project)
	s.mu.Lock()
	if status.Running {
		s.mu.Unlock()
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "An export process is already running for this project.",
		})
		return
	}
	status.Running = true
	status.Mode = mode
	status.Progress = 0
	status.Logs = []string{}
	status.Stats = make(map[string]string)
	status.OutputFiles = []string{}
	status.CSVFolder = csvFolderName

	createSQLiteInit := reqBody.CreateSQLite || (!reqBody.CreateDuckDB && !reqBody.CreateSQLite && !reqBody.CreateSQL)
	if (mode == "pipeline" && createSQLiteInit) || mode == "csv-to-sqlite" {
		status.SQLiteFile = sqliteName
	} else {
		status.SQLiteFile = ""
	}

	createDuckDBInit := reqBody.CreateDuckDB
	if (mode == "pipeline" && createDuckDBInit) || mode == "csv-to-duckdb" {
		status.DuckDBFile = duckdbName
	} else {
		status.DuckDBFile = ""
	}

	if (mode == "pipeline" && reqBody.CreateSQL) || mode == "csv-to-sql" {
		status.SQLFile = sqlName
	} else {
		status.SQLFile = ""
	}
	status.CompletedAt = ""
	status.Error = ""

	ctx, cancel := context.WithCancel(context.Background())
	s.exportCancelFuncs[project] = cancel
	s.mu.Unlock()

	s.addExportLog(project, fmt.Sprintf("[%s] [INFO] Starting export execution (Mode: %s)...", time.Now().Format("15:04:05"), mode))
	if inPath != "" {
		s.addExportLog(project, fmt.Sprintf("[INFO] Input JSONL: %s", inPath))
	}
	s.addExportLog(project, fmt.Sprintf("[INFO] CSV Target:  %s", csvDir))
	if mode == "pipeline" {
		if createSQLiteInit {
			s.addExportLog(project, fmt.Sprintf("[INFO] SQLite Target: %s", sqlitePath))
		}
		if createDuckDBInit {
			s.addExportLog(project, fmt.Sprintf("[INFO] DuckDB Target: %s", duckdbPath))
		}
		if reqBody.CreateSQL {
			s.addExportLog(project, fmt.Sprintf("[INFO] SQL Target:    %s", sqlPath))
		}
	} else if mode == "csv-to-sqlite" {
		s.addExportLog(project, fmt.Sprintf("[INFO] SQLite Target: %s", sqlitePath))
	} else if mode == "csv-to-duckdb" {
		s.addExportLog(project, fmt.Sprintf("[INFO] DuckDB Target: %s", duckdbPath))
	} else if mode == "csv-to-sql" {
		s.addExportLog(project, fmt.Sprintf("[INFO] SQL Target:    %s", sqlPath))
	}

	go func() {
		defer func() {
			s.mu.Lock()
			delete(s.exportCancelFuncs, project)
			status.Running = false
			s.mu.Unlock()
		}()

		pythonBin := findPythonInterpreter()
		openalexDir := findOpenAlexDir()
		scriptPath := findJsonToCsvScript()

		if scriptPath == "" {
			s.addExportLog(project, "[ERROR] json_to_csv.py script not found.")
			s.mu.Lock()
			status.Error = "json_to_csv.py script not found"
			s.mu.Unlock()
			return
		}

		args := []string{
			"-u",
			scriptPath,
			"--mode", mode,
			"--overwrite",
		}

		switch mode {
		case "pipeline":
			args = append(args, "--jsonl", inPath, "--csv-dir", csvDir)
			if createSQLiteInit {
				args = append(args, "--sqlite", sqlitePath)
			}
			if createDuckDBInit {
				args = append(args, "--duckdb", duckdbPath)
			}
			if reqBody.CreateSQL {
				args = append(args, "--sql", sqlPath)
			}
		case "jsonl-to-csv":
			args = append(args, "--jsonl", inPath, "--csv-dir", csvDir)
		case "csv-to-sqlite":
			args = append(args, "--csv-dir", csvDir, "--sqlite", sqlitePath)
		case "csv-to-duckdb":
			args = append(args, "--csv-dir", csvDir, "--duckdb", duckdbPath)
		case "csv-to-sql":
			args = append(args, "--csv-dir", csvDir, "--sql", sqlPath)
		}

		cmd := exec.CommandContext(ctx, pythonBin, args...)
		if openalexDir != "" {
			cmd.Dir = openalexDir
		}
		cmd.Env = append(os.Environ(), "PYTHONUNBUFFERED=1", "TERM=dumb", "NO_COLOR=1")
		if openalexDir != "" {
			cmd.Env = append(cmd.Env, "PYTHONPATH="+openalexDir)
		}

		stdoutPipe, err := cmd.StdoutPipe()
		if err != nil {
			s.addExportLog(project, "[ERROR] Failed to obtain stdout pipe: "+err.Error())
			s.mu.Lock()
			status.Error = err.Error()
			s.mu.Unlock()
			return
		}
		stderrPipe, err := cmd.StderrPipe()
		if err != nil {
			s.addExportLog(project, "[ERROR] Failed to obtain stderr pipe: "+err.Error())
			s.mu.Lock()
			status.Error = err.Error()
			s.mu.Unlock()
			return
		}

		if err := cmd.Start(); err != nil {
			s.addExportLog(project, "[ERROR] Failed to start process: "+err.Error())
			s.mu.Lock()
			status.Error = err.Error()
			s.mu.Unlock()
			return
		}

		scanner := bufio.NewScanner(io.MultiReader(stdoutPipe, stderrPipe))
		for scanner.Scan() {
			rawLine := scanner.Text()
			s.addExportLog(project, rawLine)

			plain := stripANSI(rawLine)
			trimmed := strings.TrimSpace(plain)

			s.mu.Lock()
			if strings.Contains(trimmed, "Processing JSONL...") {
				if status.Progress < 25 {
					status.Progress = 25
				}
			} else if strings.Contains(trimmed, "JSONL → CSV completed") {
				if status.Progress < 50 {
					status.Progress = 50
				}
			} else if strings.Contains(trimmed, "Loading papers...") {
				if status.Progress < 60 {
					status.Progress = 60
				}
			} else if strings.Contains(trimmed, "Loading authors...") {
				if status.Progress < 70 {
					status.Progress = 70
				}
			} else if strings.Contains(trimmed, "Loading institutions...") {
				if status.Progress < 75 {
					status.Progress = 75
				}
			} else if strings.Contains(trimmed, "Loading countries...") {
				if status.Progress < 80 {
					status.Progress = 80
				}
			} else if strings.Contains(trimmed, "Loading contributions...") {
				if status.Progress < 85 {
					status.Progress = 85
				}
			} else if strings.Contains(trimmed, "DuckDB database created") {
				if status.Progress < 90 {
					status.Progress = 90
				}
			} else if strings.Contains(trimmed, "Writing SQL dump...") {
				if status.Progress < 92 {
					status.Progress = 92
				}
			} else if strings.Contains(trimmed, "SQL file created") {
				if status.Progress < 98 {
					status.Progress = 98
				}
			}

			if strings.Contains(trimmed, ":") && !strings.HasPrefix(trimmed, "http") && !strings.HasPrefix(trimmed, "[") && !strings.HasPrefix(trimmed, "=") && !strings.HasPrefix(trimmed, "-") {
				parts := strings.SplitN(trimmed, ":", 2)
				if len(parts) == 2 {
					k := strings.TrimSpace(parts[0])
					v := strings.TrimSpace(parts[1])
					if status.Stats != nil && k != "" && v != "" && len(k) < 30 {
						status.Stats[k] = v
					}
				}
			}
			s.mu.Unlock()
		}

		if err := cmd.Wait(); err != nil {
			if ctx.Err() == context.Canceled {
				s.addExportLog(project, "[CANCEL] Export job cancelled by user.")
			} else {
				s.addExportLog(project, "[ERROR] Export job failed: "+err.Error())
				s.mu.Lock()
				status.Error = err.Error()
				s.mu.Unlock()
			}
		} else {
			s.mu.Lock()
			status.Progress = 100
			if mode == "pipeline" || mode == "jsonl-to-csv" {
				status.OutputFiles = append(status.OutputFiles,
					filepath.Join(csvFolderName, "papers.csv"),
					filepath.Join(csvFolderName, "authors.csv"),
					filepath.Join(csvFolderName, "institutions.csv"),
					filepath.Join(csvFolderName, "countries.csv"),
					filepath.Join(csvFolderName, "contributions.csv"),
				)
			}
			createDB := reqBody.CreateDuckDB || (!reqBody.CreateDuckDB && !reqBody.CreateSQL)
			if (mode == "pipeline" && createDB) || mode == "csv-to-duckdb" {
				status.OutputFiles = append(status.OutputFiles, duckdbName)
			}
			if (mode == "pipeline" && reqBody.CreateSQL) || mode == "csv-to-sql" {
				status.OutputFiles = append(status.OutputFiles, sqlName)
			}
			s.exportProjectMetadataFiles(project)
			status.CompletedAt = time.Now().Format("2006-01-02 15:04:05")
			s.mu.Unlock()
			s.addExportLog(project, fmt.Sprintf("[%s] [SUCCESS] Export completed successfully! Synced keywords.txt and topics.txt to data directory.", time.Now().Format("15:04:05")))
		}
	}()

	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":     "started",
		"mode":       mode,
		"csv_folder": csvFolderName,
		"duckdb":     duckdbName,
		"sql":        sqlName,
	})
}

// getProjectKeywordsAndTopics resolves active search keywords query and OpenAlex topic IDs.
func (s *APIServer) getProjectKeywordsAndTopics(project string) (string, string) {
	var keywords, topics string

	configDBPath, _, _, _, _ := s.getProjectPaths(project)
	cfg, err := config.LoadConfig(configDBPath)
	if err == nil && cfg != nil {
		keywords = strings.TrimSpace(cfg.Keywords)
		if len(cfg.Topics) > 0 {
			topics = strings.TrimSpace(strings.Join(cfg.Topics, "\n"))
		}
	}

	projBaseDir, _, _, dbBaseDir, _ := s.getProjectExportDirs(project)

	if keywords == "" {
		candidates := []string{
			filepath.Join(dbBaseDir, "keywords.txt"),
			filepath.Join(projBaseDir, "data", "keywords.txt"),
			filepath.Join(projBaseDir, "config", "keywords.txt"),
			filepath.Join("config", "keywords.txt"),
			fmt.Sprintf("/run/media/krishnakumar/New Volume/IISC/openAlex_data_collection/config/%s_keywords.txt", project),
			fmt.Sprintf("/run/media/krishnakumar/New Volume/IISC/openAlex_data_collection/config/%s_publications_keywords.txt", project),
			fmt.Sprintf("/run/media/krishnakumar/New Volume/IISC/openAlex_data_collection/config/%s Keywords .txt", project),
			"/run/media/krishnakumar/New Volume/IISC/openAlex_data_collection/config/keywords.txt",
		}
		for _, p := range candidates {
			if b, err := os.ReadFile(p); err == nil && len(strings.TrimSpace(string(b))) > 0 {
				keywords = strings.TrimSpace(string(b))
				break
			}
		}
	}

	if topics == "" {
		candidates := []string{
			filepath.Join(dbBaseDir, "topics.txt"),
			filepath.Join(projBaseDir, "data", "topics.txt"),
			filepath.Join(projBaseDir, "config", "topics.txt"),
			filepath.Join("config", "topics.txt"),
			fmt.Sprintf("/run/media/krishnakumar/New Volume/IISC/openAlex_data_collection/config/%s_topics.txt", project),
			fmt.Sprintf("/run/media/krishnakumar/New Volume/IISC/openAlex_data_collection/config/%s_publications_topics.txt", project),
			fmt.Sprintf("/run/media/krishnakumar/New Volume/IISC/openAlex_data_collection/config/%s topics.txt", project),
			"/run/media/krishnakumar/New Volume/IISC/openAlex_data_collection/config/topics.txt",
		}
		for _, p := range candidates {
			if b, err := os.ReadFile(p); err == nil && len(strings.TrimSpace(string(b))) > 0 {
				topics = strings.TrimSpace(string(b))
				break
			}
		}
	}

	return keywords, topics
}

// exportProjectMetadataFiles writes current keywords.txt and topics.txt to the project data/db folders.
func (s *APIServer) exportProjectMetadataFiles(project string) {
	keywords, topics := s.getProjectKeywordsAndTopics(project)
	projBaseDir, _, _, dbBaseDir, _ := s.getProjectExportDirs(project)
	_ = os.MkdirAll(dbBaseDir, 0755)
	_ = os.MkdirAll(filepath.Join(projBaseDir, "data"), 0755)

	if keywords != "" {
		_ = os.WriteFile(filepath.Join(dbBaseDir, "keywords.txt"), []byte(keywords+"\n"), 0644)
		_ = os.WriteFile(filepath.Join(projBaseDir, "data", "keywords.txt"), []byte(keywords+"\n"), 0644)
	}
	if topics != "" {
		_ = os.WriteFile(filepath.Join(dbBaseDir, "topics.txt"), []byte(topics+"\n"), 0644)
		_ = os.WriteFile(filepath.Join(projBaseDir, "data", "topics.txt"), []byte(topics+"\n"), 0644)
	}
}

// serveDuckDBBundleZip generates a ZIP archive with DuckDB database plus keywords.txt and topics.txt.
func (s *APIServer) serveDuckDBBundleZip(w http.ResponseWriter, r *http.Request, target, fileName, project string) {
	baseName := strings.TrimSuffix(fileName, filepath.Ext(fileName))
	zipName := fmt.Sprintf("%s_with_metadata.zip", baseName)

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, zipName))

	zipWriter := zip.NewWriter(w)
	defer zipWriter.Close()

	// 1. Add DuckDB file
	f, err := os.Open(target)
	if err == nil {
		wDb, errZip := zipWriter.Create(fileName)
		if errZip == nil {
			_, _ = io.Copy(wDb, f)
		}
		f.Close()
	}

	// 2. Add keywords.txt
	keywords, topics := s.getProjectKeywordsAndTopics(project)
	if kwWriter, err := zipWriter.Create("keywords.txt"); err == nil {
		_, _ = kwWriter.Write([]byte(keywords + "\n"))
	}

	// 3. Add topics.txt
	if topWriter, err := zipWriter.Create("topics.txt"); err == nil {
		_, _ = topWriter.Write([]byte(topics + "\n"))
	}
}

// handleExportDownload serves individual CSVs, DuckDB, SQL, JSONL files, or CSV folder as ZIP.
func (s *APIServer) handleExportDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	project := r.URL.Query().Get("project")
	if project == "" {
		project = "default"
	}
	project = sanitizeProjectName(project)
	projBaseDir, jsonlDir, csvBaseDir, dbBaseDir, sqlBaseDir := s.getProjectExportDirs(project)

	downloadType := r.URL.Query().Get("type")
	folder := filepath.Clean(r.URL.Query().Get("folder"))
	fileName := filepath.Base(r.URL.Query().Get("file"))

	switch downloadType {
	case "keywords":
		keywords, _ := s.getProjectKeywordsAndTopics(project)
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="keywords.txt"`)
		w.Write([]byte(keywords + "\n"))
		return

	case "topics":
		_, topics := s.getProjectKeywordsAndTopics(project)
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="topics.txt"`)
		w.Write([]byte(topics + "\n"))
		return

	case "csv_zip":
		if folder == "" || folder == "." {
			folder = "openalex_csv"
		}
		targetDir := filepath.Join(csvBaseDir, folder)
		if !strings.HasPrefix(targetDir, filepath.Clean(csvBaseDir)) {
			http.Error(w, "Invalid folder path", http.StatusBadRequest)
			return
		}
		entries, err := os.ReadDir(targetDir)
		if err != nil {
			http.Error(w, fmt.Sprintf("Folder %q not found", folder), http.StatusNotFound)
			return
		}

		csvFiles := []os.DirEntry{}
		for _, e := range entries {
			if !e.IsDir() && strings.HasSuffix(strings.ToLower(e.Name()), ".csv") {
				csvFiles = append(csvFiles, e)
			}
		}

		if len(csvFiles) == 0 {
			http.Error(w, "No CSV files found in folder", http.StatusNotFound)
			return
		}

		w.Header().Set("Content-Type", "application/zip")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.zip"`, folder))

		zipWriter := zip.NewWriter(w)
		defer zipWriter.Close()

		for _, e := range csvFiles {
			filePath := filepath.Join(targetDir, e.Name())
			file, err := os.Open(filePath)
			if err != nil {
				continue
			}
			fWriter, err := zipWriter.Create(e.Name())
			if err != nil {
				file.Close()
				continue
			}
			_, _ = io.Copy(fWriter, file)
			file.Close()
		}
		return

	case "csv":
		if folder == "" || folder == "." {
			folder = "openalex_csv"
		}
		target := filepath.Join(csvBaseDir, folder, fileName)
		if !strings.HasPrefix(target, filepath.Clean(csvBaseDir)) {
			http.Error(w, "Invalid file path", http.StatusBadRequest)
			return
		}
		fi, err := os.Stat(target)
		if err != nil || fi.IsDir() {
			http.Error(w, "CSV file not found", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, fileName))
		http.ServeFile(w, r, target)
		return

	case "duckdb":
		includeBundle := r.URL.Query().Get("bundle") == "true" || r.URL.Query().Get("with_meta") == "true"
		target := filepath.Join(dbBaseDir, fileName)
		if fi, err := os.Stat(target); err != nil || fi.IsDir() {
			altTarget := filepath.Join(projBaseDir, "data", fileName)
			if fi2, err2 := os.Stat(altTarget); err2 == nil && !fi2.IsDir() {
				target = altTarget
			} else {
				http.Error(w, "DuckDB file not found", http.StatusNotFound)
				return
			}
		}

		if includeBundle {
			s.serveDuckDBBundleZip(w, r, target, fileName, project)
			return
		}

		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, fileName))
		http.ServeFile(w, r, target)
		return

	case "duckdb_bundle":
		target := filepath.Join(dbBaseDir, fileName)
		if fi, err := os.Stat(target); err != nil || fi.IsDir() {
			altTarget := filepath.Join(projBaseDir, "data", fileName)
			if fi2, err2 := os.Stat(altTarget); err2 == nil && !fi2.IsDir() {
				target = altTarget
			} else {
				http.Error(w, "DuckDB file not found", http.StatusNotFound)
				return
			}
		}
		s.serveDuckDBBundleZip(w, r, target, fileName, project)
		return

	case "sql":
		target := filepath.Join(sqlBaseDir, fileName)
		if fi, err := os.Stat(target); err != nil || fi.IsDir() {
			altTarget := filepath.Join(projBaseDir, "data", fileName)
			if fi2, err2 := os.Stat(altTarget); err2 == nil && !fi2.IsDir() {
				target = altTarget
			} else {
				http.Error(w, "SQL file not found", http.StatusNotFound)
				return
			}
		}
		w.Header().Set("Content-Type", "application/sql; charset=utf-8")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, fileName))
		http.ServeFile(w, r, target)
		return

	case "jsonl":
		target := filepath.Join(jsonlDir, fileName)
		fi, err := os.Stat(target)
		if err != nil || fi.IsDir() {
			http.Error(w, "JSONL file not found", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, fileName))
		http.ServeFile(w, r, target)
		return

	case "sqlite", "db":
		target := filepath.Join(dbBaseDir, fileName)
		if fi, err := os.Stat(target); err != nil || fi.IsDir() {
			altTarget := filepath.Join(projBaseDir, "data", fileName)
			if fi2, err2 := os.Stat(altTarget); err2 == nil && !fi2.IsDir() {
				target = altTarget
			} else {
				http.Error(w, "SQLite database file not found", http.StatusNotFound)
				return
			}
		}
		w.Header().Set("Content-Type", "application/x-sqlite3")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, fileName))
		http.ServeFile(w, r, target)
		return

	default:
		http.Error(w, "Unsupported or missing download type", http.StatusBadRequest)
		return
	}
}

// handleExportLaunchViewer launches sqlitebrowser or desktop default viewer on the specified database file.
func (s *APIServer) handleExportLaunchViewer(w http.ResponseWriter, r *http.Request) {
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
	projBaseDir, _, _, dbBaseDir, _ := s.getProjectExportDirs(project)

	fileName := filepath.Base(r.URL.Query().Get("file"))
	if fileName == "" || fileName == "." {
		fileName = project + ".db"
	}

	target := filepath.Join(dbBaseDir, fileName)
	if fi, err := os.Stat(target); err != nil || fi.IsDir() {
		altTarget := filepath.Join(projBaseDir, "data", fileName)
		if fi2, err2 := os.Stat(altTarget); err2 == nil && !fi2.IsDir() {
			target = altTarget
		} else {
			w.WriteHeader(http.StatusNotFound)
			json.NewEncoder(w).Encode(map[string]string{
				"error": fmt.Sprintf("Database file %q not found in project %q", fileName, project),
			})
			return
		}
	}

	viewerBin, err := exec.LookPath("sqlitebrowser")
	if err != nil {
		viewerBin, err = exec.LookPath("xdg-open")
	}
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "No SQL viewer found installed on host (neither sqlitebrowser nor xdg-open available)",
		})
		return
	}

	cmd := exec.Command(viewerBin, target)
	cmd.Env = os.Environ()
	if err := cmd.Start(); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Failed to launch viewer: " + err.Error(),
		})
		return
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"ok":      true,
		"message": fmt.Sprintf("Opened %s in %s", fileName, filepath.Base(viewerBin)),
		"viewer":  filepath.Base(viewerBin),
		"file":    fileName,
	})
}
