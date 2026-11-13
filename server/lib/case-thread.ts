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
  /** How many questions the response puts to the owner (its `## Questions` section). */
  questions?: number | null
  /** Who wrote it: a session id for an agent; an email, or WEB-UI, for a person. */
  author?: string | null
  /** The project owner's answer, written down by whoever typed it (a session). */
  owner_answer?: boolean | null
}

/** A response written by a person (signed in, or the UI on an install without login). */
export function byPerson(author: string | null | undefined): boolean {
  const a = String(author || '')
  return a === 'WEB-UI' || a.includes('@')
}

/**
 * A response's question count as SQL over the CASE_RESPONSE reporting view. Read
 * from the stored data rather than the view's column, so a namespace whose template
 * has no `questions` field yet answers "none" instead of failing the query.
 */
export function sqlQuestions(p = ''): string {
  return `NULLIF(${p}data_json->>'questions', '')::int`
}

/** `byPerson` as SQL. */
export function sqlByPerson(p = ''): string {
  return `(${p}author = 'WEB-UI' OR ${p}author LIKE '%@%')`
}

/**
 * Whether a response settles the owner's questions asked before it: a person wrote
 * it; or it records the owner's answer (a session wrote down what the owner said in
 * a chat or typed in a terminal); or it implements or closes the case, which shows
 * the decisions were taken. An agent's plain comment or respond does not.
 */
export function answersOwner(e: Pick<ThreadEntry, 'author' | 'owner_answer' | 'response_kind'>): boolean {
  return byPerson(e.author) || e.owner_answer === true
    || e.response_kind === 'implement' || e.response_kind === 'close'
}

/** `answersOwner` as SQL. owner_answer is read from the stored data, as `sqlQuestions` is. */
export function sqlAnswersOwner(p = ''): string {
  return `(${sqlByPerson(p)} OR ${p}data_json->>'owner_answer' = 'true'`
    + ` OR ${p}response_kind IN ('implement', 'close'))`
}

/** A response's owner_answer mark as SQL, for selects that feed `summariseThread`. */
export function sqlOwnerAnswer(p = ''): string {
  return `(${p}data_json->>'owner_answer' = 'true')`
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
  /**
   * Questions put to the owner that nobody has settled: the latest response with
   * questions has no later response that answers the owner (`answersOwner`), and
   * the case is not implemented or closed. Agents' plain comments do not count.
   */
  awaitingOwner: boolean
  /** How many questions that response asks (0 when nothing is waiting). */
  openQuestions: number
}

const TERMINAL = new Set(['implemented', 'closed'])

export function summariseThread(status: string | null | undefined, entries: ThreadEntry[]): ThreadSummary {
  const s: ThreadSummary = {
    respond: 0, implement: 0, comment: 0, close: 0,
    reopened: false, reanswered: false, unanswered: false, needsHistory: false,
    awaitingOwner: false, openQuestions: 0,
  }
  let finishedSeq = -Infinity
  let respondSeq = -Infinity
  let askedSeq = -Infinity
  let asked = 0
  let answeredSeq = -Infinity
  for (const e of entries) {
    if ((e.questions ?? 0) > 0 && e.response_seq > askedSeq) { askedSeq = e.response_seq; asked = e.questions! }
    if (answersOwner(e)) answeredSeq = Math.max(answeredSeq, e.response_seq)
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
  s.awaitingOwner = !terminal && askedSeq > -Infinity && answeredSeq < askedSeq
  s.openQuestions = s.awaitingOwner ? asked : 0
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

/** The questions marker, e.g. "2 questions", or '' when none wait for the owner. */
export function questionsMarker(s: ThreadSummary): string {
  if (!s.awaitingOwner) return ''
  return `${s.openQuestions} question${s.openQuestions === 1 ? '' : 's'}`
}

/** The marker a list shows, or '' for none. */
export function threadMarker(s: ThreadSummary): string {
  if (s.reopened) return s.reanswered ? 'reopened · re-answered' : 'reopened'
  if (s.unanswered) return 'unanswered'
  return ''
}
