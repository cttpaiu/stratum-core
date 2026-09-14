---
sidebar_position: 4
---

# API Reference

The Stratum backend exposes a REST HTTP API for managing projects, configuring data sources, executing database queries, and checking pipeline runs. All endpoints are prefixed with `/api/`.

---

## 1. System Status

### `GET /api/status`
Returns the operational health status of the Go server.

**Response (200 OK):**
```json
{
  "status": "healthy",
  "version": "1.0.0",
  "uptime_seconds": 1284
}
```

---

## 2. Ingest & Processing Pipelines

### `POST /api/run-pipeline`
Triggers a background ingestion or metadata imputation pipeline execution.

**Request Body:**
```json
{
  "action": "ingest" // Options: "ingest", "impute"
}
```

**Response (200 OK):**
```json
{
  "status": "started",
  "pipeline_id": "pip-902318",
  "message": "Ingestion pipeline initialized in the background."
}
```

---

### `GET /api/pipeline/status`
Polls the active or most recent pipeline execution state, returning progress statistics.

**Response (200 OK):**
```json
{
  "pipeline_id": "pip-902318",
  "status": "running", // Options: "idle", "running", "completed", "failed"
  "action": "ingest",
  "progress_percent": 45,
  "processed_items": 1250,
  "total_items": 2778,
  "error_count": 0
}
```

---

## 3. Database Statistics & Querying

### `GET /api/stats`
Retrieves summary metrics from the loaded DuckDB analytical database.

**Response (200 OK):**
```json
{
  "total_papers": 15004,
  "total_authors": 38102,
  "total_institutions": 1492,
  "missing_country_count": 240,
  "imputed_country_count": 105,
  "international_collaboration_rate": 0.28
}
```

---

### `POST /api/query`
Executes an analytical SQL statement against the DuckDB database. Supports standard relational table queries as well as direct JSONL queries using DuckDB's native `read_json_auto()`.

**Query Parameters:**
- `project` (string, optional): Target project slug (defaults to `"default"`).

**Request Body:**
Accepts either `query` or `sql`:
```json
{
  "query": "SELECT publication_year, COUNT(*) as paper_count FROM papers GROUP BY publication_year ORDER BY publication_year DESC"
}
```

Or direct JSONL querying:
```json
{
  "query": "SELECT id, title, publication_year, cited_by_count FROM read_json_auto('data/jsonl/*.jsonl') LIMIT 10"
}
```

**Response (200 OK):**
Returns a JSON array of row objects (or `[]` if 0 rows match):
```json
[
  {
    "publication_year": 2024,
    "paper_count": 451
  },
  {
    "publication_year": 2023,
    "paper_count": 2304
  }
]
```

**Response (400 Bad Request):**
```json
{
  "error": "Catalog Error: Table with name nonexistent_table does not exist!"
}
```

---

### `POST /api/db/import-jsonl`
Normalizes and imports downloaded OpenAlex JSONL paper files into DuckDB relational tables (`papers`, `authors`, `institutions`, `countries`, `contributions`).

**Query Parameters:**
- `project` (string, optional): Target project slug.

**Request Body:**
```json
{
  "filename": "6G.jsonl" // Optional: defaults to auto-discovered project JSONL
}
```

**Response (200 OK):**
```json
{
  "status": "success",
  "file": "6G.jsonl",
  "papers": 9380,
  "authors": 24150,
  "institutions": 1250,
  "contributions": 31200,
  "countries": 84
}
```

---

### `POST /api/query/validate`
Validates the syntax and safety of a SQL query before execution.

**Request Body:**
```json
{
  "sql": "SELECT * FROM papers"
}
```

**Response (200 OK):**
```json
{
  "valid": true,
  "error": ""
}
```

---

## 4. Configuration

### `GET /api/config`
Retrieves the current search keywords, topics, and API keys.

**Response (200 OK):**
```json
{
  "keywords": "quantum computing AND cryptography",
  "topics": ["T10123", "T10901"],
  "api": {
    "email": "researcher@university.edu",
    "concurrent_requests": 4
  }
}
```

---

### `POST /api/config`
Updates SQLite configurations.

**Request Body:**
```json
{
  "keywords": "quantum computing AND machine learning",
  "topics": ["T10123"],
  "api": {
    "email": "researcher@university.edu",
    "concurrent_requests": 6
  }
}
```

**Response (200 OK):**
```json
{
  "status": "updated",
  "message": "Configuration successfully saved."
}
```

---

## 5. Metadata Upload & TF-IDF

### `POST /api/upload`
Uploads a local metadata file (e.g., CSV, JSONL) to be parsed and loaded.

**Request:** Multipart form upload containing a file field.

**Response (200 OK):**
```json
{
  "status": "uploaded",
  "filename": "metadata_export.jsonl",
  "records_count": 580
}
```

---

### `POST /api/tfidf`
Performs TF-IDF candidate term extraction from local catalog files (.csv, .xlsx, .xls) combined with dense semantic KeyBERT re-ranking using `allenai-specter`.

