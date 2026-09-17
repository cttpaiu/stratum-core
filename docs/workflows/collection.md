# Ingestion & Enrichment Checklist

Run these steps after verifying query precision and coverage:

- [ ] Execute `download` to pull matching OpenAlex papers into `collected_papers.jsonl`.
- [ ] Monitor log updates and hit rates.
- [ ] Run pre-ingestion country imputation (`openalex impute-country` or Ingestion Tab 4) to recover missing country codes via ROR lookups and gazetteer heuristics into `collected_papers_imputed.jsonl`.
- [ ] Initialize the DuckDB schema and insert records using `convert_db` or `POST /api/db/import-jsonl`.
- [ ] Run Crossref affiliation imputation (`impute crossref`).
- [ ] Run rule-based country boundary checks.
- [ ] Run LLM affiliation classification (`impute llm`).
- [ ] Run PDF text extraction for remaining missing links (`impute pdf`).
- [ ] Check DuckDB totals and imputation audit logs.
