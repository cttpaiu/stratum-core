package openalex

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"stratum/config"
)

// OpenAlexClient wraps the http client, handling concurrent requests, rate-limiting, and error retries.
type OpenAlexClient struct {
	apiKeys            []string
	email              string
	perPage            int
	concurrentRequests int
	maxRetries         int
	retryDelay         int

	baseURL    string
	httpClient *http.Client
	semaphore  chan struct{}
	poolMutex  sync.Mutex
	keyStates  []string
	keyUsage   []int
	keyCursor  int
}

// Work represents a parsed OpenAlex Work object with essential metadata fields.
type Work struct {
	ID                        string            `json:"id"`
	DOI                       string            `json:"doi"`
	Title                     string            `json:"title"`
	PublicationYear           int               `json:"publication_year"`
	PublicationDate           string            `json:"publication_date"`
	Type                      string            `json:"type"`
	PrimaryLocation           Location          `json:"primary_location"`
	OpenAccess                OpenAccessInfo    `json:"open_access"`
	CitedByCount              int               `json:"cited_by_count"`
	CitationPercentile        PercentileInfo    `json:"citation_normalized_percentile"`
	FWCI                      float64           `json:"fwci"`
	PrimaryTopic              TopicInfo         `json:"primary_topic"`
	Topics                    []TopicInfo       `json:"topics"`
	InstitutionsDistinctCount int               `json:"institutions_distinct_count"`
	CountriesDistinctCount    int               `json:"countries_distinct_count"`
	AbstractInvertedIndex     map[string][]int  `json:"abstract_inverted_index"`
	UpdatedDate               string            `json:"updated_date"`
	Authorships               []AuthorshipInfo  `json:"authorships"`
}

// Location represents primary source and publisher details.
type Location struct {
	Source SourceInfo `json:"source"`
}

type SourceInfo struct {
	DisplayName      string `json:"display_name"`
	ISSN             string `json:"issn_l"`
	IsCore           bool   `json:"is_core"`
	HostOrganization string `json:"host_organization_name"`
}

type OpenAccessInfo struct {
	IsOA     bool   `json:"is_oa"`
	OAStatus string `json:"oa_status"`
	OAURL    string `json:"oa_url"`
}

type PercentileInfo struct {
	Value        float64 `json:"value"`
	IsInTop1Pct  bool    `json:"is_in_top_1_percent"`
	IsInTop10Pct bool    `json:"is_in_top_10_percent"`
}

type TopicInfo struct {
	ID          string   `json:"id"`
	DisplayName string   `json:"display_name"`
	Score       float64  `json:"score"`
	Subfield    SubTopic `json:"subfield"`
	Field       SubTopic `json:"field"`
	Domain      SubTopic `json:"domain"`
}

type SubTopic struct {
	DisplayName string `json:"display_name"`
}

type AuthorshipInfo struct {
	Author               AuthorDetail `json:"author"`
	Institutions         []InstDetail `json:"institutions"`
	RawAffiliationString []string     `json:"raw_affiliation_strings"`
	RawAuthorName        string       `json:"raw_author_name"`
	AuthorPosition       string       `json:"author_position"`
	IsCorresponding      bool         `json:"is_corresponding"`
	Countries            []string     `json:"countries"`
}

type AuthorDetail struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name"`
	ORCID       string `json:"orcid"`
}

type InstDetail struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name"`
	CountryCode string `json:"country_code"`
	Type        string `json:"type"`
	ROR         string `json:"ror"`
}

// WorkPageResponse wraps metadata and results from a paginated API request.
type WorkPageResponse struct {
	Meta    MetaResponse `json:"meta"`
	Results []Work       `json:"results"`
}

// RawPageResponse wraps metadata and results as raw JSON messages to fetch full paper records.
type RawPageResponse struct {
	Meta    MetaResponse      `json:"meta"`
	Results []json.RawMessage `json:"results"`
}

type MetaResponse struct {
	Count      int    `json:"count"`
	NextCursor string `json:"next_cursor"`
}

