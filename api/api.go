package api

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"embed"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"math"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"stratum/config"
	"stratum/db"
	"stratum/impute"
	"stratum/openalex"
	"stratum/tfidf"

	"github.com/extrame/xls"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/xuri/excelize/v2"
)

//go:embed dist/*
var frontendFS embed.FS

// ConfigRevision represents a versioned snapshot of keywords, topics, and anchors.
type ConfigRevision struct {
	Version   int    `json:"version"`
	Timestamp string `json:"timestamp"`
	Label     string `json:"label"`
	Keywords  string `json:"keywords"`
	Topics    string `json:"topics"`
	Anchors   string `json:"anchors"`
}

// PipelineStatus tracks the state and log output of the active ingestion pipeline.
type PipelineStatus struct {
	Syncing  bool     `json:"syncing"`
	Progress int      `json:"progress"`
	Logs     []string `json:"logs"`
}

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

// APIServer manages HTTP routes and coordinates tasks for the web client interface.
type APIServer struct {
	addr                string
	dbPath              string
	workspaceDir        string
	dbManagers          map[string]*db.DBManager
	configDBs           map[string]*sql.DB
	pipelineStatuses    map[string]*PipelineStatus
	pipelineCancelFuncs map[string]context.CancelFunc
	imputeStatuses      map[string]*ImputeStatus
	imputeCancelFuncs   map[string]context.CancelFunc
	exportStatuses      map[string]*ExportStatus
	exportCancelFuncs   map[string]context.CancelFunc
	projectMutexes      map[string]*sync.Mutex
	server              *http.Server
	mcpServer           *mcp.Server
	mcpHandler          *mcp.SSEHandler
	currentProject      string
	mu                  sync.Mutex
}

// NewAPIServer creates a new API server on the specified address.
func NewAPIServer(addr string, dbPath string, workspaceDir string) *APIServer {
	s := &APIServer{
		addr:                addr,
		dbPath:              dbPath,
		workspaceDir:        workspaceDir,
		dbManagers:          make(map[string]*db.DBManager),
		configDBs:           make(map[string]*sql.DB),
		pipelineStatuses:    make(map[string]*PipelineStatus),
		pipelineCancelFuncs: make(map[string]context.CancelFunc),
		imputeStatuses:      make(map[string]*ImputeStatus),
		imputeCancelFuncs:   make(map[string]context.CancelFunc),
		exportStatuses:      make(map[string]*ExportStatus),
		exportCancelFuncs:   make(map[string]context.CancelFunc),
		projectMutexes:      make(map[string]*sync.Mutex),
		currentProject:      "default",
	}

	s.mcpServer = mcp.NewServer(&mcp.Implementation{
		Name:    "stratum-mcp-sse",
		Version: "1.0.0",
	}, nil)

	if err := s.RegisterMCPTools(); err != nil {
		log.Printf("[WARNING] Failed to register MCP tools: %v", err)
	}

	if err := s.RegisterMCPResources(); err != nil {
		log.Printf("[WARNING] Failed to register MCP resources: %v", err)
	}

	s.mcpHandler = mcp.NewSSEHandler(func(request *http.Request) *mcp.Server {
		return s.mcpServer
	}, &mcp.SSEOptions{})

	return s
}

// RegisterRoutes registers endpoints for dashboard metrics, query execution, files, and config.
func (s *APIServer) RegisterRoutes() error {
	mux := http.NewServeMux()

	// Register API endpoints
	mux.HandleFunc("/api/status", s.handleStatus)
	mux.HandleFunc("/api/stats", s.handleStats)
	mux.HandleFunc("/api/query", s.handleQuery)
	mux.HandleFunc("/api/db/import-jsonl", s.handleImportJSONL)
	mux.HandleFunc("/api/config", s.handleConfig)
	mux.HandleFunc("/api/run-pipeline", s.handleRunPipeline)
	mux.HandleFunc("/api/pipeline/status", s.handlePipelineStatus)
	mux.HandleFunc("/api/pipeline/cancel", s.handlePipelineCancel)
	mux.HandleFunc("/api/download-papers", s.handleDownloadPapers)
	mux.HandleFunc("/api/download/papers", s.handleDownloadPapers)
	mux.HandleFunc("/api/download/info", s.handleDownloadInfo)
	mux.HandleFunc("/api/download/file", s.handleDownloadFile)
	mux.HandleFunc("/api/upload", s.handleUpload)
	mux.HandleFunc("/api/tfidf", s.handleTFIDF)
	mux.HandleFunc("/api/query/validate", s.handleQueryValidate)
	mux.HandleFunc("/api/query/generate", s.handleQueryGenerate)
	mux.HandleFunc("/api/query/generate-from-anchors", s.handleQueryGenerateFromAnchors)
	mux.HandleFunc("/api/openalex/count", s.handleOpenAlexCount)
	mux.HandleFunc("/api/openalex/sample", s.handleOpenAlexSample)
	mux.HandleFunc("/api/openalex/topics", s.handleOpenAlexTopics)
	mux.HandleFunc("/api/projects", s.handleListProjects)
	mux.HandleFunc("/api/projects/create", s.handleCreateProject)
	mux.HandleFunc("/api/projects/delete", s.handleDeleteProject)
	mux.HandleFunc("/api/workspace", s.handleWorkspace)
	mux.HandleFunc("/api/impute/files", s.handleImputeFiles)
	mux.HandleFunc("/api/jsonl/preview", s.handleJSONLPreview)
	mux.HandleFunc("/api/impute/run", s.handleImputeRun)
	mux.HandleFunc("/api/impute/status", s.handleImputeStatus)
	mux.HandleFunc("/api/impute/cancel", s.handleImputeCancel)
	mux.HandleFunc("/api/export/files", s.handleExportFiles)
	mux.HandleFunc("/api/export/run", s.handleExportRun)
	mux.HandleFunc("/api/export/status", s.handleExportStatus)
	mux.HandleFunc("/api/export/cancel", s.handleExportCancel)
	mux.HandleFunc("/api/export/download", s.handleExportDownload)
	mux.HandleFunc("/api/export/launch-viewer", s.handleExportLaunchViewer)
	mux.HandleFunc("/api/export/check-db", s.handleExportCheckDB)
	mux.Handle("/api/mcp", s.mcpHandler)

	// Get sub-filesystem for frontend assets
	subFS, err := fs.Sub(frontendFS, "dist")
	if err != nil {
		return err
	}

	// Serve embedded static files with client-side SPA routing fallback
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			w.Write([]byte(`{"error": "API endpoint not found"}`))
			return
		}

		path := r.URL.Path
		if path == "/" {
			path = "/index.html"
		}
		filePath := strings.TrimPrefix(path, "/")

		// Check if file exists in the embedded directory
		f, err := subFS.Open(filePath)
		if err != nil {
			// Fallback to index.html for client-side routing
			indexData, err := fs.ReadFile(subFS, "index.html")
			if err != nil {
				http.Error(w, "internal server error", http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write(indexData)
			return
		}
		f.Close()

		http.FileServer(http.FS(subFS)).ServeHTTP(w, r)
	})

	s.server = &http.Server{
		Addr:    s.addr,
		Handler: loggingMiddleware(mux),
	}

	return nil
}

// Start starts the HTTP server asynchronously.
func (s *APIServer) Start() error {
	if s.server == nil {
		return fmt.Errorf("server not registered, call RegisterRoutes first")
	}
	go func() {
		if err := s.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("[FATAL] HTTP server ListenAndServe failed: %v", err)
			os.Exit(1)
		}
	}()
	return nil
}

