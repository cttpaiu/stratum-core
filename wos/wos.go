package wos

import (
	"bufio"
	"crypto/sha1"
	"database/sql"
	"encoding/csv"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"

	_ "github.com/duckdb/duckdb-go/v2"
	"github.com/xuri/excelize/v2"
	"github.com/adrg/strutil/metrics"
	"golang.org/x/text/runes"
	"golang.org/x/text/transform"
	"golang.org/x/text/unicode/norm"
)

// ComparisonReport provides metadata statistics on overlap between DuckDB papers and WoS papers.
type ComparisonReport struct {
	TotalWoS          int     `json:"total_wos"`
	TotalDB           int     `json:"total_db"`
	ExactDOIMatches   int     `json:"exact_doi_matches"`
	FuzzyTitleMatches int     `json:"fuzzy_title_matches"`
	OverlapPercent    float64 `json:"overlap_percent"`
}

// COUNTRY_FILE_TO_CODE maps country names (Excel/CSV filenames) to ISO-3166-1 alpha-2 codes.
var COUNTRY_FILE_TO_CODE = map[string]string{
	"Argentina":      "AR",
	"Australia":      "AU",
	"Austria":        "AT",
	"Belgium":        "BE",
	"Brazil":         "BR",
	"Canada":         "CA",
	"China":          "CN",
	"Czech Republic": "CZ",
	"Denmark":        "DK",
	"England":        "GB",
	"Finland":        "FI",
	"France":         "FR",
	"Germany":        "DE",
	"Hong Kong":      "HK",
	"India":          "IN",
	"Iran":           "IR",
	"Israel":         "IL",
	"Italy":          "IT",
	"Japan":          "JP",
	"Mexico":         "MX",
	"Netherlands":    "NL",
	"Norway":         "NO",
	"Poland":         "PL",
	"Russia":         "RU",
	"Saudi Arabia":   "SA",
	"Scotland":       "GB",
	"Singapore":      "SG",
	"South Africa":   "ZA",
	"South Korea":    "KR",
	"Spain":          "ES",
	"Sweden":         "SE",
	"Switzerland":    "CH",
	"Taiwan":         "TW",
	"Turkey":         "TR",
	"UAE":            "AE",
	"UK":             "GB",
	"US":             "US",
}

// NormalizeDOI strips URL prefixes, lowercases, and cleans DOI strings.
func NormalizeDOI(raw string) string {
	s := strings.TrimSpace(raw)
	s = strings.ToLower(s)
	for _, prefix := range []string{"https://doi.org/", "http://doi.org/", "doi:"} {
		if strings.HasPrefix(s, prefix) {
			s = s[len(prefix):]
			break
		}
	}
	return s
}

// NormalizeTitle performs aggressive normalization: strips diacritics, punctuation, lowercases, and collapses spaces.
func NormalizeTitle(raw string) string {
	if raw == "" {
		return ""
	}
	s := raw
	// NFKD normalization + strip diacritics
	t := transform.Chain(norm.NFKD, runes.Remove(runes.In(unicode.Mn)), norm.NFC)
	if normalized, _, err := transform.String(t, s); err == nil {
		s = normalized
	}
	s = strings.ToLower(s)

	// Remove punctuation: non-alphanumeric and non-space characters
	punctRE := regexp.MustCompile(`[^\pL\pN\s]+`)
	s = punctRE.ReplaceAllString(s, " ")

	// Collapse whitespace
	wsRE := regexp.MustCompile(`\s+`)
	s = wsRE.ReplaceAllString(s, " ")
	return strings.TrimSpace(s)
}

func countryCodeForFile(path string) string {
	filename := filepath.Base(path)
	stem := strings.TrimSuffix(filename, filepath.Ext(filename))
	code := COUNTRY_FILE_TO_CODE[stem]
	if code == "HK" {
		return "CN" // Normalize HK to CN
	}
	return code
}

func ensureWoSSchema(db *sql.DB) error {
	queries := []string{
		"ALTER TABLE papers ADD COLUMN IF NOT EXISTS from_wos BOOLEAN DEFAULT FALSE",
		"ALTER TABLE papers ADD COLUMN IF NOT EXISTS wos_accession_number VARCHAR",
		"ALTER TABLE contributions ADD COLUMN IF NOT EXISTS source VARCHAR DEFAULT 'openalex'",
		"UPDATE contributions SET source = 'openalex' WHERE source IS NULL",
	}
	for _, q := range queries {
		if _, err := db.Exec(q); err != nil {
			if !strings.Contains(err.Error(), "already exists") {
				return err
			}
		}
	}
	return nil
}

