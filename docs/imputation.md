---
sidebar_position: 6
---

# Affiliation & Country Imputation Engine

Stratum features an advanced two-tier imputation architecture to address missing institutional metadata and country codes in academic literature. Missing affiliations and geographical data are resolved through a high-throughput **Pre-Ingestion JSONL Cascade** (`openalex impute-country`) before database ingestion, followed by a deep **In-Database Metadata Restoration Engine** (`impute/impute.go`) operating on DuckDB tables.

```mermaid
flowchart TD
    subgraph Tier 1: Pre-Ingestion Cascade (JSONL)
        RawJSONL[Raw OpenAlex JSONL] --> Imputer[openalex impute-country]
        
        Imputer --> S1{Stage 1: Existing Code?}
        S1 -- Yes --> Retain1[Standardize & Retain ISO-2]
        S1 -- No --> S2{Stage 2: Has ROR ID?}
        
        S2 -- Yes --> ROR[Query api.ror.org/v2]
        ROR -- Success --> SetROR[Set ISO-2 via ROR]
        S2 -- No / Fail --> S3{Stage 3: Affiliation Regex?}
        
        S3 -- Match --> Gaz[Match Country / State Gazetteers]
        S3 -- No Match --> S4{Stage 4: Display Name?}
        
        S4 -- Match --> NameGaz[Scan Institution Tokens]
        S4 -- No Match --> Missing[Mark as Unresolved]
        
        Retain1 --> ImputedJSONL[*_imputed.jsonl]
        SetROR --> ImputedJSONL
        Gaz --> ImputedJSONL
        NameGaz --> ImputedJSONL
        Missing --> ImputedJSONL
    end

    subgraph Tier 2: Post-Ingestion Enrichment (DuckDB)
        ImputedJSONL --> ImportDuckDB[(DuckDB Tables)]
        ImportDuckDB --> Crossref[Crossref DOI Resolution]
        ImportDuckDB --> LLM[LLM Entity Extraction / Ollama / Gemini]
        ImportDuckDB --> PDF[Full-Text PDF Extraction]
    end
```

---

## 1. Pre-Ingestion JSONL Country Imputation (`openalex impute-country`)

Running imputation directly on raw JSONL records before database conversion ensures high performance, clean relational loading, and zero schema pollution.

### Non-Destructive Raw Data Guarantee
The original OpenAlex JSONL export is **never modified in-place**. The imputer reads records line-by-line and writes enriched records to a separate file, typically named `<input>_imputed.jsonl`. If any step is interrupted, raw data remains completely intact.

### The 4-Stage Methodological Cascade

For each authorship record in a publication, the engine applies the following heuristic cascade in strict sequence:

#### Stage 01: Preserve Existing OpenAlex Country Codes
- Standardizes valid ISO-2 country codes already populated by OpenAlex in `institution.country_code` or `authorship.countries`.
- Normalizes ISO-3 representations and common abbreviations (e.g., mapping `HK` $\to$ `CN` when configured).
- Skips further processing if a valid code is already present, avoiding unnecessary network calls.

