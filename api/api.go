package api

import (
	"context"
	"database/sql"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"stratum/config"
	"stratum/db"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

//go:embed dist/*
var frontendFS embed.FS

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
	cttStatuses         map[string]*CTTStatus
	cttCancelFuncs      map[string]context.CancelFunc
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
		cttStatuses:         make(map[string]*CTTStatus),
		cttCancelFuncs:      make(map[string]context.CancelFunc),
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

	// 1. Core Server & Status
	mux.HandleFunc("/api/status", s.handleStatus)
	mux.HandleFunc("/api/workspace", s.handleWorkspace)

	// 2. Project Management (api/projects.go)
	mux.HandleFunc("/api/projects", s.handleListProjects)
	mux.HandleFunc("/api/projects/create", s.handleCreateProject)
	mux.HandleFunc("/api/projects/delete", s.handleDeleteProject)

	// 3. Search / Topics / Prompt Query Builder (api/search.go)
	mux.HandleFunc("/api/config", s.handleConfig)
	mux.HandleFunc("/api/upload", s.handleUpload)
	mux.HandleFunc("/api/tfidf", s.handleTFIDF)
	mux.HandleFunc("/api/query/validate", s.handleQueryValidate)
	mux.HandleFunc("/api/query/generate", s.handleQueryGenerate)
	mux.HandleFunc("/api/query/generate-from-anchors", s.handleQueryGenerateFromAnchors)
	mux.HandleFunc("/api/openalex/count", s.handleOpenAlexCount)
	mux.HandleFunc("/api/openalex/sample", s.handleOpenAlexSample)
	mux.HandleFunc("/api/openalex/topics", s.handleOpenAlexTopics)

	// 4. Ingest Page & Pipeline Sync (api/ingest.go)
	mux.HandleFunc("/api/run-pipeline", s.handleRunPipeline)
	mux.HandleFunc("/api/pipeline/status", s.handlePipelineStatus)
	mux.HandleFunc("/api/pipeline/cancel", s.handlePipelineCancel)
	mux.HandleFunc("/api/download-papers", s.handleDownloadPapers)
	mux.HandleFunc("/api/download/papers", s.handleDownloadPapers)
	mux.HandleFunc("/api/download/info", s.handleDownloadInfo)
	mux.HandleFunc("/api/download/file", s.handleDownloadFile)
	mux.HandleFunc("/api/db/import-jsonl", s.handleImportJSONL)

	// 5. Impute Country (api/impute.go)
	mux.HandleFunc("/api/impute/files", s.handleImputeFiles)
	mux.HandleFunc("/api/jsonl/preview", s.handleJSONLPreview)
	mux.HandleFunc("/api/impute/run", s.handleImputeRun)
	mux.HandleFunc("/api/impute/status", s.handleImputeStatus)
	mux.HandleFunc("/api/impute/cancel", s.handleImputeCancel)

	// 6. Export Page & Artifacts (api/export.go)
	mux.HandleFunc("/api/export/files", s.handleExportFiles)
	mux.HandleFunc("/api/export/run", s.handleExportRun)
	mux.HandleFunc("/api/export/status", s.handleExportStatus)
	mux.HandleFunc("/api/export/cancel", s.handleExportCancel)
	mux.HandleFunc("/api/export/download", s.handleExportDownload)
	mux.HandleFunc("/api/export/launch-viewer", s.handleExportLaunchViewer)

	// 7. Check DB Verification (api/check_db.go)
	mux.HandleFunc("/api/export/check-db", s.handleExportCheckDB)

	// 8. SQL Analytics & Dashboard (api/sql.go)
	mux.HandleFunc("/api/stats", s.handleStats)
	mux.HandleFunc("/api/query", s.handleQuery)
	mux.HandleFunc("/api/country-rankings", s.handleCountryRankings)
	mux.HandleFunc("/api/sql/country-rankings", s.handleCountryRankings)

	// 9. Insights Page / CTT Pipeline (api/insights.go)
	mux.HandleFunc("/api/ctt/files", s.handleCTTFiles)
	mux.HandleFunc("/api/ctt/run", s.handleCTTRun)
	mux.HandleFunc("/api/ctt/status", s.handleCTTStatus)
	mux.HandleFunc("/api/ctt/cancel", s.handleCTTCancel)
	mux.HandleFunc("/api/ctt/download", s.handleCTTDownload)

	// 10. Model Context Protocol (MCP) (api/mcp.go)
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

func (s *APIServer) resolveDatabasePath(project, rawFile string) string {
	if project == "" {
		project = "default"
	}
	project = sanitizeProjectName(project)
	projBaseDir, _, _, dbBaseDir, _ := s.getProjectExportDirs(project)

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

	if target == "" && rawFile != "" {
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
	if target == "" && rawFile == "" {
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

	return target
}

func (s *APIServer) getDBMgrForFile(project, rawFile string) (*db.DBManager, error) {
	if rawFile == "" {
		return s.getDBMgr(project)
	}

	targetPath := s.resolveDatabasePath(project, rawFile)
	if targetPath == "" {
		targetPath = rawFile
	}

	cacheKey := "path:" + targetPath

	s.mu.Lock()
	if mgr, ok := s.dbManagers[cacheKey]; ok {
		s.mu.Unlock()
		return mgr, nil
	}

	if s.projectMutexes == nil {
		s.projectMutexes = make(map[string]*sync.Mutex)
	}
	fileMu, ok := s.projectMutexes[cacheKey]
	if !ok {
		fileMu = &sync.Mutex{}
		s.projectMutexes[cacheKey] = fileMu
	}
	s.mu.Unlock()

	fileMu.Lock()
	defer fileMu.Unlock()

	s.mu.Lock()
	if mgr, ok := s.dbManagers[cacheKey]; ok {
		s.mu.Unlock()
		return mgr, nil
	}
	s.mu.Unlock()

	mgr, err := db.NewDBManager(targetPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open database %s: %w", targetPath, err)
	}

	s.mu.Lock()
	s.dbManagers[cacheKey] = mgr
	s.mu.Unlock()

	return mgr, nil
}

func (s *APIServer) handleStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "online"})
}
