// src/main.tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { Root } from './routes/__root'
import { Index } from './routes/index'
import { Ingest } from './routes/ingest'
import { Sql } from './routes/sql'
import { Docs } from './routes/docs'
import { Export } from './routes/export'
import { CheckDB } from './routes/check-db'
import { Insights } from './routes/insights'
import './index.css'

// 1. Programmatic Route Tree Setup
const rootRoute = createRootRoute({
  component: Root,
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: Index,
})

const ingestRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/ingest',
  component: Ingest,
})

const exportRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/export',
  component: Export,
})

const checkDBRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/check-db',
  validateSearch: (search: Record<string, unknown>): { file?: string } => ({
    file: typeof search.file === 'string' ? search.file : undefined,
  }),
  component: CheckDB,
})

const sqlRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sql',
  component: Sql,
})

const insightsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/insights',
  component: Insights,
})

const docsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/docs',
  component: Docs,
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  ingestRoute,
  exportRoute,
  checkDBRoute,
  sqlRoute,
  insightsRoute,
  docsRoute,
])

// 2. Initialize Router instance
const router = createRouter({ routeTree })

// 3. Register router type for type safety
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

// 4. Render App
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
