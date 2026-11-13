import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { wipFetchJson, assertBulkSuccess } from '../lib/wipBulk'
import { FLAG_INTENTS, DEFAULT_FLAG_INTENT, type FlagIntent } from '../lib/promptTemplates'
import { CORPUS_NS } from '../lib/namespaces'
import { listWorkers, type OutstandingFlag, type Worker } from '../lib/reporting'
import { WEB_UI_AUTHOR } from '../lib/kbGateway'

interface Props {
  sourceDocId: string
  sourceDocTitle: string
  onClose: () => void
}

interface Term {
  term_id: string
  value: string
  label?: string
}
interface TermListResponse {
  items: Term[]
}
interface TemplateInfo {
  template_id: string
  version: number
}
interface BulkItemResult {
  index?: number
  status?: string
  id?: string
}
interface BulkResponse {
  results: BulkItemResult[]
}

const TARGET_YAC_TERMINOLOGY = 'KB_TARGET_YAC'

// The one write pair the UI performs: FLAG_RECORD + FLAGGED_FROM edge.
// v3 identity is [flag_type, flagged_document]: re-flagging the same intent
// on the same doc upserts (re-arms the dispatch queue), never duplicates.
// doc_status must be sent explicitly — the platform does not apply the
// template's default_value on create; 'published' means pending dispatch.
export async function createFlagWithEdge(opts: {
  namespace: string
  sourceDocId: string
  flagType: FlagIntent['id']
  targetYac: string
  title: string
  body: string
  /** An AGENT_IDENTITY's agent_value; omitted, the dispatcher picks the worker. */
  worker?: string
}): Promise<string> {
  const { namespace, sourceDocId, flagType, targetYac, title, body, worker } = opts
  const flagTmpl = await wipFetchJson<TemplateInfo>(
    `/api/template-store/templates/by-value/FLAG_RECORD?namespace=${namespace}`,
  )
  const edgeTmpl = await wipFetchJson<TemplateInfo>(
    `/api/template-store/templates/by-value/FLAGGED_FROM?namespace=${namespace}`,
  )
  const flagRes = await wipFetchJson<BulkResponse>('/api/document-store/documents', {
    method: 'POST',
    body: JSON.stringify([
      {
        template_id: flagTmpl.template_id,
        template_version: flagTmpl.version,
        namespace,
        data: {
          flag_type: flagType,
          flagged_document: sourceDocId,
          title,
          body,
          // Replaced server-side with the signed-in user (server/ui-author.ts).
          authored_by: WEB_UI_AUTHOR,
          doc_status: 'published',
          target_yac: targetYac,
          // kind is set server-side from flag_type (server/lib/flag-kind.ts).
          ...(worker ? { worker } : {}),
        },
      },
    ]),
  })
  const [flagItem] = assertBulkSuccess(flagRes, 'FLAG_RECORD')
  const flagId = flagItem?.id
  if (!flagId) throw new Error('FLAG_RECORD created but no id returned')

  const edgeRes = await wipFetchJson<BulkResponse>('/api/document-store/documents', {
    method: 'POST',
    body: JSON.stringify([
      {
        template_id: edgeTmpl.template_id,
        template_version: edgeTmpl.version,
        namespace,
        data: {
          source_ref: flagId,
          target_ref: sourceDocId,
        },
      },
    ]),
  })
  assertBulkSuccess(edgeRes, 'FLAGGED_FROM')
  return flagId
}

/**
 * One-click flag for the common case: respond → BE-YAC, no note. Deliberately
 * minimal while dispatch experience accrues — more targets/intents (and a
 * pass-through instruction) come later; the dialog stays for anything custom.
 * Idempotent by flag identity: clicking again re-arms the same flag, and a
 * re-armed flag is dispatched again — so every click can produce a response.
 *
 * Disabled (greyed out) when clicking would ask for a response already asked for:
 * - the doc has an outstanding respond flag: pending dispatch, or dispatched with
 *   no response since (fetchOutstandingRespondFlags);
 * - this button has just written one (reporting may not show it yet);
 * - the caller passes inactiveReason: the case list does for every case that is
 *   not open, so clicking down a list only ever queues unanswered cases. Asking
 *   for another response on an answered case is a deliberate act, made on the
 *   doc page, which passes no reason.
 *
 * @param sourceDocId/sourceDocTitle - the doc being flagged.
 * @param outstanding - the doc's outstanding respond flag, if any (undefined: not known yet).
 * @param inactiveReason - why the caller does not offer a flag here (tooltip), if it does not.
 * @param compact - the smaller form used on list rows.
 */
