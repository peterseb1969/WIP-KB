import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { WipFooter } from '@wip/react'
import { Sidebar } from './Sidebar'

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="bg-primary">
        <div className="px-6 py-4">
          <Link
            to="/"
            className="text-xl font-semibold tracking-tight text-white hover:text-white/90"
          >
            World in a Pie <span className="text-white/60">·</span> Knowledgebase
          </Link>
        </div>
      </header>
      <div className="flex flex-1">
        <Sidebar />
        <main className="min-w-0 flex-1 px-6 py-8">
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </main>
      </div>
      <WipFooter
        appName="Knowledgebase"
        buildStamp={import.meta.env.VITE_BUILD_STAMP}
        buildSha={import.meta.env.VITE_BUILD_SHA}
      />
    </div>
  )
}
