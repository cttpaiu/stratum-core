package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	_ "github.com/duckdb/duckdb-go/v2"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"stratum/config"
	"stratum/db"
)

// Helper to setup a test directory structure and config files
func setupTestEnv(t *testing.T) (string, func()) {
	// Create temporary directories
	_ = os.MkdirAll("config", 0755)
	_ = os.MkdirAll("data/jsonl", 0755)
	_ = os.MkdirAll("data/uploads", 0755)

	tmpDir, err := os.MkdirTemp("", "stratum_test_dir_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	dbPath := filepath.Join(tmpDir, "papers.db")

	// Write default YAML config
	cfgContent := fmt.Sprintf(`api:
  keys: ["test-api-key"]
  email: "test@example.com"
filters:
  date_from: "2024-01-01"
  date_to: "2024-12-31"
  doc_types: ["article"]
collection:
  per_page: 50
  concurrent_requests: 2
  max_retries: 3
  retry_delay: 1
llm:
  provider: "ollama"
  model: "llama3"
output:
  jsonl_dir: "data/jsonl"
  db_dir: "%s"
keywords_file: "config/keywords.txt"
topics_file: "config/topics.txt"
anchor_file: "config/anchor.txt"
`, tmpDir)

	err = os.WriteFile("config/collection.yml", []byte(cfgContent), 0644)
	if err != nil {
		t.Fatalf("failed to write collection.yml: %v", err)
	}

	err = os.WriteFile("config/keywords.txt", []byte("(\"machine learning\")"), 0644)
	if err != nil {
		t.Fatalf("failed to write keywords.txt: %v", err)
	}

	err = os.WriteFile("config/topics.txt", []byte("T10012\nT10245"), 0644)
	if err != nil {
		t.Fatalf("failed to write topics.txt: %v", err)
	}

	err = os.WriteFile("config/anchor.txt", []byte("10.1001/test"), 0644)
	if err != nil {
		t.Fatalf("failed to write anchor.txt: %v", err)
	}

	cleanup := func() {
		os.Remove("config/collection.yml")
		os.Remove("config/keywords.txt")
		os.Remove("config/topics.txt")
		os.Remove("config/anchor.txt")
		os.RemoveAll("config")
		os.RemoveAll("data")
		os.RemoveAll(tmpDir)
	}

	return dbPath, cleanup
}

type redirectTransport struct {
	targetURL     *url.URL
	origTransport http.RoundTripper
}

func (t *redirectTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	req.URL.Scheme = t.targetURL.Scheme
	req.URL.Host = t.targetURL.Host
	return t.origTransport.RoundTrip(req)
}

func TestStatusRoute(t *testing.T) {
	dbPath, cleanup := setupTestEnv(t)
	defer cleanup()

	server := NewAPIServer("localhost:8080", dbPath, "")
	err := server.RegisterRoutes()
	if err != nil {
		t.Fatalf("RegisterRoutes failed: %v", err)
	}

	req := httptest.NewRequest("GET", "/api/status", nil)
	w := httptest.NewRecorder()
	server.server.Handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", w.Code)
	}

	var resp map[string]string
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["status"] != "online" {
		t.Errorf("expected status online, got %q", resp["status"])
	}
}

func TestStatsRoute(t *testing.T) {
	dbPath, cleanup := setupTestEnv(t)
	defer cleanup()

	server := NewAPIServer("localhost:8080", dbPath, "")
	err := server.RegisterRoutes()
	if err != nil {
		t.Fatalf("RegisterRoutes failed: %v", err)
	}

	// Prepare mock schema and mock data
	dbMgr, err := server.getDBMgr("default")
	if err != nil {
		t.Fatalf("failed to get db manager: %v", err)
	}
	err = dbMgr.CreateSchema()
	if err != nil {
		t.Fatalf("failed to create schema: %v", err)
	}

	dbConn, err := sql.Open("duckdb", dbPath)
	if err != nil {
		t.Fatalf("failed to open duckdb: %v", err)
	}
	defer dbConn.Close()

	_, err = dbConn.Exec(`
		INSERT INTO papers (id, doi, title, publication_year, journal_name, is_oa, cited_by_count)
		VALUES ('p-1', '10.1001/test1', 'Deep Learning', 2024, 'Nature', TRUE, 100)
	`)
	if err != nil {
		t.Fatalf("failed to insert mock paper: %v", err)
	}

	req := httptest.NewRequest("GET", "/api/stats", nil)
	w := httptest.NewRecorder()
	server.server.Handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", w.Code)
	}

	var stats db.DashboardStats
	json.NewDecoder(w.Body).Decode(&stats)

	if stats.TotalPapers != 1 {
		t.Errorf("expected TotalPapers = 1, got %d", stats.TotalPapers)
	}
}