// NewClient initializes a new OpenAlexClient.
func NewClient(apiKeys []string, email string, perPage int, concurrentRequests int, maxRetries int, retryDelay int) *OpenAlexClient {
	if perPage <= 0 {
		perPage = 200
	}
	if concurrentRequests <= 0 {
		concurrentRequests = 10
	}
	if maxRetries <= 0 {
		maxRetries = 5
	}
	if retryDelay <= 0 {
		retryDelay = 2
	}
	keyStates := make([]string, len(apiKeys))
	for i := range keyStates {
		keyStates[i] = "active"
	}
	return &OpenAlexClient{
		apiKeys:            apiKeys,
		email:              email,
		perPage:            perPage,
		concurrentRequests: concurrentRequests,
		maxRetries:         maxRetries,
		retryDelay:         retryDelay,
		baseURL:            "https://api.openalex.org",
		httpClient:         &http.Client{Timeout: 60 * time.Second},
		semaphore:          make(chan struct{}, concurrentRequests),
		keyStates:          keyStates,
		keyUsage:           make([]int, len(apiKeys)),
	}
}

func (c *OpenAlexClient) acquireKey() (int, string) {
	c.poolMutex.Lock()
	defer c.poolMutex.Unlock()

	n := len(c.apiKeys)
	if n == 0 {
		return -1, ""
	}
	for offset := 0; offset < n; offset++ {
		i := (c.keyCursor + offset) % n
		if c.keyStates[i] == "active" {
			c.keyCursor = (i + 1) % n
			c.keyUsage[i]++
			return i, c.apiKeys[i]
		}
	}
	return -1, ""
}

func (c *OpenAlexClient) markKey(idx int, state string) bool {
	c.poolMutex.Lock()
	defer c.poolMutex.Unlock()

	if idx < 0 || idx >= len(c.apiKeys) {
		return false
	}
	if c.keyStates[idx] != "active" {
		return false
	}
	c.keyStates[idx] = state
	return true
}

func (c *OpenAlexClient) hasActiveKey() bool {
	c.poolMutex.Lock()
	defer c.poolMutex.Unlock()

	for _, s := range c.keyStates {
		if s == "active" {
			return true
		}
	}
	return len(c.apiKeys) == 0
}

func (c *OpenAlexClient) doRequest(ctx context.Context, req *http.Request) ([]byte, error) {
	var lastBody []byte
	var lastErr error

	for attempt := 0; attempt < c.maxRetries; attempt++ {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}

		idx, key := c.acquireKey()
		if idx == -1 && len(c.apiKeys) > 0 && !c.hasActiveKey() {
			return nil, fmt.Errorf("all API keys exhausted or rejected")
		}

		currReq := req.Clone(ctx)
		currReq.Header.Set("User-Agent", "mailto:"+c.email)
		if key != "" {
			q := currReq.URL.Query()
			q.Set("api_key", key)
			currReq.URL.RawQuery = q.Encode()
		}

		resp, err := c.httpClient.Do(currReq)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			lastErr = err
			if attempt < c.maxRetries-1 {
				select {
				case <-time.After(time.Duration(c.retryDelay) * time.Second):
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			}
			continue
		}

		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			lastErr = err
			if attempt < c.maxRetries-1 {
				select {
				case <-time.After(time.Duration(c.retryDelay) * time.Second):
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			}
			continue
		}

		lastBody = body

		contentType := resp.Header.Get("Content-Type")
		if !strings.Contains(strings.ToLower(contentType), "json") {
			snippet := string(body)
			if len(snippet) > 200 {
				snippet = snippet[:200]
			}
			return nil, fmt.Errorf("non-JSON response (HTTP %d, Content-Type=%s): %s", resp.StatusCode, contentType, snippet)
		}

		var apiErr struct {
			Error   string `json:"error"`
			Message string `json:"message"`
		}
		json.Unmarshal(body, &apiErr)

		isBudget := strings.Contains(apiErr.Message, "Insufficient budget") || strings.Contains(apiErr.Error, "Insufficient budget")
		isForbidden := resp.StatusCode == 403

		if isBudget && idx != -1 {
			c.markKey(idx, "exhausted")
			continue
		}
		if isForbidden && idx != -1 {
			c.markKey(idx, "rejected")
			continue
		}

		if resp.StatusCode == 429 {
			backoff := time.Duration(c.retryDelay) * time.Duration(1<<attempt) * time.Second
			time.Sleep(backoff)
			continue
		}

		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			lastErr = fmt.Errorf("HTTP error %d: %s", resp.StatusCode, string(body))
			if attempt < c.maxRetries-1 {
				time.Sleep(time.Duration(c.retryDelay) * time.Second)
			}
			continue
		}

		return body, nil
	}

	if len(c.apiKeys) > 0 && !c.hasActiveKey() {
		return nil, fmt.Errorf("all API keys exhausted or rejected")
	}
	if lastErr != nil {
		return nil, fmt.Errorf("request failed after %d attempts: %w", c.maxRetries, lastErr)
	}
	return nil, fmt.Errorf("request failed after %d attempts: body=%s", c.maxRetries, string(lastBody))
}

