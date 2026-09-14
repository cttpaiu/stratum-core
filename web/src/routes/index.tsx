// src/routes/index.tsx
import { useState, useEffect, useRef } from 'react'
import { useProject } from '../context/ProjectContext'
import {
  FileText,
  Users,
  Globe,
  Building2,
  Terminal,
  Play,
  Loader2,
  CheckCircle,
  Database,
  Download,
  Square,
} from 'lucide-react'
import { mockMetrics } from '../lib/mock-stratum'

interface TargetRowProps {
  name: string
  description: string
  metric: string
  status: 'ACTIVE_SYNC' | 'STABLE' | 'PENDING'
  tags: string[]
  icon: React.ReactNode
}

function TargetRow({ name, description, metric, status, tags, icon }: TargetRowProps) {
  const statusStyles = {
    ACTIVE_SYNC:
      'bg-green-50 text-green-700 border-green-200 dark:bg-green-950/20 dark:text-green-400 dark:border-green-800/40',
    STABLE:
      'bg-zinc-100 text-zinc-700 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700/60',
    PENDING:
      'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/20 dark:text-amber-400 dark:border-amber-800/40',
  }

  return (
    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between p-4 border border-zinc-200 dark:border-zinc-850 hover:bg-zinc-50 dark:hover:bg-zinc-900/20 transition-all font-mono text-xs">
      <div className="flex items-center gap-4 w-full sm:w-auto">
        <div className="h-8 w-8 rounded bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 flex items-center justify-center text-zinc-600 dark:text-zinc-400 shrink-0">
          {icon}
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="font-bold text-sm tracking-tight text-zinc-900 dark:text-zinc-100">
            {name}
          </span>
          <span className="text-zinc-500 dark:text-zinc-400 text-[11px] font-sans">
            {description}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-4 mt-3 sm:mt-0 w-full sm:w-auto justify-between sm:justify-end shrink-0">
        <div className="flex items-center gap-1.5">
          {tags.map((tag) => (
            <span
              key={tag}
              className="px-2 py-0.5 rounded-full border border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 text-[10px] uppercase font-semibold"
            >
              {tag}
            </span>
          ))}
        </div>
        <div className="w-24 text-right">
          <span className="font-mono font-bold text-base text-zinc-800 dark:text-zinc-200">
            {metric}
          </span>
        </div>
        <div className="w-28 text-right">
          <span
            className={`px-2.5 py-1 rounded border text-[9px] font-semibold uppercase tracking-wider ${statusStyles[status]}`}
          >
            {status}
          </span>
        </div>
      </div>
    </div>
  )
}

interface DashboardStats {
  total_papers: number
  total_institutions: number
  total_countries: number
  oa_status_counts: Array<{ status: string; count: number }>
}