// StartWithListener starts the HTTP server asynchronously on a pre-bound listener.
func (s *APIServer) StartWithListener(listener net.Listener) error {
	if s.server == nil {
		return fmt.Errorf("server not registered, call RegisterRoutes first")
	}
	go func() {
		if err := s.server.Serve(listener); err != nil && err != http.ErrServerClosed {
			log.Printf("[FATAL] HTTP server Serve failed: %v", err)
			os.Exit(1)
		}
	}()
	return nil
}

type loggingResponseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (lrw *loggingResponseWriter) WriteHeader(code int) {
	lrw.statusCode = code
	lrw.ResponseWriter.WriteHeader(code)
}

func loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		lrw := &loggingResponseWriter{ResponseWriter: w, statusCode: http.StatusOK}
		next.ServeHTTP(lrw, r)
		duration := time.Since(start)
		log.Printf("[HTTP] %s %s - %d (%s)", r.Method, r.URL.String(), lrw.statusCode, duration)
	})
}

// Stop gracefully shuts down the server.
func (s *APIServer) Stop(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, mgr := range s.dbManagers {
		mgr.Close()
	}
	for _, dbConn := range s.configDBs {
		dbConn.Close()
	}
	if s.server != nil {
		return s.server.Shutdown(ctx)
	}
	return nil
}

func sanitizeProjectName(name string) string {
	reg := regexp.MustCompile(`[^a-zA-Z0-9_\-]`)
	return reg.ReplaceAllString(name, "")
}

func (s *APIServer) getProjectPaths(project string) (configDBPath, papersDBPath, jsonlDir, dbDir, uploadsDir string) {
	baseDir := s.workspaceDir
	if baseDir == "" {
		baseDir = "."
	}

	if project == "" || project == "default" {
		if s.workspaceDir != "" {
			configDBPath = filepath.Join(baseDir, "data", "config.db")
			if filepath.IsAbs(s.dbPath) {
				papersDBPath = s.dbPath
			} else {
				papersDBPath = filepath.Join(baseDir, "data", "papers.db")
			}
			jsonlDir = filepath.Join(baseDir, "data", "jsonl")
			dbDir = filepath.Join(baseDir, "data")
			uploadsDir = filepath.Join(baseDir, "data", "uploads")
		} else {
			configDBPath = filepath.Join(filepath.Dir(s.dbPath), "config.db")
			papersDBPath = s.dbPath
			jsonlDir = "data/jsonl"
			dbDir = "data"
			uploadsDir = "data/uploads"
		}
		return
	}

	project = sanitizeProjectName(project)
	projDir := filepath.Join(baseDir, "projects", project)
	directProj := filepath.Join(baseDir, project)
	if _, err := os.Stat(projDir); os.IsNotExist(err) {
		if fi, err2 := os.Stat(directProj); err2 == nil && fi.IsDir() {
			projDir = directProj
		}
	} else {
		if _, err := os.Lstat(directProj); os.IsNotExist(err) {
			_ = os.Symlink(projDir, directProj)
		}
	}
	configDBPath = filepath.Join(projDir, "data", "config.db")
	papersDBPath = filepath.Join(projDir, "data", fmt.Sprintf("%s.db", project))
	jsonlDir = filepath.Join(projDir, "data", "jsonl")
	dbDir = filepath.Join(projDir, "data")
	uploadsDir = filepath.Join(projDir, "data", "uploads")
	return
}

func (s *APIServer) getConfigDB(project string) (*sql.DB, error) {
	if project == "" {
		project = "default"
	}
	project = sanitizeProjectName(project)

	s.mu.Lock()
	if dbConn, ok := s.configDBs[project]; ok {
		s.mu.Unlock()
		return dbConn, nil
	}
	s.mu.Unlock()

	configDBPath, _, _, _, _ := s.getProjectPaths(project)

	if err := os.MkdirAll(filepath.Dir(configDBPath), 0755); err != nil {
		return nil, err
	}

	dbConn, err := sql.Open("duckdb", configDBPath)
	if err != nil {
		return nil, err
	}
	if err := dbConn.Ping(); err != nil {
		dbConn.Close()
		return nil, err
	}

	// Initialize config database schema
	queries := []string{
		`CREATE TABLE IF NOT EXISTS config (
			id INTEGER PRIMARY KEY,
			email VARCHAR,
			api_keys VARCHAR,
			date_from VARCHAR,
			date_to VARCHAR,
			doc_types VARCHAR,
			batch_size_topics INTEGER,
			per_page INTEGER,
			concurrent_requests INTEGER,
			max_retries INTEGER,
			retry_delay INTEGER,
			llm_provider VARCHAR,
			llm_model VARCHAR,
			llm_base_url VARCHAR,
			keywords VARCHAR,
			topics VARCHAR,
			anchors VARCHAR
		);`,
		`CREATE TABLE IF NOT EXISTS config_history (
			version INTEGER PRIMARY KEY,
			timestamp VARCHAR,
			label VARCHAR,
			keywords VARCHAR,
			topics VARCHAR,
			anchors VARCHAR
		);`,
	}

	for _, q := range queries {
		if _, err := dbConn.Exec(q); err != nil {
			dbConn.Close()
			return nil, err
		}
	}

	var count int
	err = dbConn.QueryRow("SELECT COUNT(*) FROM config").Scan(&count)
	if err != nil {
		dbConn.Close()
		return nil, err
	}

	if count == 0 {
		// Default config values
		email := "sathyarajasekar5873@gmail.com"
		apiKeys := "28leglCF5hY0mVmVYXSNNm"
		dateFrom := "2003-01-01"
		dateTo := "2024-12-31"
		docTypes := "article,review,proceedings-article"
		batchSizeTopics := 10
		perPage := 200
		concurrentRequests := 10
		maxRetries := 5
		retryDelay := 2
		llmProvider := "ollama"
		llmModel := "sorc/qwen3:4b"
		llmBaseURL := "http://localhost:11434"
		var keywords, topics, anchors string

		// Auto-migrate from legacy collection.yml if it exists
		var legacyYmlPath string
		if project == "default" {
			legacyYmlPath = "config/collection.yml"
		} else {
			legacyYmlPath = filepath.Join("projects", project, "config", "collection.yml")
		}

		if _, err := os.Stat(legacyYmlPath); err == nil {
			if cfg, err := config.LoadConfig(legacyYmlPath); err == nil {
				email = cfg.API.Email
				apiKeys = strings.Join(cfg.API.Keys, ",")
				dateFrom = cfg.Filters.DateFrom
				dateTo = cfg.Filters.DateTo
				docTypes = strings.Join(cfg.Filters.DocTypes, ",")
				batchSizeTopics = cfg.Collection.BatchSizeTopics
				perPage = cfg.Collection.PerPage
				concurrentRequests = cfg.Collection.ConcurrentRequests
				maxRetries = cfg.Collection.MaxRetries
				retryDelay = cfg.Collection.RetryDelay
				llmProvider = cfg.LLM.Provider
				llmModel = cfg.LLM.Model
				llmBaseURL = cfg.LLM.BaseURL
				keywords = cfg.Keywords
				topics = strings.Join(cfg.Topics, "\n")
				anchors = strings.Join(cfg.Anchors, "\n")
			}
		}

		_, err = dbConn.Exec(`INSERT INTO config (
			id, email, api_keys, date_from, date_to, doc_types,
			batch_size_topics, per_page, concurrent_requests, max_retries, retry_delay,
			llm_provider, llm_model, llm_base_url, keywords, topics, anchors
		) VALUES (
			1, ?, ?, ?, ?, ?,
			?, ?, ?, ?, ?,
			?, ?, ?, ?, ?, ?
		)`,
			email, apiKeys, dateFrom, dateTo, docTypes,
			batchSizeTopics, perPage, concurrentRequests, maxRetries, retryDelay,
			llmProvider, llmModel, llmBaseURL, keywords, topics, anchors,
		)
		if err != nil {
			dbConn.Close()
			return nil, err
		}
	}

	s.mu.Lock()
	s.configDBs[project] = dbConn
	s.mu.Unlock()

	return dbConn, nil
}

