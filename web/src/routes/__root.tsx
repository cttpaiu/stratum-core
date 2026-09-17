// src/routes/__root.tsx
import { useState, useEffect } from 'react'
import { Link, Outlet } from '@tanstack/react-router'
import { LayoutDashboard, Settings, Database, BookOpen, Sun, Moon, Cpu, Trash2, AlertTriangle, Download, CheckCircle2 } from 'lucide-react'
import { ProjectContext } from '../context/ProjectContext'

export function Root() {
  const [darkMode, setDarkMode] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('darkMode')
      if (saved !== null) {
        return saved === 'true'
      }
      return window.matchMedia('(prefers-color-scheme: dark)').matches
    }
    return false
  })

  const [activeProject, setActiveProject] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('activeProject')
      return saved || 'default'
    }
    return 'default'
  })
  const [projects, setProjects] = useState<string[]>(['default'])
  const [workspaceDir, setWorkspaceDir] = useState('')

  // Create Project Modal State Hooks
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [projectNameInput, setProjectNameInput] = useState('')
  const [modalError, setModalError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  // Delete Project Modal State Hooks
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const fetchProjects = async () => {
    try {
      const response = await fetch('/api/projects')
      if (response.ok) {
        const data = await response.json()
        setProjects(data.projects || ['default'])
      }
    } catch (err) {
      console.error('Failed to load projects list:', err)
    }
  }


  useEffect(() => {
    let isMounted = true
    const init = async () => {
      try {
        const [projRes, wsRes] = await Promise.all([
          fetch('/api/projects'),
          fetch('/api/workspace'),
        ])
        if (projRes.ok && isMounted) {
          const data = await projRes.json()
          setProjects(data.projects || ['default'])
        }
        if (wsRes.ok && isMounted) {
          const data = await wsRes.json()
          setWorkspaceDir(data.workspace_dir || '')
        }
      } catch (err) {
        console.error('Failed to load initial data:', err)
      }
    }
    init()
    return () => {
      isMounted = false
    }
  }, [])

  useEffect(() => {
    localStorage.setItem('activeProject', activeProject)
  }, [activeProject])

  const handleCreateProject = () => {
    setProjectNameInput('')
    setModalError(null)
    setIsSaving(false)
    setIsModalOpen(true)
  }

  const submitCreateProject = async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    const sanitized = projectNameInput.replace(/[^a-zA-Z0-9_-]/g, '').trim()
    if (!sanitized) {
      setModalError(
        'Invalid project name. Only alphanumeric, hyphens, and underscores are allowed.',
      )
      return
    }

    setIsSaving(true)
    setModalError(null)
    try {
      const response = await fetch('/api/projects/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: sanitized }),
      })
      if (response.ok) {
        await fetchProjects()
        setActiveProject(sanitized)
        setIsModalOpen(false)
      } else {
        const errData = await response.json()
        setModalError(errData.error || response.statusText || 'Failed to create project.')
      }
    } catch (err) {
      setModalError('Connection error: ' + String(err))
    } finally {
      setIsSaving(false)
    }
  }

  const handleDeleteProject = () => {
    if (activeProject === 'default') return
    setDeleteError(null)
    setIsDeleting(false)
    setIsDeleteModalOpen(true)
  }

  const submitDeleteProject = async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    if (activeProject === 'default') return

    setIsDeleting(true)
    setDeleteError(null)
    try {
      const response = await fetch('/api/projects/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: activeProject }),
      })
      if (response.ok) {
        await fetchProjects()
        setActiveProject('default')
        setIsDeleteModalOpen(false)
      } else {
        const errData = await response.json()
        setDeleteError(errData.error || response.statusText || 'Failed to delete project.')
      }
    } catch (err) {
      setDeleteError('Connection error: ' + String(err))
    } finally {
      setIsDeleting(false)
    }
  }



  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
    localStorage.setItem('darkMode', String(darkMode))
  }, [darkMode])

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-white text-zinc-900 transition-colors duration-200 dark:bg-zinc-950 dark:text-zinc-100 font-sans">
      {/* Left Sidebar */}
      <aside className="w-64 border-r border-zinc-200 bg-zinc-50 flex flex-col justify-between dark:border-zinc-850 dark:bg-zinc-900/40">
        <div className="flex flex-col">
          {/* Top Brand Header */}
          <div className="flex items-center gap-3 p-5 border-b border-zinc-200 dark:border-zinc-850">
            <div className="h-9 w-9 bg-zinc-900 dark:bg-zinc-100 flex items-center justify-center rounded border border-zinc-300 dark:border-zinc-800 shadow-sm">
              <span className="font-mono font-bold text-lg text-white dark:text-zinc-950">S</span>
            </div>
            <div className="flex flex-col">
              <span className="font-mono font-bold text-sm tracking-tight">Stratum Core</span>
              <span className="text-[10px] font-mono text-zinc-500 font-semibold uppercase tracking-wider">
                Version 5.0.1
              </span>
            </div>
          </div>

          {/* Workspace Area */}
          <div className="flex flex-col gap-1.5 p-4 border-b border-zinc-200 dark:border-zinc-850 bg-zinc-100/30 dark:bg-zinc-900/10">
            <span className="text-[9px] font-mono font-bold uppercase tracking-wider text-zinc-400">
              Workspace Folder
            </span>
            <div className="text-[10px] font-mono truncate text-zinc-600 dark:text-zinc-400" title={workspaceDir || 'Default'}>
              {workspaceDir || './'}
            </div>
          </div>

          {/* Project Selector Area */}
          <div className="flex flex-col gap-2 p-4 border-b border-zinc-200 dark:border-zinc-850 bg-zinc-100/30 dark:bg-zinc-900/10">
            <div className="flex items-center justify-between">
              <span className="text-[9px] font-mono font-bold uppercase tracking-wider text-zinc-400">
                Active Project
              </span>
              <button
                type="button"
                onClick={handleCreateProject}
                className="text-[9px] font-mono font-bold uppercase text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 cursor-pointer"
              >
                + New
              </button>
            </div>
            <div className="flex items-center gap-1.5">
              <select
                value={activeProject}
                onChange={(e) => setActiveProject(e.target.value)}
                aria-label="Select active project"
                className="flex-1 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-1.5 rounded font-mono text-xs focus:outline-none min-w-0"
              >
                {projects.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              {activeProject !== 'default' && (
                <button
                  type="button"
                  onClick={handleDeleteProject}
                  title={`Delete project "${activeProject}"`}
                  className="p-1.5 rounded border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-zinc-400 hover:text-red-600 hover:border-red-300 dark:hover:text-red-400 dark:hover:border-red-800/60 hover:bg-red-50 dark:hover:bg-red-950/20 transition cursor-pointer shrink-0"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Navigation Links */}
          <nav className="flex flex-col gap-1 p-3">
            <Link
              to="/"
              activeProps={{
                className:
                  'bg-zinc-200 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-semibold',
              }}
              inactiveProps={{
                className:
                  'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-900/60',
              }}
              className="flex items-center gap-3 px-3 py-2.5 rounded text-xs font-mono uppercase tracking-wider transition-all"
            >
              <LayoutDashboard className="h-4 w-4" />
              <span>Dashboard</span>
            </Link>

            <Link
              to="/ingest"
              activeProps={{
                className:
                  'bg-zinc-200 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-semibold',
              }}
              inactiveProps={{
                className:
                  'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-900/60',
              }}
              className="flex items-center gap-3 px-3 py-2.5 rounded text-xs font-mono uppercase tracking-wider transition-all"
            >
              <Settings className="h-4 w-4" />
              <span>Ingest Config</span>
            </Link>

            <Link
              to="/export"
              activeProps={{
                className:
                  'bg-zinc-200 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-semibold',
              }}
              inactiveProps={{
                className:
                  'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-900/60',
              }}
              className="flex items-center gap-3 px-3 py-2.5 rounded text-xs font-mono uppercase tracking-wider transition-all"
            >
              <Download className="h-4 w-4" />
              <span>Download & Export</span>
            </Link>

            <Link
              to="/check-db"
              activeProps={{
                className:
                  'bg-zinc-200 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-semibold',
              }}
              inactiveProps={{
                className:
                  'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-900/60',
              }}
              className="flex items-center gap-3 px-3 py-2.5 rounded text-xs font-mono uppercase tracking-wider transition-all"
            >
              <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              <span>Check DB</span>
            </Link>

            <Link
              to="/sql"
              activeProps={{
                className:
                  'bg-zinc-200 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-semibold',
              }}
              inactiveProps={{
                className:
                  'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-900/60',
              }}
              className="flex items-center gap-3 px-3 py-2.5 rounded text-xs font-mono uppercase tracking-wider transition-all"
            >
              <Database className="h-4 w-4" />
              <span>SQL Playground</span>
            </Link>

            <Link
              to="/wos"
              activeProps={{
                className:
                  'bg-zinc-200 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-semibold',
              }}
              inactiveProps={{
                className:
                  'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-900/60',
              }}
              className="flex items-center gap-3 px-3 py-2.5 rounded text-xs font-mono uppercase tracking-wider transition-all"
            >
              <Cpu className="h-4 w-4" />
              <span>WoS & Imputation</span>
            </Link>

            <Link
              to="/docs"
              activeProps={{
                className:
                  'bg-zinc-200 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-semibold',
              }}
              inactiveProps={{
                className:
                  'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-900/60',
              }}
              className="flex items-center gap-3 px-3 py-2.5 rounded text-xs font-mono uppercase tracking-wider transition-all"
            >
              <BookOpen className="h-4 w-4" />
              <span>Developer Docs</span>
            </Link>
          </nav>
        </div>

        {/* Bottom Footer with Dark Toggle */}
        <div className="p-4 border-t border-zinc-200 dark:border-zinc-850 bg-zinc-100/60 dark:bg-zinc-900/20">
          <button
            onClick={() => setDarkMode(!darkMode)}
            className="w-full flex items-center justify-between px-3 py-2 rounded border border-zinc-300 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-850 transition text-xs font-mono select-none"
          >
            <span className="text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">Theme</span>
            <div className="flex items-center gap-1.5">
              {darkMode ? (
                <>
                  <Moon className="h-3.5 w-3.5 text-zinc-400" />
                  <span className="text-zinc-300">Night</span>
                </>
              ) : (
                <>
                  <Sun className="h-3.5 w-3.5 text-amber-500" />
                  <span className="text-zinc-700">Light</span>
                </>
              )}
            </div>
          </button>
        </div>
      </aside>

      {/* Main Component Stage */}
      <main className="flex-1 overflow-y-auto p-10 select-text">
        <ProjectContext.Provider value={{ activeProject, setActiveProject }}>
          <Outlet />
        </ProjectContext.Provider>
      </main>

      {/* Custom Project Creation Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div
            className="w-full max-w-md bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded shadow-xl overflow-hidden animate-in zoom-in-95 duration-200"
            role="dialog"
            aria-modal="true"
          >
            {/* Modal Header */}
            <div className="px-5 py-4 border-b border-zinc-200 dark:border-zinc-800">
              <h3 className="text-xs font-bold font-mono uppercase tracking-wider text-zinc-900 dark:text-zinc-100">
                Create New Project
              </h3>
            </div>

            <form onSubmit={submitCreateProject}>
              {/* Modal Body */}
              <div className="p-5 flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <label
                    htmlFor="project-name-input"
                    className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-400"
                  >
                    Project Name
                  </label>
                  <input
                    id="project-name-input"
                    type="text"
                    value={projectNameInput}
                    onChange={(e) => {
                      // Live validate to allow only a-zA-Z0-9_-
                      const val = e.target.value
                      const sanitized = val.replace(/[^a-zA-Z0-9_-]/g, '')
                      setProjectNameInput(sanitized)
                      if (modalError) setModalError(null)
                    }}
                    placeholder="e.g. li-ion-batteries"
                    autoFocus
                    className="w-full bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 px-3 py-2 rounded font-mono text-xs text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-zinc-400 dark:focus:border-zinc-700"
                  />
                  <span className="text-[9px] font-mono text-zinc-400 leading-normal">
                    Alphanumeric characters, hyphens, and underscores only.
                  </span>
                </div>

                {modalError && (
                  <div className="p-3 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900/50 rounded text-red-600 dark:text-red-400 font-mono text-[10px] leading-relaxed">
                    {modalError}
                  </div>
                )}
              </div>

              {/* Modal Footer */}
              <div className="px-5 py-3 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  disabled={isSaving}
                  className="px-3 py-1.5 border border-zinc-200 dark:border-zinc-800 rounded text-[10px] font-mono font-bold uppercase text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 bg-white dark:bg-zinc-900 cursor-pointer disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSaving || !projectNameInput.trim()}
                  className="px-3 py-1.5 bg-zinc-900 dark:bg-zinc-100 hover:bg-zinc-805 dark:hover:bg-zinc-200 text-white dark:text-zinc-950 rounded text-[10px] font-mono font-bold uppercase tracking-wider shadow cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed transition"
                >
                  {isSaving ? 'Creating...' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Custom Project Deletion Modal */}
      {isDeleteModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div
            className="w-full max-w-md bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded shadow-xl overflow-hidden animate-in zoom-in-95 duration-200"
            role="dialog"
            aria-modal="true"
          >
            {/* Modal Header */}
            <div className="px-5 py-4 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-2.5">
              <div className="h-7 w-7 rounded-full bg-red-100 dark:bg-red-950/40 border border-red-200 dark:border-red-800 flex items-center justify-center text-red-600 dark:text-red-400 shrink-0">
                <AlertTriangle className="h-4 w-4" />
              </div>
              <h3 className="text-xs font-bold font-mono uppercase tracking-wider text-zinc-900 dark:text-zinc-100">
                Delete Project
              </h3>
            </div>

            <form onSubmit={submitDeleteProject}>
              {/* Modal Body */}
              <div className="p-5 flex flex-col gap-3">
                <p className="text-xs font-sans text-zinc-700 dark:text-zinc-300 leading-relaxed">
                  Are you sure you want to delete project{' '}
                  <span className="font-mono font-bold text-zinc-900 dark:text-zinc-100 bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded">
                    {activeProject}
                  </span>
                  ?
                </p>
                <p className="text-[11px] font-sans text-zinc-500 dark:text-zinc-400 leading-relaxed">
                  This action will permanently delete all associated database files, JSONL outputs, uploaded files, and configuration for this project. This action cannot be undone.
                </p>

                {deleteError && (
                  <div className="p-3 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900/50 rounded text-red-600 dark:text-red-400 font-mono text-[10px] leading-relaxed">
                    {deleteError}
                  </div>
                )}
              </div>

              {/* Modal Footer */}
              <div className="px-5 py-3 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setIsDeleteModalOpen(false)}
                  disabled={isDeleting}
                  className="px-3 py-1.5 border border-zinc-200 dark:border-zinc-800 rounded text-[10px] font-mono font-bold uppercase text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 bg-white dark:bg-zinc-900 cursor-pointer disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isDeleting}
                  className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded text-[10px] font-mono font-bold uppercase tracking-wider shadow cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center gap-1.5"
                >
                  <Trash2 className="h-3 w-3" />
                  {isDeleting ? 'Deleting...' : 'Delete Project'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
