import { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface Message {
  role: 'user' | 'assistant'
  content: string
  toolCalls?: number
}

const BASE_PATH = import.meta.env.BASE_URL || '/'
const DEFAULT_W = 520
const DEFAULT_H = 600
const MIN_W = 320
const MIN_H = 280

/**
 * App-wide natural-language query bar. Posts the question to `/server-api/ask`,
 * where the server runs an Anthropic model over WIP's MCP tools, and renders the
 * agent's answer. Agent-mediated retrieval, not a deterministic query.
 */
export default function AskBar() {
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(false)
  const [sessionId, setSessionId] = useState<string | undefined>()
  const [dim, setDim] = useState({ w: DEFAULT_W, h: DEFAULT_H })
  const [fullscreen, setFullscreen] = useState(false)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const submit = async () => {
    const question = input.trim()
    if (!question || loading) return
    setInput('')
    setMessages((prev) => [...prev, { role: 'user', content: question }])
    setLoading(true)
    try {
      const res = await fetch(`${BASE_PATH}api/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, sessionId }),
      })
      const data = await res.json()
      if (!res.ok) {
        setMessages((prev) => [...prev, { role: 'assistant', content: `Error: ${data.error}` }])
      } else {
        setSessionId(data.sessionId)
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: data.answer, toolCalls: data.toolCalls },
        ])
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setMessages((prev) => [...prev, { role: 'assistant', content: `Connection error: ${msg}` }])
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    void submit()
  }

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  const handleNew = () => {
    setMessages([])
    setSessionId(undefined)
  }

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      if (fullscreen) return
      e.preventDefault()
      const startX = e.clientX
      const startY = e.clientY
      const startW = dim.w
      const startH = dim.h
      const onMove = (ev: MouseEvent) => {
        const newW = Math.max(MIN_W, Math.min(window.innerWidth - 48, startW + (startX - ev.clientX)))
        const newH = Math.max(MIN_H, Math.min(window.innerHeight - 48, startH + (startY - ev.clientY)))
        setDim({ w: newW, h: newH })
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [dim, fullscreen],
  )

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 w-14 h-14 rounded-full bg-blue-600 text-white shadow-lg hover:bg-blue-700 flex items-center justify-center z-50"
        aria-label="Open chat"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
        </svg>
      </button>
    )
  }

  const panelStyle: React.CSSProperties = fullscreen
    ? { width: 'calc(100vw - 3rem)', height: 'calc(100vh - 3rem)' }
    : { width: dim.w, height: dim.h }

  return (
    <div
      className="fixed bottom-6 right-6 bg-white rounded-2xl shadow-2xl border border-gray-200 flex flex-col z-50 max-w-[calc(100vw-3rem)] max-h-[calc(100vh-3rem)]"
      style={panelStyle}
    >
      {!fullscreen && (
        <div
          onMouseDown={startResize}
          className="absolute top-1 left-1 w-4 h-4 cursor-nwse-resize z-10 text-gray-300 hover:text-gray-500"
          aria-label="Resize"
          title="Drag to resize"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M14 2 L2 14 M14 6 L6 14 M14 10 L10 14" />
          </svg>
        </div>
      )}

      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-blue-600 text-white rounded-t-2xl">
        <span className="font-semibold text-sm pl-3">Ask</span>
        <div className="flex items-center gap-2">
          {messages.length > 0 && (
            <button onClick={handleNew} className="text-xs bg-blue-500 hover:bg-blue-400 px-2 py-1 rounded">
              New
            </button>
          )}
          <button
            onClick={() => setFullscreen((v) => !v)}
            className="text-white/80 hover:text-white p-1"
            aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {fullscreen ? (
                <>
                  <path d="M9 4v5H4" />
                  <path d="M15 4v5h5" />
                  <path d="M9 20v-5H4" />
                  <path d="M15 20v-5h5" />
                </>
              ) : (
                <>
                  <path d="M4 9V4h5" />
                  <path d="M20 9V4h-5" />
                  <path d="M4 15v5h5" />
                  <path d="M20 15v5h-5" />
                </>
              )}
            </svg>
          </button>
          <button onClick={() => setOpen(false)} className="text-white/80 hover:text-white text-lg leading-none px-1" aria-label="Close">
            &times;
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0">
        {messages.length === 0 && (
          <div className="text-gray-400 text-sm text-center py-8">Ask a question about your data...</div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                msg.role === 'user' ? 'bg-blue-600 text-white whitespace-pre-wrap' : 'bg-gray-100 text-gray-800'
              }`}
            >
              {msg.role === 'assistant' ? (
                <div className="prose prose-sm prose-gray max-w-none prose-p:my-1 prose-pre:my-2 prose-pre:bg-gray-50 prose-pre:text-xs prose-headings:mt-2 prose-headings:mb-1 prose-ul:my-1 prose-ol:my-1">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                </div>
              ) : (
                msg.content
              )}
              {msg.toolCalls ? (
                <div className="text-xs mt-1 opacity-60">
                  {msg.toolCalls} tool call{msg.toolCalls > 1 ? 's' : ''}
                </div>
              ) : null}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-gray-100 rounded-lg px-3 py-2 text-sm text-gray-500">Thinking...</div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSubmit} className="border-t border-gray-100 p-3 flex gap-2 items-end">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKey}
          disabled={loading}
          placeholder="Type your question... (Shift+Enter for newline)"
          rows={2}
          className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400 resize-none max-h-40"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </div>
  )
}