func (s *APIServer) ensureProjectDirs(project string) error {
	baseDir := s.workspaceDir
	if baseDir == "" {
		baseDir = "."
	}

	if project == "" || project == "default" {
		_ = os.MkdirAll(filepath.Join(baseDir, "data", "jsonl"), 0755)
		_ = os.MkdirAll(filepath.Join(baseDir, "data", "uploads"), 0755)
		return nil
	}

	project = sanitizeProjectName(project)
	projDir := filepath.Join(baseDir, "projects", project)
	if err := os.MkdirAll(filepath.Join(projDir, "data", "jsonl"), 0755); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(projDir, "data", "uploads"), 0755); err != nil {
		return err
	}
	return nil
}

func (s *APIServer) initializeProjectFiles(project string) error {
	// config.db is initialized dynamically in getConfigDB, so this is a no-op
	return nil
}

func (s *APIServer) getDBMgr(project string) (*db.DBManager, error) {
	if project == "" {
		project = "default"
	}
	project = sanitizeProjectName(project)

	s.mu.Lock()
	if mgr, ok := s.dbManagers[project]; ok {
		s.mu.Unlock()
		return mgr, nil
	}

	if s.projectMutexes == nil {
		s.projectMutexes = make(map[string]*sync.Mutex)
	}
	projMu, ok := s.projectMutexes[project]
	if !ok {
		projMu = &sync.Mutex{}
		s.projectMutexes[project] = projMu
	}
	s.mu.Unlock()

	projMu.Lock()
	defer projMu.Unlock()

	// Double-check after acquiring the project mutex
	s.mu.Lock()
	if mgr, ok := s.dbManagers[project]; ok {
		s.mu.Unlock()
		return mgr, nil
	}
	s.mu.Unlock()

	_, dbPath, _, _, _ := s.getProjectPaths(project)

	dbDir := filepath.Dir(dbPath)
	if err := os.MkdirAll(dbDir, 0755); err != nil {
		return nil, err
	}

	mgr, err := db.NewDBManager(dbPath)
	if err != nil {
		return nil, err
	}
	_ = mgr.CreateSchema()

	s.mu.Lock()
	s.dbManagers[project] = mgr
	s.mu.Unlock()

	return mgr, nil
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

func (s *APIServer) handleStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"status": "online"}`))
}

func (s *APIServer) handleWorkspace(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodGet {
		http.Error(w, `{"error": "Method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	json.NewEncoder(w).Encode(map[string]string{
		"workspace_dir": s.workspaceDir,
	})
}

func (s *APIServer) handleStats(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	project := r.URL.Query().Get("project")
	dbMgr, err := s.getDBMgr(project)
	if err != nil {
		http.Error(w, "Database manager error: "+err.Error(), http.StatusInternalServerError)
		return
	}
	stats, err := dbMgr.GetDashboardStats()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(stats)
}

func (s *APIServer) handleQuery(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var body struct {
		Query string `json:"query"`
		SQL   string `json:"sql"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	sqlQuery := strings.TrimSpace(body.Query)
	if sqlQuery == "" {
		sqlQuery = strings.TrimSpace(body.SQL)
	}

	project := r.URL.Query().Get("project")
	dbMgr, err := s.getDBMgr(project)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	results, err := dbMgr.RunQuery(sqlQuery)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	if results == nil {
		results = []map[string]interface{}{}
	}

	json.NewEncoder(w).Encode(results)
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

func findOpenAlexDir() string {
	candidates := []string{
		"/run/media/krishnakumar/New Volume/IISC/openAlex_data_collection",
		filepath.Join("..", "openAlex_data_collection"),
		"openAlex_data_collection",
	}
	for _, p := range candidates {
		if fi, err := os.Stat(p); err == nil && fi.IsDir() {
			return p
		}
	}
	return ""
}

func findOpenAlexBinary() string {
	pythonBin := findPythonInterpreter()
	if pythonBin != "" {
		openalexCandidate := filepath.Join(filepath.Dir(pythonBin), "openalex")
		if _, err := os.Stat(openalexCandidate); err == nil {
			return openalexCandidate
		}
	}
	candidates := []string{
		"/run/media/krishnakumar/New Volume/IISC/openAlex_data_collection/.venv/bin/openalex",
		filepath.Join("..", "openAlex_data_collection", ".venv", "bin", "openalex"),
		"openalex",
	}
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
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

type imputeRunRequest struct {
	InputPath  string `json:"input_path"`
	OutputPath string `json:"output_path"`
	Limit      *int   `json:"limit"`
	UseROR     *bool  `json:"use_ror"`
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

var ansiStripRegex = regexp.MustCompile(`\x1b\[[0-9;]*[a-zA-Z]`)

func stripANSI(str string) string {
	return ansiStripRegex.ReplaceAllString(str, "")
}

func formatBytesHuman(sizeBytes int64) string {
	if sizeBytes < 1024 {
		return fmt.Sprintf("%d B", sizeBytes)
	} else if sizeBytes < 1024*1024 {
		return fmt.Sprintf("%.1f KB", float64(sizeBytes)/1024.0)
	} else if sizeBytes < 1024*1024*1024 {
		return fmt.Sprintf("%.1f MB", float64(sizeBytes)/(1024.0*1024.0))
	}
	return fmt.Sprintf("%.2f GB", float64(sizeBytes)/(1024.0*1024.0*1024.0))
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
				return directCSVFiles[i].Name < directCSVFiles[j].Name
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

// handleExportCheckDB executes openalex check-db on the selected database and returns the structured health report.
func (s *APIServer) handleExportCheckDB(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		http.Error(w, `{"error": "Method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	project := r.URL.Query().Get("project")
	if project == "" {
		project = "default"
	}
	project = sanitizeProjectName(project)
	projBaseDir, _, _, dbBaseDir, _ := s.getProjectExportDirs(project)

	rawFile := r.URL.Query().Get("file")
	var target string
	if rawFile != "" {
		if filepath.IsAbs(rawFile) {
			if fi, err := os.Stat(rawFile); err == nil && !fi.IsDir() {
				target = rawFile
			}
		} else {
			if fi, err := os.Stat(rawFile); err == nil && !fi.IsDir() {
				target, _ = filepath.Abs(rawFile)
			}
		}
	}

	if target == "" {
		fileName := filepath.Base(rawFile)
		if fileName != "" && fileName != "." {
			candidates := []string{
				filepath.Join(dbBaseDir, fileName),
				filepath.Join(projBaseDir, "data", fileName),
			}
			if project == "default" {
				candidates = append(candidates, filepath.Join(s.workspaceDir, "data", "db", fileName), filepath.Join(s.workspaceDir, "data", fileName))
			}
			if oDir := findOpenAlexDir(); oDir != "" {
				candidates = append(candidates, filepath.Join(oDir, "data", "db", fileName), filepath.Join(oDir, fileName))
			}
			if pEntries, err := os.ReadDir(filepath.Join(s.workspaceDir, "projects")); err == nil {
				for _, pe := range pEntries {
					if pe.IsDir() {
						candidates = append(candidates,
							filepath.Join(s.workspaceDir, "projects", pe.Name(), "data", "db", fileName),
							filepath.Join(s.workspaceDir, "projects", pe.Name(), "data", fileName),
						)
					}
				}
			}
			for _, c := range candidates {
				if fi, err := os.Stat(c); err == nil && !fi.IsDir() {
					target = c
					break
				}
			}
		}
	}

	// If no file was specified or found, auto-discover the newest .db or .duckdb
	if target == "" {
		searchDirs := []string{dbBaseDir, filepath.Join(projBaseDir, "data")}
		if project == "default" {
			searchDirs = append(searchDirs, filepath.Join(s.workspaceDir, "data", "db"))
		}
		var newestFile string
		var newestTime time.Time
		for _, dir := range searchDirs {
			entries, err := os.ReadDir(dir)
			if err != nil {
				continue
			}
			for _, e := range entries {
				if e.IsDir() {
					continue
				}
				nameLower := strings.ToLower(e.Name())
				if (strings.HasSuffix(nameLower, ".duckdb") || strings.HasSuffix(nameLower, ".db") || strings.HasSuffix(nameLower, ".sqlite")) && !strings.HasPrefix(nameLower, "config") {
					info, err := e.Info()
					if err == nil && info.ModTime().After(newestTime) {
						newestTime = info.ModTime()
						newestFile = filepath.Join(dir, e.Name())
					}
				}
			}
		}
		if newestFile != "" {
			target = newestFile
		}
	}

	if target == "" {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{
			"error": fmt.Sprintf("No database file found in project %q (%s)", project, dbBaseDir),
		})
		return
	}

	nativeData, nativeErr := runNativeCheckDB(target)
	if nativeErr != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"error": fmt.Sprintf("Failed to run check-db on %s: %v", filepath.Base(target), nativeErr),
		})
		return
	}

	nativeData["cli_output"] = renderCheckDBTerminalOutput(target, nativeData)
	json.NewEncoder(w).Encode(nativeData)
}