func TestQueryRoute(t *testing.T) {
	dbPath, cleanup := setupTestEnv(t)
	defer cleanup()

	server := NewAPIServer("localhost:8080", dbPath, "")
	err := server.RegisterRoutes()
	if err != nil {
		t.Fatalf("RegisterRoutes failed: %v", err)
	}

	dbMgr, err := server.getDBMgr("default")
	if err != nil {
		t.Fatalf("failed to get db manager: %v", err)
	}
	err = dbMgr.CreateSchema()
	if err != nil {
		t.Fatalf("failed to create schema: %v", err)
	}

	dbConn, err := sql.Open("duckdb", dbPath)
	if err != nil {
		t.Fatalf("failed to open duckdb: %v", err)
	}
	defer dbConn.Close()

	_, err = dbConn.Exec(`
		INSERT INTO papers (id, doi, title, publication_year, journal_name, is_oa)
		VALUES ('p-1', '10.1001/test1', 'Deep Learning', 2024, 'Nature', TRUE)
	`)
	if err != nil {
		t.Fatalf("failed to insert mock paper: %v", err)
	}

	bodyJSON, _ := json.Marshal(map[string]string{
		"query": "SELECT id, title FROM papers WHERE publication_year = 2024",
	})

	req := httptest.NewRequest("POST", "/api/query", bytes.NewBuffer(bodyJSON))
	w := httptest.NewRecorder()
	server.server.Handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	var rows []map[string]interface{}
	json.NewDecoder(w.Body).Decode(&rows)

	if len(rows) != 1 {
		t.Errorf("expected 1 row, got %d", len(rows))
	} else {
		if rows[0]["id"] != "p-1" || rows[0]["title"] != "Deep Learning" {
			t.Errorf("unexpected row content: %v", rows[0])
		}
	}
}

func TestConfigRoute(t *testing.T) {
	dbPath, cleanup := setupTestEnv(t)
	defer cleanup()

	server := NewAPIServer("localhost:8080", dbPath, "")
	err := server.RegisterRoutes()
	if err != nil {
		t.Fatalf("RegisterRoutes failed: %v", err)
	}

	// 1. Test GET config
	reqGet := httptest.NewRequest("GET", "/api/config", nil)
	wGet := httptest.NewRecorder()
	server.server.Handler.ServeHTTP(wGet, reqGet)

	if wGet.Code != http.StatusOK {
		t.Errorf("expected GET status 200, got %d", wGet.Code)
	}

	var respGet map[string]interface{}
	json.NewDecoder(wGet.Body).Decode(&respGet)

	if respGet["keywords"] != "(\"machine learning\")" {
		t.Errorf("expected keywords matching config, got %q", respGet["keywords"])
	}

	// 2. Test POST config
	configDBPath := filepath.Join(filepath.Dir(dbPath), "config.db")
	cfg, err := config.LoadConfig(configDBPath)
	if err != nil {
		t.Fatalf("failed to load config: %v", err)
	}

	bodyJSON, _ := json.Marshal(map[string]interface{}{
		"config":   cfg,
		"keywords": "(\"neural networks\")",
		"topics":   "T22334",
		"anchors":  "10.1111/test",
	})

	reqPost := httptest.NewRequest("POST", "/api/config", bytes.NewBuffer(bodyJSON))
	wPost := httptest.NewRecorder()
	server.server.Handler.ServeHTTP(wPost, reqPost)

	if wPost.Code != http.StatusOK {
		t.Errorf("expected POST status 200, got %d", wPost.Code)
	}

	// Check if DB config updated
	loaded, err := config.LoadConfig(configDBPath)
	if err != nil {
		t.Fatalf("failed to load updated config: %v", err)
	}
	if loaded.Keywords != "(\"neural networks\")" {
		t.Errorf("expected keywords updated to '(\"neural networks\")', got %q", loaded.Keywords)
	}
}

