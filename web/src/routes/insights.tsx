// src/routes/insights.tsx
import { useState, useEffect } from 'react'
import {
  TrendingUp,
  BarChart3,
  RefreshCw,
  Play,
  Download,
  AlertTriangle,
  FileSpreadsheet,
  Activity,
} from 'lucide-react'
import {
  BarLineChart,
  HBarChart,
  Panel,
  PanelHeader,
  Kpi,
  KpiGrid,
  ChartCard,
  T,
  type HRow,
} from '../lib/insights-charts'

interface CTTStatus {
  running: boolean
  progress: number
  logs: string[]
  stats?: Record<string, string>
  output_files?: Array<{
    name: string
    path: string
    category: string
    size_human: string
    mod_time: string
  }>
  output_dir?: string
  error?: string
}

export function Insights() {
  const [status, setStatus] = useState<CTTStatus | null>(null)
  const [starting, setStarting] = useState(false)
  const [activeTab, setActiveTab] = useState<'analytics' | 'ctt'>('analytics')

  // Sample data for initial analytics visualization using insights chart primitives
  const sampleLabels = ['2019', '2020', '2021', '2022', '2023', '2024']
  const sampleBars = [
    { name: 'Total Papers', color: T.bar, values: [120, 240, 450, 890, 1420, 1850] },
  ]
  const sampleLines = [
    { name: 'Top 1% Cited', color: T.amber, values: [12, 25, 58, 110, 195, 260], axis: 'right' as const },
  ]

  const sampleCountryRows: HRow[] = [
    {
      key: 'US',
      rank: 1,
      label: 'United States',
      segments: [{ value: 1420, color: T.bar }],
      right: '1,420 (28.3%)',
    },
    {
      key: 'CN',
      rank: 2,
      label: 'China',
      segments: [{ value: 1180, color: T.bar }],
      right: '1,180 (23.5%)',
    },
    {
      key: 'GB',
      rank: 3,
      label: 'United Kingdom',
      segments: [{ value: 520, color: T.bar }],
      right: '520 (10.4%)',
    },
    {
      key: 'DE',
      rank: 4,
      label: 'Germany',
      segments: [{ value: 410, color: T.bar }],
      right: '410 (8.2%)',
    },
    {
      key: 'IN',
      rank: 5,
      label: 'India',
      segments: [{ value: 385, color: T.orange }],
      right: '385 (7.7%)',
      highlight: true,
    },
    {
      key: 'JP',
      rank: 6,
      label: 'Japan',
      segments: [{ value: 310, color: T.bar }],
      right: '310 (6.2%)',
    },
    {
      key: 'CA',
      rank: 7,
      label: 'Canada',
      segments: [{ value: 290, color: T.bar }],
      right: '290 (5.8%)',
    },
    {
      key: 'FR',
      rank: 8,
      label: 'France',
      segments: [{ value: 245, color: T.bar }],
      right: '245 (4.9%)',
    },
  ]

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/ctt/status')
      if (res.ok) {
        const data = await res.json()
        setStatus(data)
      }
    } catch {
      // Background poll silently fails if offline
    }
  }

  useEffect(() => {
    fetchStatus()
    const timer = setInterval(fetchStatus, 4000)
    return () => clearInterval(timer)
  }, [])

  const handleRunCTT = async () => {
    try {
      setStarting(true)
      await fetch('/api/ctt/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input_dir: 'ctt_inputfiles',
          output_dir: 'ctt_outputs',
          country_file: 'Country_List_CTT_final.xlsx',
          workers: 4,
        }),
      })
      await fetchStatus()
    } catch (e) {
      console.error(e)
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="flex flex-col gap-6 w-full max-w-7xl mx-auto pb-16">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-zinc-200 dark:border-zinc-800 pb-5 pt-2">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 flex items-center justify-center border border-emerald-500/20">
              <TrendingUp className="h-4 w-4" />
            </div>
            <h1 className="text-xl sm:text-2xl font-mono font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
              Scientometric Insights &amp; CTT
            </h1>
          </div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 font-sans max-w-2xl">
            Critical Technology Tracker (CTT) analytics, international research share, and field-normalized bibliometric reach.
          </p>
        </div>

        {/* Navigation Tabs */}
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-0.5 text-xs font-mono">
            <button
              type="button"
              onClick={() => setActiveTab('analytics')}
              className={`px-3 py-1.5 rounded transition flex items-center gap-1.5 cursor-pointer ${
                activeTab === 'analytics'
                  ? 'bg-zinc-100 dark:bg-zinc-800 font-bold text-zinc-900 dark:text-zinc-100 shadow-xs'
                  : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
              }`}
            >
              <BarChart3 className="h-3.5 w-3.5" />
              <span>Visual Insights</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('ctt')}
              className={`px-3 py-1.5 rounded transition flex items-center gap-1.5 cursor-pointer ${
                activeTab === 'ctt'
                  ? 'bg-zinc-100 dark:bg-zinc-800 font-bold text-zinc-900 dark:text-zinc-100 shadow-xs'
                  : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
              }`}
            >
              <Activity className="h-3.5 w-3.5" />
              <span>CTT Pipeline {status?.running && '●'}</span>
            </button>
          </div>
        </div>
      </div>

      {activeTab === 'analytics' ? (
        <div className="flex flex-col gap-6">
          {/* KPI Strip */}
          <KpiGrid>
            <Kpi
              label="Global Output"
              value="5,015"
              note="Total publications analyzed"
            />
            <Kpi
              label="Leading Country"
              value="US (28.3%)"
              note="1,420 publications"
              tone="sky"
            />
            <Kpi
              label="Top 1% Tier"
              value="260"
              note="Highly cited breakthrough papers"
              tone="amber"
            />
            <Kpi
              label="Collaboration Rate"
              value="41.2%"
              note="Cross-border co-authorships"
              tone="emerald"
            />
          </KpiGrid>

          {/* Charts Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="flex flex-col gap-2">
              <span className="text-xs font-mono font-bold text-zinc-400 uppercase tracking-wider">
                Publication Growth &amp; High-Impact Output Over Time
              </span>
              <ChartCard>
                <BarLineChart
                  labels={sampleLabels}
                  bars={sampleBars}
                  lines={sampleLines}
                  leftTitle="Total Papers"
                  rightTitle="Top 1% Cited"
                  height={260}
                />
              </ChartCard>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-xs font-mono font-bold text-zinc-400 uppercase tracking-wider">
                Top Contributing Nations
              </span>
              <ChartCard>
                <HBarChart
                  rows={sampleCountryRows}
                  axisTitle="Publication Volume"
                />
              </ChartCard>
            </div>
          </div>
        </div>
      ) : (
        <Panel>
          <PanelHeader
            icon={<Activity className="h-4 w-4" />}
            title="Critical Technology Tracker (CTT) Execution"
            subtitle={status?.running ? 'Pipeline active...' : 'Standby / Ready to run'}
            right={
              <button
                type="button"
                onClick={handleRunCTT}
                disabled={starting || status?.running}
                className="px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-mono text-xs font-bold transition flex items-center gap-1.5 cursor-pointer"
              >
                {starting || status?.running ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5 fill-current" />
                )}
                <span>{status?.running ? 'CTT Running...' : 'Run CTT Script'}</span>
              </button>
            }
          />

          <div className="p-4 flex flex-col gap-4">
            {status?.error && (
              <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>{status.error}</span>
              </div>
            )}

            {/* Output files if generated */}
            {status?.output_files && status.output_files.length > 0 && (
              <div className="flex flex-col gap-2">
                <span className="text-xs font-mono font-bold text-zinc-400 uppercase tracking-wider">
                  Generated Output Workbooks ({status.output_files.length})
                </span>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {status.output_files.map((f) => (
                    <a
                      key={f.name}
                      href={`/api/ctt/download?file=${encodeURIComponent(f.name)}`}
                      className="p-3 rounded-lg border border-zinc-800 bg-zinc-900/40 hover:bg-zinc-800/60 flex items-center justify-between transition group"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <FileSpreadsheet className="h-4 w-4 text-emerald-400 shrink-0" />
                        <span className="text-xs font-mono text-zinc-200 truncate group-hover:text-emerald-400 transition">
                          {f.name}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-[10px] text-zinc-500 font-mono">{f.size_human}</span>
                        <Download className="h-3.5 w-3.5 text-zinc-400 group-hover:text-zinc-100" />
                      </div>
                    </a>
                  ))}
                </div>
              </div>
            )}

            {/* Live Terminal Log Output */}
            <div className="flex flex-col gap-1.5 mt-2">
              <span className="text-xs font-mono font-bold text-zinc-400 uppercase tracking-wider">
                Execution Logs
              </span>
              <div className="h-64 p-3 rounded-lg bg-black border border-zinc-800 font-mono text-[11px] text-zinc-300 overflow-y-auto flex flex-col gap-1 leading-relaxed">
                {status?.logs && status.logs.length > 0 ? (
                  status.logs.map((log, i) => (
                    <div key={i} className="text-zinc-400">
                      {log}
                    </div>
                  ))
                ) : (
                  <div className="text-zinc-600 italic">No execution logs yet. Click &quot;Run CTT Script&quot; to begin.</div>
                )}
              </div>
            </div>
          </div>
        </Panel>
      )}
    </div>
  )
}