**Request Body:**
```json
{
  "project": "default",
  "file_name": "quantum_papers.csv",
  "title_col": "Title",
  "abstract_col": "Abstract",
  "doi_col": "DOI",
  "ngram_min": 2,
  "ngram_max": 3,
  "min_df": 2,
  "max_df": 0.85,
  "candidate_pool": 20,
  "top_n": 20,
  "use_keybert": true,
  "keybert_model": "allenai-specter",
  "alpha": 0.1
}
```

**Parameters:**
- `candidate_pool` (integer, default `20`): Number of candidate terms initially extracted by TF-IDF.
- `top_n` (integer, default `20`): Final number of terms returned after KeyBERT semantic re-ranking.
- `use_keybert` (boolean, default `true`): Enables dense semantic re-ranking via `allenai-specter`.
- `keybert_model` (string, default `"allenai-specter"`): Embedding model optimized for scientific literature.
- `alpha` (float, default `0.1`): Linear blend weight between normalized TF-IDF and KeyBERT cosine similarity. Set to `0.0` for pure KeyBERT scoring.

**Response (200 OK):**
```json
{
  "keywords": [
    {
      "term": "quantum key distribution",
      "score": 0.884,
      "tfidf_score": 0.045,
      "keybert_score": 0.915
    },
    {
      "term": "error correction codes",
      "score": 0.762,
      "tfidf_score": 0.038,
      "keybert_score": 0.820
    }
  ]
}
```

---

## 6. Projects Management

### `GET /api/projects`
Lists all managed workspaces.

**Response (200 OK):**
```json
[
  {
    "id": "proj-quantum-computing",
    "name": "Quantum Computing Research",
    "created_at": "2026-06-10T08:00:00Z"
  }
]
```

---

### `POST /api/projects/create`
Creates a new isolated workspace.

**Request Body:**
```json
{
  "name": "Carbon Sequestration Ingestion"
}
```

**Response (200 OK):**
```json
{
  "id": "proj-carbon-sequestration",
  "name": "Carbon Sequestration Ingestion",
  "status": "created"
}
```

---

## 7. Country Imputation API

### `POST /api/impute/run`
Launches the 4-stage sequential heuristic cascade (`openalex impute-country`) in the background to infer missing country codes in an OpenAlex JSONL publication dataset before DuckDB ingestion.

**Query Parameters:**
- `project` (string, optional): Target project slug (defaults to `"default"`).

**Request Body (optional):**
```json
{
  "input_path": "quantum_computing.jsonl",
  "output_path": "quantum_computing_imputed.jsonl",
  "limit": 500,
  "use_ror": true
}
```

**Response (200 OK):**
```json
{
  "status": "started",
  "project": "quantum_computing",
  "input_file": "quantum_computing.jsonl",
  "output_file": "quantum_computing_imputed.jsonl"
}
```

---

### `GET /api/impute/status`
Polls current execution status, live progress percentage, log streams, and resolution metrics for an active or completed imputation job.

**Query Parameters:**
- `project` (string, optional): Target project slug.

**Response (200 OK):**
```json
{
  "running": false,
  "progress": 100,
  "output_file": "quantum_computing_imputed.jsonl",
  "logs": [
    "[15:04:05] [INFO] Starting OpenAlex JSONL country imputation...",
    "[15:04:05] [INFO] Input file:  data/jsonl/quantum_computing.jsonl",
    "[15:04:05] [INFO] Output file: data/jsonl/quantum_computing_imputed.jsonl",
    "[15:04:05] [INFO] ROR lookups: true",
    "[15:04:12] [INFO] Processed 10,450 authorships (imputed: 842 via ROR, 1,215 via gazetteer)"
  ],
  "stats": {
    "records_processed": "4210",
    "authorships_processed": "10450",
    "institutions_imputed": "2057",
    "authorships_imputed": "342"
  }
}
```

---

### `POST /api/impute/cancel`
Gracefully requests cancellation of the currently executing imputation background task.

**Query Parameters:**
- `project` (string, optional): Target project slug.

**Response (200 OK):**
```json
{
  "status": "cancelling"
}
```

---

### `GET /api/impute/files`
Lists all available `.jsonl` files in the project workspace, identifying their size, modification date, and whether they are raw or imputed datasets.

**Query Parameters:**
- `project` (string, optional): Target project slug.

**Response (200 OK):**
```json
[
  {
    "name": "quantum_computing.jsonl",
    "size_bytes": 15420310,
    "size_human": "14.7 MB",
    "mod_time": "2026-09-08 11:20:00",
    "is_imputed": false
  },
  {
    "name": "quantum_computing_imputed.jsonl",
    "size_bytes": 15488120,
    "size_human": "14.8 MB",
    "mod_time": "2026-09-08 11:25:30",
    "is_imputed": true
  }
]
```

---

### `GET /api/download/file`
Directly serves a raw or imputed JSONL file for browser download.

**Query Parameters:**
- `project` (string, optional): Target project slug.
- `file` (string, optional): Name of the file to download (e.g. `quantum_computing_imputed.jsonl`).