func TestSPAFallback(t *testing.T) {
	dbPath, cleanup := setupTestEnv(t)
	defer cleanup()

	server := NewAPIServer("localhost:8080", dbPath, "")
	err := server.RegisterRoutes()
	if err != nil {
		t.Fatalf("RegisterRoutes failed: %v", err)
	}

	// Hitting /sql or /docs should serve /dist/index.html (the SPA shell)
	req := httptest.NewRequest("GET", "/sql", nil)
	w := httptest.NewRecorder()
	server.server.Handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected fallback status 200, got %d", w.Code)
	}

	bodyStr := w.Body.String()
	if !strings.Contains(bodyStr, "<html") && !strings.Contains(bodyStr, "Stratum") {
		t.Errorf("expected SPA fallback to render HTML document shell, got: %s", bodyStr)
	}
}

func TestPipelineRoutes(t *testing.T) {
	dbPath, cleanup := setupTestEnv(t)
	defer cleanup()

	server := NewAPIServer("localhost:8080", dbPath, "")
	err := server.RegisterRoutes()
	if err != nil {
		t.Fatalf("RegisterRoutes failed: %v", err)
	}

	// Mock OpenAlex API serving pagination query
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		
		// Return empty search page response
		payload := map[string]interface{}{
			"meta": map[string]interface{}{
				"count":       0,
				"next_cursor": "",
			},
			"results": []interface{}{},
		}
		json.NewEncoder(w).Encode(payload)
	}))
	defer ts.Close()

	// Redirect HTTP calls to test server
	mockURL, _ := url.Parse(ts.URL)
	origTransport := http.DefaultTransport
	http.DefaultTransport = &redirectTransport{targetURL: mockURL, origTransport: origTransport}
	defer func() { http.DefaultTransport = origTransport }()

	// Set valid keywords on the default configuration before running pipeline
	configDBPath, _, _, _, _ := server.getProjectPaths("")
	cfg, err := config.LoadConfig(configDBPath)
	if err != nil {
		t.Fatalf("failed to load config: %v", err)
	}
	cfg.Keywords = "quantum"
	err = config.SaveConfig(configDBPath, cfg)
	if err != nil {
		t.Fatalf("failed to save config: %v", err)
	}

	// Trigger run pipeline
	reqRun := httptest.NewRequest("POST", "/api/run-pipeline", nil)
	wRun := httptest.NewRecorder()
	server.server.Handler.ServeHTTP(wRun, reqRun)

	if wRun.Code != http.StatusOK {
		t.Errorf("expected /api/run-pipeline status 200, got %d", wRun.Code)
	}

	// Give the async pipeline goroutine a brief moment to run and close
	time.Sleep(100 * time.Millisecond)

	// Fetch status
	reqStatus := httptest.NewRequest("GET", "/api/pipeline/status", nil)
	wStatus := httptest.NewRecorder()
	server.server.Handler.ServeHTTP(wStatus, reqStatus)

	if wStatus.Code != http.StatusOK {
		t.Errorf("expected /api/pipeline/status status 200, got %d", wStatus.Code)
	}

	var status PipelineStatus
	json.NewDecoder(wStatus.Body).Decode(&status)

	// In the test setup, OpenAlex returns 0 results, so it should finish very fast and set Syncing to false.
	// Check that logs list is populated.
	if len(status.Logs) == 0 {
		t.Errorf("expected logs captured, got 0 logs")
	}
}