export function QuickFlagButton({
  sourceDocId,
  sourceDocTitle,
  outstanding,
  inactiveReason,
  compact = false,
}: {
  sourceDocId: string
  sourceDocTitle: string
  outstanding?: OutstandingFlag | null
  inactiveReason?: string
  compact?: boolean
}) {
  const NAMESPACE = CORPUS_NS
  const qc = useQueryClient()
  const [state, setState] = useState<'idle' | 'busy' | 'flagged' | 'error'>('idle')

  const handleClick = async () => {
    setState('busy')
    try {
      const head = sourceDocTitle.slice(0, 60)
      await createFlagWithEdge({
        namespace: NAMESPACE,
        sourceDocId,
        flagType: 'respond',
        targetYac: 'BE-YAC',
        title: `Flag → BE-YAC: ${head}${sourceDocTitle.length > 60 ? '…' : ''}`,
        body: 'One-click respond flag.',
      })
      qc.invalidateQueries({ queryKey: ['relationships', sourceDocId] })
      // Every outstanding-flag lookup (doc page, case list) re-reads.
      qc.invalidateQueries({ queryKey: ['outstanding-respond-flags'] })
      // Stays 'flagged' (disabled) from here on: the flag is outstanding now, even
      // before reporting has synced it, and a second click would dispatch it twice.
      setState('flagged')
    } catch {
      setState('error')
      setTimeout(() => setState('idle'), 4000)
    }
  }

  const known = state === 'flagged' ? 'pending' : outstanding ?? null
  const blocked = state === 'busy' ? null
    : known === 'pending' ? 'Flagged for a response from BE-YAC; waiting to be picked up'
    : known === 'dispatched' ? 'Flagged and picked up; waiting for the response. You can flag again once it has arrived.'
    : inactiveReason ?? null
  const size = compact ? 'px-2 py-0.5 text-[11px]' : 'px-3 py-1 text-xs'
  const look = blocked
    ? 'cursor-default border-gray-200 bg-gray-100 text-text-muted'
    : 'border-accent/20 bg-accent/5 text-accent hover:bg-accent/10 disabled:cursor-wait disabled:opacity-60'
  const label = state === 'busy' ? 'Flagging…'
    : state === 'error' ? 'Flag failed — retry'
    : known ? (compact ? 'Flagged' : 'Flagged: awaiting response')
    : (compact ? 'Flag' : 'Flag: respond → BE-YAC')

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={state === 'busy' || blocked !== null}
      title={blocked ?? 'Flag for a response from BE-YAC'}
      className={`shrink-0 rounded-md border font-medium focus:outline-none focus:ring-2 focus:ring-accent/40 ${size} ${look}`}
    >
      {label}
    </button>
  )
}

/**
 * A case's pending implement flag, beside its flag button: written and waiting to
 * be picked up, or picked up and waiting for the implement (or close) response.
 * Nothing when there is none. The one-click button stays respond-only.
 */
export function ImplementFlagChip({ state, compact = false }: { state: OutstandingFlag | null | undefined; compact?: boolean }) {
  if (!state) return null
  const title = state === 'pending'
    ? 'Flagged for implementation; waiting to be picked up'
    : 'Flagged for implementation and picked up; waiting for the implement response'
  return (
    <span
      title={title}
      className={`shrink-0 rounded-md border border-gray-200 bg-gray-100 font-medium text-text-muted ${compact ? 'px-2 py-0.5 text-[11px]' : 'px-3 py-1 text-xs'}`}
    >
      {compact ? 'Implement' : 'Flagged: implement'}
    </span>
  )
}

/**
 * The flag-for-YAC modal — the one write the UI performs. Creates a FLAG_RECORD
 * with a FLAGGED_FROM edge to the source doc.
 * @param sourceDocId/sourceDocTitle - the doc being flagged. @param onClose - dismiss callback.
 */
