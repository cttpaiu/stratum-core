// src/lib/mock-stratum.ts

export interface MockPaper {
  id: string
  title: string
  doi: string
  publication_year: number
  journal_name: string
  is_oa: boolean
  cited_by_count: number
  fwci: number
}

export interface MockContribution {
  row_id: number
  paper_id: string
  author_name: string
  institution_name: string
  country_code: string
  author_position: string
}

export interface DashboardMetrics {
  totalPapers: number
  openAccessCount: number
  imputedInstitutions: number
  unresolvedAffiliations: number
}

// 1. Dashboard Metrics
export const mockMetrics: DashboardMetrics = {
  totalPapers: 12450,
  openAccessCount: 8715,
  imputedInstitutions: 3820,
  unresolvedAffiliations: 142,
}

// 2. Mock Papers Data
export const mockPapers: MockPaper[] = [
  {
    id: 'w4389021481',
    title: 'Model Context Protocol: A Standardized API for AI Agent Tooling',
    doi: '10.48550/arxiv.2406.12345',
    publication_year: 2024,
    journal_name: 'arXiv preprint',
    is_oa: true,
    cited_by_count: 48,
    fwci: 2.45,
  },
  {
    id: 'w4312984920',
    title: 'Fuzzy String Alignment at Scale for Academic Metadata Cross-Linking',
    doi: '10.1016/j.joi.2023.101452',
    publication_year: 2023,
    journal_name: 'Journal of Informetrics',
    is_oa: false,
    cited_by_count: 12,
    fwci: 1.15,
  },
  {
    id: 'w4289043211',
    title: 'Measuring Scientific Impact: OpenAccess vs Paywalled Distribution Models',
    doi: '10.1371/journal.pone.0289124',
    publication_year: 2022,
    journal_name: 'PLOS ONE',
    is_oa: true,
    cited_by_count: 89,
    fwci: 1.62,
  },
  {
    id: 'w4392019482',
    title: 'Ingestion of Semi-Structured JSONL In Bibliometric Databases',
    doi: '10.1109/tse.2024.3214521',
    publication_year: 2024,
    journal_name: 'IEEE Transactions on Software Engineering',
    is_oa: false,
    cited_by_count: 5,
    fwci: 0.98,
  },
  {
    id: 'w4210984931',
    title: 'Pure Go In-Memory PDF Parser using Object Stream Decompression',
    doi: '10.5281/zenodo.5123984',
    publication_year: 2021,
    journal_name: 'SoftwareX',
    is_oa: true,
    cited_by_count: 22,
    fwci: 1.41,
  },
]

// 3. Mock Contributions Data
export const mockContributions: MockContribution[] = [
  {
    row_id: 1,
    paper_id: 'w4389021481',
    author_name: 'John Doe',
    institution_name: 'Stanford University',
    country_code: 'US',
    author_position: 'first',
  },
  {
    row_id: 2,
    paper_id: 'w4389021481',
    author_name: 'Jane Smith',
    institution_name: 'Tsinghua University',
    country_code: 'CN',
    author_position: 'last',
  },
  {
    row_id: 3,
    paper_id: 'w4312984920',
    author_name: 'Hiroshi Tanaka',
    institution_name: 'University of Tokyo',
    country_code: 'JP',
    author_position: 'first',
  },
  {
    row_id: 4,
    paper_id: 'w4289043211',
    author_name: 'Elena Rostova',
    institution_name: 'Sorbonne University',
    country_code: 'FR',
    author_position: 'middle',
  },
]

// 4. Mock SQL Schema Info
export interface TableField {
  name: string
  type: string
  description?: string
}

export interface TableSchema {
  name: string
  fields: TableField[]
}

