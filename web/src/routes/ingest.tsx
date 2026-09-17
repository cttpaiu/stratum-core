import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useProject } from '../context/ProjectContext'
import {
  Save,
  Check,
  Loader2,
  Upload,
  AlertCircle,
  Key,
  Calendar,
  Copy,
  Play,
  CheckCircle,
  Search,
  PieChart,
  Square,
  Bell,
  FileText,
  X,
  Activity,
  Maximize2,
  Minimize2,
  Plus,
  Trash2,
  Download,
  Terminal,
  Settings,
  Sparkles,
  Brain,
  Filter,
  Tag,
  Bookmark,
  Globe,
  RefreshCw,
} from 'lucide-react'

interface ScoredKeyword {
  term: string
  score: number
  tfidf_score?: number
  keybert_score?: number
  selected: boolean
}

interface AppConfig {
  api?: {
    keys?: string[]
    email?: string
  }
  filters?: {
    date_from?: string
    date_to?: string
    doc_types?: string[]
  }
}
interface ConfigRevision {
  version: number
  timestamp: string
  label: string
  keywords: string
  topics: string
  anchors: string
}

interface SearchableListEditorProps {
  id: string
  label: string
  value: string
  onChange: (val: string) => void
  placeholder: string
  disabled?: boolean
  maxCollapsedItems?: number
  validate?: (val: string) => { valid: boolean; error?: string; normalized?: string }
}