func TestProjectsAndHistory(t *testing.T) {
	dbPath, cleanup := setupTestEnv(t)
	defer cleanup()
	defer os.RemoveAll("projects")

	server := NewAPIServer("localhost:8080", dbPath, "")
	err := server.RegisterRoutes()
	if err != nil {
		t.Fatalf("RegisterRoutes failed: %v", err)
	}

	// 1. List projects initially (should contain "default")
	reqList := httptest.NewRequest("GET", "/api/projects", nil)
	wList := httptest.NewRecorder()
	server.server.Handler.ServeHTTP(wList, reqList)

	if wList.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", wList.Code)
	}
	var listResp map[string][]string
	json.NewDecoder(wList.Body).Decode(&listResp)
	if len(listResp["projects"]) != 1 || listResp["projects"][0] != "default" {
		t.Errorf("unexpected projects list: %v", listResp["projects"])
	}

	// 2. Create new project "test-proj"
	createBody, _ := json.Marshal(map[string]string{
		"name": "test-proj",
	})
	reqCreate := httptest.NewRequest("POST", "/api/projects/create", bytes.NewBuffer(createBody))
	wCreate := httptest.NewRecorder()
	server.server.Handler.ServeHTTP(wCreate, reqCreate)

	if wCreate.Code != http.StatusOK {
		t.Fatalf("failed to create project: %d, body: %s", wCreate.Code, wCreate.Body.String())
	}

	// 3. List projects again (should contain "default" and "test-proj")
	wList2 := httptest.NewRecorder()
	server.server.Handler.ServeHTTP(wList2, reqList)
	json.NewDecoder(wList2.Body).Decode(&listResp)
	found := false
	for _, p := range listResp["projects"] {
		if p == "test-proj" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("project test-proj not found in list: %v", listResp["projects"])
	}

	// 4. Test configuration and history in "test-proj"
	reqGetConfig := httptest.NewRequest("GET", "/api/config?project=test-proj", nil)
	wGetConfig := httptest.NewRecorder()
	server.server.Handler.ServeHTTP(wGetConfig, reqGetConfig)

	if wGetConfig.Code != http.StatusOK {
		t.Fatalf("failed to get project config: %d", wGetConfig.Code)
	}

	var configResp struct {
		Keywords string           `json:"keywords"`
		History  []ConfigRevision `json:"history"`
	}
	json.NewDecoder(wGetConfig.Body).Decode(&configResp)

	// Projects are pre-populated with Version 1 "Project Created" revision
	if len(configResp.History) == 0 {
		t.Errorf("expected history revision, got 0")
	} else if configResp.History[0].Label != "Project Created" {
		t.Errorf("expected initial revision label 'Project Created', got %q", configResp.History[0].Label)
	}
}

func TestOpenAlexTopicsRoute(t *testing.T) {
	dbPath, cleanup := setupTestEnv(t)
	defer cleanup()

	server := NewAPIServer("localhost:8080", dbPath, "")
	err := server.RegisterRoutes()
	if err != nil {
		t.Fatalf("RegisterRoutes failed: %v", err)
	}

	// Mock OpenAlex API serving group_by and topic details
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(r.URL.Path, "/works") {
			fmt.Fprintln(w, `{"group_by":[{"key":"https://openalex.org/T10001","key_display_name":"Topic 1","count":10}],"meta":{"count":1,"next_cursor":""}}`)
		} else if strings.Contains(r.URL.Path, "/topics/") {
			fmt.Fprintln(w, `{"id":"https://openalex.org/T10001","display_name":"Topic 1","description":"Test Topic","keywords":["kw1"],"domain":{"display_name":"Domain 1"},"field":{"display_name":"Field 1"},"subfield":{"display_name":"Subfield 1"}}`)
		}
	}))
	defer ts.Close()

	// Redirect HTTP calls to test server
	mockURL, _ := url.Parse(ts.URL)
	origTransport := http.DefaultTransport
	http.DefaultTransport = &redirectTransport{targetURL: mockURL, origTransport: origTransport}
	defer func() { http.DefaultTransport = origTransport }()

	bodyJSON, _ := json.Marshal(map[string]interface{}{
		"query":     "quantum",
		"email":     "test@example.com",
		"date_from": "2024-01-01",
		"date_to":   "2024-12-31",
		"details":   true,
	})

	req := httptest.NewRequest("POST", "/api/openalex/topics", bytes.NewBuffer(bodyJSON))
	w := httptest.NewRecorder()
	server.server.Handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected /api/openalex/topics status 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	var resp struct {
		TotalTopics int `json:"total_topics"`
		TotalPapers int `json:"total_papers"`
		Topics      []struct {
			TopicID     string  `json:"topic_id"`
			DisplayName string  `json:"display_name"`
			Description string  `json:"description"`
			Count       int     `json:"paper_count"`
			Percentage  float64 `json:"percentage"`
		} `json:"topics"`
	}
	json.NewDecoder(w.Body).Decode(&resp)

	if resp.TotalTopics != 1 || resp.TotalPapers != 10 {
		t.Errorf("unexpected summary count: %+v", resp)
	}
	if len(resp.Topics) != 1 || resp.Topics[0].TopicID != "T10001" || resp.Topics[0].DisplayName != "Topic 1" || resp.Topics[0].Description != "Test Topic" {
		t.Errorf("unexpected topic: %+v", resp.Topics)
	}
}