func copyDBToTemp(src string) (string, error) {
	in, err := os.Open(src)
	if err != nil {
		return "", err
	}
	defer in.Close()

	ext := filepath.Ext(src)
	if ext == "" {
		ext = ".duckdb"
	}
	tmpFile, err := os.CreateTemp("", "stratum_checkdb_*"+ext)
	if err != nil {
		return "", err
	}
	defer tmpFile.Close()

	if _, err := io.Copy(tmpFile, in); err != nil {
		_ = os.Remove(tmpFile.Name())
		return "", err
	}
	return tmpFile.Name(), nil
}

func runNativeCheckDB(dbPath string) (map[string]interface{}, error) {
	if _, err := os.Stat(dbPath); err != nil {
		return nil, err
	}

	var dbConn *sql.DB
	var tempCleanupFile string

	// Direct open attempt
	conn, err := sql.Open("duckdb", dbPath)
	if err == nil && conn.Ping() == nil {
		dbConn = conn
	} else {
		if conn != nil {
			_ = conn.Close()
		}
		// If direct open failed (e.g. database locked by DBeaver, python, or another connection), snapshot to temporary file
		tmpFile, copyErr := copyDBToTemp(dbPath)
		if copyErr != nil {
			return nil, fmt.Errorf("could not open database (%v) and temporary snapshot failed: %w", err, copyErr)
		}
		tempCleanupFile = tmpFile
		snapConn, snapErr := sql.Open("duckdb", tmpFile)
		if snapErr != nil {
			_ = os.Remove(tempCleanupFile)
			return nil, fmt.Errorf("could not open snapshot database: %w", snapErr)
		}
		dbConn = snapConn
	}

	defer func() {
		if dbConn != nil {
			_ = dbConn.Close()
		}
		if tempCleanupFile != "" {
			_ = os.Remove(tempCleanupFile)
		}
	}()

	qInt := func(sqlQuery string, def int64) int64 {
		var val sql.NullInt64
		if err := dbConn.QueryRow(sqlQuery).Scan(&val); err == nil && val.Valid {
			return val.Int64
		}
		return def
	}

	qFloat := func(sqlQuery string, def float64) float64 {
		var val sql.NullFloat64
		if err := dbConn.QueryRow(sqlQuery).Scan(&val); err == nil && val.Valid {
			return val.Float64
		}
		return def
	}

	total := qInt("SELECT COUNT(*) FROM papers", 0)
	yearMin := qInt("SELECT MIN(publication_year) FROM papers", 0)
	yearMax := qInt("SELECT MAX(publication_year) FROM papers", 0)
	withAbstract := qInt("SELECT COUNT(*) FROM papers WHERE abstract_text IS NOT NULL AND abstract_text != ''", 0)
	authorCount := qInt("SELECT COUNT(*) FROM authors", 0)
	instCount := qInt("SELECT COUNT(*) FROM institutions", 0)
	countryCount := qInt("SELECT COUNT(*) FROM countries", 0)
	contribCount := qInt("SELECT COUNT(*) FROM contributions", 0)

	withCountry := qInt("SELECT COUNT(DISTINCT paper_id) FROM contributions WHERE country_code IS NOT NULL", 0)
	withInstitution := qInt("SELECT COUNT(DISTINCT paper_id) FROM contributions WHERE institution_id IS NOT NULL", 0)

	authorsWithOrcid := qInt("SELECT COUNT(*) FROM authors WHERE orcid IS NOT NULL AND TRIM(orcid) != ''", 0)
	institutionsWithRor := qInt("SELECT COUNT(*) FROM institutions WHERE ror_id IS NOT NULL AND TRIM(ror_id) != ''", 0)

	contribWithCountry := qInt("SELECT COUNT(*) FROM contributions WHERE country_code IS NOT NULL", 0)
	contribWithInstitution := qInt("SELECT COUNT(*) FROM contributions WHERE institution_id IS NOT NULL", 0)
	contribWithRawAffiliation := qInt("SELECT COUNT(*) FROM contributions WHERE raw_affiliation_string IS NOT NULL AND TRIM(raw_affiliation_string) != ''", 0)

	orphan := qInt("SELECT COUNT(*) FROM papers p WHERE NOT EXISTS (SELECT 1 FROM contributions c WHERE c.paper_id = p.id)", 0)
	allNull := qInt(`SELECT COUNT(*) FROM papers p
		WHERE EXISTS (SELECT 1 FROM contributions c WHERE c.paper_id = p.id)
		  AND NOT EXISTS (
		      SELECT 1 FROM contributions c
		      WHERE c.paper_id = p.id AND c.institution_id IS NOT NULL
		  )`, 0)
	zeroTotal := orphan + allNull

	contribsForZero := qInt(`SELECT COUNT(*) FROM contributions c
		WHERE NOT EXISTS (
			SELECT 1 FROM contributions c2
			WHERE c2.paper_id = c.paper_id AND c2.institution_id IS NOT NULL
		)`, 0)

	rowsImputable := qInt(`SELECT COUNT(*) FROM contributions c
		WHERE NOT EXISTS (
			SELECT 1 FROM contributions c2
			WHERE c2.paper_id = c.paper_id AND c2.institution_id IS NOT NULL
		)
		AND c.raw_affiliation_string IS NOT NULL
		AND TRIM(c.raw_affiliation_string) != ''`, 0)

	papersImputable := qInt(`SELECT COUNT(DISTINCT c.paper_id) FROM contributions c
		WHERE NOT EXISTS (
			SELECT 1 FROM contributions c2
			WHERE c2.paper_id = c.paper_id AND c2.institution_id IS NOT NULL
		)
		AND c.raw_affiliation_string IS NOT NULL
		AND TRIM(c.raw_affiliation_string) != ''`, 0)

	rowsDead := contribsForZero - rowsImputable

	papersWithDoi := qInt(`SELECT COUNT(*) FROM papers p
		WHERE NOT EXISTS (
			SELECT 1 FROM contributions c
			WHERE c.paper_id = p.id AND c.institution_id IS NOT NULL
		)
		AND p.doi IS NOT NULL AND TRIM(p.doi) != ''`, 0)

	papersWithoutDoi := zeroTotal - papersWithDoi

	// Buckets
	buckets := make(map[string]int64)
	bucketRows, err := dbConn.Query(`
		WITH paper_stats AS (
			SELECT paper_id,
				SUM(CASE WHEN institution_id IS NULL THEN 1 ELSE 0 END) AS missing,
				SUM(CASE WHEN institution_id IS NOT NULL THEN 1 ELSE 0 END) AS filled
			FROM contributions
			GROUP BY paper_id
		)
		SELECT
			CASE WHEN missing >= 5 THEN 5 ELSE missing END AS bucket,
			COUNT(*) AS papers
		FROM paper_stats
		WHERE missing > 0 AND filled > 0
		GROUP BY bucket
		ORDER BY bucket
	`)
	if err == nil {
		for bucketRows.Next() {
			var b int
			var cnt int64
			if err := bucketRows.Scan(&b, &cnt); err == nil {
				buckets[strconv.Itoa(b)] = cnt
			}
		}
		bucketRows.Close()
	}
	var partialTotal int64
	for _, n := range buckets {
		partialTotal += n
	}

	allNullCountry := qInt(`SELECT COUNT(*) FROM papers p
		WHERE EXISTS (SELECT 1 FROM contributions c WHERE c.paper_id = p.id)
		  AND NOT EXISTS (
		      SELECT 1 FROM contributions c
		      WHERE c.paper_id = p.id AND c.country_code IS NOT NULL
		  )`, 0)
	zeroCountryTotal := orphan + allNullCountry

	countryBuckets := make(map[string]int64)
	cBucketRows, err := dbConn.Query(`
		WITH paper_stats AS (
			SELECT paper_id,
				SUM(CASE WHEN country_code IS NULL THEN 1 ELSE 0 END) AS missing,
				SUM(CASE WHEN country_code IS NOT NULL THEN 1 ELSE 0 END) AS filled
			FROM contributions
			GROUP BY paper_id
		)
		SELECT
			CASE WHEN missing >= 5 THEN 5 ELSE missing END AS bucket,
			COUNT(*) AS papers
		FROM paper_stats
		WHERE missing > 0 AND filled > 0
		GROUP BY bucket
		ORDER BY bucket
	`)
	if err == nil {
		for cBucketRows.Next() {
			var b int
			var cnt int64
			if err := cBucketRows.Scan(&b, &cnt); err == nil {
				countryBuckets[strconv.Itoa(b)] = cnt
			}
		}
		cBucketRows.Close()
	}
	var partialCountryTotal int64
	for _, n := range countryBuckets {
		partialCountryTotal += n
	}

	oaCount := qInt("SELECT COUNT(*) FROM papers WHERE is_oa = true", 0)
	top1Count := qInt("SELECT COUNT(*) FROM papers WHERE is_top_1_percent = true", 0)
	top10Count := qInt("SELECT COUNT(*) FROM papers WHERE is_top_10_percent = true", 0)

	top1WithInstitution := qInt(`
		SELECT COUNT(DISTINCT c.paper_id) FROM contributions c
		JOIN papers p ON c.paper_id = p.id
		WHERE p.is_top_1_percent = true AND c.institution_id IS NOT NULL
	`, 0)
	top1WithCountry := qInt(`
		SELECT COUNT(DISTINCT c.paper_id) FROM contributions c
		JOIN papers p ON c.paper_id = p.id
		WHERE p.is_top_1_percent = true AND c.country_code IS NOT NULL
	`, 0)

	top10WithInstitution := qInt(`
		SELECT COUNT(DISTINCT c.paper_id) FROM contributions c
		JOIN papers p ON c.paper_id = p.id
		WHERE p.is_top_10_percent = true AND c.institution_id IS NOT NULL
	`, 0)
	top10WithCountry := qInt(`
		SELECT COUNT(DISTINCT c.paper_id) FROM contributions c
		JOIN papers p ON c.paper_id = p.id
		WHERE p.is_top_10_percent = true AND c.country_code IS NOT NULL
	`, 0)

	internationalCount := qInt("SELECT COUNT(*) FROM papers WHERE is_international = true", 0)
	coreJournalCount := qInt("SELECT COUNT(*) FROM papers WHERE is_core_journal = true", 0)
	avgCitations := qFloat("SELECT AVG(cited_by_count) FROM papers WHERE cited_by_count IS NOT NULL", 0.0)
	avgFwci := qFloat("SELECT AVG(fwci) FROM papers WHERE fwci IS NOT NULL", 0.0)

	oaStatusBreakdown := make([][2]interface{}, 0)
	oaRows, err := dbConn.Query(`
		SELECT COALESCE(oa_status, 'unknown') AS status, COUNT(*) AS n
		FROM papers GROUP BY status ORDER BY n DESC
	`)
	if err == nil {
		for oaRows.Next() {
			var status string
			var n int64
			if err := oaRows.Scan(&status, &n); err == nil {
				oaStatusBreakdown = append(oaStatusBreakdown, [2]interface{}{status, n})
			}
		}
		oaRows.Close()
	}

	topTopics := make([]map[string]interface{}, 0)
	topicRows, err := dbConn.Query(`
		SELECT primary_topic_name, COUNT(*) as n
		FROM papers
		WHERE primary_topic_name IS NOT NULL
		GROUP BY primary_topic_name ORDER BY n DESC LIMIT 5
	`)
	if err == nil {
		for topicRows.Next() {
			var name string
			var n int64
			if err := topicRows.Scan(&name, &n); err == nil {
				topTopics = append(topTopics, map[string]interface{}{
					"name":  name,
					"count": n,
				})
			}
		}
		topicRows.Close()
	}

	absPath, _ := filepath.Abs(dbPath)
	return map[string]interface{}{
		"total":                        total,
		"year_min":                     yearMin,
		"year_max":                     yearMax,
		"with_abstract":                withAbstract,
		"author_count":                 authorCount,
		"inst_count":                   instCount,
		"country_count":                countryCount,
		"contrib_count":                contribCount,
		"with_country":                 withCountry,
		"with_institution":             withInstitution,
		"authors_with_orcid":           authorsWithOrcid,
		"institutions_with_ror":         institutionsWithRor,
		"contrib_with_country":         contribWithCountry,
		"contrib_with_institution":     contribWithInstitution,
		"contrib_with_raw_affiliation": contribWithRawAffiliation,
		"orphan":                       orphan,
		"all_null":                     allNull,
		"zero_total":                   zeroTotal,
		"contribs_for_zero":            contribsForZero,
		"rows_imputable":               rowsImputable,
		"rows_dead":                    rowsDead,
		"papers_imputable":             papersImputable,
		"papers_with_doi":              papersWithDoi,
		"papers_without_doi":           papersWithoutDoi,
		"buckets":                      buckets,
		"partial_total":                partialTotal,
		"all_null_country":             allNullCountry,
		"zero_country_total":           zeroCountryTotal,
		"country_buckets":              countryBuckets,
		"partial_country_total":        partialCountryTotal,
		"oa_count":                     oaCount,
		"top1_count":                   top1Count,
		"top1_with_institution":        top1WithInstitution,
		"top1_with_country":            top1WithCountry,
		"top10_count":                  top10Count,
		"top10_with_institution":       top10WithInstitution,
		"top10_with_country":           top10WithCountry,
		"international_count":          internationalCount,
		"core_journal_count":           coreJournalCount,
		"avg_citations":                avgCitations,
		"avg_fwci":                     avgFwci,
		"oa_status_breakdown":          oaStatusBreakdown,
		"top_topics":                   topTopics,
		"db_path":                      absPath,
	}, nil
}

