#!/usr/bin/env python3
"""
CTT Quantum Bibliometrics Pipeline
==================================
Runs the full scientometric/bibliometric analysis across the four quantum
sub-technology DuckDB databases and writes consolidated Excel outputs
(all sub-technologies stacked in the same sheets, distinguished by
sub_tech_id), plus a verification report per database.

Usage:
    python run_ctt_quantum_pipeline.py

Configure the DATABASES list and paths in the CONFIG section below.
Requires: duckdb, pandas, openpyxl   (pip install duckdb pandas openpyxl)

Country resolution is CODE-BASED: every affiliation is resolved through
its institution country_code against the CTT country master (the Excel),
NOT through each database's own numeric country column. The four
databases were found to differ (some lack a country_id column, some carry
stray/duplicate country rows such as a second 'UK' at a non-CTT id), so
trusting per-database numeric columns is unsafe. country_code is present
and consistent in every database, and the Excel is the single source of
truth for the id<->name mapping. HK and GB/UK folding also key off
country_code ('HK'->China, 'GB'/'UK'->United Kingdom).
"""

import os
import sys
import datetime

import duckdb
import pandas as pd

# =====================================================================
# CONFIG
# =====================================================================

# All inputs (the per-technology DuckDB databases and the country master Excel)
# live in INPUT_DIR. The names below are bare filenames, resolved against
# INPUT_DIR at load time, with a fall-back to the current directory so the
# script still runs if you keep an input file beside it.
INPUT_DIR = "ctt_inputfiles"


def _resolve(name: str) -> str:
    """INPUT_DIR/name if present there, else name in CWD, else the INPUT_DIR
    path (so a not-found error points at the expected folder)."""
    here = os.path.join(INPUT_DIR, name)
    if os.path.exists(here):
        return here
    if os.path.exists(name):
        return name
    return here


DATABASES = [
    # (database filename,           tech_id, sub_tech_id, label)
    ("QC_publications.duckdb",   1, 1, "Quantum Computing"),
    ("QSM_publications.duckdb",  1, 2, "Quantum Sensing and Metrology"),
    ("QMD_publications.duckdb",  1, 3, "Quantum Materials and Devices"),
    ("QCC_publications.duckdb",  1, 4, "Quantum Communications and Cryptography"),
    ("GE.duckdb",                7, 19, "Genetic Engineering"),
    ("green_hydrogen.duckdb",         2, 5, "Green Hydrogen"),
    ("SMR_publications.duckdb",  2, 6, "Small Modular Reactor"),
 ("Li-ion_batteries_and_Advanced_Chemistry_Cells.duckdb", 2,7, "Li-ion batteries and Advanced Chemistry Cells"),
("hypersonic_publications.duckdb", 4,1,"Hypersonics"),
("PNT_publications.duckdb", 4,3, "Positioning, Navigation and Timing"),
("AdvancedJetEngines_publications.duckdb", 4, 2, "Advanced Jet Engineering"),
("6G_publications.duckdb", 6, 17, "6G Communication Technologies"),

    ("neuromorphic_publications.duckdb", 5, 15, "Neuromorphic Computing"),
    #("DPI_patents.xlsx", 5, 16, "Digital Public Infrastructure for AI Adoption"),
    ("6G_publications.duckdb", 6, 17, "6G Communications Technologies"),
    #("BCI_patents.xlsx", 7, 18, "Brain-Computer Interfaces"),
    ("biofoundry_publications.duckdb", 7, 20, "Biofoundry Technologies"),
    ("Cybersecurity_publications.duckdb", 10, 26, "Cybersecurity Technologies"),
   # ("Blockchain_publications.duckdb", 10, 27, "Blockchain Technologies"),
    ("AIML_publications.duckdb", 11, 30, "AI/ML for Weather Modelling"),)
]

# Resolve every database filename under INPUT_DIR (bare names above -> full paths).
DATABASES = [(_resolve(p), t, s, lbl) for (p, t, s, lbl) in DATABASES]

COUNTRY_EXCEL = "Country_List_CTT_final.xlsx"  # id, country_code, country_name; in INPUT_DIR

# =====================================================================
# CROSS-DATABASE DEDUPLICATION (within each tech_id)
# =====================================================================
# Pass 1 scans every sub-technology database of a tech_id and builds an
# ownership map. A publication that appears in more than one sub-technology
# of the SAME tech_id is OWNED by the LOWEST sub_tech_id in the group; it is
# removed from all higher sub_tech_id databases. Authors are deduplicated
# by the SAME rule (an author is owned by the lowest sub_tech_id they appear
# in, within the tech_id). Dedup never crosses tech_id: a paper in both a
# quantum database and the GE database still counts once per technology.
#
# Matching keys:
#   paper  -> normalised DOI where present, else the record id
#   author -> ORCID where present, else the record id
#
# Pass 2 computes indicators with non-owned papers/authors filtered out, so
# both the per-sub-technology and the overall-technology figures count each
# paper and each author exactly once.
#
# CONSEQUENCE: a sub-technology's figures become "records this sub-technology
# owns after lower sub_tech_ids have claimed shared records", so e.g. QSM
# (sub 2) loses everything it shares with QC (sub 1). This is intended; it is
# NOT comparable to the earlier whole-counting-per-subtech outputs.
#
# Set to False to restore whole-counting (each paper/author counted once per
# sub-technology it appears in).
DEDUPLICATE_WITHIN_TECH = True

