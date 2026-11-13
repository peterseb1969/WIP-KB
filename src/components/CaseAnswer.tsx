import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { wipKeys } from '@wip/react'
import { writeCaseResponse } from '../lib/kbGateway'
import { createFlagWithEdge } from './FlagModal'
import { CORPUS_NS } from '../lib/namespaces'

/**
 * Answer a case from its page: the owner's reply to a response's questions, or
 * any other remark. Writes a `comment` response attributed to the signed-in user
 * (the server stamps the author; see server/ui-author.ts), so the case stops
 * waiting for an answer.
 *
 * "Send back" (on by default) then raises the case's respond flag for its target,
 * so the answer goes back into the work queue: a flag's identity is its kind plus
 * the case, so this re-arms the existing respond flag rather than adding one. The
 * answer is written first; a failed flag never loses it. Choosing the kind of
 * work and the worker is CASE-1291's.
 */
export function CaseAnswer({
  docId,
  caseNumber,
  caseTitle,
  targetYac,
  waiting,
}: {
  docId: string
  caseNumber: number
  caseTitle: string
  targetYac: string | null
  /** Questions to the owner wait for an answer: open the box straight away. */
  waiting: boolean
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(waiting)
  const [text, setText] = useState('')
  const [sendBack, setSendBack] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const target = targetYac || 'any'

  async function submit() {
    if (!text.trim()) return setError('Write the answer first.')
    setBusy(true)
    setError(null)
    try {
      const r = await writeCaseResponse(caseNumber, 'comment', text.trim())
      let msg = `Posted as ${r.synonym ?? `CASE-${caseNumber}#${r.number ?? '?'}`}.`
      if (sendBack) {
        try {
          const head = caseTitle.slice(0, 60)
          await createFlagWithEdge({
            namespace: CORPUS_NS,
            sourceDocId: docId,
            flagType: 'respond',
            targetYac: target,
            title: `Flag → ${target}: answered — ${head}${caseTitle.length > 60 ? '…' : ''}`,
            body: `The owner answered in ${r.synonym ?? `CASE-${caseNumber}`}; continue from the thread.`,
          })
          msg += ` Sent back to ${target}.`
        } catch (e) {
          msg += ` Sending it back failed (${(e as Error).message}); flag the case by hand.`
        }
      }
      qc.invalidateQueries({ queryKey: wipKeys.documents.detail(docId) })
      qc.invalidateQueries({ queryKey: ['relationships', docId] })
      qc.invalidateQueries({ queryKey: ['case-responses'] })
      qc.invalidateQueries({ queryKey: ['case-threads'] })
      qc.invalidateQueries({ queryKey: ['awaiting-owner'] })
      qc.invalidateQueries({ queryKey: ['outstanding-respond-flags'] })
      setText('')
      setOpen(false)
      setDone(msg)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => { setOpen(true); setDone(null) }}
          className="rounded-md border border-gray-300 bg-surface px-3 py-1 text-xs font-medium text-text hover:bg-background focus:outline-none focus:ring-2 focus:ring-primary/40"
        >
          Answer
        </button>
        {done && <span className="text-xs text-success">{done}</span>}
      </div>
    )
  }

  return (
    <div className="mt-4 flex flex-col gap-2 rounded-md border border-primary/30 bg-surface px-3 py-2">
      <span className="text-xs font-medium text-text">
        {waiting ? 'Answer the questions' : 'Answer'}
        <span className="font-normal text-text-muted"> — posted as a comment under your name; markdown works</span>
      </span>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        placeholder={waiting ? '1. …\n2. …' : 'Your answer'}
        className="w-full rounded border border-gray-300 bg-surface px-2 py-1 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
      />
      <label className="flex items-center gap-2 text-xs text-text">
        <input type="checkbox" checked={sendBack} onChange={(e) => setSendBack(e.target.checked)} />
        Send back to {target} (raises the case's respond flag)
      </label>
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={busy || !text.trim()}
          className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-white hover:bg-primary-light focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Posting…' : sendBack ? 'Post and send back' : 'Post answer'}
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