// GetTotalCount returns the estimated total number of works matching the API filter query.
func (c *OpenAlexClient) GetTotalCount(ctx context.Context, apiFilter string) (int, error) {
	baseURL := c.baseURL
	if baseURL == "" {
		baseURL = "https://api.openalex.org"
	}
	u, err := url.Parse(baseURL + "/works")
	if err != nil {
		return 0, err
	}
	q := u.Query()
	q.Set("filter", apiFilter)
	q.Set("per_page", "1")
	u.RawQuery = q.Encode()

	req, err := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
	if err != nil {
		return 0, err
	}

	select {
	case c.semaphore <- struct{}{}:
	case <-ctx.Done():
		return 0, ctx.Err()
	}
	defer func() { <-c.semaphore }()

	body, err := c.doRequest(ctx, req)
	if err != nil {
		return 0, err
	}

	var resp WorkPageResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return 0, err
	}

	return resp.Meta.Count, nil
}

// FetchPage retrieves a single page of results for a given filter and cursor.
func (c *OpenAlexClient) FetchPage(ctx context.Context, apiFilter string, cursor string) (*WorkPageResponse, error) {
	baseURL := c.baseURL
	if baseURL == "" {
		baseURL = "https://api.openalex.org"
	}
	u, err := url.Parse(baseURL + "/works")
	if err != nil {
		return nil, err
	}
	q := u.Query()
	q.Set("filter", apiFilter)
	q.Set("per_page", fmt.Sprintf("%d", c.perPage))
	q.Set("cursor", cursor)
	q.Set("select", "id,doi,title,publication_year,publication_date,type,primary_location,open_access,cited_by_count,citation_normalized_percentile,fwci,primary_topic,topics,authorships,institutions_distinct_count,countries_distinct_count,updated_date,abstract_inverted_index")
	u.RawQuery = q.Encode()

	req, err := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
	if err != nil {
		return nil, err
	}

	select {
	case c.semaphore <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-c.semaphore }()

	body, err := c.doRequest(ctx, req)
	if err != nil {
		return nil, err
	}

	var resp WorkPageResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, err
	}

	return &resp, nil
}

// FetchPageRaw retrieves a single page of results for a given filter and cursor, returning the raw JSON response body.
func (c *OpenAlexClient) FetchPageRaw(ctx context.Context, apiFilter string, cursor string) ([]byte, error) {
	baseURL := c.baseURL
	if baseURL == "" {
		baseURL = "https://api.openalex.org"
	}
	u, err := url.Parse(baseURL + "/works")
	if err != nil {
		return nil, err
	}
	q := u.Query()
	q.Set("filter", apiFilter)
	q.Set("per_page", fmt.Sprintf("%d", c.perPage))
	q.Set("cursor", cursor)
	// We omit the 'select' query parameter to download the full records
	u.RawQuery = q.Encode()

	req, err := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
	if err != nil {
		return nil, err
	}

	select {
	case c.semaphore <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-c.semaphore }()

	return c.doRequest(ctx, req)
}

// FetchSamplePage retrieves a single page of random results for a given filter using the OpenAlex sample and seed parameters.
func (c *OpenAlexClient) FetchSamplePage(ctx context.Context, apiFilter string, limit int, seed int) (*WorkPageResponse, error) {
	baseURL := c.baseURL
	if baseURL == "" {
		baseURL = "https://api.openalex.org"
	}
	u, err := url.Parse(baseURL + "/works")
	if err != nil {
		return nil, err
	}
	q := u.Query()
	q.Set("filter", apiFilter)
	q.Set("sample", fmt.Sprintf("%d", limit))
	q.Set("seed", fmt.Sprintf("%d", seed))
	q.Set("select", "id,doi,title,publication_year,publication_date,type,primary_location,open_access,cited_by_count,citation_normalized_percentile,fwci,primary_topic,authorships,institutions_distinct_count,countries_distinct_count,updated_date,abstract_inverted_index")
	u.RawQuery = q.Encode()

	req, err := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
	if err != nil {
		return nil, err
	}

	select {
	case c.semaphore <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-c.semaphore }()

	body, err := c.doRequest(ctx, req)
	if err != nil {
		return nil, err
	}

	var resp WorkPageResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, err
	}

	return &resp, nil
}

