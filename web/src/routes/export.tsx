import { useState, useEffect, useRef, useCallback } from 'react'
import { Link } from '@tanstack/react-router'
import {
  Download,
  FileText,
  Database,
  FileSpreadsheet,
  FolderArchive,
  Play,
  Square,
  RefreshCw,
  CheckCircle,
  AlertTriangle,
  Terminal,
  Layers,
  Copy,
  Check,
  Archive,
  HardDrive,
  FileCode,
  Sparkles,
  Info,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'
import { useProject } from '../context/ProjectContext'

export type { CheckDBData } from './check-db'

interface ImputeFileItem {
  name: string
  path: string
  size_bytes: number
  size_human: string
  mod_time: string
  is_imputed: boolean
}

interface CSVFileItem {
  name: string
  size_bytes: number
  size_human: string
  mod_time: string
}

interface CSVFolderItem {
  name: string
  path: string
  files: CSVFileItem[]
  total_size_bytes: number
  total_size_human: string
  mod_time: string
}

interface DuckDBFileItem {
  name: string
  path: string
  size_bytes: number
  size_human: string
  mod_time: string
}

interface SQLiteFileItem {
  name: string
  path: string
  size_bytes: number
  size_human: string
  mod_time: string
}

interface SQLFileItem {
  name: string
  path: string
  size_bytes: number
  size_human: string
  mod_time: string
}

interface ExportFilesResponse {
  project: string
  jsonl_files: ImputeFileItem[]
  csv_folders: CSVFolderItem[]
  duckdb_files: DuckDBFileItem[]
  sqlite_files: SQLiteFileItem[]
  sql_files: SQLFileItem[]
  last_status?: ExportStatus
  has_sqlitebrowser?: boolean
}

interface ExportStatus {
  running: boolean
  mode: string
  progress: number
  logs: string[]
  stats?: Record<string, string>
  output_files?: string[]
  csv_folder?: string
  duckdb_file?: string
  sqlite_file?: string
  sql_file?: string
  completed_at?: string
  error?: string
}

type ExportMode = 'pipeline' | 'jsonl-to-csv' | 'csv-to-sqlite' | 'csv-to-duckdb' | 'csv-to-sql'

interface Toast {
  id: string
  type: 'success' | 'error' | 'info'
  title: string
  message: string
}

export function Export() {
  const { activeProject } = useProject()

  // 1. Operational Mode
  const [mode, setMode] = useState<ExportMode>('pipeline')

  // 2. File State
  const [filesData, setFilesData] = useState<ExportFilesResponse>({
    project: activeProject || 'default',
    jsonl_files: [],
    csv_folders: [],
    duckdb_files: [],
    sqlite_files: [],
    sql_files: [],
  })
  const [loadingFiles, setLoadingFiles] = useState(false)

  // Form Inputs
  const [selectedJSONL, setSelectedJSONL] = useState('')
  const [csvFolderName, setCsvFolderName] = useState('openalex_csv')
  const [selectedCSVFolderForConversion, setSelectedCSVFolderForConversion] = useState('openalex_csv')
  const [sqliteName, setSqliteName] = useState(
    activeProject && activeProject !== 'default' ? `${activeProject}.db` : 'papers.db'
  )
  const [duckdbName, setDuckdbName] = useState(
    activeProject && activeProject !== 'default' ? `${activeProject}.duckdb` : 'papers.duckdb'
  )
  const [sqlName, setSqlName] = useState(
    activeProject && activeProject !== 'default' ? `${activeProject}_dump.sql` : 'papers_dump.sql'
  )
  const [createSQLite, setCreateSQLite] = useState(true)
  const [createDuckDB, setCreateDuckDB] = useState(true)
  const [createSQL, setCreateSQL] = useState(false)

  // 3. Execution & Diagnostics State
  const [exportRunning, setExportRunning] = useState(false)
  const [exportProgress, setExportProgress] = useState(0)
  const [exportLogs, setExportLogs] = useState<string[]>([])
  const [exportStats, setExportStats] = useState<Record<string, string>>({})
  const [exportOutputFiles, setExportOutputFiles] = useState<string[]>([])
  const [exportError, setExportError] = useState<string | null>(null)
  const [copiedLogs, setCopiedLogs] = useState(false)

  const logsEndRef = useRef<HTMLDivElement | null>(null)
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const [showOlderArchives, setShowOlderArchives] = useState(false)

  // 1. Target the last converted CSV folder
  const latestCSVFolder = (() => {
    if (exportOutputFiles.length > 0) {
      const match = filesData.csv_folders.find((f) => f.name === csvFolderName)
      if (match) return match
    }
    if (filesData.last_status?.csv_folder) {
      const match = filesData.csv_folders.find((f) => f.name === filesData.last_status?.csv_folder)
      if (match) return match
    }
    return filesData.csv_folders.length > 0 ? filesData.csv_folders[0] : null
  })()

  const olderCSVFolders = latestCSVFolder
    ? filesData.csv_folders.filter((f) => f.name !== latestCSVFolder.name)
    : []

  // 2. Target the last converted SQLite database (.db)
  const latestSQLiteFile = (() => {
    if (exportOutputFiles.length > 0) {
      const match = filesData.sqlite_files?.find((d) => d.name === sqliteName)
      if (match) return match
    }
    if (filesData.last_status?.sqlite_file) {
      const match = filesData.sqlite_files?.find((d) => d.name === filesData.last_status?.sqlite_file)
      if (match) return match
    }
    return filesData.sqlite_files && filesData.sqlite_files.length > 0 ? filesData.sqlite_files[0] : null
  })()

  const olderSQLiteFiles = latestSQLiteFile
    ? (filesData.sqlite_files || []).filter((d) => d.path !== latestSQLiteFile.path)
    : []

  // 3. Target the last converted DuckDB database
  const latestDuckDBFile = (() => {
    if (exportOutputFiles.length > 0) {
      const match = filesData.duckdb_files.find((d) => d.name === duckdbName)
      if (match) return match
    }
    if (filesData.last_status?.duckdb_file) {
      const match = filesData.duckdb_files.find((d) => d.name === filesData.last_status?.duckdb_file)
      if (match) return match
    }
    return filesData.duckdb_files.length > 0 ? filesData.duckdb_files[0] : null
  })()

  const olderDuckDBFiles = latestDuckDBFile
    ? filesData.duckdb_files.filter((d) => d.path !== latestDuckDBFile.path)
    : []

  // 4. Target the last converted SQL dump
  const latestSQLFile = (() => {
    if (exportOutputFiles.length > 0) {
      const match = filesData.sql_files.find((s) => s.name === sqlName)
      if (match) return match
    }
    if (filesData.last_status?.sql_file) {
      const match = filesData.sql_files.find((s) => s.name === filesData.last_status?.sql_file)
      if (match) return match
    }
    return filesData.sql_files.length > 0 ? filesData.sql_files[0] : null
  })()

  const olderSQLFiles = latestSQLFile
    ? filesData.sql_files.filter((s) => s.path !== latestSQLFile.path)
    : []

  const totalOlderCount = olderCSVFolders.length + olderSQLiteFiles.length + olderDuckDBFiles.length + olderSQLFiles.length

  // Toasts
  const [toasts, setToasts] = useState<Toast[]>([])

  const addToast = (type: 'success' | 'error' | 'info', title: string, message: string) => {
    const id = Math.random().toString(36).substring(2, 9)
    setToasts((prev) => [...prev, { id, type, title, message }])
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 6000)
  }

  // Update filenames when activeProject changes
  useEffect(() => {
    if (activeProject && activeProject !== 'default') {
      setSqliteName(`${activeProject}.db`)
      setDuckdbName(`${activeProject}.duckdb`)
      setSqlName(`${activeProject}_dump.sql`)
    } else {
      setSqliteName('papers.db')
      setDuckdbName('papers.duckdb')
      setSqlName('papers_dump.sql')
    }
  }, [activeProject])

  // Fetch available files for export and download
  const fetchFiles = useCallback(async () => {
    setLoadingFiles(true)
    try {
      const res = await fetch(`/api/export/files?project=${activeProject}`)
      if (res.ok) {
        const data: ExportFilesResponse = await res.json()
        setFilesData(data)

        // Auto-select latest JSONL file (preferring imputed)
        if (data.jsonl_files && data.jsonl_files.length > 0) {
          const imputed = data.jsonl_files.find((f) => f.is_imputed)
          const collected = data.jsonl_files.find((f) => f.name === 'collected_papers.jsonl')
          const chosen = imputed || collected || data.jsonl_files[0]
          setSelectedJSONL(chosen.name)
        }

        // Set default CSV folder if present
        if (data.csv_folders && data.csv_folders.length > 0) {
          setSelectedCSVFolderForConversion(data.csv_folders[0].name)
        }
      }
    } catch (err) {
      console.error('Failed to load export files:', err)
    } finally {
      setLoadingFiles(false)
    }
  }, [activeProject])

  useEffect(() => {
    fetchFiles()
  }, [fetchFiles])

  // Scroll to bottom of logs when updated
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [exportLogs])

  // Status Polling Loop
  useEffect(() => {
    if (!exportRunning) {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
      return
    }

    const poll = async () => {
      try {
        const res = await fetch(`/api/export/status?project=${activeProject}`)
        if (res.ok) {
          const status: ExportStatus = await res.json()
          setExportProgress(status.progress)
          setExportLogs(status.logs || [])
          if (status.stats) setExportStats(status.stats)
          if (status.output_files) setExportOutputFiles(status.output_files)
          if (status.error) setExportError(status.error)

          if (!status.running) {
            setExportRunning(false)
            if (pollIntervalRef.current) {
              clearInterval(pollIntervalRef.current)
              pollIntervalRef.current = null
            }
            if (status.error) {
              addToast('error', 'Export Failed', status.error)
            } else {
              addToast('success', 'Export Completed', 'Artifacts generated and ready for download.')
              fetchFiles()
            }
          }
        }
      } catch (err) {
        console.error('Failed to poll export status:', err)
      }
    }

    poll()
    pollIntervalRef.current = setInterval(poll, 1000)

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
    }
  }, [exportRunning, activeProject, fetchFiles])

  // Start Export Execution
  const handleStartExport = async () => {
    const targetFolder = mode === 'csv-to-duckdb' || mode === 'csv-to-sqlite' || mode === 'csv-to-sql' 
      ? selectedCSVFolderForConversion 
      : csvFolderName.trim() || 'openalex_csv'

    const reqBody = {
      mode,
      jsonl_path: selectedJSONL,
      csv_folder: targetFolder,
      sqlite_name: sqliteName.trim() || `${activeProject || 'papers'}.db`,
      duckdb_name: duckdbName.trim() || 'papers.duckdb',
      sql_name: sqlName.trim() || 'papers_dump.sql',
      create_sqlite: createSQLite,
      create_duckdb: createDuckDB,
      create_sql: createSQL,
    }

    setExportRunning(true)
    setExportProgress(5)
    setExportLogs([`[INFO] Initializing ${mode} export...`])
    setExportStats({})
    setExportOutputFiles([])
    setExportError(null)

    try {
      const res = await fetch(`/api/export/run?project=${activeProject}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
      })

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        const msg = errData.error || `HTTP ${res.status}: Failed to start export`
        setExportRunning(false)
        setExportError(msg)
        addToast('error', 'Failed to Start Export', msg)
      } else {
        addToast('info', 'Export Started', `Running mode: ${mode}`)
      }
    } catch (err) {
      setExportRunning(false)
      const msg = String(err)
      setExportError(msg)
      addToast('error', 'Connection Error', msg)
    }
  }

  // Cancel Export Execution
  const handleCancelExport = async () => {
    try {
      const res = await fetch(`/api/export/cancel?project=${activeProject}`, {
        method: 'POST',
      })
      if (res.ok) {
        addToast('info', 'Cancellation Requested', 'Stopping background export worker...')
      }
    } catch (err) {
      console.error('Failed to cancel export:', err)
    }
  }

  // Download Trigger Helpers
  const triggerDownload = (type: string, folder?: string, file?: string) => {
    let url = `/api/export/download?project=${encodeURIComponent(activeProject)}&type=${encodeURIComponent(type)}`
    if (folder) url += `&folder=${encodeURIComponent(folder)}`
    if (file) url += `&file=${encodeURIComponent(file)}`
    window.open(url, '_blank')
  }

  const handleCopyLogs = () => {
    if (exportLogs.length === 0) return
    navigator.clipboard.writeText(exportLogs.join('\n'))
    setCopiedLogs(true)
    setTimeout(() => setCopiedLogs(false), 2000)
  }

  return (
    <div className="flex flex-col gap-8 pb-16 w-full max-w-7xl mx-auto">
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
            {toast.type === 'success' && <CheckCircle className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />}
            {toast.type === 'error' && <AlertTriangle className="h-4 w-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />}
            {toast.type === 'info' && <Info className="h-4 w-4 text-zinc-600 dark:text-zinc-400 shrink-0 mt-0.5" />}
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="font-mono font-bold tracking-tight">{toast.title}</span>
              <span className="font-sans opacity-90 leading-tight break-words">{toast.message}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Page Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-zinc-200 dark:border-zinc-800 pb-5">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-mono font-bold tracking-tight uppercase text-zinc-900 dark:text-zinc-50 flex items-center gap-2.5">
              <Download className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
              Download & Export Studio
            </h1>
            <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase tracking-wider bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700">
              Project: {activeProject}
            </span>
          </div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 font-sans max-w-3xl leading-relaxed">
            Decompose JSONL publication records into 5 relational CSV files (<code>papers</code>, <code>authors</code>, <code>institutions</code>, <code>countries</code>, <code>contributions</code>), ingest into indexed DuckDB databases, generate SQL schema dumps, and download all artifacts.
          </p>
        </div>

        <div className="flex items-center gap-2.5 shrink-0 flex-wrap">
          <Link
            to="/check-db"
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded text-xs font-mono font-bold border border-emerald-500/50 dark:border-emerald-500/60 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/60 cursor-pointer transition shadow-sm"
            title="Open database completeness and health verification page (check-db)"
          >
            <Database className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
            <span>Check DB</span>
          </Link>

          <button
            type="button"
            onClick={fetchFiles}
            disabled={loadingFiles}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-mono font-bold border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-850 cursor-pointer transition shadow-sm"
            title="Scan project directory for changes"
          >
            <RefreshCw className={`h-3 w-3 ${loadingFiles ? 'animate-spin text-emerald-500' : ''}`} />
            <span>Refresh Files</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start w-full">
        {/* LEFT COLUMN: Operation Mode & Execution Configuration (cols: 6) */}
        <div className="lg:col-span-6 flex flex-col gap-6">
          {/* Mode Selector Tabs */}
          <div className="flex flex-col gap-2">
            <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-400">
              Select Operation Mode
            </span>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => setMode('pipeline')}
                disabled={exportRunning}
                className={`flex flex-col items-start p-3 rounded border text-left cursor-pointer transition ${
                  mode === 'pipeline'
                    ? 'border-emerald-500/80 bg-emerald-50/50 dark:bg-emerald-950/20 text-emerald-950 dark:text-emerald-100 shadow-sm'
                    : 'border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 hover:bg-zinc-50 dark:hover:bg-zinc-900 text-zinc-700 dark:text-zinc-300'
                }`}
              >
                <div className="flex items-center gap-1.5 font-mono text-xs font-bold">
                  <Sparkles className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                  <span>Full Pipeline</span>
                </div>
                <span className="text-[10px] text-zinc-500 dark:text-zinc-400 mt-1">
                  JSONL → 5 CSVs → SQLite (.db) + DuckDB
                </span>
              </button>

              <button
                type="button"
                onClick={() => setMode('jsonl-to-csv')}
                disabled={exportRunning}
                className={`flex flex-col items-start p-3 rounded border text-left cursor-pointer transition ${
                  mode === 'jsonl-to-csv'
                    ? 'border-emerald-500/80 bg-emerald-50/50 dark:bg-emerald-950/20 text-emerald-950 dark:text-emerald-100 shadow-sm'
                    : 'border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 hover:bg-zinc-50 dark:hover:bg-zinc-900 text-zinc-700 dark:text-zinc-300'
                }`}
              >
                <div className="flex items-center gap-1.5 font-mono text-xs font-bold">
                  <FileSpreadsheet className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
                  <span>JSONL → CSV</span>
                </div>
                <span className="text-[10px] text-zinc-500 dark:text-zinc-400 mt-1">
                  Decompose into 5 Relational CSVs
                </span>
              </button>

              <button
                type="button"
                onClick={() => setMode('csv-to-sqlite')}
                disabled={exportRunning}
                className={`flex flex-col items-start p-3 rounded border text-left cursor-pointer transition ${
                  mode === 'csv-to-sqlite'
                    ? 'border-emerald-500/80 bg-emerald-50/50 dark:bg-emerald-950/20 text-emerald-950 dark:text-emerald-100 shadow-sm'
                    : 'border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 hover:bg-zinc-50 dark:hover:bg-zinc-900 text-zinc-700 dark:text-zinc-300'
                }`}
              >
                <div className="flex items-center gap-1.5 font-mono text-xs font-bold">
                  <Database className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                  <span>CSV → SQLite (.db)</span>
                </div>
                <span className="text-[10px] text-zinc-500 dark:text-zinc-400 mt-1">
                  Compile for DB Browser / SQL Viewer
                </span>
              </button>

              <button
                type="button"
                onClick={() => setMode('csv-to-duckdb')}
                disabled={exportRunning}
                className={`flex flex-col items-start p-3 rounded border text-left cursor-pointer transition ${
                  mode === 'csv-to-duckdb'
                    ? 'border-emerald-500/80 bg-emerald-50/50 dark:bg-emerald-950/20 text-emerald-950 dark:text-emerald-100 shadow-sm'
                    : 'border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 hover:bg-zinc-50 dark:hover:bg-zinc-900 text-zinc-700 dark:text-zinc-300'
                }`}
              >
                <div className="flex items-center gap-1.5 font-mono text-xs font-bold">
                  <Database className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                  <span>CSV → DuckDB</span>
                </div>
                <span className="text-[10px] text-zinc-500 dark:text-zinc-400 mt-1">
                  Load CSVs into indexed DuckDB
                </span>
              </button>

              <button
                type="button"
                onClick={() => setMode('csv-to-sql')}
                disabled={exportRunning}
                className={`flex flex-col items-start p-3 rounded border text-left cursor-pointer transition ${
                  mode === 'csv-to-sql'
                    ? 'border-emerald-500/80 bg-emerald-50/50 dark:bg-emerald-950/20 text-emerald-950 dark:text-emerald-100 shadow-sm'
                    : 'border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 hover:bg-zinc-50 dark:hover:bg-zinc-900 text-zinc-700 dark:text-zinc-300'
                }`}
              >
                <div className="flex items-center gap-1.5 font-mono text-xs font-bold">
                  <FileCode className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400" />
                  <span>CSV → SQL Dump</span>
                </div>
                <span className="text-[10px] text-zinc-500 dark:text-zinc-400 mt-1">
                  Generate ANSI/DuckDB SQL file
                </span>
              </button>
            </div>
          </div>

          {/* Setup & Execution Card */}
          <div className="flex flex-col gap-4 border border-zinc-200 dark:border-zinc-800 p-5 rounded bg-white dark:bg-zinc-950/10 shadow-sm">
            <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 pb-2.5">
              <div className="flex items-center gap-2">
                <Layers className="h-4 w-4 text-zinc-900 dark:text-zinc-100" />
                <span className="text-xs font-mono font-bold uppercase text-zinc-900 dark:text-zinc-100">
                  Execution Parameters
                </span>
              </div>
              <span className="px-2 py-0.5 rounded text-[9px] font-mono font-bold uppercase bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700">
                json_to_csv.py
              </span>
            </div>

            {/* Input JSONL Selection (for pipeline and jsonl-to-csv) */}
            {(mode === 'pipeline' || mode === 'jsonl-to-csv') && (
              <div className="flex flex-col gap-2 p-3.5 rounded border border-zinc-200 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-900/40">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-500 flex items-center gap-1.5">
                    <FileText className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                    Source JSONL File
                  </span>
                  {selectedJSONL && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-mono font-bold uppercase bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 border border-emerald-300 dark:border-emerald-800">
                      <CheckCircle className="h-2.5 w-2.5" /> Auto-Selected
                    </span>
                  )}
                </div>

                <div className="flex items-center justify-between bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 px-3 py-2 rounded">
                  <div className="flex items-center gap-2 min-w-0">
                    <FileText className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    <span className="font-mono text-xs font-bold text-zinc-900 dark:text-zinc-100 truncate">
                      {selectedJSONL || 'No JSONL files found'}
                    </span>
                  </div>
                  <span className="text-[10px] font-mono text-zinc-400 shrink-0">
                    data/jsonl/
                  </span>
                </div>

                {filesData.jsonl_files.length > 1 && (
                  <div className="flex items-center justify-between pt-1 text-[10px] font-mono text-zinc-400">
                    <span>Select alternative JSONL:</span>
                    <select
                      value={selectedJSONL}
                      onChange={(e) => setSelectedJSONL(e.target.value)}
                      disabled={exportRunning}
                      className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 px-2 py-0.5 rounded text-[10px] font-mono text-zinc-700 dark:text-zinc-300 cursor-pointer max-w-[220px] truncate"
                    >
                      {filesData.jsonl_files.map((f) => (
                        <option key={f.name} value={f.name}>
                          {f.name} ({f.size_human}){f.is_imputed ? ' [Imputed]' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            )}

            {/* CSV Source Selection (for csv-to-duckdb, csv-to-sqlite, and csv-to-sql) */}
            {(mode === 'csv-to-duckdb' || mode === 'csv-to-sqlite' || mode === 'csv-to-sql') && (
              <div className="flex flex-col gap-2 p-3.5 rounded border border-zinc-200 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-900/40">
                <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-500 flex items-center gap-1.5">
                  <FileSpreadsheet className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
                  Source CSV Directory
                </span>
                {filesData.csv_folders.length > 0 ? (
                  <select
                    value={selectedCSVFolderForConversion}
                    onChange={(e) => setSelectedCSVFolderForConversion(e.target.value)}
                    disabled={exportRunning}
                    className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 px-3 py-2 rounded text-xs font-mono text-zinc-800 dark:text-zinc-200 cursor-pointer"
                  >
                    {filesData.csv_folders.map((folder) => (
                      <option key={folder.name} value={folder.name}>
                        {folder.name} ({folder.files.length} tables, {folder.total_size_human})
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="p-3 rounded border border-amber-200 dark:border-amber-900/50 bg-amber-50/60 dark:bg-amber-950/20 text-amber-800 dark:text-amber-300 text-xs font-mono">
                    No decomposed CSV folders found in <code>data/csv/</code>. Please run the JSONL → CSV mode first.
                  </div>
                )}
              </div>
            )}

            {/* Output CSV Directory Name (for pipeline and jsonl-to-csv) */}
            {(mode === 'pipeline' || mode === 'jsonl-to-csv') && (
              <div className="flex flex-col gap-1.5 p-3.5 rounded border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/30">
                <label className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">
                  Target CSV Folder Name:
                </label>
                <input
                  type="text"
                  value={csvFolderName}
                  onChange={(e) => setCsvFolderName(e.target.value)}
                  disabled={exportRunning}
                  placeholder="openalex_csv"
                  className="font-mono text-xs px-3 py-2 border border-zinc-200 dark:border-zinc-800 rounded bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-zinc-400"
                />
                <span className="text-[10px] font-mono text-zinc-400">
                  Will generate: <code>papers.csv</code>, <code>authors.csv</code>, <code>institutions.csv</code>, <code>countries.csv</code>, <code>contributions.csv</code>
                </span>
              </div>
            )}

            {/* SQLite Database Target (.db) */}
            {(mode === 'pipeline' || mode === 'csv-to-sqlite') && (
              <div className="flex flex-col gap-1.5 p-3.5 rounded border border-emerald-300 dark:border-emerald-800/80 bg-emerald-50/25 dark:bg-emerald-950/20">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] font-mono font-bold uppercase tracking-wider text-emerald-900 dark:text-emerald-300 flex items-center gap-1.5">
                    <Database className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                    <span>Target SQLite Database (.db):</span>
                  </label>
                  {mode === 'pipeline' && (
                    <label className="flex items-center gap-1.5 text-[10px] font-mono cursor-pointer select-none text-emerald-800 dark:text-emerald-300 font-semibold">
                      <input
                        type="checkbox"
                        checked={createSQLite}
                        onChange={(e) => setCreateSQLite(e.target.checked)}
                        disabled={exportRunning}
                        className="rounded text-emerald-600 focus:ring-emerald-500"
                      />
                      <span>Generate SQLite (.db)</span>
                    </label>
                  )}
                </div>
                <input
                  type="text"
                  value={sqliteName}
                  onChange={(e) => setSqliteName(e.target.value)}
                  disabled={exportRunning || (mode === 'pipeline' && !createSQLite)}
                  placeholder={`${activeProject || 'papers'}.db`}
                  className="font-mono text-xs px-3 py-2 border border-zinc-200 dark:border-zinc-800 rounded bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-emerald-500 disabled:opacity-50"
                />
                <span className="text-[10px] font-mono text-emerald-700 dark:text-emerald-400">
                  Location: <code>data/db/{sqliteName || `${activeProject || 'papers'}.db`}</code> • <strong>Compatible with DB Browser for SQLite, VS Code SQL Viewer, and DBeaver (no password required).</strong>
                </span>
              </div>
            )}

            {/* DuckDB Database Target Name */}
            {(mode === 'pipeline' || mode === 'csv-to-duckdb') && (
              <div className="flex flex-col gap-1.5 p-3.5 rounded border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/30">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-700 dark:text-zinc-300 flex items-center gap-1.5">
                    <Database className="h-3 w-3 text-amber-600" />
                    <span>Target DuckDB Database:</span>
                  </label>
                  {mode === 'pipeline' && (
                    <label className="flex items-center gap-1.5 text-[10px] font-mono cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={createDuckDB}
                        onChange={(e) => setCreateDuckDB(e.target.checked)}
                        disabled={exportRunning}
                        className="rounded"
                      />
                      <span>Enable DuckDB</span>
                    </label>
                  )}
                </div>
                <input
                  type="text"
                  value={duckdbName}
                  onChange={(e) => setDuckdbName(e.target.value)}
                  disabled={exportRunning || (mode === 'pipeline' && !createDuckDB)}
                  placeholder="papers.duckdb"
                  className="font-mono text-xs px-3 py-2 border border-zinc-200 dark:border-zinc-800 rounded bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-zinc-400 disabled:opacity-50"
                />
                <span className="text-[10px] font-mono text-zinc-400">
                  Location: <code>data/db/{duckdbName || 'papers.duckdb'}</code> (includes automated B-Tree indexes)
                </span>
              </div>
            )}

            {/* SQL Dump Target Name */}
            {(mode === 'pipeline' || mode === 'csv-to-sql') && (
              <div className="flex flex-col gap-1.5 p-3.5 rounded border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/30">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-700 dark:text-zinc-300 flex items-center gap-1.5">
                    <FileCode className="h-3 w-3 text-purple-600" />
                    <span>Target SQL Dump File:</span>
                  </label>
                  {mode === 'pipeline' && (
                    <label className="flex items-center gap-1.5 text-[10px] font-mono cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={createSQL}
                        onChange={(e) => setCreateSQL(e.target.checked)}
                        disabled={exportRunning}
                        className="rounded"
                      />
                      <span>Generate SQL</span>
                    </label>
                  )}
                </div>
                <input
                  type="text"
                  value={sqlName}
                  onChange={(e) => setSqlName(e.target.value)}
                  disabled={exportRunning || (mode === 'pipeline' && !createSQL)}
                  placeholder="papers_dump.sql"
                  className="font-mono text-xs px-3 py-2 border border-zinc-200 dark:border-zinc-800 rounded bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-zinc-400 disabled:opacity-50"
                />
                <span className="text-[10px] font-mono text-zinc-400">
                  Location: <code>data/sql/{sqlName || 'papers_dump.sql'}</code> (schema + insert statements)
                </span>
              </div>
            )}

            {/* Primary Action Button */}
            <div className="border-t border-zinc-200 dark:border-zinc-800 pt-3 flex gap-2">
              {exportRunning ? (
                <button
                  type="button"
                  onClick={handleCancelExport}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded font-mono text-xs font-bold uppercase border border-rose-300 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-400 hover:bg-rose-100 dark:hover:bg-rose-950/50 cursor-pointer transition shadow-sm animate-pulse"
                >
                  <Square className="h-3.5 w-3.5 fill-current" />
                  <span>Stop / Cancel Export</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleStartExport}
                  disabled={exportRunning || ((mode === 'pipeline' || mode === 'jsonl-to-csv') && !selectedJSONL)}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded font-mono text-xs font-bold uppercase bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-950 border-zinc-800 hover:bg-zinc-800 dark:hover:bg-zinc-200 disabled:opacity-50 cursor-pointer transition select-none shadow-sm"
                >
                  <Play className="h-3.5 w-3.5 fill-current" />
                  <span>Run Export ({mode})</span>
                </button>
              )}
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN: Artifact Download Vault & Architecture Guide (cols: 6) */}
        <div className="lg:col-span-6 flex flex-col gap-6">
          {/* Artifact Download Vault Card */}
          <div className="border border-zinc-200 dark:border-zinc-800 p-5 rounded bg-white dark:bg-zinc-950/10 shadow-sm flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 pb-2.5">
              <div className="flex items-center gap-2">
                <FolderArchive className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                <span className="text-xs font-mono font-bold uppercase tracking-wider text-zinc-900 dark:text-zinc-100">
                  Artifact Download Vault
                </span>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold uppercase bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 border border-emerald-300 dark:border-emerald-800">
                  Last Converted
                </span>
              </div>
              <span className="px-2 py-0.5 rounded text-[9px] font-mono font-bold uppercase bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700">
                1-Click Browser Downloads
              </span>
            </div>

            {/* CSV Bundles (Only Last Converted) */}
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-500 flex items-center gap-1.5">
                  <FileSpreadsheet className="h-3.5 w-3.5 text-blue-600" />
                  Relational CSV Exports (Last Converted)
                </span>
                {latestCSVFolder && (
                  <span className="text-[10px] font-mono text-zinc-400">
                    {latestCSVFolder.mod_time}
                  </span>
                )}
              </div>

              {!latestCSVFolder ? (
                <div className="p-3 rounded border border-dashed border-zinc-200 dark:border-zinc-800 text-center text-xs font-mono text-zinc-400">
                  No CSV folders converted yet. Run export to produce relational tables.
                </div>
              ) : (
                <div className="flex flex-col gap-2.5 p-3.5 rounded border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/30">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-2">
                      <FolderArchive className="h-4 w-4 text-amber-500 shrink-0" />
                      <span className="font-mono text-xs font-bold text-zinc-900 dark:text-zinc-100">
                        {latestCSVFolder.name}
                      </span>
                      <span className="text-[10px] font-mono text-zinc-400">
                        ({latestCSVFolder.total_size_human})
                      </span>
                    </div>

                    {/* 1-Click ZIP Download */}
                    <button
                      type="button"
                      onClick={() => triggerDownload('csv_zip', latestCSVFolder.name)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded font-mono text-[11px] font-bold uppercase bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer transition shadow-sm"
                      title="Download all 5 relational CSV files compressed as a single ZIP archive"
                    >
                      <Archive className="h-3.5 w-3.5" />
                      <span>Download All as ZIP</span>
                    </button>
                  </div>

                  {/* Individual CSV Table Badges */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pt-1">
                    {latestCSVFolder.files.map((file) => (
                      <button
                        key={file.name}
                        type="button"
                        onClick={() => triggerDownload('csv', latestCSVFolder.name, file.name)}
                        className="flex items-center justify-between px-2.5 py-1.5 rounded border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:border-emerald-500/60 dark:hover:border-emerald-500/60 text-left transition cursor-pointer group"
                        title={`Download ${file.name} (${file.size_human})`}
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <FileSpreadsheet className="h-3 w-3 text-zinc-400 group-hover:text-emerald-500 transition shrink-0" />
                          <span className="font-mono text-[10px] font-medium text-zinc-800 dark:text-zinc-200 truncate">
                            {file.name}
                          </span>
                        </div>
                        <span className="text-[9px] font-mono text-zinc-400 shrink-0 ml-1">
                          {file.size_human}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Databases & Dumps Vault (Only Last Converted) */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 border-t border-zinc-200 dark:border-zinc-800 pt-3">
              {/* SQLite Database (.db) - Primary for SQL Viewers */}
              <div className="flex flex-col gap-2 p-3 rounded border border-emerald-300 dark:border-emerald-800/80 bg-emerald-50/20 dark:bg-emerald-950/15">
                <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-emerald-800 dark:text-emerald-300 flex items-center gap-1">
                  <Database className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                  SQLite (.db) (Last Converted)
                </span>
                {!latestSQLiteFile ? (
                  <div className="p-2.5 rounded border border-dashed border-zinc-200 dark:border-zinc-800 text-[10px] font-mono text-zinc-400 text-center">
                    None converted yet
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => triggerDownload('sqlite', undefined, latestSQLiteFile.name)}
                    className="flex items-center justify-between p-2.5 rounded border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:border-emerald-500/60 dark:hover:border-emerald-500/60 hover:bg-zinc-50 dark:hover:bg-zinc-850 text-left cursor-pointer transition text-xs font-mono group mt-auto"
                    title={`Download ${latestSQLiteFile.name} (${latestSQLiteFile.size_human})`}
                  >
                    <div className="flex items-center gap-2 truncate">
                      <Database className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 group-hover:text-emerald-500 transition shrink-0" />
                      <span className="truncate font-bold text-zinc-800 dark:text-zinc-200">{latestSQLiteFile.name}</span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0 ml-1">
                      <span className="text-[10px] text-zinc-400">{latestSQLiteFile.size_human}</span>
                      <Download className="h-3 w-3 text-zinc-400 group-hover:text-emerald-500 transition" />
                    </div>
                  </button>
                )}
              </div>

              {/* DuckDB File */}
              <div className="flex flex-col gap-2 p-3 rounded border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/30">
                <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-500 flex items-center gap-1">
                  <Database className="h-3 w-3 text-amber-500" />
                  DuckDB Database (Last Converted)
                </span>
                {!latestDuckDBFile ? (
                  <div className="p-2.5 rounded border border-dashed border-zinc-200 dark:border-zinc-800 text-[10px] font-mono text-zinc-400 text-center">
                    None converted yet
                  </div>
                ) : (
                  <div className="flex flex-col gap-2 mt-auto">
                    <button
                      type="button"
                      onClick={() => triggerDownload('duckdb', undefined, latestDuckDBFile.name)}
                      className="flex items-center justify-between p-2.5 rounded border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:border-amber-500/60 dark:hover:border-amber-500/60 hover:bg-zinc-50 dark:hover:bg-zinc-850 text-left cursor-pointer transition text-xs font-mono group"
                      title={`Download ${latestDuckDBFile.name} (${latestDuckDBFile.size_human})`}
                    >
                      <div className="flex items-center gap-2 truncate">
                        <HardDrive className="h-3.5 w-3.5 text-amber-500 group-hover:text-amber-600 transition shrink-0" />
                        <span className="truncate font-bold text-zinc-800 dark:text-zinc-200">{latestDuckDBFile.name}</span>
                      </div>
                      <div className="flex items-center gap-1 shrink-0 ml-1">
                        <span className="text-[10px] text-zinc-400">{latestDuckDBFile.size_human}</span>
                        <Download className="h-3 w-3 text-zinc-400 group-hover:text-amber-600 transition" />
                      </div>
                    </button>
                    <Link
                      to="/check-db"
                      search={{ file: latestDuckDBFile.name }}
                      className="flex items-center justify-center gap-1.5 py-1.5 px-3 rounded border border-amber-500/40 dark:border-amber-500/50 bg-amber-50/70 dark:bg-amber-950/40 hover:bg-amber-100 dark:hover:bg-amber-900/60 text-amber-800 dark:text-amber-300 font-mono text-[11px] font-bold uppercase transition cursor-pointer shadow-xs"
                      title={`Open check-db health check page for ${latestDuckDBFile.name}`}
                    >
                      <Database className="h-3 w-3 text-amber-600 dark:text-amber-400" />
                      <span>Check DB Health</span>
                    </Link>
                  </div>
                )}
              </div>

              {/* SQL Dump File */}
              <div className="flex flex-col gap-2 p-3 rounded border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/30">
                <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-500 flex items-center gap-1">
                  <FileCode className="h-3 w-3 text-purple-500" />
                  SQL Dump (Last Converted)
                </span>
                {!latestSQLFile ? (
                  <div className="p-2.5 rounded border border-dashed border-zinc-200 dark:border-zinc-800 text-[10px] font-mono text-zinc-400 text-center">
                    None converted yet
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => triggerDownload('sql', undefined, latestSQLFile.name)}
                    className="flex items-center justify-between p-2.5 rounded border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:border-purple-500/60 dark:hover:border-purple-500/60 hover:bg-zinc-50 dark:hover:bg-zinc-850 text-left cursor-pointer transition text-xs font-mono group mt-auto"
                    title={`Download ${latestSQLFile.name} (${latestSQLFile.size_human})`}
                  >
                    <div className="flex items-center gap-2 truncate">
                      <FileCode className="h-3.5 w-3.5 text-purple-500 group-hover:text-purple-600 transition shrink-0" />
                      <span className="truncate font-bold text-zinc-800 dark:text-zinc-200">{latestSQLFile.name}</span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0 ml-2">
                      <span className="text-[10px] text-zinc-400">{latestSQLFile.size_human}</span>
                      <Download className="h-3 w-3 text-zinc-400 group-hover:text-purple-600 transition" />
                    </div>
                  </button>
                )}
              </div>
            </div>

            {/* Optional Collapsible for Previously Converted Archives */}
            {totalOlderCount > 0 && (
              <div className="border-t border-zinc-200 dark:border-zinc-800 pt-2 flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => setShowOlderArchives(!showOlderArchives)}
                  className="flex items-center justify-between px-2.5 py-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-900 text-[10px] font-mono text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 cursor-pointer transition"
                >
                  <span className="flex items-center gap-1.5">
                    <span>{showOlderArchives ? 'Hide previously converted items' : `Show previously converted items (${totalOlderCount} older item${totalOlderCount > 1 ? 's' : ''})`}</span>
                  </span>
                  {showOlderArchives ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                </button>

                {showOlderArchives && (
                  <div className="flex flex-col gap-3 p-3 rounded border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/30 text-xs font-mono">
                    {olderCSVFolders.length > 0 && (
                      <div className="flex flex-col gap-2">
                        <span className="text-[10px] uppercase font-bold text-zinc-500">Older CSV Folders:</span>
                        {olderCSVFolders.map((folder) => (
                          <div key={folder.name} className="flex items-center justify-between p-2 rounded bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
                            <div className="flex items-center gap-2 truncate">
                              <FolderArchive className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                              <span className="font-bold truncate">{folder.name}</span>
                              <span className="text-zinc-400 text-[10px] shrink-0">({folder.total_size_human}, {folder.mod_time})</span>
                            </div>
                            <button
                              type="button"
                              onClick={() => triggerDownload('csv_zip', folder.name)}
                              className="px-2.5 py-1 rounded bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-[10px] font-bold uppercase shrink-0 ml-2 cursor-pointer"
                            >
                              Download ZIP
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {olderSQLiteFiles.length > 0 && (
                      <div className="flex flex-col gap-2">
                        <span className="text-[10px] uppercase font-bold text-zinc-500">Older SQLite Databases (.db):</span>
                        {olderSQLiteFiles.map((db) => (
                          <button
                            key={db.path}
                            type="button"
                            onClick={() => triggerDownload('sqlite', undefined, db.name)}
                            className="flex items-center justify-between p-2 rounded bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-850 text-left cursor-pointer"
                          >
                            <span className="truncate">{db.name}</span>
                            <span className="text-zinc-400 text-[10px] shrink-0 ml-2">{db.size_human} ({db.mod_time})</span>
                          </button>
                        ))}
                      </div>
                    )}

                    {olderDuckDBFiles.length > 0 && (
                      <div className="flex flex-col gap-2">
                        <span className="text-[10px] uppercase font-bold text-zinc-500">Older DuckDB Databases:</span>
                        {olderDuckDBFiles.map((db) => (
                          <div
                            key={db.path}
                            className="flex items-center justify-between p-2 rounded bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800"
                          >
                            <div className="flex items-center gap-2 truncate min-w-0">
                              <Database className="h-3 w-3 text-amber-500 shrink-0" />
                              <span className="truncate font-medium">{db.name}</span>
                              <span className="text-zinc-400 text-[10px] shrink-0 ml-1">({db.size_human}, {db.mod_time})</span>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0 ml-2">
                              <Link
                                to="/check-db"
                                search={{ file: db.name }}
                                className="px-2 py-1 rounded border border-amber-500/40 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/50 text-[10px] font-mono font-bold uppercase cursor-pointer transition"
                                title={`Open check-db health check page for ${db.name}`}
                              >
                                Check DB
                              </Link>
                              <button
                                type="button"
                                onClick={() => triggerDownload('duckdb', undefined, db.name)}
                                className="px-2 py-1 rounded bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-[10px] font-bold uppercase cursor-pointer transition"
                              >
                                Download
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {olderSQLFiles.length > 0 && (
                      <div className="flex flex-col gap-2">
                        <span className="text-[10px] uppercase font-bold text-zinc-500">Older SQL Dumps:</span>
                        {olderSQLFiles.map((sql) => (
                          <button
                            key={sql.path}
                            type="button"
                            onClick={() => triggerDownload('sql', undefined, sql.name)}
                            className="flex items-center justify-between p-2 rounded bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-850 text-left cursor-pointer"
                          >
                            <span className="truncate">{sql.name}</span>
                            <span className="text-zinc-400 text-[10px] shrink-0 ml-2">{sql.size_human} ({sql.mod_time})</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Relational Schema Architecture Info Card */}
          <div className="border border-zinc-200 dark:border-zinc-800 p-5 rounded bg-white dark:bg-zinc-950/10 shadow-sm flex flex-col gap-3">
            <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 pb-2">
              <span className="text-xs font-mono font-bold uppercase tracking-wider text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                <Layers className="h-3.5 w-3.5 text-zinc-500" />
                Relational Decomposition Structure
              </span>
              <span className="text-[9px] font-mono text-zinc-400">5 Decomposed Tables</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] font-mono">
              <div className="p-2 rounded border border-zinc-200/70 dark:border-zinc-800 bg-zinc-50/40 dark:bg-zinc-900/20">
                <span className="font-bold text-zinc-800 dark:text-zinc-200">papers.csv</span>
                <p className="text-[10px] text-zinc-400 font-sans mt-0.5">
                  29 fields: DOI, title, abstract, dates, journal, OA metrics, FWCI, citation counts.
                </p>
              </div>
              <div className="p-2 rounded border border-zinc-200/70 dark:border-zinc-800 bg-zinc-50/40 dark:bg-zinc-900/20">
                <span className="font-bold text-zinc-800 dark:text-zinc-200">contributions.csv</span>
                <p className="text-[10px] text-zinc-400 font-sans mt-0.5">
                  Foreign key junction table linking paper_id, author_id, institution_id, country_code.
                </p>
              </div>
              <div className="p-2 rounded border border-zinc-200/70 dark:border-zinc-800 bg-zinc-50/40 dark:bg-zinc-900/20">
                <span className="font-bold text-zinc-800 dark:text-zinc-200">authors.csv</span>
                <p className="text-[10px] text-zinc-400 font-sans mt-0.5">
                  Author entity deduplication with OpenAlex ID, display name, and ORCID.
                </p>
              </div>
              <div className="p-2 rounded border border-zinc-200/70 dark:border-zinc-800 bg-zinc-50/40 dark:bg-zinc-900/20">
                <span className="font-bold text-zinc-800 dark:text-zinc-200">institutions.csv & countries.csv</span>
                <p className="text-[10px] text-zinc-400 font-sans mt-0.5">
                  Normalized institutions (ROR IDs, synthetic flags) and standardized ISO country entities.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* BOTTOM: Real-Time Diagnostics Console (cols: 12) - BELOW ALL */}
        <div className="lg:col-span-12 flex flex-col gap-4 border border-zinc-200 dark:border-zinc-800 p-5 rounded mt-2 w-full bg-white dark:bg-zinc-950/10 shadow-sm">
          <div className="flex justify-between items-center border-b border-zinc-200 dark:border-zinc-800 pb-3 flex-wrap gap-3">
            <div className="flex flex-col gap-1">
              <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-zinc-900 dark:text-zinc-50 flex items-center gap-2">
                <Terminal className="h-4 w-4 text-zinc-500" />
                Export Diagnostics & Progress Console
              </h3>
              <p className="text-[11px] text-zinc-400 font-sans">
                Real-time terminal stream, decomposition row counts, and indexing telemetry from <code>json_to_csv.py</code>.
              </p>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              {/* Status Badge */}
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[10px] font-mono font-bold uppercase border ${
                  exportRunning
                    ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-800 animate-pulse'
                    : exportProgress === 100
                      ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border-emerald-300 dark:border-emerald-800'
                      : exportError
                        ? 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-400 border-rose-300 dark:border-rose-800'
                        : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700'
                }`}
              >
                {exportRunning && <RefreshCw className="h-2.5 w-2.5 animate-spin" />}
                {exportRunning
                  ? `Running (${exportProgress}%)`
                  : exportProgress === 100
                    ? 'Completed (100%)'
                    : exportError
                      ? 'Error'
                      : 'Idle'}
              </span>

              {/* Copy Logs Button */}
              {exportLogs.length > 0 && (
                <button
                  type="button"
                  onClick={handleCopyLogs}
                  className="flex items-center gap-1 px-2.5 py-1 rounded font-mono text-[10px] font-bold uppercase border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer transition"
                >
                  {copiedLogs ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                  <span>{copiedLogs ? 'Copied' : 'Copy'}</span>
                </button>
              )}

              {/* Clear Logs Button */}
              {exportLogs.length > 0 && !exportRunning && (
                <button
                  type="button"
                  onClick={() => {
                    setExportLogs([])
                    setExportStats({})
                    setExportProgress(0)
                  }}
                  className="px-2.5 py-1 rounded font-mono text-[10px] font-bold uppercase border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 cursor-pointer transition"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Progress Bar */}
          <div className="w-full bg-zinc-100 dark:bg-zinc-900 h-2 rounded-full overflow-hidden border border-zinc-200 dark:border-zinc-800">
            <div
              className={`h-full transition-all duration-300 ${
                exportProgress === 100
                  ? 'bg-emerald-500'
                  : exportError
                    ? 'bg-rose-500'
                    : 'bg-emerald-600'
              }`}
              style={{ width: `${Math.max(exportProgress, exportRunning ? 10 : 0)}%` }}
            />
          </div>

          {/* Generated Artifacts Banner (when complete) */}
          {exportOutputFiles.length > 0 && exportProgress === 100 && (
            <div className="flex items-center gap-2 p-2.5 rounded border border-emerald-300 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/20 text-emerald-900 dark:text-emerald-200 text-xs font-mono">
              <CheckCircle className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <span className="font-bold">Generated Artifacts:</span>
              <div className="flex flex-wrap gap-1.5 items-center">
                {exportOutputFiles.map((file) => (
                  <span key={file} className="px-2 py-0.5 rounded bg-white dark:bg-zinc-900 border border-emerald-200 dark:border-emerald-800 text-[10px]">
                    {file}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Key Statistics Counters */}
          {Object.keys(exportStats).length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-2.5">
              {Object.entries(exportStats).map(([key, val]) => (
                <div
                  key={key}
                  className="flex flex-col p-2.5 rounded border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/30"
                >
                  <span className="text-[9px] font-mono uppercase tracking-wider text-zinc-400 truncate">
                    {key}
                  </span>
                  <span className="font-mono text-xs font-bold text-zinc-900 dark:text-zinc-100 mt-0.5 truncate">
                    {val}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Terminal Logs Output */}
          <div className="w-full h-80 bg-zinc-950 text-zinc-300 font-mono text-[11px] p-4 rounded border border-zinc-800 overflow-y-auto shadow-inner flex flex-col gap-1 select-text">
            {exportLogs.length === 0 ? (
              <div className="h-full flex items-center justify-center text-zinc-600 italic select-none">
                Ready to execute. Select mode and click "Run Export" to monitor live decomposition and database creation.
              </div>
            ) : (
              exportLogs.map((log, idx) => {
                let colorClass = 'text-zinc-300'
                if (log.includes('[ERROR]') || log.includes('✗')) {
                  colorClass = 'text-rose-400 font-bold'
                } else if (log.includes('[SUCCESS]') || log.includes('✓')) {
                  colorClass = 'text-emerald-400 font-bold'
                } else if (log.includes('[WARNING]') || log.includes('[CANCEL]')) {
                  colorClass = 'text-amber-400'
                } else if (log.includes('[INFO]')) {
                  colorClass = 'text-blue-400'
                }
                return (
                  <div key={idx} className={`leading-relaxed break-all ${colorClass}`}>
                    {log}
                  </div>
                )
              })
            )}
            <div ref={logsEndRef} />
          </div>
        </div>
      </div>
    </div>
  )
}
