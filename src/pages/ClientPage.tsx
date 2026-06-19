import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Copy, Check, Download, Terminal, RefreshCw, KeyRound, FileText } from 'lucide-react'

// The app's own backend (not the WIP proxy): kb-client + gateway routes are
// served at {BASE_URL}server-api/* and authed by the app session — no X-API-Key
// needed from the browser (same pattern as BootstrapGate).
const SERVER_API = `${import.meta.env.BASE_URL}server-api`
const KBC = `${SERVER_API}/kb-client`

interface Manifest {
  client?: string
  client_version?: string
  schema_version?: string
  install_endpoint?: string
  served_from?: string
  manifest_endpoint?: string
  version_contract?: string
  note?: string
  files?: string[]
  bundle_digest?: string
}

// Roles for the served files (the manifest derives files[] from disk but carries
// no per-file role). `retired` writers are flagged — writes go through the
// gateway verbs now (CASE-464). `extra` = served alongside the .py files[].
type Role = { role: string; retired?: boolean; extra?: boolean }
const FILE_ROLES: Record<string, Role> = {
  'kb-client.sh': { role: 'Runner — fetches/refreshes the bundle; run scripts via it', extra: true },
  'install.sh': { role: 'Bootstrap — `curl | sh` materializes the bundle', extra: true },
  'case-fetch.py': { role: 'Read — fetch a case / list cases' },
  'kb_write_core.py': { role: 'Shared core — doc builders + kb.json/key resolution' },
  'stats-to-kb.py': { role: 'Stats — computes locally, POSTs /stats/snapshot' },
  'add-to-kb.py': { role: 'Retired writer — file/transition via gateway verbs', retired: true },
  'case_allocate.py': { role: 'Retired — allocation is a gateway verb now', retired: true },
  'case-update.py': { role: 'Retired writer — transitions via gateway verbs', retired: true },
  'kb-bulk-mirror.py': { role: 'Retired writer — mirror via gateway verbs (--dry-run stays)', retired: true },
  'case-workflow.md': { role: 'Playbook — authoritative case how-to (rendered below)', extra: true },
  'README.md': { role: 'Bundle readme', extra: true },
  'manifest.json': { role: 'Manifest (schema_version, version_contract)', extra: true },
}
// Order extras after the scripts; manifest.json last.
const EXTRA_ORDER = ['kb-client.sh', 'install.sh', 'case-workflow.md', 'README.md', 'manifest.json']

const SERVING_ENDPOINTS: Array<[string, string, string]> = [
  ['GET', 'kb-client/manifest', 'schema_version, files[], bundle_digest (derived at serve time)'],
  ['GET', 'kb-client/download', 'whole bundle as one-shot JSON { files: {name: content} }'],
  ['GET', 'kb-client/files/:name', 'a single whitelisted bundle file (text/plain)'],
  ['GET', 'kb-client/install', 'the bootstrap shell script (curl | sh target)'],
]
const GATEWAY_ENDPOINTS: Array<[string, string, string]> = [
  ['GET', 'kb/cases?status=&since=', 'list cases (projections)'],
  ['GET', 'kb/cases/:n', 'one case incl. body (CASE-<n> synonym)'],
  ['GET', 'kb/sessions  ·  kb/journeys/:day', 'list sessions / a journey day'],
  ['POST', 'kb/cases', 'file a case (allocates number + synonym + REFERENCES)'],
  ['POST', 'kb/cases/:n/{respond,comment,close,implement}', 'append a section + drive the status machine'],
  ['POST', 'kb/{sessions,journeys,documents}/mirror', 'upsert a session / journey / document'],
  ['POST', 'kb/stats/snapshot', 'record a GIT_STATS_SNAPSHOT'],
]

function Copyable({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="group relative">
      <pre className="overflow-x-auto rounded-md border border-gray-200 bg-background px-3 py-2.5 pr-10 font-mono text-xs leading-relaxed text-text">
        {text}
      </pre>
      <button
        type="button"
        aria-label={label ?? 'Copy'}
        onClick={() => {
          navigator.clipboard.writeText(text).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
          })
        }}
        className="absolute right-1.5 top-1.5 rounded p-1.5 text-text-muted hover:bg-surface hover:text-text"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-primary" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  )
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Terminal
  title: string
  children: ReactNode
}) {
  return (
    <section className="rounded-lg border border-gray-200 bg-surface p-5">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold tracking-tight text-text">
        <Icon className="h-4 w-4 text-primary" />
        {title}
      </h2>
      {children}
    </section>
  )
}

