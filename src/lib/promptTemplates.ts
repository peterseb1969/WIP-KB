// Flag intents mirror the case-workflow verbs. flag_type is half of
// FLAG_RECORD's identity [flag_type, flagged_document], so 'respond' and
// 'implement' on the same doc are two distinct flags. (The three
// prepare-a-prompt intents that used to live here retired with the manual
// dispatch flow the automated flag queue replaced.)
export interface FlagIntent {
  id: 'respond' | 'implement'
  label: string
  generate(id: string, title: string): string
}

export const FLAG_INTENTS: FlagIntent[] = [
  {
    id: 'respond',
    label: 'Respond — read, validate, suggest implementation options + cost',
    generate: (id, title) =>
      `Read the KB doc with WIP ID ${id} ("${title}"), validate it against the codebase, and respond with implementation options and a cost estimate.`,
  },
  {
    id: 'implement',
    label: 'Implement',
    generate: (id, title) =>
      `Read the KB doc with WIP ID ${id} ("${title}") and implement it.`,
  },
]

export const DEFAULT_FLAG_INTENT: FlagIntent = FLAG_INTENTS[0]!
