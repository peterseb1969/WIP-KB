import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { WipFooter } from '@wip/react'

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="border-b border-gray-200 bg-surface">
        <div className="mx-auto flex max-w-6xl items-center px-6 py-4">
          <Link to="/" className="text-xl font-semibold tracking-tight text-text">
            KB
          </Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
      <WipFooter appName="KB" />
    </div>
  )
}
