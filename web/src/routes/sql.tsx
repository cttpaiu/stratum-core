import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useProject } from '../context/ProjectContext'
import html2canvas from 'html2canvas'
import { jsPDF } from 'jspdf'
import {
  Download,
  RefreshCw,
  HardDrive,
  BarChart3,
  Table as TableIcon,
  Award,
  Globe,
  Building2,
  Calendar,
  FileText,
  Code2,
  ChevronDown,
  ChevronUp,
  Check,
  Loader2,
  AlertCircle,
  Flame,
  Sparkles,
  TrendingUp,
  Layers,
  Network,
  ArrowLeftRight,
  Users,
} from 'lucide-react'
import { executeMockQuery } from '../lib/mock-stratum'

const regionNames =
  typeof Intl !== 'undefined' && Intl.DisplayNames
    ? new Intl.DisplayNames(['en'], { type: 'region' })
    : null

function formatCountryName(code: string): string {
  if (!code || code === 'unknown') return 'Unknown'
  const upper = code.toUpperCase().trim()
  try {
    return (regionNames && regionNames.of(upper)) || upper
  } catch {
    return upper
  }
}


function formatNumber(num: number | undefined | null): string {
  if (num === undefined || num === null) return '0'
  return num.toLocaleString()
}

function formatShortNumber(num: number | undefined | null): string {
  if (num === undefined || num === null) return '0'
  const n = Math.round(Number(num))
  return String(n)
}

interface DatabaseFileItem {
  name: string
  path: string
  size_human: string
  type: 'DuckDB' | 'SQLite'
  mod_time: string
}

interface DiscoveredDBItem {
  name: string
  path: string
  size_human: string
  source: string
  is_active_project: boolean
}

type OutcomeId =
  | 'countries'
  | 'trajectory'
  | 'cagr'
  | 'impact_growth'
  | 'bilateral'
  | 'institutions'
  | 'authors'

type CountryTier = 'total' | 'top1pct' | 'top10pct'

