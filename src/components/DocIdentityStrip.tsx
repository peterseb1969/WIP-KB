import { useEffect, useState, type RefObject } from 'react'
import { Check, Copy } from 'lucide-react'

/**
 * A strip fixed to the top of the viewport that names the open document once its
 * header has scrolled away, so the bottom of a long case or paper still says
 * which document it is: the handle (CASE-<n>, CASE-<n>#<seq> for a response, or
 * the template for other types), the title, and the document ID with a copy
 * button. A reading aid only — it never changes the document.
 *
 * @param headerRef - the doc header; the strip shows while it is out of view.
 * @param handle - the short identifier shown first, e.g. "CASE-957".
 * @param title - the document's title.
 * @param documentId - the WIP document ID, shown and copyable.
 */
export function DocIdentityStrip({
  headerRef,
  handle,
  title,
  documentId,
}: {
  headerRef: RefObject<HTMLElement | null>
  handle: string
  title: string
  documentId: string
}) {
  const [visible, setVisible] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const el = headerRef.current
    if (!el) return
    // Shown only once the header has left the viewport upwards; a header below
    // the fold (never the case on load) does not count as scrolled past.
    const io = new IntersectionObserver(([entry]) => {
      if (!entry) return
      setVisible(!entry.isIntersecting && entry.boundingClientRect.top < 0)
    })
    io.observe(el)
    return () => io.disconnect()
  }, [headerRef, documentId])

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])

  if (!visible) return null

  const copy = () => {
    void navigator.clipboard?.writeText(documentId).then(() => setCopied(true))
  }

  return (
    <div
      role="region"
      aria-label="Current document"
      className="fixed inset-x-0 top-0 z-30 border-b border-gray-200 bg-surface/95 shadow-sm backdrop-blur"
    >
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-6 py-2 text-sm">
        <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 font-mono text-xs font-semibold text-primary">
          {handle}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium text-text" title={title}>
          {title}
        </span>
        <span className="hidden shrink-0 font-mono text-xs text-text-muted sm:inline">
          {documentId}
        </span>
        <button
          type="button"
          onClick={copy}
          title="Copy document ID"
          aria-label="Copy document ID"
          className="shrink-0 rounded p-1 text-text-muted hover:bg-background hover:text-text focus:outline-none focus:ring-2 focus:ring-primary/40"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  )
}
