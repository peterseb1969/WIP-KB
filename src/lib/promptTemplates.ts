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
