# Complete Ingestion & Imputation Workflow

This workflow represents the end-to-end cycle to establish a project database:

1.  **Configure**: Set project metadata (API keys, email contact).
2.  **Upload**: Import reference file (`upload_file`).
3.  **Analyze**: Run keywords/anchors extraction (`extract_query_and_anchors` with TF-IDF candidate pool & KeyBERT Specter re-ranking).
4.  **Refine**: Test hits, review topic tables, and edit config.
5.  **Validate**: Verify anchors are covered and syntax is correct.
6.  **Download**: Start concurrent downloads (`download`) saving raw works to JSONL.
7.  **Impute Countries**: Run pre-ingestion country imputation (`openalex impute-country` / Tab 4) with the 4-stage heuristic cascade (ROR lookups + gazetteer regex) generating `*_imputed.jsonl`.
8.  **Ingest to DuckDB**: Load imputed records into DuckDB relational tables (`POST /api/db/import-jsonl` or `convert_db`).
9.  **Enrich In-Database**: Run post-ingestion imputation (`impute`) with Crossref DOI lookups, LLM extraction (Ollama/Gemini), and full-text PDF parsing.
10. **Analyze**: Verify database table counts, explore live schemas, and execute analytical queries in the SQL Playground.