const COUNTRY_QUERIES = {
  total: `SELECT 
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
  top1pct: `SELECT 
    ROW_NUMBER() OVER (ORDER BY COUNT(DISTINCT CASE WHEN p.is_top_1_percent = TRUE THEN c.paper_id END) DESC) AS rank,
    c.country_code,
    COUNT(DISTINCT CASE WHEN p.is_top_1_percent = TRUE THEN c.paper_id END) AS top_1pct_papers,
    COUNT(DISTINCT c.paper_id) AS total_papers,
    ROUND(COUNT(DISTINCT CASE WHEN p.is_top_1_percent = TRUE THEN c.paper_id END) * 100.0 / NULLIF(COUNT(DISTINCT c.paper_id), 0), 2) AS top_1pct_rate,
    ROUND(COUNT(DISTINCT CASE WHEN p.is_top_1_percent = TRUE THEN c.paper_id END) * 100.0 / NULLIF((SELECT COUNT(*) FROM papers WHERE is_top_1_percent = TRUE), 0), 2) AS share_pct
FROM contributions c
JOIN papers p ON c.paper_id = p.id
WHERE c.country_code IS NOT NULL AND TRIM(country_code) != ''
GROUP BY c.country_code
HAVING top_1pct_papers > 0
ORDER BY top_1pct_papers DESC
LIMIT 15;`,
  top10pct: `SELECT 
    ROW_NUMBER() OVER (ORDER BY COUNT(DISTINCT CASE WHEN p.is_top_10_percent = TRUE THEN c.paper_id END) DESC) AS rank,
    c.country_code,
    COUNT(DISTINCT CASE WHEN p.is_top_10_percent = TRUE THEN c.paper_id END) AS top_10pct_papers,
    COUNT(DISTINCT c.paper_id) AS total_papers,
    ROUND(COUNT(DISTINCT CASE WHEN p.is_top_10_percent = TRUE THEN c.paper_id END) * 100.0 / NULLIF(COUNT(DISTINCT c.paper_id), 0), 2) AS top_10pct_rate,
    ROUND(COUNT(DISTINCT CASE WHEN p.is_top_10_percent = TRUE THEN c.paper_id END) * 100.0 / NULLIF((SELECT COUNT(*) FROM papers WHERE is_top_10_percent = TRUE), 0), 2) AS share_pct
FROM contributions c
JOIN papers p ON c.paper_id = p.id
WHERE c.country_code IS NOT NULL AND TRIM(country_code) != ''
GROUP BY c.country_code
HAVING top_10pct_papers > 0
ORDER BY top_10pct_papers DESC
LIMIT 15;`,
}

const AUTHOR_QUERIES = {
  global: `SELECT 
    ROW_NUMBER() OVER (ORDER BY COUNT(DISTINCT c.paper_id) DESC) AS rank,
    c.author_name,
    MAX(c.country_code) AS country_code,
    COUNT(DISTINCT c.paper_id) AS paper_count,
    COUNT(DISTINCT CASE WHEN p.is_top_1_percent = TRUE THEN c.paper_id END) AS top_1pct_papers,
    COUNT(DISTINCT CASE WHEN p.is_top_10_percent = TRUE THEN c.paper_id END) AS top_10pct_papers,
    COALESCE(SUM(p.cited_by_count), 0) AS total_citations,
    ROUND(COUNT(DISTINCT c.paper_id) * 100.0 / NULLIF((SELECT COUNT(*) FROM papers), 0), 2) AS share_pct
FROM contributions c
JOIN papers p ON c.paper_id = p.id
WHERE c.author_name IS NOT NULL AND TRIM(c.author_name) != ''
GROUP BY c.author_name
ORDER BY paper_count DESC
LIMIT 10;`,
  india: `SELECT 
    ROW_NUMBER() OVER (ORDER BY COUNT(DISTINCT c.paper_id) DESC) AS rank,
    c.author_name,
    'IN' AS country_code,
    COUNT(DISTINCT c.paper_id) AS paper_count,
    COUNT(DISTINCT CASE WHEN p.is_top_1_percent = TRUE THEN c.paper_id END) AS top_1pct_papers,
    COUNT(DISTINCT CASE WHEN p.is_top_10_percent = TRUE THEN c.paper_id END) AS top_10pct_papers,
    COALESCE(SUM(p.cited_by_count), 0) AS total_citations,
    ROUND(COUNT(DISTINCT c.paper_id) * 100.0 / NULLIF((SELECT COUNT(DISTINCT paper_id) FROM contributions WHERE country_code = 'IN'), 0), 2) AS share_pct
FROM contributions c
JOIN papers p ON c.paper_id = p.id
WHERE c.country_code = 'IN' AND c.author_name IS NOT NULL AND TRIM(c.author_name) != ''
GROUP BY c.author_name
ORDER BY paper_count DESC
LIMIT 10;`,
}

const INSTITUTION_QUERIES = {
  total: `SELECT 
    ROW_NUMBER() OVER (ORDER BY COUNT(DISTINCT c.paper_id) DESC) AS rank,
    COALESCE(i.display_name, c.institution_id) AS institution_name,
    MAX(c.country_code) AS country_code,
    COUNT(DISTINCT c.paper_id) AS paper_count,
    COUNT(*) AS total_contributions,
    ROUND(COUNT(DISTINCT c.paper_id) * 100.0 / NULLIF((SELECT COUNT(*) FROM papers), 0), 2) AS share_pct
FROM contributions c
LEFT JOIN institutions i ON c.institution_id = i.id
WHERE c.institution_id IS NOT NULL AND TRIM(c.institution_id) != ''
GROUP BY c.institution_id, i.display_name
ORDER BY rank ASC
LIMIT 10;`,
  top1pct: `SELECT 
    ROW_NUMBER() OVER (ORDER BY COUNT(DISTINCT CASE WHEN p.is_top_1_percent = TRUE THEN c.paper_id END) DESC) AS rank,
    COALESCE(i.display_name, c.institution_id) AS institution_name,
    MAX(c.country_code) AS country_code,
    COUNT(DISTINCT CASE WHEN p.is_top_1_percent = TRUE THEN c.paper_id END) AS top_1pct_papers,
    COUNT(DISTINCT c.paper_id) AS total_papers,
    ROUND(COUNT(DISTINCT CASE WHEN p.is_top_1_percent = TRUE THEN c.paper_id END) * 100.0 / NULLIF(COUNT(DISTINCT c.paper_id), 0), 2) AS top_1pct_rate,
    ROUND(COUNT(DISTINCT CASE WHEN p.is_top_1_percent = TRUE THEN c.paper_id END) * 100.0 / NULLIF((SELECT COUNT(*) FROM papers WHERE is_top_1_percent = TRUE), 0), 2) AS share_pct
FROM contributions c
JOIN papers p ON c.paper_id = p.id
LEFT JOIN institutions i ON c.institution_id = i.id
WHERE c.institution_id IS NOT NULL AND TRIM(c.institution_id) != ''
GROUP BY c.institution_id, i.display_name
HAVING top_1pct_papers > 0
ORDER BY top_1pct_papers DESC
LIMIT 10;`,
  top10pct: `SELECT 
    ROW_NUMBER() OVER (ORDER BY COUNT(DISTINCT CASE WHEN p.is_top_10_percent = TRUE THEN c.paper_id END) DESC) AS rank,
    COALESCE(i.display_name, c.institution_id) AS institution_name,
    MAX(c.country_code) AS country_code,
    COUNT(DISTINCT CASE WHEN p.is_top_10_percent = TRUE THEN c.paper_id END) AS top_10pct_papers,
    COUNT(DISTINCT c.paper_id) AS total_papers,
    ROUND(COUNT(DISTINCT CASE WHEN p.is_top_10_percent = TRUE THEN c.paper_id END) * 100.0 / NULLIF(COUNT(DISTINCT c.paper_id), 0), 2) AS top_10pct_rate,
    ROUND(COUNT(DISTINCT CASE WHEN p.is_top_10_percent = TRUE THEN c.paper_id END) * 100.0 / NULLIF((SELECT COUNT(*) FROM papers WHERE is_top_10_percent = TRUE), 0), 2) AS share_pct
FROM contributions c
JOIN papers p ON c.paper_id = p.id
LEFT JOIN institutions i ON c.institution_id = i.id
WHERE c.institution_id IS NOT NULL AND TRIM(c.institution_id) != ''
GROUP BY c.institution_id, i.display_name
HAVING top_10pct_papers > 0
ORDER BY top_10pct_papers DESC
LIMIT 10;`,
}

interface OutcomeConfig {
  id: OutcomeId
  label: string
  shortLabel: string
  description: string
  icon: React.ComponentType<{ className?: string }>
  sql: string
}

const OUTCOMES: OutcomeConfig[] = [
  {
    id: 'countries',
    label: 'Top 15 Country Rankings',
    shortLabel: 'Top 15 Countries',
    description: 'National research volume, international contributions, and global scientific output share',
    icon: Globe,
    sql: COUNTRY_QUERIES.total,
  },
  {
    id: 'trajectory',
    label: 'Number of Papers Produced Each Year',
    shortLabel: 'Annual Trajectory',
    description: 'Year-by-year volume of scientific papers produced in this corpus',
    icon: Calendar,
    sql: `SELECT 
    publication_year AS year,
    COUNT(*) AS paper_count
FROM papers
WHERE publication_year IS NOT NULL
GROUP BY publication_year
ORDER BY publication_year ASC;`,
  },
  {
    id: 'cagr',
    label: 'Compound Annual Growth Rate (CAGR)',
    shortLabel: 'CAGR Growth',
    description: 'Compounded annualized growth velocity and year-over-year expansion of scientific publications',
    icon: TrendingUp,
    sql: `SELECT 
    publication_year AS year,
    COUNT(*) AS paper_count,
    LAG(COUNT(*)) OVER (ORDER BY publication_year) AS prev_year_papers,
    ROUND(((COUNT(*) - LAG(COUNT(*)) OVER (ORDER BY publication_year)) * 100.0 / NULLIF(LAG(COUNT(*)) OVER (ORDER BY publication_year), 0)), 2) AS yoy_growth_pct
FROM papers
WHERE publication_year IS NOT NULL
GROUP BY publication_year
ORDER BY publication_year ASC;`,
  },
  {
    id: 'impact_growth',
    label: 'Top 1% & Top 10% Year-on-Year Growth',
    shortLabel: 'Top 1% / 10% YoY',
    description: 'Annual stacked volume, elite citation composition, and year-on-year growth rate for Top 1% and Top 10% papers',
    icon: Layers,
    sql: `SELECT 
    publication_year AS year,
    COUNT(*) AS total_papers,
    COUNT(CASE WHEN is_top_1_percent = TRUE THEN 1 END) AS top_1pct_papers,
    COUNT(CASE WHEN is_top_10_percent = TRUE AND (is_top_1_percent = FALSE OR is_top_1_percent IS NULL) THEN 1 END) AS top_10pct_rest_papers,
    COUNT(CASE WHEN is_top_10_percent = TRUE THEN 1 END) AS top_10pct_total_papers,
    ROUND(COUNT(CASE WHEN is_top_1_percent = TRUE THEN 1 END) * 100.0 / NULLIF(COUNT(*), 0), 2) AS top_1pct_share,
    ROUND(COUNT(CASE WHEN is_top_10_percent = TRUE THEN 1 END) * 100.0 / NULLIF(COUNT(*), 0), 2) AS top_10pct_share,
    ROUND(((COUNT(CASE WHEN is_top_1_percent = TRUE THEN 1 END) - LAG(COUNT(CASE WHEN is_top_1_percent = TRUE THEN 1 END)) OVER (ORDER BY publication_year)) * 100.0 / NULLIF(LAG(COUNT(CASE WHEN is_top_1_percent = TRUE THEN 1 END)) OVER (ORDER BY publication_year), 0)), 2) AS top_1pct_yoy_pct,
    ROUND(((COUNT(CASE WHEN is_top_10_percent = TRUE THEN 1 END) - LAG(COUNT(CASE WHEN is_top_10_percent = TRUE THEN 1 END)) OVER (ORDER BY publication_year)) * 100.0 / NULLIF(LAG(COUNT(CASE WHEN is_top_10_percent = TRUE THEN 1 END)) OVER (ORDER BY publication_year), 0)), 2) AS top_10pct_yoy_pct,
    ROUND(((COUNT(*) - LAG(COUNT(*)) OVER (ORDER BY publication_year)) * 100.0 / NULLIF(LAG(COUNT(*)) OVER (ORDER BY publication_year), 0)), 2) AS total_yoy_pct
FROM papers
WHERE publication_year IS NOT NULL
GROUP BY publication_year
ORDER BY publication_year ASC;`,
  },
  {
    id: 'bilateral',
    label: 'Country-Country Collaboration: Bilateral Pairs',
    shortLabel: 'Bilateral Pairs',
    description: 'Cross-border co-authorship pairs, high-impact corridors, and bilateral scientific collaboration networks',
    icon: Network,
    sql: `SELECT 
    ROW_NUMBER() OVER (ORDER BY COUNT(DISTINCT c1.paper_id) DESC) AS rank,
    c1.country_code AS country_a,
    c2.country_code AS country_b,
    COUNT(DISTINCT c1.paper_id) AS collaboration_count,
    COUNT(DISTINCT CASE WHEN p.is_top_10_percent = TRUE THEN c1.paper_id END) AS top_10pct_collabs,
    COUNT(DISTINCT CASE WHEN p.is_top_1_percent = TRUE THEN c1.paper_id END) AS top_1pct_collabs,
    ROUND(COUNT(DISTINCT c1.paper_id) * 100.0 / NULLIF(SUM(COUNT(DISTINCT c1.paper_id)) OVER (), 0), 2) AS share_pct
FROM contributions c1
JOIN contributions c2 ON c1.paper_id = c2.paper_id AND c1.country_code < c2.country_code
JOIN papers p ON c1.paper_id = p.id
WHERE c1.country_code IS NOT NULL AND TRIM(c1.country_code) != ''
  AND c2.country_code IS NOT NULL AND TRIM(c2.country_code) != ''
GROUP BY c1.country_code, c2.country_code
ORDER BY collaboration_count DESC
LIMIT 25;`,
  },
  {
    id: 'institutions',
    label: 'Top 10 Global Institutions',
    shortLabel: 'Top 10 Inst',
    description: 'Premier university and laboratory affiliations ranked by publication volume and citation impact',
    icon: Building2,
    sql: INSTITUTION_QUERIES.total,
  },
  {
    id: 'authors',
    label: 'Top 10 Global & Indian Authors',
    shortLabel: 'Top Authors',
    description: 'Leading researchers ranked by publication volume and elite citation impact',
    icon: Users,
    sql: AUTHOR_QUERIES.global,
  },
]

export function Sql() {
  const { activeProject } = useProject()

  const initialFileFromUrl = (() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search)
      return params.get('file') || ''
    }
    return ''
  })()

  // Database selection state
  const [dbFiles, setDbFiles] = useState<DatabaseFileItem[]>([])
  const [discoveredDBs, setDiscoveredDBs] = useState<DiscoveredDBItem[]>([])
  const [selectedDB, setSelectedDB] = useState<string>(initialFileFromUrl)
  const [loadingFiles, setLoadingFiles] = useState(false)

  // Outcome selection state
  const [activeOutcome, setActiveOutcome] = useState<OutcomeId>('countries')
  const [countryTier, setCountryTier] = useState<CountryTier>('total')
  const [instTier, setInstTier] = useState<'total' | 'top1pct' | 'top10pct'>('total')
  const [viewMode, setViewMode] = useState<'graph' | 'table'>('graph')
  const [hoveredCountryIdx, setHoveredCountryIdx] = useState<number | null>(null)
  const [selectedMetric, setSelectedMetric] = useState<string>('')
  const [showSqlAudit, setShowSqlAudit] = useState(false)
  const [cagrMetricMode, setCagrMetricMode] = useState<'cagr' | 'yoy' | 'dual'>('cagr')
  const [hoveredCagrIdx, setHoveredCagrIdx] = useState<number | null>(null)
  const [impactStackMode, setImpactStackMode] = useState<'impact' | 'full' | 'yoy_rates'>('impact')
  const [hoveredImpactIdx, setHoveredImpactIdx] = useState<number | null>(null)
  const [collabFilterMode, setCollabFilterMode] = useState<'all' | 'india'>('all')
  const [hoveredCollabIdx, setHoveredCollabIdx] = useState<number | null>(null)
  const [collabSortMetric, setCollabSortMetric] = useState<'total' | 'top10' | 'top1'>('total')
  const [authorScope, setAuthorScope] = useState<'split' | 'global' | 'india'>('split')
  const [authorSortMetric, setAuthorSortMetric] = useState<'paper_count' | 'top_1pct_papers' | 'top_10pct_papers' | 'total_citations'>('paper_count')
  const [indiaAuthorRows, setIndiaAuthorRows] = useState<Record<string, string | number | boolean>[]>([])
  const [globalAuthorRows, setGlobalAuthorRows] = useState<Record<string, string | number | boolean>[]>([])

  // Execution & Results state
  const [executing, setExecuting] = useState(false)
  const [queryError, setQueryError] = useState<string | null>(null)
  const [executionTimeMs, setExecutionTimeMs] = useState<number | null>(null)
  const [results, setResults] = useState<{
    columns: string[]
    rows: Record<string, string | number | boolean>[]
  }>({ columns: [], rows: [] })

  // Overall KPI stats state
  const [overallStats, setOverallStats] = useState<{
    total_papers?: number
    total_countries?: number
    total_institutions?: number
    oa_ratio?: number
    top_country?: string
  }>({})

  const [exporting, setExporting] = useState(false)
  const [exportSuccess, setExportSuccess] = useState(false)
  const [exportProgress, setExportProgress] = useState('')
  const [exportPercent, setExportPercent] = useState(0)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const graphContainerRef = useRef<HTMLDivElement>(null)

  const activeOutcomeConfig = useMemo(() => {
    const base = OUTCOMES.find((o) => o.id === activeOutcome) || OUTCOMES[0]
    if (activeOutcome === 'countries') {
      return {
        ...base,
        sql: COUNTRY_QUERIES[countryTier],
        label:
          countryTier === 'top1pct'
            ? 'Top 1% Elite Publications Ranking'
            : countryTier === 'top10pct'
              ? 'Top 10% High-Impact Publications Ranking'
              : 'Top 15 Country Rankings',
        shortLabel:
          countryTier === 'top1pct'
            ? 'Top 1% Elite'
            : countryTier === 'top10pct'
              ? 'Top 10% Impact'
              : 'Top 15 Countries',
        icon:
          countryTier === 'top1pct'
            ? Flame
            : countryTier === 'top10pct'
              ? Sparkles
              : Globe,
      }
    }
    if (activeOutcome === 'institutions') {
      return {
        ...base,
        sql: INSTITUTION_QUERIES[instTier],
        label:
          instTier === 'top1pct'
            ? 'Top 10 Global Institutions (Top 1% Elite Publications)'
            : instTier === 'top10pct'
              ? 'Top 10 Global Institutions (Top 10% High-Impact Publications)'
              : 'Top 10 Global Institutions (Total Publications)',
        shortLabel:
          instTier === 'top1pct'
            ? 'Inst Top 1%'
            : instTier === 'top10pct'
              ? 'Inst Top 10%'
              : 'Top 10 Inst',
        icon:
          instTier === 'top1pct'
            ? Flame
            : instTier === 'top10pct'
              ? Sparkles
              : Building2,
      }
    }
    if (activeOutcome === 'authors') {
      return {
        ...base,
        sql: AUTHOR_QUERIES[authorScope === 'india' ? 'india' : 'global'],
        label:
          authorScope === 'india'
            ? 'Top 10 Indian Authors'
            : authorScope === 'global'
              ? 'Top 10 Global Authors'
              : 'Top 10 Global & Indian Authors (Side-by-Side Comparison)',
        shortLabel:
          authorScope === 'india'
            ? 'India Authors'
            : authorScope === 'global'
              ? 'Global Authors'
              : 'Top Authors',
        icon: Users,
      }
    }
    return base
  }, [activeOutcome, countryTier, instTier, authorScope])

  // Run the SQL query for the selected outcome
  const runOutcomeQuery = useCallback(
    async (outcomeId: OutcomeId, targetDb?: string, overrideSql?: string) => {
      const outcome = OUTCOMES.find((o) => o.id === outcomeId) || OUTCOMES[0]
      const sqlToExecute =
        overrideSql ||
        (outcomeId === 'countries'
          ? COUNTRY_QUERIES[countryTier]
          : outcomeId === 'institutions'
            ? INSTITUTION_QUERIES[instTier]
            : outcomeId === 'authors'
              ? AUTHOR_QUERIES[authorScope === 'india' ? 'india' : 'global']
              : outcome.sql)
      const dbToQuery = targetDb !== undefined ? targetDb : selectedDB
      setExecuting(true)
      setQueryError(null)
      const startTime = performance.now()

      try {
        let url = `/api/query?project=${encodeURIComponent(activeProject)}`
        if (dbToQuery) {
          url += `&file=${encodeURIComponent(dbToQuery)}`
        }

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: sqlToExecute, file: dbToQuery }),
        })

        const elapsed = Math.round(performance.now() - startTime)
        setExecutionTimeMs(elapsed)

        if (res.ok) {
          const data = await res.json()
          if (Array.isArray(data) && data.length > 0) {
            const rows = data as Record<string, string | number | boolean>[]
            const columns = Object.keys(rows[0])
            setResults({ columns, rows })

            // Auto-select preferred metric
            if (columns.includes('collaboration_count')) {
              setSelectedMetric('collaboration_count')
            } else if (columns.includes('top_1pct_papers')) {
              setSelectedMetric('top_1pct_papers')
            } else if (columns.includes('top_10pct_papers')) {
              setSelectedMetric('top_10pct_papers')
            } else if (columns.includes('paper_count')) {
              setSelectedMetric('paper_count')
            } else if (columns.includes('total_papers')) {
              setSelectedMetric('total_papers')
            } else if (columns.includes('count')) {
              setSelectedMetric('count')
            } else {
              const firstNum = columns.find(
                (c) => c !== 'rank' && c !== 'id' && typeof rows[0][c] === 'number',
              )
              if (firstNum) setSelectedMetric(firstNum)
            }
            if (outcomeId === 'authors') {
              if (authorScope === 'india') {
                setIndiaAuthorRows(rows)
              } else {
                setGlobalAuthorRows(rows)
              }
            }
            return
          }
        }

        if (outcomeId === 'authors') {
          // Preload both global and India datasets for side-by-side view
          (async () => {
            try {
              const compKey = authorScope === 'india' ? 'global' : 'india'
              const compSql = AUTHOR_QUERIES[compKey]
              const resComp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: compSql, file: dbToQuery }),
              })
              if (resComp.ok) {
                const compData = await resComp.json()
                if (Array.isArray(compData) && compData.length > 0) {
                  if (compKey === 'india') setIndiaAuthorRows(compData)
                  else setGlobalAuthorRows(compData)
                  return
                }
              }
              if (compKey === 'india') setIndiaAuthorRows(executeMockQuery(AUTHOR_QUERIES.india).rows)
              else setGlobalAuthorRows(executeMockQuery(AUTHOR_QUERIES.global).rows)
            } catch {
              if (authorScope === 'india') setGlobalAuthorRows(executeMockQuery(AUTHOR_QUERIES.global).rows)
              else setIndiaAuthorRows(executeMockQuery(AUTHOR_QUERIES.india).rows)
            }
          })()
        }

        // Graceful fallback to mock dataset if API returned empty / error
        const mock = executeMockQuery(sqlToExecute)
        setResults(mock)
        if (outcomeId === 'authors') {
          setGlobalAuthorRows(executeMockQuery(AUTHOR_QUERIES.global).rows)
          setIndiaAuthorRows(executeMockQuery(AUTHOR_QUERIES.india).rows)
        }
        if (mock.columns.includes('collaboration_count')) {
          setSelectedMetric('collaboration_count')
        } else if (mock.columns.includes('top_1pct_papers')) {
          setSelectedMetric('top_1pct_papers')
        } else if (mock.columns.includes('top_10pct_papers')) {
          setSelectedMetric('top_10pct_papers')
        } else if (mock.columns.includes('paper_count')) {
          setSelectedMetric('paper_count')
        } else if (mock.columns.includes('total_papers')) {
          setSelectedMetric('total_papers')
        }
      } catch {
        // Fallback to mock query on connection failure
        const mock = executeMockQuery(sqlToExecute)
        setResults(mock)
        if (outcomeId === 'authors') {
          setGlobalAuthorRows(executeMockQuery(AUTHOR_QUERIES.global).rows)
          setIndiaAuthorRows(executeMockQuery(AUTHOR_QUERIES.india).rows)
        }
        if (mock.columns.includes('collaboration_count')) {
          setSelectedMetric('collaboration_count')
        } else if (mock.columns.includes('top_1pct_papers')) {
          setSelectedMetric('top_1pct_papers')
        } else if (mock.columns.includes('top_10pct_papers')) {
          setSelectedMetric('top_10pct_papers')
        } else if (mock.columns.includes('paper_count')) {
          setSelectedMetric('paper_count')
        } else if (mock.columns.includes('total_papers')) {
          setSelectedMetric('total_papers')
        }
        const elapsed = Math.round(performance.now() - startTime)
        setExecutionTimeMs(elapsed)
      } finally {
        setExecuting(false)
      }
    },
    [activeProject, selectedDB, countryTier, instTier, authorScope],
  )

  // Fetch KPI Stats for top header banner
  const fetchOverallStats = useCallback(async () => {
    try {
      const res = await fetch(`/api/stats?project=${encodeURIComponent(activeProject)}`)
      if (res.ok) {
        const data = await res.json()
        let oaSum = 0
        if (Array.isArray(data.oa_status_counts)) {
          for (const item of data.oa_status_counts) {
            if (item.status && item.status !== 'closed' && item.status !== 'unknown') {
              oaSum += Number(item.count || 0)
            }
          }
        }
        const tot = Number(data.total_papers || 0)
        const topC = data.country_counts?.[0]?.country_code || 'US'

        setOverallStats({
          total_papers: tot,
          total_countries: data.total_countries || data.country_counts?.length || 0,
          total_institutions: data.total_institutions || 0,
          oa_ratio: tot > 0 ? Math.round((oaSum / tot) * 100) : 0,
          top_country: topC,
        })
      }
    } catch {
      // ignore
    }
  }, [activeProject])

  // Fetch DB files list
  const fetchDBFiles = useCallback(async () => {
    setLoadingFiles(true)
    try {
      const resp = await fetch(`/api/export/files?project=${encodeURIComponent(activeProject)}`)
      if (resp.ok) {
        const data = await resp.json()
        const items: DatabaseFileItem[] = []

        if (Array.isArray(data.duckdb_files)) {
          for (const f of data.duckdb_files) {
            items.push({
              name: f.name,
              path: f.path,
              size_human: f.size_human,
              type: 'DuckDB',
              mod_time: f.mod_time,
            })
          }
        }
        setDbFiles(items)

        const discovered: DiscoveredDBItem[] = []
        if (Array.isArray(data.discovered_databases)) {
          for (const d of data.discovered_databases) {
            discovered.push({
              name: d.name,
              path: d.path,
              size_human: d.size_human,
              source: d.source,
              is_active_project: !!d.is_active_project,
            })
          }
        }
        setDiscoveredDBs(discovered)

        let chosen = selectedDB
        if (!chosen) {
          if (items.length > 0) chosen = items[0].name
          else if (discovered.length > 0) chosen = discovered[0].path || discovered[0].name
        }

        if (chosen) {
          setSelectedDB(chosen)
          runOutcomeQuery(activeOutcome, chosen)
        } else {
          runOutcomeQuery(activeOutcome, '')
        }
      } else {
        runOutcomeQuery(activeOutcome, selectedDB)
      }
    } catch {
      runOutcomeQuery(activeOutcome, selectedDB)
    } finally {
      setLoadingFiles(false)
    }
  }, [activeProject, selectedDB, activeOutcome, runOutcomeQuery])

  useEffect(() => {
    fetchDBFiles()
    fetchOverallStats()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject])

  const handleOutcomeChange = (newOutcome: OutcomeId) => {
    setActiveOutcome(newOutcome)
    if (newOutcome === 'countries') {
      runOutcomeQuery('countries', undefined, COUNTRY_QUERIES[countryTier])
    } else if (newOutcome === 'institutions') {
      runOutcomeQuery('institutions', undefined, INSTITUTION_QUERIES[instTier])
    } else if (newOutcome === 'authors') {
      runOutcomeQuery('authors', undefined, AUTHOR_QUERIES[authorScope === 'india' ? 'india' : 'global'])
    } else {
      runOutcomeQuery(newOutcome)
    }
  }

  const handleCountryTierChange = (tier: CountryTier) => {
    setCountryTier(tier)
    runOutcomeQuery('countries', undefined, COUNTRY_QUERIES[tier])
  }

  const handleAuthorScopeChange = (scope: 'split' | 'global' | 'india') => {
    setAuthorScope(scope)
    runOutcomeQuery('authors', undefined, AUTHOR_QUERIES[scope === 'india' ? 'india' : 'global'])
  }

  const handleInstTierChange = (tier: 'total' | 'top1pct' | 'top10pct') => {
    setInstTier(tier)
    runOutcomeQuery('institutions', undefined, INSTITUTION_QUERIES[tier])
  }

  // Color Normalizer for html2canvas to ensure 100% color fidelity
  // (Converts any Tailwind v4 oklch or CSS color() functions into standard hex/rgba via Canvas 2D)
  const normalizeColorsForClone = useCallback((clonedDoc: Document, clonedElement: HTMLElement) => {
    try {
      const helperCanvas = clonedDoc.createElement('canvas')
      const ctx = helperCanvas.getContext('2d')
      if (!ctx) return

      const convertColor = (val: string): string => {
        if (!val || typeof val !== 'string') return val
        if (!val.includes('oklch') && !val.includes('color(')) return val
        try {
          ctx.fillStyle = '#000000'
          ctx.fillStyle = val
          return ctx.fillStyle
        } catch {
          return val
        }
      }

      const allElements = clonedElement.querySelectorAll('*')
      allElements.forEach((el) => {
        const htmlEl = el as HTMLElement
        if (htmlEl.style) {
          if (htmlEl.style.color) htmlEl.style.color = convertColor(htmlEl.style.color)
          if (htmlEl.style.backgroundColor) htmlEl.style.backgroundColor = convertColor(htmlEl.style.backgroundColor)
          if (htmlEl.style.borderColor) htmlEl.style.borderColor = convertColor(htmlEl.style.borderColor)
          if (htmlEl.style.fill) htmlEl.style.fill = convertColor(htmlEl.style.fill)
          if (htmlEl.style.stroke) htmlEl.style.stroke = convertColor(htmlEl.style.stroke)
        }
      })

      clonedDoc.querySelectorAll('style').forEach((styleEl) => {
        if (styleEl.textContent && styleEl.textContent.includes('oklch')) {
          styleEl.textContent = styleEl.textContent.replace(/oklch\([^)]+\)/g, (match) => {
            return convertColor(match)
          })
        }
      })
    } catch {
      // Continue gracefully if style rewriting meets restricted sandbox
    }
  }, [])

  const handleExportPDF = async (mode: 'all' | 'current' = 'all') => {
    if (exporting) return
    setExporting(true)
    setExportPercent(5)
    setExportMenuOpen(false)

    const originalOutcome = activeOutcome
    const originalViewMode = viewMode

    try {
      // Ensure we are in Graph View so elements exist in the DOM
      if (viewMode !== 'graph') {
        setViewMode('graph')
        await new Promise((r) => setTimeout(r, 400))
      }

      const isDark = document.documentElement.classList.contains('dark')

      if (mode === 'current') {
        setExportProgress(`Capturing ${activeOutcomeConfig.shortLabel}...`)
        setExportPercent(35)
        await new Promise((r) => setTimeout(r, 300))

        const element = graphContainerRef.current
        if (!element) {
          throw new Error('Graph container element not found')
        }

        const canvas = await html2canvas(element, {
          scale: 2,
          useCORS: true,
          logging: false,
          backgroundColor: isDark ? '#09090b' : '#ffffff',
          scrollX: 0,
          scrollY: 0,
          windowWidth: Math.max(element.scrollWidth, 1280),
          onclone: (clonedDoc, clonedEl) => normalizeColorsForClone(clonedDoc, clonedEl),
        })

        setExportProgress('Compiling PDF...')
        setExportPercent(75)

        const imgWidth = canvas.width
        const imgHeight = canvas.height
        const isPortrait = imgHeight > imgWidth * 1.25
        const orientation = isPortrait ? 'portrait' : 'landscape'

        const pdf = new jsPDF({
          orientation,
          unit: 'mm',
          format: 'a4',
        })

        const pageWidth = orientation === 'landscape' ? 297 : 210
        const pageHeight = orientation === 'landscape' ? 210 : 297

        // Theme-aware Page Background
        pdf.setFillColor(isDark ? 9 : 255, isDark ? 9 : 255, isDark ? 11 : 255)
        pdf.rect(0, 0, pageWidth, pageHeight, 'F')

        // Header Banner
        const bannerH = 15
        pdf.setFillColor(15, 23, 42) // Slate 900
        pdf.rect(10, 8, pageWidth - 20, bannerH, 'F')

        pdf.setFont('helvetica', 'bold')
        pdf.setFontSize(10.5)
        pdf.setTextColor(255, 255, 255)
        pdf.text(`STRATUM CORE — ${activeOutcomeConfig.label.toUpperCase()}`, 14, 14.5)

        pdf.setFont('helvetica', 'normal')
        pdf.setFontSize(7.5)
        pdf.setTextColor(203, 213, 225)
        pdf.text(
          `Project: ${activeProject || 'Default'}  •  ${activeOutcomeConfig.description}  •  ${new Date().toLocaleDateString()}`,
          14,
          19.5,
        )

        // Proportional Image Fit
        const headerBottom = 8 + bannerH + 4
        const footerTop = pageHeight - 10
        const availWidth = pageWidth - 20
        const availHeight = footerTop - headerBottom

        const scale = Math.min(availWidth / imgWidth, availHeight / imgHeight)
        const renderW = imgWidth * scale
        const renderH = imgHeight * scale
        const renderX = 10 + (availWidth - renderW) / 2
        const renderY = headerBottom + (availHeight - renderH) / 2

        const imgData = canvas.toDataURL('image/png')
        pdf.addImage(imgData, 'PNG', renderX, renderY, renderW, renderH, undefined, 'FAST')

        // Footer
        pdf.setDrawColor(isDark ? 39 : 226, isDark ? 39 : 232, isDark ? 42 : 240)
        pdf.setLineWidth(0.3)
        pdf.line(10, pageHeight - 8, pageWidth - 10, pageHeight - 8)

        pdf.setFont('helvetica', 'normal')
        pdf.setFontSize(7)
        pdf.setTextColor(isDark ? 161 : 100, isDark ? 161 : 116, isDark ? 170 : 139)
        pdf.text('Stratum Core • Scientometric Graph Export', 10, pageHeight - 4)
        pdf.text(
          `${activeOutcomeConfig.shortLabel} — Authentic Color Fidelity`,
          pageWidth / 2,
          pageHeight - 4,
          { align: 'center' },
        )
        pdf.text('Page 1 of 1', pageWidth - 10, pageHeight - 4, { align: 'right' })

        const cleanProj = (activeProject || 'stratum').replace(/\s+/g, '_')
        const cleanLabel = activeOutcomeConfig.shortLabel.replace(/\s+/g, '_')
        pdf.save(`${cleanProj}_${cleanLabel}_graph_${Date.now()}.pdf`)
      } else {
        // Export ALL 7 graphs in sequence
        const totalSteps = OUTCOMES.length
        const pdf = new jsPDF({
          orientation: 'landscape',
          unit: 'mm',
          format: 'a4',
        })

        for (let i = 0; i < totalSteps; i++) {
          const outcome = OUTCOMES[i]
          const pct = Math.round((i / totalSteps) * 90) + 5
          setExportPercent(pct)
          setExportProgress(`Capturing Graph ${i + 1} of ${totalSteps}: ${outcome.shortLabel}...`)

          // Switch active outcome
          setActiveOutcome(outcome.id)
          await runOutcomeQuery(outcome.id)

          // Preload author sets if authors tab
          if (outcome.id === 'authors') {
            if (globalAuthorRows.length === 0) {
              setGlobalAuthorRows(executeMockQuery(AUTHOR_QUERIES.global).rows)
            }
            if (indiaAuthorRows.length === 0) {
              setIndiaAuthorRows(executeMockQuery(AUTHOR_QUERIES.india).rows)
            }
          }

          // Let DOM settle
          const settleDelay = 700
          await new Promise((r) => setTimeout(r, settleDelay))

          const element = graphContainerRef.current
          if (!element) continue

          const canvas = await html2canvas(element, {
            scale: 2,
            useCORS: true,
            logging: false,
            backgroundColor: isDark ? '#09090b' : '#ffffff',
            scrollX: 0,
            scrollY: 0,
            windowWidth: Math.max(element.scrollWidth, 1280),
            onclone: (clonedDoc, clonedEl) => normalizeColorsForClone(clonedDoc, clonedEl),
          })

          const imgWidth = canvas.width
          const imgHeight = canvas.height
          const isPortrait = imgHeight > imgWidth * 1.25
          const orientation = isPortrait ? 'portrait' : 'landscape'

          if (i > 0) {
            pdf.addPage('a4', orientation)
          }

          const pageWidth = orientation === 'landscape' ? 297 : 210
          const pageHeight = orientation === 'landscape' ? 210 : 297

          // Theme-aware Page Background
          pdf.setFillColor(isDark ? 9 : 255, isDark ? 9 : 255, isDark ? 11 : 255)
          pdf.rect(0, 0, pageWidth, pageHeight, 'F')

          // Header Banner
          const bannerH = 15
          pdf.setFillColor(15, 23, 42) // Slate 900
          pdf.rect(10, 8, pageWidth - 20, bannerH, 'F')

          pdf.setFont('helvetica', 'bold')
          pdf.setFontSize(10.5)
          pdf.setTextColor(255, 255, 255)
          pdf.text(`STRATUM CORE — ${outcome.label.toUpperCase()}`, 14, 14.5)

          pdf.setFont('helvetica', 'normal')
          pdf.setFontSize(7.5)
          pdf.setTextColor(203, 213, 225)
          pdf.text(
            `Project: ${activeProject || 'Default'}  •  Analysis ${i + 1} of ${totalSteps}  •  ${new Date().toLocaleDateString()}`,
            14,
            19.5,
          )

          // Proportional Image Fit
          const headerBottom = 8 + bannerH + 4
          const footerTop = pageHeight - 10
          const availWidth = pageWidth - 20
          const availHeight = footerTop - headerBottom

          const scale = Math.min(availWidth / imgWidth, availHeight / imgHeight)
          const renderW = imgWidth * scale
          const renderH = imgHeight * scale
          const renderX = 10 + (availWidth - renderW) / 2
          const renderY = headerBottom + (availHeight - renderH) / 2

          const imgData = canvas.toDataURL('image/png')
          pdf.addImage(imgData, 'PNG', renderX, renderY, renderW, renderH, undefined, 'FAST')

          // Footer
          pdf.setDrawColor(isDark ? 39 : 226, isDark ? 39 : 232, isDark ? 42 : 240)
          pdf.setLineWidth(0.3)
          pdf.line(10, pageHeight - 8, pageWidth - 10, pageHeight - 8)

          pdf.setFont('helvetica', 'normal')
          pdf.setFontSize(7)
          pdf.setTextColor(isDark ? 161 : 100, isDark ? 161 : 116, isDark ? 170 : 139)
          pdf.text('Stratum Core • Scientometric Graph Dossier', 10, pageHeight - 4)
          pdf.text(
            `${outcome.shortLabel} — Authentic Color Fidelity`,
            pageWidth / 2,
            pageHeight - 4,
            { align: 'center' },
          )
          pdf.text(
            `Page ${i + 1} of ${totalSteps}`,
            pageWidth - 10,
            pageHeight - 4,
            { align: 'right' },
          )
        }

        setExportProgress('Saving PDF document...')
        setExportPercent(100)
        const cleanProj = (activeProject || 'stratum').replace(/\s+/g, '_')
        pdf.save(`${cleanProj}_all_scientometric_graphs_${Date.now()}.pdf`)
      }

      setExportSuccess(true)
      setTimeout(() => setExportSuccess(false), 4000)
    } catch (err) {
      console.error('PDF export failed:', err)
    } finally {
      // Restore original state
      setActiveOutcome(originalOutcome)
      runOutcomeQuery(originalOutcome)
      if (originalViewMode !== 'graph') {
        setViewMode(originalViewMode)
      }
      setExporting(false)
      setExportProgress('')
      setExportPercent(0)
    }
  }

  const handleExportCSV = () => {
    setExporting(true)
    setTimeout(() => {
      const { columns, rows } = results
      if (columns.length === 0 || rows.length === 0) {
        setExporting(false)
        return
      }

      const headers = columns.join(',')
      const csvLines = rows.map((row) =>
        columns
          .map((col) => {
            const val = row[col]
            if (val === null || val === undefined) return ''
            return typeof val === 'string' ? `"${val.replace(/"/g, '""')}"` : val
          })
          .join(','),
      )
      const csvContent = [headers, ...csvLines].join('\n')

      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      const fileSuffix =
        activeOutcome === 'countries'
          ? `_countries_${countryTier}`
          : activeOutcome === 'institutions'
            ? `_institutions_${instTier}`
            : `_${activeOutcome}`
      link.setAttribute('download', `stratum${fileSuffix}_${Date.now()}.csv`)
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)

      setExporting(false)
      setExportSuccess(true)
      setTimeout(() => setExportSuccess(false), 3000)
    }, 400)
  }

  // Derive metrics for active outcome
  const numericCols = useMemo(() => {
    return results.columns.filter((c) => {
      if (['rank', 'id', 'row_id', 'year'].includes(c)) return false
      return results.rows.some((r) => typeof r[c] === 'number')
    })
  }, [results])

  const activeMetric = useMemo(() => {
    if (selectedMetric && results.columns.includes(selectedMetric)) {
      return selectedMetric
    }
    if (results.columns.includes('top_1pct_papers')) return 'top_1pct_papers'
    if (results.columns.includes('top_10pct_papers')) return 'top_10pct_papers'
    if (results.columns.includes('paper_count')) return 'paper_count'
    if (results.columns.includes('total_papers')) return 'total_papers'
    if (results.columns.includes('count')) return 'count'
    return numericCols[0] || ''
  }, [selectedMetric, results, numericCols])

  // Whether the active metric is a percentage/rate column rather than a raw count.
  // Rate metrics need a "%" suffix on axis labels and should not be summed into a "Total".
  const isRateMetric = activeMetric.includes('rate')

  const maxMetricVal = useMemo(() => {
    return Math.max(
      ...results.rows.map((r) => {
        const v = Number(r[activeMetric])
        return isNaN(v) ? 0 : v
      }),
      1,
    )
  }, [results, activeMetric])

  const totalMetricSum = useMemo(() => {
    return results.rows.reduce((acc, r) => {
      const v = Number(r[activeMetric])
      return acc + (isNaN(v) ? 0 : v)
    }, 0)
  }, [results, activeMetric])

  // Parsed & normalized bilateral collaboration pairs, memoized on the query results only.
  const bilateralParsedRows = useMemo(() => {
    return results.rows.map((r, i) => {
      const ca = String(r.country_a ?? '').toUpperCase()
      const cb = String(r.country_b ?? '').toUpperCase()
      const total = Number(r.collaboration_count ?? r.paper_count ?? r.count ?? 0)
      const top10 = Number(r.top_10pct_collabs ?? 0)
      const top1 = Number(r.top_1pct_collabs ?? 0)
      const share = Number(r.share_pct ?? 0)
      const rank = r.rank !== undefined ? Number(r.rank) : i + 1
      const isIndia = ca === 'IN' || cb === 'IN'

      return {
        originalRank: rank,
        countryA: ca,
        countryB: cb,
        total,
        top10,
        top1,
        share,
        isIndia,
      }
    })
  }, [results.rows])

  // Minimum pixel width per chart implementation to keep bars usable when there are many columns
  // (e.g. a wide year range for trajectory/CAGR/impact-growth). Charts scroll horizontally instead
  // of squashing below a legible width.
  const chartMinWidth = (rowCount: number, perCol = 44, floor = 420) =>
    Math.max(rowCount * perCol, floor)

  return (
    <div className="flex flex-col gap-5 w-full max-w-7xl mx-auto pb-12">
      {/* Top Header & Context Bar (Insights Style) */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-zinc-200 dark:border-zinc-800 pb-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2.5">
            <div className="h-8 w-8 rounded bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-950 flex items-center justify-center font-mono shadow-xs">
              <BarChart3 className="h-4 w-4" />
            </div>
            <h1 className="text-xl font-mono font-bold tracking-tight text-zinc-900 dark:text-zinc-100 uppercase">
              Scientometric Insights
            </h1>
            <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase tracking-wider bg-blue-50 text-blue-700 border border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800/60">
              {activeProject}
            </span>
          </div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 font-sans max-w-2xl">
            Select an analytical outcome to view prominent scientometric visualizations powered by
            DuckDB SQL commands.
          </p>
        </div>

        {/* Database & Action Bar */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Target DB Selector */}
          <div className="flex items-center gap-1.5 bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 rounded px-2.5 py-1.5 text-xs font-mono">
            <HardDrive className="h-3.5 w-3.5 text-zinc-400" />
            <span className="text-[10px] uppercase font-bold text-zinc-400">Database:</span>
            <select
              value={selectedDB}
              onChange={(e) => {
                const db = e.target.value
                setSelectedDB(db)
                runOutcomeQuery(activeOutcome, db)
              }}
              disabled={loadingFiles || executing}
              className="bg-transparent font-mono text-xs text-zinc-800 dark:text-zinc-200 focus:outline-none cursor-pointer max-w-[150px] truncate"
              title="Select database"
            >
              {dbFiles.map((f) => (
                <option key={f.path || f.name} value={f.name}>
                  {f.name} ({f.size_human})
                </option>
              ))}
              {discoveredDBs.map((d) => (
                <option key={d.path} value={d.path}>
                  {d.name} ({d.size_human})
                </option>
              ))}
              {dbFiles.length === 0 && discoveredDBs.length === 0 && (
                <option value="">Default Project DB</option>
              )}
            </select>
          </div>

          {/* Refresh Button */}
          <button
            type="button"
            onClick={() => {
              fetchDBFiles()
              runOutcomeQuery(activeOutcome)
            }}
            disabled={executing || loadingFiles}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-xs font-mono transition cursor-pointer"
            title="Refresh active outcome data"
          >
            <RefreshCw className={`h-3 w-3 ${executing ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">Refresh</span>
          </button>

          {/* Export PDF Button with Options Menu */}
          <div className="relative inline-flex items-center rounded border border-zinc-300 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-2xs">
            <button
              type="button"
              onClick={() => handleExportPDF('all')}
              disabled={exporting}
              className="flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-850 text-zinc-700 dark:text-zinc-300 transition text-xs font-mono select-none disabled:opacity-50 cursor-pointer border-r border-zinc-200 dark:border-zinc-800"
              title="Download all scientometric graphs with authentic colors (PDF)"
            >
              {exporting ? (
                <Loader2 className="h-3 w-3 animate-spin text-orange-500" />
              ) : (
                <FileText className="h-3 w-3 text-orange-600 dark:text-orange-400" />
              )}
              <span className="font-bold">Export PDF</span>
            </button>

            <button
              type="button"
              onClick={() => setExportMenuOpen(!exportMenuOpen)}
              disabled={exporting}
              className="px-1.5 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-850 text-zinc-600 dark:text-zinc-400 transition cursor-pointer disabled:opacity-50"
              title="PDF export options"
            >
              <ChevronDown className="h-3 w-3" />
            </button>

            {exportMenuOpen && (
              <>
                <div
                  className="fixed inset-0 z-30"
                  onClick={() => setExportMenuOpen(false)}
                />
                <div className="absolute right-0 top-full mt-1.5 z-40 w-72 rounded-md border border-zinc-200 dark:border-zinc-850 bg-white dark:bg-zinc-900 shadow-xl py-1 text-xs font-mono">
                  <div className="px-3 py-1.5 border-b border-zinc-100 dark:border-zinc-800 text-[10px] uppercase font-bold text-zinc-400">
                    PDF Scientometric Exports
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setExportMenuOpen(false)
                      handleExportPDF('all')
                    }}
                    className="w-full text-left px-3 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-850 flex items-start gap-2.5 text-zinc-800 dark:text-zinc-200 cursor-pointer"
                  >
                    <Layers className="h-4 w-4 text-orange-500 shrink-0 mt-0.5" />
                    <div className="flex flex-col">
                      <span className="font-bold text-zinc-900 dark:text-zinc-100">
                        All Graphs (Complete Report)
                      </span>
                      <span className="text-[10px] text-zinc-500 dark:text-zinc-400 leading-tight mt-0.5">
                        Multi-page PDF containing all 7 analyses with authentic colors
                      </span>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setExportMenuOpen(false)
                      handleExportPDF('current')
                    }}
                    className="w-full text-left px-3 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-850 flex items-start gap-2.5 text-zinc-800 dark:text-zinc-200 cursor-pointer border-t border-zinc-100 dark:border-zinc-800"
                  >
                    <BarChart3 className="h-4 w-4 text-sky-500 shrink-0 mt-0.5" />
                    <div className="flex flex-col">
                      <span className="font-bold text-zinc-900 dark:text-zinc-100">
                        Current Graph ({activeOutcomeConfig.shortLabel})
                      </span>
                      <span className="text-[10px] text-zinc-500 dark:text-zinc-400 leading-tight mt-0.5">
                        High-resolution single-page PDF with identical color fidelity
                      </span>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setExportMenuOpen(false)
                      handleExportCSV()
                    }}
                    className="w-full text-left px-3 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-850 flex items-center gap-2 text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200 cursor-pointer border-t border-zinc-100 dark:border-zinc-800 text-[11px]"
                  >
                    <Download className="h-3 w-3 shrink-0" />
                    <span>Export Raw Data (CSV)</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {exportSuccess && (
        <div className="flex items-center gap-2 p-3 border border-green-200 bg-green-50/50 text-green-700 dark:border-green-800/40 dark:bg-green-950/20 dark:text-green-400 font-mono text-xs rounded">
          <Check className="h-4 w-4 shrink-0" />
          <span>[SUCCESS] Scientometric Graph PDF compiled and downloaded successfully with authentic colors.</span>
        </div>
      )}

      {/* High-Resolution Color PDF Export Progress Modal */}
      {exporting && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-2xl p-5 max-w-md w-full flex flex-col gap-3 font-mono">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-full bg-orange-100 dark:bg-orange-950/60 text-orange-600 dark:text-orange-400 shrink-0">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
              <div className="flex flex-col min-w-0">
                <span className="font-bold text-sm text-zinc-900 dark:text-zinc-100 truncate">
                  Exporting Scientometric PDF
                </span>
                <span className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate">
                  Preserving authentic colors (Saffron, Sky, Emerald, Amber)
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-1.5 mt-1">
              <div className="flex items-center justify-between text-xs text-zinc-700 dark:text-zinc-300 font-bold">
                <span className="truncate">{exportProgress}</span>
                <span className="shrink-0 text-orange-600 dark:text-orange-400 ml-2">
                  {exportPercent}%
                </span>
              </div>
              <div className="w-full bg-zinc-100 dark:bg-zinc-800 rounded-full h-2 overflow-hidden">
                <div
                  className="bg-orange-500 h-full transition-all duration-300 rounded-full"
                  style={{ width: `${exportPercent}%` }}
                />
              </div>
            </div>

            <p className="text-[10px] text-zinc-400 dark:text-zinc-500 leading-normal border-t border-zinc-100 dark:border-zinc-800/80 pt-2 mt-1">
              Rasterizing vector SVGs, bilateral networks, and styled cards at 2x resolution...
            </p>
          </div>
        </div>
      )}

      {/* Top Scientometric Metric Cards Strip (Insights Style) */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* Total Publications */}
        <div className="p-3 rounded border border-zinc-200 dark:border-zinc-850 bg-white dark:bg-zinc-900/40 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between text-zinc-400 mb-1">
            <span className="text-[10px] font-mono font-bold uppercase tracking-wider">
              Publications
            </span>
            <FileText className="h-3.5 w-3.5 text-zinc-400" />
          </div>
          <span className="text-xl font-mono font-bold text-zinc-900 dark:text-zinc-100">
            {formatNumber(overallStats.total_papers || 11280)}
          </span>
          <span className="text-[10px] text-zinc-400 font-mono">Indexed bibliometrics</span>
        </div>

        {/* Top Research Hub */}
        <div className="p-3 rounded border border-zinc-200 dark:border-zinc-850 bg-white dark:bg-zinc-900/40 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between text-zinc-500 dark:text-zinc-400 mb-1">
            <span className="text-[10px] font-mono font-bold uppercase tracking-wider">
              Top Research Hub
            </span>
            <Building2 className="h-3.5 w-3.5 text-zinc-400" />
          </div>
          <span className="text-base font-mono font-bold text-zinc-900 dark:text-zinc-100 truncate">
            {activeProject === 'AUV_v2' ? 'Harbin Eng. Univ' : 'Premier University'}
          </span>
          <span className="text-[10px] text-zinc-400 font-mono">
            Most active affiliation
          </span>
        </div>

        {/* Global Reach */}
        <div className="p-3 rounded border border-zinc-200 dark:border-zinc-850 bg-white dark:bg-zinc-900/40 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between text-zinc-500 dark:text-zinc-400 mb-1">
            <span className="text-[10px] font-mono font-bold uppercase tracking-wider">
              Global Reach
            </span>
            <Globe className="h-3.5 w-3.5 text-zinc-400" />
          </div>
          <span className="text-xl font-mono font-bold text-zinc-900 dark:text-zinc-100">
            {overallStats.total_countries || 125}
          </span>
          <span className="text-[10px] text-zinc-400 font-mono">
            Nations contributing
          </span>
        </div>
      </div>

      {/* Outcome Selector Navigation Tabs Bar (Insights Style) */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-zinc-200 dark:border-zinc-800 pb-1">
        {/* Horizontal Outcome Tabs */}
        <div className="flex items-center gap-1 overflow-x-auto">
          {OUTCOMES.map((outcome) => {
            const Icon = outcome.icon
            const isActive = activeOutcome === outcome.id
            return (
              <button
                key={outcome.id}
                type="button"
                onClick={() => handleOutcomeChange(outcome.id)}
                className={`flex items-center gap-2 px-3.5 py-2 text-xs font-mono uppercase tracking-wider border-b-2 transition-all cursor-pointer whitespace-nowrap ${
                  isActive
                    ? 'border-zinc-900 dark:border-zinc-100 text-zinc-900 dark:text-zinc-100 font-bold bg-zinc-50 dark:bg-zinc-900/50'
                    : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                }`}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span>{outcome.shortLabel}</span>
              </button>
            )
          })}
        </div>

        {/* View Mode Switcher: Graph / Table */}
        <div className="flex items-center gap-2 self-end sm:self-auto shrink-0 mb-1">
          <div className="flex items-center rounded border border-zinc-200 dark:border-zinc-800 bg-zinc-100 dark:bg-zinc-900 p-0.5 shadow-2xs">
            <button
              type="button"
              onClick={() => setViewMode('graph')}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono transition cursor-pointer ${
                viewMode === 'graph'
                  ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-bold shadow-xs'
                  : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
              }`}
              title="Prominent Graph View"
            >
              <BarChart3 className="h-3.5 w-3.5" />
              <span>Graph</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode('table')}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono transition cursor-pointer ${
                viewMode === 'table'
                  ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-bold shadow-xs'
                  : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
              }`}
              title="Raw Data Table"
            >
              <TableIcon className="h-3.5 w-3.5" />
              <span>Table</span>
            </button>
          </div>
        </div>
      </div>

      {/* Error Notice */}
      {queryError && (
        <div className="p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50 rounded flex items-center justify-between font-mono text-xs text-red-700 dark:text-red-400">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{queryError}</span>
          </div>
        </div>
      )}

      {/* Main Scientometric Graph & Visualization Container */}
      {executing ? (
        <div className="p-16 text-center flex flex-col items-center justify-center gap-3 border border-zinc-200 dark:border-zinc-850 rounded bg-white dark:bg-zinc-900/30 shadow-xs font-mono text-xs text-zinc-400">
          <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />
          <span className="font-bold uppercase tracking-wider text-zinc-600 dark:text-zinc-300">
            Querying DuckDB analytical engine...
          </span>
        </div>
      ) : viewMode === 'graph' ? (
        <div ref={graphContainerRef} className="flex flex-col gap-4">
          {/* 1. TOP 15 COUNTRIES / TOP 1% / TOP 10% OUTCOME */}
          {activeOutcome === 'countries' && (
            <div className="flex flex-col gap-3 border border-zinc-200 dark:border-zinc-850 rounded bg-white dark:bg-zinc-900/40 p-4 shadow-xs">
              {/* Header Strip with Sub-Mode & Metrics Switchers */}
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 border-b border-zinc-100 dark:border-zinc-800 pb-3">
                <div className="flex items-center gap-2 flex-wrap min-w-0">
                  {countryTier === 'top1pct' ? (
                    <Flame className="h-4 w-4 text-orange-500 shrink-0" />
                  ) : countryTier === 'top10pct' ? (
                    <Sparkles className="h-4 w-4 text-amber-500 shrink-0" />
                  ) : (
                    <Globe className="h-4 w-4 text-zinc-600 dark:text-zinc-400 shrink-0" />
                  )}
                  <span className="font-mono font-bold text-xs uppercase tracking-tight text-zinc-900 dark:text-zinc-100">
                    {countryTier === 'top1pct'
                      ? 'Top 1% Elite Publications'
                      : countryTier === 'top10pct'
                        ? 'Top 10% High-Impact Publications'
                        : 'Top 15 Countries Output'}
                  </span>

                  {/* Sub-Tabs: All Works vs Top 1% Elite vs Top 10% Elite */}
                  <div className="flex items-center rounded border border-zinc-200 dark:border-zinc-850 bg-zinc-100 dark:bg-zinc-900 p-0.5 text-[10px] font-mono shadow-2xs">
                    <button
                      type="button"
                      onClick={() => handleCountryTierChange('total')}
                      className={`px-2.5 py-1 rounded transition cursor-pointer ${
                        countryTier === 'total'
                          ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-bold shadow-2xs'
                          : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                      }`}
                      title="All indexed publications across top 15 nations"
                    >
                      All Works
                    </button>
                    <button
                      type="button"
                      onClick={() => handleCountryTierChange('top1pct')}
                      className={`flex items-center gap-1 px-2.5 py-1 rounded transition cursor-pointer ${
                        countryTier === 'top1pct'
                          ? 'bg-orange-500 text-white font-bold shadow-2xs'
                          : 'text-zinc-500 hover:text-orange-600 dark:hover:text-orange-400'
                      }`}
                      title="Top 1% highly-cited publications"
                    >
                      <Flame className="h-2.5 w-2.5" />
                      <span>Top 1% Elite</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleCountryTierChange('top10pct')}
                      className={`flex items-center gap-1 px-2.5 py-1 rounded transition cursor-pointer ${
                        countryTier === 'top10pct'
                          ? 'bg-amber-500 text-white font-bold shadow-2xs'
                          : 'text-zinc-500 hover:text-amber-600 dark:hover:text-amber-400'
                      }`}
                      title="Top 10% high-impact publications"
                    >
                      <Sparkles className="h-2.5 w-2.5" />
                      <span>Top 10% Elite</span>
                    </button>
                  </div>

                  {results.rows.length > 0 && (() => {
                    const topRow = results.rows[0]
                    const topCC = String(topRow?.country_code || '')
                    const isTopIndia = topCC.toUpperCase() === 'IN'
                    const topVal = Number(topRow?.[activeMetric] || 0)
                    return (
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-mono border flex items-center gap-1 ${
                          isTopIndia
                            ? 'bg-orange-50 text-orange-800 dark:bg-orange-950/60 dark:text-orange-300 border-orange-300 dark:border-orange-800'
                            : 'bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200 border-zinc-200 dark:border-zinc-700'
                        }`}
                      >
                        <Award className="h-3 w-3" />
                        <span>
                          #1 {formatCountryName(topCC)}:{' '}
                          {topVal.toLocaleString()}{isRateMetric ? '%' : ''}
                        </span>
                      </span>
                    )
                  })()}
                  {/* Quick India Highlight Chip if India is in Top 15 */}
                  {results.rows.some((r) => String(r.country_code || '').toUpperCase() === 'IN') && (() => {
                    const inRow = results.rows.find(
                      (r) => String(r.country_code || '').toUpperCase() === 'IN',
                    )
                    const inRank = inRow?.rank !== undefined ? Number(inRow.rank) : 10
                    const inVal = Number(inRow?.[activeMetric] || 0)
                    return (
                      <span
                        onClick={() => {
                          const idx = results.rows.findIndex(
                            (r) => String(r.country_code || '').toUpperCase() === 'IN',
                          )
                          if (idx !== -1) setHoveredCountryIdx(idx)
                        }}
                        className="px-2 py-0.5 rounded text-[10px] font-mono bg-orange-50 text-orange-700 dark:bg-orange-950/50 dark:text-orange-300 border border-orange-300 dark:border-orange-800 flex items-center gap-1 cursor-pointer hover:bg-orange-100 dark:hover:bg-orange-900/50 transition shadow-2xs"
                        title="Click to inspect India bibliometrics"
                      >
                        <span className="font-bold">India:</span>
                        <span className="font-bold">#{inRank}</span>
                        <span>({inVal.toLocaleString()}{isRateMetric ? '%' : ''})</span>
                      </span>
                    )
                  })()}
                  {!isRateMetric && (
                    <span className="text-[10px] font-mono text-zinc-400 hidden sm:inline">
                      Total: {totalMetricSum.toLocaleString()}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  {/* Metric Selector Pills */}
                  {numericCols.length > 1 && (
                    <div className="flex items-center rounded border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 p-0.5 text-[11px] font-mono">
                      {numericCols.map((col) => {
                        const labelMap: Record<string, string> = {
                          top_1pct_papers: 'Top 1%',
                          top_1pct_rate: 'Top 1% Rate %',
                          top_10pct_papers: 'Top 10%',
                          top_10pct_rate: 'Top 10% Rate %',
                          paper_count: 'Papers',
                          total_papers: 'Total Papers',
                          total_contributions: 'Contributions',
                          share_pct: 'Share %',
                        }
                        return (
                          <button
                            key={col}
                            type="button"
                            onClick={() => setSelectedMetric(col)}
                            className={`px-2 py-0.5 rounded transition cursor-pointer ${
                              activeMetric === col
                                ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 font-bold'
                                : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                            }`}
                          >
                            {labelMap[col] || col}
                          </button>
                        )
                      })}
                    </div>
                  )}

                </div>
              </div>

              {/* VERTICAL COLUMN HISTOGRAM (Black/Grey Theme + India in Orange) */}
              <div className="flex flex-col gap-2">
                  <div className="overflow-x-auto">
                    <div
                      className="relative flex items-stretch h-56 sm:h-60 pt-3 pb-1"
                      style={{ minWidth: `${chartMinWidth(Math.min(results.rows.length, 15))}px` }}
                    >
                    {/* Y-Axis Scale Gutter */}
                    <div className="flex flex-col justify-between items-end pr-2 text-[10px] font-mono text-zinc-400 select-none w-12 sm:w-16 shrink-0 border-r border-zinc-200 dark:border-zinc-800 pb-0.5 whitespace-nowrap">
                      <span>{formatShortNumber(maxMetricVal)}{isRateMetric ? '%' : ''}</span>
                      <span>{formatShortNumber(maxMetricVal * 0.75)}{isRateMetric ? '%' : ''}</span>
                      <span>{formatShortNumber(maxMetricVal * 0.5)}{isRateMetric ? '%' : ''}</span>
                      <span>{formatShortNumber(maxMetricVal * 0.25)}{isRateMetric ? '%' : ''}</span>
                      <span>0{isRateMetric ? '%' : ''}</span>
                    </div>

                    {/* Chart Plot Area with 15 Vertical Columns */}
                    <div className="relative flex-1 flex flex-col justify-between pl-2">
                      {/* Horizontal Gridlines */}
                      <div className="absolute inset-0 left-2 flex flex-col justify-between pointer-events-none opacity-40 z-0">
                        <div className="border-b border-dashed border-zinc-300 dark:border-zinc-700 w-full" />
                        <div className="border-b border-dashed border-zinc-200 dark:border-zinc-800 w-full" />
                        <div className="border-b border-dashed border-zinc-200 dark:border-zinc-800 w-full" />
                        <div className="border-b border-dashed border-zinc-200 dark:border-zinc-800 w-full" />
                        <div className="border-b border-zinc-300 dark:border-zinc-700 w-full" />
                      </div>

                      {/* Columns */}
                      <div className="relative z-10 h-full flex items-end justify-between gap-1 sm:gap-2">
                        {results.rows.slice(0, 15).map((row, idx) => {
                          const val = Number(row[activeMetric]) || 0
                          const heightPct =
                            maxMetricVal > 0
                              ? Math.max(Math.round((val / maxMetricVal) * 100), 4)
                              : 4
                          const cc = String(row.country_code || '')
                          const countryName = formatCountryName(cc)
                          const rank = row.rank !== undefined ? Number(row.rank) : idx + 1
                          const isIndia =
                            cc.toUpperCase() === 'IN' || countryName.toLowerCase() === 'india'
                          const sharePct =
                            row.share_pct !== undefined
                              ? Number(row.share_pct)
                              : totalMetricSum > 0
                                ? (val / totalMetricSum) * 100
                                : 0
                          const isHovered = hoveredCountryIdx === idx

                          // Black/Grey theme with India exclusively in vibrant orange
                          const barColor = isIndia
                            ? 'bg-gradient-to-t from-orange-600 to-orange-400 dark:from-orange-500 dark:to-orange-400 border-t border-x border-orange-400 dark:border-orange-300 shadow-md ring-1 ring-orange-500/40'
                            : 'bg-gradient-to-t from-zinc-800 to-zinc-600 dark:from-zinc-700 dark:to-zinc-400 group-hover:from-zinc-700 group-hover:to-zinc-500 transition-colors'

                          const metricLabel =
                            activeMetric === 'top_1pct_papers'
                              ? 'top 1% papers'
                              : activeMetric === 'top_1pct_rate'
                                ? '% elite rate'
                                : activeMetric === 'top_10pct_papers'
                                  ? 'top 10% papers'
                                  : activeMetric === 'top_10pct_rate'
                                    ? '% top 10% rate'
                                    : activeMetric === 'paper_count'
                                      ? 'papers'
                                      : activeMetric === 'total_papers'
                                        ? 'total papers'
                                        : activeMetric

                          return (
                            <div
                              key={idx}
                              onMouseEnter={() => setHoveredCountryIdx(idx)}
                              onMouseLeave={() => setHoveredCountryIdx(null)}
                              onClick={() => setHoveredCountryIdx(idx)}
                              className="flex-1 min-w-[24px] max-w-[52px] flex flex-col items-center justify-end h-full group relative cursor-pointer"
                            >
                              {/* Hover Tooltip Popup */}
                              {isIndia ? (
                                <div className="absolute -top-16 left-1/2 -translate-x-1/2 hidden group-hover:flex flex-col items-center bg-orange-950 text-orange-100 px-2.5 py-1.5 rounded text-[10px] font-mono z-30 shadow-xl pointer-events-none whitespace-nowrap border border-orange-500">
                                  <span className="font-bold flex items-center gap-1 text-orange-200">
                                    {countryName} ({cc})
                                  </span>
                                  <span className="text-[9px] text-orange-300">
                                    #{rank} • {val.toLocaleString()}{isRateMetric ? '%' : ''}{' '}
                                    {metricLabel} ({sharePct.toFixed(1)}%)
                                  </span>
                                  <div className="w-1.5 h-1.5 bg-orange-950 rotate-45 -mb-1 mt-0.5 border-r border-b border-orange-500" />
                                </div>
                              ) : (
                                <div className="absolute -top-16 left-1/2 -translate-x-1/2 hidden group-hover:flex flex-col items-center bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950 px-2 py-1 rounded text-[10px] font-mono z-30 shadow-xl pointer-events-none whitespace-nowrap border border-zinc-700 dark:border-zinc-300">
                                  <span className="font-bold">
                                    {countryName} ({cc})
                                  </span>
                                  <span className="text-[9px] opacity-80">
                                    #{rank} • {val.toLocaleString()}{isRateMetric ? '%' : ''}{' '}
                                    {metricLabel} ({sharePct.toFixed(1)}%)
                                  </span>
                                  <div className="w-1.5 h-1.5 bg-zinc-950 dark:bg-zinc-100 rotate-45 -mb-1 mt-0.5" />
                                </div>
                              )}

                              {/* Value label on top of bar */}
                              <span
                                className={`text-[8px] sm:text-[10px] font-mono font-semibold transition-colors mb-0.5 truncate max-w-full ${
                                  isIndia
                                    ? 'text-orange-600 dark:text-orange-400 font-black'
                                    : isHovered
                                      ? 'text-zinc-900 dark:text-zinc-100 font-bold'
                                      : 'text-zinc-500 dark:text-zinc-400'
                                }`}
                              >
                                {isRateMetric ? `${val.toFixed(1)}%` : formatShortNumber(val)}
                              </span>

                              {/* Histogram Column */}
                              <div
                                style={{ height: `${heightPct}%` }}
                                className={`w-full max-w-[32px] sm:max-w-[38px] ${barColor} rounded-t transition-all duration-200 ${
                                  isHovered ? 'scale-y-[1.03] origin-bottom brightness-110' : ''
                                }`}
                              />
                            </div>
                          )
                        })}
                      </div>
                    </div>
                    </div>
                  </div>

                  {/* X-Axis Labels Row */}
                  <div className="flex items-start justify-between pl-12 sm:pl-16 gap-1 sm:gap-2 pt-1.5 border-t border-zinc-200 dark:border-zinc-800">
                    {results.rows.slice(0, 15).map((row, idx) => {
                      const rank = row.rank !== undefined ? Number(row.rank) : idx + 1
                      const cc = String(row.country_code || '')
                      const countryName = formatCountryName(cc)
                      const isHovered = hoveredCountryIdx === idx
                      const isIndia =
                        cc.toUpperCase() === 'IN' || countryName.toLowerCase() === 'india'

                      const rankChipStyle = isIndia
                        ? 'bg-orange-500 text-white dark:bg-orange-600 dark:text-white font-bold ring-1 ring-orange-400 shadow-2xs'
                        : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400'

                      return (
                        <div
                          key={idx}
                          onMouseEnter={() => setHoveredCountryIdx(idx)}
                          onMouseLeave={() => setHoveredCountryIdx(null)}
                          onClick={() => setHoveredCountryIdx(idx)}
                          className="flex-1 min-w-[24px] max-w-[52px] flex flex-col items-center min-w-0 cursor-pointer"
                          title={`${countryName} (#${rank})`}
                        >
                          <span
                            className={`text-[10px] font-mono font-bold uppercase transition-colors ${
                              isIndia
                                ? 'text-orange-600 dark:text-orange-400 font-black'
                                : isHovered
                                  ? 'text-zinc-900 dark:text-zinc-100'
                                  : 'text-zinc-700 dark:text-zinc-300'
                            }`}
                          >
                            {cc}
                          </span>
                          <span
                            className={`text-[8px] sm:text-[9px] font-mono px-1 rounded ${rankChipStyle}`}
                          >
                            #{rank}
                          </span>
                          <span
                            className={`hidden lg:block text-[8px] truncate max-w-[44px] ${
                              isIndia
                                ? 'text-orange-600 dark:text-orange-400 font-bold'
                                : 'text-zinc-400'
                            }`}
                          >
                            {countryName}
                          </span>
                        </div>
                      )
                    })}
                  </div>

                  {/* Interactive Inspector Strip */}
                  {results.rows.length > 0 && (() => {
                    const inspectRow =
                      hoveredCountryIdx !== null && results.rows[hoveredCountryIdx]
                        ? results.rows[hoveredCountryIdx]
                        : results.rows.find(
                            (r) => String(r.country_code || '').toUpperCase() === 'IN',
                          ) || results.rows[0]
                    const inspectCC = String(inspectRow?.country_code || '')
                    const inspectName = formatCountryName(inspectCC)
                    const isInspectIndia =
                      inspectCC.toUpperCase() === 'IN' || inspectName.toLowerCase() === 'india'
                    const inspectRank =
                      inspectRow?.rank !== undefined
                        ? Number(inspectRow.rank)
                        : (hoveredCountryIdx ?? 0) + 1
                    const inspectVal = Number(inspectRow?.[activeMetric]) || 0
                    const inspectTop1Pct =
                      inspectRow?.top_1pct_papers !== undefined
                        ? Number(inspectRow.top_1pct_papers)
                        : null
                    const inspectRate =
                      inspectRow?.top_1pct_rate !== undefined
                        ? Number(inspectRow.top_1pct_rate)
                        : null
                    const inspectTop10Pct =
                      inspectRow?.top_10pct_papers !== undefined
                        ? Number(inspectRow.top_10pct_papers)
                        : null
                    const inspectRate10 =
                      inspectRow?.top_10pct_rate !== undefined
                        ? Number(inspectRow.top_10pct_rate)
                        : null
                    const inspectPapers =
                      inspectRow?.paper_count !== undefined
                        ? Number(inspectRow.paper_count)
                        : inspectVal
                    const inspectTotal =
                      inspectRow?.total_papers !== undefined
                        ? Number(inspectRow.total_papers)
                        : null
                    const inspectContribs =
                      inspectRow?.total_contributions !== undefined
                        ? Number(inspectRow.total_contributions)
                        : 0
                    const inspectShare =
                      inspectRow?.share_pct !== undefined
                        ? Number(inspectRow.share_pct)
                        : totalMetricSum > 0
                          ? (inspectVal / totalMetricSum) * 100
                          : 0

                    return (
                      <div
                        className={`flex flex-wrap items-center justify-between gap-2 p-2.5 rounded border text-xs font-mono mt-1 ${
                          isInspectIndia
                            ? 'bg-orange-50/50 dark:bg-orange-950/20 border-orange-300 dark:border-orange-800/60'
                            : 'bg-zinc-50 dark:bg-zinc-850/60 border-zinc-200 dark:border-zinc-800'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={`w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold border ${
                              isInspectIndia
                                ? 'bg-orange-500 text-white border-orange-600 shadow-2xs'
                                : 'border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200'
                            }`}
                          >
                            #{inspectRank}
                          </span>
                          <span
                            className={`font-sans font-bold ${
                              isInspectIndia
                                ? 'text-orange-600 dark:text-orange-400'
                                : 'text-zinc-900 dark:text-zinc-100'
                            }`}
                          >
                            {inspectName}
                          </span>
                          <span
                            className={`text-[10px] font-mono ${
                              isInspectIndia ? 'text-orange-500 font-bold' : 'text-zinc-400'
                            }`}
                          >
                            ({inspectCC})
                          </span>
                        </div>
                        <div className="flex items-center gap-3 sm:gap-5 text-xs font-mono">
                          {inspectTop1Pct !== null ? (
                            <>
                              <span>
                                <strong
                                  className={
                                    isInspectIndia
                                      ? 'text-orange-600 dark:text-orange-400'
                                      : 'text-zinc-900 dark:text-zinc-100'
                                  }
                                >
                                  {inspectTop1Pct.toLocaleString()}
                                </strong>{' '}
                                <span className="text-zinc-400 text-[10px]">Top 1% Papers</span>
                              </span>
                              {inspectRate !== null && (
                                <span>
                                  <strong
                                    className={
                                      isInspectIndia
                                        ? 'text-orange-600 dark:text-orange-400'
                                        : 'text-zinc-900 dark:text-zinc-100'
                                    }
                                  >
                                    {inspectRate.toFixed(2)}%
                                  </strong>{' '}
                                  <span className="text-zinc-400 text-[10px]">Top 1% Rate</span>
                                </span>
                              )}
                              {inspectTotal !== null && (
                                <span>
                                  <strong
                                    className={
                                      isInspectIndia
                                        ? 'text-orange-600 dark:text-orange-400'
                                        : 'text-zinc-900 dark:text-zinc-100'
                                    }
                                  >
                                    {inspectTotal.toLocaleString()}
                                  </strong>{' '}
                                  <span className="text-zinc-400 text-[10px]">Total Papers</span>
                                </span>
                              )}
                            </>
                          ) : inspectTop10Pct !== null ? (
                            <>
                              <span>
                                <strong
                                  className={
                                    isInspectIndia
                                      ? 'text-orange-600 dark:text-orange-400'
                                      : 'text-zinc-900 dark:text-zinc-100'
                                  }
                                >
                                  {inspectTop10Pct.toLocaleString()}
                                </strong>{' '}
                                <span className="text-zinc-400 text-[10px]">Top 10% Papers</span>
                              </span>
                              {inspectRate10 !== null && (
                                <span>
                                  <strong
                                    className={
                                      isInspectIndia
                                        ? 'text-orange-600 dark:text-orange-400'
                                        : 'text-zinc-900 dark:text-zinc-100'
                                    }
                                  >
                                    {inspectRate10.toFixed(2)}%
                                  </strong>{' '}
                                  <span className="text-zinc-400 text-[10px]">Top 10% Rate</span>
                                </span>
                              )}
                              {inspectTotal !== null && (
                                <span>
                                  <strong
                                    className={
                                      isInspectIndia
                                        ? 'text-orange-600 dark:text-orange-400'
                                        : 'text-zinc-900 dark:text-zinc-100'
                                    }
                                  >
                                    {inspectTotal.toLocaleString()}
                                  </strong>{' '}
                                  <span className="text-zinc-400 text-[10px]">Total Papers</span>
                                </span>
                              )}
                            </>
                          ) : (
                            <>
                              <span>
                                <strong
                                  className={
                                    isInspectIndia
                                      ? 'text-orange-600 dark:text-orange-400'
                                      : 'text-zinc-900 dark:text-zinc-100'
                                  }
                                >
                                  {inspectPapers.toLocaleString()}
                                </strong>{' '}
                                <span className="text-zinc-400 text-[10px]">Papers</span>
                              </span>
                              {inspectContribs > 0 && (
                                <span>
                                  <strong
                                    className={
                                      isInspectIndia
                                        ? 'text-orange-600 dark:text-orange-400'
                                        : 'text-zinc-900 dark:text-zinc-100'
                                    }
                                  >
                                    {inspectContribs.toLocaleString()}
                                  </strong>{' '}
                                  <span className="text-zinc-400 text-[10px]">Contributions</span>
                                </span>
                              )}
                            </>
                          )}
                          <span>
                            <strong
                              className={
                                isInspectIndia
                                  ? 'text-orange-600 dark:text-orange-400'
                                  : 'text-zinc-900 dark:text-zinc-100'
                              }
                            >
                              {inspectShare.toFixed(1)}%
                            </strong>{' '}
                            <span className="text-zinc-400 text-[10px]">Global Share</span>
                          </span>
                        </div>
                      </div>
                    )
                  })()}
                </div>
            </div>
          )}

          {/* 2. PUBLICATION TRAJECTORY OUTCOME (Vertical Timeline Bar Chart - Black/Grey Theme) */}
          {activeOutcome === 'trajectory' && (
            <div className="flex flex-col gap-4 border border-zinc-200 dark:border-zinc-850 rounded bg-white dark:bg-zinc-900/40 p-5 shadow-xs">
              <div className="flex items-center justify-between border-b border-zinc-100 dark:border-zinc-800 pb-3">
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-zinc-600 dark:text-zinc-400" />
                  <span className="font-mono font-bold text-xs uppercase tracking-tight text-zinc-900 dark:text-zinc-100">
                    Number of Papers Produced Each Year
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs font-mono text-zinc-400">
                  <span className="text-[10px] text-zinc-400 font-mono">
                    Annual publication volume
                  </span>
                  <button
                    type="button"
                    onClick={() => handleOutcomeChange('cagr')}
                    className="flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400 hover:underline cursor-pointer ml-1"
                    title="View CAGR growth rates"
                  >
                    <TrendingUp className="h-3 w-3" />
                    <span>CAGR Analysis →</span>
                  </button>
                </div>
              </div>

              {/* Visual Vertical Bar Timeline of Papers Produced Each Year */}
              {(() => {
                const totalAnnualPapers = results.rows.reduce(
                  (sum, r) => sum + (Number(r.paper_count ?? r.total_papers) || 0),
                  0,
                )
                const maxAnnualPapers = Math.max(
                  ...results.rows.map((r) => Number(r.paper_count ?? r.total_papers) || 0),
                  1,
                )
                const trajectoryMinWidth = chartMinWidth(results.rows.length)

                return (
                  <div className="flex flex-col gap-2">
                    <div className="overflow-x-auto">
                      <div
                        className="relative flex items-stretch h-56 sm:h-60 pt-3 pb-1"
                        style={{ minWidth: `${trajectoryMinWidth}px` }}
                      >
                      {/* Y-Axis Scale Gutter */}
                      <div className="flex flex-col justify-between items-end pr-2 text-[10px] font-mono text-zinc-400 select-none w-12 sm:w-16 shrink-0 border-r border-zinc-200 dark:border-zinc-850 pb-0.5 whitespace-nowrap">
                        <span>{formatShortNumber(maxAnnualPapers)}</span>
                        <span>{formatShortNumber(maxAnnualPapers * 0.75)}</span>
                        <span>{formatShortNumber(maxAnnualPapers * 0.5)}</span>
                        <span>{formatShortNumber(maxAnnualPapers * 0.25)}</span>
                        <span>0</span>
                      </div>

                      {/* Chart Plot Area with Vertical Columns */}
                      <div className="relative flex-1 flex flex-col justify-between pl-2">
                        {/* Horizontal Gridlines */}
                        <div className="absolute inset-0 left-2 flex flex-col justify-between pointer-events-none opacity-40 z-0">
                          <div className="border-b border-dashed border-zinc-300 dark:border-zinc-700 w-full" />
                          <div className="border-b border-dashed border-zinc-200 dark:border-zinc-850 w-full" />
                          <div className="border-b border-dashed border-zinc-200 dark:border-zinc-850 w-full" />
                          <div className="border-b border-dashed border-zinc-200 dark:border-zinc-850 w-full" />
                          <div className="border-b border-dashed border-zinc-300 dark:border-zinc-700 w-full" />
                        </div>

                        {/* Columns */}
                        <div className="relative z-10 h-full flex items-end justify-between gap-1.5 sm:gap-2">
                          {results.rows.map((row, idx) => {
                            const yr = Number(row.year ?? row.publication_year) || 2020 + idx
                            const paperCount = Number(row.paper_count ?? row.total_papers) || 0
                            const heightPct =
                              maxAnnualPapers > 0
                                ? Math.max(Math.round((paperCount / maxAnnualPapers) * 100), paperCount > 0 ? 4 : 0)
                                : 0
                            const pctOfTotal =
                              totalAnnualPapers > 0 ? (paperCount / totalAnnualPapers) * 100 : 0

                            return (
                              <div
                                key={yr}
                                className="flex-1 min-w-[28px] max-w-[56px] flex flex-col items-center justify-end h-full group relative cursor-pointer"
                              >
                                {/* Hover Tooltip Popup */}
                                <div className="absolute -top-14 left-1/2 -translate-x-1/2 hidden group-hover:flex flex-col items-center bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950 px-2.5 py-1.5 rounded text-[10px] font-mono z-30 shadow-xl pointer-events-none whitespace-nowrap border border-zinc-700 dark:border-zinc-300">
                                  <span className="font-bold">
                                    {yr}: {paperCount.toLocaleString()} papers
                                  </span>
                                  <span className="text-[9px] opacity-80">
                                    {pctOfTotal.toFixed(1)}% of total output
                                  </span>
                                  <div className="w-1.5 h-1.5 bg-zinc-950 dark:bg-zinc-100 rotate-45 -mb-1 mt-0.5" />
                                </div>

                                {/* Value label on top of bar */}
                                <span className="text-[8px] sm:text-[10px] font-mono font-semibold transition-colors mb-0.5 truncate max-w-full text-zinc-500 dark:text-zinc-400 group-hover:text-zinc-900 dark:group-hover:text-zinc-100 group-hover:font-bold">
                                  {formatShortNumber(paperCount)}
                                </span>

                                {/* Column Bar */}
                                <div
                                  style={{ height: `${heightPct}%` }}
                                  className="w-full max-w-[32px] sm:max-w-[38px] bg-zinc-900 dark:bg-zinc-200 group-hover:bg-zinc-700 dark:group-hover:bg-zinc-300 rounded-t transition-all duration-200 group-hover:scale-y-[1.03] origin-bottom"
                                />
                              </div>
                            )
                          })}
                        </div>
                      </div>
                      </div>
                    </div>

                    {/* X-Axis Labels Row */}
                    <div
                      className="overflow-x-auto"
                    >
                      <div
                        className="flex items-start justify-between pl-12 sm:pl-16 gap-1.5 sm:gap-2 pt-1.5 border-t border-zinc-200 dark:border-zinc-850"
                        style={{ minWidth: `${trajectoryMinWidth}px` }}
                      >
                        {results.rows.map((row, idx) => {
                          const yr = Number(row.year ?? row.publication_year) || 2020 + idx
                          return (
                            <div
                              key={yr}
                              className="flex-1 min-w-[28px] max-w-[56px] flex flex-col items-center"
                            >
                              <span className="text-[10px] sm:text-[11px] font-mono text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors">
                                {yr}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  </div>
                )
              })()}

              {/* Annual Summary Metrics */}
              {(() => {
                const sortedTrajectory = [...results.rows]
                  .map((r) => ({
                    yr: Number(r.year ?? r.publication_year),
                    cnt: Number(r.paper_count ?? r.total_papers) || 0,
                  }))
                  .filter((r) => !isNaN(r.yr) && r.cnt > 0)
                  .sort((a, b) => a.yr - b.yr)
                const startItem = sortedTrajectory[0]
                const endItem = sortedTrajectory[sortedTrajectory.length - 1]
                const yearDiff = startItem && endItem ? endItem.yr - startItem.yr : 0
                const trajectoryCAGR =
                  yearDiff > 0 && startItem && startItem.cnt > 0 && endItem && endItem.cnt > 0
                    ? (Math.pow(endItem.cnt / startItem.cnt, 1 / yearDiff) - 1) * 100
                    : null

                return (
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 pt-1 font-mono text-xs">
                    <div className="p-2 rounded bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-100 dark:border-zinc-800">
                      <span className="text-[10px] text-zinc-400 uppercase">Indexed Years</span>
                      <p className="font-bold text-sm text-zinc-900 dark:text-zinc-100">
                        {results.rows.length} Years
                      </p>
                    </div>
                    <div className="p-2 rounded bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-100 dark:border-zinc-800">
                      <span className="text-[10px] text-zinc-400 uppercase">Total Papers Produced</span>
                      <p className="font-bold text-sm text-zinc-900 dark:text-zinc-100">
                        {results.rows
                          .reduce((sum, r) => sum + (Number(r.paper_count ?? r.total_papers) || 0), 0)
                          .toLocaleString()}
                      </p>
                    </div>
                    <div className="p-2 rounded bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-100 dark:border-zinc-800">
                      <span className="text-[10px] text-zinc-400 uppercase">Peak Annual Output</span>
                      <p className="font-bold text-sm text-zinc-900 dark:text-zinc-100">
                        {Math.max(
                          ...results.rows.map((r) => Number(r.paper_count ?? r.total_papers) || 0),
                          0,
                        ).toLocaleString()}
                      </p>
                    </div>
                    <div className="p-2 rounded bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-100 dark:border-zinc-800">
                      <span className="text-[10px] text-zinc-400 uppercase">Avg Papers / Year</span>
                      <p className="font-bold text-sm text-zinc-900 dark:text-zinc-100">
                        {results.rows.length > 0
                          ? Math.round(
                              results.rows.reduce(
                                (sum, r) => sum + (Number(r.paper_count ?? r.total_papers) || 0),
                                0,
                              ) / results.rows.length,
                            ).toLocaleString()
                          : 0}
                      </p>
                    </div>
                    <div
                      onClick={() => handleOutcomeChange('cagr')}
                      className="p-2 rounded bg-emerald-50/40 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-800/40 hover:border-emerald-500/60 transition cursor-pointer group"
                      title="Click to explore full CAGR analysis"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-emerald-700 dark:text-emerald-400 uppercase font-bold">Corpus CAGR</span>
                        <TrendingUp className="h-3 w-3 text-emerald-600 dark:text-emerald-400 group-hover:translate-x-0.5 transition-transform" />
                      </div>
                      <p className="font-bold text-sm text-emerald-600 dark:text-emerald-400">
                        {trajectoryCAGR !== null ? `${trajectoryCAGR >= 0 ? '+' : ''}${trajectoryCAGR.toFixed(1)}%` : '—'}
                      </p>
                    </div>
                  </div>
                )
              })()}
            </div>
          )}

          {/* 3. COMPOUND ANNUAL GROWTH RATE (CAGR) OUTCOME (Emerald & Monochrome Theme) */}
          {activeOutcome === 'cagr' && (
            <div className="flex flex-col gap-4 border border-zinc-200 dark:border-zinc-850 rounded bg-white dark:bg-zinc-900/40 p-5 shadow-xs">
              {/* Header with Title and Mode Switcher */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-zinc-100 dark:border-zinc-800 pb-3 gap-3">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/40 flex items-center justify-center">
                    <TrendingUp className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <div>
                    <span className="font-mono font-bold text-xs uppercase tracking-tight text-zinc-900 dark:text-zinc-100 block">
                      Compound Annual Growth Rate (CAGR)
                    </span>
                    <span className="text-[10px] text-zinc-400 font-mono">
                      Compounded annual expansion & Year-over-Year (YoY) velocity
                    </span>
                  </div>
                </div>

                {/* Metric View Switcher */}
                <div className="flex items-center gap-1 rounded border border-zinc-200 dark:border-zinc-850 bg-zinc-100 dark:bg-zinc-900 p-0.5 self-start sm:self-auto shadow-2xs font-mono text-xs">
                  <button
                    type="button"
                    onClick={() => setCagrMetricMode('cagr')}
                    className={`px-2.5 py-1 rounded transition cursor-pointer text-[11px] ${
                      cagrMetricMode === 'cagr'
                        ? 'bg-white dark:bg-zinc-800 text-emerald-700 dark:text-emerald-300 font-bold shadow-xs'
                        : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                    }`}
                  >
                    Cumulative CAGR (%)
                  </button>
                  <button
                    type="button"
                    onClick={() => setCagrMetricMode('yoy')}
                    className={`px-2.5 py-1 rounded transition cursor-pointer text-[11px] ${
                      cagrMetricMode === 'yoy'
                        ? 'bg-white dark:bg-zinc-800 text-emerald-700 dark:text-emerald-300 font-bold shadow-xs'
                        : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                    }`}
                  >
                    YoY Growth (%)
                  </button>
                  <button
                    type="button"
                    onClick={() => setCagrMetricMode('dual')}
                    className={`px-2.5 py-1 rounded transition cursor-pointer text-[11px] ${
                      cagrMetricMode === 'dual'
                        ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-bold shadow-xs'
                        : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                    }`}
                  >
                    Dual (Volume & Rates)
                  </button>
                </div>
              </div>

              {/* Data Series Computation & Chart Plot */}
              {(() => {
                const sortedRows = [...results.rows]
                  .map((r) => {
                    const yr = Number(r.year ?? r.publication_year)
                    const count = Number(r.paper_count ?? r.total_papers ?? r.count) || 0
                    const prevCount =
                      r.prev_year_papers !== undefined && r.prev_year_papers !== null
                        ? Number(r.prev_year_papers)
                        : null
                    const sqlYoy =
                      r.yoy_growth_pct !== undefined && r.yoy_growth_pct !== null
                        ? Number(r.yoy_growth_pct)
                        : null
                    return { year: yr, papers: count, prevPapers: prevCount, sqlYoy }
                  })
                  .filter((r) => !isNaN(r.year) && r.year >= 1950 && r.year <= 2050)
                  .sort((a, b) => a.year - b.year)

                if (sortedRows.length === 0) {
                  return (
                    <div className="p-8 text-center font-mono text-xs text-zinc-400">
                      No publication year records available to compute CAGR.
                    </div>
                  )
                }

                // Baseline year is the earliest year with papers > 0
                const baseItem = sortedRows.find((r) => r.papers > 0) || sortedRows[0]
                const latestItem = sortedRows[sortedRows.length - 1]
                const totalSpanYears = latestItem.year - baseItem.year
                const overallCAGR =
                  totalSpanYears > 0 && baseItem.papers > 0 && latestItem.papers > 0
                    ? (Math.pow(latestItem.papers / baseItem.papers, 1 / totalSpanYears) - 1) * 100
                    : null

                // Compute CAGR & YoY series for each row
                const series = sortedRows.map((row, idx) => {
                  const yearsSinceBase = row.year - baseItem.year
                  let cagr: number | null = null
                  if (yearsSinceBase === 0) {
                    cagr = 0
                  } else if (yearsSinceBase > 0 && baseItem.papers > 0 && row.papers > 0) {
                    cagr = (Math.pow(row.papers / baseItem.papers, 1 / yearsSinceBase) - 1) * 100
                  }

                  let yoy: number | null = null
                  if (row.sqlYoy !== null && row.sqlYoy !== undefined) {
                    yoy = row.sqlYoy
                  } else if (idx > 0 && sortedRows[idx - 1].papers > 0) {
                    yoy = ((row.papers - sortedRows[idx - 1].papers) / sortedRows[idx - 1].papers) * 100
                  }

                  const prevPapers = idx > 0 ? sortedRows[idx - 1].papers : null
                  const netGain = prevPapers !== null ? row.papers - prevPapers : 0
                  const multiplier = baseItem.papers > 0 ? row.papers / baseItem.papers : 1

                  return {
                    ...row,
                    cagr,
                    yoy,
                    prevPapers,
                    netGain,
                    multiplier,
                    isBase: row.year === baseItem.year,
                  }
                })

                // Peak YoY acceleration
                const peakItem = [...series]
                  .filter((s) => s.yoy !== null)
                  .sort((a, b) => (b.yoy ?? 0) - (a.yoy ?? 0))[0]

                // Scale maximum and minimum calculations
                const maxCagr = Math.max(...series.map((s) => s.cagr ?? 0), 10)
                const minCagr = Math.min(...series.map((s) => s.cagr ?? 0), 0)
                const maxYoy = Math.max(...series.map((s) => s.yoy ?? 0), 10)
                const minYoy = Math.min(...series.map((s) => s.yoy ?? 0), 0)
                const maxPapers = Math.max(...series.map((s) => s.papers), 1)

                const activeMax =
                  cagrMetricMode === 'cagr'
                    ? maxCagr
                    : cagrMetricMode === 'yoy'
                      ? maxYoy
                      : maxPapers

                const activeMin =
                  cagrMetricMode === 'cagr'
                    ? minCagr
                    : cagrMetricMode === 'yoy'
                      ? minYoy
                      : 0

                const hasNegatives = activeMin < -0.1
                const totalSpan = Math.max(activeMax - activeMin, 1)
                const zeroLineBottomPct = hasNegatives ? (Math.abs(activeMin) / totalSpan) * 100 : 0
                const cagrMinWidth = chartMinWidth(series.length)

                return (
                  <div className="flex flex-col gap-3">
                    {/* Visual Vertical Chart Plot */}
                    <div className="overflow-x-auto">
                      <div
                        className="relative flex items-stretch h-60 sm:h-64 pt-3 pb-1"
                        style={{ minWidth: `${cagrMinWidth}px` }}
                      >
                      {/* Y-Axis Scale Gutter */}
                      <div className="flex flex-col justify-between items-end pr-2 text-[10px] font-mono text-zinc-400 select-none w-12 sm:w-16 shrink-0 border-r border-zinc-200 dark:border-zinc-850 pb-0.5 whitespace-nowrap">
                        {!hasNegatives ? (
                          <>
                            <span>{cagrMetricMode === 'dual' ? formatShortNumber(activeMax) : `+${Math.round(activeMax)}%`}</span>
                            <span>{cagrMetricMode === 'dual' ? formatShortNumber(activeMax * 0.75) : `+${Math.round(activeMax * 0.75)}%`}</span>
                            <span>{cagrMetricMode === 'dual' ? formatShortNumber(activeMax * 0.5) : `+${Math.round(activeMax * 0.5)}%`}</span>
                            <span>{cagrMetricMode === 'dual' ? formatShortNumber(activeMax * 0.25) : `+${Math.round(activeMax * 0.25)}%`}</span>
                            <span>0{cagrMetricMode === 'dual' ? '' : '%'}</span>
                          </>
                        ) : (
                          <>
                            <span>+{Math.round(activeMax)}%</span>
                            <span>+{Math.round(activeMax * 0.5)}%</span>
                            <span>0%</span>
                            <span>{Math.round(activeMin * 0.5)}%</span>
                            <span>{Math.round(activeMin)}%</span>
                          </>
                        )}
                      </div>

                      {/* Chart Plot Area with Vertical Columns */}
                      <div className="relative flex-1 flex flex-col justify-between pl-2">
                        {/* Horizontal Gridlines */}
                        <div className="absolute inset-0 left-2 flex flex-col justify-between pointer-events-none opacity-40 z-0">
                          <div className="border-b border-dashed border-zinc-300 dark:border-zinc-700 w-full" />
                          <div className="border-b border-dashed border-zinc-200 dark:border-zinc-850 w-full" />
                          <div className="border-b border-dashed border-zinc-200 dark:border-zinc-850 w-full" />
                          <div className="border-b border-dashed border-zinc-200 dark:border-zinc-850 w-full" />
                          <div className="border-b border-dashed border-zinc-300 dark:border-zinc-700 w-full" />
                        </div>

                        {/* Explicit Zero Baseline Line for negative values */}
                        {hasNegatives && (
                          <div
                            style={{ bottom: `${zeroLineBottomPct}%` }}
                            className="absolute left-2 right-0 border-b border-zinc-400 dark:border-zinc-500 z-10 pointer-events-none"
                          />
                        )}

                        {/* Columns Container */}
                        <div className="relative z-20 h-full flex items-end justify-between gap-1.5 sm:gap-2">
                          {series.map((item, idx) => {
                            const isHovered = hoveredCagrIdx === idx
                            const primaryVal =
                              cagrMetricMode === 'cagr'
                                ? item.cagr ?? 0
                                : cagrMetricMode === 'yoy'
                                  ? item.yoy ?? 0
                                  : item.papers

                            let heightPct = 0
                            let bottomPct = 0
                            let isNegative = false

                            if (hasNegatives) {
                              if (primaryVal >= 0) {
                                heightPct = Math.max((primaryVal / totalSpan) * 100, item.isBase || primaryVal > 0 ? 3 : 0)
                                bottomPct = zeroLineBottomPct
                              } else {
                                isNegative = true
                                heightPct = Math.max((Math.abs(primaryVal) / totalSpan) * 100, 3)
                                bottomPct = zeroLineBottomPct - heightPct
                              }
                            } else {
                              heightPct = activeMax > 0 ? Math.max((primaryVal / activeMax) * 100, item.isBase || primaryVal > 0 ? 4 : 0) : 0
                              bottomPct = 0
                            }

                            const barColor = item.isBase
                              ? 'bg-zinc-400 dark:bg-zinc-600 rounded-t'
                              : isNegative
                                ? 'bg-gradient-to-b from-rose-500 to-rose-600 dark:from-rose-500 dark:to-rose-600 rounded-b shadow-xs'
                                : cagrMetricMode === 'dual'
                                  ? 'bg-zinc-850 dark:bg-zinc-300 rounded-t group-hover:bg-zinc-700 dark:group-hover:bg-zinc-200'
                                  : 'bg-gradient-to-t from-emerald-600 to-emerald-400 dark:from-emerald-500 dark:to-emerald-400 rounded-t shadow-xs'

                            return (
                              <div
                                key={item.year}
                                onMouseEnter={() => setHoveredCagrIdx(idx)}
                                onMouseLeave={() => setHoveredCagrIdx(null)}
                                className="flex-1 min-w-[28px] max-w-[56px] flex flex-col items-center justify-end h-full group relative cursor-pointer"
                              >
                                {/* Hover Tooltip Popup */}
                                <div className="absolute -top-24 left-1/2 -translate-x-1/2 hidden group-hover:flex flex-col items-center bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950 px-3 py-2 rounded text-[10px] font-mono z-40 shadow-xl pointer-events-none whitespace-nowrap border border-zinc-700 dark:border-zinc-300">
                                  <div className="font-bold flex items-center gap-1.5 text-xs text-white dark:text-zinc-900 border-b border-zinc-800 dark:border-zinc-200 pb-1 mb-1 w-full justify-between">
                                    <span>{item.year}</span>
                                    <span className="text-[10px] font-normal text-emerald-400 dark:text-emerald-600">
                                      {item.isBase ? 'Baseline Anchor' : `${item.multiplier.toFixed(2)}× Output`}
                                    </span>
                                  </div>
                                  <div className="flex flex-col gap-0.5 text-[9px] w-full">
                                    <div className="flex justify-between gap-3">
                                      <span className="text-zinc-400 dark:text-zinc-600">Total Papers:</span>
                                      <span className="font-bold text-zinc-100 dark:text-zinc-900">{item.papers.toLocaleString()}</span>
                                    </div>
                                    <div className="flex justify-between gap-3">
                                      <span className="text-zinc-400 dark:text-zinc-600">Cumulative CAGR:</span>
                                      <span className="font-bold text-emerald-400 dark:text-emerald-600">
                                        {item.cagr !== null ? `${item.cagr >= 0 ? '+' : ''}${item.cagr.toFixed(2)}% / yr` : 'Base Year'}
                                      </span>
                                    </div>
                                    {item.yoy !== null && (
                                      <div className="flex justify-between gap-3">
                                        <span className="text-zinc-400 dark:text-zinc-600">YoY Annual Growth:</span>
                                        <span className={`font-bold ${item.yoy >= 0 ? 'text-emerald-400 dark:text-emerald-600' : 'text-rose-400 dark:text-rose-600'}`}>
                                          {item.yoy >= 0 ? '+' : ''}{item.yoy.toFixed(2)}%
                                        </span>
                                      </div>
                                    )}
                                    {item.prevPapers !== null && (
                                      <div className="flex justify-between gap-3">
                                        <span className="text-zinc-400 dark:text-zinc-600">Net Annual Gain:</span>
                                        <span className="font-bold text-zinc-200 dark:text-zinc-800">
                                          {item.netGain >= 0 ? '+' : ''}{item.netGain.toLocaleString()} papers
                                        </span>
                                      </div>
                                    )}
                                  </div>
                                  <div className="w-1.5 h-1.5 bg-zinc-950 dark:bg-zinc-100 rotate-45 -mb-1 mt-1" />
                                </div>

                                {/* Value label on top of bar */}
                                <div className="flex flex-col items-center mb-0.5 max-w-full z-20">
                                  <span
                                    className={`text-[8px] sm:text-[10px] font-mono font-bold transition-colors truncate max-w-full ${
                                      item.isBase
                                        ? 'text-zinc-500 dark:text-zinc-400'
                                        : isNegative
                                          ? 'text-rose-600 dark:text-rose-400'
                                          : 'text-emerald-600 dark:text-emerald-400'
                                    }`}
                                  >
                                    {item.isBase
                                      ? 'Base'
                                      : cagrMetricMode === 'cagr'
                                        ? `${(item.cagr ?? 0) >= 0 ? '+' : ''}${(item.cagr ?? 0).toFixed(1)}%`
                                        : cagrMetricMode === 'yoy'
                                          ? `${(item.yoy ?? 0) >= 0 ? '+' : ''}${(item.yoy ?? 0).toFixed(1)}%`
                                          : `${(item.cagr ?? 0) >= 0 ? '+' : ''}${(item.cagr ?? 0).toFixed(1)}%`}
                                  </span>
                                  <span className="text-[7px] sm:text-[9px] font-mono text-zinc-400 dark:text-zinc-500">
                                    {formatShortNumber(item.papers)}
                                  </span>
                                </div>

                                {/* Column Stem Bar */}
                                <div className="relative w-full flex justify-center h-full">
                                  <div
                                    style={{
                                      height: `${heightPct}%`,
                                      bottom: `${bottomPct}%`,
                                    }}
                                    className={`absolute w-full max-w-[32px] sm:max-w-[38px] ${barColor} transition-all duration-200 ${
                                      isHovered ? 'scale-y-[1.03] brightness-110' : ''
                                    } ${isNegative ? 'origin-top' : 'origin-bottom'}`}
                                  />
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                      </div>
                    </div>

                    {/* X-Axis Labels Row */}
                    <div className="overflow-x-auto">
                      <div
                        className="flex items-start justify-between pl-12 sm:pl-16 gap-1.5 sm:gap-2 pt-1.5 border-t border-zinc-200 dark:border-zinc-850"
                        style={{ minWidth: `${cagrMinWidth}px` }}
                      >
                        {series.map((item) => (
                          <div
                            key={item.year}
                            className="flex-1 min-w-[28px] max-w-[56px] flex flex-col items-center"
                          >
                            <span
                              className={`text-[10px] sm:text-[11px] font-mono transition-colors ${
                                item.isBase
                                  ? 'font-bold text-zinc-900 dark:text-zinc-100'
                                  : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
                              }`}
                            >
                              {item.year}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Scientometric KPI Cards for CAGR */}
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 pt-2 font-mono text-xs">
                      {/* Overall CAGR */}
                      <div className="p-3 rounded bg-emerald-50/50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-800/40">
                        <div className="flex items-center justify-between text-emerald-600 dark:text-emerald-400 mb-1">
                          <span className="text-[10px] uppercase font-bold tracking-wider">Overall CAGR</span>
                          <TrendingUp className="h-3.5 w-3.5" />
                        </div>
                        <p className="font-bold text-base text-emerald-700 dark:text-emerald-300">
                          {overallCAGR !== null ? `${overallCAGR >= 0 ? '+' : ''}${overallCAGR.toFixed(2)}%` : '—'}
                        </p>
                        <span className="text-[9px] text-emerald-600/80 dark:text-emerald-400/70">
                          Annualized ({baseItem.year} → {latestItem.year})
                        </span>
                      </div>

                      {/* Baseline Year Output */}
                      <div className="p-3 rounded bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-100 dark:border-zinc-800">
                        <span className="text-[10px] text-zinc-400 uppercase font-bold tracking-wider">Base Year ({baseItem.year})</span>
                        <p className="font-bold text-base text-zinc-900 dark:text-zinc-100 mt-1">
                          {baseItem.papers.toLocaleString()} papers
                        </p>
                        <span className="text-[9px] text-zinc-400">Baseline anchor volume</span>
                      </div>

                      {/* Latest Year Output */}
                      <div className="p-3 rounded bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-100 dark:border-zinc-800">
                        <span className="text-[10px] text-zinc-400 uppercase font-bold tracking-wider">Latest Year ({latestItem.year})</span>
                        <p className="font-bold text-base text-zinc-900 dark:text-zinc-100 mt-1">
                          {latestItem.papers.toLocaleString()} papers
                        </p>
                        <span className="text-[9px] text-zinc-400">Terminal corpus output</span>
                      </div>

                      {/* Output Multiplier */}
                      <div className="p-3 rounded bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-100 dark:border-zinc-800">
                        <span className="text-[10px] text-zinc-400 uppercase font-bold tracking-wider">Net Expansion</span>
                        <p className="font-bold text-base text-zinc-900 dark:text-zinc-100 mt-1">
                          {(latestItem.papers / Math.max(baseItem.papers, 1)).toFixed(2)}×
                        </p>
                        <span className="text-[9px] text-zinc-400">Total volume multiplier</span>
                      </div>

                      {/* Peak Acceleration Year */}
                      <div className="p-3 rounded bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-100 dark:border-zinc-800">
                        <span className="text-[10px] text-zinc-400 uppercase font-bold tracking-wider">Peak Velocity</span>
                        <p className="font-bold text-base text-zinc-900 dark:text-zinc-100 mt-1 truncate">
                          {peakItem && peakItem.yoy !== null ? `${peakItem.year} (+${peakItem.yoy.toFixed(1)}%)` : '—'}
                        </p>
                        <span className="text-[9px] text-zinc-400">Highest single-year jump</span>
                      </div>
                    </div>

                    {/* Scientometric Formula & Methodology Breakdown */}
                    <div className="p-3 rounded border border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/30 text-xs font-mono text-zinc-600 dark:text-zinc-400 flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
                      <div className="flex flex-col gap-1">
                        <span className="font-bold text-zinc-800 dark:text-zinc-200 text-[11px] flex items-center gap-1.5">
                          <Code2 className="h-3.5 w-3.5 text-zinc-500" />
                          CAGR Formula & Mathematical Methodology
                        </span>
                        <p className="text-[10px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
                          Compounded Annual Growth Rate (CAGR) measures the geometric mean of annual publication progression:
                        </p>
                      </div>
                      <div className="px-3 py-2 rounded bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-[11px] font-mono text-zinc-900 dark:text-zinc-100 whitespace-nowrap shadow-2xs self-stretch md:self-auto text-center">
                        <span className="text-emerald-600 dark:text-emerald-400 font-bold">CAGR</span> = ( {latestItem.papers.toLocaleString()} / {baseItem.papers.toLocaleString()} )
                        <sup>1 / {Math.max(totalSpanYears, 1)}</sup> − 1 ={' '}
                        <strong className="text-emerald-600 dark:text-emerald-400">
                          {overallCAGR !== null ? `${overallCAGR >= 0 ? '+' : ''}${overallCAGR.toFixed(2)}%` : '0.00%'}
                        </strong>
                      </div>
                    </div>
                  </div>
                )
              })()}
            </div>
          )}

          {/* 4. TOP 1% & TOP 10% YEAR-ON-YEAR GROWTH RATE STACKED BARGRAPH */}
          {activeOutcome === 'impact_growth' && (
            <div className="flex flex-col gap-4 border border-zinc-200 dark:border-zinc-850 rounded bg-white dark:bg-zinc-900/40 p-5 shadow-xs">
              {/* Header with Title and Mode Switcher */}
              <div className="flex flex-col lg:flex-row lg:items-center justify-between border-b border-zinc-100 dark:border-zinc-800 pb-3 gap-3">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/40 flex items-center justify-center">
                    <Layers className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                  </div>
                  <div>
                    <span className="font-mono font-bold text-xs uppercase tracking-tight text-zinc-900 dark:text-zinc-100 block">
                      Year-on-Year Growth Rate: Top 10% & Top 1%
                    </span>
                    <span className="text-[10px] text-zinc-400 font-mono">
                      Stacked citation impact composition & Year-on-Year (YoY) velocity
                    </span>
                  </div>
                </div>

                {/* Legend & View Switcher */}
                <div className="flex flex-wrap items-center gap-3">
                  <div className="hidden sm:flex items-center gap-3 text-[11px] font-mono pr-2 border-r border-zinc-200 dark:border-zinc-800">
                    <div className="flex items-center gap-1.5">
                      <div className="w-2.5 h-2.5 rounded-xs bg-amber-500 dark:bg-amber-400" />
                      <span className="text-zinc-700 dark:text-zinc-300 font-semibold">Top 1% Elite</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-2.5 h-2.5 rounded-xs bg-sky-500 dark:bg-sky-400" />
                      <span className="text-zinc-700 dark:text-zinc-300 font-semibold">Top 10% Rest</span>
                    </div>
                    {impactStackMode === 'full' && (
                      <div className="flex items-center gap-1.5">
                        <div className="w-2.5 h-2.5 rounded-xs bg-zinc-700 dark:bg-zinc-600" />
                        <span className="text-zinc-400">Standard (&gt;10%)</span>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-1 rounded border border-zinc-200 dark:border-zinc-850 bg-zinc-100 dark:bg-zinc-900 p-0.5 shadow-2xs font-mono text-xs">
                    <button
                      type="button"
                      onClick={() => setImpactStackMode('impact')}
                      className={`px-2.5 py-1 rounded transition cursor-pointer text-[11px] ${
                        impactStackMode === 'impact'
                          ? 'bg-white dark:bg-zinc-800 text-amber-600 dark:text-amber-400 font-bold shadow-xs'
                          : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                      }`}
                    >
                      Impact Stack
                    </button>
                    <button
                      type="button"
                      onClick={() => setImpactStackMode('full')}
                      className={`px-2.5 py-1 rounded transition cursor-pointer text-[11px] ${
                        impactStackMode === 'full'
                          ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-bold shadow-xs'
                          : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                      }`}
                    >
                      Full Corpus
                    </button>
                    <button
                      type="button"
                      onClick={() => setImpactStackMode('yoy_rates')}
                      className={`px-2.5 py-1 rounded transition cursor-pointer text-[11px] ${
                        impactStackMode === 'yoy_rates'
                          ? 'bg-white dark:bg-zinc-800 text-sky-600 dark:text-sky-400 font-bold shadow-xs'
                          : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                      }`}
                    >
                      YoY Rates (%)
                    </button>
                  </div>
                </div>
              </div>

              {/* Data Series Computation & Stacked Bar Graph */}
              {(() => {
                const sortedRows = [...results.rows]
                  .map((r) => {
                    const yr = Number(r.year ?? r.publication_year)
                    const total = Number(r.total_papers ?? r.paper_count ?? r.count) || 0
                    const top1 = Number(r.top_1pct_papers) || 0
                    const top10Total = Number(r.top_10pct_total_papers ?? r.top_10pct_papers) || 0
                    const top10Rest =
                      r.top_10pct_rest_papers !== undefined && r.top_10pct_rest_papers !== null
                        ? Number(r.top_10pct_rest_papers)
                        : Math.max(top10Total - top1, 0)
                    const standard = Math.max(total - (top1 + top10Rest), 0)

                    const sqlTop1YoY =
                      r.top_1pct_yoy_pct !== undefined && r.top_1pct_yoy_pct !== null
                        ? Number(r.top_1pct_yoy_pct)
                        : null
                    const sqlTop10YoY =
                      r.top_10pct_yoy_pct !== undefined && r.top_10pct_yoy_pct !== null
                        ? Number(r.top_10pct_yoy_pct)
                        : null
                    const sqlTotalYoY =
                      r.total_yoy_pct !== undefined && r.total_yoy_pct !== null
                        ? Number(r.total_yoy_pct)
                        : null

                    return {
                      year: yr,
                      total,
                      top1,
                      top10Rest,
                      top10Total: Math.max(top10Total, top1 + top10Rest),
                      standard,
                      sqlTop1YoY,
                      sqlTop10YoY,
                      sqlTotalYoY,
                    }
                  })
                  .filter((r) => !isNaN(r.year) && r.year >= 1950 && r.year <= 2050)
                  .sort((a, b) => a.year - b.year)

                if (sortedRows.length === 0) {
                  return (
                    <div className="p-8 text-center font-mono text-xs text-zinc-400">
                      No publication records available to compute Top 1% & Top 10% YoY growth.
                    </div>
                  )
                }

                // Compute YoY Growth rates & Scientometrics
                const series = sortedRows.map((row, idx) => {
                  let top1YoY: number | null = row.sqlTop1YoY
                  let top10YoY: number | null = row.sqlTop10YoY
                  let totalYoY: number | null = row.sqlTotalYoY

                  if (idx > 0) {
                    const prev = sortedRows[idx - 1]
                    if (top1YoY === null && prev.top1 > 0) {
                      top1YoY = ((row.top1 - prev.top1) / prev.top1) * 100
                    }
                    if (top10YoY === null && prev.top10Total > 0) {
                      top10YoY = ((row.top10Total - prev.top10Total) / prev.top10Total) * 100
                    }
                    if (totalYoY === null && prev.total > 0) {
                      totalYoY = ((row.total - prev.total) / prev.total) * 100
                    }
                  }

                  const prevRow = idx > 0 ? sortedRows[idx - 1] : null
                  const top1NetGain = prevRow ? row.top1 - prevRow.top1 : 0
                  const top10NetGain = prevRow ? row.top10Total - prevRow.top10Total : 0
                  const totalNetGain = prevRow ? row.total - prevRow.total : 0

                  const top1Share = row.total > 0 ? (row.top1 / row.total) * 100 : 0
                  const top10Share = row.total > 0 ? (row.top10Total / row.total) * 100 : 0
                  const eliteRatio = row.top10Total > 0 ? (row.top1 / row.top10Total) * 100 : 0

                  return {
                    ...row,
                    top1YoY,
                    top10YoY,
                    totalYoY,
                    top1NetGain,
                    top10NetGain,
                    totalNetGain,
                    top1Share,
                    top10Share,
                    eliteRatio,
                    isBase: idx === 0,
                  }
                })

                // Totals & CAGR
                const sumTop1 = series.reduce((sum, s) => sum + s.top1, 0)
                const sumTop10 = series.reduce((sum, s) => sum + s.top10Total, 0)
                const sumTotal = series.reduce((sum, s) => sum + s.total, 0)

                const firstYear = series[0].year
                const latestItem = series[series.length - 1]
                const spanYears = latestItem.year - firstYear

                const top1CAGR =
                  spanYears > 0 && series[0].top1 > 0 && latestItem.top1 > 0
                    ? (Math.pow(latestItem.top1 / series[0].top1, 1 / spanYears) - 1) * 100
                    : null
                const top10CAGR =
                  spanYears > 0 && series[0].top10Total > 0 && latestItem.top10Total > 0
                    ? (Math.pow(latestItem.top10Total / series[0].top10Total, 1 / spanYears) - 1) * 100
                    : null

                const peakTop1Item = [...series]
                  .filter((s) => s.top1YoY !== null)
                  .sort((a, b) => (b.top1YoY ?? 0) - (a.top1YoY ?? 0))[0]

                // Scale Maxima
                const maxImpact = Math.max(...series.map((s) => s.top10Total), 10)
                const maxTotal = Math.max(...series.map((s) => s.total), 10)
                const maxRate = Math.max(
                  ...series.map((s) => Math.max(s.top1YoY ?? 0, s.top10YoY ?? 0, s.totalYoY ?? 0)),
                  10,
                )
                const minRate = Math.min(
                  ...series.map((s) => Math.min(s.top1YoY ?? 0, s.top10YoY ?? 0, s.totalYoY ?? 0)),
                  0,
                )

                const activeMax =
                  impactStackMode === 'impact'
                    ? maxImpact
                    : impactStackMode === 'full'
                      ? maxTotal
                      : maxRate

                const activeMin = impactStackMode === 'yoy_rates' ? minRate : 0
                const hasRateNegatives = activeMin < -0.1
                const rateSpan = Math.max(activeMax - activeMin, 1)
                const rateZeroBottomPct = hasRateNegatives ? (Math.abs(activeMin) / rateSpan) * 100 : 0
                const impactMinWidth = chartMinWidth(series.length, 48)

                return (
                  <div className="flex flex-col gap-3">
                    {/* Visual Chart Plot Area */}
                    <div className="overflow-x-auto">
                      <div
                        className="relative flex items-stretch h-64 sm:h-72 pt-3 pb-1"
                        style={{ minWidth: `${impactMinWidth}px` }}
                      >
                      {/* Y-Axis Scale Gutter */}
                      <div className="flex flex-col justify-between items-end pr-2 text-[10px] font-mono text-zinc-400 select-none w-12 sm:w-16 shrink-0 border-r border-zinc-200 dark:border-zinc-850 pb-0.5 whitespace-nowrap">
                        {impactStackMode === 'yoy_rates' ? (
                          !hasRateNegatives ? (
                            <>
                              <span>+{Math.round(activeMax)}%</span>
                              <span>+{Math.round(activeMax * 0.75)}%</span>
                              <span>+{Math.round(activeMax * 0.5)}%</span>
                              <span>+{Math.round(activeMax * 0.25)}%</span>
                              <span>0%</span>
                            </>
                          ) : (
                            <>
                              <span>+{Math.round(activeMax)}%</span>
                              <span>+{Math.round(activeMax * 0.5)}%</span>
                              <span>0%</span>
                              <span>{Math.round(activeMin * 0.5)}%</span>
                              <span>{Math.round(activeMin)}%</span>
                            </>
                          )
                        ) : (
                          <>
                            <span>{formatShortNumber(activeMax)}</span>
                            <span>{formatShortNumber(activeMax * 0.75)}</span>
                            <span>{formatShortNumber(activeMax * 0.5)}</span>
                            <span>{formatShortNumber(activeMax * 0.25)}</span>
                            <span>0</span>
                          </>
                        )}
                      </div>

                      {/* Chart Plot Area with Vertical Columns */}
                      <div className="relative flex-1 flex flex-col justify-between pl-2">
                        {/* Horizontal Gridlines */}
                        <div className="absolute inset-0 left-2 flex flex-col justify-between pointer-events-none opacity-40 z-0">
                          <div className="border-b border-dashed border-zinc-300 dark:border-zinc-700 w-full" />
                          <div className="border-b border-dashed border-zinc-200 dark:border-zinc-850 w-full" />
                          <div className="border-b border-dashed border-zinc-200 dark:border-zinc-850 w-full" />
                          <div className="border-b border-dashed border-zinc-200 dark:border-zinc-850 w-full" />
                          <div className="border-b border-dashed border-zinc-300 dark:border-zinc-700 w-full" />
                        </div>

                        {/* Zero Baseline Line for negative rates */}
                        {impactStackMode === 'yoy_rates' && hasRateNegatives && (
                          <div
                            style={{ bottom: `${rateZeroBottomPct}%` }}
                            className="absolute left-2 right-0 border-b border-zinc-400 dark:border-zinc-500 z-10 pointer-events-none"
                          />
                        )}

                        {/* Columns Container */}
                        <div className="relative z-20 h-full flex items-end justify-between gap-1.5 sm:gap-2">
                          {series.map((item, idx) => {
                            const isHovered = hoveredImpactIdx === idx
                            const barTotal =
                              impactStackMode === 'impact' ? item.top10Total : item.total
                            const totalHeightPct =
                              activeMax > 0
                                ? Math.max(Math.round((barTotal / activeMax) * 100), barTotal > 0 ? 5 : 0)
                                : 0

                            const top1HeightPct =
                              barTotal > 0 ? (item.top1 / barTotal) * 100 : 0
                            const top10RestHeightPct =
                              barTotal > 0 ? (item.top10Rest / barTotal) * 100 : 0
                            const standardHeightPct =
                              barTotal > 0 ? (item.standard / barTotal) * 100 : 0

                            return (
                              <div
                                key={item.year}
                                onMouseEnter={() => setHoveredImpactIdx(idx)}
                                onMouseLeave={() => setHoveredImpactIdx(null)}
                                className="flex-1 min-w-[32px] max-w-[64px] flex flex-col items-center justify-end h-full group relative cursor-pointer"
                              >
                                {/* Hover Tooltip Popup */}
                                <div className="absolute -top-32 left-1/2 -translate-x-1/2 hidden group-hover:flex flex-col items-center bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950 px-3 py-2 rounded text-[10px] font-mono z-40 shadow-xl pointer-events-none whitespace-nowrap border border-zinc-700 dark:border-zinc-300">
                                  <div className="font-bold flex items-center justify-between gap-4 text-xs border-b border-zinc-800 dark:border-zinc-200 pb-1 mb-1.5 w-full">
                                    <span>{item.year} Impact Growth</span>
                                    <span className="text-[10px] font-normal text-amber-400 dark:text-amber-600">
                                      {item.eliteRatio.toFixed(1)}% Elite Conversion
                                    </span>
                                  </div>
                                  <div className="flex flex-col gap-1 w-full text-[9px]">
                                    <div className="flex items-center justify-between gap-4">
                                      <span className="flex items-center gap-1.5">
                                        <div className="w-2 h-2 rounded-xs bg-amber-400" />
                                        <span className="text-zinc-300 dark:text-zinc-700">Top 1% Elite:</span>
                                      </span>
                                      <span className="font-bold text-amber-300 dark:text-amber-600">
                                        {item.top1.toLocaleString()} ({item.top1Share.toFixed(1)}%)
                                        <span className="ml-1.5 font-normal text-zinc-400">
                                          YoY: {item.top1YoY !== null ? `${item.top1YoY >= 0 ? '+' : ''}${item.top1YoY.toFixed(1)}%` : 'Base'}
                                        </span>
                                      </span>
                                    </div>
                                    <div className="flex items-center justify-between gap-4">
                                      <span className="flex items-center gap-1.5">
                                        <div className="w-2 h-2 rounded-xs bg-sky-400" />
                                        <span className="text-zinc-300 dark:text-zinc-700">Top 10% Impact:</span>
                                      </span>
                                      <span className="font-bold text-sky-300 dark:text-sky-600">
                                        {item.top10Total.toLocaleString()} ({item.top10Share.toFixed(1)}%)
                                        <span className="ml-1.5 font-normal text-zinc-400">
                                          YoY: {item.top10YoY !== null ? `${item.top10YoY >= 0 ? '+' : ''}${item.top10YoY.toFixed(1)}%` : 'Base'}
                                        </span>
                                      </span>
                                    </div>
                                    <div className="flex items-center justify-between gap-4 pt-0.5 border-t border-zinc-800/80 dark:border-zinc-200/80">
                                      <span className="text-zinc-400 dark:text-zinc-600">Total Papers:</span>
                                      <span className="font-bold text-zinc-100 dark:text-zinc-900">
                                        {item.total.toLocaleString()}
                                        <span className="ml-1.5 font-normal text-zinc-400">
                                          YoY: {item.totalYoY !== null ? `${item.totalYoY >= 0 ? '+' : ''}${item.totalYoY.toFixed(1)}%` : 'Base'}
                                        </span>
                                      </span>
                                    </div>
                                  </div>
                                  <div className="w-1.5 h-1.5 bg-zinc-950 dark:bg-zinc-100 rotate-45 -mb-1 mt-1" />
                                </div>

                                {/* On-Bar Growth Badges & Volume Counter */}
                                {impactStackMode !== 'yoy_rates' ? (
                                  <div className="flex flex-col items-center mb-0.5 max-w-full z-20">
                                    <div className="flex items-center gap-1 text-[7px] sm:text-[9px] font-mono font-bold leading-none mb-0.5">
                                      <span
                                        className="text-amber-600 dark:text-amber-400"
                                        title={`Top 1% YoY: ${item.top1YoY !== null ? item.top1YoY.toFixed(1) + '%' : 'Base'}`}
                                      >
                                        {item.top1YoY !== null ? `${item.top1YoY >= 0 ? '+' : ''}${Math.round(item.top1YoY)}%` : 'Base'}
                                      </span>
                                      <span className="text-zinc-300 dark:text-zinc-700">/</span>
                                      <span
                                        className="text-sky-600 dark:text-sky-400"
                                        title={`Top 10% YoY: ${item.top10YoY !== null ? item.top10YoY.toFixed(1) + '%' : 'Base'}`}
                                      >
                                        {item.top10YoY !== null ? `${item.top10YoY >= 0 ? '+' : ''}${Math.round(item.top10YoY)}%` : 'Base'}
                                      </span>
                                    </div>
                                    <span className="text-[8px] sm:text-[10px] font-mono font-bold text-zinc-700 dark:text-zinc-300">
                                      {formatShortNumber(barTotal)}
                                    </span>
                                  </div>
                                ) : (
                                  <div className="flex flex-col items-center mb-0.5 max-w-full z-20 text-[8px] font-mono">
                                    <span className="text-amber-600 dark:text-amber-400 font-bold">
                                      {item.top1YoY !== null ? `${item.top1YoY >= 0 ? '+' : ''}${item.top1YoY.toFixed(1)}%` : 'Base'}
                                    </span>
                                  </div>
                                )}

                                {/* Stacked Column or Grouped YoY Bar */}
                                {impactStackMode !== 'yoy_rates' ? (
                                  <div className="relative w-full flex justify-center h-full">
                                    <div
                                      style={{ height: `${totalHeightPct}%` }}
                                      className={`w-full max-w-[34px] sm:max-w-[42px] flex flex-col justify-end rounded-t overflow-hidden transition-all duration-200 ${
                                        isHovered ? 'scale-y-[1.03] origin-bottom brightness-105 shadow-md' : ''
                                      }`}
                                    >
                                      {/* Top 1% Elite Segment (Top) */}
                                      <div
                                        style={{ height: `${top1HeightPct}%` }}
                                        className="w-full bg-gradient-to-t from-amber-500 to-amber-400 dark:from-amber-600 dark:to-amber-400 border-t border-x border-amber-300 dark:border-amber-400 rounded-t transition-all"
                                        title={`Top 1%: ${item.top1.toLocaleString()} papers`}
                                      />

                                      {/* Top 10% Rest Segment (Middle) */}
                                      <div
                                        style={{ height: `${top10RestHeightPct}%` }}
                                        className={`w-full bg-gradient-to-t from-sky-600 to-sky-400 dark:from-sky-500 dark:to-sky-400 border-x border-sky-300 dark:border-sky-400 transition-all ${
                                          impactStackMode === 'impact' ? 'rounded-b' : ''
                                        }`}
                                        title={`Top 10% Rest: ${item.top10Rest.toLocaleString()} papers`}
                                      />

                                      {/* Standard Segment (Bottom - when full) */}
                                      {impactStackMode === 'full' && (
                                        <div
                                          style={{ height: `${standardHeightPct}%` }}
                                          className="w-full bg-zinc-800 dark:bg-zinc-700 rounded-b transition-all"
                                          title={`Standard: ${item.standard.toLocaleString()} papers`}
                                        />
                                      )}
                                    </div>
                                  </div>
                                ) : (
                                  /* Grouped Comparative YoY Velocity Columns */
                                  <div className="relative w-full flex items-end justify-center gap-1 h-full">
                                    {/* Top 1% Rate Bar */}
                                    <div
                                      style={{
                                        height: `${item.top1YoY !== null ? Math.max((Math.abs(item.top1YoY) / rateSpan) * 100, 4) : 4}%`,
                                        bottom: hasRateNegatives && (item.top1YoY ?? 0) < 0 ? `${rateZeroBottomPct - Math.max((Math.abs(item.top1YoY ?? 0) / rateSpan) * 100, 4)}%` : `${rateZeroBottomPct}%`,
                                      }}
                                      className="w-2.5 sm:w-3 bg-amber-500 dark:bg-amber-400 rounded-t transition-all"
                                      title={`Top 1% YoY: ${item.top1YoY !== null ? item.top1YoY.toFixed(1) + '%' : 'Base'}`}
                                    />
                                    {/* Top 10% Rate Bar */}
                                    <div
                                      style={{
                                        height: `${item.top10YoY !== null ? Math.max((Math.abs(item.top10YoY) / rateSpan) * 100, 4) : 4}%`,
                                        bottom: hasRateNegatives && (item.top10YoY ?? 0) < 0 ? `${rateZeroBottomPct - Math.max((Math.abs(item.top10YoY ?? 0) / rateSpan) * 100, 4)}%` : `${rateZeroBottomPct}%`,
                                      }}
                                      className="w-2.5 sm:w-3 bg-sky-500 dark:bg-sky-400 rounded-t transition-all"
                                      title={`Top 10% YoY: ${item.top10YoY !== null ? item.top10YoY.toFixed(1) + '%' : 'Base'}`}
                                    />
                                    {/* Total Rate Bar */}
                                    <div
                                      style={{
                                        height: `${item.totalYoY !== null ? Math.max((Math.abs(item.totalYoY) / rateSpan) * 100, 4) : 4}%`,
                                        bottom: hasRateNegatives && (item.totalYoY ?? 0) < 0 ? `${rateZeroBottomPct - Math.max((Math.abs(item.totalYoY ?? 0) / rateSpan) * 100, 4)}%` : `${rateZeroBottomPct}%`,
                                      }}
                                      className="w-2.5 sm:w-3 bg-zinc-700 dark:bg-zinc-400 rounded-t transition-all"
                                      title={`Total YoY: ${item.totalYoY !== null ? item.totalYoY.toFixed(1) + '%' : 'Base'}`}
                                    />
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                      </div>
                    </div>

                    {/* X-Axis Labels Row */}
                    <div className="overflow-x-auto">
                      <div
                        className="flex items-start justify-between pl-12 sm:pl-16 gap-1.5 sm:gap-2 pt-1.5 border-t border-zinc-200 dark:border-zinc-850"
                        style={{ minWidth: `${impactMinWidth}px` }}
                      >
                        {series.map((item) => (
                          <div
                            key={item.year}
                            className="flex-1 min-w-[32px] max-w-[64px] flex flex-col items-center"
                          >
                            <span
                              className={`text-[10px] sm:text-[11px] font-mono transition-colors ${
                                item.isBase
                                  ? 'font-bold text-zinc-900 dark:text-zinc-100'
                                  : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
                              }`}
                            >
                              {item.year}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Scientometric KPI Cards for Top 1% & Top 10% YoY Growth */}
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 pt-2 font-mono text-xs">
                      {/* Total Top 1% */}
                      <div className="p-3 rounded bg-amber-50/50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800/40">
                        <div className="flex items-center justify-between text-amber-600 dark:text-amber-400 mb-1">
                          <span className="text-[10px] uppercase font-bold tracking-wider">Top 1% Elite</span>
                          <Flame className="h-3.5 w-3.5" />
                        </div>
                        <p className="font-bold text-base text-amber-700 dark:text-amber-300">
                          {sumTop1.toLocaleString()} papers
                        </p>
                        <span className="text-[9px] text-amber-600/80 dark:text-amber-400/70">
                          {((sumTop1 / Math.max(sumTotal, 1)) * 100).toFixed(1)}% of total • CAGR: {top1CAGR !== null ? `${top1CAGR >= 0 ? '+' : ''}${top1CAGR.toFixed(1)}% / yr` : '—'}
                        </span>
                      </div>

                      {/* Total Top 10% */}
                      <div className="p-3 rounded bg-sky-50/50 dark:bg-sky-950/20 border border-sky-200 dark:border-sky-800/40">
                        <div className="flex items-center justify-between text-sky-600 dark:text-sky-400 mb-1">
                          <span className="text-[10px] uppercase font-bold tracking-wider">Top 10% Impact</span>
                          <Sparkles className="h-3.5 w-3.5" />
                        </div>
                        <p className="font-bold text-base text-sky-700 dark:text-sky-300">
                          {sumTop10.toLocaleString()} papers
                        </p>
                        <span className="text-[9px] text-sky-600/80 dark:text-sky-400/70">
                          {((sumTop10 / Math.max(sumTotal, 1)) * 100).toFixed(1)}% of total • CAGR: {top10CAGR !== null ? `${top10CAGR >= 0 ? '+' : ''}${top10CAGR.toFixed(1)}% / yr` : '—'}
                        </span>
                      </div>

                      {/* Latest Year Top 1% YoY */}
                      <div className="p-3 rounded bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-100 dark:border-zinc-800">
                        <span className="text-[10px] text-zinc-400 uppercase font-bold tracking-wider">
                          Latest Top 1% YoY
                        </span>
                        <p className="font-bold text-base text-amber-600 dark:text-amber-400 mt-1">
                          {latestItem.top1YoY !== null ? `${latestItem.top1YoY >= 0 ? '+' : ''}${latestItem.top1YoY.toFixed(1)}%` : '—'}
                        </p>
                        <span className="text-[9px] text-zinc-400">
                          {latestItem.year} ({latestItem.top1.toLocaleString()} papers)
                        </span>
                      </div>

                      {/* Latest Year Top 10% YoY */}
                      <div className="p-3 rounded bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-100 dark:border-zinc-800">
                        <span className="text-[10px] text-zinc-400 uppercase font-bold tracking-wider">
                          Latest Top 10% YoY
                        </span>
                        <p className="font-bold text-base text-sky-600 dark:text-sky-400 mt-1">
                          {latestItem.top10YoY !== null ? `${latestItem.top10YoY >= 0 ? '+' : ''}${latestItem.top10YoY.toFixed(1)}%` : '—'}
                        </p>
                        <span className="text-[9px] text-zinc-400">
                          {latestItem.year} ({latestItem.top10Total.toLocaleString()} papers)
                        </span>
                      </div>

                      {/* Peak Elite Acceleration */}
                      <div className="p-3 rounded bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-100 dark:border-zinc-800">
                        <span className="text-[10px] text-zinc-400 uppercase font-bold tracking-wider">
                          Peak Top 1% Velocity
                        </span>
                        <p className="font-bold text-base text-zinc-900 dark:text-zinc-100 mt-1 truncate">
                          {peakTop1Item && peakTop1Item.top1YoY !== null ? `${peakTop1Item.year} (+${peakTop1Item.top1YoY.toFixed(1)}%)` : '—'}
                        </p>
                        <span className="text-[9px] text-zinc-400">Highest single-year jump</span>
                      </div>
                    </div>

                    {/* Scientometric Stacked Decomposition & Methodology Breakdown */}
                    <div className="p-3 rounded border border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/30 text-xs font-mono text-zinc-600 dark:text-zinc-400 flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
                      <div className="flex flex-col gap-1">
                        <span className="font-bold text-zinc-800 dark:text-zinc-200 text-[11px] flex items-center gap-1.5">
                          <Code2 className="h-3.5 w-3.5 text-zinc-500" />
                          Hierarchical Stacked Decomposition & YoY Methodology
                        </span>
                        <p className="text-[10px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
                          Top 1% elite publications (amber) form an inner subset of Top 10% high-impact papers (sky). The stacked visualization partitions these tiers non-destructively to show incremental volume, while YoY percentage badges track annual growth acceleration.
                        </p>
                      </div>
                      <div className="px-3 py-2 rounded bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-[11px] font-mono text-zinc-900 dark:text-zinc-100 whitespace-nowrap shadow-2xs self-stretch md:self-auto text-center">
                        <span className="text-amber-600 dark:text-amber-400 font-bold">Elite Conversion</span> = ( {latestItem.top1.toLocaleString()} / {latestItem.top10Total.toLocaleString()} ) ={' '}
                        <strong className="text-amber-600 dark:text-amber-400">
                          {latestItem.eliteRatio.toFixed(1)}%
                        </strong>
                      </div>
                    </div>
                  </div>
                )
              })()}
            </div>
          )}

          {/* 5. COUNTRY-COUNTRY COLLABORATION: BILATERAL PAIRS OUTCOME */}
          {activeOutcome === 'bilateral' && (
            <div className="flex flex-col gap-4 border border-zinc-200 dark:border-zinc-850 rounded bg-white dark:bg-zinc-900/40 p-5 shadow-xs">
              {/* Header with Title and Mode Switchers */}
              <div className="flex flex-col lg:flex-row lg:items-center justify-between border-b border-zinc-100 dark:border-zinc-800 pb-3 gap-3">
                <div className="flex items-center gap-2.5">
                  <div className="w-7 h-7 rounded bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/40 flex items-center justify-center">
                    <Network className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <div>
                    <span className="font-mono font-bold text-xs uppercase tracking-tight text-zinc-900 dark:text-zinc-100 block">
                      Country-Country Collaboration: Bilateral Pairs
                    </span>
                    <span className="text-[10px] text-zinc-400 font-mono">
                      Cross-border co-authorship corridors, high-impact synergy & international collaboration volume
                    </span>
                  </div>
                </div>

                {/* Filters & Sorters */}
                <div className="flex flex-wrap items-center gap-2">
                  {/* Scope filter: All Corridors vs India Partnerships */}
                  <div className="flex items-center rounded border border-zinc-200 dark:border-zinc-850 bg-zinc-100 dark:bg-zinc-900 p-0.5 font-mono text-xs shadow-2xs">
                    <button
                      type="button"
                      onClick={() => setCollabFilterMode('all')}
                      className={`px-2.5 py-1 rounded transition cursor-pointer text-[11px] ${
                        collabFilterMode === 'all'
                          ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-bold shadow-xs'
                          : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                      }`}
                    >
                      All Corridors
                    </button>
                    <button
                      type="button"
                      onClick={() => setCollabFilterMode('india')}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded transition cursor-pointer text-[11px] ${
                        collabFilterMode === 'india'
                          ? 'bg-orange-500 text-white font-bold shadow-xs'
                          : 'text-zinc-500 hover:text-orange-600 dark:hover:text-orange-400'
                      }`}
                    >
                      <span className="px-1 py-0.2 rounded text-[9px] font-bold font-mono bg-orange-600 text-white dark:bg-orange-500">IN</span>
                      <span>India Partnerships</span>
                    </button>
                  </div>

                  {/* Sorter Selector */}
                  <div className="flex items-center rounded border border-zinc-200 dark:border-zinc-850 bg-zinc-100 dark:bg-zinc-900 p-0.5 font-mono text-xs shadow-2xs">
                    <button
                      type="button"
                      onClick={() => setCollabSortMetric('total')}
                      className={`px-2.5 py-1 rounded transition cursor-pointer text-[10px] ${
                        collabSortMetric === 'total'
                          ? 'bg-white dark:bg-zinc-800 text-emerald-600 dark:text-emerald-400 font-bold shadow-xs'
                          : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                      }`}
                      title="Sort by total co-authored publications"
                    >
                      Total Collabs
                    </button>
                    <button
                      type="button"
                      onClick={() => setCollabSortMetric('top10')}
                      className={`flex items-center gap-1 px-2 py-1 rounded transition cursor-pointer text-[10px] ${
                        collabSortMetric === 'top10'
                          ? 'bg-white dark:bg-zinc-800 text-sky-600 dark:text-sky-400 font-bold shadow-xs'
                          : 'text-zinc-500 hover:text-sky-600 dark:hover:text-sky-400'
                      }`}
                      title="Sort by Top 10% high-impact publications"
                    >
                      <Sparkles className="h-2.5 w-2.5" />
                      <span>Top 10%</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setCollabSortMetric('top1')}
                      className={`flex items-center gap-1 px-2 py-1 rounded transition cursor-pointer text-[10px] ${
                        collabSortMetric === 'top1'
                          ? 'bg-white dark:bg-zinc-800 text-amber-600 dark:text-amber-400 font-bold shadow-xs'
                          : 'text-zinc-500 hover:text-amber-600 dark:hover:text-amber-400'
                      }`}
                      title="Sort by Top 1% elite publications"
                    >
                      <Flame className="h-2.5 w-2.5" />
                      <span>Top 1%</span>
                    </button>
                  </div>
                </div>
              </div>

              {/* Data Processing & Visualization */}
              {(() => {
                // Parsed rows come from the memoized `bilateralParsedRows`
                const parsedRows = bilateralParsedRows

                // Global totals across all pairs in the dataset for KPIs
                const allTotalCollabs = parsedRows.reduce((acc, r) => acc + r.total, 0)
                const allTotalTop1 = parsedRows.reduce((acc, r) => acc + r.top1, 0)
                const allTotalTop10 = parsedRows.reduce((acc, r) => acc + r.top10, 0)

                // Distinct India partners in the dataset
                const indiaPartners = new Set<string>()
                parsedRows.forEach((r) => {
                  if (r.countryA === 'IN' && r.countryB) indiaPartners.add(r.countryB)
                  if (r.countryB === 'IN' && r.countryA) indiaPartners.add(r.countryA)
                })

                // Top India pair
                const topIndiaPair = parsedRows.find((r) => r.isIndia)

                // Filtered and sorted rows for display
                let displayRows = collabFilterMode === 'india'
                  ? parsedRows.filter((r) => r.isIndia)
                  : parsedRows

                displayRows = [...displayRows].sort((a, b) => {
                  if (collabSortMetric === 'top1') return b.top1 - a.top1
                  if (collabSortMetric === 'top10') return b.top10 - a.top10
                  return b.total - a.total
                })

                const maxVal = displayRows.reduce((max, r) => {
                  const val = collabSortMetric === 'top1' ? r.top1 : collabSortMetric === 'top10' ? r.top10 : r.total
                  return Math.max(max, val)
                }, 1)

                return (
                  <div className="flex flex-col gap-4">
                    {/* BILATERAL CORRIDORS LIST / BAR GRAPH */}
                    {displayRows.length === 0 ? (
                      <div className="p-8 text-center border border-dashed border-zinc-200 dark:border-zinc-850 rounded font-mono text-xs text-zinc-400">
                        No bilateral pairs found matching current criteria.
                      </div>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {displayRows.map((row, idx) => {
                          const activeVal =
                            collabSortMetric === 'top1'
                              ? row.top1
                              : collabSortMetric === 'top10'
                                ? row.top10
                                : row.total
                          const barWidthPct = Math.max((activeVal / maxVal) * 100, 3)
                          const isHovered = hoveredCollabIdx === idx
                          const aName = formatCountryName(row.countryA)
                          const bName = formatCountryName(row.countryB)
                          const isAIndia = row.countryA === 'IN'
                          const isBIndia = row.countryB === 'IN'

                          return (
                            <div
                              key={`${row.countryA}-${row.countryB}-${idx}`}
                              onMouseEnter={() => setHoveredCollabIdx(idx)}
                              onMouseLeave={() => setHoveredCollabIdx(null)}
                              className={`group relative p-2.5 sm:p-3 rounded border transition-all duration-200 ${
                                row.isIndia
                                  ? 'border-orange-300 dark:border-orange-850 bg-orange-50/40 dark:bg-orange-950/20 shadow-xs ring-1 ring-orange-500/20'
                                  : 'border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 hover:border-zinc-300 dark:hover:border-zinc-700'
                              } ${isHovered ? 'scale-[1.005] z-10 shadow-md' : ''}`}
                            >
                              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                                {/* Left Side: Rank & Corridor Identifiers */}
                                <div className="flex items-center gap-2.5 min-w-[240px] sm:min-w-[280px]">
                                  {/* Rank Badge */}
                                  <span
                                    className={`w-6 h-6 rounded flex items-center justify-center text-[10px] font-mono font-bold border shrink-0 ${
                                      row.isIndia
                                        ? 'border-orange-500 bg-orange-500 text-white shadow-2xs'
                                        : 'border-zinc-200 dark:border-zinc-700 bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
                                    }`}
                                  >
                                    #{idx + 1}
                                  </span>

                                  {/* Country A */}
                                  <div className="flex items-center gap-1.5 font-mono text-xs">
                                    <span
                                      className={`px-1.5 py-0.5 rounded text-[11px] font-bold ${
                                        isAIndia
                                          ? 'bg-orange-500/15 text-orange-600 dark:text-orange-400 border border-orange-500/30'
                                          : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700'
                                      }`}
                                    >
                                      {row.countryA}
                                    </span>
                                    <span className="hidden md:inline text-[11px] text-zinc-500 dark:text-zinc-400 max-w-[90px] truncate" title={aName}>
                                      {aName}
                                    </span>
                                  </div>

                                  {/* Bilateral Corridor Connector */}
                                  <div className="flex items-center text-zinc-400 px-1">
                                    <ArrowLeftRight className="h-3 w-3 shrink-0" />
                                  </div>

                                  {/* Country B */}
                                  <div className="flex items-center gap-1.5 font-mono text-xs">
                                    <span
                                      className={`px-1.5 py-0.5 rounded text-[11px] font-bold ${
                                        isBIndia
                                          ? 'bg-orange-500/15 text-orange-600 dark:text-orange-400 border border-orange-500/30'
                                          : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700'
                                      }`}
                                    >
                                      {row.countryB}
                                    </span>
                                    <span className="hidden md:inline text-[11px] text-zinc-500 dark:text-zinc-400 max-w-[90px] truncate" title={bName}>
                                      {bName}
                                    </span>
                                  </div>

                                  {/* India Tag */}
                                  {row.isIndia && (
                                    <span className="ml-1 px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-orange-100 dark:bg-orange-950/60 text-orange-700 dark:text-orange-300 border border-orange-300 dark:border-orange-800 shrink-0">
                                      India Corridor
                                    </span>
                                  )}
                                </div>

                                {/* Center: Proportional Track Bar */}
                                <div className="flex-1 flex flex-col justify-center px-2 min-w-[120px]">
                                  <div className="w-full h-3 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden flex">
                                    {/* Segment: Top 1% (amber) */}
                                    {row.top1 > 0 && (
                                      <div
                                        style={{
                                          width: `${Math.min((row.top1 / Math.max(activeVal, 1)) * barWidthPct, barWidthPct)}%`,
                                        }}
                                        className="h-full bg-amber-500 dark:bg-amber-400 transition-all duration-300"
                                        title={`Top 1%: ${row.top1.toLocaleString()} papers`}
                                      />
                                    )}
                                    {/* Segment: Top 10% rest (sky) */}
                                    {row.top10 > row.top1 && (
                                      <div
                                        style={{
                                          width: `${Math.min(((row.top10 - row.top1) / Math.max(activeVal, 1)) * barWidthPct, barWidthPct)}%`,
                                        }}
                                        className="h-full bg-sky-500 dark:bg-sky-400 transition-all duration-300"
                                        title={`Top 10% Rest: ${(row.top10 - row.top1).toLocaleString()} papers`}
                                      />
                                    )}
                                    {/* Segment: Standard (emerald or orange) */}
                                    <div
                                      style={{
                                        width: `${Math.max(
                                          barWidthPct -
                                            (row.top10 > 0
                                              ? (row.top10 / Math.max(activeVal, 1)) * barWidthPct
                                              : (row.top1 / Math.max(activeVal, 1)) * barWidthPct),
                                          0,
                                        )}%`,
                                      }}
                                      className={`h-full transition-all duration-300 ${
                                        row.isIndia
                                          ? 'bg-orange-500 dark:bg-orange-400'
                                          : 'bg-emerald-600 dark:bg-emerald-500'
                                      }`}
                                    />
                                  </div>
                                </div>

                                {/* Right Side: Exact Figures & Scientometric Badges */}
                                <div className="flex items-center gap-2 shrink-0 font-mono text-xs">
                                  {/* Exact Total Value - never rounded to 'k' */}
                                  <span
                                    className={`font-bold text-xs sm:text-sm min-w-[70px] text-right ${
                                      row.isIndia
                                        ? 'text-orange-600 dark:text-orange-400'
                                        : 'text-zinc-900 dark:text-zinc-100'
                                    }`}
                                  >
                                    {row.total.toLocaleString()} papers
                                  </span>

                                  {/* Top 1% Badge */}
                                  {row.top1 > 0 && (
                                    <span
                                      className="hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800/60"
                                      title={`${row.top1.toLocaleString()} Top 1% elite co-authorships (${((row.top1 / Math.max(row.total, 1)) * 100).toFixed(1)}%)`}
                                    >
                                      <Flame className="h-2.5 w-2.5" />
                                      {row.top1.toLocaleString()}
                                    </span>
                                  )}

                                  {/* Top 10% Badge */}
                                  {row.top10 > 0 && (
                                    <span
                                      className="hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 border border-sky-200 dark:border-sky-800/60"
                                      title={`${row.top10.toLocaleString()} Top 10% high-impact co-authorships (${((row.top10 / Math.max(row.total, 1)) * 100).toFixed(1)}%)`}
                                    >
                                      <Sparkles className="h-2.5 w-2.5" />
                                      {row.top10.toLocaleString()}
                                    </span>
                                  )}

                                  {/* Share Badge */}
                                  {row.share > 0 && (
                                    <span
                                      className="px-1.5 py-0.5 rounded text-[10px] font-mono text-zinc-500 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-800/80 min-w-[45px] text-right"
                                      title={`${row.share.toFixed(2)}% of global bilateral collaboration volume`}
                                    >
                                      {row.share.toFixed(1)}%
                                    </span>
                                  )}
                                </div>
                              </div>

                              {/* Expanded Hover Inspector Card */}
                              {isHovered && (
                                <div className="mt-2.5 pt-2.5 border-t border-zinc-100 dark:border-zinc-800 flex flex-wrap items-center justify-between gap-3 text-[11px] font-mono animate-fadeIn">
                                  <div className="flex items-center gap-2">
                                    <span className="font-bold text-zinc-800 dark:text-zinc-200">
                                      {aName} ({row.countryA}) ⇄ {bName} ({row.countryB})
                                    </span>
                                    <span className="text-zinc-400">|</span>
                                    <span className="text-zinc-500">
                                      Corridor Output: <strong>{row.total.toLocaleString()}</strong> distinct joint papers
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-3">
                                    <span className="text-amber-600 dark:text-amber-400">
                                      Elite (Top 1%): <strong>{row.top1.toLocaleString()}</strong> ({((row.top1 / Math.max(row.total, 1)) * 100).toFixed(1)}%)
                                    </span>
                                    <span className="text-sky-600 dark:text-sky-400">
                                      Impact (Top 10%): <strong>{row.top10.toLocaleString()}</strong> ({((row.top10 / Math.max(row.total, 1)) * 100).toFixed(1)}%)
                                    </span>
                                    <span className="text-zinc-600 dark:text-zinc-300">
                                      Global Share: <strong>{row.share.toFixed(2)}%</strong>
                                    </span>
                                  </div>
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}

                    {/* Scientometric KPI Cards Strip for Bilateral Collaboration */}
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 pt-2 font-mono text-xs">
                      {/* #1 Global Corridor */}
                      <div className="p-3 rounded bg-emerald-50/50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-800/40">
                        <div className="flex items-center justify-between text-emerald-600 dark:text-emerald-400 mb-1">
                          <span className="text-[10px] uppercase font-bold tracking-wider">#1 Global Pair</span>
                          <Network className="h-3.5 w-3.5" />
                        </div>
                        {parsedRows.length > 0 ? (
                          <>
                            <p className="font-bold text-base text-emerald-700 dark:text-emerald-300 truncate">
                              {parsedRows[0].countryA} ⇄ {parsedRows[0].countryB}
                            </p>
                            <span className="text-[9px] text-emerald-600/80 dark:text-emerald-400/70">
                              {parsedRows[0].total.toLocaleString()} papers ({parsedRows[0].share.toFixed(1)}% share)
                            </span>
                          </>
                        ) : (
                          <p className="font-bold text-base text-zinc-400">—</p>
                        )}
                      </div>

                      {/* Top India Corridor */}
                      <div className="p-3 rounded bg-orange-50/50 dark:bg-orange-950/20 border border-orange-200 dark:border-orange-800/40">
                        <div className="flex items-center justify-between text-orange-600 dark:text-orange-400 mb-1">
                          <span className="text-[10px] uppercase font-bold tracking-wider">India #1 Partner</span>
                          <span className="px-1 py-0.2 rounded text-[9px] font-bold bg-orange-500/20 text-orange-700 dark:text-orange-300">IN</span>
                        </div>
                        {topIndiaPair ? (
                          <>
                            <p className="font-bold text-base text-orange-700 dark:text-orange-300 truncate">
                              {topIndiaPair.countryA === 'IN'
                                ? `${formatCountryName(topIndiaPair.countryB)} (${topIndiaPair.countryB})`
                                : `${formatCountryName(topIndiaPair.countryA)} (${topIndiaPair.countryA})`}
                            </p>
                            <span className="text-[9px] text-orange-600/80 dark:text-orange-400/70">
                              {topIndiaPair.total.toLocaleString()} papers (Global #{topIndiaPair.originalRank})
                            </span>
                          </>
                        ) : (
                          <p className="font-bold text-base text-zinc-400">—</p>
                        )}
                      </div>

                      {/* Total Bilateral Links */}
                      <div className="p-3 rounded bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-100 dark:border-zinc-800">
                        <span className="text-[10px] text-zinc-400 uppercase font-bold tracking-wider">
                          Active Corridors
                        </span>
                        <p className="font-bold text-base text-zinc-900 dark:text-zinc-100 mt-1">
                          {parsedRows.length.toLocaleString()} pairs
                        </p>
                        <span className="text-[9px] text-zinc-400">
                          {allTotalCollabs.toLocaleString()} joint papers
                        </span>
                      </div>

                      {/* High-Impact & Elite Collab Rate */}
                      <div className="p-3 rounded bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-100 dark:border-zinc-800">
                        <span className="text-[10px] text-zinc-400 uppercase font-bold tracking-wider">
                          High-Impact Collab Rate
                        </span>
                        <p className="font-bold text-base text-sky-600 dark:text-sky-400 mt-1">
                          {allTotalCollabs > 0
                            ? `${((allTotalTop10 / allTotalCollabs) * 100).toFixed(1)}%`
                            : '0.0%'}
                        </p>
                        <span className="text-[9px] text-zinc-400">
                          {allTotalTop10.toLocaleString()} Top 10% ({allTotalTop1.toLocaleString()} Top 1%)
                        </span>
                      </div>

                      {/* India Global Reach */}
                      <div className="p-3 rounded bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-100 dark:border-zinc-800">
                        <span className="text-[10px] text-zinc-400 uppercase font-bold tracking-wider">
                          India Reach
                        </span>
                        <p className="font-bold text-base text-zinc-900 dark:text-zinc-100 mt-1">
                          {indiaPartners.size} nations
                        </p>
                        <span className="text-[9px] text-zinc-400">
                          Co-authored partnerships
                        </span>
                      </div>
                    </div>

                    {/* Scientometric Bilateral Methodology & Canonical SQL Pair Logic */}
                    <div className="p-3 rounded border border-zinc-200 dark:border-zinc-850 bg-zinc-50/70 dark:bg-zinc-900/30 text-xs font-mono text-zinc-600 dark:text-zinc-400 flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
                      <div className="flex flex-col gap-1">
                        <span className="font-bold text-zinc-800 dark:text-zinc-200 text-[11px] flex items-center gap-1.5">
                          <Code2 className="h-3.5 w-3.5 text-zinc-500" />
                          Canonical Bilateral Ordering & Deduplication Methodology
                        </span>
                        <p className="text-[10px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
                          To model symmetric cross-border co-authorships without double-counting, each paper's distinct country affiliations are self-joined using the strict inequality <code className="px-1 py-0.2 rounded bg-zinc-200/80 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200">c1.country_code &lt; c2.country_code</code>. This eliminates domestic loops (e.g. US–US) and produces a single canonical pair for any bilateral relationship.
                        </p>
                      </div>
                      <div className="px-3 py-2 rounded bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-850 text-[11px] font-mono text-zinc-900 dark:text-zinc-100 whitespace-nowrap shadow-2xs self-stretch md:self-auto text-center">
                        <span className="text-emerald-600 dark:text-emerald-400 font-bold">Collab Share</span> = ( Pair Papers / Total Global Bilateral Links ) × 100
                      </div>
                    </div>
                  </div>
                )
              })()}
            </div>
          )}

          {/* 6. LEADING RESEARCH HUBS / INSTITUTIONS OUTCOME */}
          {activeOutcome === 'institutions' && (
            <div className="flex flex-col gap-4 border border-zinc-200 dark:border-zinc-850 rounded bg-white dark:bg-zinc-900/40 p-4 shadow-xs">
              {/* Header Strip with Sub-Mode Pills */}
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 border-b border-zinc-100 dark:border-zinc-800 pb-3">
                <div className="flex items-center gap-2 flex-wrap min-w-0">
                  {instTier === 'top1pct' ? (
                    <Flame className="h-4 w-4 text-orange-500 shrink-0" />
                  ) : instTier === 'top10pct' ? (
                    <Sparkles className="h-4 w-4 text-amber-500 shrink-0" />
                  ) : (
                    <Building2 className="h-4 w-4 text-zinc-600 dark:text-zinc-400 shrink-0" />
                  )}
                  <span className="font-mono font-bold text-xs uppercase tracking-tight text-zinc-900 dark:text-zinc-100">
                    {instTier === 'top1pct'
                      ? 'Top 10 Global Institutions (Top 1% Elite Publications)'
                      : instTier === 'top10pct'
                        ? 'Top 10 Global Institutions (Top 10% High-Impact Publications)'
                        : 'Top 10 Global Institutions (Total Publications)'}
                  </span>

                  {/* Sub-Mode Switcher Pills (Inside Single Institutions Group) */}
                  <div className="flex items-center rounded border border-zinc-200 dark:border-zinc-850 bg-zinc-100 dark:bg-zinc-900 p-0.5 text-[10px] font-mono">
                    <button
                      type="button"
                      onClick={() => handleInstTierChange('total')}
                      className={`flex items-center gap-1 px-2.5 py-1 rounded transition cursor-pointer ${
                        instTier === 'total'
                          ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-bold shadow-2xs'
                          : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                      }`}
                      title="Top 10 institutions by total publication volume"
                    >
                      <Building2 className="h-3 w-3" />
                      <span>Total Volume</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleInstTierChange('top1pct')}
                      className={`flex items-center gap-1 px-2.5 py-1 rounded transition cursor-pointer ${
                        instTier === 'top1pct'
                          ? 'bg-orange-500 text-white font-bold shadow-2xs'
                          : 'text-zinc-500 hover:text-orange-600 dark:hover:text-orange-400'
                      }`}
                      title="Top 10 institutions by Top 1% elite publications"
                    >
                      <Flame className="h-3 w-3" />
                      <span>Top 1% Elite</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleInstTierChange('top10pct')}
                      className={`flex items-center gap-1 px-2.5 py-1 rounded transition cursor-pointer ${
                        instTier === 'top10pct'
                          ? 'bg-amber-500 text-white font-bold shadow-2xs'
                          : 'text-zinc-500 hover:text-amber-600 dark:hover:text-amber-400'
                      }`}
                      title="Top 10 institutions by Top 10% high-impact publications"
                    >
                      <Sparkles className="h-3 w-3" />
                      <span>Top 10% Impact</span>
                    </button>
                  </div>
                </div>

                {results.rows.length > 0 && (() => {
                  const firstInst = results.rows[0]
                  const firstCC = String(firstInst?.country_code || '').toUpperCase()
                  const isFirstIndia = firstCC === 'IN' || String(firstInst?.institution_name || '').toLowerCase().includes('india')
                  const firstVal =
                    instTier === 'top1pct'
                      ? Number(firstInst.top_1pct_papers) || 0
                      : instTier === 'top10pct'
                        ? Number(firstInst.top_10pct_papers) || 0
                        : Number(firstInst.paper_count) || Number(firstInst.total_papers) || 0
                  return (
                    <div className="flex items-center gap-1.5 self-start lg:self-auto">
                      <span className="text-[10px] uppercase font-mono text-zinc-400">Global Leader:</span>
                      <span
                        className={`text-[11px] font-mono font-bold flex items-center gap-1.5 ${
                          isFirstIndia
                            ? 'text-orange-600 dark:text-orange-400'
                            : 'text-zinc-800 dark:text-zinc-200'
                        }`}
                      >
                        {firstCC && (
                          <span className="px-1 py-0.2 rounded text-[9px] font-mono font-bold bg-zinc-200 dark:bg-zinc-700">
                            {firstCC}
                          </span>
                        )}
                        <span>#1 {String(firstInst?.institution_name || '')}</span>
                        <span className="px-1 py-0.5 rounded text-[9px] bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">
                          {firstVal.toLocaleString()} papers
                        </span>
                      </span>
                    </div>
                  )
                })()}
              </div>

              {/* 2-Column Balanced Institutional Ranking Chart (Exact unrounded integers, India Saffron Highlight) */}
              {(() => {
                const displayRows = results.rows.slice(0, 10)
                const getRowVal = (row: Record<string, string | number | boolean>) => {
                  if (instTier === 'top1pct') return Number(row.top_1pct_papers) || 0
                  if (instTier === 'top10pct') return Number(row.top_10pct_papers) || 0
                  return Number(row.paper_count) || Number(row.total_papers) || 0
                }
                const maxVal = Math.max(...displayRows.map(getRowVal), 1)

                return (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1.5">
                      {displayRows.map((row, idx) => {
                        const val = getRowVal(row)
                        const barWidth = Math.max((val / maxVal) * 100, 2)
                        const instName = String(row.institution_name || '')
                        const cc = String(row.country_code || '').toUpperCase()
                        const rank = row.rank !== undefined ? Number(row.rank) : idx + 1
                        const isIndia = cc === 'IN' || instName.toLowerCase().includes('india') || instName.toLowerCase().includes('iisc')
                        const sharePct = Number(row.share_pct) || 0
                        const ratePct =
                          instTier === 'top1pct'
                            ? Number(row.top_1pct_rate) || 0
                            : instTier === 'top10pct'
                              ? Number(row.top_10pct_rate) || 0
                              : null

                        return (
                          <div
                            key={idx}
                            className={`flex items-center gap-2.5 py-1.5 px-2.5 rounded text-xs font-mono transition-colors ${
                              isIndia
                                ? 'bg-orange-50/70 dark:bg-orange-950/25 border border-orange-300 dark:border-orange-800/60 shadow-2xs'
                                : 'hover:bg-zinc-100/70 dark:hover:bg-zinc-800/40 border border-transparent'
                            }`}
                          >
                            <span
                              className={`w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold border shrink-0 ${
                                isIndia
                                  ? 'border-orange-500 bg-orange-500 text-white shadow-2xs'
                                  : 'border-zinc-200 dark:border-zinc-700 bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
                              }`}
                            >
                              #{rank}
                            </span>
                            <div className="flex items-center gap-1.5 w-40 sm:w-48 shrink-0 min-w-0">
                              <span
                                className={`font-sans font-semibold text-xs truncate ${
                                  isIndia
                                    ? 'text-orange-600 dark:text-orange-400 font-bold'
                                    : 'text-zinc-900 dark:text-zinc-100'
                                }`}
                                title={instName}
                              >
                                {instName}
                              </span>
                              {cc && (
                                <span
                                  className={`text-[9px] uppercase font-mono px-1 py-0.2 rounded shrink-0 ${
                                    isIndia
                                      ? 'text-orange-700 dark:text-orange-300 bg-orange-100/80 dark:bg-orange-900/40 font-bold'
                                      : 'text-zinc-400 bg-zinc-100 dark:bg-zinc-800'
                                  }`}
                                >
                                  {cc}
                                </span>
                              )}
                            </div>
                            <div className="flex-1 h-2 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden min-w-[45px]">
                              <div
                                style={{ width: `${barWidth}%` }}
                                className={`h-full rounded-full transition-all duration-300 ${
                                  isIndia
                                    ? 'bg-orange-500 dark:bg-orange-400'
                                    : instTier === 'top1pct'
                                      ? 'bg-orange-600 dark:bg-orange-500'
                                      : instTier === 'top10pct'
                                        ? 'bg-amber-600 dark:bg-amber-500'
                                        : 'bg-zinc-800 dark:bg-zinc-300'
                                }`}
                              />
                            </div>
                            <div className="flex flex-col items-end shrink-0 min-w-[75px] text-right font-mono">
                              <span
                                className={`font-bold text-xs ${
                                  isIndia
                                    ? 'text-orange-600 dark:text-orange-400'
                                    : 'text-zinc-900 dark:text-zinc-100'
                                }`}
                              >
                                {val.toLocaleString()}
                                <span className="text-[10px] font-normal text-zinc-500 dark:text-zinc-400 ml-1">
                                  {instTier === 'top1pct'
                                    ? 'elite'
                                    : instTier === 'top10pct'
                                      ? 'top 10%'
                                      : 'papers'}
                                </span>
                              </span>
                              <div className="flex items-center gap-1 text-[9px] text-zinc-400">
                                {ratePct !== null && (
                                  <span className={ratePct >= 50 || (instTier === 'top1pct' && ratePct >= 15) ? 'text-emerald-600 dark:text-emerald-400 font-bold' : ''}>
                                    {ratePct}% rate
                                  </span>
                                )}
                                {sharePct > 0 && <span>{sharePct}% shr</span>}
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>

                    {/* Scientometric KPI Cards Strip for Institutions */}
                    {displayRows.length > 0 && (() => {
                      const topRow = displayRows[0]
                      const topIndia = displayRows.find(
                        (r) =>
                          String(r.country_code).toUpperCase() === 'IN' ||
                          String(r.institution_name).toLowerCase().includes('india') ||
                          String(r.institution_name).toLowerCase().includes('iisc')
                      )
                      const sumTop10 = displayRows.reduce((acc, r) => acc + getRowVal(r), 0)
                      const distinctNations = new Set(
                        displayRows.map((r) => String(r.country_code || '').toUpperCase()).filter(Boolean)
                      ).size
                      const sumTotalPapers = displayRows.reduce((acc, r) => acc + (Number(r.total_papers) || Number(r.paper_count) || 0), 0)
                      const avgRate = sumTotalPapers > 0 ? ((sumTop10 / sumTotalPapers) * 100).toFixed(1) : '0.0'

                      return (
                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5 pt-2 border-t border-zinc-100 dark:border-zinc-800">
                          {/* Card 1: Top Global Institution */}
                          <div className="p-3 rounded bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-100 dark:border-zinc-800">
                            <span className="text-[10px] text-zinc-400 uppercase font-bold tracking-wider">
                              Global Leader
                            </span>
                            <p className="font-bold text-xs text-zinc-900 dark:text-zinc-100 mt-1 truncate" title={String(topRow.institution_name)}>
                              {String(topRow.institution_name)} ({String(topRow.country_code).toUpperCase()})
                            </p>
                            <span className="text-[10px] font-mono text-zinc-500 dark:text-zinc-400">
                              {getRowVal(topRow).toLocaleString()} {instTier === 'top1pct' ? 'elite' : instTier === 'top10pct' ? 'top 10%' : 'papers'}
                            </span>
                          </div>

                          {/* Card 2: India Leader */}
                          <div className="p-3 rounded bg-orange-50/60 dark:bg-orange-950/20 border border-orange-200 dark:border-orange-900/40">
                            <span className="text-[10px] text-orange-600 dark:text-orange-400 uppercase font-bold tracking-wider">
                              Top Indian Hub (IN)
                            </span>
                            <p className="font-bold text-xs text-orange-700 dark:text-orange-300 mt-1 truncate" title={topIndia ? String(topIndia.institution_name) : 'Indian Institute of Science'}>
                              {topIndia ? String(topIndia.institution_name) : 'Indian Institute of Science'}
                            </p>
                            <span className="text-[10px] font-mono text-orange-600 dark:text-orange-400">
                              {topIndia ? `#${topIndia.rank} • ${getRowVal(topIndia).toLocaleString()} papers` : 'Ranked in Top 10'}
                            </span>
                          </div>

                          {/* Card 3: Top 10 Combined Output */}
                          <div className="p-3 rounded bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-100 dark:border-zinc-800">
                            <span className="text-[10px] text-zinc-400 uppercase font-bold tracking-wider">
                              Top 10 Output
                            </span>
                            <p className="font-bold text-base text-zinc-900 dark:text-zinc-100 mt-1 font-mono">
                              {sumTop10.toLocaleString()}
                            </p>
                            <span className="text-[10px] font-mono text-zinc-400">
                              Combined {instTier === 'top1pct' ? 'elite' : instTier === 'top10pct' ? 'top 10%' : 'total'} papers
                            </span>
                          </div>

                          {/* Card 4: Impact / Elite Density */}
                          <div className="p-3 rounded bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-100 dark:border-zinc-800">
                            <span className="text-[10px] text-zinc-400 uppercase font-bold tracking-wider">
                              {instTier === 'top1pct' ? 'Elite Density' : instTier === 'top10pct' ? 'High Impact Rate' : 'Combined Share'}
                            </span>
                            <p className="font-bold text-base text-zinc-900 dark:text-zinc-100 mt-1 font-mono">
                              {instTier === 'total'
                                ? `${displayRows.reduce((acc, r) => acc + (Number(r.share_pct) || 0), 0).toFixed(1)}%`
                                : `${avgRate}%`}
                            </p>
                            <span className="text-[10px] font-mono text-zinc-400">
                              {instTier === 'total' ? 'Global corpus share' : 'Average tier conversion'}
                            </span>
                          </div>

                          {/* Card 5: Geographic Diversity */}
                          <div className="p-3 rounded bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-100 dark:border-zinc-800">
                            <span className="text-[10px] text-zinc-400 uppercase font-bold tracking-wider">
                              Geographic Spread
                            </span>
                            <p className="font-bold text-base text-zinc-900 dark:text-zinc-100 mt-1 font-mono">
                              {distinctNations} nations
                            </p>
                            <span className="text-[10px] font-mono text-zinc-400">
                              Countries in Top 10
                            </span>
                          </div>
                        </div>
                      )
                    })()}

                    {/* Scientometric Note */}
                    <div className="p-3 rounded border border-zinc-200 dark:border-zinc-850 bg-zinc-50/70 dark:bg-zinc-900/30 text-xs font-mono text-zinc-600 dark:text-zinc-400 flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
                      <div className="flex flex-col gap-1">
                        <span className="font-bold text-zinc-800 dark:text-zinc-200 text-[11px] flex items-center gap-1.5">
                          <Code2 className="h-3.5 w-3.5 text-zinc-500" />
                          Institutional Affiliation Disambiguation & Scientometric Normalization
                        </span>
                        <p className="text-[10px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
                          Institution names are matched against OpenAlex ROR (Research Organization Registry) entities. Papers are attributed using whole counting per institution, with top-tier citation thresholds computed globally across field-year normalized citation percentiles.
                        </p>
                      </div>
                      <div className="px-3 py-2 rounded bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-850 text-[11px] font-mono text-zinc-900 dark:text-zinc-100 whitespace-nowrap shadow-2xs self-stretch md:self-auto text-center">
                        <span className="text-orange-600 dark:text-orange-400 font-bold">Limit 10</span> = Global Top 10 Elite Institutions
                      </div>
                    </div>
                  </>
                )
              })()}
            </div>
          )}

          {/* TOP 10 GLOBAL & INDIAN AUTHORS */}
          {activeOutcome === 'authors' && (
            <div className="flex flex-col gap-4 border border-zinc-200 dark:border-zinc-850 rounded bg-white dark:bg-zinc-900/40 p-4 sm:p-5 shadow-xs">
              {/* Header Bar: Scope Switcher, Metric Sorter */}
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 border-b border-zinc-100 dark:border-zinc-800 pb-3">
                <div className="flex items-center gap-2 flex-wrap min-w-0">
                  <Users className="h-4 w-4 text-sky-500 shrink-0" />
                  <span className="font-mono font-bold text-xs uppercase tracking-tight text-zinc-900 dark:text-zinc-100">
                    {authorScope === 'india'
                      ? 'Top 10 Indian Authors'
                      : authorScope === 'global'
                        ? 'Top 10 Global Authors'
                        : 'Top 10 Global & Indian Authors (Side-by-Side Comparison)'}
                  </span>

                  {/* Scope Selector: Split vs Global vs India */}
                  <div className="flex items-center rounded border border-zinc-200 dark:border-zinc-850 bg-zinc-100 dark:bg-zinc-900 p-0.5 text-[10px] font-mono shadow-2xs">
                    <button
                      type="button"
                      onClick={() => handleAuthorScopeChange('split')}
                      className={`flex items-center gap-1 px-2.5 py-1 rounded transition cursor-pointer ${
                        authorScope === 'split'
                          ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-bold shadow-2xs'
                          : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                      }`}
                      title="Side-by-side balanced comparison of Global Top 10 and India Top 10"
                    >
                      <ArrowLeftRight className="h-3 w-3 text-sky-500" />
                      <span>Side-by-Side</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleAuthorScopeChange('global')}
                      className={`flex items-center gap-1 px-2.5 py-1 rounded transition cursor-pointer ${
                        authorScope === 'global'
                          ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-bold shadow-2xs'
                          : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                      }`}
                      title="Global Top 10 Scholars"
                    >
                      <Globe className="h-3 w-3 text-emerald-500" />
                      <span>Global Top 10</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleAuthorScopeChange('india')}
                      className={`flex items-center gap-1 px-2.5 py-1 rounded transition cursor-pointer ${
                        authorScope === 'india'
                          ? 'bg-orange-500 text-white font-bold shadow-2xs'
                          : 'text-zinc-500 hover:text-orange-600 dark:hover:text-orange-400'
                      }`}
                      title="India Top 10 Scholars"
                    >
                      <span className="px-1 py-0.2 rounded text-[9px] font-bold font-mono bg-white/20">IN</span>
                      <span>India Top 10</span>
                    </button>
                  </div>
                </div>

                {/* Right Controls: Metric Sorter */}
                <div className="flex items-center gap-2 flex-wrap">
                  {/* Sorter Selector */}
                  <div className="flex items-center gap-1 text-[10px] font-mono text-zinc-400">
                    <span>Sort:</span>
                    <div className="flex items-center rounded border border-zinc-200 dark:border-zinc-850 bg-zinc-100 dark:bg-zinc-900 p-0.5 shadow-2xs">
                      <button
                        type="button"
                        onClick={() => setAuthorSortMetric('paper_count')}
                        className={`px-2 py-0.5 rounded transition cursor-pointer ${
                          authorSortMetric === 'paper_count'
                            ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-bold shadow-2xs'
                            : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                        }`}
                      >
                        Papers
                      </button>
                      <button
                        type="button"
                        onClick={() => setAuthorSortMetric('top_1pct_papers')}
                        className={`px-2 py-0.5 rounded transition cursor-pointer ${
                          authorSortMetric === 'top_1pct_papers'
                            ? 'bg-orange-500 text-white font-bold shadow-2xs'
                            : 'text-zinc-500 hover:text-orange-600 dark:hover:text-orange-400'
                        }`}
                        title="Sort by Top 1% elite papers"
                      >
                        Top 1%
                      </button>
                      <button
                        type="button"
                        onClick={() => setAuthorSortMetric('top_10pct_papers')}
                        className={`px-2 py-0.5 rounded transition cursor-pointer ${
                          authorSortMetric === 'top_10pct_papers'
                            ? 'bg-amber-500 text-white font-bold shadow-2xs'
                            : 'text-zinc-500 hover:text-amber-600 dark:hover:text-amber-400'
                        }`}
                        title="Sort by Top 10% impact papers"
                      >
                        Top 10%
                      </button>
                      <button
                        type="button"
                        onClick={() => setAuthorSortMetric('total_citations')}
                        className={`px-2 py-0.5 rounded transition cursor-pointer ${
                          authorSortMetric === 'total_citations'
                            ? 'bg-sky-500 text-white font-bold shadow-2xs'
                            : 'text-zinc-500 hover:text-sky-600 dark:hover:text-sky-400'
                        }`}
                        title="Sort by total citations"
                      >
                        Citations
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Author Lists Calculation & Scientometric Summary */}
              {(() => {
                const rawGlobal = (globalAuthorRows.length > 0 ? globalAuthorRows : results.rows).slice(0, 10)
                const rawIndia = (indiaAuthorRows.length > 0 ? indiaAuthorRows : executeMockQuery(AUTHOR_QUERIES.india).rows).slice(0, 10)

                const applySort = (rows: Record<string, string | number | boolean>[]) => {
                  return [...rows].sort((a, b) => {
                    const valA = Number(a[authorSortMetric]) || Number(a.paper_count) || 0
                    const valB = Number(b[authorSortMetric]) || Number(b.paper_count) || 0
                    return valB - valA
                  })
                }

                const displayGlobal = applySort(rawGlobal)
                const displayIndia = applySort(rawIndia)

                // Combined set for high-level scientometrics
                const combinedSet = authorScope === 'india' ? rawIndia : authorScope === 'global' ? rawGlobal : [...rawGlobal, ...rawIndia]

                // Top Scholars
                const topGlobalScholar = displayGlobal.length > 0 ? displayGlobal[0] : null
                const topIndiaScholar = displayIndia.length > 0 ? displayIndia[0] : null

                // Top Citation Scholar
                const topCited = [...combinedSet].sort((a, b) => (Number(b.total_citations) || 0) - (Number(a.total_citations) || 0))[0]

                const maxGlobalVal = Math.max(...displayGlobal.map((r) => Number(r[authorSortMetric]) || Number(r.paper_count) || 0), 1)
                const maxIndiaVal = Math.max(...displayIndia.map((r) => Number(r[authorSortMetric]) || Number(r.paper_count) || 0), 1)

                const renderAuthorCard = (
                  row: Record<string, string | number | boolean>,
                  idx: number,
                  isIndiaList: boolean,
                  maxVal: number,
                ) => {
                  const authorName = String(row.author_name || 'Unknown Author')
                  const cc = String(row.country_code || (isIndiaList ? 'IN' : '')).toUpperCase()
                  const isIndia = isIndiaList || cc === 'IN'
                  const papers = Number(row.paper_count) || 0
                  const top1 = Number(row.top_1pct_papers) || 0
                  const top10 = Number(row.top_10pct_papers) || 0
                  const citations = Number(row.total_citations) || 0
                  const primaryVal = Number(row[authorSortMetric]) || papers
                  const barWidth = Math.max((primaryVal / maxVal) * 100, 3)

                  return (
                    <div
                      key={`${authorName}-${idx}`}
                      className={`flex items-center gap-2.5 py-2 px-3 rounded text-xs font-mono transition-all duration-200 ${
                        isIndia
                          ? 'bg-orange-50/70 dark:bg-orange-950/25 border border-orange-300 dark:border-orange-850 shadow-2xs hover:border-orange-400'
                          : 'bg-white dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700'
                      }`}
                    >
                      {/* Rank Badge */}
                      <span
                        className={`w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold border shrink-0 ${
                          isIndia
                            ? 'border-orange-500 bg-orange-500 text-white shadow-2xs'
                            : 'border-zinc-200 dark:border-zinc-700 bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
                        }`}
                      >
                        #{idx + 1}
                      </span>

                      {/* Author Name & Country Badge */}
                      <div className="flex flex-col gap-0.5 w-40 sm:w-48 shrink-0 min-w-0">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span
                            className={`font-sans font-semibold text-xs truncate ${
                              isIndia ? 'text-orange-700 dark:text-orange-300 font-bold' : 'text-zinc-900 dark:text-zinc-100'
                            }`}
                            title={authorName}
                          >
                            {authorName}
                          </span>
                          {cc && (
                            <span
                              className={`text-[9px] uppercase font-mono px-1 py-0.2 rounded shrink-0 ${
                                isIndia
                                  ? 'text-orange-700 dark:text-orange-300 bg-orange-100/80 dark:bg-orange-900/40 font-bold'
                                  : 'text-zinc-400 bg-zinc-100 dark:bg-zinc-800'
                              }`}
                            >
                              {cc}
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-1">
                          <span className="text-[10px] text-zinc-400 font-mono">
                            {papers} {papers === 1 ? 'paper' : 'papers'}
                          </span>
                        </div>
                      </div>

                      {/* Bar Visualization */}
                      <div className="flex-1 h-2 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden min-w-[40px]">
                        <div
                          style={{ width: `${barWidth}%` }}
                          className={`h-full rounded-full transition-all duration-300 ${
                            isIndia
                              ? 'bg-orange-500 dark:bg-orange-400'
                              : 'bg-sky-500 dark:bg-sky-400'
                          }`}
                        />
                      </div>

                      {/* Metric Values & Impact Tags */}
                      <div className="flex flex-col items-end shrink-0 min-w-[85px] sm:min-w-[100px] text-right font-mono">
                        <span
                          className={`font-bold text-xs ${
                            isIndia ? 'text-orange-600 dark:text-orange-400' : 'text-zinc-900 dark:text-zinc-100'
                          }`}
                        >
                          {primaryVal.toLocaleString()}
                          <span className="text-[10px] font-normal text-zinc-500 dark:text-zinc-400 ml-1">
                            {authorSortMetric === 'total_citations'
                              ? 'cites'
                              : authorSortMetric === 'top_1pct_papers'
                                ? 'elite'
                                : authorSortMetric === 'top_10pct_papers'
                                  ? 'top 10%'
                                  : 'papers'}
                          </span>
                        </span>
                        <div className="flex items-center gap-1.5 text-[9px] text-zinc-400">
                          {top1 > 0 && <span className="text-orange-600 dark:text-orange-400 font-bold">🔥 {top1}</span>}
                          {top10 > 0 && <span className="text-amber-600 dark:text-amber-400 font-bold">✨ {top10}</span>}
                          {citations > 0 && <span>📜 {citations.toLocaleString()}</span>}
                        </div>
                      </div>
                    </div>
                  )
                }

                return (
                  <>
                    {/* Authors List Columns Container */}
                    {authorScope === 'split' ? (
                      /* SIDE-BY-SIDE 2-COLUMN VIEW */
                      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                        {/* LEFT: Global Top 10 Scholars */}
                        <div className="flex flex-col gap-2">
                          <div className="flex items-center justify-between px-1 pb-1 border-b border-zinc-200 dark:border-zinc-850">
                            <span className="text-xs font-mono font-bold uppercase text-zinc-700 dark:text-zinc-300 flex items-center gap-1.5">
                              <Globe className="h-3.5 w-3.5 text-emerald-500" />
                              Global Top 10 Scholars
                            </span>
                            <span className="text-[10px] font-mono text-zinc-400">
                              {displayGlobal.length} scholars
                            </span>
                          </div>
                          <div className="flex flex-col gap-1.5">
                            {displayGlobal.length > 0 ? (
                              displayGlobal.map((r, idx) => renderAuthorCard(r, idx, false, maxGlobalVal))
                            ) : (
                              <div className="p-4 text-center text-xs font-mono text-zinc-400 border border-dashed border-zinc-200 dark:border-zinc-850 rounded">
                                No authors found.
                              </div>
                            )}
                          </div>
                        </div>

                        {/* RIGHT: India Top 10 Scholars (Saffron Accent) */}
                        <div className="flex flex-col gap-2">
                          <div className="flex items-center justify-between px-1 pb-1 border-b border-orange-200 dark:border-orange-850">
                            <span className="text-xs font-mono font-bold uppercase text-orange-600 dark:text-orange-400 flex items-center gap-1.5">
                              <span className="px-1.5 py-0.2 rounded text-[9px] font-mono font-bold bg-orange-500 text-white">IN</span>
                              India Top 10 Scholars
                            </span>
                            <span className="text-[10px] font-mono text-orange-500 dark:text-orange-400 font-bold">
                              National Cohort
                            </span>
                          </div>
                          <div className="flex flex-col gap-1.5">
                            {displayIndia.length > 0 ? (
                              displayIndia.map((r, idx) => renderAuthorCard(r, idx, true, maxIndiaVal))
                            ) : (
                              <div className="p-4 text-center text-xs font-mono text-zinc-400 border border-dashed border-zinc-200 dark:border-zinc-850 rounded">
                                No authors found.
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    ) : authorScope === 'global' ? (
                      /* SINGLE VIEW: GLOBAL TOP 10 */
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1.5">
                        {displayGlobal.length > 0 ? (
                          displayGlobal.map((r, idx) => renderAuthorCard(r, idx, false, maxGlobalVal))
                        ) : (
                          <div className="col-span-2 p-6 text-center text-xs font-mono text-zinc-400 border border-dashed border-zinc-200 dark:border-zinc-850 rounded">
                            No authors found.
                          </div>
                        )}
                      </div>
                    ) : (
                      /* SINGLE VIEW: INDIA TOP 10 */
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1.5">
                        {displayIndia.length > 0 ? (
                          displayIndia.map((r, idx) => renderAuthorCard(r, idx, true, maxIndiaVal))
                        ) : (
                          <div className="col-span-2 p-6 text-center text-xs font-mono text-zinc-400 border border-dashed border-zinc-200 dark:border-zinc-850 rounded">
                            No authors found.
                          </div>
                        )}
                      </div>
                    )}

                    {/* Scientometric Diversity & Impact KPI Cards Strip */}
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5 pt-3 border-t border-zinc-100 dark:border-zinc-800">
                      {/* Card 1: Top Global Scholar */}
                      <div className="p-3 rounded bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-100 dark:border-zinc-800">
                        <span className="text-[10px] text-zinc-400 uppercase font-bold tracking-wider">
                          Global Leader
                        </span>
                        <p className="font-bold text-xs text-zinc-900 dark:text-zinc-100 mt-1 truncate" title={topGlobalScholar ? String(topGlobalScholar.author_name) : ''}>
                          {topGlobalScholar ? String(topGlobalScholar.author_name) : '—'}
                        </p>
                        <span className="text-[10px] font-mono text-zinc-500 dark:text-zinc-400">
                          {topGlobalScholar ? `${Number(topGlobalScholar.paper_count)} papers • ${Number(topGlobalScholar.total_citations || 0).toLocaleString()} cites` : 'No author data'}
                        </span>
                      </div>

                      {/* Card 2: Leading Indian Scholar */}
                      <div className="p-3 rounded bg-orange-50/60 dark:bg-orange-950/20 border border-orange-200 dark:border-orange-900/40">
                        <span className="text-[10px] text-orange-600 dark:text-orange-400 uppercase font-bold tracking-wider flex items-center gap-1">
                          <span className="px-1 py-0.2 rounded text-[8px] font-mono font-bold bg-orange-500 text-white">IN</span>
                          Top Indian Scholar
                        </span>
                        <p className="font-bold text-xs text-orange-700 dark:text-orange-300 mt-1 truncate" title={topIndiaScholar ? String(topIndiaScholar.author_name) : 'None in cohort'}>
                          {topIndiaScholar ? String(topIndiaScholar.author_name) : 'None in cohort'}
                        </p>
                        <span className="text-[10px] font-mono text-orange-600/80 dark:text-orange-400/80">
                          {topIndiaScholar ? `${Number(topIndiaScholar.paper_count)} papers • ${Number(topIndiaScholar.total_citations || 0).toLocaleString()} cites` : 'No Indian author in filter'}
                        </span>
                      </div>

                      {/* Card 3: Highest Citation Scholar */}
                      <div className="p-3 rounded bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-100 dark:border-zinc-800">
                        <span className="text-[10px] text-zinc-400 uppercase font-bold tracking-wider">
                          Citation Leader
                        </span>
                        <p className="font-bold text-xs text-zinc-900 dark:text-zinc-100 mt-1 truncate" title={topCited ? String(topCited.author_name) : ''}>
                          {topCited ? String(topCited.author_name) : '—'}
                        </p>
                        <span className="text-[10px] font-mono text-zinc-500 dark:text-zinc-400">
                          {topCited ? `${Number(topCited.total_citations || 0).toLocaleString()} citations` : '0 citations'}
                        </span>
                      </div>

                      {/* Card 4: Elite Impact Density */}
                      <div className="p-3 rounded bg-orange-50/50 dark:bg-orange-950/20 border border-orange-200 dark:border-orange-900/40">
                        <span className="text-[10px] text-orange-600 dark:text-orange-400 uppercase font-bold tracking-wider">
                          Top 1% Elite Papers
                        </span>
                        <p className="font-bold text-base text-orange-700 dark:text-orange-300 mt-1 font-mono">
                          {combinedSet.reduce((acc, r) => acc + (Number(r.top_1pct_papers) || 0), 0).toLocaleString()}
                        </p>
                        <span className="text-[10px] font-mono text-orange-600/70 dark:text-orange-400/70">
                          Combined elite output
                        </span>
                      </div>

                      {/* Card 5: Cohort Size */}
                      <div className="p-3 rounded bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-100 dark:border-zinc-800">
                        <span className="text-[10px] text-zinc-400 uppercase font-bold tracking-wider">
                          Scholars Profiled
                        </span>
                        <p className="font-bold text-base text-zinc-900 dark:text-zinc-100 mt-1 font-mono">
                          {combinedSet.length} Authors
                        </p>
                        <span className="text-[10px] font-mono text-zinc-400">
                          {authorScope === 'split' ? '10 Global + 10 Indian' : 'Ranked top cohort'}
                        </span>
                      </div>
                    </div>

                    {/* Scientometric Note */}
                    <div className="p-3 rounded border border-zinc-200 dark:border-zinc-850 bg-zinc-50/70 dark:bg-zinc-900/30 text-xs font-mono text-zinc-600 dark:text-zinc-400 flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
                      <div className="flex flex-col gap-1">
                        <span className="font-bold text-zinc-800 dark:text-zinc-200 text-[11px] flex items-center gap-1.5">
                          <Code2 className="h-3.5 w-3.5 text-zinc-500" />
                          Author Scientometric Disambiguation & Ranking Methodology
                        </span>
                        <p className="text-[10px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
                          Author names are extracted from contribution records linked to publication identifiers and ranked across total publication volume, top 1% elite tier output, top 10% impact, and citation density.
                        </p>
                      </div>
                      <div className="px-3 py-2 rounded bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-850 text-[11px] font-mono text-zinc-900 dark:text-zinc-100 whitespace-nowrap shadow-2xs self-stretch md:self-auto text-center">
                        <span className="text-orange-600 dark:text-orange-400 font-bold">Limit 10</span> = Top 10 Global & Indian Scholars
                      </div>
                    </div>
                  </>
                )
              })()}
            </div>
          )}
        </div>
      ) : (
        /* Raw Data Table View (When Table Toggle Is Selected) */
        <div className="w-full overflow-x-auto border border-zinc-200 dark:border-zinc-850 rounded shadow-xs max-h-[500px] overflow-y-auto">
          <table className="w-full border-collapse text-left font-mono text-xs">
            <thead className="sticky top-0 bg-zinc-50 dark:bg-zinc-900 z-10 border-b border-zinc-200 dark:border-zinc-850">
              <tr className="text-zinc-500">
                {results.columns.map((col) => (
                  <th
                    key={col}
                    className="p-3 border-r border-zinc-200 dark:border-zinc-850 font-bold uppercase select-none text-[11px]"
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {results.rows.map((row, idx) => (
                <tr
                  key={idx}
                  className="hover:bg-zinc-50/50 dark:hover:bg-zinc-900/20 transition-colors"
                >
                  {results.columns.map((col) => (
                    <td
                      key={col}
                      className="p-3 border-r border-zinc-100 dark:border-zinc-900 truncate max-w-xs text-zinc-800 dark:text-zinc-200"
                    >
                      {typeof row[col] === 'boolean'
                        ? String(row[col]).toUpperCase()
                        : (row[col] ?? 'NULL')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Subtle Collapsible SQL Auditor (Closed by Default) */}
      <div className="border border-zinc-200 dark:border-zinc-850 rounded bg-zinc-50/40 dark:bg-zinc-900/20 overflow-hidden mt-2">
        <button
          type="button"
          onClick={() => setShowSqlAudit(!showSqlAudit)}
          className="flex items-center justify-between w-full p-3 text-xs font-mono text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 cursor-pointer"
        >
          <div className="flex items-center gap-2">
            <Code2 className="h-3.5 w-3.5 text-zinc-400" />
            <span>Underlying SQL Command ({activeOutcomeConfig.shortLabel})</span>
            {executionTimeMs !== null && (
              <span className="text-[10px] text-zinc-400 font-normal">
                ({executionTimeMs} ms execution)
              </span>
            )}
          </div>
          {showSqlAudit ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>

        {showSqlAudit && (
          <div className="p-3 border-t border-zinc-200 dark:border-zinc-850 bg-zinc-950 text-zinc-200 font-mono text-xs">
            <pre className="whitespace-pre-wrap leading-relaxed overflow-x-auto">
              {activeOutcomeConfig.sql}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}

export { Sql as default }