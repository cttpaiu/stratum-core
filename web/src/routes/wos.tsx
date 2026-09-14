// src/routes/wos.tsx
import { useRef, useState } from 'react'
import { Upload, Play, Terminal, Database, Key, Loader2, CheckCircle2, XCircle } from 'lucide-react'

/**
 * ASSUMPTIONS — adjust to match your real Go backend:
 *
 * 1. POST /api/wos/import
 *    - multipart/form-data: file, doiColumn, authorColumn
 *    - response JSON: { catalogId: string, recordCount: number }
 *
 * 2. POST /api/wos/impute
 *    - JSON body: { catalogId, provider, model, apiKey?, ollamaUrl? }
 *    - response: newline-delimited JSON (NDJSON) stream, each line like:
 *      { "level": "info" | "error" | "done", "message": string }
 *      Read as a stream so logs appear incrementally. If your Go server
 *      just returns a single JSON blob instead of streaming, swap
 *      handleRunImputation's reader loop for a plain `await res.json()`.
 *
 * 3. Spreadsheet parsing uses the `xlsx` (SheetJS) package for .xls/.xlsx.
 *    Install if missing: npm install xlsx
 *
 * 4. WoS Plain Text (.txt) exports use two-letter field tags (DI = DOI,
 *    AU = Authors) rather than columns, so there's no column mapping step
 *    for that format — doiColumn/authorColumn are auto-set to 'DI'/'AU'.
 */

type LogLevel = 'info' | 'error' | 'done'
type LogEntry = { time: string; level: LogLevel; message: string }
type Status = 'standby' | 'parsing' | 'importing' | 'imported' | 'running' | 'done' | 'error'

const NO_COLUMNS_FORMATS = ['txt']

