package api

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// =====================================================================
// Check DB Page: Native DuckDB Verification & Schema Validation
// =====================================================================

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
	_, _, _, dbBaseDir, _ := s.getProjectExportDirs(project)

	rawFile := r.URL.Query().Get("file")
	target := s.resolveDatabasePath(project, rawFile)

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
	sb.WriteString(fmt.Sprintf("│      with institution info          %s  %18s │\n", barStr(float64(top1Inst)/float64(t10Denom)*100, 20), fmt.Sprintf("%s (%4.1f%%)", formatNum(top1Inst), float64(top1Inst)/float64(t10Denom)*100)))
	sb.WriteString(fmt.Sprintf("│      with country info              %s  %18s │\n", barStr(float64(top1Country)/float64(t10Denom)*100, 20), fmt.Sprintf("%s (%4.1f%%)", formatNum(top1Country), float64(top1Country)/float64(t10Denom)*100)))
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