YEAR_START, YEAR_END = 2003, 2024              # mapped to year_id 1..22

# Corpus rule: None = all records; or e.g. ["article", "review"].
# DECIDE ONCE — applies identically to every indicator and database.
TYPE_FILTER = None

INDIA_COUNTRY_ID = 12
HK_COUNTRY_ID, CN_COUNTRY_ID = 38, 7

OUTPUT_DIR = "ctt_outputs"
RESULTS_XLSX = "CTT_bibliometrics.xlsx"
VERIFY_XLSX = "CTT_verification.xlsx"

# Schema assumptions (adjust here if DESCRIBE shows different names).
# NOTE: no countries-table id column is referenced anywhere — country
# resolution goes through institutions.country_code -> country_map (Excel).
COL = {
    "contrib_paper": "paper_id",
    "contrib_inst": "institution_id",
    "contrib_author": "author_id",
    "inst_id": "id",
    "inst_name": "display_name",
    "inst_type": "type",
    "inst_country": "country_code",   # must exist in institutions in every DB
    "author_id": "id",
    "author_name": "display_name",
}

# Country-code based folding rules (applied before country_map lookup).
# Keys are UPPER-CASED institution country_code values.
CODE_ROLLUP = {
    "HK": 7,   # Hong Kong -> China
    "GB": 6,   # Great Britain / England / Scotland / Wales / N. Ireland -> UK
    "UK": 6,   # some DBs tag UK affiliations as 'UK' directly
}

# =====================================================================
# SESSION SETUP (per database): reference tables + backbones
# =====================================================================

