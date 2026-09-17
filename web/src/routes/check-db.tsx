// src/routes/check-db.tsx
import { useState, useEffect, useCallback } from 'react'
import { Link } from '@tanstack/react-router'
import {
  Database,
  RefreshCw,
  Download,
  Copy,
  Check,
  AlertTriangle,
  Layers,
  CheckCircle2,
  Building2,
  Globe,
  ArrowLeft,
  FileCode,
  HardDrive,
  Info,
  Search,
  Award,
  FolderOpen,
} from 'lucide-react'
import { useProject } from '../context/ProjectContext'
import { generateDatabaseHealthPDF } from '../lib/pdf-report'

export interface CheckDBData {
  total: number
  year_min: number | string
  year_max: number | string
  with_abstract: number
  author_count: number
  inst_count: number
  country_count: number
  contrib_count: number
  with_country: number
  with_institution: number
  authors_with_orcid: number
  institutions_with_ror: number
  contrib_with_country: number
  contrib_with_institution: number
  contrib_with_raw_affiliation: number
  orphan: number
  all_null: number
  zero_total: number
  contribs_for_zero: number
  rows_imputable: number
  rows_dead: number
  papers_imputable: number
  papers_with_doi: number
  papers_without_doi: number
  buckets: Record<string, number>
  partial_total: number
  all_null_country: number
  zero_country_total: number
  country_buckets: Record<string, number>
  partial_country_total: number
  oa_count: number
  top1_count: number
  top1_with_institution?: number
  top1_with_country?: number
  top10_count: number
  top10_with_institution?: number
  top10_with_country?: number
  international_count: number
  core_journal_count: number
  avg_citations: number
  avg_fwci: number
  oa_status_breakdown: [string, number][]
  top_topics?: { name: string; count: number }[]
  db_path?: string
  cli_output?: string
  error?: string
}

interface DatabaseFileItem {
  name: string
  path: string
  size_human: string
  type: 'DuckDB' | 'SQLite'
  mod_time: string
}

export interface DiscoveredDBItem {
  name: string
  path: string
  size_human: string
  source: string
  is_active_project: boolean
}

interface Toast {
  id: string
  type: 'success' | 'error' | 'info'
  title: string
  message: string
}