func TestOpenAlexCountRouteWithInvalidTopics(t *testing.T) {
	dbPath, cleanup := setupTestEnv(t)
	defer cleanup()

	server := NewAPIServer("localhost:8080", dbPath, "")
	err := server.RegisterRoutes()
	if err != nil {
		t.Fatalf("RegisterRoutes failed: %v", err)
	}

	// Mock OpenAlex API
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// Check that the filter parameter does NOT contain "energy batteries" (only valid topics like T10012)
		filterVal := r.URL.Query().Get("filter")
		if strings.Contains(filterVal, "energy") || strings.Contains(filterVal, "batteries") {
			t.Errorf("filter query contains unsanitized invalid topic: %q", filterVal)
		}
		fmt.Fprintln(w, `{"meta":{"count":123,"next_cursor":""},"results":[]}`)
	}))
	defer ts.Close()

	mockURL, _ := url.Parse(ts.URL)
	origTransport := http.DefaultTransport
	http.DefaultTransport = &redirectTransport{targetURL: mockURL, origTransport: origTransport}
	defer func() { http.DefaultTransport = origTransport }()

	bodyJSON, _ := json.Marshal(map[string]interface{}{
		"query":  "battery",
		"email":  "test@example.com",
		"topics": []string{"energy batteries", "T10012"}, // "energy batteries" is invalid and should be filtered out
	})

	req := httptest.NewRequest("POST", "/api/openalex/count", bytes.NewBuffer(bodyJSON))
	w := httptest.NewRecorder()
	server.server.Handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d. Body: %s", w.Code, w.Body.String())
	}
}

func TestOpenAlexTopicsRouteWithInvalidTopics(t *testing.T) {
	dbPath, cleanup := setupTestEnv(t)
	defer cleanup()

	server := NewAPIServer("localhost:8080", dbPath, "")
	err := server.RegisterRoutes()
	if err != nil {
		t.Fatalf("RegisterRoutes failed: %v", err)
	}

	// Mock OpenAlex API
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		filterVal := r.URL.Query().Get("filter")
		if strings.Contains(filterVal, "energy") || strings.Contains(filterVal, "batteries") {
			t.Errorf("filter query contains unsanitized invalid topic: %q", filterVal)
		}
		if strings.Contains(r.URL.Path, "/works") {
			fmt.Fprintln(w, `{"group_by":[{"key":"https://openalex.org/T10001","key_display_name":"Topic 1","count":10}],"meta":{"count":1,"next_cursor":""}}`)
		} else if strings.Contains(r.URL.Path, "/topics/") {
			fmt.Fprintln(w, `{"id":"https://openalex.org/T10001","display_name":"Topic 1","description":"Test Topic"}`)
		}
	}))
	defer ts.Close()

	mockURL, _ := url.Parse(ts.URL)
	origTransport := http.DefaultTransport
	http.DefaultTransport = &redirectTransport{targetURL: mockURL, origTransport: origTransport}
	defer func() { http.DefaultTransport = origTransport }()

	bodyJSON, _ := json.Marshal(map[string]interface{}{
		"query":  "battery",
		"email":  "test@example.com",
		"topics": []string{"energy batteries", "T10012"}, // "energy batteries" should be filtered out
	})

	req := httptest.NewRequest("POST", "/api/openalex/topics", bytes.NewBuffer(bodyJSON))
	w := httptest.NewRecorder()
	server.server.Handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d. Body: %s", w.Code, w.Body.String())
	}
}

