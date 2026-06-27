import { useState } from 'react'
import { PROMPT_INTENTS } from '../lib/promptTemplates'

interface Props {
  docId: string
  docTitle: string
}

/**
 * The three fixed "prepare a prompt" clipboard buttons (read-for-design,
 * read-and-validate, read-and-plan). Copies a prompt string to the clipboard — no
 * writes, no per-doc-type variation.
 * @param docId/docTitle - the doc to reference in the prompt.
 */
export function PrepareButtons({ docId, docTitle }: Props) {
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const handleCopy = async (intentId: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedId(intentId)
      setTimeout(() => setCopiedId((cur) => (cur === intentId ? null : cur)), 2000)
    } catch {
      // Clipboard API can fail in non-secure contexts. Fall back to a prompt.
      window.prompt('Copy this prompt:', text)
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      {PROMPT_INTENTS.map((intent) => {
        const text = intent.generate(docId, docTitle)
        const copied = copiedId === intent.id
        return (
          <button
            key={intent.id}
            type="button"
            onClick={() => handleCopy(intent.id, text)}
            className="rounded-md border border-primary/30 bg-surface px-3 py-1 text-xs font-medium text-primary hover:bg-primary/5 focus:outline-none focus:ring-2 focus:ring-primary/40"
            title={text}
          >
            {copied ? 'copied!' : intent.label}
          </button>
        )
      })}
    </div>
  )
}