// FetchSample fetches and deduplicates up to k random matching papers from OpenAlex.
// It performs multiple page fetches with incremented seeds if k > 200.
// If seed <= 0, a random seed is automatically generated.
func (c *OpenAlexClient) FetchSample(ctx context.Context, apiFilter string, k int, seed int) ([]Work, error) {
	if seed <= 0 {
		seed = int(time.Now().UnixNano() % 2147483647)
		if seed < 0 {
			seed = -seed
		}
	}

	var results []Work
	seen := make(map[string]bool)
	limitPerPage := 200

	page := 0
	for len(results) < k {
		limit := k - len(results)
		if limit > limitPerPage {
			limit = limitPerPage
		}

		currentSeed := seed + page
		page++

		resp, err := c.FetchSamplePage(ctx, apiFilter, limit, currentSeed)
		if err != nil {
			return nil, err
		}

		if resp == nil || len(resp.Results) == 0 {
			break
		}

		newAdded := 0
		for _, w := range resp.Results {
			if !seen[w.ID] {
				seen[w.ID] = true
				results = append(results, w)
				newAdded++
			}
		}

		// If no new works were added in this batch, avoid infinite loop if results are fully exhausted
		if newAdded == 0 && len(resp.Results) < limit {
			break
		}
	}

	if len(results) > k {
		results = results[:k]
	}

	return results, nil
}

type DownloadProgress struct {
	Batches map[string]*BatchProgress `json:"batches"`
}

type BatchProgress struct {
	LastCursor *string  `json:"last_cursor"`
	Done       bool     `json:"done"`
	Topics     []string `json:"topics"`
}

func saveProgress(path string, state *DownloadProgress) error {
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	tmpPath := path + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0644); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}

type SafeWriter struct {
	file   *os.File
	writer *bufio.Writer
	mutex  sync.Mutex
}

func NewSafeWriter(file *os.File) *SafeWriter {
	return &SafeWriter{
		file:   file,
		writer: bufio.NewWriter(file),
	}
}

func (w *SafeWriter) WriteLine(line []byte) error {
	w.mutex.Lock()
	defer w.mutex.Unlock()
	if _, err := w.writer.Write(append(line, '\n')); err != nil {
		return err
	}
	return nil
}

func (w *SafeWriter) Flush() error {
	w.mutex.Lock()
	defer w.mutex.Unlock()
	return w.writer.Flush()
}

func buildFilter(keywords string, topics []string, dateFrom string, dateTo string, docTypes []string) string {
	parts := []string{"title_and_abstract.search:" + keywords}
	if len(topics) > 0 {
		parts = append(parts, "primary_topic.id:"+strings.Join(topics, "|"))
	}
	if dateFrom != "" {
		parts = append(parts, "from_publication_date:"+dateFrom)
	}
	if dateTo != "" {
		parts = append(parts, "to_publication_date:"+dateTo)
	}
	if len(docTypes) > 0 {
		parts = append(parts, "type:"+strings.Join(docTypes, "|"))
	}
	return strings.Join(parts, ",")
}

// BuildFilter builds an OpenAlex API filter string matching openalex CLI conventions.
func BuildFilter(keywords string, topics []string, dateFrom string, dateTo string, docTypes []string) string {
	return buildFilter(keywords, topics, dateFrom, dateTo, docTypes)
}

// DownloadOptions customizes paper downloading behavior to match openalex download command.
type DownloadOptions struct {
	NoTopics        bool
	Deduplicate     bool
	BatchSizeTopics int
	TotalExpected   int
}

// DownloadStats reports counts, sizes, and duration of the download run.
type DownloadStats struct {
	TotalExpected     int           `json:"total_expected"`
	Collected         int64         `json:"collected"`
	NewPapers         int64         `json:"new_papers"`
	ExistingPapers    int64         `json:"existing_papers"`
	DuplicatesSkipped int64         `json:"duplicates_skipped"`
	OutputJSONL       string        `json:"output_jsonl"`
	FileSize          int64         `json:"file_size"`
	Duration          time.Duration `json:"duration"`
}

// DownloadPapers initiates concurrent download tasks and writes matching works to a JSONL file.
// It supports resuming from a cursor progress file.
func (c *OpenAlexClient) DownloadPapers(ctx context.Context, cfg *config.AppConfig, outputJSONL string, progressChan chan<- int) error {
	_, err := c.DownloadPapersWithOptions(ctx, cfg, outputJSONL, DownloadOptions{
		Deduplicate: false,
	}, progressChan, nil)
	return err
}