func TestOpenAlexCountRouteWithInvalidQuery(t *testing.T) {
	dbPath, cleanup := setupTestEnv(t)
	defer cleanup()

	server := NewAPIServer("localhost:8080", dbPath, "")
	err := server.RegisterRoutes()
	if err != nil {
		t.Fatalf("RegisterRoutes failed: %v", err)
	}

	bodyJSON, _ := json.Marshal(map[string]interface{}{
		"query": "(unbalanced", // invalid keywords query
		"email": "test@example.com",
	})

	req := httptest.NewRequest("POST", "/api/openalex/count", bytes.NewBuffer(bodyJSON))
	w := httptest.NewRecorder()
	server.server.Handler.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected status 400 for invalid query validation, got %d. Body: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "Query validation failed") {
		t.Errorf("expected error message to contain 'Query validation failed', got %s", w.Body.String())
	}
}

func TestOpenAlexTopicsRouteWithInvalidQuery(t *testing.T) {
	dbPath, cleanup := setupTestEnv(t)
	defer cleanup()

	server := NewAPIServer("localhost:8080", dbPath, "")
	err := server.RegisterRoutes()
	if err != nil {
		t.Fatalf("RegisterRoutes failed: %v", err)
	}

	bodyJSON, _ := json.Marshal(map[string]interface{}{
		"query": "(unbalanced", // invalid keywords query
		"email": "test@example.com",
	})

	req := httptest.NewRequest("POST", "/api/openalex/topics", bytes.NewBuffer(bodyJSON))
	w := httptest.NewRecorder()
	server.server.Handler.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected status 400 for invalid query validation, got %d. Body: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "Query validation failed") {
		t.Errorf("expected error message to contain 'Query validation failed', got %s", w.Body.String())
	}
}

func TestPipelineRouteWithInvalidQuery(t *testing.T) {
	dbPath, cleanup := setupTestEnv(t)
	defer cleanup()

	server := NewAPIServer("localhost:8080", dbPath, "")
	err := server.RegisterRoutes()
	if err != nil {
		t.Fatalf("RegisterRoutes failed: %v", err)
	}

	// Set invalid keywords on the default configuration before running pipeline
	configDBPath, _, _, _, _ := server.getProjectPaths("")
	cfg, err := config.LoadConfig(configDBPath)
	if err != nil {
		t.Fatalf("failed to load config: %v", err)
	}
	cfg.Keywords = "(unbalanced" // invalid query
	err = config.SaveConfig(configDBPath, cfg)
	if err != nil {
		t.Fatalf("failed to save config: %v", err)
	}

	// Trigger run pipeline
	reqRun := httptest.NewRequest("POST", "/api/run-pipeline", nil)
	wRun := httptest.NewRecorder()
	server.server.Handler.ServeHTTP(wRun, reqRun)

	if wRun.Code != http.StatusBadRequest {
		t.Errorf("expected /api/run-pipeline status 400 for invalid query validation, got %d. Body: %s", wRun.Code, wRun.Body.String())
	}
	if !strings.Contains(wRun.Body.String(), "Query validation failed") {
		t.Errorf("expected error message to contain 'Query validation failed', got %s", wRun.Body.String())
	}
}