export const mockSchemas: TableSchema[] = [
  {
    name: 'papers',
    fields: [
      { name: 'id', type: 'VARCHAR', description: 'Primary OpenAlex ID (e.g. w4389021481)' },
      { name: 'doi', type: 'VARCHAR', description: 'Digital Object Identifier' },
      { name: 'title', type: 'TEXT', description: 'Cleaned English title' },
      { name: 'publication_year', type: 'INTEGER', description: 'Year of publication' },
      {
        name: 'publication_date',
        type: 'VARCHAR',
        description: 'Exact publication date YYYY-MM-DD',
      },
      { name: 'type', type: 'VARCHAR', description: 'Document type (e.g. journal-article)' },
      { name: 'journal_name', type: 'VARCHAR', description: 'Source journal display name' },
      { name: 'journal_issn', type: 'VARCHAR', description: 'Source journal ISSN' },
      { name: 'is_core_journal', type: 'BOOLEAN', description: 'Flag for core venue coverage' },
      { name: 'publisher', type: 'VARCHAR', description: 'Host publishing house name' },
      { name: 'is_oa', type: 'BOOLEAN', description: 'Open Access flag status' },
      { name: 'oa_status', type: 'VARCHAR', description: 'Open Access status (e.g. gold, hybrid)' },
      { name: 'oa_url', type: 'VARCHAR', description: 'URL link to Open Access copy' },
      { name: 'cited_by_count', type: 'INTEGER', description: 'Total incoming citations' },
      {
        name: 'citation_percentile',
        type: 'DOUBLE',
        description: 'Citation normalized percentile score',
      },
      {
        name: 'is_top_1_percent',
        type: 'BOOLEAN',
        description: 'True if in the top 1% cited works',
      },
      {
        name: 'is_top_10_percent',
        type: 'BOOLEAN',
        description: 'True if in the top 10% cited works',
      },
      { name: 'fwci', type: 'DOUBLE', description: 'Field Weighted Citation Impact' },
      {
        name: 'primary_topic_id',
        type: 'VARCHAR',
        description: 'Primary topic OpenAlex ID (e.g. T10012)',
      },
      { name: 'primary_topic_name', type: 'VARCHAR', description: 'Primary topic display name' },
      {
        name: 'primary_topic_score',
        type: 'DOUBLE',
        description: 'Topic classification confidence score',
      },
      { name: 'primary_topic_field', type: 'VARCHAR', description: 'Broader research field name' },
      {
        name: 'primary_topic_subfield',
        type: 'VARCHAR',
        description: 'Research subfield category',
      },
      { name: 'primary_topic_domain', type: 'VARCHAR', description: 'Top-level scientific domain' },
      {
        name: 'institutions_distinct_count',
        type: 'INTEGER',
        description: 'Total unique institutions contributing',
      },
      {
        name: 'countries_distinct_count',
        type: 'INTEGER',
        description: 'Total unique countries contributing',
      },
      {
        name: 'is_international',
        type: 'BOOLEAN',
        description: 'True if multi-country collaboration',
      },
      { name: 'abstract_text', type: 'TEXT', description: 'Reconstructed plain text abstract' },
      { name: 'updated_date', type: 'VARCHAR', description: 'Last OpenAlex metadata update' },
    ],
  },
  {
    name: 'authors',
    fields: [
      { name: 'id', type: 'VARCHAR', description: 'OpenAlex Author ID' },
      { name: 'display_name', type: 'VARCHAR', description: 'Full researcher name' },
      { name: 'orcid', type: 'VARCHAR', description: 'ORCID researcher identifier' },
    ],
  },
  {
    name: 'institutions',
    fields: [
      { name: 'id', type: 'VARCHAR', description: 'Primary ID or synthetic IMP_ prefix' },
      { name: 'display_name', type: 'VARCHAR', description: 'Standard organization name' },
      { name: 'country_code', type: 'VARCHAR', description: 'Country affiliation code' },
      { name: 'type', type: 'VARCHAR', description: 'education, facility, healthcare, etc.' },
      { name: 'ror_id', type: 'VARCHAR', description: 'ROR identifier' },
      { name: 'is_synthetic', type: 'BOOLEAN', description: 'True if generated from imputation' },
    ],
  },
  {
    name: 'countries',
    fields: [
      { name: 'id', type: 'INTEGER', description: 'Numerical country index' },
      { name: 'country_name', type: 'VARCHAR', description: 'Full country name' },
      { name: 'country_code', type: 'VARCHAR', description: 'ISO 2-letter unique code' },
      { name: 'status', type: 'INTEGER', description: 'Country status value' },
    ],
  },
  {
    name: 'contributions',
    fields: [
      { name: 'row_id', type: 'INTEGER', description: 'Unique primary row ID' },
      { name: 'paper_id', type: 'VARCHAR', description: 'Linked paper.id value' },
      { name: 'author_id', type: 'VARCHAR', description: 'Linked author.id value' },
      { name: 'institution_id', type: 'VARCHAR', description: 'Linked institution ID' },
      {
        name: 'country_code',
        type: 'VARCHAR',
        description: 'ISO-3166-1 alpha-2 code of affiliation',
      },
      { name: 'author_name', type: 'VARCHAR', description: 'Author display name' },
      { name: 'author_position', type: 'VARCHAR', description: 'first, last, or middle' },
      { name: 'is_corresponding', type: 'BOOLEAN', description: 'True if corresponding author' },
      {
        name: 'raw_affiliation_string',
        type: 'VARCHAR',
        description: 'Original parsed metadata string',
      },
    ],
  },
]

export const mockQueries = [
  {
    label: 'Top 15 Country Rankings by Output & Share (Graph-Ready)',
    sql: `SELECT 
    ROW_NUMBER() OVER (ORDER BY COUNT(DISTINCT paper_id) DESC) AS rank,
    country_code,
    COUNT(DISTINCT paper_id) AS paper_count,
    COUNT(*) AS total_contributions,
    ROUND(COUNT(DISTINCT paper_id) * 100.0 / NULLIF(SUM(COUNT(DISTINCT paper_id)) OVER (), 0), 2) AS share_pct
FROM contributions
WHERE country_code IS NOT NULL AND TRIM(country_code) != ''
GROUP BY country_code
ORDER BY rank ASC
LIMIT 15;`,
  },
  {
    label: 'Show Tables in Database',
    sql: `SHOW TABLES;`,
  },
  {
    label: 'Table Row Counts Summary',
    sql: `SELECT 'papers' AS table_name, count(*) AS count FROM papers
UNION ALL
SELECT 'authors', count(*) FROM authors
UNION ALL
SELECT 'institutions', count(*) FROM institutions
UNION ALL
SELECT 'contributions', count(*) FROM contributions
UNION ALL
SELECT 'countries', count(*) FROM countries;`,
  },
  {
    label: 'Publication Year Distribution (papers)',
    sql: `SELECT publication_year,
       COUNT(*) as total_papers,
       SUM(CASE WHEN is_oa = TRUE THEN 1 ELSE 0 END) as open_access
FROM papers
GROUP BY publication_year
ORDER BY publication_year DESC;`,
  },
  {
    label: 'Top 10 Affiliated Countries (contributions)',
    sql: `SELECT country_code,
       COUNT(*) as contribution_count
FROM contributions
WHERE country_code IS NOT NULL
GROUP BY country_code
ORDER BY contribution_count DESC
LIMIT 10;`,
  },
  {
    label: 'Query Downloaded JSONL Directly',
    sql: `SELECT id, title, publication_year, cited_by_count
FROM read_json_auto('data/jsonl/*.jsonl')
LIMIT 10;`,
  },
  {
    label: 'List Synthetic Imputed Institutions',
    sql: `SELECT id, display_name, country_code, type
FROM institutions
WHERE is_synthetic = TRUE
ORDER BY display_name ASC
LIMIT 5;`,
  },
]

