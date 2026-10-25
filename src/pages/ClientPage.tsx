import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Copy, Check, Download, Terminal, RefreshCw, KeyRound, FileText, Library, Boxes, Layers } from 'lucide-react'

// The app's own backend (not the WIP proxy): kb-client + gateway routes are
// served at {BASE_URL}server-api/* and authed by the app session — no X-API-Key
// needed from the browser (same pattern as BootstrapGate).
const SERVER_API = `${import.meta.env.BASE_URL}server-api`
const KBC = `${SERVER_API}/kb-client`

interface Manifest {
  client?: string
  client_version?: string
  install_endpoint?: string
  served_from?: string
  manifest_endpoint?: string
  version_contract?: string
  note?: string
  files?: string[]
  bundle_digest?: string
}

// Roles for the served files (the manifest derives files[] from disk but carries
// no per-file role). The client is gateway-only over one transport core; writes
// go through the single POST /write/:type (CASE-482). `extra` = served alongside
// the .py files[].
type Role = { role: string; extra?: boolean }
const FILE_ROLES: Record<string, Role> = {
  'kb-client.sh': { role: 'Runner — fetches/refreshes the bundle; run scripts via it', extra: true },
  'install.sh': { role: 'Bootstrap — `curl | sh` materializes the bundle', extra: true },
  'kb_client_core.py': { role: 'Shared core — kb.json/API-key resolution + gateway transport (gw_get/gw_post/gw_post_bytes, failover)' },
  'case-fetch.py': { role: 'Read — case (body + response thread) / journey / list / fireside / library / edges / flags / read <TYPE> (generic typed read) / search (full-text across a knowledge base + library, --namespace to pick one; --project for one project) / topics (the topic vocabulary writes are validated against) / brief [<app>] (a project\'s context in one read; --tooling DIR saves its tooling archive), all via the gateway' },
  'kb-namespace.py': { role: 'Create a new knowledge base — a namespace seeded with the full KB model, via POST /namespaces' },
  'kb-write.py': { role: 'The write client — any doc type via POST /write/:type (file/dir/json sources, edges, patch, git-stats via --git-repo, and PROJECT --tooling PATH to attach a project\'s tooling archive)' },
  'case-workflow.md': { role: 'Playbook — authoritative case how-to (rendered below)', extra: true },
  'README.md': { role: 'Bundle readme', extra: true },
  'manifest.json': { role: 'Manifest (version_contract, bundle_digest)', extra: true },
}
// Order extras after the scripts; manifest.json last.
const EXTRA_ORDER = ['kb-client.sh', 'install.sh', 'case-workflow.md', 'README.md', 'manifest.json']

// The LIBRARY_DOC receive contract (CASE-518) — the fields a producer supplies to
// submit a doc to the Technical Library. Identity in bold; the library is agnostic
// to who/how a doc is produced, it owns only this format.
const LIBRARY_FIELDS: Array<[string, string, string]> = [
  ['slug', 'identity', 'manifest doc-slug, e.g. document-store-api'],
  ['release', 'identity', 'product line term (wip-v1, wip-v2…) — keeps v1/v2 libraries parallel; NOT the doc version'],
  ['category', 'required', 'concept | api | lib | cli'],
  ['title', 'required', 'display title'],
  ['body', 'required', 'the markdown after the frontmatter fence'],
  ['doc_status', 'default published', 'draft | published | deprecated'],
  ['audience', 'optional', 'target reader'],
  ['source_scope', 'optional', 'array of code paths/sources (provenance)'],
  ['generated_from_rev', 'optional', 'git sha at generation (provenance; carried, not acted on)'],
  ['kb_refs', 'optional', 'array of corpus document_ids — Library→KB links'],
]

const LIBRARY_SAMPLE = `---
slug: document-store-api
release: wip-v1
category: api
title: Document Store API
audience: integrators
source_scope: [schemas/document-store.json, components/document-store/src]
generated_from_rev: 69841f4f
---

# Document Store API
… generated body …`

const KBC_RUN = 'bash ~/.cache/wip-kb-client/kb-client.sh'

const PROJECT_PROFILE = `${KBC_RUN} kb-write.py PROJECT --json '{
  "app": "<project>",
  "title": "<display name>",
  "body": "<scope: what the project is, what it owns, where its code lives>",
  "repo_ids": ["<repository id>"],
  "authored_by": "<your session id>",
  "doc_status": "published"
}'`

