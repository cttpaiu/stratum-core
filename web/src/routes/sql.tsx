// src/routes/sql.tsx
import { useState, useEffect, useCallback } from 'react'
import { useProject } from '../context/ProjectContext'
import {
  Play,
  Download,
  Database,
  ChevronRight,
  ChevronDown,
  Check,
  Loader2,
  AlertCircle,
  RefreshCw,
  FileText,
  Info,
} from 'lucide-react'
import { mockSchemas, mockQueries } from '../lib/mock-stratum'

export function Sql() {
  const { activeProject } = useProject()
  const [sqlText, setSqlText] = useState(mockQueries[0].sql)
  const [expandedTable, setExpandedTable] = useState<string | null>('papers')
  const [executing, setExecuting] = useState(false)
  const [hasExecuted, setHasExecuted] = useState(false)
  const [queryError, setQueryError] = useState<string | null>(null)
  const [executionTimeMs, setExecutionTimeMs] = useState<number | null>(null)

  // Dynamic query results state
  const [results, setResults] = useState<{
    columns: string[]
    rows: Record<string, string | number | boolean>[]
  }>({ columns: [], rows: [] })
  const [exporting, setExporting] = useState(false)
  const [exportSuccess, setExportSuccess] = useState(false)

  // Live database table row counts
  const [tableCounts, setTableCounts] = useState<Record<string, number>>({})
  const [loadingCounts, setLoadingCounts] = useState(false)

  // Import JSONL state
  const [importingJSONL, setImportingJSONL] = useState(false)
  const [importSuccessMessage, setImportSuccessMessage] = useState<string | null>(null)

  // Fetch live row counts for existing tables
  const fetchTableCounts = useCallback(async () => {
    setLoadingCounts(true)
    try {
      const query = `SELECT 'papers' as tbl, count(*) as c FROM papers
UNION ALL SELECT 'authors', count(*) FROM authors
UNION ALL SELECT 'institutions', count(*) FROM institutions
UNION ALL SELECT 'contributions', count(*) FROM contributions
UNION ALL SELECT 'countries', count(*) FROM countries;`

      const res = await fetch(`/api/query?project=${encodeURIComponent(activeProject)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      })
      if (res.ok) {
        const data = await res.json()
        if (Array.isArray(data)) {
          const counts: Record<string, number> = {}
          for (const row of data) {
            if (row.tbl) {
              counts[String(row.tbl)] = Number(row.c ?? 0)
            }
          }
          setTableCounts(counts)
        }
      }
    } catch {
      // Ignore background count fetch error
    } finally {
      setLoadingCounts(false)
    }
  }, [activeProject])

  useEffect(() => {
    fetchTableCounts()
  }, [fetchTableCounts])

  const handleRunQuery = async () => {
    if (!sqlText.trim()) return
    setExecuting(true)
    setQueryError(null)
    const startTime = performance.now()
    try {
      const response = await fetch(`/api/query?project=${encodeURIComponent(activeProject)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: sqlText }),
      })
      const data = await response.json()
      const elapsed = Math.round(performance.now() - startTime)
      setExecutionTimeMs(elapsed)

      if (!response.ok) {
        setQueryError(data.error || 'Query execution failed')
        setResults({ columns: [], rows: [] })
        setHasExecuted(true)
        return
      }

      const rows = (Array.isArray(data) ? data : []) as Record<string, string | number | boolean>[]
      const columns = rows.length > 0 ? Object.keys(rows[0]) : []
      setResults({ columns, rows })
      setHasExecuted(true)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setQueryError('Failed to connect to database: ' + msg)
      setResults({ columns: [], rows: [] })
      setHasExecuted(true)
    } finally {
      setExecuting(false)
    }
  }

  const handleImportJSONL = async () => {
    setImportingJSONL(true)
    setImportSuccessMessage(null)
    setQueryError(null)
    try {
      const res = await fetch(`/api/db/import-jsonl?project=${encodeURIComponent(activeProject)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || 'Import failed')
      }
      setImportSuccessMessage(
        `Successfully imported ${data.file} into DuckDB: ${data.papers.toLocaleString()} papers, ${data.authors.toLocaleString()} authors, ${data.contributions.toLocaleString()} contributions.`
      )
      // Refresh live table row counts
      await fetchTableCounts()
    } catch (err: unknown) {
      setQueryError(err instanceof Error ? err.message : String(err))
    } finally {
      setImportingJSONL(false)
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

      // Convert rows object array to CSV format
      const headers = columns.join(',')
      const csvLines = rows.map((row) =>
        columns
          .map((col) => {
            const val = row[col]
            return typeof val === 'string' ? `"${val.replace(/"/g, '""')}"` : val
          })
          .join(','),
      )
      const csvContent = [headers, ...csvLines].join('\n')

      // Create download link using Blob
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.setAttribute('download', `stratum_query_export_${Date.now()}.csv`)
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)

      setExporting(false)
      setExportSuccess(true)
      setTimeout(() => setExportSuccess(false), 3000)
    }, 500)
  }

  const handleQuerySelect = (querySql: string) => {
    setSqlText(querySql)
  }

  const toggleTable = (tableName: string) => {
    if (expandedTable === tableName) {
      setExpandedTable(null)
    } else {
      setExpandedTable(tableName)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      handleRunQuery()
    }
  }

  const totalPaperRows = tableCounts['papers'] ?? 0

  return (
    <div className="flex flex-col gap-8 w-full max-w-7xl mx-auto">
      {/* Header Row */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between border-b border-zinc-200 pb-5 dark:border-zinc-850 gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-mono font-bold tracking-tight text-zinc-950 dark:text-zinc-50 uppercase">
              SQL Explorer & Query Studio
            </h1>
            <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700">
              {activeProject}
            </span>
          </div>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Direct read-only SQL access to compiled relational paper and contribution tables in DuckDB.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={fetchTableCounts}
            disabled={loadingCounts}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-xs font-mono transition cursor-pointer"
            title="Refresh table row counts"
          >
            <RefreshCw className={`h-3 w-3 ${loadingCounts ? 'animate-spin' : ''}`} />
            <span>Refresh Schema</span>
          </button>
        </div>
      </div>

      {/* Empty Database Helper Banner */}
      {totalPaperRows === 0 && (
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-4 border border-amber-200 bg-amber-50/60 dark:border-amber-900/40 dark:bg-amber-950/20 text-amber-900 dark:text-amber-200 rounded text-xs font-mono">
          <div className="flex items-start gap-2.5">
            <Info className="h-4 w-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
            <div className="flex flex-col gap-0.5">
              <span className="font-bold uppercase tracking-wider">
                Relational tables for &quot;{activeProject}&quot; have 0 rows
              </span>
              <p className="font-sans text-[11px] text-amber-700 dark:text-amber-300/80 leading-relaxed">
                If you previously downloaded papers (JSONL), import them into DuckDB to query relational tables (papers, authors, contributions). You can also query JSONL files directly using DuckDB&apos;s <code>read_json_auto()</code>.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleImportJSONL}
            disabled={importingJSONL}
            className="px-3.5 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded font-mono text-[10px] font-bold uppercase tracking-wider shrink-0 cursor-pointer transition disabled:opacity-50 flex items-center gap-1.5 shadow-sm"
          >
            {importingJSONL ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                <span>Importing JSONL...</span>
              </>
            ) : (
              <>
                <FileText className="h-3 w-3" />
                <span>Import JSONL into DuckDB</span>
              </>
            )}
          </button>
        </div>
      )}

      {/* Success Notification */}
      {importSuccessMessage && (
        <div className="flex items-center gap-3 p-4 border border-emerald-200 bg-emerald-50/70 text-emerald-800 dark:border-emerald-800/40 dark:bg-emerald-950/30 dark:text-emerald-300 font-mono text-xs rounded">
          <Check className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <span>{importSuccessMessage}</span>
        </div>
      )}

      {exportSuccess && (
        <div className="flex items-center gap-3 p-4 border border-green-200 bg-green-50/50 text-green-700 dark:border-green-800/40 dark:bg-green-950/20 dark:text-green-400 font-mono text-xs rounded">
          <Check className="h-4 w-4 shrink-0" />
          <span>[SUCCESS] CSV file compiled. Browser download initiated.</span>
        </div>
      )}

      {/* Main Split-Pane */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 items-start">
        {/* Left Pane: Console Area */}
        <div className="lg:col-span-3 flex flex-col gap-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <span className="text-xs font-mono font-bold uppercase tracking-wider text-zinc-500">
              Query Console
            </span>
            <div className="flex items-center gap-2">
              <label htmlFor="query-select" className="sr-only">
                Pre-configured Query
              </label>
              <select
                id="query-select"
                onChange={(e) => handleQuerySelect(e.target.value)}
                className="bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 px-3 py-1.5 rounded font-mono text-[11px] text-zinc-600 dark:text-zinc-400 focus:outline-none cursor-pointer"
              >
                <option value="">-- Load Sample Query --</option>
                {mockQueries.map((q, idx) => (
                  <option key={idx} value={q.sql}>
                    {q.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="border border-zinc-200 dark:border-zinc-850 rounded overflow-hidden shadow-sm">
            <textarea
              aria-label="SQL Editor Console"
              value={sqlText}
              onChange={(e) => setSqlText(e.target.value)}
              onKeyDown={handleKeyDown}
              className="w-full h-64 p-4 font-mono text-xs bg-zinc-950 text-zinc-200 leading-relaxed focus:outline-none focus:ring-0 resize-y"
              spellCheck={false}
              placeholder="Write any valid DuckDB SQL statement (e.g. SELECT * FROM papers LIMIT 10;)"
            />
            {/* Control Bar */}
            <div className="bg-zinc-50 dark:bg-zinc-900/40 border-t border-zinc-200 dark:border-zinc-850 p-3 flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <button
                  onClick={handleRunQuery}
                  disabled={executing || !sqlText.trim()}
                  className="flex items-center gap-2 px-4 py-1.5 rounded font-mono text-xs font-bold uppercase tracking-wider select-none border transition-all cursor-pointer bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-950 border-zinc-800 dark:border-zinc-200 hover:bg-zinc-800 dark:hover:bg-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                >
                  {executing ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" />
                      <span>Executing...</span>
                    </>
                  ) : (
                    <>
                      <Play className="h-3 w-3 fill-current" />
                      <span>Run Query</span>
                    </>
                  )}
                </button>
                <span className="text-[10px] font-mono text-zinc-400 hidden sm:inline">
                  Ctrl+Enter
                </span>
              </div>

              <div className="flex items-center gap-3">
                {executionTimeMs !== null && (
                  <span className="text-[11px] font-mono text-zinc-400">
                    {executionTimeMs} ms
                  </span>
                )}
                <button
                  onClick={handleExportCSV}
                  disabled={exporting || results.rows.length === 0}
                  className="flex items-center gap-2 px-3 py-1.5 rounded border border-zinc-300 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-850 text-zinc-700 dark:text-zinc-300 transition text-xs font-mono select-none disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  {exporting ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>Compiling...</span>
                    </>
                  ) : (
                    <>
                      <Download className="h-3.5 w-3.5" />
                      <span>Export CSV</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>

          {/* Error Banner */}
          {queryError && (
            <div className="flex items-start gap-3 p-4 border border-red-200 bg-red-50/70 text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300 rounded font-mono text-xs">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-red-600 dark:text-red-400" />
              <div className="flex flex-col gap-1 w-full overflow-x-auto">
                <span className="font-bold uppercase tracking-wider text-[10px]">
                  Query Execution Error
                </span>
                <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-red-700 dark:text-red-300">
                  {queryError}
                </pre>
              </div>
            </div>
          )}
        </div>

        {/* Right Pane: Table Schema Reference */}
        <div className="lg:col-span-1 flex flex-col gap-4 border border-zinc-200 dark:border-zinc-850 bg-zinc-50/50 dark:bg-zinc-900/10 p-4 rounded overflow-y-auto max-h-[500px]">
          <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-850 pb-2.5">
            <div className="flex items-center gap-2">
              <Database className="h-3.5 w-3.5 text-zinc-400" />
              <span className="text-xs font-mono font-bold uppercase tracking-wider text-zinc-500">
                Database Schema
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-2.5">
            {mockSchemas.map((table) => {
              const rowCount = tableCounts[table.name]
              return (
                <div key={table.name} className="flex flex-col border-b border-zinc-100 dark:border-zinc-800/60 pb-2">
                  {/* Table Toggle Header */}
                  <button
                    type="button"
                    onClick={() => toggleTable(table.name)}
                    className="flex items-center justify-between w-full text-left font-mono text-xs font-bold hover:text-zinc-500 py-1 cursor-pointer"
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-zinc-800 dark:text-zinc-200 truncate">{table.name}</span>
                      {rowCount !== undefined && (
                        <span className={`text-[9px] font-mono px-1.5 py-0.2 rounded font-normal ${rowCount > 0 ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' : 'bg-zinc-100 text-zinc-400 dark:bg-zinc-800'}`}>
                          {rowCount.toLocaleString()}
                        </span>
                      )}
                    </div>
                    {expandedTable === table.name ? (
                      <ChevronDown className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                    )}
                  </button>

                  {/* Table Fields expanded panel */}
                  {expandedTable === table.name && (
                    <div className="pl-3 border-l border-zinc-200 dark:border-zinc-800 flex flex-col gap-1 mt-1 font-mono text-[10px]">
                      {table.fields.map((field) => (
                        <div
                          key={field.name}
                          className="flex flex-col py-0.5"
                          title={field.description}
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-zinc-700 dark:text-zinc-300 font-semibold">
                              {field.name}
                            </span>
                            <span className="text-zinc-400 uppercase text-[9px]">{field.type}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Query Results Section */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-mono font-bold uppercase tracking-wider text-zinc-500">
            Query Results {hasExecuted && `(${results.rows.length} rows returned)`}
          </span>
          {hasExecuted && results.rows.length > 0 && executionTimeMs !== null && (
            <span className="text-[10px] font-mono text-zinc-400">
              Completed in {executionTimeMs} ms
            </span>
          )}
        </div>

        {!hasExecuted ? (
          <div className="p-12 text-center flex flex-col items-center justify-center gap-2.5 text-zinc-400 font-mono text-xs border border-dashed border-zinc-200 dark:border-zinc-800 rounded bg-zinc-50/30 dark:bg-zinc-900/10">
            <Database className="h-8 w-8 text-zinc-300 dark:text-zinc-700" />
            <span className="font-bold uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
              Ready to Query
            </span>
            <span className="text-[11px] text-zinc-400 font-sans max-w-md">
              Click &quot;Run Query&quot; or press Ctrl+Enter to execute SQL statements directly against DuckDB for project <strong>{activeProject}</strong>.
            </span>
          </div>
        ) : results.rows.length === 0 ? (
          <div className="p-10 text-center flex flex-col items-center justify-center gap-2 text-zinc-400 font-mono text-xs border border-zinc-200 dark:border-zinc-850 rounded bg-zinc-50/50 dark:bg-zinc-900/10">
            <Database className="h-6 w-6 text-zinc-300 dark:text-zinc-600" />
            <span className="font-bold uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
              0 rows returned
            </span>
            <span className="text-[11px] text-zinc-400 font-sans max-w-md">
              The query executed successfully in {executionTimeMs} ms, but returned no matching records.
              {totalPaperRows === 0 && ' (Note: The database tables for this project are currently empty. If you downloaded papers as JSONL, click "Import JSONL into DuckDB" above to load them.)'}
            </span>
          </div>
        ) : (
          <div className="w-full overflow-x-auto border border-zinc-200 dark:border-zinc-850 rounded shadow-sm max-h-[600px] overflow-y-auto">
            <table className="w-full border-collapse text-left font-mono text-xs">
              <thead className="sticky top-0 bg-zinc-50 dark:bg-zinc-900 z-10">
                <tr className="border-b border-zinc-200 dark:border-zinc-850 text-zinc-500">
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
              <tbody>
                {results.rows.map((row, idx) => (
                  <tr
                    key={idx}
                    className="border-b border-zinc-100 dark:border-zinc-900 hover:bg-zinc-50/50 dark:hover:bg-zinc-900/20 transition-colors"
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
      </div>
    </div>
  )
}
export { Sql as default }
