import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowLeft, Download, Search as SearchIcon } from 'lucide-react'
import {
  fetchProjectBrief,
  GatewayError,
  projectToolingUrl,
  type BriefItem,
  type BriefSection,
  type ProjectBrief,
} from '../lib/kbGateway'
import { CORPUS_NS } from '../lib/namespaces'
import { formatWipDate } from '../lib/datetime'

// Section order and headings for the brief's lists. The keys are the gateway's.
const SECTIONS: Array<{ key: string; title: string }> = [
  { key: 'open_cases', title: 'Open cases' },
  { key: 'decisions', title: 'Decisions' },
  { key: 'lessons', title: 'Lessons' },
  { key: 'firesides', title: 'Firesides' },
  { key: 'sessions', title: 'Recent sessions' },
  { key: 'memories', title: 'Memories' },
  { key: 'documents', title: 'Documents' },
]

function formatBytes(n: number | null): string {
  if (n === null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function ItemRow({ sectionKey, item }: { sectionKey: string; item: BriefItem }) {
  const detail =
    sectionKey === 'documents' && item.path
      ? `${item.path}${item.synced_from_sha ? ` @ ${item.synced_from_sha.slice(0, 8)}` : ''}`
      : sectionKey === 'memories' && item.title && item.description
        ? item.description
        : null
  return (
    <li className="flex items-baseline gap-2 py-1 text-sm">
      <Link
        to={`/doc/${item.document_id}`}
        className="shrink-0 font-mono text-xs text-primary underline-offset-2 hover:underline"
      >
        {item.handle}
      </Link>
      {(sectionKey === 'open_cases' || sectionKey === 'sessions') && item.status && (
        <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-text-muted">
          {item.status}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-text" title={item.title ?? item.description ?? ''}>
        {item.title || item.description || ''}
        {detail && <span className="text-text-muted"> · {detail}</span>}
      </span>
      {item.updated_at && (
        <span className="shrink-0 text-xs tabular-nums text-text-muted">{formatWipDate(item.updated_at)}</span>
      )}
    </li>
  )
}

function SectionBox({ sectionKey, title, section }: { sectionKey: string; title: string; section: BriefSection }) {
  const shown = section.items.length
  const count =
    section.total !== null && section.total > shown ? `${shown} of ${section.total}` : String(shown)
  return (
    <section className="rounded-lg border border-gray-200 bg-surface p-4">
      <h2 className="mb-2 flex items-baseline gap-2 text-sm font-semibold text-text">
        {title}
        {!section.unavailable && <span className="text-xs font-normal text-text-muted">{count}</span>}
      </h2>
      {section.unavailable ? (
        <p className="text-sm text-text-muted">Not available in this knowledge base.</p>
      ) : shown === 0 ? (
        <p className="text-sm text-text-muted">None tagged with this project.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {section.items.map((it) => (
            <ItemRow key={it.document_id} sectionKey={sectionKey} item={it} />
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * `/project/:app` — one project's page: its profile, its tooling archive, and the
 * documents tagged with it. Read-only; it shows the same brief a project's Claude
 * reads at session start.
 */
export default function ProjectPage() {
  const { app = '' } = useParams<{ app: string }>()
  const navigate = useNavigate()
  const q = useQuery<ProjectBrief>({
    queryKey: ['project-brief', CORPUS_NS, app],
    queryFn: () => fetchProjectBrief(app, CORPUS_NS),
    enabled: app.length > 0,
    staleTime: 30_000,
    // An unknown project is a 404 and stays one; retry only a server-side failure.
    retry: (count, e) => count < 2 && (e as GatewayError).status >= 500,
  })

  if (q.isLoading) return <p className="text-text-muted">Loading…</p>
  if (q.error) return <p className="text-danger">Failed to load project: {(q.error as Error).message}</p>
  const brief = q.data
  if (!brief) return <p className="text-text-muted">Not found.</p>
  const profile = brief.project

  return (
    <article className="min-w-0">
      <header className="mb-6">
        <div className="mb-3 flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="-ml-1 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-muted hover:bg-background hover:text-text focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back
          </button>
          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
            Project
          </span>
        </div>
        <h1 className="flex items-baseline gap-2 text-2xl font-semibold tracking-tight text-text">
          <span className="shrink-0 rounded bg-primary/10 px-2 py-0.5 font-mono text-lg font-semibold text-primary">
            {brief.app}
          </span>
          {profile?.title && <span>{profile.title}</span>}
        </h1>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
          {profile ? (
            <Link to={`/doc/${profile.document_id}`} className="text-primary underline-offset-2 hover:underline">
              Profile document
            </Link>
          ) : (
            <span>No profile document for this project yet.</span>
          )}
          {profile && profile.repo_ids.length > 0 && <span>Repositories: {profile.repo_ids.join(', ')}</span>}
          <Link
            to={`/search?p=${encodeURIComponent(brief.app)}`}
            className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
          >
            <SearchIcon className="h-3 w-3" />
            All its documents
          </Link>
        </p>
      </header>

      {profile?.tooling && (
        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-md border border-gray-200 bg-surface px-4 py-2.5 text-sm">
          <a
            href={projectToolingUrl(brief.app, brief.namespace)}
            className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline"
          >
            <Download className="h-4 w-4" />
            {profile.tooling.filename || 'Tooling archive'}
          </a>
          {profile.tooling.size_bytes !== null && (
            <span className="text-xs text-text-muted">{formatBytes(profile.tooling.size_bytes)}</span>
          )}
          <span className="text-xs text-text-muted">Downloaded as stored; never unpacked by the KB.</span>
        </div>
      )}

      {profile?.scope && (
        <div className="prose prose-gray prose-sm mb-8 max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{profile.scope}</ReactMarkdown>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {SECTIONS.map(({ key, title }) => {
          const section = brief.sections[key]
          return section ? <SectionBox key={key} sectionKey={key} title={title} section={section} /> : null
        })}
      </div>

      {brief.notes.length > 0 && (
        <ul className="mt-6 space-y-1 text-xs text-text-muted">
          {brief.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </article>
  )
}
