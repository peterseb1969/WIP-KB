import { useEffect, useState } from 'react'
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
 * "Then" says what the answer sends into the work queue, as a flag for the case's
 * owner. Implement, the default: an answer usually settles the questions, and a
 * second response would only restate the first with the decisions plugged in.
 * Respond again: for an answer that opens new ground (say, the bigger option, with
 * new sites to analyse). Nothing: the answer only. A flag's identity is its kind
 * plus the case, so each choice re-arms that kind's flag rather than adding one.
 * The answer is written first; a failed flag never loses it.
 */
type Then = 'implement' | 'respond' | 'nothing'
const THEN_LABEL: Record<Then, string> = {
  implement: 'Implement',
  respond: 'Respond again',
  nothing: 'Nothing',
}
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
  // Questions that start waiting while the page is open open the box. The box is
  // not remounted when waiting ends (an answer just posted ends it), so the
  // confirmation of what was posted and flagged stays on screen.
  useEffect(() => { if (waiting) setOpen(true) }, [waiting])
  const [text, setText] = useState('')
  const [then, setThen] = useState<Then>('implement')
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
      if (then !== 'nothing') {
        try {
          const head = caseTitle.slice(0, 60)
          const where = r.synonym ?? `CASE-${caseNumber}`
          await createFlagWithEdge({
            namespace: CORPUS_NS,
            sourceDocId: docId,
            flagType: then,
            targetYac: target,
            title: `Flag → ${target}: ${then} — ${head}${caseTitle.length > 60 ? '…' : ''}`,
            body: then === 'implement'
              ? `The owner answered in ${where}; implement from the thread.`
              : `The owner answered in ${where}; respond again from the thread.`,
          })
          msg += ` Flagged ${then} for ${target}.`
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
      qc.invalidateQueries({ queryKey: ['outstanding-implement-flags'] })
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
      <fieldset className="flex flex-wrap items-center gap-3 text-xs text-text">
        <legend className="sr-only">Then</legend>
        <span>Then, for {target}:</span>
        {(Object.keys(THEN_LABEL) as Then[]).map((t) => (
          <label key={t} className="flex items-center gap-1">
            <input type="radio" name={`then-${caseNumber}`} value={t} checked={then === t} onChange={() => setThen(t)} />
            {THEN_LABEL[t]}
          </label>
        ))}
      </fieldset>
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={busy || !text.trim()}
          className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-white hover:bg-primary-light focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Posting…' : then === 'nothing' ? 'Post answer' : `Post and flag ${then}`}
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