const KB_JSON_SAMPLE = `{
  "kb_app_url": "https://kb.internal",
  "kb_api_key_file": "<the KB API key file issued when your project was installed>",
  "namespace": "kb",
  "project": "<project>"
}`

const SERVING_ENDPOINTS: Array<[string, string, string]> = [
  ['GET', 'kb-client/manifest', 'files[] + bundle_digest (derived at serve time)'],
  ['GET', 'kb-client/download', 'whole bundle as one-shot JSON { files: {name: content} }'],
  ['GET', 'kb-client/files/:name', 'a single whitelisted bundle file (text/plain)'],
  ['GET', 'kb-client/install', 'the bootstrap shell script (curl | sh target)'],
]
const GATEWAY_ENDPOINTS: Array<[string, string, string]> = [
  ['GET', 'kb/cases?status=&filed_by=&severity=&type=&component=&app=', 'list cases (faceted, server-side)'],
  ['GET', 'kb/cases/:n?view=both|case|responses[&response=latest|<seq>]', 'one case: body, response thread, or both (default both)'],
  ['GET', 'kb/sessions  ·  kb/journeys/:day', 'list sessions / a journey day'],
  ['GET', 'kb/firesides  ·  kb/firesides/:id', 'list firesides / one fireside body (:id = a FIRESIDE-<n> synonym, a bare <n>, or a document_id)'],
  ['GET', 'kb/library-docs  ·  kb/library-docs/:slug', 'list published LIBRARY_DOCs / one body (?release= required for a slug)'],
  ['GET', 'kb/read/:type', 'generic typed read — every writable type is readable; each query param is an eq-filter on data.<field> (a term field matches the resolved term, so any alias finds it)'],
  ['GET', 'kb/search?q=&mode=auto|fts|substring&type=&limit=&app=', 'full-text search across a knowledge base (?namespace=, default: the instance\'s) plus the library, merged, ranked, with snippets; ?app= keeps only one project\'s documents'],
  ['GET', 'kb/flags', 'flag-for-YAC dispatch queue — FLAG_RECORDs joined to their target doc'],
  ['GET', 'kb/edges/:handle', 'every edge touching a doc, both directions (handle = synonym or document_id)'],
  ['GET', 'kb/types', 'doc-type manifest — write_mode + home namespace per type (spans corpus + library)'],
  ['GET', 'kb/topics?type=&namespace=', 'the topic vocabulary a type\'s validated `topics` field draws from, as a hierarchy with aliases'],
  ['POST', 'kb/write/:type', 'THE write path — {data, edges[]} or {patch, match}. Routes to the type’s home namespace (LIBRARY_DOC → library)'],
  ['POST', 'kb/edges', 'attach an edge between two EXISTING docs — the sanctioned retry for a failed edge intent'],
  ['GET', 'kb/projects/:app/brief?namespace=', 'a project\'s context in one read: PROJECT profile, open cases, newest decisions/lessons/firesides, recent sessions, memories, mirrored docs (handles + titles); :app = any alias'],
  ['GET', 'kb/projects/:app/tooling?namespace=', 'the project\'s tooling archive, streamed as stored (never unpacked or run)'],
  ['POST', 'kb/projects/:app/tooling?namespace=', 'attach or replace the project\'s tooling archive: body = the archive, X-Filename = its name; uploaded with your key and linked to the profile (the replaced archive stays in WIP, unreferenced)'],
  ['POST', 'kb/namespaces', 'create a new knowledge base — a namespace seeded with the full KB model; 409 if it exists (never re-seeds)'],
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

/**
 * `/client` route — in-app documentation of the served kb-client. Fetches the
 * bundle manifest from `/server-api/kb-client/manifest` and renders each served
 * file with its role (the CLI YACs install to read/write the KB). Read-only.
 */
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
  const oneLiner = `curl -fsSk -H "X-API-Key: $(cat <key-file>)" \\\n  ${installUrl} | KB_API_KEY_FILE=<key-file> sh`
  const readCmd = `bash ~/.cache/wip-kb-client/kb-client.sh case-fetch.py case 471`
  const writeCmd = `bash ~/.cache/wip-kb-client/kb-client.sh kb-write.py DESIGN_DECISION decision.md`

  // The served bundle: scripts (manifest files[]) + the served extras. Reads and
  // writes both go through the gateway over one shared core; kb-write.py is the
  // single write client (POST /write/:type) — CASE-482.
  const fileHref = (name: string) => `${KBC}/files/${encodeURIComponent(name)}`
  const fileRows = [
    ...(m?.files ?? []).filter((n) => !EXTRA_ORDER.includes(n)),
    ...EXTRA_ORDER,
  ]

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-text">Working against this KB</h1>
        <p className="mt-1.5 text-sm text-text-muted">
          This KB is the single source of truth. Interact three ways:{' '}
          <strong className="text-text">served CLI client</strong> (humans + YAC slash-commands),{' '}
          <strong className="text-text">gateway REST API</strong> (deterministic reads/writes), and{' '}
          <strong className="text-text">MCP</strong> (agents). Its content is organised in{' '}
          <strong className="text-text">knowledge bases</strong> (one namespace each), and inside one,
          by <strong className="text-text">project</strong>. The CLI client is fetched from this
          instance and refreshes itself; the file list and version below are read live from what
          this instance serves.
        </p>
      </header>

      <Section icon={Terminal} title="Quick start">
        <p className="mb-2 text-sm text-text-muted">
          Install once (materializes <code className="font-mono text-xs">~/.cache/wip-kb-client/</code>
          ); the key is read from a file, never shown:
        </p>
        <Copyable text={oneLiner} label="Copy install one-liner" />
        <p className="mb-2 mt-3 text-sm text-text-muted">Read through the runner:</p>
        <Copyable text={readCmd} label="Copy read command" />
        <p className="mb-2 mt-3 text-sm text-text-muted">
          …or write any doc type (<code className="font-mono text-xs">kb-write.py --list</code> shows
          them):
        </p>
        <Copyable text={writeCmd} label="Copy write command" />
        <p className="mb-2 mt-3 text-sm text-text-muted">
          At the start of a session in a project's repository, read the project's brief (see
          Projects below):
        </p>
        <Copyable text={`${KBC_RUN} case-fetch.py brief`} label="Copy brief command" />
        <p className="mt-3 text-sm text-text-muted">
          Which instance, knowledge base and project the client works with all come from{' '}
          <code className="font-mono text-xs">.claude/kb.json</code> (see Auth &amp; config), so a
          hostname change is one edit there.
        </p>
      </Section>

      <Section icon={Boxes} title="Projects">
        <p className="mb-3 text-sm text-text-muted">
          A <strong className="text-text">project</strong> is a <code className="font-mono text-xs">KB_APP</code>{' '}
          term inside a knowledge base. Its documents are the ones tagged with it: cases, decisions,
          lessons, firesides, sessions, memories and mirrored documents all carry an optional{' '}
          <code className="font-mono text-xs">app</code> field. Any alias of the term works wherever a
          project is named. A project may also have one <code className="font-mono text-xs">PROJECT</code>{' '}
          profile document: its scope, repositories and a tooling archive.
        </p>
        <p className="mb-2 text-sm text-text-muted">
          <strong className="text-text">Read it in one go.</strong> The brief lists the profile, open
          cases, the newest decisions, lessons and firesides, recent sessions, memories and documents
          (handles and titles; each is one read away). Without a name it uses the repository's
          configured project. <code className="font-mono text-xs">--tooling DIR</code> also saves the
          tooling archive, as stored and never unpacked. The same brief is a page here:{' '}
          <Link to="/project/KB" className="font-mono text-xs text-primary hover:underline">
            /project/&lt;project&gt;
          </Link>
          , linked from each entry of the Project facet on Search.
        </p>
        <Copyable text={`${KBC_RUN} case-fetch.py brief [<project>] [--tooling DIR]`} label="Copy brief command" />
        <p className="mb-2 mt-3 text-sm text-text-muted">
          <strong className="text-text">Tag what you write.</strong> Put{' '}
          <code className="font-mono text-xs">"project": "&lt;project&gt;"</code> in{' '}
          <code className="font-mono text-xs">.claude/kb.json</code> and every write of a type that has an{' '}
          <code className="font-mono text-xs">app</code> field is tagged with it, unless the document
          names its own <code className="font-mono text-xs">app</code> (an explicit value always wins).
        </p>
        <p className="mb-2 text-sm text-text-muted">
          <strong className="text-text">Find a project's documents</strong> by content or by type:
        </p>
        <Copyable
          text={`${KBC_RUN} case-fetch.py search "<terms>" --project <project>
${KBC_RUN} case-fetch.py read LESSON --filter app=<project>`}
          label="Copy project search commands"
        />
        <p className="mb-2 mt-3 text-sm text-text-muted">
          <strong className="text-text">Create or update the profile.</strong> Its identity is{' '}
          <code className="font-mono text-xs">app</code>, so writing again under any alias updates the
          same profile:
        </p>
        <Copyable text={PROJECT_PROFILE} label="Copy PROJECT profile command" />
        <p className="mb-2 mt-3 text-sm text-text-muted">
          <strong className="text-text">Attach a tooling archive</strong> (.zip, .tar.gz or .tgz, up to
          100 MB) to an existing profile, or in the same command that writes it. A new archive replaces
          the old one, which stays in WIP unreferenced:
        </p>
        <Copyable
          text={`${KBC_RUN} kb-write.py PROJECT --tooling ./tooling.zip --match app=<project>
${KBC_RUN} kb-write.py PROJECT profile.md --tooling ./tooling.zip`}
          label="Copy tooling commands"
        />
        <ul className="mt-3 space-y-1.5 text-sm text-text-muted">
          <li>
            • A new project needs its <code className="font-mono text-xs">KB_APP</code> term first. An
            administrator adds it (and any other spellings) on{' '}
            <Link to="/settings" className="text-primary hover:underline">
              Settings → Vocabulary
            </Link>
            .
          </li>
          <li>
            • Attaching runs with your key, so WIP's write permission on the knowledge base decides
            who may. Without <code className="font-mono text-xs">--match</code> it uses the repository's
            configured project. A plain .tar is not accepted; gzip it first.
          </li>
        </ul>
      </Section>

      <Section icon={Layers} title="Knowledge bases">
        <p className="mb-3 text-sm text-text-muted">
          A <strong className="text-text">knowledge base</strong> is a namespace seeded with the full KB
          model. Each has its own documents, numbering (its own CASE-1), vocabularies and
          relationships, and links cannot cross from one to another. Most work happens in the default
          one; a project that needs to be walled off gets its own.
        </p>
        <Copyable text={`${KBC_RUN} kb-namespace.py create <name>`} label="Copy create command" />
        <ul className="mt-3 space-y-1.5 text-sm text-text-muted">
          <li>
            • Creating one runs with your key, and WIP decides whether that key may create namespaces.
            An existing namespace with content is never re-seeded.
          </li>
          <li>
            • To make a repository work in one, set{' '}
            <code className="font-mono text-xs">"namespace": "&lt;name&gt;"</code> in{' '}
            <code className="font-mono text-xs">.claude/kb.json</code>; every read and write then goes
            there. For a single command, <code className="font-mono text-xs">search</code>,{' '}
            <code className="font-mono text-xs">read</code>, <code className="font-mono text-xs">brief</code>{' '}
            and <code className="font-mono text-xs">topics</code> take{' '}
            <code className="font-mono text-xs">--namespace</code>.
          </li>
          <li>
            • In the app, each one has its own address, <code className="font-mono text-xs">/apps/kb/ns/&lt;name&gt;/</code>,
            and the Knowledge base switcher in the sidebar lists them.
          </li>
        </ul>
      </Section>

      <Section icon={RefreshCw} title="The bundle — self-refreshing">
        {manifestQ.isLoading && <p className="text-sm text-text-muted">Loading manifest…</p>}
        {manifestQ.error && (
          <p className="text-sm text-danger">Manifest unavailable: {(manifestQ.error as Error).message}</p>
        )}
        {m && (
          <>
            <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Stat label="client_version" value={m.client_version ?? '—'} hint="informational semver" />
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
                  {fileRows.map((name) => (
                    <tr key={name}>
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-text">{name}</td>
                      <td className="px-3 py-2 text-text-muted">{FILE_ROLES[name]?.role ?? '—'}</td>
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
                  ))}
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
          One write endpoint: <code className="font-mono text-xs">POST kb/write/:type</code>. The client
          (<code className="font-mono text-xs">kb-write.py</code>) parses + validates the source and the
          gateway persists — mint or upsert per the type's <code className="font-mono text-xs">WRITE_POLICY</code>,
          link any edge-intents, or apply a <code className="font-mono text-xs">{'{patch, match}'}</code> field
          update. The playbook below is the authoritative how-to for filing and transitioning cases.
        </p>
      </Section>

      <Section icon={Library} title="Library submissions">
        <p className="mb-3 text-sm text-text-muted">
          The <strong className="text-text">WIP Technical Library</strong> is a distinct doc-type
          (<code className="font-mono text-xs">LIBRARY_DOC</code>) in its own{' '}
          <code className="font-mono text-xs">library</code> namespace. A producer submits a doc
          through the same write client — the gateway routes{' '}
          <code className="font-mono text-xs">LIBRARY_DOC</code> to the Library namespace
          automatically (no <code className="font-mono text-xs">--namespace</code> needed):
        </p>
        <Copyable
          text={`bash ~/.cache/wip-kb-client/kb-client.sh kb-write.py LIBRARY_DOC document-store-api.md`}
          label="Copy library submit command"
        />
        <p className="mb-2 mt-3 text-sm text-text-muted">
          The library is <strong className="text-text">agnostic to who produces a doc or how</strong>{' '}
          — generation is upstream. It owns only this <strong className="text-text">receive format</strong>:
          markdown frontmatter → fields, body → <code className="font-mono text-xs">data.body</code>.
          Identity is <code className="font-mono text-xs">[slug, release]</code> (natural-upsert:
          re-submitting the same slug+release versions in place; a new{' '}
          <code className="font-mono text-xs">release</code> is a new parallel doc).
        </p>
        <div className="overflow-x-auto rounded-md border border-gray-200">
          <table className="w-full text-left text-xs">
            <thead className="bg-background text-text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Field</th>
                <th className="px-3 py-2 font-medium">Required</th>
                <th className="px-3 py-2 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {LIBRARY_FIELDS.map(([field, req, notes]) => (
                <tr key={field}>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-text">{field}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-text-muted">
                    {req === 'identity' ? (
                      <span className="rounded bg-primary/10 px-1.5 py-0.5 font-semibold text-primary">
                        identity
                      </span>
                    ) : (
                      req
                    )}
                  </td>
                  <td className="px-3 py-2 text-text-muted">{notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mb-2 mt-3 text-sm text-text-muted">Example submission file:</p>
        <Copyable text={LIBRARY_SAMPLE} label="Copy LIBRARY_DOC sample" />
        <p className="mt-3 text-sm text-text-muted">
          <code className="font-mono text-xs">kb-write.py --list</code> shows{' '}
          <code className="font-mono text-xs">LIBRARY_DOC</code> with its namespace.{' '}
          <code className="font-mono text-xs">generated_from_rev</code> /{' '}
          <code className="font-mono text-xs">source_scope</code> are provenance the library carries
          but never acts on — fix the source and regenerate, never hand-edit.
        </p>
      </Section>

      <Section icon={KeyRound} title="Auth & config">
        <ul className="space-y-1.5 text-sm text-text-muted">
          <li>
            • Every call needs <code className="font-mono text-xs">X-API-Key</code>; the key lives in a
            file that is issued when your project is installed, and is never pasted as a literal. Its
            path goes in <code className="font-mono text-xs">kb_api_key_file</code> below, and there is
            no default.
          </li>
          <li>
            • <code className="font-mono text-xs">.claude/kb.json</code> is the single source of truth;
            the runner and the python client derive everything from it.{' '}
            <code className="font-mono text-xs">kb_app_url</code> and{' '}
            <code className="font-mono text-xs">kb_api_key_file</code> are required;{' '}
            <code className="font-mono text-xs">namespace</code> (the knowledge base, default: the
            instance's) and <code className="font-mono text-xs">project</code> (tags your writes) are
            optional. Environment variables override them:{' '}
            <code className="font-mono text-xs">KB_BASE_URL</code>,{' '}
            <code className="font-mono text-xs">KB_API_KEY_FILE</code>,{' '}
            <code className="font-mono text-xs">KB_NAMESPACE</code>,{' '}
            <code className="font-mono text-xs">KB_PROJECT</code>.
            <div className="mt-2">
              <Copyable text={KB_JSON_SAMPLE} label="Copy kb.json sample" />
            </div>
          </li>
          <li>
            • Pairing guard: overriding the base URL without the matching key fails loud —
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
