// What a case's response thread says about it, for case lists: how many responses
// of each kind, whether the case was finished once and reopened, and whether it
// still waits for its first answer.
//
// Shared by the gateway (`GET /cases`, kbc list) and the UI's case list, so both
// apply one rule. Pure: no I/O, importable from the browser bundle.
//
// The thread is used rather than the record's status history because reporting
// keeps only a case's latest version, so history in bulk would cost one call per
// case. A reopen leaves the thread's implement or close response in place, which
// is the evidence. Cases from before threaded responses existed have no such
// response even when they were finished, so an open one with no answer could be
// a reopen the thread cannot show: `needsHistory` marks exactly those rows, and
// the caller checks their earlier versions (applyHistory).

export interface ThreadEntry {
  response_kind: string
  response_seq: number
}

export interface ThreadSummary {
  respond: number
  implement: number
  comment: number
  close: number
  /** Not implemented or closed now, but it was once. */
  reopened: boolean
  /** Reopened, and a respond came after the latest implement or close. */
  reanswered: boolean
  /** Open, never answered (no respond), and not a reopen. */
  unanswered: boolean
  /** The thread cannot rule out a reopen: check the case's earlier statuses. */
  needsHistory: boolean
}

const TERMINAL = new Set(['implemented', 'closed'])

export function summariseThread(status: string | null | undefined, entries: ThreadEntry[]): ThreadSummary {
  const s: ThreadSummary = {
    respond: 0, implement: 0, comment: 0, close: 0,
    reopened: false, reanswered: false, unanswered: false, needsHistory: false,
  }
  let finishedSeq = -Infinity
  let respondSeq = -Infinity
  for (const e of entries) {
    const k = e.response_kind
    if (k === 'respond' || k === 'implement' || k === 'comment' || k === 'close') s[k]++
    if (k === 'implement' || k === 'close') finishedSeq = Math.max(finishedSeq, e.response_seq)
    if (k === 'respond') respondSeq = Math.max(respondSeq, e.response_seq)
  }
  const terminal = TERMINAL.has(String(status || ''))
  s.reopened = !terminal && finishedSeq > -Infinity
  s.reanswered = s.reopened && respondSeq > finishedSeq
  s.unanswered = status === 'open' && s.respond === 0 && !s.reopened
  s.needsHistory = s.unanswered
  return s
}

/** Fold in what the case's earlier versions say: once implemented or closed, it is a reopen. */
export function applyHistory(s: ThreadSummary, earlierStatuses: Array<string | null | undefined>): ThreadSummary {
  if (!s.needsHistory) return s
  const was = earlierStatuses.some((st) => TERMINAL.has(String(st || '')))
  return { ...s, needsHistory: false, reopened: s.reopened || was, unanswered: s.unanswered && !was }
}

/** Compact counts, e.g. "R1 I1 C3"; empty for no responses. */
export function threadCounts(s: ThreadSummary): string {
  return [['R', s.respond], ['I', s.implement], ['C', s.comment], ['X', s.close]]
    .filter(([, n]) => (n as number) > 0).map(([k, n]) => `${k}${n}`).join(' ')
}

/** The marker a list shows, or '' for none. */
export function threadMarker(s: ThreadSummary): string {
  if (s.reopened) return s.reanswered ? 'reopened · re-answered' : 'reopened'
  if (s.unanswered) return 'unanswered'
  return ''
}