// Helper function to execute mock query and return rows and columns
export function executeMockQuery(sqlQuery: string): {
  columns: string[]
  rows: Record<string, string | number | boolean>[]
} {
  const queryClean = sqlQuery.toLowerCase().replace(/\s+/g, ' ')

  if (
    queryClean.includes('country_a') ||
    queryClean.includes('c1.country_code < c2.country_code') ||
    queryClean.includes('bilateral') ||
    queryClean.includes('collaboration_count')
  ) {
    return {
      columns: [
        'rank',
        'country_a',
        'country_b',
        'collaboration_count',
        'top_10pct_collabs',
        'top_1pct_collabs',
        'share_pct',
      ],
      rows: [
        { rank: 1, country_a: 'CN', country_b: 'US', collaboration_count: 1420, top_10pct_collabs: 512, top_1pct_collabs: 118, share_pct: 18.52 },
        { rank: 2, country_a: 'GB', country_b: 'US', collaboration_count: 530, top_10pct_collabs: 215, top_1pct_collabs: 52, share_pct: 6.91 },
        { rank: 3, country_a: 'IN', country_b: 'US', collaboration_count: 482, top_10pct_collabs: 178, top_1pct_collabs: 42, share_pct: 6.29 },
        { rank: 4, country_a: 'CA', country_b: 'US', collaboration_count: 410, top_10pct_collabs: 165, top_1pct_collabs: 38, share_pct: 5.35 },
        { rank: 5, country_a: 'DE', country_b: 'US', collaboration_count: 385, top_10pct_collabs: 154, top_1pct_collabs: 35, share_pct: 5.02 },
        { rank: 6, country_a: 'AU', country_b: 'CN', collaboration_count: 342, top_10pct_collabs: 138, top_1pct_collabs: 31, share_pct: 4.46 },
        { rank: 7, country_a: 'CN', country_b: 'GB', collaboration_count: 315, top_10pct_collabs: 124, top_1pct_collabs: 28, share_pct: 4.11 },
        { rank: 8, country_a: 'AU', country_b: 'US', collaboration_count: 290, top_10pct_collabs: 112, top_1pct_collabs: 25, share_pct: 3.78 },
        { rank: 9, country_a: 'GB', country_b: 'IN', collaboration_count: 275, top_10pct_collabs: 98, top_1pct_collabs: 21, share_pct: 3.59 },
        { rank: 10, country_a: 'FR', country_b: 'US', collaboration_count: 254, top_10pct_collabs: 96, top_1pct_collabs: 20, share_pct: 3.31 },
        { rank: 11, country_a: 'JP', country_b: 'US', collaboration_count: 248, top_10pct_collabs: 92, top_1pct_collabs: 19, share_pct: 3.23 },
        { rank: 12, country_a: 'CN', country_b: 'SG', collaboration_count: 236, top_10pct_collabs: 95, top_1pct_collabs: 22, share_pct: 3.08 },
        { rank: 13, country_a: 'DE', country_b: 'IN', collaboration_count: 215, top_10pct_collabs: 82, top_1pct_collabs: 17, share_pct: 2.80 },
        { rank: 14, country_a: 'DE', country_b: 'GB', collaboration_count: 208, top_10pct_collabs: 79, top_1pct_collabs: 16, share_pct: 2.71 },
        { rank: 15, country_a: 'CN', country_b: 'KR', collaboration_count: 195, top_10pct_collabs: 74, top_1pct_collabs: 15, share_pct: 2.54 },
        { rank: 16, country_a: 'AU', country_b: 'IN', collaboration_count: 182, top_10pct_collabs: 68, top_1pct_collabs: 14, share_pct: 2.37 },
        { rank: 17, country_a: 'CA', country_b: 'IN', collaboration_count: 165, top_10pct_collabs: 61, top_1pct_collabs: 12, share_pct: 2.15 },
        { rank: 18, country_a: 'FR', country_b: 'GB', collaboration_count: 158, top_10pct_collabs: 58, top_1pct_collabs: 11, share_pct: 2.06 },
        { rank: 19, country_a: 'CH', country_b: 'DE', collaboration_count: 149, top_10pct_collabs: 55, top_1pct_collabs: 12, share_pct: 1.94 },
        { rank: 20, country_a: 'CN', country_b: 'IN', collaboration_count: 138, top_10pct_collabs: 49, top_1pct_collabs: 9, share_pct: 1.80 },
      ],
    }
  }

  if (
    (queryClean.includes('is_top_1_percent') || queryClean.includes('top_1pct')) &&
    (queryClean.includes('is_top_10_percent') || queryClean.includes('top_10pct'))
  ) {
    return {
      columns: [
        'year',
        'total_papers',
        'top_1pct_papers',
        'top_10pct_rest_papers',
        'top_10pct_total_papers',
        'top_1pct_share',
        'top_10pct_share',
        'top_1pct_yoy_pct',
        'top_10pct_yoy_pct',
        'total_yoy_pct',
      ],
      rows: [
        {
          year: 2021,
          total_papers: 410,
          top_1pct_papers: 15,
          top_10pct_rest_papers: 55,
          top_10pct_total_papers: 70,
          top_1pct_share: 3.66,
          top_10pct_share: 17.07,
          top_1pct_yoy_pct: 0,
          top_10pct_yoy_pct: 0,
          total_yoy_pct: 0,
        },
        {
          year: 2022,
          total_papers: 2120,
          top_1pct_papers: 92,
          top_10pct_rest_papers: 328,
          top_10pct_total_papers: 420,
          top_1pct_share: 4.34,
          top_10pct_share: 19.81,
          top_1pct_yoy_pct: 513.33,
          top_10pct_yoy_pct: 500.00,
          total_yoy_pct: 417.07,
        },
        {
          year: 2023,
          total_papers: 4100,
          top_1pct_papers: 245,
          top_10pct_rest_papers: 755,
          top_10pct_total_papers: 1000,
          top_1pct_share: 5.98,
          top_10pct_share: 24.39,
          top_1pct_yoy_pct: 166.30,
          top_10pct_yoy_pct: 138.10,
          total_yoy_pct: 93.40,
        },
        {
          year: 2024,
          total_papers: 5820,
          top_1pct_papers: 461,
          top_10pct_rest_papers: 1389,
          top_10pct_total_papers: 1850,
          top_1pct_share: 7.92,
          top_10pct_share: 31.79,
          top_1pct_yoy_pct: 88.16,
          top_10pct_yoy_pct: 85.00,
          total_yoy_pct: 41.95,
        },
      ],
    }
  }

  if (
    queryClean.includes('lag(') ||
    queryClean.includes('prev_year_papers') ||
    queryClean.includes('yoy') ||
    queryClean.includes('cagr')
  ) {
    return {
      columns: ['year', 'paper_count', 'prev_year_papers', 'yoy_growth_pct'],
      rows: [
        { year: 2021, paper_count: 410, prev_year_papers: 0, yoy_growth_pct: 0 },
        { year: 2022, paper_count: 2120, prev_year_papers: 410, yoy_growth_pct: 417.07 },
        { year: 2023, paper_count: 4100, prev_year_papers: 2120, yoy_growth_pct: 93.40 },
        { year: 2024, paper_count: 5820, prev_year_papers: 4100, yoy_growth_pct: 41.95 },
      ],
    }
  }

  if (queryClean.includes('publication_year') || queryClean.includes('trajectory')) {
    return {
      columns: ['year', 'paper_count'],
      rows: [
        { year: 2024, paper_count: 5820 },
        { year: 2023, paper_count: 4100 },
        { year: 2022, paper_count: 2120 },
        { year: 2021, paper_count: 410 },
      ],
    }
  }

  if (queryClean.includes('institution')) {
    if (queryClean.includes('is_top_1_percent') || queryClean.includes('top_1pct')) {
      return {
        columns: ['rank', 'institution_name', 'country_code', 'top_1pct_papers', 'total_papers', 'top_1pct_rate', 'share_pct'],
        rows: [
          { rank: 1, institution_name: 'Harbin Engineering University', country_code: 'CN', top_1pct_papers: 142, total_papers: 963, top_1pct_rate: 14.75, share_pct: 21.5 },
          { rank: 2, institution_name: 'Massachusetts Institute of Technology', country_code: 'US', top_1pct_papers: 88, total_papers: 380, top_1pct_rate: 23.16, share_pct: 13.3 },
          { rank: 3, institution_name: 'Northwestern Polytechnical University', country_code: 'CN', top_1pct_papers: 76, total_papers: 724, top_1pct_rate: 10.50, share_pct: 11.5 },
          { rank: 4, institution_name: 'Woods Hole Oceanographic Institution', country_code: 'US', top_1pct_papers: 65, total_papers: 420, top_1pct_rate: 15.48, share_pct: 9.8 },
          { rank: 5, institution_name: 'University of Southampton', country_code: 'GB', top_1pct_papers: 54, total_papers: 310, top_1pct_rate: 17.42, share_pct: 8.2 },
          { rank: 6, institution_name: 'Shanghai Jiao Tong University', country_code: 'CN', top_1pct_papers: 48, total_papers: 512, top_1pct_rate: 9.38, share_pct: 7.3 },
          { rank: 7, institution_name: 'Indian Institute of Science', country_code: 'IN', top_1pct_papers: 32, total_papers: 240, top_1pct_rate: 13.33, share_pct: 4.8 },
          { rank: 8, institution_name: 'University of Tokyo', country_code: 'JP', top_1pct_papers: 28, total_papers: 195, top_1pct_rate: 14.36, share_pct: 4.2 },
          { rank: 9, institution_name: 'Korea Maritime & Ocean University', country_code: 'KR', top_1pct_papers: 24, total_papers: 210, top_1pct_rate: 11.43, share_pct: 3.6 },
          { rank: 10, institution_name: 'Dalian Maritime University', country_code: 'CN', top_1pct_papers: 22, total_papers: 285, top_1pct_rate: 7.72, share_pct: 3.3 },
        ],
      }
    }

    if (queryClean.includes('is_top_10_percent') || queryClean.includes('top_10pct')) {
      return {
        columns: ['rank', 'institution_name', 'country_code', 'top_10pct_papers', 'total_papers', 'top_10pct_rate', 'share_pct'],
        rows: [
          { rank: 1, institution_name: 'Harbin Engineering University', country_code: 'CN', top_10pct_papers: 485, total_papers: 963, top_10pct_rate: 50.36, share_pct: 18.2 },
          { rank: 2, institution_name: 'Northwestern Polytechnical University', country_code: 'CN', top_10pct_papers: 340, total_papers: 724, top_10pct_rate: 46.96, share_pct: 12.8 },
          { rank: 3, institution_name: 'Shanghai Jiao Tong University', country_code: 'CN', top_10pct_papers: 268, total_papers: 512, top_10pct_rate: 52.34, share_pct: 10.1 },
          { rank: 4, institution_name: 'Woods Hole Oceanographic Institution', country_code: 'US', top_10pct_papers: 235, total_papers: 420, top_10pct_rate: 55.95, share_pct: 8.8 },
          { rank: 5, institution_name: 'Massachusetts Institute of Technology', country_code: 'US', top_10pct_papers: 228, total_papers: 380, top_10pct_rate: 60.00, share_pct: 8.6 },
          { rank: 6, institution_name: 'University of Southampton', country_code: 'GB', top_10pct_papers: 172, total_papers: 310, top_10pct_rate: 55.48, share_pct: 6.5 },
          { rank: 7, institution_name: 'Dalian Maritime University', country_code: 'CN', top_10pct_papers: 148, total_papers: 285, top_10pct_rate: 51.93, share_pct: 5.6 },
          { rank: 8, institution_name: 'Indian Institute of Science', country_code: 'IN', top_10pct_papers: 124, total_papers: 240, top_10pct_rate: 51.67, share_pct: 4.7 },
          { rank: 9, institution_name: 'Korea Maritime & Ocean University', country_code: 'KR', top_10pct_papers: 112, total_papers: 210, top_10pct_rate: 53.33, share_pct: 4.2 },
          { rank: 10, institution_name: 'University of Tokyo', country_code: 'JP', top_10pct_papers: 105, total_papers: 195, top_10pct_rate: 53.85, share_pct: 3.9 },
        ],
      }
    }

    return {
      columns: ['rank', 'institution_name', 'country_code', 'paper_count', 'total_contributions', 'share_pct'],
      rows: [
        { rank: 1, institution_name: 'Harbin Engineering University', country_code: 'CN', paper_count: 963, total_contributions: 4210, share_pct: 16.5 },
        { rank: 2, institution_name: 'Northwestern Polytechnical University', country_code: 'CN', paper_count: 724, total_contributions: 3105, share_pct: 12.4 },
        { rank: 3, institution_name: 'Shanghai Jiao Tong University', country_code: 'CN', paper_count: 512, total_contributions: 2410, share_pct: 8.8 },
        { rank: 4, institution_name: 'Woods Hole Oceanographic Institution', country_code: 'US', paper_count: 420, total_contributions: 1650, share_pct: 7.2 },
        { rank: 5, institution_name: 'Massachusetts Institute of Technology', country_code: 'US', paper_count: 380, total_contributions: 1420, share_pct: 6.5 },
        { rank: 6, institution_name: 'University of Southampton', country_code: 'GB', paper_count: 310, total_contributions: 1120, share_pct: 5.3 },
        { rank: 7, institution_name: 'Dalian Maritime University', country_code: 'CN', paper_count: 285, total_contributions: 1040, share_pct: 4.9 },
        { rank: 8, institution_name: 'Indian Institute of Science', country_code: 'IN', paper_count: 240, total_contributions: 890, share_pct: 4.1 },
        { rank: 9, institution_name: 'Korea Maritime & Ocean University', country_code: 'KR', paper_count: 210, total_contributions: 780, share_pct: 3.6 },
        { rank: 10, institution_name: 'University of Tokyo', country_code: 'JP', paper_count: 195, total_contributions: 710, share_pct: 3.3 },
      ],
    }
  }

  if (queryClean.includes('author_name')) {
    if (queryClean.includes("country_code = 'in'") || queryClean.includes("country_code = 'IN'")) {
      return {
        columns: ['rank', 'author_name', 'country_code', 'paper_count', 'top_1pct_papers', 'top_10pct_papers', 'total_citations', 'share_pct'],
        rows: [
          { rank: 1, author_name: 'Neeraj Kumar', country_code: 'IN', paper_count: 36, top_1pct_papers: 9, top_10pct_papers: 30, total_citations: 3915, share_pct: 3.55 },
          { rank: 2, author_name: 'Sudeep Tanwar', country_code: 'IN', paper_count: 21, top_1pct_papers: 5, top_10pct_papers: 17, total_citations: 1382, share_pct: 2.07 },
          { rank: 3, author_name: 'Ashu Taneja', country_code: 'IN', paper_count: 19, top_1pct_papers: 0, top_10pct_papers: 3, total_citations: 190, share_pct: 1.87 },
          { rank: 4, author_name: 'Shalli Rani', country_code: 'IN', paper_count: 16, top_1pct_papers: 1, top_10pct_papers: 4, total_citations: 220, share_pct: 1.58 },
          { rank: 5, author_name: 'Arun Kumar', country_code: 'IN', paper_count: 11, top_1pct_papers: 1, top_10pct_papers: 3, total_citations: 88, share_pct: 1.08 },
          { rank: 6, author_name: 'Vimal Bhatia', country_code: 'IN', paper_count: 10, top_1pct_papers: 0, top_10pct_papers: 2, total_citations: 130, share_pct: 0.99 },
          { rank: 7, author_name: 'Rajesh Gupta', country_code: 'IN', paper_count: 10, top_1pct_papers: 3, top_10pct_papers: 8, total_citations: 708, share_pct: 0.99 },
          { rank: 8, author_name: 'Rakesh Kumar Jha', country_code: 'IN', paper_count: 10, top_1pct_papers: 1, top_10pct_papers: 3, total_citations: 713, share_pct: 0.99 },
          { rank: 9, author_name: 'Pronaya Bhattacharya', country_code: 'IN', paper_count: 9, top_1pct_papers: 1, top_10pct_papers: 7, total_citations: 464, share_pct: 0.89 },
          { rank: 10, author_name: 'Sanjeev Sharma', country_code: 'IN', paper_count: 9, top_1pct_papers: 1, top_10pct_papers: 2, total_citations: 197, share_pct: 0.89 },
        ],
      }
    }

    return {
      columns: ['rank', 'author_name', 'country_code', 'paper_count', 'top_1pct_papers', 'top_10pct_papers', 'total_citations', 'share_pct'],
      rows: [
        { rank: 1, author_name: 'Zhu Han', country_code: 'US', paper_count: 90, top_1pct_papers: 30, top_10pct_papers: 68, total_citations: 9575, share_pct: 0.96 },
        { rank: 2, author_name: 'Dusit Niyato', country_code: 'SG', paper_count: 86, top_1pct_papers: 29, top_10pct_papers: 59, total_citations: 7229, share_pct: 0.92 },
        { rank: 3, author_name: 'Cheng-Xiang Wang', country_code: 'GB', paper_count: 57, top_1pct_papers: 13, top_10pct_papers: 32, total_citations: 13318, share_pct: 0.61 },
        { rank: 4, author_name: 'Nei Kato', country_code: 'JP', paper_count: 56, top_1pct_papers: 21, top_10pct_papers: 46, total_citations: 5667, share_pct: 0.60 },
        { rank: 5, author_name: 'Mohamed-Slim Alouini', country_code: 'US', paper_count: 54, top_1pct_papers: 21, top_10pct_papers: 37, total_citations: 7851, share_pct: 0.58 },
        { rank: 6, author_name: 'H. Vincent Poor', country_code: 'US', paper_count: 54, top_1pct_papers: 18, top_10pct_papers: 36, total_citations: 11890, share_pct: 0.58 },
        { rank: 7, author_name: 'Chau Yuen', country_code: 'SG', paper_count: 51, top_1pct_papers: 18, top_10pct_papers: 30, total_citations: 3186, share_pct: 0.55 },
        { rank: 8, author_name: 'Xiaohu You', country_code: 'CN', paper_count: 49, top_1pct_papers: 10, top_10pct_papers: 25, total_citations: 13596, share_pct: 0.52 },
        { rank: 9, author_name: 'Bo Ai', country_code: 'US', paper_count: 48, top_1pct_papers: 6, top_10pct_papers: 24, total_citations: 2688, share_pct: 0.51 },
        { rank: 10, author_name: 'Mohsen Guizani', country_code: 'QA', paper_count: 48, top_1pct_papers: 7, top_10pct_papers: 31, total_citations: 1667, share_pct: 0.51 },
      ],
    }
  }

  if (queryClean.includes('is_top_1_percent') || queryClean.includes('top_1pct')) {
    return {
      columns: ['rank', 'country_code', 'top_1pct_papers', 'total_papers', 'top_1pct_rate', 'share_pct'],
      rows: [
        { rank: 1, country_code: 'CN', top_1pct_papers: 461, total_papers: 3470, top_1pct_rate: 13.29, share_pct: 53.05 },
        { rank: 2, country_code: 'US', top_1pct_papers: 184, total_papers: 1170, top_1pct_rate: 15.73, share_pct: 21.17 },
        { rank: 3, country_code: 'GB', top_1pct_papers: 131, total_papers: 885, top_1pct_rate: 14.80, share_pct: 15.07 },
        { rank: 4, country_code: 'SA', top_1pct_papers: 90, total_papers: 532, top_1pct_rate: 16.92, share_pct: 10.36 },
        { rank: 5, country_code: 'CA', top_1pct_papers: 90, total_papers: 535, top_1pct_rate: 16.82, share_pct: 10.36 },
        { rank: 6, country_code: 'KR', top_1pct_papers: 90, total_papers: 601, top_1pct_rate: 14.98, share_pct: 10.36 },
        { rank: 7, country_code: 'SG', top_1pct_papers: 62, total_papers: 264, top_1pct_rate: 23.48, share_pct: 7.13 },
        { rank: 8, country_code: 'AU', top_1pct_papers: 58, total_papers: 312, top_1pct_rate: 18.59, share_pct: 6.67 },
        { rank: 9, country_code: 'FR', top_1pct_papers: 57, total_papers: 258, top_1pct_rate: 22.09, share_pct: 6.56 },
        { rank: 10, country_code: 'IN', top_1pct_papers: 57, total_papers: 1006, top_1pct_rate: 5.67, share_pct: 6.56 },
        { rank: 11, country_code: 'DE', top_1pct_papers: 56, total_papers: 350, top_1pct_rate: 16.00, share_pct: 6.44 },
        { rank: 12, country_code: 'SE', top_1pct_papers: 41, total_papers: 211, top_1pct_rate: 19.43, share_pct: 4.72 },
        { rank: 13, country_code: 'AE', top_1pct_papers: 39, total_papers: 238, top_1pct_rate: 16.39, share_pct: 4.49 },
        { rank: 14, country_code: 'JP', top_1pct_papers: 39, total_papers: 336, top_1pct_rate: 11.61, share_pct: 4.49 },
        { rank: 15, country_code: 'IT', top_1pct_papers: 34, total_papers: 318, top_1pct_rate: 10.69, share_pct: 3.91 },
      ],
    }
  }

  if (queryClean.includes('is_top_10_percent') || queryClean.includes('top_10pct')) {
    return {
      columns: ['rank', 'country_code', 'top_10pct_papers', 'total_papers', 'top_10pct_rate', 'share_pct'],
      rows: [
        { rank: 1, country_code: 'CN', top_10pct_papers: 1850, total_papers: 3470, top_10pct_rate: 53.31, share_pct: 48.20 },
        { rank: 2, country_code: 'US', top_10pct_papers: 620, total_papers: 1170, top_10pct_rate: 52.99, share_pct: 16.15 },
        { rank: 3, country_code: 'GB', top_10pct_papers: 410, total_papers: 885, top_10pct_rate: 46.33, share_pct: 10.68 },
        { rank: 4, country_code: 'KR', top_10pct_papers: 275, total_papers: 601, top_10pct_rate: 45.76, share_pct: 7.17 },
        { rank: 5, country_code: 'CA', top_10pct_papers: 245, total_papers: 535, top_10pct_rate: 45.79, share_pct: 6.38 },
        { rank: 6, country_code: 'IN', top_10pct_papers: 230, total_papers: 1006, top_10pct_rate: 22.86, share_pct: 5.99 },
        { rank: 7, country_code: 'SA', top_10pct_papers: 220, total_papers: 532, top_10pct_rate: 41.35, share_pct: 5.73 },
        { rank: 8, country_code: 'DE', top_10pct_papers: 165, total_papers: 350, top_10pct_rate: 47.14, share_pct: 4.30 },
        { rank: 9, country_code: 'AU', top_10pct_papers: 152, total_papers: 312, top_10pct_rate: 48.72, share_pct: 3.96 },
        { rank: 10, country_code: 'JP', top_10pct_papers: 140, total_papers: 336, top_10pct_rate: 41.67, share_pct: 3.65 },
        { rank: 11, country_code: 'FR', top_10pct_papers: 125, total_papers: 258, top_10pct_rate: 48.45, share_pct: 3.26 },
        { rank: 12, country_code: 'IT', top_10pct_papers: 118, total_papers: 318, top_10pct_rate: 37.11, share_pct: 3.07 },
        { rank: 13, country_code: 'SG', top_10pct_papers: 115, total_papers: 264, top_10pct_rate: 43.56, share_pct: 2.99 },
        { rank: 14, country_code: 'SE', top_10pct_papers: 95, total_papers: 211, top_10pct_rate: 45.02, share_pct: 2.47 },
        { rank: 15, country_code: 'AE', top_10pct_papers: 88, total_papers: 238, top_10pct_rate: 36.97, share_pct: 2.29 },
      ],
    }
  }

  if (
    queryClean.includes('country_a') ||
    queryClean.includes('c1.country_code < c2.country_code') ||
    queryClean.includes('bilateral') ||
    queryClean.includes('collaboration_count')
  ) {
    return {
      columns: ['rank', 'country_a', 'country_b', 'collaboration_count', 'top_10pct_collabs', 'top_1pct_collabs', 'share_pct'],
      rows: [
        { rank: 1, country_a: 'CN', country_b: 'US', collaboration_count: 1420, top_10pct_collabs: 512, top_1pct_collabs: 118, share_pct: 18.62 },
        { rank: 2, country_a: 'GB', country_b: 'US', collaboration_count: 685, top_10pct_collabs: 248, top_1pct_collabs: 64, share_pct: 8.98 },
        { rank: 3, country_a: 'CA', country_b: 'US', collaboration_count: 512, top_10pct_collabs: 195, top_1pct_collabs: 52, share_pct: 6.71 },
        { rank: 4, country_a: 'DE', country_b: 'US', collaboration_count: 482, top_10pct_collabs: 180, top_1pct_collabs: 46, share_pct: 6.32 },
        { rank: 5, country_a: 'AU', country_b: 'CN', collaboration_count: 430, top_10pct_collabs: 162, top_1pct_collabs: 38, share_pct: 5.64 },
        { rank: 6, country_a: 'IN', country_b: 'US', collaboration_count: 395, top_10pct_collabs: 98, top_1pct_collabs: 24, share_pct: 5.18 },
        { rank: 7, country_a: 'CN', country_b: 'GB', collaboration_count: 374, top_10pct_collabs: 135, top_1pct_collabs: 31, share_pct: 4.90 },
        { rank: 8, country_a: 'FR', country_b: 'US', collaboration_count: 341, top_10pct_collabs: 124, top_1pct_collabs: 29, share_pct: 4.47 },
        { rank: 9, country_a: 'JP', country_b: 'US', collaboration_count: 326, top_10pct_collabs: 112, top_1pct_collabs: 27, share_pct: 4.27 },
        { rank: 10, country_a: 'KR', country_b: 'US', collaboration_count: 310, top_10pct_collabs: 115, top_1pct_collabs: 25, share_pct: 4.06 },
        { rank: 11, country_a: 'CN', country_b: 'SG', collaboration_count: 285, top_10pct_collabs: 108, top_1pct_collabs: 28, share_pct: 3.74 },
        { rank: 12, country_a: 'DE', country_b: 'FR', collaboration_count: 275, top_10pct_collabs: 96, top_1pct_collabs: 22, share_pct: 3.61 },
        { rank: 13, country_a: 'CA', country_b: 'CN', collaboration_count: 260, top_10pct_collabs: 88, top_1pct_collabs: 20, share_pct: 3.41 },
        { rank: 14, country_a: 'GB', country_b: 'IN', collaboration_count: 218, top_10pct_collabs: 54, top_1pct_collabs: 14, share_pct: 2.86 },
        { rank: 15, country_a: 'DE', country_b: 'GB', collaboration_count: 205, top_10pct_collabs: 72, top_1pct_collabs: 16, share_pct: 2.69 },
        { rank: 16, country_a: 'AU', country_b: 'US', collaboration_count: 198, top_10pct_collabs: 69, top_1pct_collabs: 15, share_pct: 2.60 },
        { rank: 17, country_a: 'DE', country_b: 'IN', collaboration_count: 164, top_10pct_collabs: 41, top_1pct_collabs: 10, share_pct: 2.15 },
        { rank: 18, country_a: 'AU', country_b: 'IN', collaboration_count: 142, top_10pct_collabs: 36, top_1pct_collabs: 8, share_pct: 1.86 },
        { rank: 19, country_a: 'CA', country_b: 'IN', collaboration_count: 128, top_10pct_collabs: 32, top_1pct_collabs: 7, share_pct: 1.68 },
        { rank: 20, country_a: 'CN', country_b: 'IN', collaboration_count: 115, top_10pct_collabs: 29, top_1pct_collabs: 6, share_pct: 1.51 },
      ],
    }
  }

  if (queryClean.includes('rank') && (queryClean.includes('country') || queryClean.includes('contributions'))) {
    return {
      columns: ['rank', 'country_code', 'paper_count', 'total_contributions', 'share_pct'],
      rows: [
        { rank: 1, country_code: 'CN', paper_count: 5186, total_contributions: 25928, share_pct: 43.83 },
        { rank: 2, country_code: 'US', paper_count: 1237, total_contributions: 4124, share_pct: 10.45 },
        { rank: 3, country_code: 'KR', paper_count: 485, total_contributions: 1765, share_pct: 4.10 },
        { rank: 4, country_code: 'GB', paper_count: 462, total_contributions: 1315, share_pct: 3.90 },
        { rank: 5, country_code: 'IN', paper_count: 359, total_contributions: 1102, share_pct: 3.03 },
        { rank: 6, country_code: 'JP', paper_count: 318, total_contributions: 1233, share_pct: 2.69 },
        { rank: 7, country_code: 'IT', paper_count: 286, total_contributions: 1248, share_pct: 2.42 },
        { rank: 8, country_code: 'AU', paper_count: 265, total_contributions: 978, share_pct: 2.24 },
        { rank: 9, country_code: 'CA', paper_count: 260, total_contributions: 596, share_pct: 2.20 },
        { rank: 10, country_code: 'IR', paper_count: 238, total_contributions: 617, share_pct: 2.01 },
        { rank: 11, country_code: 'DE', paper_count: 215, total_contributions: 540, share_pct: 1.82 },
        { rank: 12, country_code: 'ES', paper_count: 198, total_contributions: 490, share_pct: 1.67 },
        { rank: 13, country_code: 'SG', paper_count: 172, total_contributions: 410, share_pct: 1.45 },
        { rank: 14, country_code: 'NL', paper_count: 154, total_contributions: 380, share_pct: 1.30 },
        { rank: 15, country_code: 'BR', paper_count: 142, total_contributions: 350, share_pct: 1.20 },
      ],
    }
  }

  if (queryClean.includes('country_code')) {
    return {
      columns: ['country_code', 'contribution_count'],
      rows: [
        { country_code: 'US', contribution_count: 5124 },
        { country_code: 'CN', contribution_count: 3892 },
        { country_code: 'GB', contribution_count: 1452 },
        { country_code: 'DE', contribution_count: 981 },
        { country_code: 'JP', contribution_count: 820 },
        { country_code: 'FR', contribution_count: 754 },
        { country_code: 'CA', contribution_count: 512 },
        { country_code: 'IN', contribution_count: 489 },
        { country_code: 'KR', contribution_count: 310 },
        { country_code: 'AU', contribution_count: 298 },
      ],
    }
  }

  if (queryClean.includes('is_synthetic') || queryClean.includes('synthetic')) {
    return {
      columns: ['id', 'display_name', 'country_code', 'type'],
      rows: [
        {
          id: 'IMP_a1b2c3d4e5',
          display_name: 'Advanced AI Labs',
          country_code: 'US',
          type: 'company',
        },
        {
          id: 'IMP_f6g7h8i9j0',
          display_name: 'Munich Quantum Research Hub',
          country_code: 'DE',
          type: 'education',
        },
        {
          id: 'IMP_k1l2m3n4o5',
          display_name: 'Kyoto Robotics Institute',
          country_code: 'JP',
          type: 'facility',
        },
        {
          id: 'IMP_p6q7r8s9t0',
          display_name: 'Paris Neural Networks Group',
          country_code: 'FR',
          type: 'education',
        },
        {
          id: 'IMP_u1v2w3x4y5',
          display_name: 'Ontario Climate Consortium',
          country_code: 'CA',
          type: 'nonprofit',
        },
      ],
    }
  }



  if (queryClean.includes('journal')) {
    return {
      columns: ['rank', 'journal_name', 'paper_count', 'share_pct'],
      rows: [
        { rank: 1, journal_name: 'IEEE Journal of Oceanic Engineering', paper_count: 840, share_pct: 14.5 },
        { rank: 2, journal_name: 'Ocean Engineering', paper_count: 715, share_pct: 12.3 },
        { rank: 3, journal_name: 'Applied Ocean Research', paper_count: 460, share_pct: 7.9 },
        { rank: 4, journal_name: 'Sensors', paper_count: 380, share_pct: 6.5 },
        { rank: 5, journal_name: 'IEEE Transactions on Robotics', paper_count: 290, share_pct: 5.0 },
        { rank: 6, journal_name: 'Journal of Field Robotics', paper_count: 245, share_pct: 4.2 },
        { rank: 7, journal_name: 'Marine Technology Society Journal', paper_count: 210, share_pct: 3.6 },
        { rank: 8, journal_name: 'Autonomous Robots', paper_count: 185, share_pct: 3.2 },
      ],
    }
  }

  if (queryClean.includes('oa_status')) {
    return {
      columns: ['status', 'paper_count', 'share_pct'],
      rows: [
        { status: 'closed', paper_count: 6601, share_pct: 58.4 },
        { status: 'gold', paper_count: 2070, share_pct: 18.3 },
        { status: 'diamond', paper_count: 812, share_pct: 7.2 },
        { status: 'hybrid', paper_count: 696, share_pct: 6.2 },
        { status: 'green', paper_count: 659, share_pct: 5.8 },
        { status: 'bronze', paper_count: 469, share_pct: 4.1 },
      ],
    }
  }

  // Fallback: return papers
  return {
    columns: ['id', 'title', 'doi', 'publication_year', 'journal_name'],
    rows: mockPapers.map((p) => ({
      id: p.id,
      title: p.title,
      doi: p.doi,
      publication_year: p.publication_year,
      journal_name: p.journal_name,
    })),
  }
}
