import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { withdrawFlag } from '../lib/kbGateway'

/** A flag's lifecycle as the Flags line shows it, from its doc_status. */
export type FlagState = 'pending' | 'dispatched' | 'withdrawn'
export function flagState(docStatus: string | undefined): FlagState {
  if (docStatus === 'dispatched') return 'dispatched'
  // archived is what the UI's withdraw writes; deprecated is the other retired value.
  if (docStatus === 'archived' || docStatus === 'deprecated') return 'withdrawn'
  return 'pending'
}

/**
 * One flag on a doc page's Flags line: kind → owner · state, linking to the flag
 * record. A pending or dispatched flag can be withdrawn here, in two clicks
 * ("withdraw", then "yes"). A withdrawn flag is never dispatched and no longer
 * counts as asked for; flagging the doc again re-arms it.
 *
 * @param docId - the flagged doc, whose relationships are re-read after a withdraw.
 * @param canWithdraw - false where the UI writes nothing (a doc outside the corpus).
 */
export function FlagChip({
  docId,
  flagId,
  flagType,
  title,
  targetYac,
  docStatus,
  canWithdraw,
}: {
  docId: string
  flagId: string
  flagType?: string
  title?: string
  targetYac?: string
  docStatus?: string
  canWithdraw: boolean
}) {
  const qc = useQueryClient()
  const [stage, setStage] = useState<'idle' | 'confirm' | 'busy' | 'done'>('idle')
  const [error, setError] = useState<string | null>(null)
  const state: FlagState = stage === 'done' ? 'withdrawn' : flagState(docStatus)

  async function withdraw() {
    setStage('busy')
    setError(null)
    try {
      await withdrawFlag(flagId)
      setStage('done')
      qc.invalidateQueries({ queryKey: ['relationships', docId] })
      qc.invalidateQueries({ queryKey: ['outstanding-respond-flags'] })
      qc.invalidateQueries({ queryKey: ['outstanding-implement-flags'] })
    } catch (e) {
      setError((e as Error).message)
      setStage('idle')
    }
  }

  const look = state === 'pending'
    ? 'border-accent/30 bg-accent/10 font-medium text-accent hover:bg-accent/20'
    : 'border-gray-200 bg-gray-50 text-text-muted opacity-70 hover:opacity-100'
  const small = 'rounded px-1 text-[11px] focus:outline-none focus:ring-2 focus:ring-accent/40'

  return (
    <span className="inline-flex items-center gap-1">
      <Link
        to={`/doc/${flagId}`}
        title={title || flagId}
        className={`rounded-full border px-2.5 py-0.5 ${look} ${state === 'withdrawn' ? 'line-through' : ''}`}
      >
        {flagType || 'flag'}
        {targetYac ? ` → ${targetYac}` : ''}
        <span className={state === 'pending' ? '' : 'font-normal'}> · {state}</span>
      </Link>
      {canWithdraw && state !== 'withdrawn' && stage === 'idle' && (
        <button
          type="button"
          onClick={() => setStage('confirm')}
          title="Withdraw this flag: it will not be dispatched, and no longer counts as asked for"
          className={`${small} text-text-muted hover:bg-background hover:text-danger`}
        >
          withdraw
        </button>
      )}
      {stage === 'confirm' && (
        <span className="inline-flex items-center gap-1 text-[11px] text-text">
          Withdraw?
          <button type="button" onClick={withdraw} className={`${small} font-medium text-danger hover:bg-danger/10`}>
            Yes
          </button>
          <button type="button" onClick={() => setStage('idle')} className={`${small} text-text-muted hover:bg-background`}>
            No
          </button>
        </span>
      )}
      {stage === 'busy' && <span className="text-[11px] text-text-muted">Withdrawing…</span>}
      {error && <span className="text-[11px] text-danger">Withdraw failed: {error}</span>}
    </span>
  )
}
