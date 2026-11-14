import type { CaseClaimView } from '../lib/reporting'

/**
 * Who is working on a case: one chip per claim that holds it ("respond ·
 * BE-YAC-2026…", "implement · parked"). Read-only: claims are taken and released
 * by agents through kbc, never from the UI.
 */
export function ClaimChips({ claims }: { claims: CaseClaimView[] | undefined }) {
  if (!claims?.length) return null
  return (
    <>
      {claims.map((c) => (
        <span
          key={`${c.kind}/${c.holder}`}
          title={c.state === 'parked'
            ? `Claimed for ${c.kind} by ${c.holder}; parked (waiting on a decision)`
            : `Claimed for ${c.kind} by ${c.holder}${c.leaseUntil ? `; lease until ${c.leaseUntil.slice(0, 16).replace('T', ' ')}` : ''}`}
          className="rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent"
        >
          {c.kind} · {c.state === 'parked' ? 'parked' : c.holder}
        </span>
      ))}
    </>
  )
}

/** The reason a one-click flag of a kind is not offered while a claim of that kind holds the case. */
export function flagClaimReason(claims: CaseClaimView[] | undefined, kind: 'respond' | 'implement'): string | undefined {
  const c = claims?.find((x) => x.kind === kind)
  if (!c) return undefined
  return kind === 'respond'
    ? `${c.holder} is working on a response (claimed for respond)`
    : `${c.holder} is implementing it (claimed for implement)`
}
