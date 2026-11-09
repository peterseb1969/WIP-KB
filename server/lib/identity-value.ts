// The value an edge's target key is matched with, against a type's identity field.
//
// A writer names a minted document the way the KB prints it: CASE-1179, not 1179.
// When the identity field is an integer, such a handle (<PREFIX>-<n>, or #<n>) and a
// numeric string are matched as the number: an equality filter on the string would
// find nothing and leave the edge silently unlinked. Any other key, and any key for
// a non-integer identity field, is passed through unchanged.
export function identityValue(
  template: { fields?: Array<{ name?: string; type?: string }> },
  idField: string,
  targetKey: unknown,
): unknown {
  const field = (template.fields ?? []).find((f) => f.name === idField)
  if (field?.type !== 'integer' || typeof targetKey !== 'string') return targetKey
  const m = /^\s*(?:[A-Za-z][A-Za-z_]*-|#)?(\d+)\s*$/.exec(targetKey)
  return m ? Number(m[1]) : targetKey
}