func TestOpenAlexSampleRoute(t *testing.T) {
	dbPath, cleanup := setupTestEnv(t)
	defer cleanup()

	server := NewAPIServer("localhost:8080", dbPath, "")
	err := server.RegisterRoutes()
	if err != nil {
		t.Fatalf("RegisterRoutes failed: %v", err)
	}

	// Mock OpenAlex API response
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{
			"meta": {"count": 1},
			"results": [{
				"id": "https://openalex.org/W1",
				"doi": "https://doi.org/10.1234/test",
				"title": "Test Paper Title",
				"publication_year": 2026,
				"type": "journal-article",
				"primary_topic": {
					"id": "https://openalex.org/T10001",
					"display_name": "Test Topic Name"
				},
				"abstract_inverted_index": {
					"Hello": [0],
					"World": [1]
				},
				"cited_by_count": 5,
				"fwci": 1.25,
				"institutions_distinct_count": 2,
				"countries_distinct_count": 1
			}]
		}`)
	}))
	defer ts.Close()

	mockURL, _ := url.Parse(ts.URL)
	origTransport := http.DefaultTransport
	http.DefaultTransport = &redirectTransport{targetURL: mockURL, origTransport: origTransport}
	defer func() { http.DefaultTransport = origTransport }()

	bodyJSON, _ := json.Marshal(map[string]interface{}{
		"query":       "test query",
		"email":       "test@example.com",
		"sample_size": 1,
	})

	req := httptest.NewRequest("POST", "/api/openalex/sample", bytes.NewBuffer(bodyJSON))
	w := httptest.NewRecorder()
	server.server.Handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	contentType := w.Header().Get("Content-Type")
	if contentType != "text/csv" {
		t.Errorf("expected Content-Type text/csv, got %s", contentType)
	}

	contentDisposition := w.Header().Get("Content-Disposition")
	if !strings.Contains(contentDisposition, "openalex_sample_1.csv") {
		t.Errorf("expected Content-Disposition to contain openalex_sample_1.csv, got %s", contentDisposition)
	}

	// Verify CSV contents
	csvReader := csv.NewReader(w.Body)
	records, err := csvReader.ReadAll()
	if err != nil {
		t.Fatalf("failed to read CSV response: %v", err)
	}

	if len(records) != 2 { // Header + 1 Row
		t.Fatalf("expected 2 CSV rows, got %d", len(records))
	}

	// Header verify
	expectedHeader := []string{
		"id", "doi", "title", "publication_year", "type",
		"topic_id", "topic_name", "abstract_text",
		"cited_by_count", "fwci", "institutions_count", "countries_count",
	}
	for i, h := range expectedHeader {
		if records[0][i] != h {
			t.Errorf("header column %d: expected %s, got %s", i, h, records[0][i])
		}
	}

	// Row verify
	row := records[1]
	if row[0] != "https://openalex.org/W1" || row[1] != "https://doi.org/10.1234/test" || row[2] != "Test Paper Title" {
		t.Errorf("unexpected row data fields: %v", row)
	}
	if row[3] != "2026" || row[4] != "journal-article" || row[5] != "T10001" || row[6] != "Test Topic Name" {
		t.Errorf("unexpected topic or metadata fields: %v", row)
	}
	if row[7] != "Hello World" { // Reconstructed abstract text
		t.Errorf("expected reconstructed abstract 'Hello World', got %q", row[7])
	}
	if row[8] != "5" || row[9] != "1.25" || row[10] != "2" || row[11] != "1" {
		t.Errorf("unexpected stats fields: %v", row)
	}
}

func TestMCPRoute(t *testing.T) {
	dbPath, cleanup := setupTestEnv(t)
	defer cleanup()

	server := NewAPIServer("localhost:8080", dbPath, "")
	err := server.RegisterRoutes()
	if err != nil {
		t.Fatalf("RegisterRoutes failed: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	req := httptest.NewRequest("GET", "/api/mcp", nil).WithContext(ctx)
	req.Header.Set("Accept", "text/event-stream")
	w := httptest.NewRecorder()
	server.server.Handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected GET status 200, got %d", w.Code)
	}

	contentType := w.Header().Get("Content-Type")
	if !strings.Contains(contentType, "text/event-stream") {
		t.Errorf("expected Content-Type to contain text/event-stream, got %q", contentType)
	}

	bodyStr := w.Body.String()
	if !strings.Contains(bodyStr, "event: endpoint") {
		t.Errorf("expected body to contain 'event: endpoint' initialization, got %q", bodyStr)
	}
}

func TestMCPResources(t *testing.T) {
	dbPath, cleanup := setupTestEnv(t)
	defer cleanup()

	server := NewAPIServer("localhost:8080", dbPath, "")

	// Test Knowledge Resource Handler
	hKnowledge := server.handleReadKnowledgeResource()
	reqK := &mcp.ReadResourceRequest{
		Params: &mcp.ReadResourceParams{
			URI: "stratum://knowledge/agents/search",
		},
	}

	resK, err := hKnowledge(context.Background(), reqK)
	if err != nil {
		t.Fatalf("Knowledge resource read failed: %v", err)
	}
	if len(resK.Contents) == 0 {
		t.Fatalf("expected contents, got empty")
	}
	if !strings.Contains(resK.Contents[0].Text, "Search Agent") {
		t.Errorf("expected text to contain 'Search Agent', got %q", resK.Contents[0].Text)
	}
}

func TestNewMCPTools(t *testing.T) {
	dbPath, cleanup := setupTestEnv(t)
	defer cleanup()

	server := NewAPIServer("localhost:8080", dbPath, "")

	ctx := context.Background()

	// Test 1: create_project
	resCreate, createResult, err := server.handleCreateProjectMCP(ctx, nil, CreateProjectArgs{Name: "test-mcp-project"})
	if err != nil {
		t.Fatalf("create_project MCP tool failed: %v", err)
	}
	if createResult.Status != "success" || createResult.Name != "test-mcp-project" {
		t.Errorf("unexpected create_project result: %+v", createResult)
	}
	if resCreate == nil {
		t.Errorf("expected non-nil call tool result")
	}

	// Test 2: select_project
	resSelect, selectResult, err := server.handleSelectProjectMCP(ctx, nil, SelectProjectArgs{Project: "test-mcp-project"})
	if err != nil {
		t.Fatalf("select_project MCP tool failed: %v", err)
	}
	if selectResult.Status != "success" || selectResult.Active != "test-mcp-project" {
		t.Errorf("unexpected select_project result: %+v", selectResult)
	}
	if resSelect == nil {
		t.Errorf("expected non-nil call tool result")
	}
	if server.currentProject != "test-mcp-project" {
		t.Errorf("expected currentProject to be 'test-mcp-project', got %q", server.currentProject)
	}

	// Test 3: list_projects
	_, listResult, err := server.handleListProjectsMCP(ctx, nil, ListProjectsArgs{})
	if err != nil {
		t.Fatalf("list_projects MCP tool failed: %v", err)
	}
	found := false
	for _, p := range listResult.Projects {
		if p == "test-mcp-project" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected 'test-mcp-project' in projects list, got %v", listResult.Projects)
	}

	defer os.RemoveAll("projects/test-mcp-project")

	// Test 4: update_project_config
	_, updateResult, err := server.handleUpdateProjectConfigMCP(ctx, nil, UpdateProjectConfigArgs{
		Project:  "test-mcp-project",
		Keywords: "carbon nanotubes OR graphene",
		Topics:   []string{"T10001", "T10002"},
		Label:    "Initial MCP config",
	})
	if err != nil {
		t.Fatalf("update_project_config MCP tool failed: %v", err)
	}
	if updateResult.Status != "success" {
		t.Errorf("expected status 'success', got %q", updateResult.Status)
	}

	// Test 5: get_project_config (by default should hide keywords/topics)
	_, getResult, err := server.handleGetProjectConfigMCP(ctx, nil, GetProjectConfigArgs{Project: "test-mcp-project"})
	if err != nil {
		t.Fatalf("get_project_config MCP tool failed: %v", err)
	}
	if getResult.Keywords != "" {
		t.Errorf("expected keywords to be hidden by default, got %q", getResult.Keywords)
	}
	if getResult.Topics != "" {
		t.Errorf("expected topics to be hidden by default, got %q", getResult.Topics)
	}
	if getResult.KeywordsLen != len("carbon nanotubes OR graphene") {
		t.Errorf("expected KeywordsLen %d, got %d", len("carbon nanotubes OR graphene"), getResult.KeywordsLen)
	}

	// Test 6: get_project_config explicitly retrieving query and topics
	_, getResultFull, err := server.handleGetProjectConfigMCP(ctx, nil, GetProjectConfigArgs{
		Project:       "test-mcp-project",
		IncludeQuery:  true,
		IncludeTopics: true,
	})
	if err != nil {
		t.Fatalf("get_project_config full retrieval MCP tool failed: %v", err)
	}
	if getResultFull.Keywords != "carbon nanotubes OR graphene" {
		t.Errorf("expected keywords 'carbon nanotubes OR graphene', got %q", getResultFull.Keywords)
	}
	if getResultFull.Topics != "T10001\nT10002" {
		t.Errorf("expected topics 'T10001\\nT10002', got %q", getResultFull.Topics)
	}
}