export function Index() {
  const { activeProject } = useProject()
  const [syncing, setSyncing] = useState(false)
  const [progress, setProgress] = useState(0)
  const [logs, setLogs] = useState<string[]>([])
  const [stats, setStats] = useState<DashboardStats | null>(null)

  const [prevProject, setPrevProject] = useState(activeProject)
  if (activeProject !== prevProject) {
    setPrevProject(activeProject)
    setSyncing(false)
    setProgress(0)
    setLogs([])
    setStats(null)
  }

  const consoleBottomRef = useRef<HTMLDivElement | null>(null)

  // 1. Fetch Stats on Mount & Project Switch
  useEffect(() => {
    const fetchStats = async () => {
      try {
        const response = await fetch(`/api/stats?project=${activeProject}`)
        if (response.ok) {
          const data = await response.json()
          setStats(data)
        }
      } catch (err) {
        console.error('Failed to load statistics:', err)
      }
    }

    const checkInitialStatus = async () => {
      try {
        const response = await fetch(`/api/pipeline/status?project=${activeProject}`)
        if (response.ok) {
          const data = await response.json()
          setSyncing(data.syncing)
          setProgress(data.progress)
          setLogs(data.logs || [])
        }
      } catch (err) {
        console.error('Failed to load initial status:', err)
      }
    }

    fetchStats()
    checkInitialStatus()
  }, [activeProject])

  // 2. Poll Pipeline Status periodically when Syncing
  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null

    const checkStatus = async () => {
      try {
        const response = await fetch(`/api/pipeline/status?project=${activeProject}`)
        if (response.ok) {
          const data = await response.json()
          setSyncing(data.syncing)
          setProgress(data.progress)
          setLogs(data.logs || [])

          if (!data.syncing) {
            if (intervalId) clearInterval(intervalId)
            // Fetch updated stats after sync finishes
            const statsResp = await fetch(`/api/stats?project=${activeProject}`)
            if (statsResp.ok) {
              const statsData = await statsResp.json()
              setStats(statsData)
            }
          }
        }
      } catch (err) {
        console.error('Failed to poll status:', err)
      }
    }

    if (syncing) {
      intervalId = setInterval(checkStatus, 1000)
    } else {
      if (intervalId) clearInterval(intervalId)
    }

    return () => {
      if (intervalId) clearInterval(intervalId)
    }
  }, [syncing, activeProject])

  useEffect(() => {
    if (consoleBottomRef.current) {
      consoleBottomRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs])

  // 3. Trigger Async Ingest Pipeline
  const handleSyncToggle = async () => {
    if (syncing) {
      alert('Pipeline execution running in Go background thread. Waiting for completion.')
      return
    }

    setSyncing(true)
    setProgress(0)
    setLogs([
      '[' + new Date().toLocaleTimeString() + '] [INFO] Requesting pipeline sync from backend...',
    ])

    try {
      const response = await fetch(`/api/run-pipeline?project=${activeProject}`, { method: 'POST' })
      if (!response.ok) {
        const data = await response.json()
        alert(data.error || 'Failed to start pipeline')
        setSyncing(false)
      }
    } catch (err: unknown) {
      alert('Connection failed: ' + (err instanceof Error ? err.message : String(err)))
      setSyncing(false)
    }
  }

  const handleDownloadPapers = async () => {
    if (syncing) {
      alert('Pipeline or download execution running in Go background thread. Waiting for completion.')
      return
    }

    setSyncing(true)
    setProgress(0)
    setLogs([
      '[' + new Date().toLocaleTimeString() + '] [INFO] Initiating paper download (openalex download)...',
    ])

    try {
      const response = await fetch(`/api/download-papers?project=${activeProject}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ output: 'collected_papers.jsonl' }),
      })
      if (!response.ok) {
        const data = await response.json()
        alert(data.error || 'Failed to start download')
        setSyncing(false)
      }
    } catch (err: unknown) {
      alert('Connection failed: ' + (err instanceof Error ? err.message : String(err)))
      setSyncing(false)
    }
  }

  const handleCancelPipeline = async () => {
    try {
      await fetch(`/api/pipeline/cancel?project=${activeProject}`, { method: 'POST' })
    } catch (err) {
      console.error('Failed to cancel pipeline:', err)
    }
  }

  // Derive metrics
  const totalPapers = stats ? stats.total_papers : mockMetrics.totalPapers
  const imputedInstitutions = stats ? stats.total_institutions : mockMetrics.imputedInstitutions

  let oaCount = 0
  if (stats && stats.oa_status_counts) {
    stats.oa_status_counts.forEach((item: { status: string; count: number }) => {
      if (item.status !== 'closed' && item.status !== 'unknown') {
        oaCount += item.count
      }
    })
  } else {
    oaCount = mockMetrics.openAccessCount
  }
  const oaRatio = totalPapers > 0 ? Math.round((oaCount / totalPapers) * 100) : 0

  const pendingOrCountriesLabel = stats ? 'Total Countries' : 'Pending Imputations'
  const pendingOrCountriesVal = stats ? stats.total_countries : mockMetrics.unresolvedAffiliations

  return (
    <div className="flex flex-col gap-8 w-full">
      {/* Header Row */}
      <div className="flex flex-col gap-1 border-b border-zinc-200 pb-5 dark:border-zinc-850">
        <h1 className="text-2xl font-mono font-bold tracking-tight text-zinc-950 dark:text-zinc-50 uppercase">
          Data Management Overview
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Monitor dataset health coverage, ingest live pipelines, and manage the compiled analytical
          DuckDB database.
        </p>
      </div>

      {/* Aggregate Metric Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-4 border border-zinc-200 bg-zinc-50/50 rounded flex flex-col gap-1.5 dark:border-zinc-850 dark:bg-zinc-900/10">
          <div className="flex items-center justify-between text-zinc-400">
            <span className="text-[10px] font-mono font-bold uppercase tracking-wider">
              Total Papers
            </span>
            <FileText className="h-4 w-4" />
          </div>
          <span className="text-2xl font-mono font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
            {totalPapers.toLocaleString()}
          </span>
          <span className="text-[10px] text-zinc-400 font-sans">Collected from OpenAlex API</span>
        </div>

        <div className="p-4 border border-zinc-200 bg-zinc-50/50 rounded flex flex-col gap-1.5 dark:border-zinc-850 dark:bg-zinc-900/10">
          <div className="flex items-center justify-between text-zinc-400">
            <span className="text-[10px] font-mono font-bold uppercase tracking-wider">
              Open Access Ratio
            </span>
            <Globe className="h-4 w-4" />
          </div>
          <span className="text-2xl font-mono font-bold tracking-tight text-zinc-950 dark:text-zinc-50">
            {oaRatio}%
          </span>
          <span className="text-[10px] text-zinc-400 font-sans">
            {oaCount.toLocaleString()} index papers
          </span>
        </div>

        <div className="p-4 border border-zinc-200 bg-zinc-50/50 rounded flex flex-col gap-1.5 dark:border-zinc-850 dark:bg-zinc-900/10">
          <div className="flex items-center justify-between text-zinc-400">
            <span className="text-[10px] font-mono font-bold uppercase tracking-wider">
              Imputed Institutions
            </span>
            <Building2 className="h-4 w-4" />
          </div>
          <span className="text-2xl font-mono font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
            {imputedInstitutions.toLocaleString()}
          </span>
          <span className="text-[10px] text-zinc-400 font-sans">Resolved via LLM/Crossref</span>
        </div>

        <div className="p-4 border border-zinc-200 bg-zinc-50/50 rounded flex flex-col gap-1.5 dark:border-zinc-850 dark:bg-zinc-900/10">
          <div className="flex items-center justify-between text-zinc-400">
            <span className="text-[10px] font-mono font-bold uppercase tracking-wider">
              {pendingOrCountriesLabel}
            </span>
            <Users className="h-4 w-4" />
          </div>
          <span className="text-2xl font-mono font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
            {pendingOrCountriesVal.toLocaleString()}
          </span>
          <span className="text-[10px] text-zinc-400 font-sans">
            {stats ? 'Unique countries matched' : 'Requires further execution cycles'}
          </span>
        </div>
      </div>

      {/* PostHog Style Rows */}
      <div className="flex flex-col gap-3">
        <h2 className="text-xs font-mono font-bold uppercase tracking-wider text-zinc-500">
          Data Stream Indicators
        </h2>
        <div className="flex flex-col border-t border-zinc-200 dark:border-zinc-850">
          <TargetRow
            name="OpenAlex_Works_Download"
            description="Incoming JSONL publication items downloaded via OpenAlex API and stored locally."
            metric="JSONL Files"
            status="STABLE"
            tags={['API', 'JSONL']}
            icon={<FileText className="h-4 w-4" />}
          />
          <TargetRow
            name="Imputed_Affiliations"
            description="Pipeline mapping unresolved affiliation strings to synthetic/ROR institution profiles."
            metric="DuckDB Table"
            status={syncing ? 'ACTIVE_SYNC' : 'STABLE'}
            tags={['LLM', 'CROSSREF']}
            icon={<ShuffleIcon />}
          />
          <TargetRow
            name="DuckDB_Analytical_Schema"
            description="Integrated relational tables providing microsecond SQL query execution."
            metric="DuckDB Database"
            status="STABLE"
            tags={['SQL', 'DB']}
            icon={<Database className="h-4 w-4" />}
          />
        </div>
      </div>

      {/* Simulator console */}
      <div className="border border-zinc-200 dark:border-zinc-850 rounded overflow-hidden">
        {/* Console Header */}
        <div className="bg-zinc-50 dark:bg-zinc-900/40 p-4 border-b border-zinc-200 dark:border-zinc-850 flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-zinc-400" />
            <span className="text-xs font-mono font-bold uppercase tracking-wide">
              Sync Diagnostics Console
            </span>
          </div>

          <div className="flex items-center gap-2">
            {syncing ? (
              <button
                onClick={handleCancelPipeline}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded font-mono text-xs select-none border border-rose-300 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-400 hover:bg-rose-100 dark:hover:bg-rose-950/50 cursor-pointer transition shadow-sm"
                title="Stop / Cancel running pipeline"
              >
                <Square className="h-3 w-3 fill-current" />
                <span>Stop Pipeline</span>
              </button>
            ) : (
              <button
                onClick={handleDownloadPapers}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded font-mono text-xs select-none border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-850 cursor-pointer shadow-sm transition"
                title="Download all papers to JSONL (openalex download)"
              >
                <Download className="h-3 w-3" />
                <span>Download Papers</span>
              </button>
            )}

            <button
              onClick={handleSyncToggle}
              className={`flex items-center gap-2 px-3 py-1.5 rounded font-mono text-xs select-none border transition-all ${
                syncing
                  ? 'bg-zinc-200 dark:bg-zinc-800 border-zinc-300 dark:border-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-700 cursor-not-allowed'
                  : 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-950 border-zinc-800 dark:border-zinc-200 hover:bg-zinc-800 dark:hover:bg-zinc-200 cursor-pointer'
              }`}
            >
              {syncing ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>Syncing Pipeline...</span>
                </>
              ) : (
                <>
                  <Play className="h-3 w-3 fill-current" />
                  <span>Run OpenAlex Sync</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Console Progress Bar */}
        {(syncing || progress > 0) && (
          <div className="h-1.5 w-full bg-zinc-100 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-850">
            <div
              className="h-full bg-zinc-900 dark:bg-zinc-100 transition-all duration-300 ease-out"
              style={{ width: `${Math.min(progress, 100)}%` }}
            ></div>
          </div>
        )}

        {/* Console Terminal Screen */}
        <div className="bg-zinc-950 text-zinc-300 p-4 h-64 overflow-y-auto font-mono text-[11px] leading-relaxed flex flex-col gap-1 border-t-0 select-text">
          {logs.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-zinc-600 select-none">
              <span>Diagnostics Console Idle. Click \"Run OpenAlex Sync\" to initiate.</span>
            </div>
          ) : (
            <>
              {logs.map((log, index) => (
                <div
                  key={index}
                  className={
                    log.includes('[SUCCESS]')
                      ? 'text-green-400'
                      : log.includes('[ERROR]')
                        ? 'text-red-400'
                        : ''
                  }
                >
                  {log}
                </div>
              ))}
              {progress >= 100 && (
                <div className="text-green-400 font-bold flex items-center gap-1.5 mt-1">
                  <CheckCircle className="h-3 w-3" />
                  <span>[SUCCESS] Database sync completed successfully. All services ready.</span>
                </div>
              )}
              <div ref={consoleBottomRef}></div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// Simple shuffle representation SVG
function ShuffleIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M16 3h5v5" />
      <path d="M4 20L21 3" />
      <path d="M21 16v5h-5" />
      <path d="M15 15l6 6" />
      <path d="M4 4l5 5" />
    </svg>
  )
}