def setup_session(con: duckdb.DuckDBPyConnection, country_df: pd.DataFrame,
                  paper_owner=None, author_owner=None, sub_tech_id=None) -> None:
    """Create reference tables and the four backbone temp tables."""
    con.register("_country_src", country_df)
    con.execute("""
        CREATE OR REPLACE TEMP TABLE country_map AS
        SELECT id AS country_id, country_code, country_name FROM _country_src
    """)
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE year_map AS
        SELECT y AS pub_year, y - {YEAR_START - 1} AS year_id
        FROM range({YEAR_START}, {YEAR_END + 1}) t(y)
    """)

    type_clause = ""
    if TYPE_FILTER:
        quoted = ", ".join(f"'{t}'" for t in TYPE_FILTER)
        type_clause = f"WHERE p.type IN ({quoted})"

    # Corpus + within-corpus excellence flags (per publication year).
    # Stored is_top_*_percent flags are NOT used: they mix OpenAlex
    # field-normalised and WoS baselines with different strictness.
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE flagged AS
        SELECT p.id AS paper_id,
               ym.year_id,
               (PERCENT_RANK() OVER (PARTITION BY p.publication_year
                                     ORDER BY p.cited_by_count DESC) < 0.10) AS is_top10,
               (PERCENT_RANK() OVER (PARTITION BY p.publication_year
                                     ORDER BY p.cited_by_count DESC) < 0.01) AS is_top1
        FROM papers p
        JOIN year_map ym ON p.publication_year = ym.pub_year
        {type_clause}
    """)

    # Cross-database dedup (Pass 2 application): keep only papers and authors
    # this sub-technology OWNS (lowest sub_tech_id wins within the tech_id).
    # paper_owner / author_owner are DataFrames (key, owner_sub) from Pass 1.
    if paper_owner is not None:
        con.register("_powner", paper_owner)
        before = con.execute("SELECT COUNT(*) FROM flagged").fetchone()[0]
        con.execute(f"""
            CREATE OR REPLACE TEMP TABLE flagged AS
            SELECT f.* FROM flagged f
            JOIN papers p ON p.id = f.paper_id
            JOIN _powner o
              ON o.pkey = COALESCE(
                   NULLIF(lower(regexp_replace(p.doi,'^https?://(dx\\.)?doi\\.org/','')),''),
                   p.id)
            WHERE o.owner_sub = {sub_tech_id}
        """)
        after = con.execute("SELECT COUNT(*) FROM flagged").fetchone()[0]
        print(f"    paper dedup: {before:,} -> {after:,} "
              f"({before - after:,} owned by a lower sub_tech_id)")

    # Author dedup: build the set of author_ids this sub-technology OWNS
    # (lowest sub_tech_id wins, matched by ORCID else author id). When no
    # author_owner map is supplied, all authors are owned (whole counting).
    con.execute("CREATE OR REPLACE TEMP TABLE owned_authors AS SELECT id AS author_id FROM authors")
    if author_owner is not None:
        con.register("_aowner", author_owner)
        _has_orcid = "orcid" in [c[0] for c in con.execute("DESCRIBE authors").fetchall()]
        _akey = ("COALESCE(NULLIF(lower(regexp_replace(a.orcid,"
                 "'^https?://orcid\\.org/','')),''), a.id)"
                 if _has_orcid else "a.id")
        con.execute(f"""
            CREATE OR REPLACE TEMP TABLE owned_authors AS
            SELECT a.id AS author_id
            FROM authors a
            JOIN _aowner o ON o.akey = {_akey}
            WHERE o.owner_sub = {sub_tech_id}
        """)
        na = con.execute("SELECT COUNT(*) FROM owned_authors").fetchone()[0]
        nt = con.execute("SELECT COUNT(*) FROM authors").fetchone()[0]
        print(f"    author dedup: {nt:,} -> {na:,} "
              f"({nt - na:,} owned by a lower sub_tech_id)")

    # Country resolver: upper-cased institution country_code -> CTT id,
    # applying HK/GB/UK folding before the country_map lookup. Built once
    # per session; used by pc and paper_inst. This deliberately ignores
    # each database's own countries table (schemas differ / stray rows).
    con.execute("""
        CREATE OR REPLACE TEMP TABLE code_rollup (raw_code VARCHAR, forced_id INTEGER)
    """)
    if CODE_ROLLUP:
        con.executemany("INSERT INTO code_rollup VALUES (?, ?)",
                        [(k.upper(), v) for k, v in CODE_ROLLUP.items()])

    # Paper x country, deduped (whole counting).
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE pc AS
        SELECT DISTINCT con.{COL['contrib_paper']} AS paper_id,
               COALESCE(r.forced_id, cm.country_id) AS country_id
        FROM contributions con
        JOIN institutions inst ON inst.{COL['inst_id']} = con.{COL['contrib_inst']}
        JOIN flagged f         ON f.paper_id = con.{COL['contrib_paper']}
        LEFT JOIN code_rollup r ON r.raw_code = upper(trim(inst.{COL['inst_country']}))
        LEFT JOIN country_map cm ON upper(trim(inst.{COL['inst_country']})) = upper(cm.country_code)
        WHERE COALESCE(r.forced_id, cm.country_id) IS NOT NULL
    """)

    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE paper_inst AS
        SELECT DISTINCT con.{COL['contrib_paper']} AS paper_id,
               con.{COL['contrib_inst']} AS institution_id,
               inst.{COL['inst_name']} AS institution_name,
               inst.{COL['inst_type']} AS institution_type,
               COALESCE(r.forced_id, cm.country_id) AS country_id
        FROM contributions con
        JOIN institutions inst ON inst.{COL['inst_id']} = con.{COL['contrib_inst']}
        JOIN flagged f         ON f.paper_id = con.{COL['contrib_paper']}
        LEFT JOIN code_rollup r ON r.raw_code = upper(trim(inst.{COL['inst_country']}))
        LEFT JOIN country_map cm ON upper(trim(inst.{COL['inst_country']})) = upper(cm.country_code)
        WHERE COALESCE(r.forced_id, cm.country_id) IS NOT NULL
    """)

    con.execute("""
        CREATE OR REPLACE TEMP TABLE inst_metrics AS
        SELECT pi.institution_id, pi.institution_name, pi.country_id,
               COUNT(DISTINCT pi.paper_id) AS total_publications,
               COUNT(DISTINCT CASE WHEN f.is_top1 THEN pi.paper_id END) AS top1_publications,
               RANK() OVER (ORDER BY COUNT(DISTINCT pi.paper_id) DESC) AS global_rank_total,
               RANK() OVER (ORDER BY COUNT(DISTINCT CASE WHEN f.is_top1
                                     THEN pi.paper_id END) DESC) AS global_rank_top1
        FROM paper_inst pi
        JOIN flagged f ON f.paper_id = pi.paper_id
        GROUP BY 1, 2, 3
    """)

    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE author_metrics AS
        WITH author_pubs AS (
            SELECT con.{COL['contrib_author']} AS author_id,
                   a.{COL['author_name']} AS author_name,
                   COUNT(DISTINCT con.{COL['contrib_paper']}) AS publications,
                   COUNT(DISTINCT CASE WHEN f.is_top10
                         THEN con.{COL['contrib_paper']} END) AS top10_publications,
                   COUNT(DISTINCT CASE WHEN f.is_top1
                         THEN con.{COL['contrib_paper']} END) AS top1_publications
            FROM contributions con
            JOIN authors a ON a.{COL['author_id']} = con.{COL['contrib_author']}
            JOIN owned_authors oa ON oa.author_id = con.{COL['contrib_author']}
            JOIN flagged f ON f.paper_id = con.{COL['contrib_paper']}
            GROUP BY 1, 2
        ),
        modal_affil AS (
            SELECT con.{COL['contrib_author']} AS author_id,
                   pi.institution_name, pi.country_id,
                   ROW_NUMBER() OVER (PARTITION BY con.{COL['contrib_author']}
                                      ORDER BY COUNT(DISTINCT con.{COL['contrib_paper']}) DESC,
                                               pi.institution_name) AS rn
            FROM contributions con
            JOIN paper_inst pi ON pi.paper_id = con.{COL['contrib_paper']}
                              AND pi.institution_id = con.{COL['contrib_inst']}
            GROUP BY 1, 2, 3
        )
        SELECT ap.author_id, ap.author_name, ap.publications,
               ap.top10_publications, ap.top1_publications,
               ma.institution_name AS primary_affiliation, ma.country_id
        FROM author_pubs ap
        LEFT JOIN modal_affil ma ON ma.author_id = ap.author_id AND ma.rn = 1
    """)

# =====================================================================
# INDICATOR QUERIES (all read the backbones; {t}=tech_id, {s}=sub_tech_id)
# =====================================================================

INDICATORS = {
    "Q1_year_country": """
        SELECT {t} AS tech_id, {s} AS sub_tech_id, f.year_id, cm.country_name, pc.country_id,
               COUNT(DISTINCT f.paper_id) AS total_publication,
               COUNT(DISTINCT CASE WHEN f.is_top10 THEN f.paper_id END)
                   AS top_10_publication_count,
               ROUND(100.0 * COUNT(DISTINCT CASE WHEN f.is_top10 THEN f.paper_id END)
                   / COUNT(DISTINCT f.paper_id), 2) AS top_10_publication_percentage,
               COUNT(DISTINCT CASE WHEN f.is_top1 THEN f.paper_id END)
                   AS top_1_publication_count,
               ROUND(100.0 * COUNT(DISTINCT CASE WHEN f.is_top1 THEN f.paper_id END)
                   / COUNT(DISTINCT f.paper_id), 2) AS top_1_publication_percentage
        FROM flagged f
        JOIN pc ON pc.paper_id = f.paper_id
        JOIN country_map cm ON cm.country_id = pc.country_id
        GROUP BY f.year_id, cm.country_name, pc.country_id
        ORDER BY f.year_id ASC, total_publication DESC
    """,
    "Q2a_collab_matrix": """
        SELECT {t} AS tech_id, {s} AS sub_tech_id,
               a.country_id AS parent_country_id,
               b.country_id AS collaboration_country_id,
               COUNT(DISTINCT a.paper_id) AS co_publications
        FROM pc a
        JOIN pc b ON a.paper_id = b.paper_id AND a.country_id <> b.country_id
        GROUP BY 3, 4
        ORDER BY parent_country_id, co_publications DESC
    """,
    "Q2b_top10_pairs": """
        SELECT {t} AS tech_id, {s} AS sub_tech_id,
               a.country_id AS parent_country_id,
               b.country_id AS collaboration_country_id,
               COUNT(DISTINCT a.paper_id) AS co_publications
        FROM pc a
        JOIN pc b ON a.paper_id = b.paper_id AND a.country_id < b.country_id
        GROUP BY 3, 4
        ORDER BY co_publications DESC
        LIMIT 10
    """,
    "Q3_india_collab": """
        SELECT {t} AS tech_id, {s} AS sub_tech_id,
               a.country_id AS parent_country_id,
               b.country_id AS collaboration_country_id,
               COUNT(DISTINCT a.paper_id) AS co_publications
        FROM pc a
        JOIN pc b ON a.paper_id = b.paper_id AND a.country_id <> b.country_id
        WHERE a.country_id = {india}
        GROUP BY 3, 4
        ORDER BY co_publications DESC
        LIMIT 10
    """,
    "S1_inst_global_pubs": """
        SELECT {t} AS tech_id, {s} AS sub_tech_id,
               global_rank_total AS rank, institution_name, institution_id,
               country_id, total_publications
        FROM inst_metrics
        ORDER BY global_rank_total, total_publications DESC, institution_name
        LIMIT 10
    """,
    "S2_inst_global_top1": """
        SELECT {t} AS tech_id, {s} AS sub_tech_id,
               global_rank_top1 AS rank, institution_name, institution_id,
               country_id, top1_publications, total_publications
        FROM inst_metrics
        ORDER BY global_rank_top1, total_publications DESC, institution_name
        LIMIT 10
    """,
    "S3_inst_india_pubs": """
        SELECT {t} AS tech_id, {s} AS sub_tech_id,
               RANK() OVER (ORDER BY total_publications DESC) AS india_rank,
               institution_name, institution_id, total_publications,
               global_rank_total AS global_ranking
        FROM inst_metrics
        WHERE country_id = {india}
        ORDER BY india_rank, institution_name
        LIMIT 10
    """,
    "S4_inst_india_top1": """
        SELECT {t} AS tech_id, {s} AS sub_tech_id,
               RANK() OVER (ORDER BY top1_publications DESC) AS india_rank,
               institution_name, institution_id, top1_publications,
               total_publications, global_rank_top1 AS global_ranking
        FROM inst_metrics
        WHERE country_id = {india}
        ORDER BY india_rank, total_publications DESC, institution_name
        LIMIT 10
    """,
    "S5_private_sector": """
        SELECT {t} AS tech_id, {s} AS sub_tech_id, f.year_id,
               COUNT(DISTINCT f.paper_id) AS total_publications,
               COUNT(DISTINCT CASE WHEN pi.institution_type = 'company'
                     THEN pi.paper_id END) AS company_participating_pubs,
               ROUND(100.0 * COUNT(DISTINCT CASE WHEN pi.institution_type = 'company'
                     THEN pi.paper_id END)
                   / COUNT(DISTINCT f.paper_id), 2) AS company_share_pct,
               COUNT(DISTINCT CASE WHEN pi.institution_type = 'company' AND f.is_top10
                     THEN pi.paper_id END) AS company_top10_pubs
        FROM flagged f
        LEFT JOIN paper_inst pi ON pi.paper_id = f.paper_id
        GROUP BY f.year_id
        ORDER BY f.year_id
    """,
    "S5b_top_companies": """
        SELECT {t} AS tech_id, {s} AS sub_tech_id,
               institution_name, country_id,
               COUNT(DISTINCT paper_id) AS publications
        FROM paper_inst
        WHERE institution_type = 'company'
        GROUP BY 3, 4
        ORDER BY publications DESC
        LIMIT 15
    """,
    "S6a_authors_global": """
        SELECT {t} AS tech_id, {s} AS sub_tech_id,
               RANK() OVER (ORDER BY publications DESC) AS rank,
               author_name, author_id, primary_affiliation, country_id,
               publications, top10_publications, top1_publications
        FROM author_metrics
        ORDER BY rank, top10_publications DESC, author_name
        LIMIT 10
    """,
    "S6b_authors_india": """
        SELECT {t} AS tech_id, {s} AS sub_tech_id,
               RANK() OVER (ORDER BY publications DESC) AS india_rank,
               author_name, author_id, primary_affiliation,
               publications, top10_publications, top1_publications
        FROM author_metrics
        WHERE country_id = {india}
        ORDER BY india_rank, top10_publications DESC, author_name
        LIMIT 10
    """,
}

# =====================================================================
# VERIFICATION QUERIES (V1-V9 mechanical, V10-V12 human-judgment data)
# =====================================================================

VERIFICATIONS = {
    "V1_coverage": ("""
        SELECT (SELECT COUNT(*) FROM flagged) AS corpus,
               (SELECT COUNT(DISTINCT paper_id) FROM pc) AS with_country,
               ROUND(100.0 * (SELECT COUNT(DISTINCT paper_id) FROM pc)
                   / (SELECT COUNT(*) FROM flagged), 2) AS coverage_pct
    """, "PASS if coverage_pct >= 99"),
    "V2_orphans": (f"""
        SELECT f.paper_id, p.doi, p.title, p.publication_year, p.type
        FROM flagged f
        JOIN papers p ON p.id = f.paper_id
        LEFT JOIN contributions con ON con.{COL['contrib_paper']} = f.paper_id
        WHERE con.{COL['contrib_paper']} IS NULL
        LIMIT 25
    """, "PASS if few, scattered paratext (ToCs, news, editorials)"),
    "V3_unmatched_codes": (f"""
        SELECT CASE WHEN inst.{COL['inst_country']} IS NULL THEN '(sql null)'
                    WHEN trim(inst.{COL['inst_country']}) = '' THEN '(empty)'
                    ELSE '[' || inst.{COL['inst_country']} || ']' END AS raw_code,
               COUNT(DISTINCT inst.{COL['inst_id']}) AS institutions,
               COUNT(DISTINCT con.{COL['contrib_paper']}) AS papers_affected
        FROM institutions inst
        LEFT JOIN code_rollup r ON r.raw_code = upper(trim(inst.{COL['inst_country']}))
        LEFT JOIN country_map cm ON upper(trim(inst.{COL['inst_country']})) = upper(cm.country_code)
        LEFT JOIN contributions con ON con.{COL['contrib_inst']} = inst.{COL['inst_id']}
        WHERE COALESCE(r.forced_id, cm.country_id) IS NULL
        GROUP BY 1 ORDER BY 3 DESC
    """, "PASS if only NULL/empty remain; patch alpha-3 strays (e.g. RUS->RU) via CODE_ROLLUP or source"),
    "V4_special_rules": (f"""
        SELECT (SELECT COUNT(*) FROM pc WHERE country_id = {HK_COUNTRY_ID}) AS hk_rows,
               (SELECT COUNT(DISTINCT con.{COL['contrib_paper']})
                FROM contributions con
                JOIN institutions inst ON inst.{COL['inst_id']} = con.{COL['contrib_inst']}
                WHERE upper(trim(inst.{COL['inst_country']})) = 'HK') AS hk_source_papers,
               (SELECT COUNT(DISTINCT paper_id) FROM pc WHERE country_id = 6) AS uk_papers
    """, "PASS if hk_rows = 0 and uk_papers > 0"),
    "V5_benchmark_cdc": ("""
        WITH mine AS (SELECT paper_id, COUNT(*) AS my_n FROM pc GROUP BY 1)
        SELECT p.countries_distinct_count - m.my_n AS diff, COUNT(*) AS papers
        FROM papers p JOIN mine m ON m.paper_id = p.id
        GROUP BY 1 ORDER BY 2 DESC
    """, "PASS if diff=0 dominates; +1 = HK rollup; negatives = imputation; NULL = WoS-unique"),
    "V6_inflation": ("""
        SELECT ROUND((SELECT COUNT(*) FROM pc) * 1.0 /
               (SELECT COUNT(DISTINCT paper_id) FROM pc), 3) AS inflation_ratio
    """, "PASS if ~1.2-1.5 (1.0 = dedup collapsed; 3+ = dedup broken)"),
    "V7_excellence_shares": ("""
        SELECT year_id, COUNT(*) AS papers,
               ROUND(AVG(is_top10::INT), 3) AS top10_share,
               ROUND(AVG(is_top1::INT), 3) AS top1_share
        FROM flagged GROUP BY 1 ORDER BY 1
    """, "PASS if shares near 0.10/0.01 (tie drift expected, esp. recent years)"),
    "V8a_symmetry": ("""
        WITH m AS (SELECT a.country_id AS p, b.country_id AS c,
                          COUNT(DISTINCT a.paper_id) AS n
                   FROM pc a JOIN pc b ON a.paper_id = b.paper_id
                                      AND a.country_id <> b.country_id
                   GROUP BY 1, 2)
        SELECT COUNT(*) AS asymmetric_pairs
        FROM m x JOIN m y ON x.p = y.c AND x.c = y.p WHERE x.n <> y.n
    """, "PASS if asymmetric_pairs = 0 (exact)"),
    "V8b_pair_identity": ("""
        SELECT (SELECT SUM(n) FROM (
                    SELECT COUNT(DISTINCT a.paper_id) AS n FROM pc a
                    JOIN pc b ON a.paper_id = b.paper_id AND a.country_id < b.country_id
                    GROUP BY a.country_id, b.country_id)) AS pair_total,
               (SELECT SUM(k * (k - 1) / 2) FROM (
                    SELECT COUNT(*) AS k FROM pc GROUP BY paper_id)) AS identity_total
    """, "PASS if pair_total = identity_total exactly"),
    "V8c_mega_collabs": ("""
        SELECT p.id, p.doi, p.title, k.k AS countries_on_paper
        FROM (SELECT paper_id, COUNT(*) AS k FROM pc GROUP BY 1) k
        JOIN papers p ON p.id = k.paper_id
        ORDER BY k.k DESC LIMIT 10
    """, "REVIEW any paper with k > ~15 by DOI"),
    "V10_india_trace": ("""
        SELECT p.id, p.doi, p.title, p.journal_name, p.cited_by_count,
               f.is_top10, f.is_top1
        FROM flagged f
        JOIN pc ON pc.paper_id = f.paper_id
        JOIN papers p ON p.id = f.paper_id
        WHERE pc.country_id = {india} AND f.year_id = 17
        ORDER BY p.cited_by_count DESC
    """.replace("{india}", str(INDIA_COUNTRY_ID)),
     "HUMAN: row count must equal Q1 India/2019 cell; spot-check 4-5 DOIs"),
    "V11_author_review": ("""
        SELECT author_name, author_id, primary_affiliation, country_id,
               publications, top10_publications
        FROM author_metrics ORDER BY publications DESC LIMIT 25
    """, "HUMAN: verify vs ORCID/Scopus before naming anyone in the report"),
    "V12_shape_check": ("""
        SELECT cm.country_name, f.year_id, COUNT(DISTINCT f.paper_id) AS pubs
        FROM flagged f
        JOIN pc ON pc.paper_id = f.paper_id
        JOIN country_map cm ON cm.country_id = pc.country_id
        WHERE pc.country_id IN (SELECT country_id FROM pc GROUP BY 1
                                ORDER BY COUNT(DISTINCT paper_id) DESC LIMIT 10)
        GROUP BY 1, 2 ORDER BY 1, 2
    """, "HUMAN: US/CN lead, CN rising post-2015, smooth trends, matches ASPI cast"),
}


def evaluate(name: str, df: pd.DataFrame) -> str:
    """Mechanical pass/fail where decidable; else NEEDS REVIEW."""
    try:
        if name == "V1_coverage":
            return "PASS" if df.loc[0, "coverage_pct"] >= 99 else "FAIL"
        if name == "V4_special_rules":
            return "PASS" if df.loc[0, "hk_rows"] == 0 else "FAIL"
        if name == "V6_inflation":
            r = df.loc[0, "inflation_ratio"]
            return "PASS" if 1.0 < r < 3.0 else "FAIL"
        if name == "V8a_symmetry":
            return "PASS" if df.loc[0, "asymmetric_pairs"] == 0 else "FAIL"
        if name == "V8b_pair_identity":
            return "PASS" if df.loc[0, "pair_total"] == df.loc[0, "identity_total"] else "FAIL"
        if name == "V3_unmatched_codes":
            bad = df[~df["raw_code"].isin(["(sql null)", "(empty)"])]
            return "PASS" if bad.empty else "FAIL: patch " + ", ".join(bad["raw_code"])
    except Exception as e:  # noqa: BLE001
        return f"EVAL ERROR: {e}"
    return "NEEDS REVIEW"


# =====================================================================
# PASS 1: OWNERSHIP MAPS (lowest sub_tech_id wins, within each tech_id)
# =====================================================================

def build_ownership(country_df):
    """Scan every database and, per tech_id, decide which sub_tech_id owns
    each paper and each author. Ownership = the LOWEST sub_tech_id in which
    the paper/author appears. Returns:
      paper_owners  {tech_id: DataFrame(pkey, owner_sub)}
      author_owners {tech_id: DataFrame(akey, owner_sub)}
    Matching: paper by normalised DOI else id; author by ORCID else id.
    """
    paper_best = {}    # tech_id -> {pkey: lowest_sub}
    author_best = {}   # tech_id -> {akey: lowest_sub}
    for db_path, tech_id, sub_tech_id, label in DATABASES:
        if not os.path.exists(db_path):
            continue
        con = duckdb.connect(db_path, read_only=True)
        try:
            papers = con.execute("""
                SELECT DISTINCT COALESCE(
                    NULLIF(lower(regexp_replace(doi,'^https?://(dx\\.)?doi\\.org/','')),''),
                    id) AS pkey
                FROM papers
                WHERE publication_year BETWEEN ? AND ?
            """, [YEAR_START, YEAR_END]).df()["pkey"]
            # ORCID column may be absent in older schemas; fall back to id.
            has_orcid = "orcid" in [c[0] for c in con.execute(
                "DESCRIBE authors").fetchall()]
            akey_expr = ("COALESCE(NULLIF(lower(regexp_replace(orcid,"
                         "'^https?://orcid\\.org/','')),''), id)"
                         if has_orcid else "id")
            authors = con.execute(
                f"SELECT DISTINCT {akey_expr} AS akey FROM authors").df()["akey"]
        finally:
            con.close()
        pb = paper_best.setdefault(tech_id, {})
        for k in papers:
            if k not in pb or sub_tech_id < pb[k]:
                pb[k] = sub_tech_id
        ab = author_best.setdefault(tech_id, {})
        for k in authors:
            if k not in ab or sub_tech_id < ab[k]:
                ab[k] = sub_tech_id
        print(f"  scanned {label}: {len(papers):,} papers, {len(authors):,} authors")

    paper_owners = {t: pd.DataFrame({"pkey": list(d), "owner_sub": list(d.values())})
                    for t, d in paper_best.items()}
    author_owners = {t: pd.DataFrame({"akey": list(d), "owner_sub": list(d.values())})
                     for t, d in author_best.items()}
    # report overlap removed per tech
    for t in paper_best:
        subs = sorted(set(paper_best[t].values()))
        print(f"  tech {t}: {len(paper_best[t]):,} distinct papers, "
              f"{len(author_best[t]):,} distinct authors across sub_techs {subs}")
    return paper_owners, author_owners


# =====================================================================
# MAIN
# =====================================================================

def main() -> int:
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    country_df = pd.read_excel(_resolve(COUNTRY_EXCEL))
    assert {"id", "country_code", "country_name"} <= set(country_df.columns), \
        f"{COUNTRY_EXCEL} must have columns id, country_code, country_name"

    results = {name: [] for name in INDICATORS}
    verif_rows = []
    verif_data = {name: [] for name in VERIFICATIONS}
    summary = []

    # ---- PASS 1: build ownership maps (only if dedup enabled) ----------
    paper_owners = author_owners = None
    if DEDUPLICATE_WITHIN_TECH:
        print("=== PASS 1: building cross-database ownership maps ===")
        paper_owners, author_owners = build_ownership(country_df)
        print("=== PASS 2: computing indicators on deduplicated data ===")

    for db_path, tech_id, sub_tech_id, label in DATABASES:
        if not os.path.exists(db_path):
            print(f"!! SKIPPING {label}: {db_path} not found")
            summary.append((label, tech_id, sub_tech_id, "SKIPPED - db not found"))
            continue
        print(f"\n=== {label} (tech_id={tech_id}, sub_tech_id={sub_tech_id}) :: {db_path} ===")
        con = duckdb.connect(db_path, read_only=True)
        try:
            po = paper_owners.get(tech_id) if paper_owners else None
            ao = author_owners.get(tech_id) if author_owners else None
            setup_session(con, country_df, paper_owner=po, author_owner=ao,
                          sub_tech_id=sub_tech_id)

            for name, sql in INDICATORS.items():
                df = con.execute(sql.format(t=tech_id, s=sub_tech_id,
                                            india=INDIA_COUNTRY_ID)).df()
                results[name].append(df)
                print(f"  {name}: {len(df)} rows")

            for name, (sql, expectation) in VERIFICATIONS.items():
                df = con.execute(sql).df()
                df.insert(0, "sub_tech_id", sub_tech_id)
                df.insert(0, "tech_id", tech_id)
                df.insert(0, "database", label)
                verif_data[name].append(df)
                verdict = evaluate(name, df.drop(columns=["database", "tech_id", "sub_tech_id"])
                                   .reset_index(drop=True))
                verif_rows.append({"database": label, "tech_id": tech_id,
                                   "sub_tech_id": sub_tech_id,
                                   "check": name, "expectation": expectation,
                                   "verdict": verdict})
                print(f"  {name}: {verdict}")
            summary.append((label, tech_id, sub_tech_id, "OK"))
        finally:
            con.close()

    # ---- results: ONE Excel file per indicator (stacked across sub-techs)
    results_dir = os.path.join(OUTPUT_DIR, "CTT_bibliometrics")
    os.makedirs(results_dir, exist_ok=True)

    techs = "; ".join(f"{t}/{s}={lbl}" for _, t, s, lbl in DATABASES)
    meta = pd.DataFrame({
        "key": ["generated", "technologies (tech_id/sub_tech_id)", "years",
                "type_filter", "excellence_definition", "counting",
                "special_rules", "cross_tech_caution"],
        "value": [datetime.datetime.now().isoformat(timespec="seconds"),
                  techs, f"{YEAR_START}-{YEAR_END} (year_id 1-22)",
                  str(TYPE_FILTER),
                  "within-corpus PERCENT_RANK per publication year on cited_by_count",
                  "whole counting (paper counts once per distinct country)",
                  "HK(38)->CN(7); GB/constituents->UK(6), never ranked separately",
                  "excellence percentiles are within EACH technology's own corpus; "
                  "top-10%/1% shares are NOT comparable across tech_id"],
    })
    meta.to_excel(os.path.join(results_dir, "00_README.xlsx"), index=False)
    n_written = 0
    for name, frames in results.items():
        if frames:
            path = os.path.join(results_dir, f"{name}.xlsx")
            pd.concat(frames, ignore_index=True).to_excel(path, index=False)
            n_written += 1
    print(f"\nResults: {n_written} indicator files + README in {results_dir}/")

    # ---- overall dashboard: country x year x sub-technology, all techs stacked
    # Exactly the ten dashboard columns, in the requested order. This is the
    # Q1_year_country indicator re-emitted as a single, clearly-named file so the
    # dashboard has one canonical source rather than an indicator-named one.
    DASHBOARD_COLS = [
        "tech_id", "sub_tech_id", "year_id", "country_name", "country_id",
        "total_publication", "top_10_publication_count",
        "top_10_publication_percentage", "top_1_publication_count",
        "top_1_publication_percentage",
    ]
    dash_frames = results.get("Q1_year_country", [])
    if dash_frames:
        dash = pd.concat(dash_frames, ignore_index=True)
        missing = [c for c in DASHBOARD_COLS if c not in dash.columns]
        if missing:
            print(f"!! dashboard: Q1 output missing columns {missing}; file not written")
        else:
            dash = (dash[DASHBOARD_COLS]
                    .sort_values(["tech_id", "sub_tech_id", "year_id",
                                  "total_publication"],
                                 ascending=[True, True, True, False])
                    .reset_index(drop=True))
            dash_path = os.path.join(OUTPUT_DIR, "CTT_dashboard_overall.xlsx")
            dash.to_excel(dash_path, index=False)
            print(f"Dashboard: {len(dash):,} rows across "
                  f"{dash[['tech_id','sub_tech_id']].drop_duplicates().shape[0]} "
                  f"sub-technologies -> {dash_path}")
    else:
        print("!! dashboard: no Q1_year_country frames; file not written")

    # ---- verification: ONE Excel file per check, plus a SUMMARY file
    verify_dir = os.path.join(OUTPUT_DIR, "CTT_verification")
    os.makedirs(verify_dir, exist_ok=True)
    pd.DataFrame(verif_rows).to_excel(
        os.path.join(verify_dir, "00_SUMMARY.xlsx"), index=False)
    v_written = 0
    for name, frames in verif_data.items():
        if frames:
            path = os.path.join(verify_dir, f"{name}.xlsx")
            pd.concat(frames, ignore_index=True).to_excel(path, index=False)
            v_written += 1
    print(f"Verification: {v_written} check files + SUMMARY in {verify_dir}/")

    print("\nRun summary:")
    for label, tech_id, st, status in summary:
        print(f"  [tech {tech_id} / sub {st}] {label}: {status}")
    failed = [r for r in verif_rows if r["verdict"].startswith("FAIL")]
    if failed:
        print(f"\n!! {len(failed)} verification FAILURES - "
              f"do not use outputs until resolved (see {VERIFY_XLSX} SUMMARY).")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