// DownloadPapersWithOptions runs async JSONL download following openalex download CLI functionality.
// It supports pre-flight logging, topics filtering toggle (--no-topics), deduplication, and resume tracking.
func (c *OpenAlexClient) DownloadPapersWithOptions(
	ctx context.Context,
	cfg *config.AppConfig,
	outputJSONL string,
	opts DownloadOptions,
	progressChan chan<- int,
	logChan chan<- string,
) (*DownloadStats, error) {
	startTime := time.Now()
	keywords := cfg.Keywords

	errors := ValidateKeywords(keywords)
	if len(errors) > 0 {
		return nil, fmt.Errorf("keyword validation failed: %s", strings.Join(errors, "; "))
	}

	var topics []string
	if !opts.NoTopics {
		for _, tp := range cfg.Topics {
			if ValidateTopicFormat(tp) {
				topics = append(topics, tp)
			}
		}
	}

	progressPath := outputJSONL + ".download_progress.json"
	var progressState DownloadProgress
	progressState.Batches = make(map[string]*BatchProgress)

	if data, err := os.ReadFile(progressPath); err == nil {
		json.Unmarshal(data, &progressState)
	}

	var resumeCount int
	seenIDs := make(map[string]struct{})
	var seenMu sync.Mutex

	if file, err := os.Open(outputJSONL); err == nil {
		scanner := bufio.NewScanner(file)
		buf := make([]byte, 1024*1024)
		scanner.Buffer(buf, 10*1024*1024)
		for scanner.Scan() {
			txt := strings.TrimSpace(scanner.Text())
			if txt != "" {
				resumeCount++
				if opts.Deduplicate {
					var idObj struct {
						ID string `json:"id"`
					}
					if json.Unmarshal([]byte(txt), &idObj) == nil && idObj.ID != "" {
						seenIDs[idObj.ID] = struct{}{}
					}
				}
			}
		}
		file.Close()
	}

	if opts.Deduplicate && len(seenIDs) > 0 {
		resumeCount = len(seenIDs)
	}

	var collectedCount int64 = int64(resumeCount)
	var newPapersCount int64 = 0
	var duplicatesSkipped int64 = 0

	if progressChan != nil {
		select {
		case progressChan <- int(collectedCount):
		default:
		}
	}

	if logChan != nil && resumeCount > 0 {
		logChan <- fmt.Sprintf("[INFO] Found %d existing papers in output file. Resuming from saved cursors.", resumeCount)
	}

	// Open file for appending
	f, err := os.OpenFile(outputJSONL, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	writer := NewSafeWriter(f)
	defer writer.Flush()

	var batches [][]string
	batchSize := opts.BatchSizeTopics
	if batchSize <= 0 {
		batchSize = cfg.Collection.BatchSizeTopics
	}
	if batchSize <= 0 {
		batchSize = 55
	}

	if len(topics) > 0 {
		for i := 0; i < len(topics); i += batchSize {
			end := i + batchSize
			if end > len(topics) {
				end = len(topics)
			}
			batches = append(batches, topics[i:end])
		}
	} else {
		batches = append(batches, nil)
	}

	sem := make(chan struct{}, c.concurrentRequests)
	var wg sync.WaitGroup
	var downloadErr error
	var errOnce sync.Once
	var progressMutex sync.Mutex

	for i, batch := range batches {
		batchIdx := i
		batchData := batch

		wg.Add(1)
		go func() {
			defer wg.Done()

			select {
			case <-ctx.Done():
				return
			case sem <- struct{}{}:
				defer func() { <-sem }()
			}

			err := c.processBatch(
				ctx,
				cfg,
				batchData,
				batchIdx,
				keywords,
				topics,
				writer,
				&progressState,
				&progressMutex,
				progressPath,
				&collectedCount,
				&newPapersCount,
				&duplicatesSkipped,
				seenIDs,
				&seenMu,
				opts.Deduplicate,
				progressChan,
			)
			if err != nil {
				errOnce.Do(func() {
					downloadErr = err
				})
			}
		}()
	}
	wg.Wait()

	if downloadErr != nil {
		return nil, downloadErr
	}

	// Verify if all batches are done
	progressMutex.Lock()
	allDone := true
	for _, b := range progressState.Batches {
		if !b.Done {
			allDone = false
			break
		}
	}
	progressMutex.Unlock()

	if allDone {
		os.Remove(progressPath)
	}

	fileSize := int64(0)
	if fi, err := os.Stat(outputJSONL); err == nil {
		fileSize = fi.Size()
	}

	stats := &DownloadStats{
		TotalExpected:     opts.TotalExpected,
		Collected:         atomic.LoadInt64(&collectedCount),
		NewPapers:         atomic.LoadInt64(&newPapersCount),
		ExistingPapers:    int64(resumeCount),
		DuplicatesSkipped: atomic.LoadInt64(&duplicatesSkipped),
		OutputJSONL:       outputJSONL,
		FileSize:          fileSize,
		Duration:          time.Since(startTime),
	}

	return stats, nil
}

func (c *OpenAlexClient) processBatch(
	ctx context.Context,
	cfg *config.AppConfig,
	batch []string,
	batchIdx int,
	keywords string,
	allTopics []string,
	writer *SafeWriter,
	progressState *DownloadProgress,
	progressMutex *sync.Mutex,
	progressPath string,
	collectedCount *int64,
	newPapersCount *int64,
	duplicatesSkipped *int64,
	seenIDs map[string]struct{},
	seenMu *sync.Mutex,
	deduplicate bool,
	progressChan chan<- int,
) error {
	batchKey := fmt.Sprintf("%d", batchIdx)

	progressMutex.Lock()
	batchInfo, exists := progressState.Batches[batchKey]
	if !exists {
		batchInfo = &BatchProgress{
			LastCursor: nil,
			Done:       false,
			Topics:     batch,
		}
		progressState.Batches[batchKey] = batchInfo
	}
	done := batchInfo.Done
	var savedCursor string
	if batchInfo.LastCursor != nil {
		savedCursor = *batchInfo.LastCursor
	} else {
		savedCursor = "*"
	}
	progressMutex.Unlock()

	if done {
		return nil
	}

	var filterStr string
	if len(batch) > 0 {
		fullTopicFilter := "primary_topic.id:" + strings.Join(allTopics, "|")
		baseFilter := buildFilter(keywords, allTopics, cfg.Filters.DateFrom, cfg.Filters.DateTo, cfg.Filters.DocTypes)

		if strings.Contains(baseFilter, fullTopicFilter) {
			filterStr = strings.Replace(baseFilter, fullTopicFilter, "primary_topic.id:"+strings.Join(batch, "|"), 1)
		} else {
			filterStr = buildFilter(keywords, batch, cfg.Filters.DateFrom, cfg.Filters.DateTo, cfg.Filters.DocTypes)
		}
	} else {
		filterStr = buildFilter(keywords, nil, cfg.Filters.DateFrom, cfg.Filters.DateTo, cfg.Filters.DocTypes)
	}

	cursor := savedCursor
	collectedInBatch := 0
	aborted := false

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		resp, err := c.FetchPageRaw(ctx, filterStr, cursor)
		if err != nil {
			aborted = true
			break
		}

		var pageResp RawPageResponse
		if err := json.Unmarshal(resp, &pageResp); err != nil {
			aborted = true
			break
		}

		if len(pageResp.Results) == 0 {
			break
		}

		nextCursor := pageResp.Meta.NextCursor

		for _, paper := range pageResp.Results {
			if deduplicate {
				var idHolder struct {
					ID string `json:"id"`
				}
				if json.Unmarshal(paper, &idHolder) == nil && idHolder.ID != "" {
					seenMu.Lock()
					if _, exists := seenIDs[idHolder.ID]; exists {
						seenMu.Unlock()
						if duplicatesSkipped != nil {
							atomic.AddInt64(duplicatesSkipped, 1)
						}
						continue
					}
					seenIDs[idHolder.ID] = struct{}{}
					seenMu.Unlock()
				}
			}

			if err := writer.WriteLine(paper); err != nil {
				return err
			}
			atomic.AddInt64(collectedCount, 1)
			if newPapersCount != nil {
				atomic.AddInt64(newPapersCount, 1)
			}
			if progressChan != nil {
				select {
				case progressChan <- int(atomic.LoadInt64(collectedCount)):
				default:
				}
			}
			collectedInBatch++
		}

		progressMutex.Lock()
		progressState.Batches[batchKey].LastCursor = &nextCursor
		if err := saveProgress(progressPath, progressState); err != nil {
			fmt.Fprintf(os.Stderr, "failed to save progress state: %v\n", err)
		}
		progressMutex.Unlock()

		cursor = nextCursor
		if cursor == "" || cursor == "*" {
			break
		}
	}

	progressMutex.Lock()
	defer progressMutex.Unlock()
	if aborted {
		fmt.Fprintf(os.Stderr, "Batch %d: saved cursor for resume (%d papers collected so far).\n", batchIdx, collectedInBatch)
	} else {
		progressState.Batches[batchKey].Done = true
		progressState.Batches[batchKey].LastCursor = nil
		saveProgress(progressPath, progressState)
	}

	return nil
}