func renderCheckDBTerminalOutput(dbPath string, d map[string]interface{}) string {
	getInt := func(key string) int64 {
		if v, ok := d[key].(int64); ok {
			return v
		}
		if v, ok := d[key].(int); ok {
			return int64(v)
		}
		if v, ok := d[key].(float64); ok {
			return int64(v)
		}
		return 0
	}

	barStr := func(pct float64, width int) string {
		if width <= 0 {
			width = 20
		}
		clamped := pct
		if clamped < 0 {
			clamped = 0
		}
		if clamped > 100 {
			clamped = 100
		}
		filled := int(math.Round(float64(width) * clamped / 100.0))
		if filled > width {
			filled = width
		}
		return strings.Repeat("█", filled) + strings.Repeat("░", width-filled)
	}

	formatNum := func(n int64) string {
		in := strconv.FormatInt(n, 10)
		out := make([]byte, 0, len(in)+(len(in)-1)/3)
		rem := len(in) % 3
		if rem > 0 {
			out = append(out, in[:rem]...)
			in = in[rem:]
		}
		for len(in) > 0 {
			if len(out) > 0 {
				out = append(out, ',')
			}
			out = append(out, in[:3]...)
			in = in[3:]
		}
		return string(out)
	}

	total := getInt("total")
	if total == 0 {
		total = 1
	}

	var sb strings.Builder

	// Panel 1: Database Overview
	sb.WriteString("╭─ Database Overview — " + dbPath + " ─╮\n")
	sb.WriteString(fmt.Sprintf("│ %s papers\n", formatNum(getInt("total"))))
	sb.WriteString(fmt.Sprintf("│ %s authors  ·  %s institutions  ·  %s countries  ·  %s contributions\n",
		formatNum(getInt("author_count")),
		formatNum(getInt("inst_count")),
		formatNum(getInt("country_count")),
		formatNum(getInt("contrib_count")),
	))
	sb.WriteString("╰──────────────────────────────────────────────────────────────────────────────╯\n")

	// Panel 2: Data Completeness
	sb.WriteString("╭───────────────────────────── Data Completeness ──────────────────────────────╮\n")
	sb.WriteString("│                                                                              │\n")
	sb.WriteString("│  Papers                                                                      │\n")
	sb.WriteString(fmt.Sprintf("│    with abstracts                 %s  %18s │\n", barStr(float64(getInt("with_abstract"))/float64(total)*100, 20), fmt.Sprintf("%s (%4.1f%%)", formatNum(getInt("with_abstract")), float64(getInt("with_abstract"))/float64(total)*100)))
	sb.WriteString(fmt.Sprintf("│    with country info              %s  %18s │\n", barStr(float64(getInt("with_country"))/float64(total)*100, 20), fmt.Sprintf("%s (%4.1f%%)", formatNum(getInt("with_country")), float64(getInt("with_country"))/float64(total)*100)))
	sb.WriteString(fmt.Sprintf("│    with institution info          %s  %18s │\n", barStr(float64(getInt("with_institution"))/float64(total)*100, 20), fmt.Sprintf("%s (%4.1f%%)", formatNum(getInt("with_institution")), float64(getInt("with_institution"))/float64(total)*100)))
	sb.WriteString("│                                                                              │\n")

	authorCount := getInt("author_count")
	if authorCount == 0 {
		authorCount = 1
	}
	sb.WriteString("│  Authors table                                                               │\n")
	sb.WriteString(fmt.Sprintf("│    with ORCID                     %s  %18s │\n", barStr(float64(getInt("authors_with_orcid"))/float64(authorCount)*100, 20), fmt.Sprintf("%s (%4.1f%%)", formatNum(getInt("authors_with_orcid")), float64(getInt("authors_with_orcid"))/float64(authorCount)*100)))
	sb.WriteString("│                                                                              │\n")

	instCount := getInt("inst_count")
	if instCount == 0 {
		instCount = 1
	}
	sb.WriteString("│  Institutions table                                                          │\n")
	sb.WriteString(fmt.Sprintf("│    with ROR ID                    %s  %18s │\n", barStr(float64(getInt("institutions_with_ror"))/float64(instCount)*100, 20), fmt.Sprintf("%s (%4.1f%%)", formatNum(getInt("institutions_with_ror")), float64(getInt("institutions_with_ror"))/float64(instCount)*100)))
	sb.WriteString("│                                                                              │\n")

	contribCount := getInt("contrib_count")
	if contribCount == 0 {
		contribCount = 1
	}
	sb.WriteString("│  Contributions table                                                         │\n")
	sb.WriteString(fmt.Sprintf("│    rows with country info         %s  %18s │\n", barStr(float64(getInt("contrib_with_country"))/float64(contribCount)*100, 20), fmt.Sprintf("%s (%4.1f%%)", formatNum(getInt("contrib_with_country")), float64(getInt("contrib_with_country"))/float64(contribCount)*100)))
	sb.WriteString(fmt.Sprintf("│    rows with institution info     %s  %18s │\n", barStr(float64(getInt("contrib_with_institution"))/float64(contribCount)*100, 20), fmt.Sprintf("%s (%4.1f%%)", formatNum(getInt("contrib_with_institution")), float64(getInt("contrib_with_institution"))/float64(contribCount)*100)))
	sb.WriteString(fmt.Sprintf("│    rows with raw affiliation      %s  %18s │\n", barStr(float64(getInt("contrib_with_raw_affiliation"))/float64(contribCount)*100, 20), fmt.Sprintf("%s (%4.1f%%)", formatNum(getInt("contrib_with_raw_affiliation")), float64(getInt("contrib_with_raw_affiliation"))/float64(contribCount)*100)))
	sb.WriteString("│                                                                              │\n")
	sb.WriteString("╰──────────────────────────────────────────────────────────────────────────────╯\n")

	// Panel 3: Institution & Country Coverage
	instFull := total - getInt("zero_total") - getInt("partial_total")
	if instFull < 0 {
		instFull = 0
	}
	countryFull := total - getInt("zero_country_total") - getInt("partial_country_total")
	if countryFull < 0 {
		countryFull = 0
	}
	sb.WriteString("╭─────────────────────── Institution & Country Coverage ───────────────────────╮\n")
	sb.WriteString("│ Every paper is bucketed by whether its authors' institutions/countries have  │\n")
	sb.WriteString("│ been matched. Full = every author matched. Partial = at least one author is  │\n")
	sb.WriteString("│ missing, but not all. Zero = no author on the paper is matched.              │\n")
	sb.WriteString("│                                                                              │\n")
	sb.WriteString("│ By institution                                                               │\n")
	sb.WriteString("│                                                                              │\n")
	sb.WriteString(fmt.Sprintf("│    Full — every author matched      %s  %18s │\n", barStr(float64(instFull)/float64(total)*100, 20), fmt.Sprintf("%s (%4.1f%%)", formatNum(instFull), float64(instFull)/float64(total)*100)))
	sb.WriteString(fmt.Sprintf("│    Partial — some authors missing   %s  %18s │\n", barStr(float64(getInt("partial_total"))/float64(total)*100, 20), fmt.Sprintf("%s (%4.1f%%)", formatNum(getInt("partial_total")), float64(getInt("partial_total"))/float64(total)*100)))
	sb.WriteString(fmt.Sprintf("│    Zero — no authors matched        %s  %18s │\n", barStr(float64(getInt("zero_total"))/float64(total)*100, 20), fmt.Sprintf("%s (%4.1f%%)", formatNum(getInt("zero_total")), float64(getInt("zero_total"))/float64(total)*100)))
	sb.WriteString("│                                                                              │\n")
	sb.WriteString("│ By country                                                                   │\n")
	sb.WriteString("│                                                                              │\n")
	sb.WriteString(fmt.Sprintf("│    Full — every author matched      %s  %18s │\n", barStr(float64(countryFull)/float64(total)*100, 20), fmt.Sprintf("%s (%4.1f%%)", formatNum(countryFull), float64(countryFull)/float64(total)*100)))
	sb.WriteString(fmt.Sprintf("│    Partial — some authors missing   %s  %18s │\n", barStr(float64(getInt("partial_country_total"))/float64(total)*100, 20), fmt.Sprintf("%s (%4.1f%%)", formatNum(getInt("partial_country_total")), float64(getInt("partial_country_total"))/float64(total)*100)))
	sb.WriteString(fmt.Sprintf("│    Zero — no authors matched        %s  %18s │\n", barStr(float64(getInt("zero_country_total"))/float64(total)*100, 20), fmt.Sprintf("%s (%4.1f%%)", formatNum(getInt("zero_country_total")), float64(getInt("zero_country_total"))/float64(total)*100)))
	sb.WriteString("│                                                                              │\n")
	sb.WriteString("╰──────────────────────────────────────────────────────────────────────────────╯\n\n")

	// Breakdown tables
	sb.WriteString("Partial institution-coverage breakdown (best imputation targets)\n")
	sb.WriteString("  Missing   Papers   Bar              \n ──────────────────────────────────── \n")
	buckets, _ := d["buckets"].(map[string]int64)
	pt := getInt("partial_total")
	if pt == 0 {
		pt = 1
	}
	for i := 1; i <= 5; i++ {
		key := strconv.Itoa(i)
		label := key
		if i == 5 {
			label = "5+"
		}
		var cnt int64
		if buckets != nil {
			cnt = buckets[key]
		}
		p := float64(cnt) / float64(pt) * 100.0
		sb.WriteString(fmt.Sprintf("  %-7s   %6s   %s\n", label, formatNum(cnt), barStr(p, 15)))
	}
	sb.WriteString("\n")

	sb.WriteString("Partial country-coverage breakdown\n")
	sb.WriteString("  Missing   Papers   Bar              \n ──────────────────────────────────── \n")
	cBuckets, _ := d["country_buckets"].(map[string]int64)
	pctTotal := getInt("partial_country_total")
	if pctTotal == 0 {
		pctTotal = 1
	}
	for i := 1; i <= 5; i++ {
		key := strconv.Itoa(i)
		label := key
		if i == 5 {
			label = "5+"
		}
		var cnt int64
		if cBuckets != nil {
			cnt = cBuckets[key]
		}
		p := float64(cnt) / float64(pctTotal) * 100.0
		sb.WriteString(fmt.Sprintf("  %-7s   %6s   %s\n", label, formatNum(cnt), barStr(p, 15)))
	}
	sb.WriteString("\n")

	// Influential Metrics Panel
	top10 := getInt("top10_count")
	top10Inst := getInt("top10_with_institution")
	top10Country := getInt("top10_with_country")
	top1 := getInt("top1_count")
	top1Inst := getInt("top1_with_institution")
	top1Country := getInt("top1_with_country")

	t10Denom := top10
	if t10Denom == 0 {
		t10Denom = 1
	}
	t1Denom := top1
	if t1Denom == 0 {
		t1Denom = 1
	}

	sb.WriteString("╭──────────────────────────── Influential Metrics ─────────────────────────────╮\n")
	sb.WriteString("│                                                                              │\n")
	sb.WriteString(fmt.Sprintf("│  Top 10%% cited (field-normalized)   %s  %18s │\n", barStr(float64(top10)/float64(total)*100, 20), fmt.Sprintf("%s (%4.1f%%)", formatNum(top10), float64(top10)/float64(total)*100)))
	sb.WriteString("│                                                                              │\n")
	sb.WriteString("│    Of those, coverage:                                                       │\n")
	sb.WriteString(fmt.Sprintf("│      with institution info          %s  %18s │\n", barStr(float64(top10Inst)/float64(t10Denom)*100, 20), fmt.Sprintf("%s (%4.1f%%)", formatNum(top10Inst), float64(top10Inst)/float64(t10Denom)*100)))
	sb.WriteString(fmt.Sprintf("│      with country info              %s  %18s │\n", barStr(float64(top10Country)/float64(t10Denom)*100, 20), fmt.Sprintf("%s (%4.1f%%)", formatNum(top10Country), float64(top10Country)/float64(t10Denom)*100)))
	sb.WriteString("│                                                                              │\n")
	sb.WriteString(fmt.Sprintf("│  Top 1%% cited (field-normalized)    %s  %18s │\n", barStr(float64(top1)/float64(total)*100, 20), fmt.Sprintf("%s (%4.1f%%)", formatNum(top1), float64(top1)/float64(total)*100)))
	sb.WriteString("│                                                                              │\n")
	sb.WriteString("│    Of those, coverage:                                                       │\n")
	sb.WriteString(fmt.Sprintf("│      with institution info          %s  %18s │\n", barStr(float64(top1Inst)/float64(t1Denom)*100, 20), fmt.Sprintf("%s (%4.1f%%)", formatNum(top1Inst), float64(top1Inst)/float64(t1Denom)*100)))
	sb.WriteString(fmt.Sprintf("│      with country info              %s  %18s │\n", barStr(float64(top1Country)/float64(t1Denom)*100, 20), fmt.Sprintf("%s (%4.1f%%)", formatNum(top1Country), float64(top1Country)/float64(t1Denom)*100)))
	sb.WriteString("│                                                                              │\n")
	sb.WriteString("╰──────────────────────────────────────────────────────────────────────────────╯\n\n")

	// Panel: Research Quality & Reach
	oaCount := getInt("oa_count")
	intlCount := getInt("international_count")
	coreCount := getInt("core_journal_count")
	var avgCit, avgFwci float64
	if v, ok := d["avg_citations"].(float64); ok {
		avgCit = v
	}
	if v, ok := d["avg_fwci"].(float64); ok {
		avgFwci = v
	}

	sb.WriteString("╭─────────────────────────── Research Quality & Reach ─────────────────────────╮\n")
	sb.WriteString("│                                                                              │\n")
	sb.WriteString(fmt.Sprintf("│  Open access                        %s  %18s │\n", barStr(float64(oaCount)/float64(total)*100, 20), fmt.Sprintf("%s (%4.1f%%)", formatNum(oaCount), float64(oaCount)/float64(total)*100)))
	sb.WriteString(fmt.Sprintf("│  International collaboration        %s  %18s │\n", barStr(float64(intlCount)/float64(total)*100, 20), fmt.Sprintf("%s (%4.1f%%)", formatNum(intlCount), float64(intlCount)/float64(total)*100)))
	sb.WriteString(fmt.Sprintf("│  Core journal                       %s  %18s │\n", barStr(float64(coreCount)/float64(total)*100, 20), fmt.Sprintf("%s (%4.1f%%)", formatNum(coreCount), float64(coreCount)/float64(total)*100)))
	sb.WriteString(fmt.Sprintf("│  Top 10%% cited (field-normalized)   %s  %18s │\n", barStr(float64(top10)/float64(total)*100, 20), fmt.Sprintf("%s (%4.1f%%)", formatNum(top10), float64(top10)/float64(total)*100)))
	sb.WriteString(fmt.Sprintf("│  Top 1%% cited (field-normalized)    %s  %18s │\n", barStr(float64(top1)/float64(total)*100, 20), fmt.Sprintf("%s (%4.1f%%)", formatNum(top1), float64(top1)/float64(total)*100)))
	sb.WriteString("│                                                                              │\n")
	sb.WriteString(fmt.Sprintf("│  Avg. citations per paper: %4.1f                                              │\n", avgCit))
	sb.WriteString(fmt.Sprintf("│  Avg. FWCI (field-weighted citation impact): %4.2f                           │\n", avgFwci))
	sb.WriteString("│                                                                              │\n")
	sb.WriteString("╰──────────────────────────────────────────────────────────────────────────────╯\n\n")

	if oaList, ok := d["oa_status_breakdown"].([][2]interface{}); ok && len(oaList) > 0 {
		sb.WriteString("OA Status Breakdown\n")
		sb.WriteString("  Status           Bar                Count\n ──────────────────────────────────────────\n")
		var maxN int64 = 1
		for _, item := range oaList {
			var n int64
			if v, ok := item[1].(int64); ok {
				n = v
			} else if v, ok := item[1].(int); ok {
				n = int64(v)
			}
			if n > maxN {
				maxN = n
			}
		}
		for _, item := range oaList {
			status := fmt.Sprintf("%v", item[0])
			var n int64
			if v, ok := item[1].(int64); ok {
				n = v
			} else if v, ok := item[1].(int); ok {
				n = int64(v)
			}
			p := float64(n) / float64(maxN) * 100.0
			sb.WriteString(fmt.Sprintf("  %-14s   %s   %8s\n", status, barStr(p, 15), formatNum(n)))
		}
		sb.WriteString("\n")
	}

	if topics, ok := d["top_topics"].([]map[string]interface{}); ok && len(topics) > 0 {
		sb.WriteString("Top 5 Topics\n")
		sb.WriteString("  Topic                                          Bar                Count\n ──────────────────────────────────────────────────────────────────────────────\n")
		var maxN int64 = 1
		for _, t := range topics {
			var n int64
			if v, ok := t["count"].(int64); ok {
				n = v
			} else if v, ok := t["count"].(int); ok {
				n = int64(v)
			}
			if n > maxN {
				maxN = n
			}
		}
		for _, t := range topics {
			name := fmt.Sprintf("%v", t["name"])
			if len(name) > 44 {
				name = name[:41] + "..."
			}
			var n int64
			if v, ok := t["count"].(int64); ok {
				n = v
			} else if v, ok := t["count"].(int); ok {
				n = int64(v)
			}
			p := float64(n) / float64(maxN) * 100.0
			sb.WriteString(fmt.Sprintf("  %-44s   %s   %8s\n", name, barStr(p, 15), formatNum(n)))
		}
		sb.WriteString("\n")
	}

	return sb.String()
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
		Filename       string  `json:"filename"`
		TitleColumn    string  `json:"title_column"`
		AbstractColumn string  `json:"abstract_column"`
		DOIColumn      string  `json:"doi_column"`
		TopN           int     `json:"top_n"`
		NgramMin       int     `json:"ngram_min"`
		NgramMax       int     `json:"ngram_max"`
		MinDF          int     `json:"min_df"`
		MaxDF          float64 `json:"max_df"`
		UseKeyBERT     bool    `json:"use_keybert"`
		KeyBERTModel   string  `json:"keybert_model"`
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

func findPythonInterpreter() string {
	candidates := []string{
		filepath.Join("..", "openAlex_data_collection", ".venv", "bin", "python"),
		"/run/media/krishnakumar/New Volume/IISC/openAlex_data_collection/.venv/bin/python",
		"python3",
		"python",
	}
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return "python3"
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

func (s *APIServer) handleListProjects(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodGet {
		http.Error(w, `{"error": "Method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	projects := []string{"default"}

	baseDir := s.workspaceDir
	if baseDir == "" {
		baseDir = "."
	}
	projectsDir := filepath.Join(baseDir, "projects")
	if entries, err := os.ReadDir(projectsDir); err == nil {
		for _, entry := range entries {
			if entry.IsDir() {
				name := entry.Name()
				if name == sanitizeProjectName(name) {
					projects = append(projects, name)
				}
			}
		}
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"projects": projects,
	})
}

func (s *APIServer) handleCreateProject(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		http.Error(w, `{"error": "Method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid request body: " + err.Error()})
		return
	}

	name := sanitizeProjectName(req.Name)
	if name == "" || name == "default" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid project name"})
		return
	}

	if err := s.ensureProjectDirs(name); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": "Failed to create project directories: " + err.Error()})
		return
	}

	configDB, err := s.getConfigDB(name)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": "Failed to initialize config DB: " + err.Error()})
		return
	}

	// Create initial history version 1
	configDBPath, _, _, _, _ := s.getProjectPaths(name)
	cfg, err := config.LoadConfig(configDBPath)
	var keywords, topics, anchors string
	if err == nil {
		keywords = cfg.Keywords
		topics = strings.Join(cfg.Topics, "\n")
		anchors = strings.Join(cfg.Anchors, "\n")
	}
	_ = s.appendConfigRevision(configDB, keywords, topics, anchors, "Project Created")

	json.NewEncoder(w).Encode(map[string]interface{}{
		"status": "success",
		"name":   name,
	})
}

