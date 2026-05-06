import { useParams } from 'react-router-dom'

export default function DocPage() {
  const { id } = useParams<{ id: string }>()
  return (
    <div>
      <h1 className="text-2xl font-semibold text-gray-900">Doc view</h1>
      <p className="mt-2 font-mono text-sm text-gray-500">id={id}</p>
      <p className="mt-4 text-gray-600">Renderer not yet implemented.</p>
    </div>
  )
}