// ValidateKeywords verifies strict parenthesis, quotes, operators, and safety constraints on search strings.
func ValidateKeywords(keywords string) []string {
	var errors []string
	q := strings.TrimSpace(keywords)

	if q == "" {
		errors = append(errors, "Keywords query is empty.")
		return errors
	}

	// 1. Parentheses balance
	openCount := strings.Count(q, "(")
	closeCount := strings.Count(q, ")")
	if openCount != closeCount {
		errors = append(errors, fmt.Sprintf("Unbalanced parentheses: %d open, %d close.", openCount, closeCount))
	}

	// 2. Quotes balance
	quoteCount := strings.Count(q, "\"")
	if quoteCount%2 != 0 {
		errors = append(errors, "Odd number of double quotes — every \" must have a closing \".")
	}

	// 3. Lowercase operator checks (only outside quotes)
	reQuotes := regexp.MustCompile(`"[^"]*"`)
	qNoQuotes := reQuotes.ReplaceAllString(q, "")
	reLowerOps := regexp.MustCompile(`\b(and|or|not)\b`)
	if reLowerOps.MatchString(qNoQuotes) {
		errors = append(errors, "Operators must be uppercase: use OR, AND, NOT.")
	}

	// 4. Adjacent operators
	reAdjOps := regexp.MustCompile(`\b(AND|OR)\s+(AND|OR)\b|\bNOT\s+NOT\b`)
	if reAdjOps.MatchString(q) {
		errors = append(errors, "Adjacent operators found (e.g. 'OR OR') — check query.")
	}

	// 5. Empty elements
	if strings.Contains(q, "()") {
		errors = append(errors, "Empty parentheses () found.")
	}
	if strings.Contains(q, `""`) {
		errors = append(errors, "Empty double quotes \"\" found.")
	}
	reEmptyQuotes := regexp.MustCompile(`"\s+"`)
	if reEmptyQuotes.MatchString(q) {
		errors = append(errors, "Empty double quotes with whitespace found.")
	}

	// 6. Start / End check
	trimmed := strings.TrimSpace(q)
	words := strings.Fields(trimmed)
	if len(words) > 0 {
		firstWord := strings.Trim(words[0], "()")
		lastWord := strings.Trim(words[len(words)-1], "()")
		if firstWord == "AND" || firstWord == "OR" {
			errors = append(errors, "Query cannot start with binary operator AND or OR.")
		}
		if lastWord == "AND" || lastWord == "OR" || lastWord == "NOT" {
			errors = append(errors, "Query cannot end with an operator (AND, OR, NOT).")
		}
	}

	// 7. Dangling operators next to parentheses
	reDanglingParen := regexp.MustCompile(`\(\s*(AND|OR)\b|\b(AND|OR|NOT)\s*\)`)
	if reDanglingParen.MatchString(q) {
		errors = append(errors, "Dangling operators inside parentheses (e.g. '(AND term)' or '(term OR)').")
	}

	// 8. Safety check for injection characters
	invalidChars := []string{";", "'", "`", "\\", "<", ">", "{", "}", "[", "]"}
	for _, char := range invalidChars {
		if strings.Contains(q, char) {
			errors = append(errors, fmt.Sprintf("Query contains invalid character: %q.", char))
		}
	}

	return errors
}

