package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

type GraphItem struct {
	Rank               int64   `json:"rank"`
	CountryCode        string  `json:"country_code"`
	PaperCount         int64   `json:"paper_count,omitempty"`
	TotalContributions int64   `json:"total_contributions,omitempty"`
	Top1PctPapers      int64   `json:"top_1pct_papers,omitempty"`
	Top1PctRate        float64 `json:"top_1pct_rate,omitempty"`
	SharePct           float64 `json:"share_pct"`
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
	rawFile := r.URL.Query().Get("file")
	if rawFile == "" {
		rawFile = r.URL.Query().Get("db")
	}

	dbMgr, err := s.getDBMgrForFile(project, rawFile)
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

func (s *APIServer) handleCountryRankings(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	project := r.URL.Query().Get("project")
	fileParam := r.URL.Query().Get("file")
	if fileParam == "" {
		fileParam = r.URL.Query().Get("db")
	}

	dbMgr, err := s.getDBMgrForFile(project, fileParam)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	limitStr := r.URL.Query().Get("limit")
	limit := 15
	if limitStr != "" {
		if val, err := strconv.Atoi(limitStr); err == nil && val > 0 && val <= 100 {
			limit = val
		}
	}

	tier := strings.ToLower(r.URL.Query().Get("tier"))
	if tier == "" {
		tier = strings.ToLower(r.URL.Query().Get("metric"))
	}
	isTop1Pct := tier == "top1pct" || tier == "top_1pct" || tier == "top1" || strings.ToLower(r.URL.Query().Get("top1pct")) == "true"

	var sqlQuery string
	if isTop1Pct {
		sqlQuery = fmt.Sprintf(`SELECT 
		ROW_NUMBER() OVER (ORDER BY COUNT(DISTINCT CASE WHEN p.is_top_1_percent = TRUE THEN c.paper_id END) DESC) AS rank,
		c.country_code,
		COUNT(DISTINCT CASE WHEN p.is_top_1_percent = TRUE THEN c.paper_id END) AS top_1pct_papers,
		COUNT(DISTINCT c.paper_id) AS total_papers,
		ROUND(COUNT(DISTINCT CASE WHEN p.is_top_1_percent = TRUE THEN c.paper_id END) * 100.0 / NULLIF(COUNT(DISTINCT c.paper_id), 0), 2) AS top_1pct_rate,
		ROUND(COUNT(DISTINCT CASE WHEN p.is_top_1_percent = TRUE THEN c.paper_id END) * 100.0 / NULLIF((SELECT COUNT(*) FROM papers WHERE is_top_1_percent = TRUE), 0), 2) AS share_pct
	FROM contributions c
	JOIN papers p ON c.paper_id = p.id
	WHERE c.country_code IS NOT NULL AND TRIM(c.country_code) != ''
	GROUP BY c.country_code
	HAVING top_1pct_papers > 0
	ORDER BY top_1pct_papers DESC
	LIMIT %d;`, limit)
	} else {
		sqlQuery = fmt.Sprintf(`SELECT 
		ROW_NUMBER() OVER (ORDER BY COUNT(DISTINCT paper_id) DESC) AS rank,
		country_code,
		COUNT(DISTINCT paper_id) AS paper_count,
		COUNT(*) AS total_contributions,
		ROUND(COUNT(DISTINCT paper_id) * 100.0 / NULLIF(SUM(COUNT(DISTINCT paper_id)) OVER (), 0), 2) AS share_pct
	FROM contributions c
	WHERE country_code IS NOT NULL AND TRIM(country_code) != ''
	GROUP BY country_code
	ORDER BY rank ASC
	LIMIT %d;`, limit)
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

	graphItems := make([]GraphItem, 0, len(results))
	for _, row := range results {
		var item GraphItem
		if v, ok := row["country_code"].(string); ok {
			item.CountryCode = v
		}
		if v, ok := row["rank"]; ok {
			item.Rank = toInt64(v)
		}
		if v, ok := row["paper_count"]; ok {
			item.PaperCount = toInt64(v)
		}
		if v, ok := row["total_contributions"]; ok {
			item.TotalContributions = toInt64(v)
		}
		if v, ok := row["top_1pct_papers"]; ok {
			item.Top1PctPapers = toInt64(v)
		}
		if v, ok := row["top_1pct_rate"]; ok {
			item.Top1PctRate = toFloat64(v)
		}
		if v, ok := row["total_papers"]; ok {
			if item.PaperCount == 0 {
				item.PaperCount = toInt64(v)
			}
		}
		if v, ok := row["share_pct"]; ok {
			item.SharePct = toFloat64(v)
		}
		graphItems = append(graphItems, item)
	}

	xAxisMetric := "paper_count"
	if isTop1Pct {
		xAxisMetric = "top_1pct_papers"
	}

	resp := map[string]interface{}{
		"rankings": graphItems,
		"query":    sqlQuery,
		"graph": map[string]interface{}{
			"chart_type": "bar",
			"x_axis":     "country_code",
			"y_axis":     xAxisMetric,
			"items":      graphItems,
		},
	}

	json.NewEncoder(w).Encode(resp)
}

func toInt64(val interface{}) int64 {
	switch v := val.(type) {
	case int64:
		return v
	case int:
		return int64(v)
	case int32:
		return int64(v)
	case float64:
		return int64(v)
	case float32:
		return int64(v)
	default:
		return 0
	}
}

func toFloat64(val interface{}) float64 {
	switch v := val.(type) {
	case float64:
		return v
	case float32:
		return float64(v)
	case int64:
		return float64(v)
	case int:
		return float64(v)
	default:
		return 0
	}
}
