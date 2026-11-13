// A flag's kind of work is `flag_type`, an identity string the platform cannot turn
// into a term (an identity field's type is immutable). `kind` carries the same value
// as a CLAIM_KIND term, so WIP refuses a kind outside the vocabulary. The proxy guard
// sets it on every flag the browser creates, from flag_type; a value the client sent
// is replaced. Only on a template version that declares the field: an older version
// refuses an undeclared field. Pure, for the guard and its tests.

export const FLAG_KIND_FIELD = 'kind'

/**
 * Set data.kind from data.flag_type when the item writes the template's latest
 * version and that version declares `kind` (`kindVersion`: the latest version when
 * it declares the field, else null). An item pinned to an earlier version gets no
 * kind, which at worst leaves one flag without it rather than failing the write.
 * An item without a pinned version resolves to the latest.
 */
export function setFlagKind(data: Record<string, unknown>, templateVersion: unknown, kindVersion: number | null): void {
  delete data[FLAG_KIND_FIELD]
  if (kindVersion == null) return
  const pinned = templateVersion == null ? kindVersion : Number(templateVersion)
  if (pinned >= kindVersion && typeof data.flag_type === 'string') data[FLAG_KIND_FIELD] = data.flag_type
}
