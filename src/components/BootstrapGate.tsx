/**
 * BootstrapGate — wraps the app, gating render on namespace state.
 *
 * Implements the offer-on-empty / use-on-exists pattern at the UI level
 * (CLAUDE.md "Bootstrap on Launch — BootstrapGate"):
 *   - On mount, hits /server-api/bootstrap/status.
 *   - 'ready'           → render {children}
 *   - 'wip_unreachable' → "WIP is unreachable" + retry (no answer from WIP at all)
 *   - 'wip_key_refused' → "WIP refused the app's API key" (WIP answered 401/403):
 *                         re-checked on its own with backoff for a few minutes, since
 *                         a just-issued key can take that long to be accepted, then
 *                         settles on a retry button
 *   - 'wip_error'       → "WIP answered with an error" + its HTTP status + retry
 *   - 'check_failed' / 'app_error' → the KB server's own check failed, or the
 *                         KB server did not answer: not WIP's fault + retry
 *   - 'needs_bootstrap' → bootstrap offer with Bootstrap + Check-Again
 *   - 'bootstrapping'   → live SSE progress
 *   - 'error'           → error message + retry
 *
 * The "restore from backup is the user's other option" line under the
 * needs-bootstrap state is load-bearing — without it the app implicitly
 * says "your only choice is to bootstrap a fresh namespace," which can
 * destroy data the user actually meant to restore.
 *
 * Adapted from templates/bootstrap/BootstrapGate.tsx.template:
 *   - serverApiUrl() helper inlined; paths are prefixed with Vite's
 *     `import.meta.env.BASE_URL` (`/`: the KB is served at the root of
 *     its own origin).
 *   - namespace label reads the runtime-loaded CORPUS_NS (CASE-551); APP_TITLE = 'KB'.
 */

import { useState, useEffect, useCallback } from 'react'
import { Database, AlertTriangle, RefreshCw, Loader2, ServerCrash } from 'lucide-react'
import { CORPUS_NS } from '../lib/namespaces'

const APP_TITLE = 'KB'

// Vite BASE_URL always ends in `/` (it is `/`: the KB is served at the root
// of its own origin), so it is concatenated without a leading slash.
const SERVER_API = `${import.meta.env.BASE_URL}server-api`

type AppStatus =
  | 'checking' | 'wip_unreachable' | 'wip_key_refused' | 'wip_error' | 'check_failed' | 'app_error'
  | 'needs_bootstrap' | 'bootstrapping' | 'ready' | 'error'

// The app's key under wip-deploy (the deployer names it app-<manifest name>).
const APP_KEY_NAME = 'app-wip-kb'

// A refused key is re-checked on its own: 5 s, doubling to at most 30 s, for about
// five minutes from the first refusal. After that the page waits for Retry.
const KEY_RETRY_WINDOW_MS = 5 * 60_000
function keyRetryDelay(attempt: number): number {
  return Math.min(5_000 * 2 ** attempt, 30_000)
}

interface BootstrapProgress {
  step: string
  detail: string
  done: boolean
  error?: string
}

