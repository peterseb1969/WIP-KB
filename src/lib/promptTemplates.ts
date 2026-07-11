export interface PromptIntent {
  id: 'design' | 'validate' | 'plan'
  label: string
  generate(id: string, title: string): string
}

export const PROMPT_INTENTS: PromptIntent[] = [
  {
    id: 'design',
    label: 'Read for design discussion',
    generate: (id, title) =>
      `Read the KB doc with WIP ID ${id} ("${title}") to prepare for a design discussion.`,
  },
  {
    id: 'validate',
    label: 'Read and validate via codebase',
    generate: (id, title) =>
      `Read the KB doc with WIP ID ${id} ("${title}") and validate the claims by investigating the codebase.`,
  },
  {
    id: 'plan',
    label: 'Read and create implementation plan',
    generate: (id, title) =>
      `Read the KB doc with WIP ID ${id} ("${title}") and produce an implementation plan.`,
  },
]

export const DEFAULT_INTENT: PromptIntent = PROMPT_INTENTS[0]!

// Flag intents are a separate vocabulary from the three prepare-a-prompt
// buttons above: they mirror the case-workflow verbs. flag_type is half of
// FLAG_RECORD's identity [flag_type, flagged_document], so 'respond' and
// 'implement' on the same doc are two distinct flags.
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
