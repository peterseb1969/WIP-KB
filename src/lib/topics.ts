import { wipClient } from './wipClient'

// The KB_TOPIC taxonomy as a render-ready tree (CASE-760 Phase 2). Terms come
// from def-store, structure from ontology term-relations. Both relation types
// participate: part_of is area containment, is_a is kind-of — for navigation
// they are one child→parent edge set, and the facet must not care which type
// links a node (a part_of descendants traversal alone would miss the is_a
// leaves, e.g. the restore kinds).
export interface TopicNode {
  value: string
  label: string
  children: TopicNode[]
}

export interface TopicTree {
  roots: TopicNode[]
  // topic value → itself plus every descendant value. Selecting a topic in
  // the facet filters by this whole set, so "backup-restore" matches a doc
  // tagged only "fresh-restore" — the roll-up the hierarchy exists for.
  expansion: Map<string, Set<string>>
}

export async function fetchTopicTree(namespace: string): Promise<TopicTree | null> {
  try {
    const [termsResp, relResp] = await Promise.all([
      wipClient.defStore.listTerms('KB_TOPIC', { namespace, page_size: 100 }),
      wipClient.defStore.listAllTermRelations({ namespace, page_size: 500 }),
    ])
    const terms = (termsResp.items ?? []).filter((t) => t.status === 'active')
    if (terms.length === 0) return null
    const byId = new Map(terms.map((t) => [t.term_id, t]))

    // child value → parent value, restricted to KB_TOPIC terms on both ends
    // (the relations listing is namespace-wide, not per-terminology).
    const childrenOf = new Map<string, string[]>()
    const hasParent = new Set<string>()
    for (const r of relResp.items ?? []) {
      if (r.status !== 'active') continue
      const child = byId.get(r.source_term_id)
      const parent = byId.get(r.target_term_id)
      if (!child || !parent) continue
      hasParent.add(child.value)
      const arr = childrenOf.get(parent.value) ?? []
      arr.push(child.value)
      childrenOf.set(parent.value, arr)
    }

    const byValue = new Map(terms.map((t) => [t.value, t]))
    const sortVals = (vals: string[]) =>
      [...new Set(vals)].sort((a, b) => {
        const ta = byValue.get(a)!, tb = byValue.get(b)!
        return ta.sort_order - tb.sort_order || a.localeCompare(b)
      })

    const build = (value: string, seen: Set<string>): TopicNode => ({
      value,
      label: byValue.get(value)?.label || value,
      // `seen` guards against a relation cycle hanging the render — a cycle is
      // bad data, not a crash-worthy event.
      children: seen.has(value)
        ? []
        : sortVals(childrenOf.get(value) ?? []).map((c) => build(c, new Set(seen).add(value))),
    })
    const roots = sortVals(terms.map((t) => t.value).filter((v) => !hasParent.has(v))).map((v) =>
      build(v, new Set()),
    )

    const expansion = new Map<string, Set<string>>()
    const collect = (n: TopicNode): Set<string> => {
      const s = new Set<string>([n.value])
      for (const c of n.children) for (const v of collect(c)) s.add(v)
      expansion.set(n.value, s)
      return s
    }
    roots.forEach(collect)
    return { roots, expansion }
  } catch {
    // No KB_TOPIC on this instance (or def-store unreachable) — the facet
    // falls back to a flat list over whatever topic values the docs carry.
    return null
  }
}