export default function ClientPage() {
  const manifestQ = useQuery<Manifest>({
    queryKey: ['kb-client-manifest'],
    queryFn: async () => {
      const res = await fetch(`${KBC}/manifest`)
      if (!res.ok) throw new Error(`manifest ${res.status}`)
      return res.json()
    },
    staleTime: 60_000,
  })
  const playbookQ = useQuery<string>({
    queryKey: ['kb-client-playbook'],
    queryFn: async () => {
      const res = await fetch(`${KBC}/files/case-workflow.md`)
      if (!res.ok) throw new Error(`playbook ${res.status}`)
      return res.text()
    },
    staleTime: 60_000,
  })

  const m = manifestQ.data
  const origin = window.location.origin
  const installUrl = `${origin}${m?.install_endpoint ?? `${KBC}/install`}`
  const oneLiner = `curl -fsSk -H "X-API-Key: $(cat ~/.wip-deploy/kb/secrets/api-key)" \\\n  ${installUrl} | sh`
  const runCmd = `bash ~/.cache/wip-kb-client/kb-client.sh case-fetch.py case 471`

  // Build the file list: scripts (files[]) + the served extras, each downloadable.
  const scriptFiles = (m?.files ?? []).filter((n) => !EXTRA_ORDER.includes(n))
  const fileRows = [...scriptFiles, ...EXTRA_ORDER]
  const fileHref = (name: string) => `${KBC}/files/${encodeURIComponent(name)}`

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-text">Working against this KB</h1>
        <p className="mt-1.5 text-sm text-text-muted">
          This KB is the single source of truth. Interact three ways:{' '}
          <strong className="text-text">served CLI client</strong> (humans + YAC slash-commands),{' '}
          <strong className="text-text">gateway REST API</strong> (deterministic reads/writes), and{' '}
          <strong className="text-text">MCP</strong> (agents). The CLI client is fetched from this
          instance and refreshes itself — everything below is read live from what this instance
          actually serves.
        </p>
      </header>

      <Section icon={Terminal} title="Quick start">
        <p className="mb-2 text-sm text-text-muted">
          Install once (materializes <code className="font-mono text-xs">~/.cache/wip-kb-client/</code>
          ); the key is read from a file, never shown:
        </p>
        <Copyable text={oneLiner} label="Copy install one-liner" />
        <p className="mb-2 mt-3 text-sm text-text-muted">Then run any script through the runner:</p>
        <Copyable text={runCmd} label="Copy run command" />
        <p className="mt-3 text-sm text-text-muted">
          The instance the client targets is the single source of truth in{' '}
          <code className="font-mono text-xs">.claude/kb.json</code> (
          <code className="font-mono text-xs">kb_app_url</code> +{' '}
          <code className="font-mono text-xs">kb_api_key_file</code>) — the runner derives both from
          it, so a hostname change is one edit there.
        </p>
      </Section>

      <Section icon={RefreshCw} title="The bundle — self-refreshing">
        {manifestQ.isLoading && <p className="text-sm text-text-muted">Loading manifest…</p>}
        {manifestQ.error && (
          <p className="text-sm text-danger">Manifest unavailable: {(manifestQ.error as Error).message}</p>
        )}
        {m && (
          <>
            <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Stat label="client_version" value={m.client_version ?? '—'} />
              <Stat label="schema_version" value={m.schema_version ?? '—'} hint="write-safety / identity signal" />
              <Stat
                label="bundle_digest"
                value={m.bundle_digest ? `${m.bundle_digest.slice(0, 12)}…` : '—'}
                hint="currency signal — runner re-fetches on change"
              />
            </div>
            <p className="mb-3 text-sm text-text-muted">
              The runner compares this instance's <code className="font-mono text-xs">bundle_digest</code>{' '}
              to your cached one and re-fetches when it differs — install once, auto-updates. Client
              misbehaving? Re-run the install one-liner; that is the whole recovery.
            </p>
            <div className="overflow-x-auto rounded-md border border-gray-200">
              <table className="w-full text-left text-xs">
                <thead className="bg-background text-text-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">File</th>
                    <th className="px-3 py-2 font-medium">Role</th>
                    <th className="px-3 py-2 font-medium text-right">Get</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {fileRows.map((name) => {
                    const r = FILE_ROLES[name]
                    return (
                      <tr key={name} className={r?.retired ? 'opacity-60' : ''}>
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-text">{name}</td>
                        <td className="px-3 py-2 text-text-muted">
                          {r?.role ?? '—'}
                          {r?.retired && (
                            <span className="ml-1.5 rounded bg-gray-100 px-1 py-0.5 text-[10px] uppercase text-text-muted">
                              retired
                            </span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-right">
                          <a
                            href={fileHref(name)}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-primary hover:underline"
                          >
                            <Download className="h-3 w-3" /> file
                          </a>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <a
              href={`${KBC}/download`}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-gray-200 px-3 py-1.5 text-xs font-medium text-text hover:bg-background"
            >
              <Download className="h-3.5 w-3.5" /> Download whole bundle (JSON)
            </a>
          </>
        )}
      </Section>

      <Section icon={FileText} title="Endpoints">
        <EndpointTable caption="Serving the client" base={`${SERVER_API}/`} rows={SERVING_ENDPOINTS} />
        <div className="h-4" />
        <EndpointTable caption="Gateway — reading & writing KB" base={`${SERVER_API}/`} rows={GATEWAY_ENDPOINTS} />
        <p className="mt-3 text-sm text-text-muted">
          Writes are gateway verbs (CASE-464); the bundle has no write paths left. The playbook below
          is the authoritative how-to for filing and transitioning cases.
        </p>
      </Section>

      <Section icon={KeyRound} title="Auth & config">
        <ul className="space-y-1.5 text-sm text-text-muted">
          <li>
            • Every call needs <code className="font-mono text-xs">X-API-Key</code>; the key lives in a
            file (<code className="font-mono text-xs">{'~/.wip-deploy/<name>/secrets/api-key'}</code>),
            never pasted as a literal.
          </li>
          <li>
            • <code className="font-mono text-xs">.claude/kb.json</code> is the single source of truth
            for URL + key file; the runner and the python client derive both from it.
          </li>
          <li>
            • Pairing guard (CASE-444): overriding the base URL without the matching key fails loud —
            it will not silently pair the canonical key with a different instance.
          </li>
        </ul>
      </Section>

      <Section icon={FileText} title="Case playbook">
        <div className="mb-3">
          <a
            href={fileHref('case-workflow.md')}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 px-3 py-1.5 text-xs font-medium text-text hover:bg-background"
          >
            <Download className="h-3.5 w-3.5" /> Download case-workflow.md
          </a>
        </div>
        {playbookQ.isLoading && <p className="text-sm text-text-muted">Loading playbook…</p>}
        {playbookQ.error && (
          <p className="text-sm text-danger">Playbook unavailable: {(playbookQ.error as Error).message}</p>
        )}
        {playbookQ.data && (
          <div className="prose prose-sm max-w-none rounded-md border border-gray-200 bg-background p-4">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{playbookQ.data}</ReactMarkdown>
          </div>
        )}
      </Section>
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-gray-200 bg-background px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">{label}</div>
      <div className="font-mono text-sm text-text">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-text-muted">{hint}</div>}
    </div>
  )
}

function EndpointTable({
  caption,
  base,
  rows,
}: {
  caption: string
  base: string
  rows: Array<[string, string, string]>
}) {
  return (
    <div className="overflow-x-auto rounded-md border border-gray-200">
      <table className="w-full text-left text-xs">
        <thead className="bg-background text-text-muted">
          <tr>
            <th colSpan={3} className="px-3 py-2 font-semibold text-text">
              {caption} <span className="font-mono font-normal text-text-muted">{base}</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map(([method, path, desc]) => (
            <tr key={method + path}>
              <td className="whitespace-nowrap px-3 py-2 font-mono text-text-muted">{method}</td>
              <td className="whitespace-nowrap px-3 py-2 font-mono text-text">{path}</td>
              <td className="px-3 py-2 text-text-muted">{desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