export function BootstrapGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AppStatus>('checking')
  const [progress, setProgress] = useState<BootstrapProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [httpStatus, setHttpStatus] = useState<number | null>(null)
  // Automatic re-checks of a refused key: when the first refusal was seen, how many
  // re-checks have run, and when the next one is due (null: none scheduled).
  const [refusedSince, setRefusedSince] = useState<number | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [nextAt, setNextAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())

  // quiet: an automatic re-check keeps the current panel instead of the spinner.
  const checkStatus = useCallback(async (quiet = false) => {
    if (!quiet) setStatus('checking')
    setError(null)
    let res: Response
    try {
      res = await fetch(`${SERVER_API}/bootstrap/status`)
    } catch (e) {
      // The KB server itself did not answer: not a statement about WIP.
      setError((e as Error).message)
      setStatus('app_error')
      return
    }
    try {
      if (!res.ok) throw new Error(`the KB server answered HTTP ${res.status}`)
      const data = (await res.json()) as { status: AppStatus; http_status?: number; error?: string }
      setHttpStatus(data.http_status ?? null)
      setError(data.error ?? null)
      setStatus(data.status)
    } catch (e) {
      setError((e as Error).message)
      setStatus('app_error')
    }
  }, [])

  // A manual check (Retry, Check Again) starts a fresh retry window.
  const checkNow = useCallback(() => {
    setRefusedSince(null)
    setAttempt(0)
    setNextAt(null)
    checkStatus()
  }, [checkStatus])

  useEffect(() => { checkStatus() }, [checkStatus])

  // While the key is refused, schedule the next automatic re-check, within the window.
  useEffect(() => {
    if (status !== 'wip_key_refused') { setNextAt(null); return }
    const since = refusedSince ?? Date.now()
    if (refusedSince === null) setRefusedSince(since)
    if (Date.now() - since >= KEY_RETRY_WINDOW_MS) { setNextAt(null); return }
    const due = Date.now() + keyRetryDelay(attempt)
    setNextAt(due)
    const t = setTimeout(() => { setAttempt((a) => a + 1); checkStatus(true) }, due - Date.now())
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, attempt])

  // A one-second tick for the countdown, only while a re-check is scheduled.
  useEffect(() => {
    if (nextAt === null) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [nextAt])
  const secondsLeft = nextAt === null ? null : Math.max(0, Math.ceil((nextAt - now) / 1000))
  // The window ran out: no re-check is scheduled for a refusal already seen.
  const gaveUp = refusedSince !== null && nextAt === null

  const startBootstrap = useCallback(async () => {
    setStatus('bootstrapping')
    setProgress(null)
    setError(null)

    try {
      const response = await fetch(`${SERVER_API}/bootstrap/run`, { method: 'POST' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (!response.body) throw new Error('No response body')

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let eventType = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim()
          } else if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6)) as BootstrapProgress
              setProgress(data)
              if (eventType === 'complete' && data.done && !data.error) {
                setStatus('ready')
              } else if (eventType === 'error' || data.error) {
                setError(data.error || data.detail)
                setStatus('error')
              }
            } catch { /* skip */ }
            eventType = ''
          }
        }
      }
    } catch (err) {
      setError((err as Error).message)
      setStatus('error')
    }
  }, [])

  if (status === 'ready') return <>{children}</>

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-md rounded-lg border bg-white p-8 shadow-sm">
        <div className="mb-6 flex items-center gap-3">
          <Database className="h-8 w-8 text-blue-600" />
          <h1 className="text-xl font-semibold">{APP_TITLE}</h1>
        </div>

        {status === 'checking' && (
          <div className="flex items-center gap-3 text-gray-500">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>Checking WIP connection...</span>
          </div>
        )}

        {status === 'wip_unreachable' && (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-md border border-red-200 bg-red-50 p-4">
              <ServerCrash className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
              <div>
                <p className="font-medium text-red-800">WIP is unreachable</p>
                <p className="mt-1 text-sm text-red-600">
                  The KB server got no answer from WIP. Make sure WIP is running and reachable from
                  the app.
                </p>
                {error && <p className="mt-1 break-words font-mono text-xs text-red-500">{error}</p>}
              </div>
            </div>
            <button
              onClick={checkNow}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-gray-100 px-4 py-2 text-sm font-medium hover:bg-gray-200"
            >
              <RefreshCw className="h-4 w-4" /> Retry
            </button>
          </div>
        )}

        {status === 'wip_key_refused' && (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-md border border-red-200 bg-red-50 p-4">
              <ServerCrash className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
              <div>
                <p className="font-medium text-red-800">WIP refused the app's API key</p>
                <p className="mt-1 text-sm text-red-600">
                  WIP is running, but it does not accept this app's key
                  (<code className="rounded bg-red-100 px-1">{APP_KEY_NAME}</code>
                  {httpStatus ? `, HTTP ${httpStatus}` : ''}). Right after an install, an added app or a
                  key rotation, the key can take a few minutes to be accepted (on k8s, until the mounted
                  key file refreshes). If it persists, the key was revoked or the app was removed from
                  the install; redeploying the app gives it a valid key.
                </p>
              </div>
            </div>
            {secondsLeft !== null ? (
              <p className="flex items-center justify-center gap-2 text-sm text-gray-500">
                <Loader2 className="h-4 w-4 animate-spin" /> Checking again in {secondsLeft} s…
              </p>
            ) : gaveUp ? (
              <p className="text-center text-xs text-gray-400">Stopped checking on its own after a few minutes.</p>
            ) : null}
            <button
              onClick={checkNow}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-gray-100 px-4 py-2 text-sm font-medium hover:bg-gray-200"
            >
              <RefreshCw className="h-4 w-4" /> Retry now
            </button>
          </div>
        )}

        {status === 'wip_error' && (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-md border border-red-200 bg-red-50 p-4">
              <ServerCrash className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
              <div>
                <p className="font-medium text-red-800">WIP answered with an error{httpStatus ? ` (HTTP ${httpStatus})` : ''}</p>
                <p className="mt-1 text-sm text-red-600">
                  WIP is reachable and accepted the key, but failed to answer the check. A WIP service
                  may be starting or unhealthy; check the install's status.
                </p>
                {error && <p className="mt-1 break-words font-mono text-xs text-red-500">{error}</p>}
              </div>
            </div>
            <button
              onClick={checkNow}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-gray-100 px-4 py-2 text-sm font-medium hover:bg-gray-200"
            >
              <RefreshCw className="h-4 w-4" /> Retry
            </button>
          </div>
        )}

        {(status === 'check_failed' || status === 'app_error') && (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-md border border-red-200 bg-red-50 p-4">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
              <div>
                <p className="font-medium text-red-800">
                  {status === 'app_error' ? 'The KB server did not answer' : 'The KB server could not run its check'}
                </p>
                <p className="mt-1 text-sm text-red-600">
                  This is the KB app's own server, not WIP. {status === 'app_error'
                    ? 'It may be restarting; check the app container.'
                    : 'Its log says more.'}
                </p>
                {error && <p className="mt-1 break-words font-mono text-xs text-red-500">{error}</p>}
              </div>
            </div>
            <button
              onClick={checkNow}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-gray-100 px-4 py-2 text-sm font-medium hover:bg-gray-200"
            >
              <RefreshCw className="h-4 w-4" /> Retry
            </button>
          </div>
        )}

        {status === 'needs_bootstrap' && (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 p-4">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
              <div>
                <p className="font-medium text-amber-800">Namespace not found</p>
                <p className="mt-1 text-sm text-amber-600">
                  The <code className="rounded bg-amber-100 px-1">{CORPUS_NS}</code> namespace
                  does not exist. You can bootstrap it now, or restore from a backup first
                  (via the WIP console / <code className="rounded bg-amber-100 px-1">wip-deploy</code>).
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <button
                onClick={startBootstrap}
                className="flex flex-1 items-center justify-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                <Database className="h-4 w-4" /> Bootstrap
              </button>
              <button
                onClick={checkNow}
                className="flex flex-1 items-center justify-center gap-2 rounded-md bg-gray-100 px-4 py-2 text-sm font-medium hover:bg-gray-200"
              >
                <RefreshCw className="h-4 w-4" /> Check Again
              </button>
            </div>
            <p className="text-xs text-gray-400 text-center">
              If restoring from backup, do so now and then click "Check Again".
            </p>
          </div>
        )}

        {status === 'bootstrapping' && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
              <span className="font-medium">Bootstrapping...</span>
            </div>
            {progress && (
              <div className="rounded-md bg-gray-50 p-3">
                <p className="text-xs font-medium text-gray-500">{progress.step}</p>
                <p className="mt-1 text-sm">{progress.detail}</p>
              </div>
            )}
          </div>
        )}

        {status === 'error' && (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-md border border-red-200 bg-red-50 p-4">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
              <div>
                <p className="font-medium text-red-800">Bootstrap failed</p>
                <p className="mt-1 text-sm text-red-600">{error}</p>
              </div>
            </div>
            <div className="flex gap-3">
              <button
                onClick={startBootstrap}
                className="flex flex-1 items-center justify-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                <RefreshCw className="h-4 w-4" /> Retry Bootstrap
              </button>
              <button
                onClick={checkNow}
                className="flex flex-1 items-center justify-center gap-2 rounded-md bg-gray-100 px-4 py-2 text-sm font-medium hover:bg-gray-200"
              >
                <RefreshCw className="h-4 w-4" /> Check Status
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
