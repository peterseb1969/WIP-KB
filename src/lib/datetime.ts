// Timestamp parsing for values coming out of WIP.
//
// The platform hands us the same instant in two shapes: the document API emits
// a NAIVE timestamp ("2026-07-24T21:49:03.986000" — no offset) while the
// reporting layer emits an offset-bearing one ("2026-07-24T21:49:03.986749+00:00").
// JavaScript parses a date-time without an offset as LOCAL and one with an
// offset as UTC, so the same document rendered from the two sources disagreed by
// the viewer's UTC offset — the doc page showed 9:49 PM for what the search list
// showed as 11:49 PM (CEST, +02:00). Everything the platform stores is UTC, so a
// missing offset means UTC, never local.
//
// Route every timestamp render/compare through here rather than calling
// `new Date(...)` on an API string directly; the bug is invisible in UTC+00:00
// and silent everywhere else.

// Trailing "Z", "+HH:MM"/"-HH:MM", or "+HHMM"/"-HHMM" — i.e. the value already
// carries an offset and JS will read it correctly.
const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i

/** Parse a WIP timestamp, treating a missing offset as UTC. Null when unparseable. */
export function parseWipDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const d = new Date(HAS_OFFSET.test(value) ? value : `${value}Z`)
  return isNaN(d.getTime()) ? null : d
}

/** Locale date+time for display, or '' when the value is missing/unparseable. */
export function formatWipDateTime(value: string | null | undefined): string {
  return parseWipDate(value)?.toLocaleString() ?? ''
}

/** Locale date (no time) for display, or '' when missing/unparseable. */
export function formatWipDate(value: string | null | undefined): string {
  return parseWipDate(value)?.toLocaleDateString() ?? ''
}
