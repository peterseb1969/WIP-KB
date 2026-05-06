import { useState } from 'react'
import { PROMPT_INTENTS } from '../lib/promptTemplates'

interface Props {
  docId: string
  docTitle: string
}

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
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
            title={text}
          >
            {copied ? 'copied!' : intent.label}
          </button>
        )
      })}
    </div>
  )
}
