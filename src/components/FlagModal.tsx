import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { wipFetchJson, assertBulkSuccess } from '../lib/wipBulk'
import { DEFAULT_INTENT } from '../lib/promptTemplates'

interface Props {
  sourceDocId: string
  sourceDocTitle: string
  onClose: () => void
}

interface Term {
  term_id: string
  value: string
  label?: string
}
interface TermListResponse {
  items: Term[]
}
interface TemplateInfo {
  template_id: string
  version: number
}
interface BulkItemResult {
  index?: number
  status?: string
  id?: string
}
interface BulkResponse {
  results: BulkItemResult[]
}

const NAMESPACE = 'kb'
const TARGET_YAC_TERMINOLOGY = 'KB_TARGET_YAC'

export function FlagModal({ sourceDocId, sourceDocTitle, onClose }: Props) {
  const qc = useQueryClient()
  const [targetYac, setTargetYac] = useState('')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<{ flagId: string; flagTitle: string } | null>(null)

  const { data: yacs, isLoading: yacsLoading } = useQuery<Term[]>({
    queryKey: ['target-yacs'],
    queryFn: async () => {
      const t = await wipFetchJson<{ terminology_id: string }>(
        `/api/def-store/terminologies/by-value/${TARGET_YAC_TERMINOLOGY}?namespace=${NAMESPACE}`,
      )
      const list = await wipFetchJson<TermListResponse>(
        `/api/def-store/terminologies/${t.terminology_id}/terms?namespace=${NAMESPACE}&page_size=100`,
      )
      return list.items
    },
    staleTime: 5 * 60_000,
  })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!targetYac) return setError('Pick a target YAC.')
    if (!reason.trim()) return setError('Reason cannot be empty.')

    setSubmitting(true)
    setError(null)
    try {
      const flagTmpl = await wipFetchJson<TemplateInfo>(
        `/api/template-store/templates/by-value/FLAG_RECORD?namespace=${NAMESPACE}`,
      )
      const edgeTmpl = await wipFetchJson<TemplateInfo>(
        `/api/template-store/templates/by-value/FLAGGED_FROM?namespace=${NAMESPACE}`,
      )

      const reasonHead = reason.trim().slice(0, 60)
      const flagTitle = `Flag → ${targetYac}: ${reasonHead}${reason.trim().length > 60 ? '…' : ''}`

      const flagRes = await wipFetchJson<BulkResponse>('/api/document-store/documents', {
        method: 'POST',
        body: JSON.stringify([
          {
            template_id: flagTmpl.template_id,
            template_version: flagTmpl.version,
            namespace: NAMESPACE,
            data: {
              title: flagTitle,
              body: reason.trim(),
              authored_by: 'user',
              target_yac: targetYac,
            },
          },
        ]),
      })
      const [flagItem] = assertBulkSuccess(flagRes, 'FLAG_RECORD')
      const flagId = flagItem?.id
      if (!flagId) throw new Error('FLAG_RECORD created but no id returned')

      const edgeRes = await wipFetchJson<BulkResponse>('/api/document-store/documents', {
        method: 'POST',
        body: JSON.stringify([
          {
            template_id: edgeTmpl.template_id,
            template_version: edgeTmpl.version,
            namespace: NAMESPACE,
            data: {
              source_ref: flagId,
              target_ref: sourceDocId,
            },
          },
        ]),
      })
      assertBulkSuccess(edgeRes, 'FLAGGED_FROM')

      qc.invalidateQueries({ queryKey: ['relationships', sourceDocId] })
      setCreated({ flagId, flagTitle })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  const handleCopyPrompt = async () => {
    if (!created) return
    const prompt = DEFAULT_INTENT.generate(created.flagId, created.flagTitle)
    try {
      await navigator.clipboard.writeText(prompt)
    } catch {
      window.prompt('Copy this prompt:', prompt)
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {!created ? (
          <form onSubmit={handleSubmit}>
            <h2 className="mb-1 text-lg font-semibold text-gray-900">Flag for YAC</h2>
            <p className="mb-4 text-sm text-gray-600">
              Source: <span className="font-mono">{sourceDocTitle}</span>
            </p>

            <label className="mb-3 block">
              <span className="mb-1 block text-sm font-medium text-gray-700">Target YAC</span>
              <select
                value={targetYac}
                onChange={(e) => setTargetYac(e.target.value)}
                disabled={yacsLoading}
                className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">{yacsLoading ? 'Loading…' : 'Pick a YAC…'}</option>
                {yacs?.map((y) => (
                  <option key={y.term_id} value={y.value}>
                    {y.label || y.value}
                  </option>
                ))}
              </select>
            </label>

            <label className="mb-3 block">
              <span className="mb-1 block text-sm font-medium text-gray-700">
                Reason / question
              </span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={5}
                placeholder="Why does this need a YAC's attention? Markdown allowed."
                className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm"
              />
            </label>

            {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded px-4 py-2 text-sm text-gray-600 hover:bg-gray-100"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:bg-blue-300"
              >
                {submitting ? 'Creating…' : 'Create flag'}
              </button>
            </div>
          </form>
        ) : (
          <div>
            <h2 className="mb-1 text-lg font-semibold text-gray-900">Flag created</h2>
            <p className="mb-3 text-sm text-gray-600">
              FLAG_RECORD <span className="font-mono text-xs">{created.flagId}</span> with a
              FLAGGED_FROM edge to the source doc. Prompt to dispatch:
            </p>
            <pre className="mb-3 overflow-x-auto rounded bg-gray-100 p-3 text-xs text-gray-800">
              {DEFAULT_INTENT.generate(created.flagId, created.flagTitle)}
            </pre>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={handleCopyPrompt}
                className="rounded border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
              >
                Copy prompt
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