function SearchableListEditor({
  id,
  label,
  value,
  onChange,
  placeholder,
  disabled,
  maxCollapsedItems = 10,
  validate,
}: SearchableListEditorProps) {
  const [activeTab, setActiveTab] = useState<'list' | 'raw'>('list')
  const [searchQuery, setSearchQuery] = useState('')
  const [newItem, setNewItem] = useState('')
  const [isExpanded, setIsExpanded] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)

  // Parse lines
  const items = useMemo(() => {
    return value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  }, [value])

  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return items
    return items.filter((item) =>
      item.toLowerCase().includes(searchQuery.toLowerCase())
    )
  }, [items, searchQuery])

  const invalidLines = useMemo(() => {
    if (!validate) return []
    return value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !validate(line).valid)
  }, [value, validate])

  const handleAddItem = (e?: React.FormEvent | React.KeyboardEvent) => {
    if (e) e.preventDefault()
    const cleaned = newItem.trim()
    if (!cleaned) return

    let itemToAdd = cleaned
    if (validate) {
      const res = validate(cleaned)
      if (!res.valid) {
        setValidationError(res.error || 'Invalid format')
        return
      }
      itemToAdd = res.normalized || cleaned
    }

    setValidationError(null)

    if (items.includes(itemToAdd)) {
      setNewItem('')
      return // Avoid duplicates if already present
    }
    const newValue = [...items, itemToAdd].join('\n')
    onChange(newValue)
    setNewItem('')
  }

  const handleDeleteItem = (itemToDelete: string) => {
    const newValue = items.filter((item) => item !== itemToDelete).join('\n')
    onChange(newValue)
  }

  const handleClearAll = () => {
    if (window.confirm(`Are you sure you want to clear all ${label.toLowerCase()}?`)) {
      onChange('')
    }
  }

  const handleRawBlur = () => {
    if (!validate) return
    const normalizedLines = value
      .split('\n')
      .map((line) => {
        const trimmed = line.trim()
        if (!trimmed) return ''
        const res = validate(trimmed)
        return res.valid ? (res.normalized || trimmed) : line
      })
    onChange(normalizedLines.join('\n'))
  }

  const EditorContent = (isModal: boolean) => {
    const visibleItems = isModal ? filteredItems : filteredItems.slice(0, maxCollapsedItems)
    return (
      <div className="flex flex-col h-full gap-3">
        {/* Header Controls */}
        <div className="flex items-center justify-between gap-2 border-b border-zinc-150 dark:border-zinc-800/80 pb-2">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setActiveTab('list')}
              className={`px-3 py-1 text-xs font-mono font-bold uppercase rounded transition-colors cursor-pointer ${
                activeTab === 'list'
                  ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100'
                  : 'text-zinc-400 hover:text-zinc-650 dark:hover:text-zinc-350'
              }`}
            >
              List ({items.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('raw')}
              className={`px-3 py-1 text-xs font-mono font-bold uppercase rounded transition-colors cursor-pointer ${
                activeTab === 'raw'
                  ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100'
                  : 'text-zinc-400 hover:text-zinc-650 dark:hover:text-zinc-350'
              }`}
            >
              Raw Editor
            </button>
          </div>

          <div className="flex items-center gap-3">
            {items.length > 0 && (
              <button
                type="button"
                onClick={handleClearAll}
                className="text-[10px] font-mono text-red-500 hover:text-red-650 dark:hover:text-red-400 uppercase font-bold cursor-pointer"
              >
                Clear All
              </button>
            )}
            {!isModal && (
              <button
                type="button"
                onClick={() => setIsExpanded(true)}
                className="p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded text-zinc-450 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors cursor-pointer"
                title="Expand to big editor"
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {activeTab === 'list' ? (
          <div className="flex flex-col gap-3 flex-1 min-h-0">
            {/* Add & Search Controls */}
            <div className="flex flex-col sm:flex-row gap-2">
              {/* Search Input */}
              <div className="relative flex-1">
                <span className="absolute inset-y-0 left-0 flex items-center pl-2.5 pointer-events-none text-zinc-450">
                  <Search className="h-3.5 w-3.5" />
                </span>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={`Search ${label.toLowerCase()}...`}
                  className="w-full pl-8 pr-8 py-1.5 border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 rounded font-mono text-xs focus:outline-none"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="absolute inset-y-0 right-0 flex items-center pr-2.5 text-zinc-455 hover:text-zinc-650 dark:hover:text-zinc-200 cursor-pointer"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              {/* Quick Add */}
              <div className="flex gap-1">
                <input
                  type="text"
                  value={newItem}
                  onChange={(e) => setNewItem(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      handleAddItem(e)
                    }
                  }}
                  placeholder="Add item..."
                  className="w-32 px-3 py-1.5 border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 rounded font-mono text-xs focus:outline-none"
                />
                <button
                  type="button"
                  onClick={(e) => handleAddItem(e)}
                  className="flex items-center justify-center p-1.5 border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-850 rounded hover:bg-zinc-50 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-350 cursor-pointer"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {/* Validation Error Message */}
            {validationError && (
              <div className="text-[11px] font-mono text-red-500 dark:text-red-400 flex items-center gap-1.5 px-1 py-0.5">
                <AlertCircle className="h-3.5 w-3.5 animate-pulse" />
                <span>{validationError}</span>
              </div>
            )}

            {/* List display */}
            <div
              className={`flex-1 overflow-y-auto border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/10 rounded p-2.5 font-mono text-xs ${
                isModal ? 'h-[400px]' : 'h-40'
              }`}
            >
              {filteredItems.length === 0 ? (
                <div className="h-full flex items-center justify-center text-zinc-400 text-xs py-8">
                  {searchQuery ? 'No matching items' : 'List is empty'}
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                    {visibleItems.map((item) => (
                      <div
                        key={item}
                        className="flex items-center justify-between gap-2 px-2.5 py-1.5 bg-white dark:bg-zinc-900/50 border border-zinc-150 dark:border-zinc-800/80 rounded group hover:border-zinc-300 dark:hover:border-zinc-700 transition-colors"
                      >
                        <span className="truncate select-all text-zinc-800 dark:text-zinc-200">{item}</span>
                        <button
                          type="button"
                          onClick={() => handleDeleteItem(item)}
                          className="text-zinc-400 hover:text-red-500 p-0.5 rounded cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                  {!isModal && filteredItems.length > maxCollapsedItems && (
                    <div className="text-center pt-2 border-t border-dashed border-zinc-200 dark:border-zinc-800/50 mt-1">
                      <button
                        type="button"
                        onClick={() => setIsExpanded(true)}
                        className="text-[10px] font-mono text-zinc-455 hover:text-zinc-700 dark:hover:text-zinc-300 uppercase font-bold cursor-pointer transition-colors"
                      >
                        + {filteredItems.length - maxCollapsedItems} more items (click expand to edit/view all)
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col min-h-0">
            <textarea
              id={id}
              disabled={disabled}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onBlur={handleRawBlur}
              className={`w-full p-3 border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/10 font-mono text-xs leading-relaxed focus:outline-none rounded resize-none flex-1 ${
                isModal ? 'h-[400px]' : 'h-40'
              }`}
              placeholder={placeholder}
            />
            {invalidLines.length > 0 && (
              <div className="mt-2 p-2 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900/50 rounded flex flex-col gap-1">
                <span className="text-[11px] font-mono font-bold text-red-650 dark:text-red-400 flex items-center gap-1">
                  <AlertCircle className="h-3.5 w-3.5" />
                  Warning: {invalidLines.length} invalid {invalidLines.length === 1 ? 'item' : 'items'} detected
                </span>
                <span className="text-[10px] font-mono text-red-500 dark:text-red-400/80 max-h-16 overflow-y-auto">
                  Invalid values: {invalidLines.join(', ')}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <>
      <div className="flex flex-col gap-2 border border-zinc-200 dark:border-zinc-800 p-4 rounded bg-white dark:bg-zinc-950/10 shadow-sm">
        <label
          htmlFor={id}
          className="text-xs font-mono font-bold uppercase tracking-wider text-zinc-500"
        >
          {label}
        </label>
        {EditorContent(false)}
      </div>

      {/* Expanded Modal */}
      {isExpanded && (
        <div className="fixed inset-0 z-55 flex items-center justify-center p-4 bg-zinc-950/60 backdrop-blur-sm">
          <div className="w-full max-w-3xl flex flex-col border border-zinc-200 dark:border-zinc-800 rounded-lg bg-white dark:bg-zinc-900 shadow-2xl p-6 h-[580px]">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-zinc-150 dark:border-zinc-800 pb-3 mb-4">
              <div>
                <h3 className="text-sm font-mono font-bold uppercase tracking-wider text-zinc-850 dark:text-zinc-100">
                  {label} Editor
                </h3>
                <p className="text-[10px] text-zinc-400 font-mono">
                  Manage list items individually or edit raw text. Changes are saved automatically.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsExpanded(false)}
                className="p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 transition-colors cursor-pointer"
              >
                <Minimize2 className="h-5 w-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="flex-1 min-h-0">
              {EditorContent(true)}
            </div>

            {/* Modal Footer */}
            <div className="flex justify-end pt-3 border-t border-zinc-150 dark:border-zinc-800 mt-4">
              <button
                type="button"
                onClick={() => setIsExpanded(false)}
                className="px-4 py-2 bg-zinc-900 dark:bg-zinc-100 hover:bg-zinc-800 dark:hover:bg-zinc-200 text-white dark:text-zinc-900 font-mono text-xs font-bold uppercase rounded cursor-pointer"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

const validateTopic = (val: string) => {
  const trimmed = val.trim()
  if (!trimmed) {
    return { valid: true, normalized: '' }
  }
  const match = trimmed.match(/^([tT])(\d{5})$/)
  if (!match) {
    return {
      valid: false,
      error: 'Topic ID must be in the format T12345 (T followed by exactly 5 digits)',
    }
  }
  return {
    valid: true,
    normalized: `T${match[2]}`,
  }
}

const validateDoi = (val: string) => {
  const trimmed = val.trim()
  if (!trimmed) {
    return { valid: true, normalized: '' }
  }
  // Relaxed DOI validator: must start with 10. and have a slash separating prefix and suffix
  const match = trimmed.match(/^10\.\d{4,9}\/.+$/)
  if (!match) {
    return {
      valid: false,
      error: 'DOI must start with "10." followed by a 4-9 digit prefix and a slash (e.g. 10.1016/...)',
    }
  }
  return {
    valid: true,
    normalized: trimmed,
  }
}

let toastIdCounter = 0
function getNextToastId() {
  return `toast-${++toastIdCounter}`
}

export function Ingest() {
  const { activeProject } = useProject()
  // API Config States
  const [keywords, setKeywords] = useState('')
  const [topics, setTopics] = useState('')
  const [anchors, setAnchors] = useState('')
  const [appConfig, setAppConfig] = useState<AppConfig | null>(null)
  const [apiKeysStr, setApiKeysStr] = useState('')
  const [apiEmail, setApiEmail] = useState('')
  const [dateFrom, setDateFrom] = useState('2003-01-01')
  const [dateTo, setDateTo] = useState('2024-12-31')
  const [selectedDocTypes, setSelectedDocTypes] = useState<Record<string, boolean>>({
    article: true,
    review: true,
    'proceedings-article': true,
    preprint: false,
    'book-chapter': false,
    dataset: false,
  })
  const [configHistory, setConfigHistory] = useState<ConfigRevision[]>([])
  const [selectedVersion, setSelectedVersion] = useState<string>('')
  const [saveLabel, setSaveLabel] = useState('')

  // Upload States
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadSuccess, setUploadSuccess] = useState(false)
  const [uploadedFilename, setUploadedFilename] = useState('')
  const [columns, setColumns] = useState<string[]>([])
  const [rowCount, setRowCount] = useState<number | null>(null)
  const [selectedTitleCol, setSelectedTitleCol] = useState('')
  const [selectedAbstractCol, setSelectedAbstractCol] = useState('')
  const [selectedDoiCol, setSelectedDoiCol] = useState('')

  // TF-IDF Extraction States
  const [topN, setTopN] = useState(20)
  const [ngramMin, setNgramMin] = useState(2)
  const [ngramMax, setNgramMax] = useState(3)
  const [minDF, setMinDF] = useState(2)
  const [maxDF] = useState(0.85)
  const [useKeyBERT, setUseKeyBERT] = useState(true)
  const [keybertModel, setKeybertModel] = useState("allenai-specter")
  const [candidatePool, setCandidatePool] = useState(20)
  const [alphaBlend, setAlphaBlend] = useState(0.1)
  const [extracting, setExtracting] = useState(false)
  const [extractedKeywords, setExtractedKeywords] = useState<ScoredKeyword[]>([])

  // AI Query Generation States
  const [generatingQuery, setGeneratingQuery] = useState(false)
  const [llmProvider, setLlmProvider] = useState<'gemini' | 'ollama'>(() => {
    return (typeof window !== 'undefined' ? localStorage.getItem('stratum_llm_provider') as 'gemini' | 'ollama' : null) || 'gemini'
  })
  const [llmApiKey, setLlmApiKey] = useState(() => {
    return typeof window !== 'undefined' ? localStorage.getItem('stratum_gemini_key') || '' : ''
  })
  const [llmModel, setLlmModel] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('stratum_gemini_model')
      if (saved && (saved.startsWith('gemini') || saved.startsWith('models/gemini'))) {
        return saved
      }
    }
    return 'gemini-3.6-flash'
  })
  const [ollamaModel, setOllamaModel] = useState(() => {
    return typeof window !== 'undefined' ? localStorage.getItem('stratum_ollama_model') || 'qwen3:4b' : 'qwen3:4b'
  })
  const [ollamaUrl, setOllamaUrl] = useState(() => {
    return typeof window !== 'undefined' ? localStorage.getItem('stratum_ollama_url') || 'http://localhost:11434' : 'http://localhost:11434'
  })
  const [domainContext, setDomainContext] = useState('')
  const [showAIModal, setShowAIModal] = useState(false)
  const [categorizedBreakdown, setCategorizedBreakdown] = useState<Record<string, string[]> | null>(null)

  // Validation States
  const [validating, setValidating] = useState(false)
  const [queryValid, setQueryValid] = useState<boolean | null>(null)
  const [queryErrors, setQueryErrors] = useState<string[]>([])

  // OpenAlex Count States
  const [checkingCount, setCheckingCount] = useState(false)
  const [searchMode, setSearchMode] = useState<'keyword' | 'filtered' | null>(null)
  const [openalexCount, setOpenalexCount] = useState<number | null>(null)
  const [activeFilterString, setActiveFilterString] = useState<string | null>(null)
  const [copiedFilter, setCopiedFilter] = useState(false)
  const [anchorsCount, setAnchorsCount] = useState<number | null>(null)
  const [anchorsTotal, setAnchorsTotal] = useState<number | null>(null)
  const [anchorsMatched, setAnchorsMatched] = useState<number | null>(null)
  const [anchorsMissing, setAnchorsMissing] = useState<string[]>([])
  const [checkAnchors, setCheckAnchors] = useState(true)
  const [downloadingSample, setDownloadingSample] = useState(false)
  const [sampleModalConfig, setSampleModalConfig] = useState<{
    defaultSize: number
    onConfirm: (size: number) => void
  } | null>(null)
  const [sampleSizeInput, setSampleSizeInput] = useState('')

  interface DownloadPreflightInfo {
    total: number
    estimated_mb: number
    free_space_gb: number
    topics_count: number
    no_topics: boolean
    default_filename: string
    jsonl_dir: string
    existing_papers: number
    is_resumable: boolean
    needs_overwrite_choice: boolean
  }

  const [fetchingDownloadInfo, setFetchingDownloadInfo] = useState(false)
  const [downloadModalOpen, setDownloadModalOpen] = useState(false)
  const defaultJsonlName = useMemo(() => {
    return activeProject && activeProject !== 'default' ? `${activeProject}.jsonl` : 'collected_papers.jsonl'
  }, [activeProject])

  const [downloadInfo, setDownloadInfo] = useState<DownloadPreflightInfo | null>(null)
  const [downloadOutputFilename, setDownloadOutputFilename] = useState('')
  const [downloadNoTopics, setDownloadNoTopics] = useState(false)
  const [downloadOverwrite, setDownloadOverwrite] = useState(false)
  const [startingDownload, setStartingDownload] = useState(false)

  useEffect(() => {
    if (activeProject && activeProject !== 'default') {
      setDownloadOutputFilename(`${activeProject}.jsonl`)
    } else {
      setDownloadOutputFilename('collected_papers.jsonl')
    }
  }, [activeProject])


  // OpenAlex Topics States
  interface OpenAlexTopic {
    topic_id: string
    display_name: string
    description?: string
    subfield?: string
    field?: string
    domain?: string
    paper_count: number
    frequency?: number
    percentage: number
    coverage?: number
    importance?: string
    status?: string
    example_doi?: string
  }
  const [checkingTopics, setCheckingTopics] = useState(false)
  const topicsAbortControllerRef = useRef<AbortController | null>(null)
  const [openalexTopics, setOpenalexTopics] = useState<OpenAlexTopic[] | null>(null)
  const [openalexTopicsTotal, setOpenalexTopicsTotal] = useState<number | null>(null)
  const [openalexTopicsTotalPapers, setOpenalexTopicsTotalPapers] = useState<number | null>(null)
  const [topicDiscoverySource, setTopicDiscoverySource] = useState<'keywords' | 'anchors' | null>(null)
  const [showAllTopics, setShowAllTopics] = useState(false)

  // Pipeline Sync States
  const [syncing, setSyncing] = useState(false)
  const [pipelineProgress, setPipelineProgress] = useState(0)
  const [pipelineLogs, setPipelineLogs] = useState<string[]>([])
  const consoleContainerRef = useRef<HTMLDivElement | null>(null)
  const prevSyncingRef = useRef(false)
  const fetchImputeFilesRef = useRef<() => void>(() => {})

  // 1. Initial Status Check
  useEffect(() => {
    const checkInitialStatus = async () => {
      if (!activeProject) return
      try {
        const response = await fetch(`/api/pipeline/status?project=${activeProject}`)
        if (response.ok) {
          const data = await response.json()
          setSyncing(data.syncing)
          setPipelineProgress(data.progress)
          setPipelineLogs(data.logs || [])
        }
      } catch (err) {
        console.error('Failed to load initial status:', err)
      }
    }

    checkInitialStatus()
  }, [activeProject])

  // 2. Poll Pipeline Status periodically when Syncing
  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null

    const checkStatus = async () => {
      if (!activeProject) return
      try {
        const response = await fetch(`/api/pipeline/status?project=${activeProject}`)
        if (response.ok) {
          const data = await response.json()
          setSyncing(data.syncing)
          setPipelineProgress(data.progress)
          setPipelineLogs(data.logs || [])

          if (!data.syncing) {
            if (intervalId) clearInterval(intervalId)
            if (prevSyncingRef.current) {
              fetchImputeFilesRef.current?.()
              addToast(
                'success',
                'Download Completed',
                'JSONL download complete! File is ready on disk and selectable in Country Imputation.'
              )
            }
          }
          prevSyncingRef.current = data.syncing
        }
      } catch (err) {
        console.error('Failed to poll status:', err)
      }
    }

    if (syncing) {
      prevSyncingRef.current = true
      intervalId = setInterval(checkStatus, 1000)
    } else {
      if (intervalId) clearInterval(intervalId)
    }

    return () => {
      if (intervalId) clearInterval(intervalId)
    }
  }, [syncing, activeProject])

  // Auto-scroll logs to bottom inside the console box only (without hijacking page scroll)
  useEffect(() => {
    if (consoleContainerRef.current) {
      consoleContainerRef.current.scrollTop = consoleContainerRef.current.scrollHeight
    }
  }, [pipelineLogs])

  const handleSyncToggle = async () => {
    if (syncing) {
      alert('Pipeline execution running in Go background thread. Waiting for completion.')
      return
    }

    setSyncing(true)
    setPipelineProgress(0)
    setPipelineLogs([
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

  const selectedTopicsList = useMemo(() => {
    return topics
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean)
  }, [topics])

  const isTopicSelected = useCallback((topicId: string) => {
    return selectedTopicsList.includes(topicId.trim())
  }, [selectedTopicsList])

  const handleToggleTopic = useCallback((topicId: string, checked: boolean) => {
    const trimmedId = topicId.trim()
    let newList: string[]
    if (checked) {
      if (selectedTopicsList.includes(trimmedId)) return
      newList = [...selectedTopicsList, trimmedId]
    } else {
      newList = selectedTopicsList.filter((t) => t !== trimmedId)
    }
    setTopics(newList.join('\n'))
  }, [selectedTopicsList])

  // Save States
  const [saving, setSaving] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)

  // Navigation & Tab States
  const [activeTab, setActiveTab] = useState<'keywords' | 'topics' | 'execution' | 'imputation' | 'settings'>('keywords')

  // Imputation Tab States (openalex impute-country)
  interface ImputeFileItem {
    name: string
    path: string
    size_bytes: number
    size_human: string
    mod_time: string
    is_imputed: boolean
  }

  interface ImputeStatusResponse {
    running: boolean
    progress: number
    logs: string[]
    output_file?: string
    stats?: Record<string, string>
    error?: string
  }

  const [imputeFiles, setImputeFiles] = useState<ImputeFileItem[]>([])
  const [loadingImputeFiles, setLoadingImputeFiles] = useState(false)
  const [selectedImputeFile, setSelectedImputeFile] = useState('collected_papers.jsonl')
  const [imputeOutputPath, setImputeOutputPath] = useState('collected_papers_imputed.jsonl')
  const [imputeUseROR, setImputeUseROR] = useState(true)
  const [imputeRunning, setImputeRunning] = useState(false)
  const [imputeLogs, setImputeLogs] = useState<string[]>([])
  const [imputeStats, setImputeStats] = useState<Record<string, string>>({})
  const [imputeOutputFile, setImputeOutputFile] = useState<string | null>(null)
  const [imputeError, setImputeError] = useState<string | null>(null)
  const imputeLogsEndRef = useRef<HTMLDivElement | null>(null)
  const imputePollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Toast Notifications States
  interface Toast {
    id: string
    type: 'success' | 'error' | 'info'
    title: string
    message: string
  }
  const [toasts, setToasts] = useState<Toast[]>([])

  const cleanErrorMessage = (msg: string): string => {
    if (!msg) return 'An unknown error occurred.'
    if (
      msg.includes('non-JSON response') &&
      (msg.includes('<html') || msg.includes('<!doctype html>'))
    ) {
      const httpStatusMatch = msg.match(/HTTP \d+/i)
      const statusStr = httpStatusMatch ? ` (${httpStatusMatch[0]})` : ''
      const titleMatch = msg.match(/<title>([\s\S]*?)<\/title>/i)
      if (titleMatch && titleMatch[1]) {
        return `OpenAlex server error${statusStr}: ${titleMatch[1].trim()}`
      }
      const h1Match = msg.match(/<h1>([\s\S]*?)<\/h1>/i)
      if (h1Match && h1Match[1]) {
        return `OpenAlex server error${statusStr}: ${h1Match[1].trim()}`
      }
      return `OpenAlex server returned an invalid HTML error response${statusStr}. Please try again later.`
    }
    return msg.replace(/<[^>]*>/g, '').trim()
  }

  const addToast = (type: 'success' | 'error' | 'info', title: string, message: string) => {
    const id = getNextToastId()
    setToasts((prev) => [...prev, { id, type, title, message: cleanErrorMessage(message) }])
    setTimeout(() => {
      removeToast(id)
    }, 6000)
  }

  const removeToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }

  // Web Browser Notification Permission State
  const [notificationPermission, setNotificationPermission] = useState<'granted' | 'denied' | 'default' | 'unsupported'>(() => {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      return Notification.permission
    }
    return 'unsupported'
  })

  const requestNotificationPermission = async () => {
    if (!('Notification' in window)) return
    const permission = await Notification.requestPermission()
    setNotificationPermission(permission)
    if (permission === 'granted') {
      addToast('success', 'Notifications Enabled', 'You will now receive desktop notifications when processes finish.')
    }
  }

  const sendNotification = (title: string, body: string) => {
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(title, { body: cleanErrorMessage(body) })
      } catch (err) {
        console.error('Failed to trigger notification:', err)
      }
    }
  }

  // Custom Alert Modal State
  const [alertConfig, setAlertConfig] = useState<{
    type: 'success' | 'error' | 'info'
    title: string
    message: string
  } | null>(null)

  const triggerAlert = (type: 'success' | 'error' | 'info', title: string, message: string) => {
    setAlertConfig({ type, title, message: cleanErrorMessage(message) })
  }

  const fileInputRef = useRef<HTMLInputElement>(null)

  const fetchConfig = useCallback(async () => {
    try {
      const response = await fetch(`/api/config?project=${activeProject}`)
      if (response.ok) {
        const data = await response.json()
        const cfg = data.config
        setAppConfig(cfg)
        setKeywords(data.keywords || '')
        setTopics(data.topics || '')
        setAnchors(data.anchors || '')
        setConfigHistory(data.history || [])

        if (cfg) {
          setApiKeysStr(cfg.api?.keys?.join(', ') || '')
          setApiEmail(cfg.api?.email || '')
          setDateFrom(cfg.filters?.date_from || '2003-01-01')
          setDateTo(cfg.filters?.date_to || '2024-12-31')

          const types = cfg.filters?.doc_types || []
          const typeMap: Record<string, boolean> = {
            article: false,
            review: false,
            'proceedings-article': false,
            preprint: false,
            'book-chapter': false,
            dataset: false,
          }
          types.forEach((t: string) => {
            typeMap[t] = true
          })
          setSelectedDocTypes(typeMap)
        }
      }
    } catch (err) {
      console.error('Failed to load configuration:', err)
    }
  }, [activeProject])

  // Load Initial Config
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchConfig()
  }, [fetchConfig])

  useEffect(() => {
    setSelectedVersion('')
  }, [activeProject])

  // File Upload Handler
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setFile(e.target.files[0])
      setUploadSuccess(false)
      setExtractedKeywords([])
    }
  }

  const triggerUpload = async () => {
    if (!file) return
    setUploading(true)
    setUploadSuccess(false)
    const formData = new FormData()
    formData.append('file', file)

    try {
      const response = await fetch(`/api/upload?project=${activeProject}`, {
        method: 'POST',
        body: formData,
      })
      if (response.ok) {
        const data = await response.json()
        setUploadedFilename(data.filename)
        setColumns(data.columns || [])
        setRowCount(data.row_count !== undefined ? data.row_count : null)
        setUploadSuccess(true)

        // Guess columns
        const cols = data.columns || []
        const tCol = cols.find((c: string) => /title/i.test(c)) || cols[0] || ''
        const aCol =
          cols.find((c: string) => /abstract|summary/i.test(c)) || cols[1] || cols[0] || ''
        const dCol = cols.find((c: string) => /doi/i.test(c)) || cols[2] || cols[0] || ''
        setSelectedTitleCol(tCol)
        setSelectedAbstractCol(aCol)
        setSelectedDoiCol(dCol)
      } else {
        const errData = await response.json()
        triggerAlert('error', 'Upload Failed', errData.error || response.statusText)
      }
    } catch (err: unknown) {
      triggerAlert('error', 'Upload Failed', err instanceof Error ? err.message : String(err))
    } finally {
      setUploading(false)
    }
  }

  // TF-IDF Extraction Handler
  const handleExtractKeywords = async () => {
    if (!uploadedFilename) return
    setExtracting(true)

    try {
      const response = await fetch(`/api/tfidf?project=${activeProject}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: uploadedFilename,
          title_column: selectedTitleCol,
          abstract_column: selectedAbstractCol,
          doi_column: selectedDoiCol,
          top_n: useKeyBERT ? Number(topN) : Number(candidatePool),
          ngram_min: Number(ngramMin),
          ngram_max: Number(ngramMax),
          min_df: Number(minDF),
          max_df: Number(maxDF),
          use_keybert: useKeyBERT,
          keybert_model: keybertModel,
          candidate_pool: Number(candidatePool),
          alpha: Number(alphaBlend),
        }),
      })

      if (response.ok) {
        const data = await response.json()
        const list = (data.keywords || []).map((k: { term: string; score: number; tfidf_score?: number; keybert_score?: number }) => ({
          ...k,
          selected: true,
        }))
        setExtractedKeywords(list)
        setAnchorsCount(data.anchors_count || 0)
        fetchConfig() // Reload config to reflect newly saved anchors in textarea
      } else {
        const errData = await response.json()
        triggerAlert('error', 'Extraction Failed', errData.error || response.statusText)
      }
    } catch (err: unknown) {
      triggerAlert('error', 'Extraction Failed', err instanceof Error ? err.message : String(err))
    } finally {
      setExtracting(false)
    }
  }

  const toggleKeywordSelection = (index: number) => {
    setExtractedKeywords((prev) =>
      prev.map((k, i) => (i === index ? { ...k, selected: !k.selected } : k)),
    )
  }

  const selectAllKeywords = (selected: boolean) => {
    setExtractedKeywords((prev) => prev.map((k) => ({ ...k, selected })))
  }

  const appendKeywordsToQuery = () => {
    const selectedTerms = extractedKeywords.filter((k) => k.selected).map((k) => `"${k.term}"`)

    if (selectedTerms.length === 0) return

    const joined = selectedTerms.join(' OR ')
    setKeywords((prev) => {
      const trimmed = prev.trim()
      if (!trimmed) {
        return `(\n  ${joined}\n)`
      }
      // Append to the existing query
      if (trimmed.endsWith(')')) {
        return trimmed.slice(0, -1) + `\n  OR ${joined}\n)`
      }
      return trimmed + ` OR (\n  ${joined}\n)`
    })
  }

  const handleAutoGenerateQuery = async (customKey?: string) => {
    const activeKey = customKey !== undefined ? customKey : llmApiKey
    if (llmProvider === 'gemini' && !activeKey.trim()) {
      setShowAIModal(true)
      return
    }

    const selected = extractedKeywords.filter((k) => k.selected).map((k) => k.term)
    const terms = selected.length > 0 ? selected : extractedKeywords.map((k) => k.term)

    if (terms.length === 0) {
      triggerAlert('info', 'No Keywords Available', 'Please upload a catalog and extract keywords first.')
      return
    }

    setGeneratingQuery(true)
    const activeModel =
      llmProvider === 'gemini'
        ? (llmModel.trim().startsWith('gemini') ? llmModel.trim() : 'gemini-3.6-flash')
        : (ollamaModel.replace(/\s+/g, '') || 'qwen3:4b')

    try {
      const response = await fetch('/api/query/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: activeProject,
          terms: terms,
          provider: llmProvider,
          api_key: activeKey.trim() || undefined,
          model: activeModel,
          ollama_url: ollamaUrl.trim() || undefined,
          domain_context: domainContext.trim() || undefined,
        }),
      })

      if (response.ok) {
        const data = await response.json()
        if (data.query) {
          setKeywords(data.query)
          setCategorizedBreakdown(data.categories || null)
          setQueryValid(data.valid)
          setQueryErrors(data.errors || [])
          setShowAIModal(false)
          addToast('success', 'Boolean Query Generated', `Auto-categorized ${terms.length} keywords into bounded Boolean query.`)
        }
      } else {
        const errData = await response.json()
        triggerAlert('error', 'Query Generation Failed', errData.error || response.statusText)
      }
    } catch (err: unknown) {
      triggerAlert('error', 'Connection Error', err instanceof Error ? err.message : String(err))
    } finally {
      setGeneratingQuery(false)
    }
  }

  // Query Validation Handler
  const handleValidateQuery = async () => {
    if (!keywords.trim()) {
      setQueryValid(null)
      setQueryErrors([])
      return
    }
    setValidating(true)
    setQueryValid(null)

    try {
      const response = await fetch('/api/query/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: keywords }),
      })
      if (response.ok) {
        const data = await response.json()
        setQueryValid(data.valid)
        setQueryErrors(data.errors || [])
      } else {
        triggerAlert('error', 'Validation Failed', 'Failed to validate query syntax.')
      }
    } catch (err: unknown) {
      triggerAlert('error', 'Connection Error', err instanceof Error ? err.message : String(err))
    } finally {
      setValidating(false)
    }
  }

  // Fetch Real Count Handler (supports openalex search & openalex search-filtered)
  const handleGetOpenAlexCount = async (mode: 'keyword' | 'filtered' = 'keyword') => {
    if (!keywords.trim()) {
      triggerAlert('info', 'Empty Query', 'Please enter a search keywords query first.')
      return
    }
    setCheckingCount(true)
    setOpenalexCount(null)
    setActiveFilterString(null)
    setAnchorsTotal(null)
    setAnchorsMatched(null)
    setAnchorsMissing([])
    setSearchMode(mode)

    const keysList = apiKeysStr
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean)

    const topicsList =
      mode === 'filtered'
        ? topics
            .split('\n')
            .map((t) => t.trim())
            .filter((t) => t && !t.startsWith('#'))
        : []

    if (mode === 'filtered' && topicsList.length === 0) {
      triggerAlert(
        'info',
        'No Topics Configured',
        'Please add topic IDs to topics.txt or fetch topics first before running a filtered search.',
      )
      setCheckingCount(false)
      return
    }

    const docTypesList = Object.keys(selectedDocTypes).filter((k) => selectedDocTypes[k])

    try {
      const response = await fetch(`/api/openalex/count?project=${activeProject}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: keywords,
          keys: keysList,
          email: apiEmail,
          date_from: dateFrom,
          date_to: dateTo,
          doc_types: docTypesList,
          topics: topicsList,
          check_anchors: checkAnchors,
        }),
      })

      if (response.ok) {
        const data = await response.json()
        setOpenalexCount(data.count)
        setActiveFilterString(data.filter || null)
        setAnchorsTotal(data.anchors_total || 0)
        setAnchorsMatched(data.anchors_matched || 0)
        setAnchorsMissing(data.anchors_missing || [])

        const countVal = data.count || 0
        const matched = data.anchors_matched || 0
        const total = data.anchors_total || 0
        const modeTitle =
          mode === 'keyword'
            ? 'OpenAlex Keyword Search (openalex search)'
            : 'OpenAlex Filtered Search (openalex search-filtered)'

        if (total > 0) {
          addToast(
            'success',
            `${modeTitle} Completed`,
            `Found ${countVal.toLocaleString()} papers. Anchor match: ${matched}/${total} (${Math.round((matched / total) * 100)}%).`,
          )
        } else {
          addToast(
            'success',
            `${modeTitle} Completed`,
            `Found ${countVal.toLocaleString()} papers.`,
          )
        }
        sendNotification(
          `Stratum: ${modeTitle} Completed`,
          `Estimated papers: ${countVal.toLocaleString()}.${total > 0 ? ` Anchor match: ${matched}/${total}.` : ''}`,
        )
      } else {
        const errData = await response.json()
        const errMsg = errData.error || response.statusText
        triggerAlert('error', 'Search Count Failed', errMsg)
        addToast('error', 'Search Count Failed', errMsg)
        sendNotification('Stratum: Search Count Failed', errMsg)
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      triggerAlert('error', 'Count Request Failed', errMsg)
      addToast('error', 'Search Count Failed', errMsg)
      sendNotification('Stratum: Search Count Failed', errMsg)
    } finally {
      setCheckingCount(false)
    }
  }

  // Download Random Sample CSV Handler
  const handleDownloadSample = async () => {
    if (!keywords.trim()) {
      triggerAlert('info', 'Empty Query', 'Please enter a search keywords query first.')
      return
    }

    setSampleSizeInput('385')
    setSampleModalConfig({
      defaultSize: 385,
      onConfirm: async (sampleSize) => {
        setDownloadingSample(true)

        const keysList = apiKeysStr
          .split(',')
          .map((k) => k.trim())
          .filter(Boolean)
        const topicsList =
          searchMode === 'filtered'
            ? topics
                .split('\n')
                .map((t) => t.trim())
                .filter((t) => t && !t.startsWith('#'))
            : []
        const docTypesList = Object.keys(selectedDocTypes).filter((k) => selectedDocTypes[k])

        try {
          const response = await fetch(`/api/openalex/sample?project=${activeProject}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              query: keywords,
              keys: keysList,
              email: apiEmail,
              date_from: dateFrom,
              date_to: dateTo,
              doc_types: docTypesList,
              topics: topicsList,
              sample_size: sampleSize,
            }),
          })

          if (!response.ok) {
            const contentType = response.headers.get('content-type')
            let errMsg = response.statusText
            if (contentType && contentType.includes('application/json')) {
              const errData = await response.json()
              errMsg = errData.error || errMsg
            }
            throw new Error(errMsg)
          }

          const blob = await response.blob()
          const url = window.URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = `${activeProject || 'openalex'}_sample_${sampleSize}.csv`
          document.body.appendChild(a)
          a.click()
          a.remove()
          window.URL.revokeObjectURL(url)

          addToast(
            'success',
            'Sample Download Completed',
            `Successfully downloaded CSV sample of ${sampleSize} papers.`,
          )
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err)
          triggerAlert('error', 'Download Failed', errMsg)
          addToast('error', 'Sample Download Failed', errMsg)
        } finally {
          setDownloadingSample(false)
        }
      },
    })
  }

  // OpenAlex Download (openalex download) Pre-flight & Initiation Handlers
  const fetchDownloadPreflight = async (noTopics: boolean, outputFilename: string) => {
    setFetchingDownloadInfo(true)
    try {
      const docTypesList = Object.keys(selectedDocTypes).filter((k) => selectedDocTypes[k])
      const topicsList = topics
        .split('\n')
        .map((t) => t.trim())
        .filter((t) => t && !t.startsWith('#'))

      const res = await fetch(`/api/download/info?project=${encodeURIComponent(activeProject)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: keywords,
          topics: topicsList,
          no_topics: noTopics,
          output: outputFilename,
          date_from: dateFrom,
          date_to: dateTo,
          doc_types: docTypesList,
        }),
      })

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        throw new Error(errData.error || `HTTP ${res.status}: Failed to fetch pre-flight info`)
      }

      const data: DownloadPreflightInfo = await res.json()
      setDownloadInfo(data)
      setDownloadOutputFilename(data.default_filename || outputFilename || defaultJsonlName)
      setDownloadNoTopics(noTopics)
      if (data.needs_overwrite_choice) {
        setDownloadOverwrite(true)
      }
      return data
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      triggerAlert('error', 'Pre-flight Check Failed', msg)
      addToast('error', 'Pre-flight Error', msg)
      return null
    } finally {
      setFetchingDownloadInfo(false)
    }
  }

  const handleOpenDownloadPreflight = async () => {
    if (!keywords.trim()) {
      triggerAlert('error', 'Keywords Required', 'Please specify search keywords first.')
      return
    }
    const data = await fetchDownloadPreflight(false, downloadOutputFilename || defaultJsonlName)
    if (data) {
      setDownloadModalOpen(true)
    }
  }

  const handleStartDownloadPapers = async () => {
    if (syncing) {
      triggerAlert('info', 'Task in Progress', 'A download or pipeline task is already active.')
      return
    }

    setStartingDownload(true)
    try {
      const docTypesList = Object.keys(selectedDocTypes).filter((k) => selectedDocTypes[k])
      const topicsList = topics
        .split('\n')
        .map((t) => t.trim())
        .filter((t) => t && !t.startsWith('#'))

      const response = await fetch(`/api/download-papers?project=${encodeURIComponent(activeProject)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          output: downloadOutputFilename.trim() || defaultJsonlName,
          no_topics: downloadNoTopics,
          overwrite: downloadOverwrite,
          query: keywords,
          date_from: dateFrom,
          date_to: dateTo,
          doc_types: docTypesList,
          topics: topicsList,
        }),
      })

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}))
        throw new Error(errData.error || 'Failed to initiate paper download')
      }

      setDownloadModalOpen(false)
      setSyncing(true)
      setPipelineProgress(0)
      setPipelineLogs([
        `[${new Date().toLocaleTimeString()}] [INFO] Initiating paper download (openalex download) -> ${downloadOutputFilename}...`,
      ])
      addToast(
        'success',
        'Download Initiated',
        `Downloading matching papers to ${downloadOutputFilename} (openalex download).`,
      )

      setTimeout(() => {
        if (consoleContainerRef.current) {
          consoleContainerRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }
      }, 150)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      triggerAlert('error', 'Download Failed', msg)
      addToast('error', 'Download Failed', msg)
    } finally {
      setStartingDownload(false)
    }
  }

  const handleCancelPipeline = async () => {
    try {
      const res = await fetch(`/api/pipeline/cancel?project=${activeProject}`, { method: 'POST' })
      if (res.ok) {
        addToast('info', 'Cancellation Requested', 'Cancellation signal sent. Saving progress state...')
      }
    } catch (err) {
      console.error('Failed to cancel pipeline:', err)
    }
  }

  // Imputation Handlers & Effects
  const fetchImputeFiles = useCallback(async () => {
    if (!activeProject) return
    const projName = activeProject !== 'default' ? activeProject : 'collected_papers'
    setLoadingImputeFiles(true)
    try {
      const res = await fetch(`/api/impute/files?project=${activeProject}`)
      if (res.ok) {
        const data = await res.json()
        const files: ImputeFileItem[] = data.files || []
        setImputeFiles(files)
        if (files.length > 0) {
          let chosen = ''
          setSelectedImputeFile((prev) => {
            if (prev && files.some((f) => f.name === prev)) {
              chosen = prev
              return prev
            }
            const projRaw = files.find((f) => f.name === `${projName}.jsonl`)
            const projImputed = files.find((f) => f.name === `${projName}_imputed.jsonl`)
            const collected = files.find((f) => f.name === 'collected_papers.jsonl')
            const collectedImputed = files.find((f) => f.name === 'collected_papers_imputed.jsonl')
            chosen = projRaw
              ? projRaw.name
              : projImputed
                ? projImputed.name
                : collected
                  ? collected.name
                  : collectedImputed
                    ? collectedImputed.name
                    : files[0].name
            return chosen
          })
          const targetName = chosen || files[0].name
          const stem = targetName.replace(/(_imputed)?\.jsonl$/i, '')
          setImputeOutputPath(`${stem || projName}_imputed.jsonl`)
        } else {
          setSelectedImputeFile(`${projName}.jsonl`)
          setImputeOutputPath(`${projName}_imputed.jsonl`)
        }
      }
    } catch (err) {
      console.error('Failed to fetch JSONL files for imputation:', err)
      const projName = activeProject !== 'default' ? activeProject : 'collected_papers'
      setSelectedImputeFile((prev) => prev || `${projName}.jsonl`)
      setImputeOutputPath((prev) => prev || `${projName}_imputed.jsonl`)
    } finally {
      setLoadingImputeFiles(false)
    }
  }, [activeProject])

  fetchImputeFilesRef.current = fetchImputeFiles

  useEffect(() => {
    if (activeTab === 'imputation') {
      fetchImputeFiles()
    }
  }, [activeTab, fetchImputeFiles])

  const handleSelectImputeFile = (filename: string) => {
    setSelectedImputeFile(filename)
    if (filename) {
      const stem = filename.replace(/(_imputed)?\.jsonl$/i, '')
      const projName = activeProject && activeProject !== 'default' ? activeProject : 'collected_papers'
      setImputeOutputPath(`${stem || projName}_imputed.jsonl`)
    }
  }

  const handleStartImputation = async () => {
    const projName = activeProject && activeProject !== 'default' ? activeProject : 'collected_papers'
    const inputFile = selectedImputeFile || `${projName}.jsonl`
    if (!inputFile) {
      triggerAlert('error', 'Input File Required', 'Please select an input JSONL file.')
      return
    }

    // Ensure output file has input name + _imputed.jsonl format
    let targetOut = imputeOutputPath.trim()
    if (!targetOut) {
      const stem = inputFile.replace(/\.jsonl$/i, '')
      targetOut = `${stem}_imputed.jsonl`
      setImputeOutputPath(targetOut)
    } else if (!targetOut.toLowerCase().endsWith('.jsonl')) {
      targetOut = `${targetOut}.jsonl`
      setImputeOutputPath(targetOut)
    }

    setImputeRunning(true)
    setImputeError(null)
    setImputeStats({})
    setImputeLogs([`[${new Date().toLocaleTimeString()}] [INFO] Starting OpenAlex country imputation for ${inputFile}...`])

    try {
      const payload: {
        input_path: string
        output_path: string
        use_ror: boolean
      } = {
        input_path: inputFile,
        output_path: targetOut,
        use_ror: imputeUseROR,
      }

      const res = await fetch(`/api/impute/run?project=${activeProject}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!res.ok) {
        const data = await res.json()
        setImputeRunning(false)
        triggerAlert('error', 'Imputation Failed', data.error || 'Failed to start imputation')
        return
      }

      const data = await res.json()
      setImputeOutputFile(data.output_file || null)
      addToast('info', 'Imputation Started', `Country imputation started for ${inputFile}. Live progress tracking below.`)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setImputeRunning(false)
      triggerAlert('error', 'Connection Error', msg)
    }
  }

  const handleCancelImputation = async () => {
    try {
      const res = await fetch(`/api/impute/cancel?project=${activeProject}`, { method: 'POST' })
      if (res.ok) {
        addToast('info', 'Cancellation Requested', 'Sent cancellation signal to imputation process.')
      }
    } catch (err) {
      console.error('Failed to cancel imputation:', err)
    }
  }

  useEffect(() => {
    if (!imputeRunning) {
      if (imputePollIntervalRef.current) {
        clearInterval(imputePollIntervalRef.current)
        imputePollIntervalRef.current = null
      }
      return
    }

    const poll = async () => {
      try {
        const res = await fetch(`/api/impute/status?project=${activeProject}`)
        if (res.ok) {
          const st: ImputeStatusResponse = await res.json()
          if (st.logs && st.logs.length > 0) {
            setImputeLogs(st.logs)
          }
          if (st.stats) {
            setImputeStats(st.stats)
          }
          if (st.output_file) {
            setImputeOutputFile(st.output_file)
          }
          if (st.error) {
            setImputeError(st.error)
          }
          if (!st.running) {
            setImputeRunning(false)
            if (st.error) {
              addToast('error', 'Imputation Failed', st.error)
            } else {
              addToast('success', 'Imputation Complete', `Finished country imputation! File: ${st.output_file || 'output JSONL'}`)
              fetchImputeFiles()
            }
          }
        }
      } catch (err) {
        console.error('Error polling imputation status:', err)
      }
    }

    poll()
    imputePollIntervalRef.current = setInterval(poll, 1000)
    return () => {
      if (imputePollIntervalRef.current) {
        clearInterval(imputePollIntervalRef.current)
        imputePollIntervalRef.current = null
      }
    }
  }, [imputeRunning, activeProject, fetchImputeFiles])

  useEffect(() => {
    if (imputeLogsEndRef.current) {
      imputeLogsEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [imputeLogs])

  const handleDownloadImputeFile = (fileName?: string) => {
    const targetFile = fileName || imputeOutputFile || 'collected_papers_imputed.jsonl'
    const a = document.createElement('a')
    a.href = `/api/download/file?project=${activeProject}&file=${encodeURIComponent(targetFile)}`
    a.download = targetFile
    document.body.appendChild(a)
    a.click()
    a.remove()
    addToast('success', 'Download Started', `Downloading ${targetFile} to your computer.`)
  }

  const handleCancelTopics = () => {
    if (topicsAbortControllerRef.current) {
      topicsAbortControllerRef.current.abort()
      topicsAbortControllerRef.current = null
    }
    setCheckingTopics(false)
    addToast('info', 'Topics Analysis Cancelled', 'Topic distribution analysis was stopped.')
  }

  const handleGetOpenAlexTopics = async () => {
    if (checkingTopics) {
      handleCancelTopics()
      return
    }

    if (!keywords.trim()) {
      triggerAlert('info', 'Empty Query', 'Please enter a search keywords query first.')
      return
    }

    const controller = new AbortController()
    topicsAbortControllerRef.current = controller

    setCheckingTopics(true)
    setTopicDiscoverySource('keywords')
    setOpenalexTopics(null)
    setOpenalexTopicsTotal(null)
    setOpenalexTopicsTotalPapers(null)

    const keysList = apiKeysStr
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean)
    const topicsList = topics
      .split('\n')
      .map((t) => t.trim())
      .filter((t) => t && !t.startsWith('#'))
    const docTypesList = Object.keys(selectedDocTypes).filter((k) => selectedDocTypes[k])

    try {
      const response = await fetch(`/api/openalex/topics?project=${activeProject}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          query: keywords,
          keys: keysList,
          email: apiEmail,
          date_from: dateFrom,
          date_to: dateTo,
          doc_types: docTypesList,
          topics: topicsList,
          details: true,
        }),
      })

      if (response.ok) {
        const data = await response.json()
        setOpenalexTopics(data.topics || [])
        setOpenalexTopicsTotal(data.total_topics || 0)
        setOpenalexTopicsTotalPapers(data.total_papers || 0)

        const topicsCount = data.total_topics || 0
        const papersCount = data.total_papers || 0
        addToast(
          'success',
          'Topics Analysis Completed',
          `Resolved ${topicsCount} topics across ${papersCount.toLocaleString()} papers.`,
        )
        sendNotification(
          'Stratum: Topics Analysis Completed',
          `Found ${topicsCount} active research topics in current search results.`,
        )
      } else {
        const errData = await response.json()
        const errMsg = errData.error || response.statusText
        triggerAlert('error', 'Topics Fetch Failed', errMsg)
        addToast('error', 'Topics Analysis Failed', errMsg)
        sendNotification('Stratum: Topics Analysis Failed', errMsg)
      }
    } catch (err: unknown) {
      if (err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'))) {
        // User intentionally cancelled
        return
      }
      const errMsg = err instanceof Error ? err.message : String(err)
      triggerAlert(
        'error',
        'Topics Request Failed',
        errMsg,
      )
      addToast('error', 'Topics Analysis Failed', errMsg)
      sendNotification('Stratum: Topics Analysis Failed', errMsg)
    } finally {
      topicsAbortControllerRef.current = null
      setCheckingTopics(false)
    }
  }

  // Fetch Topics from Anchor Files / DOIs (matching openalex/commands/topic_search.py)
  const handleGetTopicsFromAnchors = async () => {
    const anchorsList = anchors
      .split('\n')
      .map((a) => a.trim())
      .filter((a) => a && !a.startsWith('#'))

    if (anchorsList.length === 0) {
      triggerAlert(
        'info',
        'No Anchor Papers Configured',
        'Please enter anchor DOIs in the Anchor DOIs editor first before extracting topics from anchors.',
      )
      return
    }

    if (checkingTopics) {
      handleCancelTopics()
      return
    }

    const controller = new AbortController()
    topicsAbortControllerRef.current = controller

    setCheckingTopics(true)
    setTopicDiscoverySource('anchors')
    setOpenalexTopics(null)
    setOpenalexTopicsTotal(null)
    setOpenalexTopicsTotalPapers(null)

    const keysList = apiKeysStr
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean)

    const currentTopicsList = topics
      .split('\n')
      .map((t) => t.trim())
      .filter((t) => t && !t.startsWith('#'))

    try {
      const response = await fetch(`/api/openalex/topics?project=${activeProject}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          keys: keysList,
          email: apiEmail,
          from_anchors: true,
          anchors: anchorsList,
          topics: currentTopicsList,
          details: true,
        }),
      })

      if (response.ok) {
        const data = await response.json()
        setOpenalexTopics(data.topics || [])
        setOpenalexTopicsTotal(data.total_topics || 0)
        setOpenalexTopicsTotalPapers(data.total_papers || 0)

        const topicsCount = data.total_topics || 0
        const papersCount = data.total_papers || 0
        const anchorsCount = data.anchors_total || anchorsList.length
        addToast(
          'success',
          'Anchor Topics Resolved',
          `Found ${topicsCount} unique topics across ${papersCount}/${anchorsCount} anchor papers.`,
        )
        sendNotification(
          'Stratum: Anchor Topics Resolved',
          `Extracted ${topicsCount} topics from ${papersCount} resolved anchor papers.`,
        )
      } else {
        const errData = await response.json()
        const errMsg = errData.error || response.statusText
        triggerAlert('error', 'Anchor Topics Fetch Failed', errMsg)
        addToast('error', 'Anchor Topics Failed', errMsg)
        sendNotification('Stratum: Anchor Topics Failed', errMsg)
      }
    } catch (err: unknown) {
      if (err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'))) {
        return
      }
      const errMsg = err instanceof Error ? err.message : String(err)
      triggerAlert('error', 'Anchor Topics Request Failed', errMsg)
      addToast('error', 'Anchor Topics Failed', errMsg)
      sendNotification('Stratum: Anchor Topics Failed', errMsg)
    } finally {
      topicsAbortControllerRef.current = null
      setCheckingTopics(false)
    }
  }

  const handleDownloadTopicsCSV = () => {
    if (!openalexTopics || openalexTopics.length === 0) return

    // Helper to escape values for CSV
    const escapeCSV = (val: string | number | undefined | null) => {
      if (val === undefined || val === null) return '""'
      const str = String(val)
      const escaped = str.replace(/"/g, '""')
      return `"${escaped}"`
    }

    let headers: string[]
    let rows: (string | number)[][]

    if (topicDiscoverySource === 'anchors') {
      // Matches missing_topic_analysis.csv schema from topic_search.py
      headers = [
        'Topic ID',
        'Topic',
        'Subfield',
        'Field',
        'Domain',
        'Frequency',
        'Coverage %',
        'Importance',
        'Status',
        'Example DOI',
      ]
      rows = openalexTopics.map((t) => [
        t.topic_id,
        escapeCSV(t.display_name),
        escapeCSV(t.subfield || ''),
        escapeCSV(t.field || ''),
        escapeCSV(t.domain || ''),
        t.frequency ?? t.paper_count,
        `${(t.coverage ?? t.percentage).toFixed(2)}%`,
        escapeCSV(t.importance || ''),
        escapeCSV(t.status || (isTopicSelected(t.topic_id) ? 'Already Present' : 'NEW')),
        escapeCSV(t.example_doi || ''),
      ])
    } else {
      headers = ['Topic ID', 'Topic Name', 'Description', 'Paper Count', 'Percentage']
      rows = openalexTopics.map((t) => [
        t.topic_id,
        escapeCSV(t.display_name),
        escapeCSV(t.description || ''),
        t.paper_count,
        `${t.percentage.toFixed(4)}%`,
      ])
    }

    const csvContent = [headers.join(','), ...rows.map((row) => row.join(','))].join('\n')

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.setAttribute('href', url)
    const filename =
      topicDiscoverySource === 'anchors'
        ? `anchor_topic_analysis_${activeProject || 'export'}.csv`
        : `openalex_topics_${activeProject || 'export'}.csv`
    link.setAttribute('download', filename)
    link.style.visibility = 'hidden'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  const handleAddCriticalAndHighTopics = () => {
    if (!openalexTopics || openalexTopics.length === 0) return
    const criticalAndHigh = openalexTopics
      .filter((t) => t.importance?.includes('Critical') || t.importance?.includes('High'))
      .map((t) => t.topic_id.trim())
    if (criticalAndHigh.length === 0) {
      addToast('info', 'No Critical/High Topics', 'No topics met the Critical or High threshold.')
      return
    }
    const current = topics
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean)
    const combined = Array.from(new Set([...current, ...criticalAndHigh]))
    setTopics(combined.join('\n'))
    addToast('success', 'Topics Added', `Added ${criticalAndHigh.length} Critical & High topics to Target Topics.`)
  }

  const handleAddAllNewTopics = () => {
    if (!openalexTopics || openalexTopics.length === 0) return
    const newTopics = openalexTopics
      .filter((t) => (t.status ? t.status === 'NEW' : !isTopicSelected(t.topic_id)))
      .map((t) => t.topic_id.trim())
    if (newTopics.length === 0) {
      addToast('info', 'All Topics Present', 'All discovered topics are already in Target Topics.')
      return
    }
    const current = topics
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean)
    const combined = Array.from(new Set([...current, ...newTopics]))
    setTopics(combined.join('\n'))
    addToast('success', 'New Topics Added', `Added ${newTopics.length} new topics to Target Topics.`)
  }

  const handleAddTopNTopics = (n: number) => {
    if (!openalexTopics || openalexTopics.length === 0) return
    const topN = openalexTopics.slice(0, n).map((t) => t.topic_id.trim())
    const current = topics
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean)
    const combined = Array.from(new Set([...current, ...topN]))
    setTopics(combined.join('\n'))
    addToast('success', 'Topics Added', `Added ${topN.length} top topics to Target Topics.`)
  }

  const handleAddAllFoundTopics = () => {
    if (!openalexTopics || openalexTopics.length === 0) return
    const allIds = openalexTopics.map((t) => t.topic_id.trim())
    const current = topics
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean)
    const combined = Array.from(new Set([...current, ...allIds]))
    setTopics(combined.join('\n'))
    addToast('success', 'All Topics Added', `Added all ${allIds.length} discovered topics to Target Topics.`)
  }

  // Save Config Handler
  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setSaveSuccess(false)

    // Validate topics
    const invalidTopicsList = topics
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean)
      .filter((t) => !validateTopic(t).valid)

    if (invalidTopicsList.length > 0) {
      triggerAlert(
        'error',
        'Validation Error',
        `Cannot save configuration: Target Topics contains invalid entries: ${invalidTopicsList.join(', ')}`
      )
      setSaving(false)
      return
    }

    // Validate DOIs
    const invalidAnchorsList = anchors
      .split('\n')
      .map((a) => a.trim())
      .filter(Boolean)
      .filter((a) => !validateDoi(a).valid)

    if (invalidAnchorsList.length > 0) {
      triggerAlert(
        'error',
        'Validation Error',
        `Cannot save configuration: Anchor DOIs contains invalid entries: ${invalidAnchorsList.join(', ')}`
      )
      setSaving(false)
      return
    }

    const normalizedTopics = topics
      .split('\n')
      .map((t) => {
        const trimmed = t.trim()
        if (!trimmed) return ''
        const res = validateTopic(trimmed)
        return res.valid ? (res.normalized || trimmed) : t
      })
      .join('\n')

    const normalizedAnchors = anchors
      .split('\n')
      .map((a) => {
        const trimmed = a.trim()
        if (!trimmed) return ''
        const res = validateDoi(trimmed)
        return res.valid ? (res.normalized || trimmed) : a
      })
      .join('\n')

    setTopics(normalizedTopics)
    setAnchors(normalizedAnchors)

    const keysList = apiKeysStr
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean)
    const docTypesList = Object.keys(selectedDocTypes).filter((k) => selectedDocTypes[k])

    const updatedConfig = {
      ...appConfig,
      api: {
        ...appConfig?.api,
        keys: keysList,
        email: apiEmail,
      },
      filters: {
        ...appConfig?.filters,
        date_from: dateFrom,
        date_to: dateTo,
        doc_types: docTypesList,
      },
    }

    try {
      const response = await fetch(`/api/config?project=${activeProject}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: updatedConfig,
          keywords,
          topics: normalizedTopics,
          anchors: normalizedAnchors,
          label: saveLabel,
        }),
      })

      if (response.ok) {
        setSaveSuccess(true)
        setSaveLabel('')
        setSelectedVersion('')
        fetchConfig()
        setTimeout(() => setSaveSuccess(false), 4000)
      } else {
        const errData = await response.json().catch(() => ({}))
        if (errData.errors && Array.isArray(errData.errors)) {
          triggerAlert('error', 'Failed to save configuration', '- ' + errData.errors.join('\n- '))
        } else {
          triggerAlert(
            'error',
            'Failed to save configuration',
            errData.error || response.statusText || 'Unknown error',
          )
        }
      }
    } catch (err: unknown) {
      triggerAlert('error', 'Save Failed', err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-8 w-full max-w-7xl mx-auto relative">
      {/* Floating Toast Notification Alerts */}
      <div className="fixed top-6 right-6 z-50 flex flex-col gap-3 w-80 pointer-events-none">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`p-4 rounded-lg shadow-lg border text-xs font-mono flex items-start justify-between gap-3 pointer-events-auto transition-all duration-300 animate-slide-in ${
              toast.type === 'success'
                ? 'bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300'
                : toast.type === 'error'
                  ? 'bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800 text-red-800 dark:text-red-300'
                  : 'bg-blue-50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-300'
            }`}
          >
            <div className="flex flex-col gap-1">
              <span className="font-bold uppercase tracking-wider text-[10px]">
                {toast.title}
              </span>
              <p className="font-sans leading-relaxed text-zinc-600 dark:text-zinc-400">
                {toast.message}
              </p>
            </div>
            <button
              type="button"
              onClick={() => removeToast(toast.id)}
              className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 cursor-pointer shrink-0"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>

      {/* Page Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between border-b border-zinc-200 pb-5 dark:border-zinc-800 gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-mono font-bold tracking-tight text-zinc-950 dark:text-zinc-50 uppercase">
            Pipeline Setup & Keywords Studio
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Upload local paper catalogs to extract TF-IDF terms, refine boolean queries, configure
            multiple keys, and validate query volumes.
          </p>
        </div>

        {/* Tab Switcher - Premium Monochrome Design */}
        <div className="flex items-center bg-zinc-100 dark:bg-zinc-900 p-1 rounded-lg border border-zinc-200 dark:border-zinc-800 font-mono text-xs font-bold uppercase select-none shrink-0 self-start md:self-center">
          <button
            type="button"
            onClick={() => setActiveTab('keywords')}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-md transition-all cursor-pointer ${
              activeTab === 'keywords'
                ? 'bg-white dark:bg-zinc-800 shadow-sm text-zinc-955 dark:text-white border border-zinc-200/50 dark:border-zinc-700/50'
                : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
            }`}
          >
            <FileText className="h-3.5 w-3.5 text-zinc-500" />
            Keywords & Anchors
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('topics')}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-md transition-all cursor-pointer ${
              activeTab === 'topics'
                ? 'bg-white dark:bg-zinc-800 shadow-sm text-zinc-955 dark:text-white border border-zinc-200/50 dark:border-zinc-700/50'
                : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
            }`}
          >
            <Tag className="h-3.5 w-3.5 text-zinc-500" />
            Topic ID
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('execution')}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-md transition-all cursor-pointer ${
              activeTab === 'execution'
                ? 'bg-white dark:bg-zinc-800 shadow-sm text-zinc-955 dark:text-white border border-zinc-200/50 dark:border-zinc-700/50'
                : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
            }`}
          >
            <Activity className="h-3.5 w-3.5 text-zinc-500" />
            Execution & Analysis
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('imputation')}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-md transition-all cursor-pointer ${
              activeTab === 'imputation'
                ? 'bg-white dark:bg-zinc-800 shadow-sm text-zinc-955 dark:text-white border border-zinc-200/50 dark:border-zinc-700/50'
                : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
            }`}
          >
            <Globe className="h-3.5 w-3.5 text-zinc-500" />
            Imputation
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('settings')}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-md transition-all cursor-pointer ${
              activeTab === 'settings'
                ? 'bg-white dark:bg-zinc-800 shadow-sm text-zinc-955 dark:text-white border border-zinc-200/50 dark:border-zinc-700/50'
                : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
            }`}
          >
            <Settings className="h-3.5 w-3.5 text-zinc-500" />
            Settings
          </button>
        </div>
      </div>

      {saveSuccess && (
        <div className="flex items-center gap-3 p-4 border border-green-200 bg-green-50/50 text-green-700 dark:border-green-800/40 dark:bg-green-950/20 dark:text-green-400 font-mono text-xs rounded">
          <CheckCircle className="h-4 w-4 shrink-0" />
          <span>
            [SUCCESS] Configuration successfully saved. Keywords, topics, and API keys updated.
          </span>
        </div>
      )}

      <form onSubmit={handleSaveConfig} className="w-full flex flex-col gap-8">
        {/* Top Save & Version Selector Panel */}
        <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between border border-zinc-200 dark:border-zinc-800 p-4 rounded bg-white dark:bg-zinc-950/10 shadow-sm gap-4">
          {/* Left Side: Load dropdown & Label input */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-4 flex-1">
            {configHistory.length > 0 && (
              <div className="flex flex-col gap-1 min-w-[200px]">
                <label htmlFor="version-selector" className="text-[10px] font-mono uppercase text-zinc-400 font-bold">
                  Load Saved Version
                </label>
                <select
                  id="version-selector"
                  value={selectedVersion}
                  onChange={(e) => {
                    const val = e.target.value
                    setSelectedVersion(val)
                    const verNum = parseInt(val, 10)
                    if (isNaN(verNum)) return
                    const rev = configHistory.find((r) => r.version === verNum)
                    if (rev) {
                      setKeywords(rev.keywords)
                      setTopics(rev.topics)
                      setAnchors(rev.anchors)
                      addToast(
                        'info',
                        'Revision Restored',
                        `Loaded parameters from revision v${rev.version}. Click Save to apply.`,
                      )
                    }
                  }}
                  className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-2.5 rounded font-mono text-xs focus:outline-none cursor-pointer"
                >
                  <option value="" disabled>
                    Select version to restore...
                  </option>
                  {configHistory
                    .slice()
                    .reverse()
                    .map((rev) => (
                      <option key={rev.version} value={String(rev.version)}>
                        v{rev.version} - {rev.label || 'No description'} ({rev.timestamp})
                      </option>
                    ))}
                </select>
              </div>
            )}

            <div className="flex flex-col gap-1 flex-1 max-w-md">
              <label htmlFor="save-label" className="text-[10px] font-mono uppercase text-zinc-400 font-bold">
                Revision Label / Commit Message (Optional)
              </label>
              <input
                id="save-label"
                type="text"
                disabled={saving}
                value={saveLabel}
                onChange={(e) => setSaveLabel(e.target.value)}
                placeholder="e.g. Configured new keyword search options..."
                className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-2.5 rounded font-mono text-xs focus:outline-none"
              />
            </div>
          </div>

          {/* Right Side: Save Button */}
          <div className="flex items-end self-end md:self-center">
            <button
              type="submit"
              disabled={saving || queryValid === false}
              className="flex items-center gap-2 px-5 py-2.5 bg-zinc-950 dark:bg-zinc-50 text-white dark:text-zinc-950 rounded hover:bg-zinc-900 dark:hover:bg-zinc-200 font-mono text-xs font-bold uppercase cursor-pointer disabled:opacity-50 select-none shadow-sm transition-colors"
            >
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Saving...</span>
                </>
              ) : (
                <>
                  <Save className="h-4 w-4" />
                  <span>Save Configuration</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Tab 1: Keywords & Anchors */}
        {activeTab === 'keywords' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start w-full">
            {/* LEFT SUB-COLUMN: TF-IDF Extraction (cols: 6) */}
            <div className="lg:col-span-6 flex flex-col gap-6 border border-zinc-200 dark:border-zinc-800 p-5 bg-zinc-50/20 dark:bg-zinc-950/20 rounded">
              <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 pb-2">
                <span className="text-sm font-mono font-bold uppercase tracking-wider text-zinc-800 dark:text-zinc-200">
                  TF-IDF Keyword Extraction
                </span>
                <span className="text-[10px] font-mono text-zinc-400">LOCAL CATALOGS</span>
              </div>

              {/* Step 1: File Uploader */}
              <div className="flex flex-col gap-2.5">
                <span className="text-xs font-mono font-bold uppercase text-zinc-500">
                  1. Select CSV or Excel File
                </span>
                <div className="flex gap-2 min-w-0">
                <input
                  type="file"
                  accept=".csv,.xlsx,.xls"
                  className="hidden"
                  ref={fileInputRef}
                  onChange={handleFileSelect}
                />

                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex-1 min-w-0 flex items-center gap-2 px-3 py-3 border border-dashed border-zinc-300 dark:border-zinc-800 rounded font-mono text-xs cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900/60 transition"
                >
                  <Upload className="h-4 w-4 text-zinc-400 shrink-0" />

                  <span
                    className="min-w-0 flex-1 truncate text-left text-zinc-700 dark:text-zinc-300"
                    title={file?.name}
                  >
                    {file ? file.name : 'Choose catalog file...'}
                  </span>
                </button>

                {file && (
                  <button
                    type="button"
                    onClick={triggerUpload}
                    disabled={uploading}
                    className="shrink-0 px-4 py-2 border rounded font-mono text-xs font-bold uppercase tracking-wider bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-950 hover:bg-zinc-800 dark:hover:bg-zinc-200 disabled:opacity-50 cursor-pointer"
                  >
                    {uploading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      'Upload'
                    )}
                  </button>
                )}
              </div>
                {uploadSuccess && (
                  <span className="text-[10px] font-mono text-green-600 dark:text-green-400 flex items-center gap-1">
                    <Check className="h-3 w-3" /> Catalog parsed. {rowCount !== null ? `${rowCount.toLocaleString()} rows and ` : ''}{columns.length} columns detected.
                  </span>
                )}
              </div>

              {/* Step 2: Column Selection & Parameters (Only after upload) */}
              {uploadSuccess && (
                <div className="flex flex-col gap-4 border-t border-zinc-200 dark:border-zinc-800 pt-4">
                  <span className="text-xs font-mono font-bold uppercase text-zinc-500">
                    2. Configure Text Mining
                  </span>

                  <div className="grid grid-cols-3 gap-2.5">
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] font-mono uppercase text-zinc-400">
                        Title Column
                      </label>
                      <select
                        value={selectedTitleCol}
                        onChange={(e) => setSelectedTitleCol(e.target.value)}
                        className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-1.5 rounded font-mono text-xs w-full focus:outline-none"
                      >
                        {columns.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] font-mono uppercase text-zinc-400">
                        Abstract Column
                      </label>
                      <select
                        value={selectedAbstractCol}
                        onChange={(e) => setSelectedAbstractCol(e.target.value)}
                        className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-1.5 rounded font-mono text-xs w-full focus:outline-none"
                      >
                        {columns.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] font-mono uppercase text-zinc-400 truncate">
                        DOI Column
                      </label>
                      <select
                        value={selectedDoiCol}
                        onChange={(e) => setSelectedDoiCol(e.target.value)}
                        className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-1.5 rounded font-mono text-xs w-full focus:outline-none"
                      >
                        {columns.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Advanced TF-IDF params */}
                  <div className="grid grid-cols-3 gap-2 border-t border-zinc-100 dark:border-zinc-800 pt-3 mt-1">
                    <div className="flex flex-col gap-1">
                      <label className="text-[9px] font-mono uppercase text-zinc-400">
                        N-gram Range
                      </label>
                      <div className="flex items-center gap-1 font-mono text-xs">
                        <input
                          type="number"
                          value={ngramMin}
                          onChange={(e) => setNgramMin(Number(e.target.value))}
                          className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-1 rounded text-center focus:outline-none"
                        />
                        <span className="text-zinc-400">-</span>
                        <input
                          type="number"
                          value={ngramMax}
                          onChange={(e) => setNgramMax(Number(e.target.value))}
                          className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-1 rounded text-center focus:outline-none"
                        />
                      </div>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-[9px] font-mono uppercase text-zinc-400">
                        Min DF (Docs)
                      </label>
                      <input
                        type="number"
                        value={minDF}
                        onChange={(e) => setMinDF(Number(e.target.value))}
                        className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-1 rounded font-mono text-xs text-center focus:outline-none"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-[9px] font-mono uppercase text-zinc-400">
                        {useKeyBERT ? 'Candidate Pool' : 'Top N terms'}
                      </label>
                      <input
                        type="number"
                        value={candidatePool}
                        onChange={(e) => setCandidatePool(Number(e.target.value))}
                        className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-1 rounded font-mono text-xs text-center focus:outline-none"
                      />
                    </div>
                  </div>

                  {/* KeyBERT Semantic Re-ranking Toggle */}
                  <div className="flex flex-col gap-2.5 mt-2 border-t border-zinc-200 dark:border-zinc-800 pt-3">
                    <label className="flex items-center justify-between cursor-pointer select-none">
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={useKeyBERT}
                          onChange={(e) => setUseKeyBERT(e.target.checked)}
                          className="rounded border-zinc-300 text-zinc-900 focus:ring-0 cursor-pointer"
                        />
                        <span className="text-[10px] font-mono font-bold uppercase text-zinc-700 dark:text-zinc-300 flex items-center gap-1.5">
                          <Brain className="h-3.5 w-3.5 text-purple-500" />
                          KeyBERT Semantic Re-Ranking
                        </span>
                      </div>
                      {useKeyBERT && (
                        <span className="px-1.5 py-0.5 rounded bg-purple-50 dark:bg-purple-950/30 text-purple-600 dark:text-purple-400 font-mono text-[9px] font-bold uppercase">
                          Active
                        </span>
                      )}
                    </label>

                    {useKeyBERT && (
                      <div className="flex flex-col gap-2 p-2.5 bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200/80 dark:border-zinc-800 rounded font-mono text-xs">
                        <div className="flex flex-col gap-1">
                          <label className="text-[9px] uppercase text-zinc-400 font-bold">
                            Embedding Model
                          </label>
                          <select
                            value={keybertModel}
                            onChange={(e) => setKeybertModel(e.target.value)}
                            className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-1.5 rounded text-xs focus:outline-none"
                          >
                            <option value="allenai-specter">allenai-specter (Scientific Papers)</option>
                          </select>
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                          <div className="flex flex-col gap-1">
                            <label className="text-[9px] uppercase text-zinc-400 font-bold">
                              Top N terms
                            </label>
                            <input
                              type="number"
                              value={topN}
                              onChange={(e) => setTopN(Number(e.target.value))}
                              className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-1 rounded text-xs text-center focus:outline-none"
                            />
                          </div>
                          <div className="flex flex-col gap-1">
                            <label className="text-[9px] uppercase text-zinc-400 font-bold">
                              Blend Weight (α)
                            </label>
                            <input
                              type="number"
                              step="0.1"
                              min="0"
                              max="1"
                              value={alphaBlend}
                              onChange={(e) => setAlphaBlend(Number(e.target.value))}
                              className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-1 rounded text-xs text-center focus:outline-none"
                            />
                          </div>
                        </div>
                        <span className="text-[9px] text-zinc-400 leading-normal font-sans">
                          Candidate pool extracts {candidatePool} TF-IDF terms and re-ranks them via dense semantic embeddings, returning top {topN} (α={alphaBlend}: {Math.round(alphaBlend*100)}% TF-IDF + {Math.round((1-alphaBlend)*100)}% KeyBERT).
                        </span>
                      </div>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={handleExtractKeywords}
                    disabled={extracting}
                    className="mt-2 w-full flex items-center justify-center gap-2 px-3 py-2 border rounded font-mono text-xs font-bold uppercase bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-950 border-zinc-800 hover:bg-zinc-800 dark:hover:bg-zinc-200 disabled:opacity-50 cursor-pointer"
                  >
                    {extracting ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>Extracting Terms...</span>
                      </>
                    ) : (
                      <span>Extract Scored Keywords</span>
                    )}
                  </button>
                  {anchorsCount !== null && anchorsCount > 0 && (
                    <span className="text-[10px] font-mono text-green-600 dark:text-green-400 flex items-center gap-1 mt-1">
                      <Check className="h-3 w-3" /> Extracted {anchorsCount} anchor DOIs to anchor.txt.
                    </span>
                  )}
                </div>
              )}

              {/* Step 3: Extracted Terms List */}
              {extractedKeywords.length > 0 && (
                <div className="flex flex-col gap-3 border-t border-zinc-200 dark:border-zinc-800 pt-4">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono font-bold uppercase text-zinc-500">
                      3. Select Scored Keywords ({extractedKeywords.filter((k) => k.selected).length}{' '}
                      selected)
                    </span>
                    <div className="flex gap-2 text-[10px] font-mono">
                      <button
                        type="button"
                        onClick={() => selectAllKeywords(true)}
                        className="text-zinc-500 hover:underline cursor-pointer font-semibold"
                      >
                        All
                      </button>
                      <span className="text-zinc-300">|</span>
                      <button
                        type="button"
                        onClick={() => selectAllKeywords(false)}
                        className="text-zinc-500 hover:underline cursor-pointer font-semibold"
                      >
                        None
                      </button>
                    </div>
                  </div>

                  {/* Scrollable checklist */}
                  <div className="max-h-60 overflow-y-auto border border-zinc-200 dark:border-zinc-800 rounded bg-white dark:bg-zinc-950/40 p-1 flex flex-col gap-0.5">
                    {extractedKeywords.map((kw, i) => (
                      <label
                        key={kw.term}
                        className={`flex items-center justify-between p-2 rounded cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900/60 font-mono text-xs select-none ${kw.selected ? 'bg-zinc-50/50 dark:bg-zinc-900/20' : ''}`}
                      >
                        <div className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={kw.selected}
                            onChange={() => toggleKeywordSelection(i)}
                            className="rounded border-zinc-300 text-zinc-900 focus:ring-0 cursor-pointer"
                          />
                          <span className="font-semibold text-zinc-800 dark:text-zinc-200">
                            {kw.term}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          {kw.keybert_score !== undefined ? (
                            <>
                              {alphaBlend > 0 && (
                                <span
                                  className="text-[9px] text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/30 px-1 py-0.5 rounded font-mono font-semibold"
                                  title={`TF-IDF: ${kw.tfidf_score?.toFixed(4) || kw.score.toFixed(4)}`}
                                >
                                  tf: {(kw.tfidf_score ?? kw.score).toFixed(3)}
                                </span>
                              )}
                              <span
                                className="text-[9px] text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-950/30 px-1 py-0.5 rounded font-mono font-semibold"
                                title={`KeyBERT: ${kw.keybert_score.toFixed(4)}`}
                              >
                                KB: {kw.keybert_score.toFixed(3)}
                              </span>
                              <span
                                className="text-[10px] text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/20 px-1.5 py-0.5 rounded font-mono font-bold"
                                title={alphaBlend === 0 ? `KeyBERT Score: ${kw.score.toFixed(4)}` : `Combined (α=${alphaBlend}): ${kw.score.toFixed(4)}`}
                              >
                                c: {kw.score.toFixed(4)}
                              </span>
                            </>
                          ) : (
                            <span
                              className="text-[10px] text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/20 px-1.5 py-0.5 rounded font-mono font-bold"
                              title={`TF-IDF: ${kw.score.toFixed(4)}`}
                            >
                              tf: {kw.score.toFixed(4)}
                            </span>
                          )}
                        </div>
                      </label>
                    ))}
                  </div>

                  <div className="flex flex-col gap-2">

                    <button
                      type="button"
                      onClick={() => handleAutoGenerateQuery()}
                      disabled={generatingQuery}
                      className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-950 font-mono text-xs font-bold uppercase cursor-pointer hover:bg-zinc-800 dark:hover:bg-zinc-200 shadow-sm transition disabled:opacity-50 select-none"
                    >
                      {generatingQuery ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          <span>Classifying & Compiling Query...</span>
                        </>
                      ) : (
                        <>
                          <Brain className="h-4 w-4 text-purple-400 shrink-0" />
                          <span>Auto-Build from Keywords (AI)</span>
                        </>
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={appendKeywordsToQuery}
                      className="w-full flex items-center justify-center gap-2 px-3 py-2 border border-zinc-300 dark:border-zinc-800 rounded bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 font-mono text-xs cursor-pointer select-none font-bold uppercase"
                    >
                      <Copy className="h-3.5 w-3.5 text-zinc-400" />
                      Append Selected (OR)
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* RIGHT SUB-COLUMN: Query Builder, Topics & Anchors Editor (cols: 6) */}
            <div className="lg:col-span-6 flex flex-col gap-6">
              <div className="flex flex-col gap-3 border border-zinc-200 dark:border-zinc-800 p-5 rounded bg-white dark:bg-zinc-950/10">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <label
                    htmlFor="keywords-input"
                    className="text-sm font-mono font-bold uppercase tracking-wider text-zinc-800 dark:text-zinc-200"
                  >
                    Boolean Keywords Query (keywords.txt)
                  </label>
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded border border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 font-mono text-[9px] font-semibold uppercase">
                      Syntax check
                    </span>
                  </div>
                </div>

                <textarea
                  id="keywords-input"
                  disabled={saving}
                  value={keywords}
                  onChange={(e) => {
                    setKeywords(e.target.value)
                    setQueryValid(null)
                    setQueryErrors([])
                  }}
                  className="w-full h-64 p-4 border border-zinc-200 dark:border-zinc-800 bg-zinc-950 text-zinc-300 font-mono text-xs leading-relaxed focus:outline-none focus:ring-0 rounded"
                  placeholder="Enter boolean query using OR / AND / NOT operators..."
                />

                {categorizedBreakdown && (
                  <div className="p-3 bg-zinc-50 dark:bg-zinc-900/40 border border-zinc-200 dark:border-zinc-800 rounded flex flex-col gap-2 text-xs font-mono">
                    <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 pb-1.5">
                      <span className="font-bold uppercase text-[10px] text-zinc-600 dark:text-zinc-300 flex items-center gap-1.5">
                        <Sparkles className="h-3.5 w-3.5 text-amber-500" />
                        AI Categorized Buckets: (Core OR Methods) OR (Mechanisms AND Applications)
                      </span>
                      <button
                        type="button"
                        onClick={() => setCategorizedBreakdown(null)}
                        className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 cursor-pointer"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
                      <div className="flex flex-col gap-0.5 p-2 bg-white dark:bg-zinc-900 rounded border border-zinc-200/60 dark:border-zinc-800">
                        <span className="font-bold text-emerald-600 dark:text-emerald-400 text-[10px] uppercase">
                          1. Core Technology ({categorizedBreakdown['1_core_technology']?.length || 0})
                        </span>
                        <span className="text-zinc-600 dark:text-zinc-400 text-[10px] truncate" title={categorizedBreakdown['1_core_technology']?.join(', ')}>
                          {categorizedBreakdown['1_core_technology']?.join(', ') || '(none)'}
                        </span>
                      </div>
                      <div className="flex flex-col gap-0.5 p-2 bg-white dark:bg-zinc-900 rounded border border-zinc-200/60 dark:border-zinc-800">
                        <span className="font-bold text-blue-600 dark:text-blue-400 text-[10px] uppercase">
                          2. Methods & Tools ({categorizedBreakdown['2_methods_tools']?.length || 0})
                        </span>
                        <span className="text-zinc-600 dark:text-zinc-400 text-[10px] truncate" title={categorizedBreakdown['2_methods_tools']?.join(', ')}>
                          {categorizedBreakdown['2_methods_tools']?.join(', ') || '(none)'}
                        </span>
                      </div>
                      <div className="flex flex-col gap-0.5 p-2 bg-white dark:bg-zinc-900 rounded border border-zinc-200/60 dark:border-zinc-800">
                        <span className="font-bold text-purple-600 dark:text-purple-400 text-[10px] uppercase">
                          3. Mechanisms ({categorizedBreakdown['3_mechanisms']?.length || 0})
                        </span>
                        <span className="text-zinc-600 dark:text-zinc-400 text-[10px] truncate" title={categorizedBreakdown['3_mechanisms']?.join(', ')}>
                          {categorizedBreakdown['3_mechanisms']?.join(', ') || '(none)'}
                        </span>
                      </div>
                      <div className="flex flex-col gap-0.5 p-2 bg-white dark:bg-zinc-900 rounded border border-zinc-200/60 dark:border-zinc-800">
                        <span className="font-bold text-amber-600 dark:text-amber-400 text-[10px] uppercase">
                          4. Applications ({categorizedBreakdown['4_applications']?.length || 0})
                        </span>
                        <span className="text-zinc-600 dark:text-zinc-400 text-[10px] truncate" title={categorizedBreakdown['4_applications']?.join(', ')}>
                          {categorizedBreakdown['4_applications']?.join(', ') || '(none)'}
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between flex-wrap gap-3 mt-1.5">
                  <button
                    type="button"
                    onClick={handleValidateQuery}
                    disabled={validating || !keywords.trim()}
                    className="flex items-center gap-2 px-3.5 py-1.5 border border-zinc-300 dark:border-zinc-800 rounded bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 font-mono text-xs cursor-pointer disabled:opacity-50 select-none font-bold uppercase"
                  >
                    {validating ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>Validating...</span>
                      </>
                    ) : (
                      <>
                        <Play className="h-3 w-3 fill-current" />
                        <span>Validate Query Syntax</span>
                      </>
                    )}
                  </button>

                  <div className="flex items-center">
                    {queryValid === true && (
                      <span className="text-xs font-mono text-green-600 dark:text-green-400 flex items-center gap-1.5">
                        <CheckCircle className="h-4 w-4" /> [VALID] Boolean grammar checks passed.
                      </span>
                    )}
                    {queryValid === false && (
                      <span className="text-xs font-mono text-red-600 dark:text-red-400 flex items-center gap-1.5">
                        <AlertCircle className="h-4 w-4" /> [ERROR]{' '}
                        {queryErrors[0] || 'Syntax validation failed.'}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Anchor DOIs Config Panel & Topics Link */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <SearchableListEditor
                  id="anchors-input"
                  label="Anchor DOIs (anchor.txt)"
                  disabled={saving}
                  value={anchors}
                  onChange={setAnchors}
                  placeholder="10.1016/j.renene..."
                  maxCollapsedItems={6}
                  validate={validateDoi}
                />

                <div className="flex flex-col justify-between p-4 bg-zinc-50/50 dark:bg-zinc-900/20 border border-zinc-200 dark:border-zinc-800 rounded">
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono font-bold uppercase tracking-wider text-zinc-700 dark:text-zinc-300 flex items-center gap-1.5">
                        <Tag className="h-3.5 w-3.5 text-zinc-500" />
                        Target Topic IDs
                      </span>
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">
                        {selectedTopicsList.length} configured
                      </span>
                    </div>
                    <p className="text-[11px] text-zinc-400 font-sans leading-relaxed">
                      Configure OpenAlex Topic IDs (<code>topics.txt</code>) in the dedicated <strong>Topic ID</strong> tab with live cluster discovery, bulk addition, and format validation.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveTab('topics')}
                    className="mt-3 flex items-center justify-center gap-2 px-3 py-2 bg-white dark:bg-zinc-850 hover:bg-zinc-100 dark:hover:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded font-mono text-xs font-bold uppercase text-zinc-800 dark:text-zinc-200 transition cursor-pointer"
                  >
                    <Tag className="h-3.5 w-3.5 text-zinc-500" />
                    <span>Manage Topic IDs in Topic ID Tab &rarr;</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Tab 2: Topic IDs (topics.txt) */}
        {activeTab === 'topics' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start w-full">
            {/* LEFT COLUMN: Topic IDs Config & Editor (cols: 5) */}
            <div className="lg:col-span-5 flex flex-col gap-6">
              <div className="flex flex-col gap-4 border border-zinc-200 dark:border-zinc-800 p-5 rounded bg-white dark:bg-zinc-950/10 shadow-sm">
                <div className="flex flex-col gap-1.5 border-b border-zinc-200 dark:border-zinc-800 pb-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono font-bold uppercase tracking-wider text-zinc-800 dark:text-zinc-200 flex items-center gap-2">
                      <Tag className="h-4 w-4 text-zinc-500" />
                      Target Topic IDs (topics.txt)
                    </span>
                    <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300">
                      {selectedTopicsList.length} Configured
                    </span>
                  </div>
                  <p className="text-[11px] text-zinc-400 font-sans leading-relaxed">
                    Store and manage OpenAlex topic identifiers (format <code>T12345</code>) to scope queries and ingestion pipelines.
                  </p>
                </div>

                {/* Searchable / List & Raw Topic Editor */}
                <div className="flex flex-col gap-3">
                  <SearchableListEditor
                    id="dedicated-topics-input"
                    label="Topic IDs (topics.txt)"
                    disabled={saving}
                    value={topics}
                    onChange={setTopics}
                    placeholder="e.g. T10020, T10145..."
                    maxCollapsedItems={12}
                    validate={validateTopic}
                  />
                </div>

                {/* Quick Helper / Info Card */}
                <div className="p-3 bg-zinc-50/50 dark:bg-zinc-900/30 rounded border border-zinc-200/60 dark:border-zinc-800/60 text-[11px] font-mono text-zinc-500 dark:text-zinc-400 flex flex-col gap-1.5">
                  <div className="font-bold text-zinc-700 dark:text-zinc-300 flex items-center gap-1.5 text-[10px] uppercase">
                    <Sparkles className="h-3 w-3 text-amber-500" /> Topic ID Format Guide
                  </div>
                  <p className="text-[10px] font-sans text-zinc-500 dark:text-zinc-400">
                    OpenAlex classifies papers into primary topics. Each Topic ID begins with a &apos;T&apos; followed by 5 digits (e.g., <code>T10020</code> for Lithium-ion batteries).
                  </p>
                  <p className="text-[10px] font-sans text-zinc-400">
                    You can add IDs manually above or use the <strong>OpenAlex Topic Discovery</strong> tool on the right to discover and select topics automatically.
                  </p>
                </div>
              </div>
            </div>

            {/* RIGHT COLUMN: OpenAlex Topic Discovery & Bulk Import (cols: 7) */}
            <div className="lg:col-span-7 flex flex-col gap-6">
              <div className="flex flex-col gap-4 border border-zinc-200 dark:border-zinc-800 p-5 rounded bg-white dark:bg-zinc-950/10 shadow-sm">
                <div className="flex justify-between items-start border-b border-zinc-200 dark:border-zinc-800 pb-3">
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-mono font-bold uppercase tracking-wider text-zinc-800 dark:text-zinc-200 flex items-center gap-2">
                      <PieChart className="h-4 w-4 text-zinc-500" />
                      OpenAlex Topic Discovery & Cluster Analysis
                    </span>
                    <p className="text-[11px] text-zinc-400 font-sans">
                      Fetch research topics from OpenAlex matching active keywords to inspect cluster sizes and bulk-add to <code>topics.txt</code>.
                    </p>
                  </div>
                </div>

                {/* Trigger & Discovery Action Buttons */}
                <div className="flex flex-col gap-2.5">
                  <div className="flex flex-col sm:flex-row gap-2.5">
                    {checkingTopics ? (
                      <button
                        type="button"
                        onClick={handleCancelTopics}
                        className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 border rounded font-mono text-xs font-bold uppercase bg-red-600 hover:bg-red-700 text-white border-red-700 transition cursor-pointer shadow-sm animate-pulse"
                      >
                        <Square className="h-3.5 w-3.5 fill-current" />
                        Stop Topic Analysis
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={handleGetOpenAlexTopics}
                          disabled={checkingCount || !keywords.trim() || queryValid === false}
                          className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-950 border border-zinc-800 rounded font-mono text-xs font-bold uppercase hover:bg-zinc-800 dark:hover:bg-zinc-200 disabled:opacity-50 cursor-pointer transition select-none shadow-sm"
                          title="Fetch top topic clusters matching the keyword query"
                        >
                          <PieChart className="h-3.5 w-3.5" />
                          <span>Discover from Keywords</span>
                        </button>

                        <button
                          type="button"
                          onClick={handleGetTopicsFromAnchors}
                          disabled={checkingCount || !anchors.trim()}
                          className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 border border-zinc-300 dark:border-zinc-700 rounded font-mono text-xs font-bold uppercase hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50 cursor-pointer transition select-none shadow-sm"
                          title="Extract and classify all primary topics directly from the configured anchor papers (anchor.txt)"
                        >
                          <Bookmark className="h-3.5 w-3.5 text-zinc-500" />
                          <span>Fetch from Anchors</span>
                        </button>
                      </>
                    )}
                  </div>

                  {/* Bulk Add Shortcuts when topics are loaded */}
                  {openalexTopics && openalexTopics.length > 0 && (
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-zinc-100 dark:border-zinc-800/80">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[10px] font-mono uppercase text-zinc-400 font-bold">Bulk Add:</span>
                        {topicDiscoverySource === 'anchors' && (
                          <>
                            <button
                              type="button"
                              onClick={handleAddCriticalAndHighTopics}
                              className="px-2 py-1 border border-amber-300 dark:border-amber-800/60 bg-amber-50/50 dark:bg-amber-950/20 hover:bg-amber-100 dark:hover:bg-amber-900/40 rounded font-mono text-[10px] uppercase font-bold text-amber-800 dark:text-amber-300 cursor-pointer"
                              title="Add all Critical & High coverage topics"
                            >
                              + Critical & High
                            </button>
                            <button
                              type="button"
                              onClick={handleAddAllNewTopics}
                              className="px-2 py-1 border border-emerald-300 dark:border-emerald-800/60 bg-emerald-50/50 dark:bg-emerald-950/20 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 rounded font-mono text-[10px] uppercase font-bold text-emerald-800 dark:text-emerald-300 cursor-pointer"
                              title="Add all newly discovered topics (not already in topics.txt)"
                            >
                              + All NEW
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          onClick={() => handleAddTopNTopics(5)}
                          className="px-2 py-1 border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800 rounded font-mono text-[10px] uppercase font-bold text-zinc-700 dark:text-zinc-300 cursor-pointer"
                          title="Add top 5 most frequent topics to topics.txt"
                        >
                          + Top 5
                        </button>
                        <button
                          type="button"
                          onClick={() => handleAddTopNTopics(10)}
                          className="px-2 py-1 border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800 rounded font-mono text-[10px] uppercase font-bold text-zinc-700 dark:text-zinc-300 cursor-pointer"
                          title="Add top 10 most frequent topics to topics.txt"
                        >
                          + Top 10
                        </button>
                        <button
                          type="button"
                          onClick={handleAddAllFoundTopics}
                          className="px-2 py-1 border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800 rounded font-mono text-[10px] uppercase font-bold text-zinc-700 dark:text-zinc-300 cursor-pointer"
                          title="Add all discovered topics to topics.txt"
                        >
                          + All ({openalexTopics.length})
                        </button>
                      </div>

                      <button
                        type="button"
                        onClick={handleDownloadTopicsCSV}
                        className="flex items-center gap-1.5 text-[10px] font-mono uppercase text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200 cursor-pointer font-bold border border-zinc-200 dark:border-zinc-800 px-2.5 py-1 rounded bg-zinc-50 hover:bg-zinc-100 dark:bg-zinc-900/50 dark:hover:bg-zinc-850"
                      >
                        <Download className="h-3 w-3" />
                        Download CSV
                      </button>
                    </div>
                  )}
                </div>

                {/* Topics Table or Status */}
                {checkingTopics ? (
                  <div className="py-12 border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/10 rounded flex flex-col items-center justify-center gap-2">
                    <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
                    <span className="text-xs font-mono text-zinc-500 uppercase tracking-wider font-bold">
                      {topicDiscoverySource === 'anchors'
                        ? 'Analyzing Anchor Papers & Classifying Research Topics (topic-search)...'
                        : 'Querying OpenAlex Topic Clusters...'}
                    </span>
                  </div>
                ) : openalexTopics !== null ? (
                  openalexTopics.length === 0 ? (
                    <div className="py-8 text-center text-xs font-mono text-zinc-400 uppercase border border-zinc-100 dark:border-zinc-800 rounded">
                      No matching topic distribution data returned
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3 w-full">
                      {/* Discovery Source & Stats Banner */}
                      <div className="flex flex-wrap items-center justify-between gap-2 p-2 bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200/80 dark:border-zinc-800 rounded text-xs font-mono">
                        <div className="flex items-center gap-2">
                          {topicDiscoverySource === 'anchors' ? (
                            <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 border border-amber-300/50 dark:border-amber-800/50 flex items-center gap-1">
                              <Bookmark className="h-3 w-3" /> Anchor Papers Topic Extraction (topic-search)
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300 border border-emerald-300/50 dark:border-emerald-800/50 flex items-center gap-1">
                              <PieChart className="h-3 w-3" /> Keywords Topic Discovery
                            </span>
                          )}
                          <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                            <strong>{openalexTopicsTotal?.toLocaleString() || openalexTopics.length}</strong> unique topics across{' '}
                            <strong>{openalexTopicsTotalPapers?.toLocaleString()}</strong> {topicDiscoverySource === 'anchors' ? 'anchor papers' : 'papers'}.
                          </span>
                        </div>
                      </div>

                      <div className="overflow-x-auto w-full border border-zinc-150 dark:border-zinc-800 rounded max-h-[440px] overflow-y-auto">
                        <table className="w-full text-left border-collapse text-xs font-sans">
                          <thead className="sticky top-0 bg-zinc-50 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800 text-[10px] font-mono uppercase text-zinc-400 z-10">
                            <tr>
                              <th className="p-3 w-12 text-center font-bold">Target</th>
                              <th className="p-3 w-24">Topic ID</th>
                              {topicDiscoverySource === 'anchors' && (
                                <>
                                  <th className="p-3 w-20 text-center">Status</th>
                                  <th className="p-3 w-28">Importance</th>
                                </>
                              )}
                              <th className="p-3">Topic & Hierarchy</th>
                              <th className="p-3 text-right w-24 font-bold">
                                {topicDiscoverySource === 'anchors' ? 'Anchors' : 'Papers'}
                              </th>
                              <th className="p-3 text-right w-32 font-bold">
                                {topicDiscoverySource === 'anchors' ? 'Coverage %' : 'Share %'}
                              </th>
                              {topicDiscoverySource === 'anchors' && (
                                <th className="p-3 w-36">Example DOI</th>
                              )}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                            {openalexTopics.slice(0, showAllTopics ? openalexTopics.length : 15).map((topic) => {
                              const selected = isTopicSelected(topic.topic_id)
                              const isNew = topic.status === 'NEW' || (!topic.status && !selected)
                              return (
                                <tr
                                  key={topic.topic_id}
                                  className={`hover:bg-zinc-50/50 dark:hover:bg-zinc-900/20 transition-colors ${
                                    selected ? 'bg-zinc-50/80 dark:bg-zinc-900/40' : ''
                                  }`}
                                >
                                  <td className="p-3 text-center w-12">
                                    <input
                                      type="checkbox"
                                      checked={selected}
                                      onChange={(e) => handleToggleTopic(topic.topic_id, e.target.checked)}
                                      className="rounded border-zinc-300 text-zinc-900 focus:ring-0 cursor-pointer"
                                    />
                                  </td>
                                  <td className="p-3 font-mono text-[11px]">
                                    <span className="bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded text-zinc-800 dark:text-zinc-300 font-semibold border border-zinc-200/50 dark:border-zinc-800">
                                      {topic.topic_id}
                                    </span>
                                  </td>

                                  {topicDiscoverySource === 'anchors' && (
                                    <>
                                      <td className="p-3 text-center font-mono text-[10px]">
                                        {isNew ? (
                                          <span className="px-1.5 py-0.5 rounded font-bold bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300 border border-emerald-300/40">
                                            NEW
                                          </span>
                                        ) : (
                                          <span className="px-1.5 py-0.5 rounded font-medium bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                                            Present
                                          </span>
                                        )}
                                      </td>
                                      <td className="p-3 font-mono text-[10px]">
                                        {topic.importance ? (
                                          <span
                                            className={`font-semibold ${
                                              topic.importance.includes('Critical')
                                                ? 'text-red-600 dark:text-red-400'
                                                : topic.importance.includes('High')
                                                ? 'text-amber-600 dark:text-amber-400'
                                                : topic.importance.includes('Medium')
                                                ? 'text-blue-600 dark:text-blue-400'
                                                : 'text-zinc-400'
                                            }`}
                                          >
                                            {topic.importance}
                                          </span>
                                        ) : (
                                          '—'
                                        )}
                                      </td>
                                    </>
                                  )}

                                  <td className="p-3 font-medium text-zinc-900 dark:text-zinc-100 max-w-[220px]" title={`${topic.display_name} — ${topic.description || ''}`}>
                                    <div className="font-semibold truncate">{topic.display_name}</div>
                                    {(topic.subfield || topic.field) && (
                                      <div className="text-[10px] text-zinc-400 truncate">
                                        {[topic.subfield, topic.field, topic.domain].filter(Boolean).join(' › ')}
                                      </div>
                                    )}
                                    {topic.description && !topic.subfield && (
                                      <div className="text-[10px] text-zinc-400 truncate">{topic.description}</div>
                                    )}
                                  </td>

                                  <td className="p-3 text-right font-mono font-medium text-zinc-950 dark:text-zinc-50">
                                    {(topic.frequency ?? topic.paper_count).toLocaleString()}
                                  </td>

                                  <td className="p-3">
                                    <div className="flex items-center justify-end gap-2 w-full">
                                      <div className="w-14 bg-zinc-200 dark:bg-zinc-800 h-1.5 rounded-full overflow-hidden shrink-0">
                                        <div
                                          className={`h-full rounded-full ${
                                            topicDiscoverySource === 'anchors' ? 'bg-amber-500' : 'bg-zinc-900 dark:bg-zinc-100'
                                          }`}
                                          style={{ width: `${Math.min(topic.coverage ?? topic.percentage, 100)}%` }}
                                        />
                                      </div>
                                      <span className="font-mono text-[11px] text-zinc-600 dark:text-zinc-400 w-12 text-right">
                                        {(topic.coverage ?? topic.percentage).toFixed(1)}%
                                      </span>
                                    </div>
                                  </td>

                                  {topicDiscoverySource === 'anchors' && (
                                    <td className="p-3 font-mono text-[10px] text-zinc-500 dark:text-zinc-400 truncate max-w-[140px]" title={topic.example_doi || ''}>
                                      {topic.example_doi ? (
                                        <span className="bg-zinc-100 dark:bg-zinc-900 px-1 py-0.5 rounded border border-zinc-200/40 dark:border-zinc-800 truncate block">
                                          {topic.example_doi}
                                        </span>
                                      ) : (
                                        '—'
                                      )}
                                    </td>
                                  )}
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>

                      {openalexTopics.length > 15 && (
                        <button
                          type="button"
                          onClick={() => setShowAllTopics(!showAllTopics)}
                          className="mx-auto mt-1 px-4 py-1.5 border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900/50 rounded font-mono text-[10px] uppercase font-bold text-zinc-600 dark:text-zinc-400 cursor-pointer"
                        >
                          {showAllTopics ? 'Show Less (Top 15)' : `Show All ${openalexTopics.length} Discovered Topics`}
                        </button>
                      )}
                    </div>
                  )
                ) : (
                  <div className="py-10 border border-dashed border-zinc-200 dark:border-zinc-800 rounded text-center flex flex-col items-center justify-center gap-2 text-zinc-400">
                    <PieChart className="h-6 w-6 text-zinc-300 dark:text-zinc-700" />
                    <span className="text-xs font-mono uppercase font-bold">No Topics Discovered Yet</span>
                    <span className="text-[11px] font-sans text-zinc-400 max-w-md">
                      Click <strong>Discover from Keywords</strong> to cluster your keyword query results, or <strong>Fetch from Anchors</strong> to extract topic IDs directly from your anchor benchmark papers.
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Tab 3: Execution & Search Analysis */}
        {activeTab === 'execution' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start w-full">
            {/* LEFT COLUMN: OpenAlex Search & Anchor Validation (cols: 6) */}
            <div className="lg:col-span-6 flex flex-col gap-6">
              {/* Volume Estimation & Anchor Verification */}
              <div className="flex flex-col gap-4 border border-zinc-200 dark:border-zinc-800 p-5 rounded bg-white dark:bg-zinc-950/10 shadow-sm">
                <div className="flex flex-col gap-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono font-bold uppercase text-zinc-500">
                      OpenAlex Works Search & Anchor Validation
                    </span>
                    <label className="flex items-center gap-2 cursor-pointer select-none font-mono text-[10px] text-zinc-500 font-bold uppercase">
                      <input
                        type="checkbox"
                        checked={checkAnchors}
                        onChange={() => setCheckAnchors((prev) => !prev)}
                        className="rounded border-zinc-300 dark:border-zinc-800 text-zinc-900 focus:ring-0 cursor-pointer"
                      />
                      <span>Validate Anchor Papers</span>
                    </label>
                  </div>
                  <p className="text-[11px] text-zinc-400 font-sans leading-relaxed">
                    Execute keyword search (<code>openalex search</code>) or topic-filtered search (<code>openalex search-filtered</code>) against the live OpenAlex API.
                  </p>

                  {/* Results badge / panel */}
                  <div className="min-h-[7rem] py-4 px-4 border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/10 rounded flex flex-col items-center justify-center gap-2 mt-1">
                    {checkingCount ? (
                      <div className="flex flex-col items-center justify-center gap-2 py-4">
                        <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
                        <span className="text-[10px] font-mono text-zinc-400 uppercase tracking-widest font-bold">
                          Querying Live OpenAlex API...
                        </span>
                      </div>
                    ) : openalexCount !== null ? (
                      <div className="w-full flex flex-col items-center gap-3">
                        {/* Search Mode indicator badge */}
                        <div className="flex items-center gap-2">
                          {searchMode === 'keyword' ? (
                            <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300 border border-emerald-300/50 dark:border-emerald-800/50 flex items-center gap-1">
                              <Search className="h-3 w-3" /> Keyword Search (openalex search)
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase bg-indigo-100 text-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-300 border border-indigo-300/50 dark:border-indigo-800/50 flex items-center gap-1">
                              <Filter className="h-3 w-3" /> Filtered Search (openalex search-filtered)
                            </span>
                          )}
                        </div>

                        <div className="flex flex-col items-center justify-center gap-0.5">
                          <span className="text-3xl font-mono font-bold text-zinc-900 dark:text-zinc-50">
                            {openalexCount.toLocaleString()}
                          </span>
                          <span className="text-[9px] font-mono text-green-600 dark:text-green-400 uppercase tracking-widest font-bold">
                            MATCHING WORKS FOUND
                          </span>
                        </div>

                        {/* Search Parameters Summary Pills */}
                        <div className="flex flex-wrap items-center justify-center gap-1.5 text-[10px] font-mono text-zinc-500 dark:text-zinc-400">
                          <span className="px-2 py-0.5 bg-zinc-100 dark:bg-zinc-800 rounded">
                            📅 {dateFrom} → {dateTo}
                          </span>
                          <span className="px-2 py-0.5 bg-zinc-100 dark:bg-zinc-800 rounded">
                            📄 {Object.values(selectedDocTypes).filter(Boolean).length} doc types
                          </span>
                          {searchMode === 'filtered' && (
                            <span className="px-2 py-0.5 bg-zinc-100 dark:bg-zinc-800 rounded">
                              🏷️ {topics.split('\n').map((t) => t.trim()).filter((t) => t && !t.startsWith('#')).length} topics
                            </span>
                          )}
                        </div>

                        {/* OpenAlex Filter Query String Preview */}
                        {activeFilterString && (
                          <div className="w-full mt-1 p-2 bg-zinc-100 dark:bg-zinc-900 rounded border border-zinc-200 dark:border-zinc-800 flex items-center justify-between gap-2 text-[10px] font-mono text-zinc-600 dark:text-zinc-400">
                            <span className="truncate flex-1" title={activeFilterString}>
                              <strong className="text-zinc-700 dark:text-zinc-300">Filter: </strong>
                              {activeFilterString}
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                navigator.clipboard.writeText(activeFilterString)
                                setCopiedFilter(true)
                                setTimeout(() => setCopiedFilter(false), 2000)
                              }}
                              className="shrink-0 p-1 hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 transition cursor-pointer"
                              title="Copy OpenAlex filter query"
                            >
                              {copiedFilter ? (
                                <Check className="h-3.5 w-3.5 text-green-500" />
                              ) : (
                                <Copy className="h-3.5 w-3.5" />
                              )}
                            </button>
                          </div>
                        )}

                        {/* Anchor Paper Coverage */}
                        {anchorsTotal !== null && anchorsTotal > 0 && (
                          <div className="border-t border-zinc-200 dark:border-zinc-800 pt-3 mt-1 w-full flex flex-col gap-1.5">
                            <div className="flex justify-between items-center text-[10px] font-mono uppercase tracking-wider text-zinc-400">
                              <span>Anchor Paper Match</span>
                              <span className="font-bold text-zinc-700 dark:text-zinc-300">
                                {anchorsMatched} / {anchorsTotal} (
                                {anchorsTotal > 0
                                  ? Math.round((anchorsMatched! / anchorsTotal) * 100)
                                  : 0}
                                %)
                              </span>
                            </div>
                            <div className="w-full bg-zinc-200 dark:bg-zinc-800 h-1.5 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all duration-300 ${
                                  anchorsMatched === anchorsTotal ? 'bg-green-500' : 'bg-amber-500'
                                }`}
                                style={{
                                  width: `${anchorsTotal > 0 ? (anchorsMatched! / anchorsTotal) * 100 : 0}%`,
                                }}
                              />
                            </div>
                            {anchorsMissing.length > 0 && (
                              <div className="mt-1 flex flex-col gap-1">
                                <span className="text-[9px] font-mono text-amber-600 dark:text-amber-400 uppercase tracking-wide flex items-center gap-1 font-semibold">
                                  <AlertCircle className="h-3 w-3 shrink-0" /> Missing{' '}
                                  {anchorsMissing.length} anchors from results
                                </span>
                                <div className="bg-amber-50/50 dark:bg-amber-950/10 border border-amber-200/50 dark:border-amber-900/30 p-2 rounded text-[10px] font-mono text-zinc-500 dark:text-zinc-400 max-h-24 overflow-y-auto w-full text-left">
                                  {anchorsMissing.map((doi) => (
                                    <div key={doi} className="truncate">
                                      • {doi}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs font-mono text-zinc-400 uppercase tracking-wider py-4">
                        No Search Executed Yet
                      </span>
                    )}
                  </div>
                </div>

                {/* Primary Action Buttons */}
                <div className="flex flex-col gap-2">
                  <div className="flex gap-2.5">
                    <button
                      type="button"
                      onClick={() => handleGetOpenAlexCount('keyword')}
                      disabled={checkingCount || checkingTopics || downloadingSample || !keywords.trim() || queryValid === false}
                      className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 border rounded font-mono text-xs font-bold uppercase bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-950 border-zinc-800 hover:bg-zinc-800 dark:hover:bg-zinc-200 disabled:opacity-50 cursor-pointer transition select-none shadow-sm"
                      title="Run keyword-only search without topic filters (openalex search)"
                    >
                      {checkingCount && searchMode === 'keyword' ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Search className="h-3.5 w-3.5 shrink-0" />
                      )}
                      <span>Keyword Search</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => handleGetOpenAlexCount('filtered')}
                      disabled={checkingCount || checkingTopics || downloadingSample || !keywords.trim() || queryValid === false}
                      className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 border rounded font-mono text-xs font-bold uppercase bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-200 border-zinc-300 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-850 disabled:opacity-50 cursor-pointer transition select-none shadow-sm"
                      title="Run search with keywords AND topics filter (openalex search-filtered)"
                    >
                      {checkingCount && searchMode === 'filtered' ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Filter className="h-3.5 w-3.5 shrink-0" />
                      )}
                      <span>Filtered Search</span>
                    </button>
                  </div>

                  <div className="flex flex-col sm:flex-row gap-2">
                    <button
                      type="button"
                      onClick={handleDownloadSample}
                      disabled={checkingCount || checkingTopics || downloadingSample || !keywords.trim() || queryValid === false}
                      className="flex-1 flex items-center justify-center gap-2 px-3 py-2 border rounded font-mono text-xs font-bold uppercase bg-zinc-50 dark:bg-zinc-900/60 text-zinc-700 dark:text-zinc-300 border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50 cursor-pointer transition select-none"
                      title="Download a random sample of matching works as CSV (openalex sample)"
                    >
                      {downloadingSample ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Download className="h-3.5 w-3.5 shrink-0" />
                      )}
                      <span>Download Sample CSV</span>
                    </button>

                    <button
                      type="button"
                      onClick={handleOpenDownloadPreflight}
                      disabled={checkingCount || checkingTopics || downloadingSample || syncing || fetchingDownloadInfo || !keywords.trim() || queryValid === false}
                      className="flex-1 flex items-center justify-center gap-2 px-3 py-2 border rounded font-mono text-xs font-bold uppercase bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-950 border-zinc-800 dark:border-zinc-200 hover:bg-zinc-800 dark:hover:bg-zinc-200 disabled:opacity-50 cursor-pointer transition select-none shadow-sm"
                      title="Download all matching papers to JSONL (openalex download)"
                    >
                      {fetchingDownloadInfo ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Download className="h-3.5 w-3.5 shrink-0" />
                      )}
                      <span>Download Papers (JSONL)</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* RIGHT COLUMN: Topic Distribution Analysis (cols: 6) */}
            <div className="lg:col-span-6 flex flex-col gap-6">
              <div className="flex flex-col gap-4 border border-zinc-200 dark:border-zinc-800 p-5 rounded bg-white dark:bg-zinc-950/10">
                <div className="flex flex-col gap-2.5">
                  <span className="text-xs font-mono font-bold uppercase text-zinc-500">
                    Topic Grouping & Distribution Analysis
                  </span>
                  <p className="text-[11px] text-zinc-400 font-sans leading-relaxed">
                    Fetch sorted counts of the top 200 research topics matching keywords. Concurrent API requests resolve full names/descriptions.
                  </p>

                  {/* Topics summaries badge */}
                  <div className="min-h-[6rem] py-4 px-3 border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/10 rounded flex flex-col items-center justify-center gap-1 mt-1">
                    {checkingTopics ? (
                      <div className="flex flex-col items-center justify-center gap-2">
                        <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
                        <span className="text-[9px] font-mono text-zinc-400 uppercase tracking-widest font-bold">
                          ANALYZING TOPICS...
                        </span>
                        <span className="text-[10px] font-sans text-zinc-400">
                          Fetching OpenAlex topic clusters... Click Stop below to cancel.
                        </span>
                      </div>
                    ) : openalexTopics !== null ? (
                      <div className="w-full flex flex-col items-center gap-2.5">
                        <div className="flex flex-col items-center justify-center gap-1">
                          <span className="text-2xl font-mono font-bold text-zinc-900 dark:text-zinc-50">
                            {openalexTopicsTotal?.toLocaleString() || 0}
                          </span>
                          <span className="text-[9px] font-mono text-zinc-400 uppercase tracking-widest font-bold">
                            UNIQUE TOPICS FOUND
                          </span>
                        </div>
                        <span className="text-[10px] font-sans text-zinc-400">
                          Mapped across <span className="font-semibold text-zinc-700 dark:text-zinc-300">{openalexTopicsTotalPapers?.toLocaleString()}</span> papers.
                        </span>
                      </div>
                    ) : (
                      <span className="text-xs font-mono text-zinc-400 uppercase tracking-wider">
                        No Topic Data Yet
                      </span>
                    )}
                  </div>
                </div>

                {checkingTopics ? (
                  <button
                    type="button"
                    onClick={handleCancelTopics}
                    className="w-full flex items-center justify-center gap-2 px-3 py-2 border rounded font-mono text-xs font-bold uppercase bg-red-600 hover:bg-red-700 text-white border-red-700 transition cursor-pointer shadow-sm animate-pulse"
                    title="Stop / Cancel Topic Analysis"
                  >
                    <Square className="h-3.5 w-3.5 fill-current" />
                    Stop / Cancel Analysis
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleGetOpenAlexTopics}
                    disabled={checkingCount || !keywords.trim() || queryValid === false}
                    className="w-full flex items-center justify-center gap-2 px-3 py-2 border rounded font-mono text-xs font-bold uppercase bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-950 border-zinc-800 hover:bg-zinc-800 dark:hover:bg-zinc-200 disabled:opacity-50 cursor-pointer transition select-none"
                  >
                    <PieChart className="h-3.5 w-3.5" />
                    Get Topic Distribution
                  </button>
                )}
              </div>
            </div>

            {/* FULL-WIDTH ROW: Sync Diagnostics Console (cols: 12) */}
            <div className="lg:col-span-12 flex flex-col gap-4 border border-zinc-200 dark:border-zinc-800 p-5 rounded mt-2 w-full bg-white dark:bg-zinc-950/10">
              <div className="flex justify-between items-center border-b border-zinc-200 dark:border-zinc-800 pb-3 flex-wrap gap-3">
                <div className="flex flex-col gap-1">
                  <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-zinc-900 dark:text-zinc-50 flex items-center gap-2">
                    <Terminal className="h-4 w-4 text-zinc-500" />
                    Ingestion Pipeline & Sync Diagnostics
                  </h3>
                  <p className="text-[11px] text-zinc-400 font-sans">
                    Execute the OpenAlex ingestion pipeline for the active configuration, download publications, and populate the DuckDB database.
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {syncing && (
                    <button
                      type="button"
                      onClick={handleCancelPipeline}
                      className="flex items-center gap-1.5 px-3.5 py-2 rounded font-mono text-xs font-bold uppercase border border-rose-300 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-400 hover:bg-rose-100 dark:hover:bg-rose-950/50 cursor-pointer transition shadow-sm"
                      title="Stop / Cancel running pipeline"
                    >
                      <Square className="h-3.5 w-3.5 fill-current" />
                      <span>Stop Pipeline</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={handleSyncToggle}
                    className={`flex items-center gap-2 px-4 py-2 rounded font-mono text-xs font-bold uppercase border transition-all ${
                      syncing
                        ? 'bg-zinc-200 dark:bg-zinc-800 border-zinc-300 dark:border-zinc-700 text-zinc-500 hover:bg-zinc-350 dark:hover:bg-zinc-700 cursor-not-allowed'
                        : 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-950 border-zinc-800 dark:border-zinc-200 hover:bg-zinc-800 dark:hover:bg-zinc-200 cursor-pointer shadow-sm'
                    }`}
                  >
                    {syncing ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>Syncing Pipeline...</span>
                      </>
                    ) : (
                      <>
                        <Play className="h-3.5 w-3.5 fill-current" />
                        <span>Run OpenAlex Sync</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Console Progress Bar */}
              {(syncing || pipelineProgress > 0) && (
                <div className="h-1.5 w-full bg-zinc-150 dark:bg-zinc-900 rounded overflow-hidden">
                  <div
                    className="h-full bg-zinc-900 dark:bg-zinc-100 transition-all duration-300 ease-out"
                    style={{ width: `${Math.min(pipelineProgress, 100)}%` }}
                  ></div>
                </div>
              )}

              {/* Console Terminal Screen */}
              <div
                ref={consoleContainerRef}
                className="bg-zinc-950 text-zinc-300 p-4 h-64 overflow-y-auto font-mono text-[11px] leading-relaxed flex flex-col gap-1 rounded border border-zinc-900 select-text"
              >
                {pipelineLogs.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-zinc-650 select-none">
                    <span>Diagnostics Console Idle. Click "Run OpenAlex Sync" to initiate.</span>
                  </div>
                ) : (
                  <>
                    {pipelineLogs.map((log, index) => (
                      <div
                        key={index}
                        className={
                          log.includes('[SUCCESS]')
                            ? 'text-emerald-400'
                            : log.includes('[ERROR]')
                              ? 'text-rose-400 animate-pulse'
                              : log.includes('[INFO]')
                                ? 'text-zinc-500'
                                : ''
                        }
                      >
                        {log}
                      </div>
                    ))}
                    {pipelineProgress >= 100 && (
                      <div className="text-emerald-400 font-bold flex items-center gap-1.5 mt-1">
                        <CheckCircle className="h-3.5 w-3.5 shrink-0" />
                        <span>[SUCCESS] Database sync completed successfully. All services ready.</span>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* FULL-WIDTH ROW: OpenAlex Topics Distribution Table (cols: 12) */}
            {openalexTopics !== null && (
              <div className="lg:col-span-12 flex flex-col gap-4 border border-zinc-200 dark:border-zinc-800 p-5 rounded mt-2 w-full bg-white dark:bg-zinc-950/10">
                <div className="flex justify-between items-center border-b border-zinc-200 dark:border-zinc-800 pb-3">
                  <div className="flex flex-col gap-1">
                    <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-zinc-900 dark:text-zinc-50 flex items-center gap-2">
                      <PieChart className="h-4 w-4 text-zinc-500" />
                      OpenAlex Topic Breakdown Results
                    </h3>
                    <p className="text-[11px] text-zinc-400 font-sans">
                      Showing top research topics (up to 200) in matching publications.
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={handleDownloadTopicsCSV}
                      className="flex items-center gap-1.5 text-[10px] font-mono uppercase text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200 cursor-pointer font-bold border border-zinc-200 dark:border-zinc-800 px-2.5 py-1 rounded bg-zinc-50 hover:bg-zinc-100 dark:bg-zinc-900/50 dark:hover:bg-zinc-850 transition-colors"
                    >
                      <Download className="h-3 w-3" />
                      Download CSV
                    </button>
                    <button
                      type="button"
                      onClick={() => setOpenalexTopics(null)}
                      className="text-[10px] font-mono uppercase text-zinc-400 hover:text-zinc-650 dark:hover:text-zinc-200 cursor-pointer"
                    >
                      Clear Results
                    </button>
                  </div>
                </div>
                {openalexTopics.length === 0 ? (
                  <div className="py-8 text-center text-xs font-mono text-zinc-400 uppercase">
                    No topic distribution data retrieved
                  </div>
                ) : (
                  <div className="flex flex-col gap-3 w-full">
                    <div className="overflow-x-auto w-full border border-zinc-100 dark:border-zinc-800 rounded">
                      <table className="w-full text-left border-collapse text-xs font-sans">
                        <thead>
                          <tr className="bg-zinc-50 dark:bg-zinc-900/50 border-b border-zinc-150 dark:border-zinc-800 text-[10px] font-mono uppercase text-zinc-400">
                            <th className="p-3 w-16 text-center font-bold">Target</th>
                            <th className="p-3 w-28">Topic ID</th>
                            <th className="p-3">Topic Name</th>
                            <th className="p-3">Description</th>
                            <th className="p-3 text-right w-32 font-bold">Paper Count</th>
                            <th className="p-3 text-right w-40 font-bold">Percentage</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                          {openalexTopics.slice(0, showAllTopics ? openalexTopics.length : 10).map((topic) => (
                            <tr key={topic.topic_id} className="hover:bg-zinc-50/55 dark:hover:bg-zinc-900/10">
                              <td className="p-3 text-center w-16">
                                <input
                                  type="checkbox"
                                  checked={isTopicSelected(topic.topic_id)}
                                  onChange={(e) => handleToggleTopic(topic.topic_id, e.target.checked)}
                                  className="rounded border-zinc-300 text-zinc-900 focus:ring-0 cursor-pointer"
                                />
                              </td>
                              <td className="p-3 font-mono text-[11px]">
                                <span className="bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded text-zinc-800 dark:text-zinc-300 font-semibold border border-zinc-200/50 dark:border-zinc-800">
                                  {topic.topic_id}
                                </span>
                              </td>
                              <td className="p-3 font-medium text-zinc-900 dark:text-zinc-100 max-w-[200px] truncate font-semibold" title={topic.display_name}>
                                {topic.display_name}
                              </td>
                              <td className="p-3 text-zinc-400 dark:text-zinc-500 max-w-xs truncate" title={topic.description}>
                                {topic.description || '—'}
                              </td>
                              <td className="p-3 text-right font-mono font-medium text-zinc-950 dark:text-zinc-50">
                                {topic.paper_count.toLocaleString()}
                              </td>
                              <td className="p-3">
                                <div className="flex items-center justify-end gap-3 w-full">
                                  <div className="w-20 bg-zinc-200 dark:bg-zinc-800 h-1.5 rounded-full overflow-hidden shrink-0">
                                    <div
                                      className="bg-zinc-900 dark:bg-zinc-100 h-full rounded-full"
                                      style={{ width: `${topic.percentage}%` }}
                                    />
                                  </div>
                                  <span className="font-mono text-[11px] text-zinc-600 dark:text-zinc-400 w-12 text-right">
                                    {topic.percentage.toFixed(2)}%
                                  </span>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {openalexTopics.length > 10 && (
                      <button
                        type="button"
                        onClick={() => setShowAllTopics(!showAllTopics)}
                        className="mx-auto mt-2 px-4 py-1.5 border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900/50 rounded font-mono text-[10px] uppercase font-bold text-zinc-600 dark:text-zinc-400 cursor-pointer"
                      >
                        {showAllTopics ? 'Show Less (Top 10)' : `Show All ${openalexTopics.length} Topics`}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Tab 4: Country Imputation (openalex impute-country) */}
        {activeTab === 'imputation' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start w-full">
            {/* TOP-LEFT: Country Imputation Setup & Parameters (cols: 6) */}
            <div className="lg:col-span-6 flex flex-col gap-6">
              {/* Setup & Parameters Card */}
              <div className="flex flex-col gap-4 border border-zinc-200 dark:border-zinc-800 p-5 rounded bg-white dark:bg-zinc-950/10 shadow-sm h-full">
                <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 pb-2.5">
                  <div className="flex items-center gap-2">
                    <Globe className="h-4 w-4 text-zinc-900 dark:text-zinc-100" />
                    <span className="text-xs font-mono font-bold uppercase text-zinc-900 dark:text-zinc-100">
                      Country Imputation Setup
                    </span>
                  </div>
                  <span className="px-2 py-0.5 rounded text-[9px] font-mono font-bold uppercase bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700">
                    openalex impute-country
                  </span>
                </div>

                <p className="text-[11px] text-zinc-400 font-sans leading-relaxed">
                  Recover missing <code className="font-mono text-zinc-700 dark:text-zinc-300">country_code</code> values directly in OpenAlex JSONL publication records before database conversion, using ROR lookups and raw affiliation string heuristics.
                </p>

                {/* Input JSONL File */}
                <div className="flex flex-col gap-3 p-3.5 rounded border border-zinc-200 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-900/40">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-500 flex items-center gap-1.5">
                      <FileText className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                      Input JSONL File
                    </span>
                    <button
                      type="button"
                      onClick={fetchImputeFiles}
                      disabled={loadingImputeFiles}
                      className="text-[10px] font-mono text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 flex items-center gap-1 cursor-pointer transition"
                      title="Re-scan StratumProjects directory"
                    >
                      <RefreshCw className={`h-2.5 w-2.5 ${loadingImputeFiles ? 'animate-spin' : ''}`} />
                      <span>Refresh List</span>
                    </button>
                  </div>

                  {/* Dropdown File Selector */}
                  <div className="flex flex-col gap-1.5">
                    <select
                      value={selectedImputeFile}
                      onChange={(e) => handleSelectImputeFile(e.target.value)}
                      disabled={imputeRunning || loadingImputeFiles}
                      className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 px-3 py-2 rounded text-xs font-mono font-semibold text-zinc-900 dark:text-zinc-100 cursor-pointer focus:outline-none focus:ring-1 focus:ring-zinc-400"
                    >
                      {imputeFiles.length === 0 ? (
                        <option value={`${activeProject || 'collected_papers'}.jsonl`}>
                          {activeProject || 'collected_papers'}.jsonl (Not found on disk)
                        </option>
                      ) : (
                        imputeFiles.map((f) => (
                          <option key={f.name} value={f.name}>
                            {f.name} — {f.size_human} {f.is_imputed ? '[Imputed]' : '[Raw]'}
                          </option>
                        ))
                      )}
                    </select>
                  </div>

                  <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400 pt-1 border-t border-zinc-200/60 dark:border-zinc-800/60">
                    <span className="truncate">
                      Location: <strong className="text-zinc-700 dark:text-zinc-300">StratumProjects/{activeProject}/data/jsonl/{selectedImputeFile}</strong>
                    </span>
                    {imputeFiles.find((f) => f.name === selectedImputeFile) && (
                      <span className="text-emerald-600 dark:text-emerald-400 font-bold shrink-0 ml-2">
                        Ready on Disk
                      </span>
                    )}
                  </div>
                </div>

                {/* Name the Output File */}
                <div className="flex flex-col gap-1.5 p-3.5 rounded border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/30">
                  <div className="flex items-center justify-between">
                    <label className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-700 dark:text-zinc-300 flex items-center gap-1.5">
                      <span>Name the Output File:</span>
                    </label>
                    <span className="text-[9px] font-mono text-zinc-400">
                      [input_name]_imputed.jsonl
                    </span>
                  </div>

                  <div className="relative">
                    <input
                      type="text"
                      value={imputeOutputPath}
                      onChange={(e) => setImputeOutputPath(e.target.value)}
                      disabled={imputeRunning}
                      placeholder={selectedImputeFile ? `${selectedImputeFile.replace(/(_imputed)?\.jsonl$/i, '')}_imputed.jsonl` : `${activeProject || 'collected_papers'}_imputed.jsonl`}
                      className="w-full font-mono text-xs px-3 py-2 border border-zinc-200 dark:border-zinc-800 rounded bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-zinc-400 dark:focus:border-zinc-600 font-medium"
                    />
                  </div>
                  <span className="text-[10px] font-mono text-zinc-400">
                    Destination: StratumProjects/{activeProject || '...'}/data/jsonl/{imputeOutputPath || (selectedImputeFile ? `${selectedImputeFile.replace(/(_imputed)?\.jsonl$/i, '')}_imputed.jsonl` : `${activeProject || 'collected_papers'}_imputed.jsonl`)}
                  </span>
                </div>

                {/* Option: ROR Lookup */}
                <div className="border-t border-zinc-200 dark:border-zinc-800 pt-3 flex items-start gap-2.5">
                  <input
                    type="checkbox"
                    id="impute-ror"
                    checked={imputeUseROR}
                    onChange={(e) => setImputeUseROR(e.target.checked)}
                    disabled={imputeRunning}
                    className="mt-0.5 rounded border-zinc-300 dark:border-zinc-800 text-zinc-900 cursor-pointer"
                  />
                  <label htmlFor="impute-ror" className="flex flex-col cursor-pointer select-none">
                    <span className="text-xs font-mono font-bold text-zinc-800 dark:text-zinc-200">
                      Enable ROR API Lookups (--ror)
                    </span>
                    <span className="text-[11px] text-zinc-400 font-sans">
                      Query api.ror.org for institutions with an ROR ID that lack country codes.
                    </span>
                  </label>
                </div>

                {/* Primary Action Button */}
                <div className="border-t border-zinc-200 dark:border-zinc-800 pt-3 flex gap-2">
                  {imputeRunning ? (
                    <button
                      type="button"
                      onClick={handleCancelImputation}
                      className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded font-mono text-xs font-bold uppercase border border-rose-300 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-400 hover:bg-rose-100 dark:hover:bg-rose-950/50 cursor-pointer transition shadow-sm animate-pulse"
                      title="Stop / Cancel imputation process"
                    >
                      <Square className="h-3.5 w-3.5 fill-current" />
                      <span>Stop / Cancel Imputation</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handleStartImputation}
                      disabled={imputeRunning || !selectedImputeFile}
                      className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded font-mono text-xs font-bold uppercase bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-950 border-zinc-800 hover:bg-zinc-800 dark:hover:bg-zinc-200 disabled:opacity-50 cursor-pointer transition select-none shadow-sm"
                    >
                      <Play className="h-3.5 w-3.5 fill-current" />
                      <span>Run Country Imputation</span>
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* TOP-RIGHT: Methodological Cascade & Reference Info (cols: 6) */}
            <div className="lg:col-span-6 flex flex-col gap-6">
              {/* Methodological Cascade Info Card */}
              <div className="border border-zinc-200 dark:border-zinc-800 p-5 rounded bg-white dark:bg-zinc-950/10 shadow-sm flex flex-col gap-4 h-full">
                <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 pb-2.5">
                  <div className="flex items-center gap-2">
                    <Brain className="h-4 w-4 text-zinc-900 dark:text-zinc-100" />
                    <span className="text-xs font-mono font-bold uppercase tracking-wider text-zinc-900 dark:text-zinc-100">
                      Methodological Cascade Steps
                    </span>
                  </div>
                  <span className="px-2 py-0.5 rounded text-[9px] font-mono font-bold uppercase bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700">
                    Heuristic Cascade
                  </span>
                </div>

                <p className="text-[11px] text-zinc-400 font-sans leading-relaxed">
                  The imputation tool evaluates each institution record against a four-stage sequential pipeline to resolve ambiguous or missing country affiliations:
                </p>

                <div className="flex flex-col gap-2.5 font-sans text-xs">
                  <div className="flex items-start gap-3 p-2.5 rounded border border-zinc-200/60 dark:border-zinc-800/80 bg-zinc-50/50 dark:bg-zinc-900/30">
                    <span className="px-1.5 py-0.5 rounded bg-zinc-200 dark:bg-zinc-800 text-[10px] font-mono font-bold text-zinc-700 dark:text-zinc-300 shrink-0">01</span>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-mono font-bold text-zinc-800 dark:text-zinc-200 text-xs">Preserve Existing OpenAlex Codes</span>
                      <span className="text-[11px] text-zinc-400">Valid ISO-2 country codes already populated by OpenAlex are standardized and retained intact.</span>
                    </div>
                  </div>

                  <div className="flex items-start gap-3 p-2.5 rounded border border-zinc-200/60 dark:border-zinc-800/80 bg-zinc-50/50 dark:bg-zinc-900/30">
                    <span className="px-1.5 py-0.5 rounded bg-zinc-200 dark:bg-zinc-800 text-[10px] font-mono font-bold text-zinc-700 dark:text-zinc-300 shrink-0">02</span>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-mono font-bold text-zinc-800 dark:text-zinc-200 text-xs">ROR Registry Lookup</span>
                      <span className="text-[11px] text-zinc-400">If the institution has an ROR identifier, queries <code className="font-mono">api.ror.org</code> to retrieve authoritative country data.</span>
                    </div>
                  </div>

                  <div className="flex items-start gap-3 p-2.5 rounded border border-zinc-200/60 dark:border-zinc-800/80 bg-zinc-50/50 dark:bg-zinc-900/30">
                    <span className="px-1.5 py-0.5 rounded bg-zinc-200 dark:bg-zinc-800 text-[10px] font-mono font-bold text-zinc-700 dark:text-zinc-300 shrink-0">03</span>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-mono font-bold text-zinc-800 dark:text-zinc-200 text-xs">Affiliation String Regex Heuristic</span>
                      <span className="text-[11px] text-zinc-400">Extracts ISO-2 country codes from raw affiliation strings matching country names, common aliases, US states, and Indian states/UTs.</span>
                    </div>
                  </div>

                  <div className="flex items-start gap-3 p-2.5 rounded border border-zinc-200/60 dark:border-zinc-800/80 bg-zinc-50/50 dark:bg-zinc-900/30">
                    <span className="px-1.5 py-0.5 rounded bg-zinc-200 dark:bg-zinc-800 text-[10px] font-mono font-bold text-zinc-700 dark:text-zinc-300 shrink-0">04</span>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-mono font-bold text-zinc-800 dark:text-zinc-200 text-xs">Institution Display Name Inspection</span>
                      <span className="text-[11px] text-zinc-400">Fallback scanner inspects institution name tokens for explicit national/regional markers.</span>
                    </div>
                  </div>
                </div>

                <div className="mt-auto pt-3 border-t border-zinc-100 dark:border-zinc-800/80 flex items-center justify-between text-[10px] font-mono text-zinc-400">
                  <span>Non-destructive processing</span>
                  <span className="text-emerald-600 dark:text-emerald-400 font-bold">100% Raw Data Safe</span>
                </div>
              </div>
            </div>

            {/* BOTTOM: Real-time Diagnostics Terminal (cols: 12) - BELOW ALL */}
            <div className="lg:col-span-12 flex flex-col gap-4 border border-zinc-200 dark:border-zinc-800 p-5 rounded mt-2 w-full bg-white dark:bg-zinc-950/10 shadow-sm">
              <div className="flex justify-between items-center border-b border-zinc-200 dark:border-zinc-800 pb-3 flex-wrap gap-3">
                <div className="flex flex-col gap-1">
                  <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-zinc-900 dark:text-zinc-50 flex items-center gap-2">
                    <Terminal className="h-4 w-4 text-zinc-500" />
                    Country Imputation Diagnostics Console
                  </h3>
                  <p className="text-[11px] text-zinc-400 font-sans">
                    Real-time execution logs, institution resolution rates, and output metrics from <code className="font-mono text-zinc-700 dark:text-zinc-300">openalex impute-country</code>.
                  </p>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  {imputeOutputFile && !imputeRunning && (
                    <button
                      type="button"
                      onClick={() => handleDownloadImputeFile(imputeOutputFile)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded font-mono text-xs font-bold uppercase border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/60 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer shadow-sm transition"
                      title="Download imputed JSONL file to your computer"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>Download Imputed File</span>
                    </button>
                  )}

                  <span
                    className={`px-2.5 py-1 rounded text-[10px] font-mono font-bold uppercase tracking-wider ${
                      imputeRunning
                        ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 animate-pulse border border-amber-300/40'
                        : imputeError
                          ? 'bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300 border border-red-300/40'
                          : imputeLogs.length > 0
                            ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300 border border-emerald-300/40'
                            : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700'
                    }`}
                  >
                    {imputeRunning ? 'RUNNING' : imputeError ? 'ERROR' : imputeLogs.length > 0 ? 'COMPLETED' : 'IDLE'}
                  </span>
                </div>
              </div>

              {/* Summary Badges if stats exist */}
              {Object.keys(imputeStats).length > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-3.5 bg-zinc-50/60 dark:bg-zinc-900/40 border border-zinc-200 dark:border-zinc-800 rounded font-mono">
                  <div className="flex flex-col">
                    <span className="text-[9px] text-zinc-400 uppercase tracking-wider">Records Processed</span>
                    <span className="text-base font-bold text-zinc-900 dark:text-zinc-100">
                      {imputeStats['JSON records processed'] || '—'}
                    </span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-[9px] text-zinc-400 uppercase tracking-wider">Institutions Imputed</span>
                    <span className="text-base font-bold text-emerald-600 dark:text-emerald-400">
                      {imputeStats['Institutions country imputed'] || imputeStats['Country imputed'] || '—'}
                    </span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-[9px] text-zinc-400 uppercase tracking-wider">Already Had Country</span>
                    <span className="text-base font-bold text-zinc-700 dark:text-zinc-300">
                      {imputeStats['Already had country'] || '—'}
                    </span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-[9px] text-zinc-400 uppercase tracking-wider">Processing Time</span>
                    <span className="text-base font-bold text-zinc-700 dark:text-zinc-300">
                      {imputeStats['Processing time'] || '—'}
                    </span>
                  </div>
                </div>
              )}

              {/* Console Output Screen */}
              <div className="h-72 rounded bg-zinc-950 p-4 font-mono text-xs overflow-y-auto text-zinc-300 border border-zinc-900 shadow-inner flex flex-col gap-1 select-text">
                {imputeLogs.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-zinc-600 gap-2">
                    <Terminal className="h-6 w-6 stroke-1" />
                    <span className="text-xs uppercase tracking-widest">
                      Diagnostics Console Idle. Click "Run Country Imputation" to start.
                    </span>
                  </div>
                ) : (
                  imputeLogs.map((log, idx) => (
                    <div
                      key={idx}
                      className={`leading-relaxed break-all font-mono ${
                        log.includes('[ERROR]') || log.includes('ERROR:')
                          ? 'text-red-400'
                          : log.includes('[SUCCESS]') || log.includes('SUMMARY')
                            ? 'text-emerald-400 font-semibold'
                            : log.includes('[WARNING]')
                              ? 'text-amber-400'
                              : log.startsWith('===') || log.startsWith('---')
                                ? 'text-zinc-500'
                                : 'text-zinc-300'
                      }`}
                    >
                      {log}
                    </div>
                  ))
                )}
                <div ref={imputeLogsEndRef} />
              </div>

              {/* Console Footer */}
              <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400 pt-1">
                <span>
                  Output file destination: <strong className="text-zinc-600 dark:text-zinc-300">StratumProjects/{activeProject}/data/jsonl/{imputeOutputPath || (selectedImputeFile ? `${selectedImputeFile.replace(/\.jsonl$/i, '')}_imputed.jsonl` : '...')}</strong>
                </span>
                {imputeLogs.length > 0 && !imputeRunning && (
                  <button
                    type="button"
                    onClick={() => {
                      setImputeLogs([])
                      setImputeStats({})
                    }}
                    className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 cursor-pointer font-bold"
                  >
                    Clear Logs
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Tab 5: Settings */}
        {activeTab === 'settings' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start w-full">
            {/* LEFT COLUMN: API Keys & Polite Pool + Desktop Alerts (cols: 6) */}
            <div className="lg:col-span-6 flex flex-col gap-6">
              {/* API Keys & Polite Pool */}
              <div className="border border-zinc-200 dark:border-zinc-800 p-5 bg-white dark:bg-zinc-950/10 rounded flex flex-col gap-6">
                <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 pb-2">
                  <span className="text-sm font-mono font-bold uppercase tracking-wider text-zinc-800 dark:text-zinc-200 flex items-center gap-2">
                    <Key className="h-4 w-4 text-zinc-500" />
                    API Keys & Polite Pool
                  </span>
                </div>

                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[11px] font-mono uppercase text-zinc-400 font-bold">
                      OpenAlex API Keys (Comma-separated for rotation)
                    </label>
                    <input
                      type="text"
                      value={apiKeysStr}
                      onChange={(e) => setApiKeysStr(e.target.value)}
                      placeholder="Key1, Key2, Key3..."
                      className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-2.5 rounded font-mono text-xs focus:outline-none"
                    />
                    <span className="text-[9px] text-zinc-400 font-sans leading-normal">
                      If multiple keys are set, Stratum rotates queries across them and automatically
                      sets aside keys that encounter quota exceptions.
                    </span>
                  </div>

                  <div className="flex flex-col gap-1.5 mt-1 border-t border-zinc-200 dark:border-zinc-800 pt-3">
                    <label className="text-[11px] font-mono uppercase text-zinc-400 font-bold">
                      Polite Pool Email Address (Contact UserAgent)
                    </label>
                    <input
                      type="email"
                      value={apiEmail}
                      onChange={(e) => setApiEmail(e.target.value)}
                      placeholder="your.name@institution.edu"
                      className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-2.5 rounded font-mono text-xs focus:outline-none"
                    />
                    <span className="text-[9px] text-zinc-400 font-sans leading-normal">
                      OpenAlex reserves a dedicated "polite pool" with faster response times for users
                      who send their contact email in the headers.
                    </span>
                  </div>
                </div>
              </div>

              {/* Desktop Notifications Panel */}
              <div className="flex flex-col gap-4 border border-zinc-200 dark:border-zinc-800 p-5 rounded bg-white dark:bg-zinc-950/10">
                <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 pb-2">
                  <span className="text-xs font-mono font-bold uppercase tracking-wider text-zinc-800 dark:text-zinc-200 flex items-center gap-2">
                    <Bell className="h-4 w-4 text-zinc-500 animate-pulse" />
                    Desktop Alerts Setting
                  </span>
                  {notificationPermission === 'granted' ? (
                    <span className="px-2 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950/20 text-emerald-600 border border-emerald-200/50 font-mono text-[9px] font-bold uppercase">
                      Enabled
                    </span>
                  ) : notificationPermission === 'denied' ? (
                    <span className="px-2 py-0.5 rounded bg-red-50 dark:bg-red-950/20 text-red-600 border border-red-200/50 font-mono text-[9px] font-bold uppercase">
                      Blocked
                    </span>
                  ) : notificationPermission === 'unsupported' ? (
                    <span className="px-2 py-0.5 rounded bg-zinc-100 text-zinc-500 font-mono text-[9px] font-bold uppercase">
                      Unsupported
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded bg-amber-50 dark:bg-amber-950/20 text-amber-600 border border-amber-200/50 font-mono text-[9px] font-bold uppercase">
                      Setup needed
                    </span>
                  )}
                </div>

                <p className="text-[11px] text-zinc-400 font-sans leading-relaxed">
                  Receive browser push alerts when long-running search calculations, topic details fetches, or pipeline syncs finish, so you are immediately notified even when working in other tabs.
                </p>

                <div className="flex flex-col gap-3 mt-1">
                  {notificationPermission === 'default' && (
                    <button
                      type="button"
                      onClick={requestNotificationPermission}
                      className="w-full flex items-center justify-center gap-2 px-3 py-2 border border-zinc-300 dark:border-zinc-800 rounded font-mono text-xs font-bold uppercase bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 cursor-pointer transition select-none"
                    >
                      <Bell className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                      Request Notification Permission
                    </button>
                  )}

                  {notificationPermission === 'granted' && (
                    <div className="flex flex-col gap-3">
                      <span className="text-[10px] font-mono text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5 font-semibold">
                        <Check className="h-3.5 w-3.5 shrink-0" /> Desktop notifications are fully configured and ready.
                      </span>
                      <button
                        type="button"
                        onClick={() => sendNotification('Stratum Notification', 'Desktop notifications are working properly!')}
                        className="self-start px-3 py-1.5 border border-zinc-200 dark:border-zinc-800 rounded font-mono text-[10px] font-bold uppercase hover:bg-zinc-50 dark:hover:bg-zinc-850 text-zinc-600 dark:text-zinc-400 cursor-pointer transition"
                      >
                        Send Test Notification
                      </button>
                    </div>
                  )}

                  {notificationPermission === 'denied' && (
                    <span className="text-[10px] font-mono text-amber-600 dark:text-amber-400 flex items-center gap-1.5 leading-normal">
                      <AlertCircle className="h-3.5 w-3.5 shrink-0" /> Notifications are blocked. Please enable them in your browser site settings to receive completion alerts.
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* RIGHT COLUMN: Search Constraints & Filtering + Environment (cols: 6) */}
            <div className="lg:col-span-6 flex flex-col gap-6">
              {/* Search Constraints & Filtering */}
              <div className="flex flex-col gap-5 border border-zinc-200 dark:border-zinc-800 p-5 rounded bg-white dark:bg-zinc-950/10">
                <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 pb-2">
                  <span className="text-sm font-mono font-bold uppercase tracking-wider text-zinc-800 dark:text-zinc-200 flex items-center gap-2">
                    <Calendar className="h-4 w-4 text-zinc-500" />
                    Search Constraints & Filtering
                  </span>
                </div>

                {/* Date Filters */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[11px] font-mono uppercase text-zinc-500 font-bold">
                      Publication Date From
                    </label>
                    <input
                      type="date"
                      value={dateFrom}
                      onChange={(e) => setDateFrom(e.target.value)}
                      className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-2 rounded font-mono text-xs focus:outline-none"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[11px] font-mono uppercase text-zinc-500 font-bold">
                      Publication Date To
                    </label>
                    <input
                      type="date"
                      value={dateTo}
                      onChange={(e) => setDateTo(e.target.value)}
                      className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-2 rounded font-mono text-xs focus:outline-none"
                    />
                  </div>
                </div>

                {/* Document Types Checkboxes */}
                <div className="flex flex-col gap-2.5 mt-2 border-t border-zinc-200 dark:border-zinc-800 pt-4">
                  <span className="text-[11px] font-mono uppercase text-zinc-500 font-bold">
                    Target Document Types
                  </span>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {Object.keys(selectedDocTypes).map((type) => (
                      <label
                        key={type}
                        className={`flex items-center gap-2 p-2 rounded border border-zinc-200 dark:border-zinc-800/80 cursor-pointer select-none font-mono text-[11px] ${
                          selectedDocTypes[type]
                            ? 'bg-zinc-50/50 border-zinc-300 dark:bg-zinc-900/10 dark:border-zinc-700 text-zinc-900 dark:text-zinc-100 font-semibold'
                            : 'bg-white dark:bg-zinc-950/20 hover:bg-zinc-50 dark:hover:bg-zinc-900/40 text-zinc-400'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={selectedDocTypes[type]}
                          onChange={() =>
                            setSelectedDocTypes((prev) => ({
                              ...prev,
                              [type]: !prev[type],
                            }))
                          }
                          className="rounded border-zinc-300 text-zinc-900 focus:ring-0 cursor-pointer"
                        />
                        <span className="capitalize">{type.replace('-', ' ')}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>

              {/* AI & LLM Query Builder Settings */}
              <div className="flex flex-col gap-4 border border-zinc-200 dark:border-zinc-800 p-5 rounded bg-white dark:bg-zinc-950/10">
                <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 pb-2">
                  <span className="text-sm font-mono font-bold uppercase tracking-wider text-zinc-800 dark:text-zinc-200 flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-amber-500" />
                    AI Query Builder Configuration
                  </span>
                </div>

                <div className="flex flex-col gap-3">
                  {/* Provider Selection */}
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-mono font-bold uppercase text-zinc-500">
                      LLM Provider
                    </label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setLlmProvider('gemini')
                          localStorage.setItem('stratum_llm_provider', 'gemini')
                        }}
                        className={`flex-1 py-1.5 border rounded font-mono text-[10px] font-bold uppercase cursor-pointer transition ${
                          llmProvider === 'gemini'
                            ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-950 border-zinc-800'
                            : 'bg-transparent text-zinc-500 border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900'
                        }`}
                      >
                        Gemini API
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setLlmProvider('ollama')
                          localStorage.setItem('stratum_llm_provider', 'ollama')
                        }}
                        className={`flex-1 py-1.5 border rounded font-mono text-[10px] font-bold uppercase cursor-pointer transition ${
                          llmProvider === 'ollama'
                            ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-950 border-zinc-800'
                            : 'bg-transparent text-zinc-500 border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900'
                        }`}
                      >
                        Ollama (Local)
                      </button>
                    </div>
                  </div>

                  {/* Provider Config Fields */}
                  {llmProvider === 'gemini' ? (
                    <>
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-mono font-bold uppercase text-zinc-500">
                          Model Selection
                        </label>
                        <select
                          value={llmModel}
                          onChange={(e) => {
                            setLlmModel(e.target.value)
                            localStorage.setItem('stratum_gemini_model', e.target.value)
                          }}
                          className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-2 rounded font-mono text-xs focus:outline-none"
                        >
                          <option value="gemini-3.6-flash">Gemini 3.6 Flash (Fastest & Recommended)</option>
                          <option value="gemini-3.6-pro">Gemini 3.6 Pro (Deep Reasoning)</option>
                          <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                          <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
                          <option value="gemini-1.5-flash">Gemini 1.5 Flash</option>
                        </select>
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-mono font-bold uppercase text-zinc-500 flex items-center gap-1">
                          <Key className="h-3 w-3" /> Gemini API Key
                        </label>
                        <input
                          type="password"
                          value={llmApiKey}
                          onChange={(e) => {
                            setLlmApiKey(e.target.value)
                            localStorage.setItem('stratum_gemini_key', e.target.value)
                          }}
                          placeholder="Enter GEMINI_API_KEY..."
                          className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-2 rounded font-mono text-xs focus:outline-none"
                        />
                        <span className="text-[9px] text-zinc-400 font-sans">
                          Used to classify extracted keywords into the 4-bucket bounded boolean schema.
                        </span>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-mono font-bold uppercase text-zinc-500">
                          Ollama Server URL
                        </label>
                        <input
                          type="text"
                          value={ollamaUrl}
                          onChange={(e) => {
                            setOllamaUrl(e.target.value)
                            localStorage.setItem('stratum_ollama_url', e.target.value)
                          }}
                          placeholder="http://localhost:11434"
                          className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-2 rounded font-mono text-xs focus:outline-none"
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-mono font-bold uppercase text-zinc-500">
                          Ollama Model Name
                        </label>
                        <input
                          type="text"
                          value={ollamaModel}
                          onChange={(e) => {
                            setOllamaModel(e.target.value)
                            localStorage.setItem('stratum_ollama_model', e.target.value)
                          }}
                          placeholder="e.g. qwen3:4b, llama3"
                          className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-2 rounded font-mono text-xs focus:outline-none"
                        />
                      </div>
                    </>
                  )}
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-mono font-bold uppercase text-zinc-500">
                      Domain Context Hint (Optional)
                    </label>
                    <input
                      type="text"
                      value={domainContext}
                      onChange={(e) => setDomainContext(e.target.value)}
                      placeholder="e.g. Quantum Computing, Materials Science"
                      className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-2 rounded font-mono text-xs focus:outline-none"
                    />
                  </div>
                </div>
              </div>

              {/* Environment & Workspace Preferences */}
              <div className="flex flex-col gap-4 border border-zinc-200 dark:border-zinc-800 p-5 rounded bg-white dark:bg-zinc-950/10">
                <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 pb-2">
                  <span className="text-xs font-mono font-bold uppercase tracking-wider text-zinc-800 dark:text-zinc-200 flex items-center gap-2">
                    <Settings className="h-4 w-4 text-zinc-500" />
                    Environment & Preferences
                  </span>
                </div>
                <div className="flex flex-col gap-3 text-xs font-mono text-zinc-500">
                  <div className="flex justify-between items-center py-2 border-b border-zinc-100 dark:border-zinc-900">
                    <span>Active Workspace</span>
                    <span className="font-bold text-zinc-800 dark:text-zinc-200">{activeProject || 'Default'}</span>
                  </div>
                  <div className="flex justify-between items-center py-2 border-b border-zinc-100 dark:border-zinc-900">
                    <span>Browser Notification Support</span>
                    <span className="font-bold text-zinc-800 dark:text-zinc-200">
                      {typeof window !== 'undefined' && 'Notification' in window ? 'Supported' : 'Unavailable'}
                    </span>
                  </div>
                  <div className="flex justify-between items-center py-2">
                    <span>Toast Auto-Dismiss</span>
                    <span className="font-bold text-zinc-800 dark:text-zinc-200">6 seconds</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </form>

      {/* Custom Themed Alert Modal */}
      {alertConfig && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div
            className="w-full max-w-sm bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded shadow-xl overflow-hidden animate-in zoom-in-95 duration-200"
            role="alertdialog"
            aria-modal="true"
          >
            {/* Modal Header */}
            <div className="px-5 py-4 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-2">
              <span
                className={`h-2 w-2 rounded-full ${alertConfig.type === 'success' ? 'bg-emerald-500' : alertConfig.type === 'error' ? 'bg-red-500' : 'bg-blue-500'}`}
              />
              <h3 className="text-xs font-bold font-mono uppercase tracking-wider text-zinc-900 dark:text-zinc-100">
                {alertConfig.title}
              </h3>
            </div>

            {/* Modal Body */}
            <div className="p-5 flex flex-col gap-3">
              <p className="font-mono text-[11px] leading-relaxed text-zinc-700 dark:text-zinc-350 whitespace-pre-line">
                {alertConfig.message}
              </p>
            </div>

            {/* Modal Footer */}
            <div className="px-5 py-3 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50 flex items-center justify-end">
              <button
                type="button"
                onClick={() => setAlertConfig(null)}
                className="px-4 py-1.5 bg-zinc-900 dark:bg-zinc-100 hover:bg-zinc-800 dark:hover:bg-zinc-200 text-white dark:text-zinc-950 rounded text-[10px] font-mono font-bold uppercase tracking-wider cursor-pointer shadow transition"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Custom Themed Sample Modal */}
      {sampleModalConfig && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div
            className="w-full max-w-sm bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded shadow-xl overflow-hidden animate-in zoom-in-95 duration-200"
            role="dialog"
            aria-modal="true"
          >
            {/* Modal Header */}
            <div className="px-5 py-4 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-zinc-400 dark:bg-zinc-650" />
              <h3 className="text-xs font-bold font-mono uppercase tracking-wider text-zinc-900 dark:text-zinc-100">
                Get Random Sample
              </h3>
            </div>

            {/* Modal Body */}
            <form
              onSubmit={(e) => {
                e.preventDefault()
                const size = parseInt(sampleSizeInput.trim(), 10)
                if (isNaN(size) || size <= 0) {
                  triggerAlert('error', 'Invalid Sample Size', 'Please enter a valid positive number.')
                  return
                }
                setSampleModalConfig(null)
                sampleModalConfig.onConfirm(size)
              }}
              className="p-5 flex flex-col gap-4"
            >
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed font-sans">
                Specify the number of papers to retrieve as a random sample. The active keywords, date filters, and topics will be applied.
              </p>

              <div className="flex flex-col gap-1.5">
                <label className="text-[9px] font-mono font-bold uppercase tracking-wider text-zinc-400">
                  Sample Size
                </label>
                <input
                  type="number"
                  min={1}
                  required
                  value={sampleSizeInput}
                  onChange={(e) => setSampleSizeInput(e.target.value)}
                  className="w-full font-mono text-xs px-3 py-2 border border-zinc-200 dark:border-zinc-800 rounded bg-transparent text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-400 focus:border-transparent transition-all"
                  placeholder="e.g. 385"
                  autoFocus
                />
              </div>

              {/* Modal Footer */}
              <div className="mt-2 border-t border-zinc-100 dark:border-zinc-850 pt-4 flex items-center justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => setSampleModalConfig(null)}
                  className="px-4 py-1.5 border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 text-zinc-700 dark:text-zinc-300 rounded text-[10px] font-mono font-bold uppercase tracking-wider cursor-pointer transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-zinc-900 dark:bg-zinc-100 hover:bg-zinc-800 dark:hover:bg-zinc-200 text-white dark:text-zinc-950 rounded text-[10px] font-mono font-bold uppercase tracking-wider cursor-pointer shadow transition"
                >
                  Download CSV
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* OpenAlex Download Pre-flight Modal */}
      {downloadModalOpen && downloadInfo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div
            className="w-full max-w-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200"
            role="dialog"
            aria-modal="true"
          >
            {/* Modal Header */}
            <div className="px-5 py-4 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Terminal className="h-4 w-4 text-emerald-500" />
                <h3 className="text-xs font-bold font-mono uppercase tracking-wider text-zinc-900 dark:text-zinc-100">
                  openalex download — Pre-flight Check
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setDownloadModalOpen(false)}
                className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-5 flex flex-col gap-4">
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed font-sans">
                Review estimated harvest metrics and output configuration before initiating async download of OpenAlex publication records.
              </p>

              {/* Pre-flight Metrics Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                <div className="border border-zinc-200 dark:border-zinc-800 rounded p-3 bg-zinc-50/50 dark:bg-zinc-950/20 flex flex-col gap-1">
                  <span className="text-[9px] font-mono uppercase font-bold text-zinc-400">Total Papers</span>
                  <span className="font-mono text-sm font-bold text-emerald-600 dark:text-emerald-400">
                    {downloadInfo.total.toLocaleString()}
                  </span>
                  <span className="text-[9px] text-zinc-400">matching query</span>
                </div>

                <div className="border border-zinc-200 dark:border-zinc-800 rounded p-3 bg-zinc-50/50 dark:bg-zinc-950/20 flex flex-col gap-1">
                  <span className="text-[9px] font-mono uppercase font-bold text-zinc-400">Est. Size</span>
                  <span className="font-mono text-sm font-bold text-zinc-900 dark:text-zinc-100">
                    ~{downloadInfo.estimated_mb.toFixed(0)} MB
                  </span>
                  <span className="text-[9px] text-zinc-400">~8.5 KB / paper</span>
                </div>

                <div className="border border-zinc-200 dark:border-zinc-800 rounded p-3 bg-zinc-50/50 dark:bg-zinc-950/20 flex flex-col gap-1">
                  <span className="text-[9px] font-mono uppercase font-bold text-zinc-400">Filter Scope</span>
                  <span className="font-mono text-sm font-bold text-zinc-900 dark:text-zinc-100">
                    {downloadNoTopics ? '0 Topics' : `${downloadInfo.topics_count} Topics`}
                  </span>
                  <span className="text-[9px] text-zinc-400">
                    {downloadNoTopics ? 'keywords only' : '+ keywords'}
                  </span>
                </div>

                <div className="border border-zinc-200 dark:border-zinc-800 rounded p-3 bg-zinc-50/50 dark:bg-zinc-950/20 flex flex-col gap-1">
                  <span className="text-[9px] font-mono uppercase font-bold text-zinc-400">Free Storage</span>
                  <span className="font-mono text-sm font-bold text-zinc-900 dark:text-zinc-100">
                    {downloadInfo.free_space_gb.toFixed(1)} GB
                  </span>
                  <span className="text-[9px] text-zinc-400">on drive</span>
                </div>
              </div>

              {/* Low Disk Space Alert */}
              {downloadInfo.free_space_gb < (downloadInfo.estimated_mb * 2 / 1024) && (
                <div className="flex items-start gap-2 p-3 rounded border border-amber-300 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20 text-amber-800 dark:text-amber-300 text-xs">
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold">Low disk space warning: </span>
                    <span>
                      {downloadInfo.free_space_gb.toFixed(1)} GB free, recommended ~{(downloadInfo.estimated_mb * 2 / 1024).toFixed(1)} GB (2× estimated size).
                    </span>
                  </div>
                </div>
              )}

              {/* Output File Configuration */}
              <div className="flex flex-col gap-1.5">
                <label className="text-[9px] font-mono font-bold uppercase tracking-wider text-zinc-400">
                  Output JSONL Filename
                </label>
                <input
                  type="text"
                  required
                  value={downloadOutputFilename}
                  onChange={(e) => setDownloadOutputFilename(e.target.value)}
                  onBlur={() => {
                    const clean = downloadOutputFilename.trim() || defaultJsonlName
                    fetchDownloadPreflight(downloadNoTopics, clean)
                  }}
                  className="w-full font-mono text-xs px-3 py-2 border border-zinc-200 dark:border-zinc-800 rounded bg-transparent text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-400 focus:border-transparent transition-all"
                  placeholder={defaultJsonlName}
                />
                {/* Quick Presets */}
                <div className="flex items-center gap-2 pt-0.5 flex-wrap">
                  <span className="text-[10px] font-mono text-zinc-400">Presets:</span>
                  {activeProject && activeProject !== 'default' && (
                    <button
                      type="button"
                      onClick={() => {
                        const name = `${activeProject}.jsonl`
                        setDownloadOutputFilename(name)
                        fetchDownloadPreflight(downloadNoTopics, name)
                      }}
                      className={`px-2 py-0.5 rounded font-mono text-[10px] border transition cursor-pointer ${
                        downloadOutputFilename === `${activeProject}.jsonl`
                          ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 font-bold border-transparent'
                          : 'border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:border-zinc-300'
                      }`}
                    >
                      {activeProject}.jsonl (Project)
                    </button>
                  )}
                  {activeProject && activeProject !== 'default' && (
                    <button
                      type="button"
                      onClick={() => {
                        const name = `${activeProject}_imputed.jsonl`
                        setDownloadOutputFilename(name)
                        fetchDownloadPreflight(downloadNoTopics, name)
                      }}
                      className={`px-2 py-0.5 rounded font-mono text-[10px] border transition cursor-pointer ${
                        downloadOutputFilename === `${activeProject}_imputed.jsonl`
                          ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 font-bold border-transparent'
                          : 'border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:border-zinc-300'
                      }`}
                    >
                      {activeProject}_imputed.jsonl
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setDownloadOutputFilename('collected_papers.jsonl')
                      fetchDownloadPreflight(downloadNoTopics, 'collected_papers.jsonl')
                    }}
                    className={`px-2 py-0.5 rounded font-mono text-[10px] border transition cursor-pointer ${
                      downloadOutputFilename === 'collected_papers.jsonl'
                        ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 font-bold border-transparent'
                        : 'border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:border-zinc-300'
                    }`}
                  >
                    collected_papers.jsonl
                  </button>
                </div>
                <span className="text-[10px] font-mono text-zinc-400">
                  Destination: <span className="text-zinc-600 dark:text-zinc-300">StratumProjects/{activeProject}/data/jsonl/{downloadOutputFilename || defaultJsonlName}</span>
                </span>
              </div>

              {/* Topics Filter Toggle (--no-topics) */}
              <label className="flex items-start gap-2.5 p-3 rounded border border-zinc-200 dark:border-zinc-800 bg-zinc-50/30 dark:bg-zinc-900/30 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={downloadNoTopics}
                  onChange={(e) => {
                    const checked = e.target.checked
                    setDownloadNoTopics(checked)
                    fetchDownloadPreflight(checked, downloadOutputFilename)
                  }}
                  className="mt-0.5 rounded border-zinc-300 dark:border-zinc-700 text-zinc-900 focus:ring-0"
                />
                <div className="flex flex-col gap-0.5">
                  <span className="font-mono text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                    Ignore Topics Filter (--no-topics)
                  </span>
                  <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                    Harvest using keywords only, bypassing any configured primary_topic constraints.
                  </span>
                </div>
              </label>

              {/* Resume / Overwrite Checkpoint Handling */}
              {downloadInfo.is_resumable && (
                <div className="flex items-start gap-2 p-3 rounded border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50/50 dark:bg-emerald-950/20 text-emerald-800 dark:text-emerald-300 text-xs">
                  <CheckCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold">Resume checkpoint detected: </span>
                    <span>
                      Found {downloadInfo.existing_papers.toLocaleString()} existing papers in <span className="font-mono">{downloadOutputFilename}</span> with an active <span className="font-mono">.download_progress.json</span> sidecar. The download will resume from saved cursor positions without duplicates.
                    </span>
                  </div>
                </div>
              )}

              {downloadInfo.needs_overwrite_choice && (
                <div className="flex flex-col gap-2 p-3 rounded border border-amber-300 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20 text-xs">
                  <div className="flex items-start gap-2 text-amber-800 dark:text-amber-300">
                    <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                    <div>
                      <span className="font-bold">Existing file without resume tracking: </span>
                      <span>
                        <span className="font-mono">{downloadOutputFilename}</span> contains {downloadInfo.existing_papers.toLocaleString()} papers, but no cursor progress sidecar was found. Appending without cursor tracking will create duplicate records.
                      </span>
                    </div>
                  </div>

                  <label className="flex items-center gap-2 mt-1 cursor-pointer select-none text-zinc-800 dark:text-zinc-200 font-mono text-[11px] font-semibold">
                    <input
                      type="checkbox"
                      checked={downloadOverwrite}
                      onChange={(e) => setDownloadOverwrite(e.target.checked)}
                      className="rounded border-zinc-300 dark:border-zinc-700 text-zinc-900 focus:ring-0"
                    />
                    <span>Overwrite: Delete existing file and start fresh download (Recommended)</span>
                  </label>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="px-5 py-3 border-t border-zinc-100 dark:border-zinc-850 bg-zinc-50/50 dark:bg-zinc-900/50 flex items-center justify-between">
              <span className="text-[10px] font-mono text-zinc-400">
                Command: <span className="text-zinc-600 dark:text-zinc-300">openalex download {downloadNoTopics ? '--no-topics ' : ''}-o {downloadOutputFilename}</span>
              </span>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setDownloadModalOpen(false)}
                  disabled={startingDownload}
                  className="px-4 py-1.5 border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 rounded text-[10px] font-mono font-bold uppercase tracking-wider cursor-pointer transition disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleStartDownloadPapers}
                  disabled={startingDownload || fetchingDownloadInfo}
                  className="flex items-center gap-1.5 px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white dark:bg-emerald-500 dark:hover:bg-emerald-400 dark:text-zinc-950 rounded text-[10px] font-mono font-bold uppercase tracking-wider cursor-pointer shadow transition disabled:opacity-50"
                >
                  {startingDownload ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" />
                      <span>Initiating...</span>
                    </>
                  ) : downloadInfo.is_resumable ? (
                    <>
                      <Play className="h-3 w-3 fill-current" />
                      <span>Resume Download</span>
                    </>
                  ) : (
                    <>
                      <Download className="h-3 w-3" />
                      <span>Start Download</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Quick AI Configuration Modal */}
      {showAIModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div
            className="w-full max-w-md bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200"
            role="dialog"
            aria-modal="true"
          >
            <div className="px-5 py-4 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-amber-500" />
                <h3 className="text-xs font-bold font-mono uppercase tracking-wider text-zinc-900 dark:text-zinc-100">
                  Configure AI Query Generator
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowAIModal(false)}
                className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault()
                handleAutoGenerateQuery(llmApiKey)
              }}
              className="p-5 flex flex-col gap-4"
            >
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed font-sans">
                Stratum uses Gemini or Ollama to automatically classify extracted keywords into the 4 bibliometric categories and compile a bounded Boolean query.
              </p>

              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-mono font-bold uppercase text-zinc-500">
                  Provider
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setLlmProvider('gemini')
                      localStorage.setItem('stratum_llm_provider', 'gemini')
                    }}
                    className={`flex-1 py-1.5 border rounded font-mono text-[10px] font-bold uppercase cursor-pointer transition ${
                      llmProvider === 'gemini'
                        ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-950 border-zinc-800'
                        : 'bg-transparent text-zinc-500 border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900'
                    }`}
                  >
                    Gemini API
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setLlmProvider('ollama')
                      localStorage.setItem('stratum_llm_provider', 'ollama')
                    }}
                    className={`flex-1 py-1.5 border rounded font-mono text-[10px] font-bold uppercase cursor-pointer transition ${
                      llmProvider === 'ollama'
                        ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-950 border-zinc-800'
                        : 'bg-transparent text-zinc-500 border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900'
                    }`}
                  >
                    Ollama
                  </button>
                </div>
              </div>

              {llmProvider === 'gemini' ? (
                <>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-500 flex items-center gap-1">
                      <Key className="h-3 w-3" /> Gemini API Key
                    </label>
                    <input
                      type="password"
                      required
                      value={llmApiKey}
                      onChange={(e) => {
                        setLlmApiKey(e.target.value)
                        localStorage.setItem('stratum_gemini_key', e.target.value)
                      }}
                      className="w-full font-mono text-xs px-3 py-2 border border-zinc-200 dark:border-zinc-800 rounded bg-transparent text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-400"
                      placeholder="Enter GEMINI_API_KEY..."
                      autoFocus
                    />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-500">
                      Model
                    </label>
                    <select
                      value={llmModel}
                      onChange={(e) => {
                        setLlmModel(e.target.value)
                        localStorage.setItem('stratum_gemini_model', e.target.value)
                      }}
                      className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-2 rounded font-mono text-xs focus:outline-none"
                    >
                      <option value="gemini-3.6-flash">Gemini 3.6 Flash (Recommended)</option>
                      <option value="gemini-3.6-pro">Gemini 3.6 Pro</option>
                      <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                      <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
                      <option value="gemini-1.5-flash">Gemini 1.5 Flash</option>
                    </select>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-500">
                      Ollama Server URL
                    </label>
                    <input
                      type="text"
                      required
                      value={ollamaUrl}
                      onChange={(e) => {
                        setOllamaUrl(e.target.value)
                        localStorage.setItem('stratum_ollama_url', e.target.value)
                      }}
                      className="w-full font-mono text-xs px-3 py-2 border border-zinc-200 dark:border-zinc-800 rounded bg-transparent text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-400"
                      placeholder="http://localhost:11434"
                    />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-500">
                      Ollama Model Name
                    </label>
                    <input
                      type="text"
                      required
                      value={ollamaModel}
                      onChange={(e) => {
                        setOllamaModel(e.target.value)
                        localStorage.setItem('stratum_ollama_model', e.target.value)
                      }}
                      className="w-full font-mono text-xs px-3 py-2 border border-zinc-200 dark:border-zinc-800 rounded bg-transparent text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-400"
                      placeholder="e.g. qwen3:4b, llama3"
                    />
                  </div>
                </>
              )}

              <div className="flex flex-col gap-1.5">
                <label className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-500">
                  Domain Context Hint (Optional)
                </label>
                <input
                  type="text"
                  value={domainContext}
                  onChange={(e) => setDomainContext(e.target.value)}
                  className="w-full font-mono text-xs px-3 py-2 border border-zinc-200 dark:border-zinc-800 rounded bg-transparent text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-400"
                  placeholder="e.g. Quantum Computing and Quantum Information"
                />
              </div>

              <div className="mt-2 border-t border-zinc-100 dark:border-zinc-800 pt-4 flex items-center justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => setShowAIModal(false)}
                  className="px-4 py-1.5 border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 text-zinc-700 dark:text-zinc-300 rounded text-[10px] font-mono font-bold uppercase tracking-wider cursor-pointer transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={generatingQuery || (llmProvider === 'gemini' && !llmApiKey.trim())}
                  className="px-4 py-1.5 bg-zinc-900 dark:bg-zinc-100 hover:bg-zinc-800 dark:hover:bg-zinc-200 text-white dark:text-zinc-950 rounded text-[10px] font-mono font-bold uppercase tracking-wider cursor-pointer shadow transition disabled:opacity-50 flex items-center gap-1.5"
                >
                  {generatingQuery ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" />
                      <span>Generating...</span>
                    </>
                  ) : (
                    <span>Generate Query</span>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
export { Ingest as default }