export function Wos() {
  const [imputeProvider, setImputeProvider] = useState<'gemini' | 'ollama'>('gemini')
  const [modelName, setModelName] = useState('gemini-1.5-flash')
  const [apiKey, setApiKey] = useState('')
  const [ollamaURL, setOllamaURL] = useState('http://localhost:11434')

  const [file, setFile] = useState<File | null>(null)
  const [headers, setHeaders] = useState<string[]>([])
  const [doiColumn, setDoiColumn] = useState('')
  const [authorColumn, setAuthorColumn] = useState('')
  const [catalogId, setCatalogId] = useState<string | null>(null)

  const [status, setStatus] = useState<Status>('standby')
  const [logs, setLogs] = useState<LogEntry[]>([
    { time: new Date().toLocaleTimeString(), level: 'info', message: 'Ready for WoS data import and imputation.' },
    { time: new Date().toLocaleTimeString(), level: 'info', message: 'Stage a Web of Science export catalog to trigger diagnostics checking.' },
  ])

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDragging, setIsDragging] = useState(false)

  function log(level: LogLevel, message: string) {
    setLogs((prev) => [...prev, { time: new Date().toLocaleTimeString(), level, message }])
  }

  function extOf(name: string) {
    return name.split('.').pop()?.toLowerCase() ?? ''
  }

  async function parseFile(f: File) {
    setStatus('parsing')
    setFile(f)
    setHeaders([])
    setDoiColumn('')
    setAuthorColumn('')
    setCatalogId(null)
    log('info', `Selected file: ${f.name} (${(f.size / 1024).toFixed(1)} KB)`)

    const ext = extOf(f.name)

    try {
      if (ext === 'csv') {
        const text = await f.text()
        const firstLine = text.split(/\r?\n/)[0] ?? ''
        const cols = firstLine.split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
        setHeaders(cols)
        log('info', `Parsed CSV header row: ${cols.length} columns detected.`)
      } else if (ext === 'xlsx' || ext === 'xls') {
        const XLSX = await import('xlsx')
        const buf = await f.arrayBuffer()
        const wb = XLSX.read(buf, { type: 'array' })
        const sheetName = wb.SheetNames[0]
        const sheet = wb.Sheets[sheetName]
        const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, range: 0 })
        const cols = ((rows[0] as unknown[]) ?? []).map((c) => String(c ?? '').trim())
        setHeaders(cols)
        log('info', `Parsed sheet "${sheetName}": ${cols.length} columns detected.`)
      } else if (ext === 'txt') {
        // WoS Plain Text: tag-based, not columnar. Auto-map known tags.
        setDoiColumn('DI')
        setAuthorColumn('AU')
        const text = await f.text()
        const recordCount = (text.match(/^ER\s*$/gm) ?? []).length
        log('info', `Parsed WoS Plain Text export: ~${recordCount} record(s) found (DI/AU tags auto-mapped).`)
      } else {
        throw new Error(`Unsupported file type: .${ext}`)
      }
      setStatus('standby')
    } catch (err) {
      setStatus('error')
      log('error', `Failed to parse file: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function onFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (f) parseFile(f)
    e.target.value = '' // allow re-selecting the same file
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setIsDragging(false)
    const f = e.dataTransfer.files?.[0]
    if (f) parseFile(f)
  }

  const usesColumns = file ? !NO_COLUMNS_FORMATS.includes(extOf(file.name)) : true
  const canImport = !!file && (!usesColumns || (!!doiColumn && !!authorColumn)) && status !== 'importing' && status !== 'parsing'

  async function handleImport() {
    if (!file) return
    setStatus('importing')
    log('info', `Importing catalog "${file.name}"...`)

    try {
      const form = new FormData()
      form.append('file', file)
      form.append('doiColumn', doiColumn)
      form.append('authorColumn', authorColumn)

      const res = await fetch('/api/wos/import', { method: 'POST', body: form })
      if (!res.ok) throw new Error(`Import failed: HTTP ${res.status}`)
      const data = await res.json() as { catalogId: string; recordCount: number }

      setCatalogId(data.catalogId)
      setStatus('imported')
      log('info', `Imported ${data.recordCount} record(s). Catalog ID: ${data.catalogId}`)
    } catch (err) {
      setStatus('error')
      log('error', `Import error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const providerConfigured =
    imputeProvider === 'gemini' ? apiKey.trim().length > 0 : ollamaURL.trim().length > 0

  const canRunImputation = !!catalogId && providerConfigured && status !== 'running'

  async function handleRunImputation() {
    if (!catalogId) return
    setStatus('running')
    log('info', `Starting imputation pipeline (${imputeProvider} / ${modelName})...`)

    try {
      const res = await fetch('/api/wos/impute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          catalogId,
          provider: imputeProvider,
          model: modelName,
          apiKey: imputeProvider === 'gemini' ? apiKey : undefined,
          ollamaUrl: imputeProvider === 'ollama' ? ollamaURL : undefined,
        }),
      })
      if (!res.ok || !res.body) throw new Error(`Imputation failed: HTTP ${res.status}`)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const parsed = JSON.parse(line) as { level: LogLevel; message: string }
            log(parsed.level, parsed.message)
            if (parsed.level === 'done') setStatus('done')
          } catch {
            log('info', line)
          }
        }
      }
      if (status !== 'error') setStatus((s) => (s === 'running' ? 'done' : s))
      log('info', 'Imputation pipeline finished.')
    } catch (err) {
      setStatus('error')
      log('error', `Imputation error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const statusBadge: Record<Status, { label: string; className: string }> = {
    standby: { label: 'Standby', className: 'bg-zinc-100 dark:bg-zinc-900 border-zinc-250 dark:border-zinc-800 text-zinc-500' },
    parsing: { label: 'Parsing', className: 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900 text-amber-600' },
    importing: { label: 'Importing', className: 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900 text-amber-600' },
    imported: { label: 'Imported', className: 'bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-900 text-blue-600' },
    running: { label: 'Running', className: 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900 text-amber-600' },
    done: { label: 'Done', className: 'bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-900 text-green-600' },
    error: { label: 'Error', className: 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900 text-red-600' },
  }

  return (
    <div className="flex flex-col gap-8 w-full font-sans">
      {/* Header Row */}
      <div className="flex flex-col gap-1 border-b border-zinc-200 pb-5 dark:border-zinc-850">
        <h1 className="text-2xl font-mono font-bold tracking-tight text-zinc-950 dark:text-zinc-50 uppercase">
          Web of Science & Imputation Studio
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Import local WoS catalogs, map relational authorship contributions, and execute LLM country imputation pipelines.
        </p>
      </div>

      {/* Grid Layout: Import & Settings */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* LEFT COLUMN: Data Import (cols: 6) */}
        <div className="lg:col-span-6 flex flex-col gap-6">
          <div className="flex flex-col gap-4 border border-zinc-200 dark:border-zinc-800 p-5 rounded bg-white dark:bg-zinc-950/10">
            <div className="flex flex-col gap-2.5">
              <span className="text-xs font-mono font-bold uppercase text-zinc-500">
                1. Web of Science Data Import
              </span>
              <p className="text-[11px] text-zinc-400 font-sans leading-relaxed">
                Upload raw WoS export files (plain text formats, CSVs, or Excel spreadsheets) to parse records, extract DOIs, and stage them for contributor coverage checking.
              </p>

              {/* Upload Box */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.csv,.xls,.xlsx"
                className="hidden"
                onChange={onFileInputChange}
              />
              <div
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={onDrop}
                className={`border border-dashed rounded p-6 flex flex-col items-center justify-center gap-3 transition cursor-pointer mt-1 ${
                  isDragging
                    ? 'border-zinc-500 bg-zinc-100 dark:bg-zinc-900/50'
                    : 'border-zinc-300 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/10 hover:bg-zinc-50 dark:hover:bg-zinc-900/30'
                }`}
              >
                {status === 'parsing' ? (
                  <Loader2 className="h-6 w-6 text-zinc-400 animate-spin" />
                ) : (
                  <Upload className="h-6 w-6 text-zinc-400" />
                )}
                <span className="text-xs font-mono font-bold text-zinc-600 dark:text-zinc-400 uppercase">
                  {file ? file.name : 'Choose WoS catalog file...'}
                </span>
                <span className="text-[10px] text-zinc-400">
                  Accepts .txt (WoS Plain Text), .csv, .xls, or .xlsx
                </span>
              </div>

              {/* Schema mapping fields */}
              <div className="grid grid-cols-2 gap-3 mt-2">
                <div className="flex flex-col gap-1">
                  <label className="text-[9px] font-mono font-bold uppercase tracking-wider text-zinc-450">
                    DOI Column
                  </label>
                  <select
                    disabled={!usesColumns || headers.length === 0}
                    value={doiColumn}
                    onChange={(e) => setDoiColumn(e.target.value)}
                    className="w-full bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200 dark:border-zinc-800 p-1.5 rounded font-mono text-xs text-zinc-700 dark:text-zinc-300 disabled:text-zinc-400"
                  >
                    <option value="">{usesColumns ? 'Select column...' : 'Auto-mapped (DI)'}</option>
                    {headers.map((h) => (
                      <option key={h} value={h}>{h}</option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[9px] font-mono font-bold uppercase tracking-wider text-zinc-450">
                    Author Column
                  </label>
                  <select
                    disabled={!usesColumns || headers.length === 0}
                    value={authorColumn}
                    onChange={(e) => setAuthorColumn(e.target.value)}
                    className="w-full bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200 dark:border-zinc-800 p-1.5 rounded font-mono text-xs text-zinc-700 dark:text-zinc-300 disabled:text-zinc-400"
                  >
                    <option value="">{usesColumns ? 'Select column...' : 'Auto-mapped (AU)'}</option>
                    {headers.map((h) => (
                      <option key={h} value={h}>{h}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            <button
              type="button"
              disabled={!canImport}
              onClick={handleImport}
              className={`w-full flex items-center justify-center gap-2 mt-2 px-3 py-2 border rounded font-mono text-xs font-bold uppercase select-none transition ${
                canImport
                  ? 'border-zinc-800 bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-950 hover:opacity-90 cursor-pointer'
                  : 'border-zinc-250 dark:border-zinc-800 bg-zinc-100 dark:bg-zinc-900 text-zinc-400 dark:text-zinc-500 cursor-not-allowed'
              }`}
            >
              {status === 'importing' ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              ) : (
                <Database className="h-3.5 w-3.5 shrink-0" />
              )}
              Import & Parse Catalog
            </button>
          </div>
        </div>

        {/* RIGHT COLUMN: Imputation Configuration (cols: 6) */}
        <div className="lg:col-span-6 flex flex-col gap-6">
          <div className="flex flex-col gap-4 border border-zinc-200 dark:border-zinc-800 p-5 rounded bg-white dark:bg-zinc-950/10">
            <div className="flex flex-col gap-2.5">
              <span className="text-xs font-mono font-bold uppercase text-zinc-500">
                2. Affiliation Imputation Engine
              </span>
              <p className="text-[11px] text-zinc-400 font-sans leading-relaxed">
                Configure LLM credentials to scan paper authorship entries with missing institution countries and impute correct ISO country codes based on raw affiliation strings.
              </p>

              {/* Provider Selection */}
              <div className="flex flex-col gap-1 mt-1">
                <label className="text-[9px] font-mono font-bold uppercase tracking-wider text-zinc-450">
                  LLM Provider
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setImputeProvider('gemini')
                      setModelName('gemini-1.5-flash')
                    }}
                    className={`flex-1 py-1.5 border rounded font-mono text-[10px] font-bold uppercase transition ${
                      imputeProvider === 'gemini'
                        ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-950 border-zinc-800'
                        : 'bg-transparent text-zinc-500 border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900'
                    }`}
                  >
                    Gemini API
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setImputeProvider('ollama')
                      setModelName('llama3')
                    }}
                    className={`flex-1 py-1.5 border rounded font-mono text-[10px] font-bold uppercase transition ${
                      imputeProvider === 'ollama'
                        ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-950 border-zinc-800'
                        : 'bg-transparent text-zinc-500 border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900'
                    }`}
                  >
                    Ollama (Local)
                  </button>
                </div>
              </div>

              {/* Model Choice */}
              <div className="flex flex-col gap-1">
                <label className="text-[9px] font-mono font-bold uppercase tracking-wider text-zinc-450">
                  Model Selection
                </label>
                {imputeProvider === 'gemini' ? (
                  <select
                    value={modelName}
                    onChange={(e) => setModelName(e.target.value)}
                    className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-1.5 rounded font-mono text-xs focus:outline-none"
                  >
                    <option value="gemini-1.5-flash">Gemini 1.5 Flash (Recommended)</option>
                    <option value="gemini-1.5-pro">Gemini 1.5 Pro</option>
                  </select>
                ) : (
                  <input
                    type="text"
                    value={modelName}
                    onChange={(e) => setModelName(e.target.value)}
                    className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-1.5 rounded font-mono text-xs focus:outline-none"
                    placeholder="e.g. llama3, mistral"
                  />
                )}
              </div>

              {/* Provider Config Fields */}
              {imputeProvider === 'gemini' ? (
                <div className="flex flex-col gap-1">
                  <label className="text-[9px] font-mono font-bold uppercase tracking-wider text-zinc-450 flex items-center gap-1">
                    <Key className="h-2.5 w-2.5" /> Gemini API Key
                  </label>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-1.5 rounded font-mono text-xs focus:outline-none"
                    placeholder="Enter GEMINI_API_KEY..."
                  />
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  <label className="text-[9px] font-mono font-bold uppercase tracking-wider text-zinc-450">
                    Ollama Base URL
                  </label>
                  <input
                    type="text"
                    value={ollamaURL}
                    onChange={(e) => setOllamaURL(e.target.value)}
                    className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-1.5 rounded font-mono text-xs focus:outline-none"
                    placeholder="http://localhost:11434"
                  />
                </div>
              )}

              {catalogId && (
                <div className="flex items-center gap-1.5 text-[10px] font-mono text-zinc-400 mt-1">
                  <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />
                  Catalog ready: {catalogId}
                </div>
              )}
            </div>

            <button
              type="button"
              disabled={!canRunImputation}
              onClick={handleRunImputation}
              className={`w-full flex items-center justify-center gap-2 mt-2 px-3 py-2 border rounded font-mono text-xs font-bold uppercase select-none transition ${
                canRunImputation
                  ? 'border-zinc-800 bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-950 hover:opacity-90 cursor-pointer'
                  : 'border-zinc-250 dark:border-zinc-800 bg-zinc-100 dark:bg-zinc-900 text-zinc-400 dark:text-zinc-500 cursor-not-allowed'
              }`}
            >
              {status === 'running' ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5 shrink-0" />
              )}
              Run Imputation Pipeline
            </button>
          </div>
        </div>
      </div>

      {/* Bottom Section: Logs console */}
      <div className="flex flex-col gap-4 border border-zinc-200 dark:border-zinc-800 p-5 rounded bg-white dark:bg-zinc-950/10">
        <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-850 pb-3">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-zinc-400 shrink-0" />
            <span className="text-xs font-mono font-bold uppercase text-zinc-500">
              3. Imputation Diagnostics & Logs
            </span>
          </div>
          <span className={`px-2 py-0.5 rounded border font-mono text-[9px] font-bold uppercase ${statusBadge[status].className}`}>
            {statusBadge[status].label}
          </span>
        </div>

        <div className="bg-zinc-950 text-zinc-100 p-4 rounded font-mono text-[10px] min-h-[10rem] flex flex-col gap-1.5 leading-relaxed overflow-y-auto max-h-60 border border-zinc-900 text-left">
          {logs.map((entry, i) => (
            <span
              key={i}
              className={
                entry.level === 'error'
                  ? 'text-red-400'
                  : entry.level === 'done'
                  ? 'text-green-400'
                  : 'text-zinc-500'
              }
            >
              [{entry.time}] [{entry.level.toUpperCase()}] {entry.message}
              {entry.level === 'error' && <XCircle className="inline h-2.5 w-2.5 ml-1" />}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}