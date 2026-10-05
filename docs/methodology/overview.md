# Methodology Overview

Stratum is designed to solve the problem of constructing **representative academic publication datasets** for target technologies.

## Why a Structured Ingest Process is Required
Academic search queries are prone to:
1.  **Keyword Ambiguity**: Terms like "quantum" map to both computing and mechanics, causing noise.
2.  **Indexing Gaps**: Many academic papers do not contain ROR identifiers or country codes out of the box.
3.  **Topic Variance**: Important studies are spread across computer science, physics, and materials engineering.

By separating query discovery (TF-IDF & semantic re-ranking), validation (anchor papers, random sampling), collection (concurrent fetching), pre-ingestion country imputation (ROR registry lookups & multi-tier gazetteers), and deep in-database enrichment (Crossref, LLM, PDF imputation), we can construct a verified, clean, and normalized dataset suitable for downstream technology analysis.
