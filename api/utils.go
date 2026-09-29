package api

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
)

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

func sanitizeProjectName(name string) string {
	reg := regexp.MustCompile(`[^a-zA-Z0-9_\-]`)
	return reg.ReplaceAllString(name, "")
}

func findPythonInterpreter() string {
	candidates := []string{
		"/run/media/krishnakumar/New Volume/IISC/openAlex_data_collection/.venv/bin/python",
		filepath.Join("..", "openAlex_data_collection", ".venv", "bin", "python"),
		"python3",
		"python",
	}
	for _, p := range candidates {
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			if abs, err := filepath.Abs(p); err == nil {
				return abs
			}
			return p
		}
	}
	return "python3"
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
