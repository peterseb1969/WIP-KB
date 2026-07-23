import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { wipKeys } from '@wip/react'
import { patchCaseStatus, writeCaseResponse, type ResponseKind } from '../lib/kbGateway'

// Legal lifecycle transitions offered in the UI, gated on current status. The
// validity rule mirrors the served playbook's status machine (the caller is the
// machine; the gateway persists). close: open/responded → closed. reopen:
// closed/implemented → open. An open case has nothing to reopen; a terminal case
// nothing to close.
type Action = { verb: 'close' | 'reopen'; kind: ResponseKind; nextStatus: string; label: string }

function actionFor(status: string): Action | null {
  if (status === 'open' || status === 'responded') {
    return { verb: 'close', kind: 'close', nextStatus: 'closed', label: 'Close case' }
  }
  if (status === 'closed' || status === 'implemented') {
    // Reopen posts a `comment` (there is no distinct reopen kind) stating why the
    // case is coming back, then flips status to open — the playbook's reopen flow.
    return { verb: 'reopen', kind: 'comment', nextStatus: 'open', label: 'Reopen case' }
  }
  return null
}

/**
 * Close / reopen a case from its page — increment 2 of the KB UI write path
 * (CASE-484). A bounded lifecycle transition with a required one-line rationale
 * (a bare status flip loses the thread's account of WHY). Two gateway writes: a
 * CASE_RESPONSE carrying the reason (attributed WEB-UI), then a CASE_RECORD
 * status patch. Response-first, so the rationale is recorded even if the patch
 * then fails.
 * @param docId - the CASE_RECORD document_id (for cache invalidation).
 * @param caseNumber - the case's number (the gateway match/scope key).
 * @param status - the case's current status.
 */
export function CaseActions({
  docId,
  caseNumber,
  status,
}: {
  docId: string
  caseNumber: number
  status: string
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const action = actionFor(status)
  if (!action) return null

  async function submit() {
    const a = action!
    if (!reason.trim()) return setError('A one-line reason is required.')
    setSubmitting(true)
    setError(null)
    try {
      await writeCaseResponse(caseNumber, a.kind, reason.trim())
      try {
        await patchCaseStatus(caseNumber, a.nextStatus)
      } catch (e) {
        // The reason landed in the thread; only the status flip failed. Say so —
        // don't leave the user thinking nothing happened.
        throw new Error(`Reason recorded, but the status change failed: ${(e as Error).message}`)
      }
      qc.invalidateQueries({ queryKey: wipKeys.documents.detail(docId) })
      qc.invalidateQueries({ queryKey: ['relationships', docId] })
      qc.invalidateQueries({ queryKey: ['case-responses'] })
      setOpen(false)
      setReason('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-gray-300 bg-surface px-3 py-1 text-xs font-medium text-text hover:bg-background focus:outline-none focus:ring-2 focus:ring-primary/40"
      >
        {action.label}
      </button>
    )
  }

  return (
    <div className="flex w-full flex-col gap-2 rounded-md border border-gray-300 bg-surface px-3 py-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-medium text-text">{action.label}</span>
        <span className="text-text-muted">
          {status} → {action.nextStatus}
        </span>
      </div>
      <input
        autoFocus
        type="text"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
          if (e.key === 'Escape') setOpen(false)
        }}
        placeholder={
          action.verb === 'close' ? 'Why is this being closed?' : 'Why is this coming back?'
        }
        className="w-full rounded border border-gray-300 bg-surface px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
      />
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={submitting || !reason.trim()}
          className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-white hover:bg-primary-light focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? 'Working…' : action.label}
        </button>
        <button
          type="button"
          onClick={() => { setOpen(false); setError(null) }}
          className="rounded-md px-2 py-1 text-xs text-text-muted hover:bg-background focus:outline-none focus:ring-2 focus:ring-primary/40"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