func readWoSCSV(csvPath string) ([]map[string]string, error) {
	file, err := os.Open(csvPath)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	// Read first line to detect separator
	bufReader := bufio.NewReader(file)
	firstLine, err := bufReader.ReadString('\n')
	if err != nil {
		return nil, err
	}
	file.Seek(0, 0) // reset file reader

	reader := csv.NewReader(file)
	if strings.Contains(firstLine, "\t") {
		reader.Comma = '\t'
	} else if strings.Contains(firstLine, ";") && !strings.Contains(firstLine, ",") {
		reader.Comma = ';'
	}
	reader.FieldsPerRecord = -1 // flexible fields count

	records, err := reader.ReadAll()
	if err != nil {
		return nil, err
	}

	if len(records) == 0 {
		return nil, nil
	}

	headers := records[0]
	var rows []map[string]string
	for i := 1; i < len(records); i++ {
		row := make(map[string]string)
		for j, val := range records[i] {
			if j < len(headers) {
				row[headers[j]] = val
			}
		}
		rows = append(rows, row)
	}
	return rows, nil
}

func readWoSExcel(excelPath string) ([]map[string]string, error) {
	f, err := excelize.OpenFile(excelPath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	sheets := f.GetSheetList()
	if len(sheets) == 0 {
		return nil, fmt.Errorf("no sheets found in %s", excelPath)
	}
	sheetName := sheets[0]

	rows, err := f.GetRows(sheetName)
	if err != nil {
		return nil, err
	}

	if len(rows) == 0 {
		return nil, nil
	}

	headers := rows[0]
	var records []map[string]string
	for i := 1; i < len(rows); i++ {
		row := make(map[string]string)
		for j, val := range rows[i] {
			if j < len(headers) {
				row[headers[j]] = val
			}
		}
		records = append(records, row)
	}
	return records, nil
}

func parseTimesCited(val string) int {
	if val == "" {
		return 0
	}
	var res int
	fmt.Sscanf(val, "%d", &res)
	return res
}

func parseBoolTop(val string) bool {
	val = strings.TrimSpace(val)
	if val == "" {
		return false
	}
	if val == "1" || strings.ToLower(val) == "true" {
		return true
	}
	return false
}

type PaperMatchInfo struct {
	ID              string
	NormalizedDOI   string
	NormalizedTitle string
	Year            int
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func importRecords(dbPath string, records []map[string]string, defaultCountryCode string) error {
	db, err := sql.Open("duckdb", dbPath)
	if err != nil {
		return err
	}
	defer db.Close()

	if err := ensureWoSSchema(db); err != nil {
		return err
	}

	rows, err := db.Query("SELECT id, doi, title, publication_year FROM papers")
	if err != nil {
		return err
	}
	defer rows.Close()

	dbDOIMap := make(map[string]string)
	dbTitleMap := make(map[string]PaperMatchInfo)
	var dbPapers []PaperMatchInfo

	for rows.Next() {
		var id, doi, title sql.NullString
		var year sql.NullInt32
		if err := rows.Scan(&id, &doi, &title, &year); err != nil {
			return err
		}

		info := PaperMatchInfo{
			ID: id.String,
		}
		if doi.Valid {
			info.NormalizedDOI = NormalizeDOI(doi.String)
			if info.NormalizedDOI != "" {
				dbDOIMap[info.NormalizedDOI] = id.String
			}
		}
		if title.Valid {
			info.NormalizedTitle = NormalizeTitle(title.String)
			if info.NormalizedTitle != "" {
				dbTitleMap[info.NormalizedTitle] = info
				if year.Valid {
					info.Year = int(year.Int32)
				}
				dbPapers = append(dbPapers, info)
			}
		}
	}

	// Get next country ID
	var maxCountryID int
	db.QueryRow("SELECT COALESCE(MAX(id), 0) FROM countries").Scan(&maxCountryID)

	ensureCountry := func(code string) string {
		if code == "" {
			return ""
		}
		norm := strings.ToUpper(strings.TrimSpace(code))
		if norm == "HK" {
			norm = "CN"
		}
		var exists int
		db.QueryRow("SELECT 1 FROM countries WHERE country_code = ? LIMIT 1", norm).Scan(&exists)
		if exists == 1 {
			return norm
		}
		maxCountryID++
		db.Exec("INSERT INTO countries (id, country_name, country_code, status) VALUES (?, ?, ?, 1) ON CONFLICT DO NOTHING", maxCountryID, "["+norm+"]", norm)
		return norm
	}

	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmtUpdate, err := tx.Prepare(`
		UPDATE papers
		SET is_top_1_percent = is_top_1_percent OR ?,
			is_top_10_percent = is_top_10_percent OR ?,
			from_wos = TRUE,
			wos_accession_number = COALESCE(wos_accession_number, ?)
		WHERE id = ?
	`)
	if err != nil {
		return err
	}
	defer stmtUpdate.Close()

	stmtInsert, err := tx.Prepare(`
		INSERT INTO papers (
			id, doi, title, publication_year, type, journal_name,
			cited_by_count, is_top_1_percent, is_top_10_percent,
			from_wos, wos_accession_number
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE, ?)
		ON CONFLICT DO NOTHING
	`)
	if err != nil {
		return err
	}
	defer stmtInsert.Close()

	stmtContribCheck, err := tx.Prepare(`
		SELECT 1 FROM contributions
		WHERE paper_id = ? AND country_code = ? AND source = 'wos'
		LIMIT 1
	`)
	if err != nil {
		return err
	}
	defer stmtContribCheck.Close()

	stmtContribInsert, err := tx.Prepare(`
		INSERT INTO contributions (
			row_id, paper_id, author_id, institution_id, country_code,
			author_name, author_position, is_corresponding,
			raw_affiliation_string, source
		) VALUES (nextval('seq_contrib'), ?, NULL, NULL, ?, NULL, NULL, FALSE, NULL, 'wos')
	`)
	if err != nil {
		return err
	}
	defer stmtContribInsert.Close()

	jw := metrics.NewJaroWinkler()

	for _, rec := range records {
		doiRaw := rec["DOI"]
		titleRaw := rec["Article Title"]
		accession := rec["Accession Number"]
		source := rec["Source"]
		docType := rec["Document Type"]

		doi := NormalizeDOI(doiRaw)
		title := NormalizeTitle(titleRaw)

		var year int
		if yrStr := rec["Publication Date"]; yrStr != "" {
			// Date could be like 2021-12-31, extract first 4 chars
			if len(yrStr) >= 4 {
				fmt.Sscanf(yrStr[:4], "%d", &year)
			}
		}

		timesCited := parseTimesCited(rec["Times Cited"])
		top1 := parseBoolTop(rec["Top 1%"])
		top10 := parseBoolTop(rec["Top 10%"])

		if doi == "" && title == "" {
			continue
		}

		var paperID string
		matched := false

		// 1. DOI Match
		if doi != "" {
			if pid, ok := dbDOIMap[doi]; ok {
				paperID = pid
				matched = true
			}
		}

		// 2. Title Exact Match
		if !matched && title != "" {
			if hit, ok := dbTitleMap[title]; ok {
				paperID = hit.ID
				matched = true
			}
		}

		// 3. Title Fuzzy Match
		if !matched && title != "" && len(title) >= 30 {
			bestScore := 0.0
			var bestPaper PaperMatchInfo
			for _, dbPaper := range dbPapers {
				if year > 0 && dbPaper.Year > 0 && abs(year-dbPaper.Year) > 2 {
					continue
				}
				qLen := len(title)
				mLen := len(dbPaper.NormalizedTitle)
				lenRatio := float64(min(qLen, mLen)) / float64(max(qLen, mLen))
				if lenRatio < 0.6 {
					continue
				}

				score := jw.Compare(title, dbPaper.NormalizedTitle)
				if score > bestScore {
					bestScore = score
					bestPaper = dbPaper
				}
			}

			if bestScore >= 0.95 {
				paperID = bestPaper.ID
				matched = true
				dbTitleMap[title] = bestPaper // cache it
			}
		}

		if matched {
			var accVal interface{} = nil
			if accession != "" {
				accVal = accession
			}
			if _, err := stmtUpdate.Exec(top1, top10, accVal, paperID); err != nil {
				return err
			}
		} else {
			if accession != "" {
				suffix := strings.TrimSpace(strings.ReplaceAll(accession, "WOS:", ""))
				paperID = "WOS_" + suffix
			} else {
				h := sha1.New()
				h.Write([]byte(strings.ToLower(titleRaw)))
				paperID = fmt.Sprintf("WOS_T%x", h.Sum(nil))[:16]
			}

			var doiVal interface{} = nil
			if doiRaw != "" {
				doiVal = doiRaw
			}
			var accVal interface{} = nil
			if accession != "" {
				accVal = accession
			}

			_, err := stmtInsert.Exec(
				paperID,
				doiVal,
				titleRaw,
				year,
				docType,
				source,
				timesCited,
				top1,
				top10,
				accVal,
			)
			if err != nil {
				return err
			}

			// Add to local cache
			if doi != "" {
				dbDOIMap[doi] = paperID
			}
			if title != "" {
				dbTitleMap[title] = PaperMatchInfo{
					ID:              paperID,
					NormalizedDOI:   doi,
					NormalizedTitle: title,
					Year:            year,
				}
				dbPapers = append(dbPapers, dbTitleMap[title])
			}
		}

		cc := ensureCountry(defaultCountryCode)
		if cc != "" {
			var exists int
			stmtContribCheck.QueryRow(paperID, cc).Scan(&exists)
			if exists != 1 {
				if _, err := stmtContribInsert.Exec(paperID, cc); err != nil {
					return err
				}
			}
		}
	}

	return tx.Commit()
}

// ImportWoSCSV loads Web of Science CSV datasets, mapping and loading relevant records.
func ImportWoSCSV(csvPath string, dbPath string) error {
	records, err := readWoSCSV(csvPath)
	if err != nil {
		return err
	}
	cc := countryCodeForFile(csvPath)
	return importRecords(dbPath, records, cc)
}

// ImportWoSExcel reads Web of Science Excel exports (.xlsx) and streams records into the database.
func ImportWoSExcel(excelPath string, dbPath string) error {
	records, err := readWoSExcel(excelPath)
	if err != nil {
		return err
	}
	cc := countryCodeForFile(excelPath)
	return importRecords(dbPath, records, cc)
}

// ReadWoSRecords reads Web of Science records from a CSV or Excel file.
func ReadWoSRecords(filePath string) ([]map[string]string, error) {
	if strings.HasSuffix(strings.ToLower(filePath), ".xlsx") {
		return readWoSExcel(filePath)
	}
	return readWoSCSV(filePath)
}

// CompareDOIs queries the DuckDB database to check which DOIs (and fuzzy matched titles) from the WoS file overlap.
func CompareDOIs(wosCSVPath string, dbPath string) (*ComparisonReport, error) {
	wosRows, err := ReadWoSRecords(wosCSVPath)
	if err != nil {
		return nil, err
	}

	db, err := sql.Open("duckdb", dbPath)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	rows, err := db.Query("SELECT id, doi, title, publication_year FROM papers")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	dbDOIMap := make(map[string]string)
	dbTitleMap := make(map[string]PaperMatchInfo)
	var dbPapers []PaperMatchInfo
	totalDB := 0

	for rows.Next() {
		totalDB++
		var id, doi, title sql.NullString
		var year sql.NullInt32
		if err := rows.Scan(&id, &doi, &title, &year); err != nil {
			return nil, err
		}

		info := PaperMatchInfo{
			ID: id.String,
		}
		if doi.Valid {
			info.NormalizedDOI = NormalizeDOI(doi.String)
			if info.NormalizedDOI != "" {
				dbDOIMap[info.NormalizedDOI] = id.String
			}
		}
		if title.Valid {
			info.NormalizedTitle = NormalizeTitle(title.String)
			if info.NormalizedTitle != "" {
				dbTitleMap[info.NormalizedTitle] = info
				if year.Valid {
					info.Year = int(year.Int32)
				}
				dbPapers = append(dbPapers, info)
			}
		}
	}

	exactMatches := 0
	fuzzyMatches := 0
	totalWoS := len(wosRows)

	jw := metrics.NewJaroWinkler()

	for _, row := range wosRows {
		doi := NormalizeDOI(row["DOI"])
		title := NormalizeTitle(row["Article Title"])
		var year int
		if yrStr := row["Publication Date"]; yrStr != "" {
			if len(yrStr) >= 4 {
				fmt.Sscanf(yrStr[:4], "%d", &year)
			}
		}

		matched := false

		// 1. DOI Match
		if doi != "" {
			if _, ok := dbDOIMap[doi]; ok {
				exactMatches++
				matched = true
			}
		}

		if matched {
			continue
		}

		// 2. Title Exact Match
		if title != "" {
			if _, ok := dbTitleMap[title]; ok {
				fuzzyMatches++
				matched = true
			}
		}

		if matched {
			continue
		}

		// 3. Title Fuzzy Match
		if title != "" && len(title) >= 30 {
			bestScore := 0.0
			var bestPaper PaperMatchInfo
			for _, dbPaper := range dbPapers {
				if year > 0 && dbPaper.Year > 0 && abs(year-dbPaper.Year) > 2 {
					continue
				}
				qLen := len(title)
				mLen := len(dbPaper.NormalizedTitle)
				lenRatio := float64(min(qLen, mLen)) / float64(max(qLen, mLen))
				if lenRatio < 0.6 {
					continue
				}

				score := jw.Compare(title, dbPaper.NormalizedTitle)
				if score > bestScore {
					bestScore = score
					bestPaper = dbPaper
				}
			}

			if bestScore >= 0.95 {
				fuzzyMatches++
				matched = true
				dbTitleMap[title] = bestPaper
			}
		}
	}

	overlapPercent := 0.0
	if totalWoS > 0 {
		overlapPercent = float64(exactMatches+fuzzyMatches) / float64(totalWoS) * 100.0
	}

	return &ComparisonReport{
		TotalWoS:          totalWoS,
		TotalDB:           totalDB,
		ExactDOIMatches:   exactMatches,
		FuzzyTitleMatches: fuzzyMatches,
		OverlapPercent:    overlapPercent,
	}, nil
}
