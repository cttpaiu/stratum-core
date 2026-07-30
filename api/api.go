package api

import (
	"context"
	"database/sql"
	"embed"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"stratum/config"
	"stratum/db"
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

// APIServer manages HTTP routes and coordinates tasks for the web client interface.
type APIServer struct {
	addr             string
	dbPath           string
	workspaceDir     string
	dbManagers       map[string]*db.DBManager
	configDBs        map[string]*sql.DB
	pipelineStatuses map[string]*PipelineStatus
	projectMutexes   map[string]*sync.Mutex
	server           *http.Server
	mcpServer        *mcp.Server
	mcpHandler       *mcp.SSEHandler
	currentProject   string
	mu               sync.Mutex
}

// NewAPIServer creates a new API server on the specified address.
func NewAPIServer(addr string, dbPath string, workspaceDir string) *APIServer {
	s := &APIServer{
		addr:             addr,
		dbPath:           dbPath,
		workspaceDir:     workspaceDir,
		dbManagers:       make(map[string]*db.DBManager),
		configDBs:        make(map[string]*sql.DB),
		pipelineStatuses: make(map[string]*PipelineStatus),
		projectMutexes:   make(map[string]*sync.Mutex),
		currentProject:   "default",
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
	mux.HandleFunc("/api/config", s.handleConfig)
	mux.HandleFunc("/api/run-pipeline", s.handleRunPipeline)
	mux.HandleFunc("/api/pipeline/status", s.handlePipelineStatus)
	mux.HandleFunc("/api/upload", s.handleUpload)
	mux.HandleFunc("/api/tfidf", s.handleTFIDF)
	mux.HandleFunc("/api/query/validate", s.handleQueryValidate)
	mux.HandleFunc("/api/openalex/count", s.handleOpenAlexCount)
	mux.HandleFunc("/api/openalex/sample", s.handleOpenAlexSample)
	mux.HandleFunc("/api/openalex/topics", s.handleOpenAlexTopics)
	mux.HandleFunc("/api/projects", s.handleListProjects)
	mux.HandleFunc("/api/projects/create", s.handleCreateProject)
	mux.HandleFunc("/api/workspace", s.handleWorkspace)
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
		llmModel := "sorc/qwen3.5-instruct:2b"
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
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	project := r.URL.Query().Get("project")
	dbMgr, err := s.getDBMgr(project)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	results, err := dbMgr.RunQuery(body.Query)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	json.NewEncoder(w).Encode(results)
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
	s.mu.Unlock()

	s.addLog(project, "[INFO] Pipeline synchronization initiated by web client.")

	go func() {
		cfg.Output.JSONLDir = jsonlDir
		cfg.Output.DBDir = dbDir

		s.addLog(project, "[INFO] Initializing openalex.DownloadPapers worker pool...")
		client := openalex.NewClient(cfg.API.Keys, cfg.API.Email, cfg.Collection.PerPage, cfg.Collection.ConcurrentRequests, cfg.Collection.MaxRetries, cfg.Collection.RetryDelay)

		outputJSONL := filepath.Join(cfg.Output.JSONLDir, "collected_papers.jsonl")
		s.addLog(project, "[INFO] Starting paper download to " + outputJSONL + "...")

		progressChan := make(chan int, 100)
		errChan := make(chan error, 1)

		go func() {
			errChan <- client.DownloadPapers(context.Background(), cfg, outputJSONL, progressChan)
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
					s.updateStatus(project, false, 0, "[ERROR] Download failed: "+err.Error())
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

	keywords := tfidf.ExtractKeywords(docs, req.NgramMin, req.NgramMax, req.MinDF, req.MaxDF, req.TopN)
	if keywords == nil {
		keywords = []tfidf.ScoredTerm{}
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"keywords":      keywords,
		"anchors_count": len(dois),
	})
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
		Query    string   `json:"query"`
		Keys     []string `json:"keys"`
		Email    string   `json:"email"`
		DateFrom string   `json:"date_from"`
		DateTo   string   `json:"date_to"`
		DocTypes []string `json:"doc_types"`
		Topics   []string `json:"topics"`
		Details  bool     `json:"details"`
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

	// Fetch all topic groups using cursor pagination
	var allGroups []openalex.GroupByItem
	cursor := "*"
	for {
		resp, err := client.FetchGroupBy(r.Context(), filter, "primary_topic.id", cursor)
		if err != nil {
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

	// Sort groups by count descending
	sort.Slice(allGroups, func(i, j int) bool {
		return allGroups[i].Count > allGroups[j].Count
	})

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
		wg.Add(1)
		go func(idx int, item openalex.GroupByItem) {
			defer wg.Done()

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

	json.NewEncoder(w).Encode(map[string]interface{}{
		"total_topics": len(allGroups),
		"total_papers": totalPapers,
		"topics":       enriched,
	})
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
