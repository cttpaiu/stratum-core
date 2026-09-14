// src/routes/docs.tsx
import { useState } from 'react'
import { BookOpen, ArrowRight, HelpCircle, Code2, Database } from 'lucide-react'

interface DocGuide {
  id: string
  title: string
  subtitle: string
  icon: React.ReactNode
  content: React.ReactNode
}

export function Docs() {
  const [activeGuideId, setActiveGuideId] = useState('ingestion')

  const guides: DocGuide[] = [
    {
      id: 'ingestion',
      title: 'OpenAlex Ingestion Flow',
      subtitle: 'Data pipeline architecture',
      icon: <HelpCircle className="h-4 w-4" />,
      content: (
        <div className="flex flex-col gap-5 text-sm leading-relaxed">
          <h2 className="text-lg font-mono font-bold border-b border-zinc-200 dark:border-zinc-800 pb-2 uppercase tracking-wide">
            Pipeline Architecture
          </h2>
          <p>
            The OpenAlex Ingest engine downloads and structures academic research works according to
            keywords and topics filters.
          </p>

          <h3 className="font-mono font-bold uppercase text-xs text-zinc-500">Pipeline Stages</h3>
          <ol className="list-decimal pl-5 flex flex-col gap-2.5">
            <li>
              <strong>Validate filters</strong>: Checks boolean expression grammar and parses
              OpenAlex topic IDs (TXXXXX) stored in the project's SQLite <code>config.db</code>.
            </li>
            <li>
              <strong>Retrieve counts</strong>: Queries OpenAlex API endpoint to calculate the
              matching papers count before downloading.
            </li>
            <li>
              <strong>Concurrent download</strong>: Initiates parallel worker pools downloading
              JSONL assets concurrently, tracking progress using cursors.
            </li>
            <li>
              <strong>DOI Catalog Upload & Extraction</strong>: Supports CSV, XLSX, and legacy XLS
              formats for keyword mining and seed DOI extraction. Features a robust row-scanning
              fallback to bypass parser column shifts and retrieve all DOIs successfully.
            </li>
            <li>
              <strong>Dual-Stage Keyword Mining (TF-IDF + KeyBERT)</strong>: Extracts candidate pool terms
              (default: 20) using TF-IDF across local papers, followed by dense semantic re-ranking
              via KeyBERT with the <code>allenai-specter</code> embedding model (default blend α=0.1).
              Displays decomposed scores (<code>tf:</code>, <code>KB:</code>, and blended <code>c:</code>).
            </li>
            <li>
              <strong>DuckDB Analytics & JSONL Ingestion</strong>: Downloads raw OpenAlex works to
              JSONL, enabling instant direct SQL querying via <code>read_json_auto()</code> or one-click
              normalization into relational DuckDB tables (<code>papers</code>, <code>contributions</code>, etc.)
              via <code>POST /api/db/import-jsonl</code>.
            </li>
          </ol>

          <div className="p-4 border border-zinc-200 bg-zinc-50/50 dark:border-zinc-850 dark:bg-zinc-900/10 font-mono text-[11px] leading-relaxed">
            <span className="font-bold text-zinc-800 dark:text-zinc-200 uppercase tracking-wide block mb-1">
              Configuration Storage
            </span>
            <span>Database: projects/&#123;project-slug&#125;/config.db</span>
            <br />
            <span>
              Output Database: projects/&#123;project-slug&#125;/&#123;project-slug&#125;.db
            </span>
          </div>
        </div>
      ),
    },
    {
      id: 'imputation',
      title: 'Affiliation & Country Imputation',
      subtitle: 'Heuristic cascade & metadata restoration',
      icon: <BookOpen className="h-4 w-4" />,
      content: (
        <div className="flex flex-col gap-6 text-sm leading-relaxed">
          <div className="flex flex-col gap-2">
            <h2 className="text-lg font-mono font-bold border-b border-zinc-200 dark:border-zinc-800 pb-2 uppercase tracking-wide">
              Affiliation & Country Imputation Engine
            </h2>
            <p className="text-zinc-600 dark:text-zinc-400">
              Stratum implements a two-tier imputation architecture to resolve missing institutional and country affiliations:
              a high-throughput <strong>Pre-Ingestion JSONL Cascade</strong> running before database conversion, and an
              <strong>In-Database Metadata Restoration Engine</strong> operating directly on DuckDB.
            </p>
          </div>

          {/* Section 1: Pre-Ingestion JSONL Country Imputation */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 pb-1.5">
              <h3 className="font-mono font-bold uppercase text-xs text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                <span>1. Pre-Ingestion JSONL Cascade (<code>openalex impute-country</code>)</span>
              </h3>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800">
                100% Non-Destructive
              </span>
            </div>
            <p className="text-xs text-zinc-600 dark:text-zinc-400 font-sans">
              Executes directly over raw OpenAlex publication records in <code>.jsonl</code> format before DuckDB import. The source JSONL file is never modified; results are written to an isolated <code>&lt;file&gt;_imputed.jsonl</code>. Each authorship passes through a 4-stage sequential heuristic cascade:
            </p>

            <div className="grid grid-cols-1 gap-2.5 mt-1 font-sans">
              <div className="p-3 rounded border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/30 flex flex-col gap-1">
                <div className="flex items-center gap-2 font-mono text-xs font-bold text-zinc-800 dark:text-zinc-200">
                  <span className="px-1.5 py-0.5 rounded bg-zinc-200 dark:bg-zinc-800 text-[10px]">Stage 01</span>
                  <span>Preserve Existing OpenAlex Codes</span>
                </div>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 pl-7">
                  Valid ISO-2 and ISO-3 country codes already populated by OpenAlex in <code>institution.country_code</code> or <code>authorship.countries</code> are standardized and preserved intact without redundant remote lookups.
                </p>
              </div>

              <div className="p-3 rounded border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/30 flex flex-col gap-1">
                <div className="flex items-center gap-2 font-mono text-xs font-bold text-zinc-800 dark:text-zinc-200">
                  <span className="px-1.5 py-0.5 rounded bg-zinc-200 dark:bg-zinc-800 text-[10px]">Stage 02</span>
                  <span>Authoritative ROR Registry Lookup</span>
                </div>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 pl-7">
                  For institutions with an ROR identifier (<code>ror_id</code>) missing a country code, the engine queries <code>api.ror.org/v2/organizations/&#123;ror_id&#125;</code>. Uses exact ID matching with rate limiting (0.15s delay) and memoized in-memory caching to prevent API throttling and eliminate entity drift.
                </p>
              </div>

              <div className="p-3 rounded border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/30 flex flex-col gap-1">
                <div className="flex items-center gap-2 font-mono text-xs font-bold text-zinc-800 dark:text-zinc-200">
                  <span className="px-1.5 py-0.5 rounded bg-zinc-200 dark:bg-zinc-800 text-[10px]">Stage 03</span>
                  <span>Affiliation String Regex & Gazetteer Heuristics</span>
                </div>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 pl-7">
                  Scans raw affiliation strings (<code>raw_affiliation_strings</code>) using word-boundary regular expressions against hierarchical gazetteers in strict precedence:
                </p>
                <ul className="list-disc pl-12 text-[11px] text-zinc-500 dark:text-zinc-400 flex flex-col gap-1 mt-1 font-sans">
                  <li><strong>Country Names & Aliases</strong>: Sorted longest phrase first (e.g., "People's Republic of China", "United States of America", "South Korea", "Great Britain") to prevent substring collisions.</li>
                  <li><strong>Indian States & Union Territories</strong>: Matches all 36 Indian states and UTs (e.g., "Karnataka", "Tamil Nadu", "Maharashtra", "Delhi", "Telangana") &rarr; <code>IN</code>.</li>
                  <li><strong>US States & Territories</strong>: Matches all 50 US states, DC, and territories (e.g., "California", "Massachusetts", "Puerto Rico") &rarr; <code>US</code>.</li>
                  <li><strong>US State Abbreviations</strong>: Strictly delimited by punctuation and word boundaries (e.g., <code>, CA,</code>, <code>(MA)</code>, <code> TX </code>) &rarr; <code>US</code> to eliminate spurious two-letter false positives.</li>
                </ul>
              </div>

              <div className="p-3 rounded border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/30 flex flex-col gap-1">
                <div className="flex items-center gap-2 font-mono text-xs font-bold text-zinc-800 dark:text-zinc-200">
                  <span className="px-1.5 py-0.5 rounded bg-zinc-200 dark:bg-zinc-800 text-[10px]">Stage 04</span>
                  <span>Institution Display Name Inspection</span>
                </div>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 pl-7">
                  When raw affiliation strings are absent or uninformative, a fallback scanner evaluates tokens within <code>institution.display_name</code> against national and regional entity markers (e.g., "Indian Institute of Science" &rarr; <code>IN</code>).
                </p>
              </div>
            </div>

            {/* Dual Authorship Resolution */}
            <div className="p-3.5 border border-zinc-200 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-900/20 rounded font-mono text-[11px] leading-relaxed flex flex-col gap-1.5">
              <span className="font-bold text-zinc-800 dark:text-zinc-200 uppercase tracking-wide">
                Dual Authorship Resolution Mechanics
              </span>
              <div className="text-zinc-600 dark:text-zinc-400 font-sans text-xs">
                <strong>Authorship with Institution:</strong> Imputed country is injected directly into <code>institution.country_code</code>.<br />
                <strong>Authorship without Institution:</strong> Inferred country is written into <code>authorship.countries = [country_code]</code>, enabling downstream JSONL &rarr; CSV &rarr; DuckDB loaders to populate the <code>contributions</code> table seamlessly.
              </div>
            </div>
          </div>

          {/* Section 2: In-Database Enrichment Engine */}
          <div className="flex flex-col gap-3">
            <h3 className="font-mono font-bold uppercase text-xs text-zinc-900 dark:text-zinc-100 border-b border-zinc-200 dark:border-zinc-800 pb-1.5">
              2. In-Database Metadata Restoration (<code>impute/impute.go</code>)
            </h3>
            <p className="text-xs text-zinc-600 dark:text-zinc-400 font-sans">
              For papers already loaded into DuckDB that lack complete metadata, the Go engine executes deep post-ingestion enrichment:
            </p>
            <ul className="list-disc pl-5 flex flex-col gap-2 text-xs text-zinc-600 dark:text-zinc-400 font-sans">
              <li>
                <strong>Crossref DOI Resolution (<code>ImputeCrossRef</code>)</strong>: Queries Crossref works metadata using DOIs to restore missing author affiliation strings and ORCIDs.
              </li>
              <li>
                <strong>LLM Named Entity Extraction (<code>ImputeLLM</code>)</strong>: Submits unstructured affiliation strings to local Ollama (Llama 3, Mistral, Qwen) or Google Gemini API to extract normalized institution names and ISO-2 country codes.
              </li>
              <li>
                <strong>Full-Text PDF Extraction (<code>ImputePDF</code>)</strong>: For open-access preprints and papers (arXiv, Unpaywall), downloads PDF streams, parses first-page text objects, and extracts missing affiliations via LLM prompting.
              </li>
            </ul>
          </div>

          {/* Section 3: REST & CLI Reference */}
          <div className="flex flex-col gap-3">
            <h3 className="font-mono font-bold uppercase text-xs text-zinc-900 dark:text-zinc-100 border-b border-zinc-200 dark:border-zinc-800 pb-1.5">
              CLI & REST API Control
            </h3>
            <div className="p-4 border border-zinc-200 bg-zinc-50/50 dark:border-zinc-850 dark:bg-zinc-900/10 font-mono text-[11px] leading-relaxed flex flex-col gap-2">
              <div>
                <span className="font-bold text-zinc-800 dark:text-zinc-200">CLI Command:</span>
                <br />
                <code>openalex impute-country &lt;input.jsonl&gt; [-o &lt;output.jsonl&gt;] [--limit N] [--ror/--no-ror]</code>
              </div>
              <div>
                <span className="font-bold text-zinc-800 dark:text-zinc-200">REST Endpoints:</span>
                <br />
                <span className="text-zinc-900 dark:text-zinc-100 font-bold">POST /api/impute/run?project=&#123;slug&#125;</span> — Launches background country imputation job
                <br />
                <span className="text-zinc-900 dark:text-zinc-100 font-bold">GET /api/impute/status?project=&#123;slug&#125;</span> — Streams live execution logs, progress %, and metrics
                <br />
                <span className="text-zinc-900 dark:text-zinc-100 font-bold">POST /api/impute/cancel?project=&#123;slug&#125;</span> — Gracefully cancels ongoing imputation process
                <br />
                <span className="text-zinc-900 dark:text-zinc-100 font-bold">GET /api/impute/files?project=&#123;slug&#125;</span> — Scans project directory for raw and imputed JSONL files
                <br />
                <span className="text-zinc-900 dark:text-zinc-100 font-bold">GET /api/download/file?path=&#123;path&#125;</span> — Direct file download for resulting imputed JSONL
              </div>
            </div>
          </div>
        </div>
      ),
    },
    {
      id: 'schema',
      title: 'SQL Schema Reference',
      subtitle: 'DuckDB database design',
      icon: <Database className="h-4 w-4" />,
      content: (
        <div className="flex flex-col gap-5 text-sm leading-relaxed">
          <h2 className="text-lg font-mono font-bold border-b border-zinc-200 dark:border-zinc-800 pb-2 uppercase tracking-wide">
            Relational DuckDB Schema
          </h2>
          <p>DuckDB tables store academic indexes. Below are the structural descriptions:</p>

          <div className="overflow-x-auto border border-zinc-200 dark:border-zinc-800 rounded">
            <table className="w-full border-collapse text-left font-mono text-[11px]">
              <thead>
                <tr className="bg-zinc-50 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800 text-zinc-500">
                  <th className="p-2.5 border-r border-zinc-200 dark:border-zinc-800 font-bold uppercase">
                    Table
                  </th>
                  <th className="p-2.5 border-r border-zinc-200 dark:border-zinc-800 font-bold uppercase">
                    Columns
                  </th>
                  <th className="p-2.5 font-bold uppercase">Primary Keys / Indexes</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-zinc-150 dark:border-zinc-850 hover:bg-zinc-50/40">
                  <td className="p-2.5 border-r border-zinc-200 dark:border-zinc-800 font-bold text-zinc-800 dark:text-zinc-200">
                    papers
                  </td>
                  <td className="p-2.5 border-r border-zinc-200 dark:border-zinc-800 text-[10px] break-all leading-normal max-w-md">
                    id, doi, title, publication_year, publication_date, type, journal_name, journal_issn, is_core_journal, publisher, is_oa, oa_status, oa_url, cited_by_count, citation_percentile, is_top_1_percent, is_top_10_percent, fwci, primary_topic_id, primary_topic_name, primary_topic_score, primary_topic_field, primary_topic_subfield, primary_topic_domain, institutions_distinct_count, countries_distinct_count, is_international, abstract_text, updated_date
                  </td>
                  <td className="p-2.5">id (VARCHAR) PRIMARY KEY</td>
                </tr>
                <tr className="border-b border-zinc-150 dark:border-zinc-850 hover:bg-zinc-50/40">
                  <td className="p-2.5 border-r border-zinc-200 dark:border-zinc-800 font-bold text-zinc-800 dark:text-zinc-200">
                    authors
                  </td>
                  <td className="p-2.5 border-r border-zinc-200 dark:border-zinc-800 text-[10px]">
                    id, display_name, orcid
                  </td>
                  <td className="p-2.5">id (VARCHAR) PRIMARY KEY</td>
                </tr>
                <tr className="border-b border-zinc-150 dark:border-zinc-850 hover:bg-zinc-50/40">
                  <td className="p-2.5 border-r border-zinc-200 dark:border-zinc-800 font-bold text-zinc-800 dark:text-zinc-200">
                    institutions
                  </td>
                  <td className="p-2.5 border-r border-zinc-200 dark:border-zinc-800 text-[10px]">
                    id, display_name, country_code, type, ror_id, is_synthetic
                  </td>
                  <td className="p-2.5">id (VARCHAR) PRIMARY KEY</td>
                </tr>
                <tr className="border-b border-zinc-150 dark:border-zinc-850 hover:bg-zinc-50/40">
                  <td className="p-2.5 border-r border-zinc-200 dark:border-zinc-800 font-bold text-zinc-800 dark:text-zinc-200">
                    countries
                  </td>
                  <td className="p-2.5 border-r border-zinc-200 dark:border-zinc-800 text-[10px]">
                    id, country_name, country_code, status
                  </td>
                  <td className="p-2.5">id (INTEGER) PRIMARY KEY, country_code UNIQUE</td>
                </tr>
                <tr className="border-b border-zinc-150 dark:border-zinc-850 hover:bg-zinc-50/40">
                  <td className="p-2.5 border-r border-zinc-200 dark:border-zinc-800 font-bold text-zinc-800 dark:text-zinc-200">
                    contributions
                  </td>
                  <td className="p-2.5 border-r border-zinc-200 dark:border-zinc-800 text-[10px] break-all leading-normal max-w-md">
                    row_id, paper_id, author_id, institution_id, country_code, author_name, author_position, is_corresponding, raw_affiliation_string
                  </td>
                  <td className="p-2.5">row_id (INTEGER) PRIMARY KEY</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      ),
    },
    {
      id: 'api',
      title: 'REST & MCP API',
      subtitle: 'Integration specifications',
      icon: <Code2 className="h-4 w-4" />,
      content: (
        <div className="flex flex-col gap-5 text-sm leading-relaxed">
          <h2 className="text-lg font-mono font-bold border-b border-zinc-200 dark:border-zinc-800 pb-2 uppercase tracking-wide">
            System Integration
          </h2>
          <p>
            Stratum operates as an MCP stdio server for AI clients or as an HTTP daemon serving
            dashboard APIs.
          </p>

          <h3 className="font-mono font-bold uppercase text-xs text-zinc-500">
            MCP Tool Definitions
          </h3>
          <ul className="list-disc pl-5 flex flex-col gap-2">
            <li>
              <code>validate</code>: Parses SQLite config settings and reports validation status.
            </li>
            <li>
              <code>search</code>: Returns count of matching works.
            </li>
            <li>
              <code>download</code>: Pulls works and saves to JSONL output path.
            </li>
            <li>
              <code>convert_db</code>: Ingests JSONL database records into DuckDB.
            </li>
            <li>
              <code>impute</code>: Triggers affiliation and country code imputation pipelines.
            </li>
          </ul>

          <h3 className="font-mono font-bold uppercase text-xs text-zinc-500">REST Endpoints</h3>
          <div className="p-4 border border-zinc-200 bg-zinc-50/50 dark:border-zinc-850 dark:bg-zinc-900/10 font-mono text-[11px] leading-relaxed flex flex-col gap-1.5">
            <div>
              <span className="text-zinc-900 dark:text-zinc-100 font-bold">GET /api/projects</span>{' '}
              — Lists all dynamic project technology workspaces
            </div>
            <div>
              <span className="text-zinc-900 dark:text-zinc-100 font-bold">
                POST /api/projects/create
              </span>{' '}
              — Creates a new project database and configuration workspace
            </div>
            <div>
              <span className="text-zinc-900 dark:text-zinc-100 font-bold">POST /api/upload</span> —
              Uploads catalog files (.csv, .xlsx, .xls) and returns column headers
            </div>
            <div>
              <span className="text-zinc-900 dark:text-zinc-100 font-bold">POST /api/tfidf</span> —
              Extracts TF-IDF candidate pool (default 20) with KeyBERT allenai-specter semantic re-ranking (α=0.1)
            </div>
            <div>
              <span className="text-zinc-900 dark:text-zinc-100 font-bold">POST /api/download-papers</span> —
              Initiates background batch download of matching OpenAlex works to JSONL
            </div>
            <div>
              <span className="text-zinc-900 dark:text-zinc-100 font-bold">POST /api/db/import-jsonl</span> —
              Normalizes and loads downloaded JSONL papers into DuckDB relational tables
            </div>
            <div>
              <span className="text-zinc-900 dark:text-zinc-100 font-bold">GET /api/stats</span> —
              Returns paper database summary metrics and counts
            </div>
            <div>
              <span className="text-zinc-900 dark:text-zinc-100 font-bold">GET /api/config</span> —
              Retrieves current project settings and anchor DOIs
            </div>
            <div>
              <span className="text-zinc-900 dark:text-zinc-100 font-bold">POST /api/config</span> —
              Saves updated configuration revisions to the sqlite database
            </div>
            <div>
              <span className="text-zinc-900 dark:text-zinc-100 font-bold">POST /api/query</span> —
              Executes SQL queries against DuckDB relational tables or raw JSONL via read_json_auto()
            </div>
            <div>
              <span className="text-zinc-900 dark:text-zinc-100 font-bold">POST /api/impute/run</span> —
              Launches openalex impute-country cascade with ROR lookup and gazetteer heuristics
            </div>
            <div>
              <span className="text-zinc-900 dark:text-zinc-100 font-bold">GET /api/impute/status</span> —
              Polls real-time country imputation progress, execution logs, and institution metrics
            </div>
            <div>
              <span className="text-zinc-900 dark:text-zinc-100 font-bold">POST /api/impute/cancel</span> —
              Gracefully terminates active country imputation background task
            </div>
            <div>
              <span className="text-zinc-900 dark:text-zinc-100 font-bold">GET /api/impute/files</span> —
              Scans workspace for raw and imputed OpenAlex JSONL files
            </div>
          </div>
        </div>
      ),
    },
  ]

  const activeGuide = guides.find((g) => g.id === activeGuideId) || guides[0]

  return (
    <div className="flex flex-col gap-8 w-full">
      {/* Header Row */}
      <div className="flex flex-col gap-1 border-b border-zinc-200 pb-5 dark:border-zinc-850">
        <h1 className="text-2xl font-mono font-bold tracking-tight text-zinc-950 dark:text-zinc-50 uppercase">
          Developer Documentation
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Integrated user manuals, pipeline descriptions, schema structures, and API references.
        </p>
      </div>

      {/* Side-by-Side Reading Layout */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6 items-start">
        {/* Left Side: Navigation Sidebar */}
        <div className="md:col-span-1 flex flex-col gap-1 border border-zinc-200 dark:border-zinc-850 bg-zinc-50/40 dark:bg-zinc-900/10 p-2.5 rounded">
          {guides.map((guide) => (
            <button
              key={guide.id}
              onClick={() => setActiveGuideId(guide.id)}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded text-left transition font-mono text-xs select-none ${
                activeGuideId === guide.id
                  ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-950 font-bold'
                  : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-900/60'
              }`}
            >
              <div className="flex items-center gap-2.5 truncate">
                <span className="shrink-0">{guide.icon}</span>
                <span className="truncate">{guide.title}</span>
              </div>
              <ArrowRight
                className={`h-3 w-3 shrink-0 ${activeGuideId === guide.id ? 'opacity-100' : 'opacity-0'}`}
              />
            </button>
          ))}
        </div>

        {/* Right Side: Read Panel */}
        <div className="md:col-span-3 border border-zinc-200 dark:border-zinc-850 p-6 rounded select-text">
          <div className="flex flex-col gap-1.5 border-b border-zinc-200 dark:border-zinc-850 pb-4 mb-6">
            <h1 className="text-xl font-mono font-bold tracking-tight text-zinc-900 dark:text-zinc-50 uppercase">
              {activeGuide.title}
            </h1>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 uppercase tracking-wider font-mono font-semibold">
              {activeGuide.subtitle}
            </p>
          </div>
          {activeGuide.content}
        </div>
      </div>
    </div>
  )
}
export { Docs as default }