export function FlagModal({ sourceDocId, sourceDocTitle, onClose }: Props) {
  // FLAG_RECORD lives in the KB-corpus namespace. Read CORPUS_NS here (at render),
  // not as a module-level const — it's a runtime-loaded value now (CASE-551), so a
  // top-level capture would freeze the pre-fetch default. Flagging a Library doc
  // across namespaces is a separate concern (cross-namespace FLAGGED_FROM edges
  // unsupported — CASE-538); handled when unified flagging lands.
  const NAMESPACE = CORPUS_NS
  const qc = useQueryClient()
  const [targetYac, setTargetYac] = useState('')
  const [flagType, setFlagType] = useState<FlagIntent['id']>(DEFAULT_FLAG_INTENT.id)
  const [worker, setWorker] = useState('')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<{
    flagId: string
    flagTitle: string
    intent: FlagIntent
  } | null>(null)

  const { data: yacs, isLoading: yacsLoading } = useQuery<Term[]>({
    queryKey: ['target-yacs'],
    queryFn: async () => {
      const t = await wipFetchJson<{ terminology_id: string }>(
        `/api/def-store/terminologies/by-value/${TARGET_YAC_TERMINOLOGY}?namespace=${NAMESPACE}`,
      )
      const list = await wipFetchJson<TermListResponse>(
        `/api/def-store/terminologies/${t.terminology_id}/terms?namespace=${NAMESPACE}&page_size=100`,
      )
      return list.items
    },
    staleTime: 5 * 60_000,
  })

  // Workers that do this kind of work for this owner. None listed, no choice shown:
  // the dispatcher picks one.
  const { data: workers } = useQuery<Worker[]>({
    queryKey: ['workers', NAMESPACE, flagType, targetYac],
    queryFn: () => listWorkers(NAMESPACE, flagType, targetYac),
    enabled: !!targetYac,
    staleTime: 5 * 60_000,
  })
  const chosenWorker = workers?.some((w) => w.name === worker) ? worker : ''

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!targetYac) return setError('Pick a target YAC.')
    if (!reason.trim()) return setError('Reason cannot be empty.')

    setSubmitting(true)
    setError(null)
    try {
      const reasonHead = reason.trim().slice(0, 60)
      const flagTitle = `Flag → ${targetYac}: ${reasonHead}${reason.trim().length > 60 ? '…' : ''}`
      const flagId = await createFlagWithEdge({
        namespace: NAMESPACE,
        sourceDocId,
        flagType,
        targetYac,
        title: flagTitle,
        body: reason.trim(),
        worker: chosenWorker || undefined,
      })

      qc.invalidateQueries({ queryKey: ['relationships', sourceDocId] })
      const intent = FLAG_INTENTS.find((i) => i.id === flagType) ?? DEFAULT_FLAG_INTENT
      setCreated({ flagId, flagTitle, intent })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  const handleCopyPrompt = async () => {
    if (!created) return
    const prompt = created.intent.generate(created.flagId, created.flagTitle)
    try {
      await navigator.clipboard.writeText(prompt)
    } catch {
      window.prompt('Copy this prompt:', prompt)
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg bg-surface p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {!created ? (
          <form onSubmit={handleSubmit}>
            <h2 className="mb-1 text-lg font-semibold text-text">Flag for YAC</h2>
            <p className="mb-4 text-sm text-text-muted">
              Source: <span className="font-mono">{sourceDocTitle}</span>
            </p>

            <label className="mb-3 block">
              <span className="mb-1 block text-sm font-medium text-text">Target YAC</span>
              <select
                value={targetYac}
                onChange={(e) => setTargetYac(e.target.value)}
                disabled={yacsLoading}
                className="w-full rounded-md border border-gray-300 bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              >
                <option value="">{yacsLoading ? 'Loading…' : 'Pick a YAC…'}</option>
                {yacs?.map((y) => (
                  <option key={y.term_id} value={y.value}>
                    {y.label || y.value}
                  </option>
                ))}
              </select>
            </label>

            <label className="mb-3 block">
              <span className="mb-1 block text-sm font-medium text-text">Intent</span>
              <select
                value={flagType}
                onChange={(e) => setFlagType(e.target.value as FlagIntent['id'])}
                className="w-full rounded-md border border-gray-300 bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              >
                {FLAG_INTENTS.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.label}
                  </option>
                ))}
              </select>
            </label>

            {workers && workers.length > 0 && (
              <label className="mb-3 block">
                <span className="mb-1 block text-sm font-medium text-text">Worker</span>
                <select
                  value={chosenWorker}
                  onChange={(e) => setWorker(e.target.value)}
                  className="w-full rounded-md border border-gray-300 bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                >
                  <option value="">Let the dispatcher choose</option>
                  {workers.map((w) => (
                    <option key={w.name} value={w.name}>
                      {w.title}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <label className="mb-3 block">
              <span className="mb-1 block text-sm font-medium text-text">
                Reason / question
              </span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={5}
                placeholder="Why does this need a YAC's attention? Markdown allowed."
                className="w-full rounded-md border border-gray-300 bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </label>

            {error && <p className="mb-3 text-sm text-danger">{error}</p>}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md px-4 py-2 text-sm text-text-muted hover:bg-background focus:outline-none focus:ring-2 focus:ring-primary/40"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? 'Creating…' : 'Create flag'}
              </button>
            </div>
          </form>
        ) : (
          <div>
            <h2 className="mb-1 text-lg font-semibold text-text">Flag created</h2>
            <p className="mb-3 text-sm text-text-muted">
              FLAG_RECORD <span className="font-mono text-xs">{created.flagId}</span> with a
              FLAGGED_FROM edge to the source doc. Prompt to dispatch:
            </p>
            <pre className="mb-3 overflow-x-auto rounded bg-background p-3 text-xs text-text">
              {created.intent.generate(created.flagId, created.flagTitle)}
            </pre>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={handleCopyPrompt}
                className="rounded-md border border-primary px-4 py-2 text-sm font-medium text-primary hover:bg-primary/5 focus:outline-none focus:ring-2 focus:ring-primary/40"
              >
                Copy prompt
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light focus:outline-none focus:ring-2 focus:ring-primary/40"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