var topicRegexp = regexp.MustCompile(`^T\d{5}$`)

// ValidateTopicFormat verifies that the topic matches T + 5 digits pattern.
func ValidateTopicFormat(topic string) bool {
	return topicRegexp.MatchString(topic)
}

func (c *OpenAlexClient) checkTopicExist(ctx context.Context, topicID string) (bool, error) {
	baseURL := c.baseURL
	if baseURL == "" {
		baseURL = "https://api.openalex.org"
	}
	urlStr := fmt.Sprintf("%s/topics/%s", baseURL, topicID)
	req, err := http.NewRequestWithContext(ctx, "GET", urlStr, nil)
	if err != nil {
		return false, err
	}

	select {
	case c.semaphore <- struct{}{}:
	case <-ctx.Done():
		return false, ctx.Err()
	}
	defer func() { <-c.semaphore }()

	_, err = c.doRequest(ctx, req)
	if err != nil {
		if strings.Contains(err.Error(), "HTTP error 404") {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

// ValidateTopicsExist checks with the OpenAlex API whether specified topic IDs actually exist.
func ValidateTopicsExist(ctx context.Context, client *OpenAlexClient, topicIDs []string) (map[string]bool, error) {
	results := make(map[string]bool)
	var mu sync.Mutex

	var wg sync.WaitGroup
	errChan := make(chan error, len(topicIDs))

	for _, tid := range topicIDs {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			exists, err := client.checkTopicExist(ctx, id)
			if err != nil {
				errChan <- err
				return
			}
			mu.Lock()
			results[id] = exists
			mu.Unlock()
		}(tid)
	}

	wg.Wait()
	close(errChan)

	if len(errChan) > 0 {
		return nil, <-errChan
	}

	return results, nil
}

type GroupByItem struct {
	Key            string `json:"key"`
	KeyDisplayName string `json:"key_display_name"`
	Count          int    `json:"count"`
}

type GroupByResponse struct {
	GroupBy []GroupByItem `json:"group_by"`
	Meta    struct {
		Count      int    `json:"count"`
		NextCursor string `json:"next_cursor"`
	} `json:"meta"`
}

type TopicDetails struct {
	ID          string   `json:"id"`
	DisplayName string   `json:"display_name"`
	Description string   `json:"description"`
	Keywords    []string `json:"keywords"`
	Domain      struct {
		DisplayName string `json:"display_name"`
	} `json:"domain"`
	Field       struct {
		DisplayName string `json:"display_name"`
	} `json:"field"`
	Subfield    struct {
		DisplayName string `json:"display_name"`
	} `json:"subfield"`
}

// FetchGroupBy queries OpenAlex works endpoint with a group_by parameter.
func (c *OpenAlexClient) FetchGroupBy(ctx context.Context, apiFilter string, groupBy string, cursor string) (*GroupByResponse, error) {
	baseURL := c.baseURL
	if baseURL == "" {
		baseURL = "https://api.openalex.org"
	}
	u, err := url.Parse(baseURL + "/works")
	if err != nil {
		return nil, err
	}
	q := u.Query()
	q.Set("filter", apiFilter)
	q.Set("group_by", groupBy)
	q.Set("per_page", "200")
	q.Set("cursor", cursor)
	u.RawQuery = q.Encode()

	req, err := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
	if err != nil {
		return nil, err
	}

	select {
	case c.semaphore <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-c.semaphore }()

	body, err := c.doRequest(ctx, req)
	if err != nil {
		return nil, err
	}

	var resp GroupByResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, err
	}

	return &resp, nil
}

// FetchTopicDetails retrieves details for a single topic.
func (c *OpenAlexClient) FetchTopicDetails(ctx context.Context, topicID string) (*TopicDetails, error) {
	baseURL := c.baseURL
	if baseURL == "" {
		baseURL = "https://api.openalex.org"
	}
	// Clean the topic ID if it is a full URL
	cleanID := topicID
	if idx := strings.LastIndex(topicID, "/"); idx != -1 {
		cleanID = topicID[idx+1:]
	}

	urlStr := fmt.Sprintf("%s/topics/%s", baseURL, cleanID)
	req, err := http.NewRequestWithContext(ctx, "GET", urlStr, nil)
	if err != nil {
		return nil, err
	}

	select {
	case c.semaphore <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-c.semaphore }()

	body, err := c.doRequest(ctx, req)
	if err != nil {
		return nil, err
	}

	var details TopicDetails
	if err := json.Unmarshal(body, &details); err != nil {
		return nil, err
	}

	return &details, nil
}

var doiPrefixRegex = regexp.MustCompile(`(?i)^(?:https?://(?:dx\.)?doi\.org/|doi:)`)

// FetchWorkByDOI retrieves a single work by DOI from OpenAlex (e.g., https://api.openalex.org/works/https://doi.org/...).
func (c *OpenAlexClient) FetchWorkByDOI(ctx context.Context, doi string) (*Work, error) {
	baseURL := c.baseURL
	if baseURL == "" {
		baseURL = "https://api.openalex.org"
	}
	cleanDOI := strings.TrimSpace(doi)
	cleanDOI = doiPrefixRegex.ReplaceAllString(cleanDOI, "")
	cleanDOI = strings.TrimSpace(cleanDOI)
	encoded := url.QueryEscape(cleanDOI)

	urlStr := fmt.Sprintf("%s/works/https://doi.org/%s", baseURL, encoded)
	req, err := http.NewRequestWithContext(ctx, "GET", urlStr, nil)
	if err != nil {
		return nil, err
	}

	select {
	case c.semaphore <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-c.semaphore }()

	body, err := c.doRequest(ctx, req)
	if err != nil {
		return nil, err
	}

	var work Work
	if err := json.Unmarshal(body, &work); err != nil {
		return nil, err
	}

	return &work, nil
}