func (s *APIServer) handleDeleteProject(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		http.Error(w, `{"error": "Method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Name string `json:"name"`
	}
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&req)
	}
	if req.Name == "" {
		req.Name = r.URL.Query().Get("name")
	}

	name := sanitizeProjectName(req.Name)
	if name == "" || name == "default" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "Cannot delete default project or invalid project name"})
		return
	}

	// 1. Close open connections and release cached managers
	s.mu.Lock()
	if mgr, ok := s.dbManagers[name]; ok {
		_ = mgr.Close()
		delete(s.dbManagers, name)
	}
	if cfgDB, ok := s.configDBs[name]; ok {
		_ = cfgDB.Close()
		delete(s.configDBs, name)
	}
	delete(s.projectMutexes, name)
	if s.currentProject == name {
		s.currentProject = "default"
	}
	s.mu.Unlock()

	// 2. Remove the project directory
	baseDir := s.workspaceDir
	if baseDir == "" {
		baseDir = "."
	}
	projectDir := filepath.Join(baseDir, "projects", name)
	if _, err := os.Stat(projectDir); os.IsNotExist(err) {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{"error": fmt.Sprintf("Project %q not found", name)})
		return
	}

	if err := os.RemoveAll(projectDir); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": "Failed to delete project directory: " + err.Error()})
		return
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "success",
		"message": fmt.Sprintf("Project %s deleted successfully", name),
		"name":    name,
	})
}