export function CheckDB() {
  const { activeProject } = useProject()

  // URL search param check (e.g. /check-db?file=papers.duckdb)
  const initialFileFromUrl = (() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search)
      return params.get('file') || ''
    }
    return ''
  })()

  // State
  const [dbFiles, setDbFiles] = useState<DatabaseFileItem[]>([])
  const [discoveredDBs, setDiscoveredDBs] = useState<DiscoveredDBItem[]>([])
  const [selectedDB, setSelectedDB] = useState<string>(initialFileFromUrl)
  const [customPathInput, setCustomPathInput] = useState<string>('')
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<CheckDBData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'visual' | 'json'>('visual')
  const [copiedJson, setCopiedJson] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])

  const addToast = (type: 'success' | 'error' | 'info', title: string, message: string) => {
    const id = Math.random().toString(36).substring(2, 9)
    setToasts((prev) => [...prev, { id, type, title, message }])
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 5000)
  }

  // Execute check-db API query
  const runCheck = useCallback(async (targetFile?: string) => {
    const fileToQuery = targetFile !== undefined ? targetFile : selectedDB
    setChecking(true)
    setError(null)

    try {
      let url = `/api/export/check-db?project=${encodeURIComponent(activeProject)}`
      if (fileToQuery) {
        url += `&file=${encodeURIComponent(fileToQuery)}`
      }
      const resp = await fetch(url)
      const data = await resp.json()
      if (!resp.ok || data.error) {
        throw new Error(data.error || `HTTP ${resp.status} checking database`)
      }
      setResult(data)
      if (fileToQuery && fileToQuery !== selectedDB) {
        setSelectedDB(fileToQuery)
      }
    } catch (err: any) {
      setError(err.message || 'Failed to complete database completeness check')
      addToast('error', 'Check DB Failed', err.message || 'Verification error')
    } finally {
      setChecking(false)
    }
  }, [activeProject, selectedDB])

  // Fetch available project database files
  // Fetch available project database files & discovered external databases
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
        if (Array.isArray(data.sqlite_files)) {
          for (const f of data.sqlite_files) {
            items.push({
              name: f.name,
              path: f.path,
              size_human: f.size_human,
              type: 'SQLite',
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

        // Select initial file
        const urlParams = new URLSearchParams(window.location.search)
        const urlFile = urlParams.get('file')

        let chosen = ''
        if (urlFile && (items.some((it) => it.name === urlFile || it.path === urlFile) || discovered.some((d) => d.name === urlFile || d.path === urlFile))) {
          chosen = urlFile
        } else if (selectedDB && (items.some((it) => it.name === selectedDB || it.path === selectedDB) || discovered.some((d) => d.name === selectedDB || d.path === selectedDB))) {
          chosen = selectedDB
        } else if (items.length > 0) {
          chosen = items[0].name
        } else if (discovered.length > 0) {
          chosen = discovered[0].path || discovered[0].name
        }

        if (chosen) {
          setSelectedDB(chosen)
          runCheck(chosen)
        } else {
          // Attempt run check anyway for auto-discovery
          runCheck('')
        }
      }
    } catch (err) {
      console.error('Failed to load database files:', err)
    } finally {
      setLoadingFiles(false)
    }
  }, [activeProject, selectedDB, runCheck])

  useEffect(() => {
    fetchDBFiles()
  }, [activeProject])

  // Download comprehensive PDF report
  const handleDownloadPDFReport = () => {
    if (!result) return
    try {
      generateDatabaseHealthPDF(result, selectedDB, activeProject)
      addToast('success', 'PDF Report Downloaded', `Generated PDF health report for ${selectedDB}`)
    } catch (err: any) {
      console.error('Failed to generate PDF:', err)
      addToast('error', 'PDF Generation Failed', err.message || 'Error generating PDF document')
    }
  }

  // Copy Raw JSON
  const handleCopyJson = () => {
    if (!result) return
    navigator.clipboard.writeText(JSON.stringify(result, null, 2))
    setCopiedJson(true)
    addToast('success', 'JSON Copied', 'Full health data JSON copied to clipboard')
    setTimeout(() => setCopiedJson(false), 2500)
  }

  // UI Helper: Render unicode block character bar
  const renderBlockBar = (pct: number, width = 16) => {
    const clamped = Math.max(0, Math.min(100, pct || 0))
    const filled = Math.round((width * clamped) / 100)
    return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
  }

  // UI Helper: Completeness progress bar row
  const renderCompletenessRow = (label: string, count: number, total: number) => {
    const d = total || 1
    const pct = (count / d) * 100
    const clamped = Math.max(0, Math.min(100, pct || 0))
    const colorClass = clamped >= 80 ? 'bg-emerald-500' : clamped >= 50 ? 'bg-amber-500' : 'bg-rose-500'
    const textClass =
      clamped >= 80
        ? 'text-emerald-700 dark:text-emerald-400'
        : clamped >= 50
          ? 'text-amber-700 dark:text-amber-400'
          : 'text-rose-700 dark:text-rose-400'

    return (
      <div className="flex items-center justify-between gap-3">
        <span className="text-zinc-600 dark:text-zinc-400 truncate flex-1">{label}</span>
        <div
          className="w-28 sm:w-44 h-2 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden shrink-0 cursor-help"
          title={`${label}: ${renderBlockBar(clamped)} ${clamped.toFixed(1)}%`}
        >
          <div className={`h-full ${colorClass} rounded-full transition-all duration-300`} style={{ width: `${clamped}%` }} />
        </div>
        <span className={`w-32 text-right font-bold text-[11px] shrink-0 font-mono ${textClass}`}>
          {count.toLocaleString()} ({clamped.toFixed(1)}%)
        </span>
      </div>
    )
  }

  // UI Helper: Coverage category progress bar row
  const renderCoverageRow = (label: string, count: number, total: number, color: 'emerald' | 'amber' | 'rose') => {
    const d = total || 1
    const pct = (count / d) * 100
    const clamped = Math.max(0, Math.min(100, pct || 0))
    const colorClass = color === 'emerald' ? 'bg-emerald-500' : color === 'amber' ? 'bg-amber-500' : 'bg-rose-500'
    const textClass =
      color === 'emerald'
        ? 'text-emerald-700 dark:text-emerald-400'
        : color === 'amber'
          ? 'text-amber-700 dark:text-amber-400'
          : 'text-rose-700 dark:text-rose-400'

    return (
      <div className="flex items-center justify-between gap-3">
        <span className="text-zinc-600 dark:text-zinc-400 truncate flex-1">{label}</span>
        <div
          className="w-24 sm:w-36 h-2 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden shrink-0 cursor-help"
          title={`${label}: ${renderBlockBar(clamped)} ${clamped.toFixed(1)}%`}
        >
          <div className={`h-full ${colorClass} rounded-full transition-all duration-300`} style={{ width: `${clamped}%` }} />
        </div>
        <span className={`w-32 text-right font-bold text-[11px] shrink-0 font-mono ${textClass}`}>
          {count.toLocaleString()} ({clamped.toFixed(1)}%)
        </span>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 pb-16 w-full max-w-7xl mx-auto font-sans">
      {/* Toast Notification Stack */}
      <div className="fixed top-5 right-5 z-50 flex flex-col gap-2 pointer-events-none max-w-sm w-full">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`pointer-events-auto flex items-start gap-3 p-3.5 rounded shadow-lg border backdrop-blur-md transition-all text-xs ${
              toast.type === 'success'
                ? 'bg-emerald-50/95 dark:bg-emerald-950/90 border-emerald-300 dark:border-emerald-800 text-emerald-900 dark:text-emerald-100'
                : toast.type === 'error'
                  ? 'bg-rose-50/95 dark:bg-rose-950/90 border-rose-300 dark:border-rose-800 text-rose-900 dark:text-rose-100'
                  : 'bg-zinc-50/95 dark:bg-zinc-900/90 border-zinc-300 dark:border-zinc-700 text-zinc-900 dark:text-zinc-100'
            }`}
          >
            {toast.type === 'success' && <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />}
            {toast.type === 'error' && <AlertTriangle className="h-4 w-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />}
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="font-mono font-bold">{toast.title}</span>
              <span className="text-zinc-600 dark:text-zinc-300 text-[11px] break-words">{toast.message}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Top Header with Breadcrumbs & Action Toolbar */}
      <div className="flex flex-col gap-4 border-b border-zinc-200 dark:border-zinc-800 pb-5 pt-2">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Link
                to="/export"
                className="inline-flex items-center gap-1 text-xs font-mono text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 transition"
                title="Return to Download & Export"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                <span>Download &amp; Export</span>
              </Link>
              <span className="text-zinc-300 dark:text-zinc-700">/</span>
              <span className="text-xs font-mono font-semibold text-emerald-600 dark:text-emerald-400">
                Check DB Health
              </span>
            </div>

            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="text-xl sm:text-2xl font-mono font-bold tracking-tight text-zinc-900 dark:text-zinc-50 flex items-center gap-2.5">
                <Database className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
                Database Health &amp; Completeness
              </h1>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase bg-emerald-100 dark:bg-emerald-950/80 text-emerald-800 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-800">
                openalex check-db
              </span>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-zinc-100 dark:bg-zinc-850 text-zinc-600 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-800">
                Project: {activeProject}
              </span>
            </div>

            <p className="text-xs text-zinc-500 dark:text-zinc-400 font-sans max-w-3xl">
              Relational completeness, entity normalization (ORCID, ROR), country/institution attribution breakdown, and bibliometric reach replicated directly from OpenAlex CLI.
            </p>
          </div>

          {/* Global Action Toolbar */}
          <div className="flex items-center gap-2 shrink-0 flex-wrap">
            {/* View Mode Switcher */}
            <div className="flex items-center rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-0.5 text-xs font-mono shadow-xs">
              <button
                type="button"
                onClick={() => setViewMode('visual')}
                className={`px-3 py-1 rounded transition cursor-pointer flex items-center gap-1.5 ${
                  viewMode === 'visual'
                    ? 'bg-zinc-100 dark:bg-zinc-800 font-bold text-zinc-900 dark:text-zinc-100 shadow-xs'
                    : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                }`}
              >
                <Layers className="h-3.5 w-3.5" />
                <span>Dashboard</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode('json')}
                className={`px-3 py-1 rounded transition cursor-pointer flex items-center gap-1.5 ${
                  viewMode === 'json'
                    ? 'bg-zinc-100 dark:bg-zinc-800 font-bold text-zinc-900 dark:text-zinc-100 shadow-xs'
                    : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                }`}
              >
                <FileCode className="h-3.5 w-3.5" />
                <span>Raw JSON</span>
              </button>
            </div>

            {/* Export Actions */}
            {result && (
              <button
                type="button"
                onClick={handleDownloadPDFReport}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono font-bold border border-emerald-500/40 bg-emerald-50 dark:bg-emerald-950/40 hover:bg-emerald-100 dark:hover:bg-emerald-900/60 text-emerald-800 dark:text-emerald-300 transition cursor-pointer shadow-xs"
                title="Download comprehensive PDF health report"
              >
                <Download className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                <span>PDF Report</span>
              </button>
            )}

            {/* Re-run Button */}
            <button
              type="button"
              onClick={() => runCheck()}
              disabled={checking}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-mono font-bold bg-emerald-600 hover:bg-emerald-500 text-white transition cursor-pointer shadow-xs disabled:opacity-50"
              title="Re-execute completeness verification queries"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${checking ? 'animate-spin' : ''}`} />
              <span>{checking ? 'Checking...' : 'Re-run'}</span>
            </button>
          </div>
        </div>

        {/* Database Selection Bar (Dropdown + Custom Path input) */}
        <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3 pt-1">
          <div className="flex items-center gap-2 flex-wrap">
            {/* Target DB Selector */}
            <div className="flex items-center gap-2 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-1.5 shadow-xs">
              <HardDrive className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
              <span className="text-[10px] font-mono font-bold uppercase text-zinc-400">Database:</span>
              <select
                value={selectedDB}
                onChange={(e) => {
                  const newDB = e.target.value
                  setSelectedDB(newDB)
                  runCheck(newDB)
                }}
                disabled={checking || loadingFiles}
                className="text-xs font-mono bg-transparent text-zinc-800 dark:text-zinc-200 focus:outline-none cursor-pointer max-w-xs truncate"
                title="Select database to audit"
              >
                {dbFiles.length > 0 && (
                  <optgroup label={`Active Project (${activeProject})`}>
                    {dbFiles.map((f) => (
                      <option key={f.path || f.name} value={f.name}>
                        {f.name} ({f.type}, {f.size_human})
                      </option>
                    ))}
                  </optgroup>
                )}
                {discoveredDBs.length > 0 && (
                  <optgroup label="Discovered Databases">
                    {discoveredDBs.map((d) => (
                      <option key={d.path} value={d.path}>
                        {d.name} ({d.source}, {d.size_human})
                      </option>
                    ))}
                  </optgroup>
                )}
                {dbFiles.length === 0 && discoveredDBs.length === 0 && (
                  <option value="">{loadingFiles ? 'Scanning databases...' : 'No databases detected'}</option>
                )}
              </select>
            </div>

            {/* Custom Path Input */}
            <form
              onSubmit={(e) => {
                e.preventDefault()
                if (customPathInput.trim()) {
                  setSelectedDB(customPathInput.trim())
                  runCheck(customPathInput.trim())
                }
              }}
              className="flex items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-2.5 py-1 shadow-xs"
            >
              <Search className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
              <input
                type="text"
                placeholder="Custom DB path (/path/to/db.duckdb)..."
                value={customPathInput}
                onChange={(e) => setCustomPathInput(e.target.value)}
                className="text-xs font-mono bg-transparent text-zinc-800 dark:text-zinc-200 focus:outline-none w-48 sm:w-64 placeholder:text-zinc-400"
              />
              <button
                type="submit"
                disabled={checking || !customPathInput.trim()}
                className="px-2.5 py-1 rounded text-[11px] font-mono font-bold bg-zinc-800 hover:bg-zinc-700 text-zinc-200 disabled:opacity-40 cursor-pointer transition shadow-xs"
              >
                Analyze
              </button>
            </form>
          </div>

          {/* Quick Discovered DB chips */}
          {discoveredDBs.length > 0 && (
            <div className="flex items-center gap-1.5 overflow-x-auto text-[11px] font-mono">
              <span className="text-zinc-400 shrink-0 flex items-center gap-1 text-[10px] uppercase font-bold">
                <FolderOpen className="h-3 w-3" /> Quick:
              </span>
              {discoveredDBs.slice(0, 3).map((d) => (
                <button
                  key={d.path}
                  type="button"
                  onClick={() => {
                    setSelectedDB(d.path)
                    runCheck(d.path)
                  }}
                  className={`px-2 py-0.5 rounded-md text-[10px] border transition cursor-pointer shrink-0 truncate max-w-[150px] ${
                    (selectedDB === d.path || result?.db_path === d.path)
                      ? 'bg-emerald-500/10 border-emerald-500 text-emerald-600 dark:text-emerald-400 font-bold'
                      : 'bg-zinc-50 dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:border-zinc-400'
                  }`}
                  title={`${d.source}: ${d.path}`}
                >
                  {d.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Main Content Area */}
      {checking && !result && (
        <div className="py-28 flex flex-col items-center justify-center gap-4 text-center border border-dashed border-zinc-200 dark:border-zinc-800 rounded-xl bg-zinc-50/50 dark:bg-zinc-900/20">
          <RefreshCw className="h-10 w-10 animate-spin text-emerald-500" />
          <div className="flex flex-col gap-1 max-w-md">
            <span className="font-mono text-base font-bold text-zinc-900 dark:text-zinc-100">
              Running Database Verification
            </span>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 font-sans leading-relaxed">
              Evaluating relational completeness, scanning paper-author junction tables, and computing institution/country attribution percentages...
            </p>
          </div>
        </div>
      )}

      {/* Error Alert */}
      {error && (
        <div className="p-4 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 flex items-start gap-3.5 shadow-sm">
          <AlertTriangle className="h-5 w-5 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
          <div className="flex flex-col gap-1 min-w-0 flex-1">
            <span className="font-mono text-xs font-bold text-rose-900 dark:text-rose-200">
              Check DB Verification Error
            </span>
            <p className="text-xs text-rose-700 dark:text-rose-300 font-sans leading-relaxed">
              {error}
            </p>
            <div className="pt-2 flex items-center gap-3">
              <button
                type="button"
                onClick={() => runCheck()}
                className="text-xs font-mono font-bold text-rose-800 dark:text-rose-300 hover:underline cursor-pointer"
              >
                Try Again
              </button>
              <Link
                to="/export"
                className="text-xs font-mono text-zinc-600 dark:text-zinc-400 hover:underline"
              >
                Go to Download &amp; Export →
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Empty State when no DB files and no result */}
      {!checking && !result && !error && dbFiles.length === 0 && (
        <div className="p-10 border border-dashed border-zinc-300 dark:border-zinc-800 rounded-xl flex flex-col items-center justify-center text-center gap-4 bg-zinc-50/50 dark:bg-zinc-900/20">
          <div className="p-3 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500">
            <HardDrive className="h-8 w-8" />
          </div>
          <div className="flex flex-col gap-1 max-w-md">
            <h3 className="font-mono font-bold text-base text-zinc-900 dark:text-zinc-100">
              No Databases Found in Active Project
            </h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 font-sans leading-relaxed">
              Project <span className="font-mono font-bold text-zinc-700 dark:text-zinc-300">"{activeProject}"</span> has no DuckDB or SQLite database generated yet. Ingest OpenAlex records and convert them to DuckDB in the Download &amp; Export page first.
            </p>
          </div>
          <Link
            to="/export"
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-mono text-xs font-bold transition shadow-sm"
          >
            <Download className="h-4 w-4" />
            <span>Go to Download &amp; Export</span>
          </Link>
        </div>
      )}

      {/* Result Display */}
      {result && (
        <>
          {viewMode === 'json' ? (
            /* Raw JSON View */
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono text-zinc-400 flex items-center gap-1.5">
                  <FileCode className="h-4 w-4 text-emerald-500" />
                  Structured JSON Health Response
                </span>
                <button
                  type="button"
                  onClick={handleCopyJson}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition cursor-pointer shadow-xs"
                >
                  {copiedJson ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                  <span>{copiedJson ? 'Copied JSON' : 'Copy JSON'}</span>
                </button>
              </div>
              <pre className="p-5 rounded-xl bg-zinc-950 text-zinc-100 font-mono text-xs overflow-x-auto border border-zinc-800 max-h-[700px] leading-relaxed shadow-inner">
                {JSON.stringify(result, null, 2)}
              </pre>
            </div>
          ) : (
            /* Visual Dashboard View */
            <div className="flex flex-col gap-8">
              {/* 1. Database Overview KPI Cards */}
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                    <Layers className="h-4 w-4 text-zinc-500" />
                    Database Relational Overview
                  </span>
                  {result.db_path && (
                    <span className="text-xs font-mono text-zinc-500 dark:text-zinc-400 truncate max-w-lg" title={result.db_path}>
                      Path: {result.db_path}
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3.5">
                  {/* Papers */}
                  <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/30 flex flex-col gap-1.5 shadow-xs">
                    <span className="text-[10px] font-mono uppercase font-bold text-zinc-400">Papers</span>
                    <span className="text-2xl font-mono font-bold text-zinc-900 dark:text-zinc-50">
                      {result.total.toLocaleString()}
                    </span>
                    <span className="text-[11px] font-mono text-zinc-500">
                      Years: {result.year_min} – {result.year_max}
                    </span>
                  </div>

                  {/* Authors */}
                  <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/30 flex flex-col gap-1.5 shadow-xs">
                    <span className="text-[10px] font-mono uppercase font-bold text-zinc-400">Authors</span>
                    <span className="text-2xl font-mono font-bold text-zinc-900 dark:text-zinc-50">
                      {result.author_count.toLocaleString()}
                    </span>
                    <span className="text-[11px] font-mono text-emerald-600 dark:text-emerald-400 font-semibold">
                      {result.authors_with_orcid.toLocaleString()} with ORCID ({((result.authors_with_orcid / (result.author_count || 1)) * 100).toFixed(1)}%)
                    </span>
                  </div>

                  {/* Institutions */}
                  <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/30 flex flex-col gap-1.5 shadow-xs">
                    <span className="text-[10px] font-mono uppercase font-bold text-zinc-400">Institutions</span>
                    <span className="text-2xl font-mono font-bold text-zinc-900 dark:text-zinc-50">
                      {result.inst_count.toLocaleString()}
                    </span>
                    <span className="text-[11px] font-mono text-blue-600 dark:text-blue-400 font-semibold">
                      {result.institutions_with_ror.toLocaleString()} with ROR ({((result.institutions_with_ror / (result.inst_count || 1)) * 100).toFixed(1)}%)
                    </span>
                  </div>

                  {/* Countries */}
                  <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/30 flex flex-col gap-1.5 shadow-xs">
                    <span className="text-[10px] font-mono uppercase font-bold text-zinc-400">Countries</span>
                    <span className="text-2xl font-mono font-bold text-zinc-900 dark:text-zinc-50">
                      {result.country_count.toLocaleString()}
                    </span>
                    <span className="text-[11px] font-mono text-zinc-500">ISO 3166-1 alpha-2</span>
                  </div>

                  {/* Contributions */}
                  <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/30 flex flex-col gap-1.5 shadow-xs">
                    <span className="text-[10px] font-mono uppercase font-bold text-zinc-400">Contributions</span>
                    <span className="text-2xl font-mono font-bold text-zinc-900 dark:text-zinc-50">
                      {result.contrib_count.toLocaleString()}
                    </span>
                    <span className="text-[11px] font-mono text-zinc-500">Junction table links</span>
                  </div>
                </div>
              </div>

              {/* 2. Data Completeness Section */}
              <div className="border border-zinc-200 dark:border-zinc-800 rounded-xl p-6 bg-white dark:bg-zinc-900/20 flex flex-col gap-5 shadow-xs">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-zinc-200 dark:border-zinc-800 pb-3">
                  <span className="text-sm font-mono font-bold uppercase tracking-wider text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                    <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                    Data Completeness
                  </span>
                  <span className="text-[11px] font-mono text-zinc-400">
                    Health benchmarks: <span className="text-emerald-600 font-bold">≥80% Optimal</span> ·{' '}
                    <span className="text-amber-500 font-bold">50–79% Moderate</span> ·{' '}
                    <span className="text-rose-500 font-bold">&lt;50% Sparse</span>
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                  {/* Left Column: Papers & Entity Normalization */}
                  <div className="flex flex-col gap-5">
                    <div className="flex flex-col gap-3">
                      <span className="text-xs font-mono font-bold uppercase tracking-wider text-zinc-800 dark:text-zinc-200 border-b border-zinc-100 dark:border-zinc-800/80 pb-1">
                        Papers Table
                      </span>
                      <div className="flex flex-col gap-3 text-xs font-mono">
                        {renderCompletenessRow('Abstract Text Present', result.with_abstract, result.total)}
                        {renderCompletenessRow('Country Info Assigned', result.with_country, result.total)}
                        {renderCompletenessRow('Institution Info Assigned', result.with_institution, result.total)}
                      </div>
                    </div>

                    <div className="flex flex-col gap-3">
                      <span className="text-xs font-mono font-bold uppercase tracking-wider text-zinc-800 dark:text-zinc-200 border-b border-zinc-100 dark:border-zinc-800/80 pb-1">
                        Authors Table
                      </span>
                      
                      <div className="flex flex-col gap-3 text-xs font-mono">
                        {renderCompletenessRow('Authors with ORCID', result.authors_with_orcid, result.author_count)}
                        {renderCompletenessRow('Institutions with ROR', result.institutions_with_ror, result.inst_count)}
                      </div>
                    </div>
                  </div>

                  {/* Right Column: Contributions Junction Table */}
                  <div className="flex flex-col gap-5 justify-between">
                    <div className="flex flex-col gap-3">
                      <span className="text-xs font-mono font-bold uppercase tracking-wider text-zinc-800 dark:text-zinc-200 border-b border-zinc-100 dark:border-zinc-800/80 pb-1">
                        Contributions Junction Table
                      </span>
                      <div className="flex flex-col gap-3 text-xs font-mono">
                        {renderCompletenessRow('Rows with Resolved Country', result.contrib_with_country, result.contrib_count)}
                        {renderCompletenessRow('Rows with Resolved Institution', result.contrib_with_institution, result.contrib_count)}
                        {renderCompletenessRow('Rows with Raw Affiliation String', result.contrib_with_raw_affiliation, result.contrib_count)}
                      </div>
                      <div className="flex flex-col gap-5"></div>
                      <div className="flex flex-col gap-3">
                      <span className="text-xs font-mono font-bold uppercase tracking-wider text-zinc-800 dark:text-zinc-200 border-b border-zinc-100 dark:border-zinc-800/80 pb-1">
                        Institutions Table
                      </span>
                      
                      <div className="flex flex-col gap-3 text-xs font-mono">
                       
                        {renderCompletenessRow('Institutions with ROR', result.institutions_with_ror, result.inst_count)}
                      </div>
                    </div>
                    </div>

                    <div className="p-4 rounded-lg bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200/80 dark:border-zinc-800/80 text-xs font-sans text-zinc-600 dark:text-zinc-400 leading-relaxed flex items-start gap-2.5">
                      <Info className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                      <div>
                        <span className="font-mono font-bold text-zinc-800 dark:text-zinc-200">Relational Significance: </span>
                        Contributions rows link author identities to their institutions. Raw affiliation strings provide the foundation for LLM and regex imputation pipelines when formal institution IDs are absent.
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* 3. Institution & Country Coverage Section */}
              <div className="border border-zinc-200 dark:border-zinc-800 rounded-xl p-6 bg-white dark:bg-zinc-900/20 flex flex-col gap-5 shadow-xs">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-zinc-200 dark:border-zinc-800 pb-3">
                  <span className="text-sm font-mono font-bold uppercase tracking-wider text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                    <Building2 className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                    Institution &amp; Country Coverage
                  </span>
                  <span className="text-[11px] font-mono text-zinc-400">
                    Author Attribution Bucketing
                  </span>
                </div>

                <p className="text-xs text-zinc-500 dark:text-zinc-400 font-sans leading-relaxed">
                  Every paper is bucketed by whether its co-authors' institutions/countries have been resolved:
                  <strong className="text-emerald-600 dark:text-emerald-400 ml-1">Full</strong> (every co-author matched),
                  <strong className="text-amber-500 dark:text-amber-400 ml-1">Partial</strong> (at least one matched, but some missing),
                  <strong className="text-rose-500 dark:text-rose-400 ml-1">Zero</strong> (no co-authors resolved).
                </p>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* By Institution */}
                  <div className="flex flex-col gap-3 p-4 rounded-xl bg-zinc-50/60 dark:bg-zinc-900/40 border border-zinc-200/80 dark:border-zinc-800/80">
                    <span className="text-xs font-mono font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
                      <Building2 className="h-4 w-4 text-zinc-500" />
                      By Institution Coverage
                    </span>
                    {(() => {
                      const total = result.total || 1
                      const zero = result.zero_total
                      const partial = result.partial_total
                      const full = Math.max(0, total - zero - partial)
                      return (
                        <div className="flex flex-col gap-2.5 text-xs font-mono pt-1">
                          {renderCoverageRow('Full (Every Author Matched)', full, total, 'emerald')}
                          {renderCoverageRow('Partial (Some Authors Missing)', partial, total, 'amber')}
                          {renderCoverageRow('Zero (No Authors Matched)', zero, total, 'rose')}
                        </div>
                      )
                    })()}
                  </div>

                  {/* By Country */}
                  <div className="flex flex-col gap-3 p-4 rounded-xl bg-zinc-50/60 dark:bg-zinc-900/40 border border-zinc-200/80 dark:border-zinc-800/80">
                    <span className="text-xs font-mono font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
                      <Globe className="h-4 w-4 text-zinc-500" />
                      By Country Coverage
                    </span>
                    {(() => {
                      const total = result.total || 1
                      const zero = result.zero_country_total
                      const partial = result.partial_country_total
                      const full = Math.max(0, total - zero - partial)
                      return (
                        <div className="flex flex-col gap-2.5 text-xs font-mono pt-1">
                          {renderCoverageRow('Full (Every Author Matched)', full, total, 'emerald')}
                          {renderCoverageRow('Partial (Some Authors Missing)', partial, total, 'amber')}
                          {renderCoverageRow('Zero (No Authors Matched)', zero, total, 'rose')}
                        </div>
                      )
                    })()}
                  </div>
                </div>
              </div>

             
              

               


              

              {/* 6. Influential Metrics Section */}
              <div className="border border-zinc-200 dark:border-zinc-800 rounded-xl p-6 bg-white dark:bg-zinc-900/20 flex flex-col gap-5 shadow-xs">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-zinc-200 dark:border-zinc-800 pb-3">
                  <div className="flex items-center gap-2">
                    <Award className="h-5 w-5 text-amber-500" />
                    <div>
                      <h2 className="text-sm font-mono font-bold uppercase tracking-wider text-zinc-900 dark:text-zinc-100">
                        Influential Metrics &amp; High-Impact Attribution
                      </h2>
                      <p className="text-[11px] text-zinc-500 dark:text-zinc-400 font-sans">
                        Completeness and institutional attribution across the corpus's highest-impact tiers
                      </p>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Top 10% Cited Tier */}
                  {(() => {
                    const total = result.total || 1
                    const top10 = result.top10_count || 0
                    const top10Pct = (top10 / total) * 100
                    const top10Denom = top10 || 1
                    const instCount = result.top10_with_institution || 0
                    const countryCount = result.top10_with_country || 0

                    return (
                      <div className="p-4 rounded-xl bg-zinc-50/60 dark:bg-zinc-900/40 border border-zinc-200/80 dark:border-zinc-800/80 flex flex-col gap-3">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-mono font-bold text-zinc-900 dark:text-zinc-100">
                            Top 10% Cited (Field-Normalized)
                          </span>
                          <span className="text-xs font-mono font-bold text-amber-600 dark:text-amber-400">
                            {top10.toLocaleString()} ({top10Pct.toFixed(1)}%)
                          </span>
                        </div>
                        <div className="w-full h-2 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
                          <div className="h-full bg-amber-500 rounded-full" style={{ width: `${Math.min(100, top10Pct)}%` }} />
                        </div>

                        <div className="mt-2 flex flex-col gap-2.5 text-xs font-mono pt-2 border-t border-zinc-200 dark:border-zinc-800">
                          <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider">
                            Coverage within Top 10% Tier:
                          </span>
                          {renderCompletenessRow('With Institution Info', instCount, top10Denom)}
                          {renderCompletenessRow('With Country Info', countryCount, top10Denom)}
                        </div>
                      </div>
                    )
                  })()}

                  {/* Top 1% Cited Tier */}
                  {(() => {
                    const total = result.total || 1
                    const top1 = result.top1_count || 0
                    const top1Pct = (top1 / total) * 100
                    const top1Denom = top1 || 1
                    const instCount = result.top1_with_institution || 0
                    const countryCount = result.top1_with_country || 0

                    return (
                      <div className="p-4 rounded-xl bg-zinc-50/60 dark:bg-zinc-900/40 border border-zinc-200/80 dark:border-zinc-800/80 flex flex-col gap-3">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-mono font-bold text-zinc-900 dark:text-zinc-100">
                            Top 1% Cited (Field-Normalized)
                          </span>
                          <span className="text-xs font-mono font-bold text-purple-600 dark:text-purple-400">
                            {top1.toLocaleString()} ({top1Pct.toFixed(1)}%)
                          </span>
                        </div>
                        <div className="w-full h-2 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
                          <div className="h-full bg-purple-500 rounded-full" style={{ width: `${Math.min(100, top1Pct)}%` }} />
                        </div>

                        <div className="mt-2 flex flex-col gap-2.5 text-xs font-mono pt-2 border-t border-zinc-200 dark:border-zinc-800">
                          <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider">
                            Coverage within Top 1% Tier:
                          </span>
                          {renderCompletenessRow('With Institution Info', instCount, top1Denom)}
                          {renderCompletenessRow('With Country Info', countryCount, top1Denom)}
                        </div>
                      </div>
                    )
                  })()}
                </div>
              </div>

             
              
             

              {/* Bottom Quick Links / Actions */}
              <div className="flex flex-col sm:flex-row items-center justify-between gap-4 p-5 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/30">
                <div className="flex items-center gap-3">
                  <Database className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                  <div className="flex flex-col">
                    <span className="text-xs font-mono font-bold text-zinc-800 dark:text-zinc-200">
                      Ready to query this database?
                    </span>
                    <span className="text-[11px] text-zinc-500 font-sans">
                      Execute analytical SQL queries directly in the browser using the DuckDB SQL Playground.
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <Link
                    to="/sql"
                    className="px-3.5 py-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-750 text-zinc-800 dark:text-zinc-200 font-mono text-xs font-semibold transition"
                  >
                    SQL Playground →
                  </Link>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