#### Stage 02: Authoritative ROR Registry Lookup
- Triggered when an institution record exists with an ROR identifier (`ror` or `ror_id`) but lacks a `country_code`.
- Queries the authoritative Research Organization Registry (ROR) v2 API:
  $$\text{URL: } \texttt{https://api.ror.org/v2/organizations/\{ror\_id\}}$$
- **Rate-Limiting & Caching**: Incorporates a 0.15-second delay between requests and in-memory hash caching to eliminate redundant remote calls for repeated institutions.
- **Drift Prevention**: Deliberately avoids fuzzy name matching against the ROR API, relying only on exact organization identifiers to prevent false positive entity drift.

#### Stage 03: Affiliation String Regex & Multi-Tier Gazetteers
- Analyzes `authorship.raw_affiliation_strings` against curated, hierarchical gazetteers using word-boundary regular expressions (`(?<![a-z])term(?![a-z])`):
  1. **Country Names & Aliases**: Evaluated longest-phrase first to prevent substring collisions (e.g., *"People's Republic of China"*, *"United States of America"*, *"South Korea"*, *"Great Britain"*, *"Czech Republic"*).
  2. **Indian States & Union Territories**: Comprehensive gazetteer covering all 36 Indian states and UTs (e.g., *"Karnataka"*, *"Tamil Nadu"*, *"Maharashtra"*, *"Delhi"*, *"Telangana"* $\to$ `IN`).
  3. **US States & Territories**: Complete dictionary of all 50 US states, District of Columbia, Puerto Rico, Guam, and US Virgin Islands $\to$ `US`.
  4. **Strictly Formatted US State Abbreviations**: Evaluates uppercase 2-letter tokens only when bounded by comma or parenthetical delimiters (e.g., `", CA,"`, `"(MA)"`, `" TX "`) to prevent spurious two-letter acronym collisions.

#### Stage 04: Institution Display Name Inspection
- If raw affiliation strings are absent or inconclusive, a fallback scanner evaluates tokens within `institution.display_name` against national and regional entity markers (e.g., *"Indian Institute of Science"* $\to$ `IN`, *"Nanjing University"* $\to$ `CN`).

---

### Dual Authorship Resolution Architecture

OpenAlex records contain authorships both with and without structured institution objects. The imputer handles both cases:

| Authorship Type | Target Field Modified | Downstream Benefit |
| :--- | :--- | :--- |
| **With Institution** | `institution.country_code = "XX"` | Directly populates `institutions` and `contributions` tables in DuckDB. |
| **Without Institution** | `authorship.countries = ["XX"]` | Allows the JSONL $\to$ CSV $\to$ DuckDB loader to infer country for unmapped authors without inventing synthetic institutions. |

---

## 2. CLI and Web Interface Usage

### Command Line Interface (CLI)

The country imputation pipeline is invoked via the `openalex` CLI:

```bash
# Basic run (defaults to <input>_imputed.jsonl)
openalex impute-country data/raw/papers.jsonl

# Specify custom output path
openalex impute-country data/raw/papers.jsonl -o data/raw/papers_clean.jsonl

# Test on the first 1,000 records
openalex impute-country data/raw/papers.jsonl --limit 1000

# Disable ROR remote lookups (offline / air-gapped mode)
openalex impute-country data/raw/papers.jsonl --no-ror
```

### Ingestion Dashboard (Tab 4)

In the Stratum Web Dashboard under **Ingestion**:
1. Navigate to **Tab 4: Country Imputation (`openalex impute-country`)**.
2. Select the input `.jsonl` file from the auto-discovered project directory.
3. Configure record limits (optional) and toggle ROR lookups.
4. Click **Run Country Imputation** to execute the pipeline with real-time log streaming, progress bars, and resolution breakdown metrics.
5. Download the resulting `*_imputed.jsonl` file or proceed to one-click DuckDB ingestion via the SQL Playground / Import API.

---

## 3. Post-Ingestion In-Database Enrichment (`impute/impute.go`)

For papers already loaded into DuckDB that lack complete metadata, Stratum provides an in-database enrichment suite:

### Crossref DOI Metadata Resolution (`ImputeCrossRef`)
- Queries publisher metadata via the Crossref works API using DOIs.
- Matches author names and positions to restore missing affiliation strings and author ORCIDs.

### LLM Named Entity Extraction (`ImputeLLM`)
- Submits raw, ambiguous affiliation text to local Ollama models (such as Llama 3, Mistral, or Qwen) or the Google Gemini API.
- Prompts the LLM to extract structured university/organization names and ISO-2 country codes.

### Full-Text PDF Parsing (`ImputePDF`)
- For open-access preprints and publications (via arXiv or Unpaywall), downloads PDF streams and decompresses first-page text objects.
- Extracts author affiliation headers and passes them through entity extraction prompts.
