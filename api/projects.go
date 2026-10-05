package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"stratum/config"
)

// =====================================================================
// Projects & Workspace Management Handlers
// =====================================================================

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
