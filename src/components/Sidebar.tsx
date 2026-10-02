import { Fragment } from 'react'
import { NavLink } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Home, Search, Terminal, Settings, Library } from 'lucide-react'
import { CaseJump } from './CaseJump'
import { CORPUS_NS, corpusHref, listCorpora } from '../lib/namespaces'

const items = [
  { to: '/', label: 'Start', icon: Home, end: true },
  { to: '/search', label: 'Search', icon: Search, end: false },
  { to: '/client', label: 'Client', icon: Terminal, end: false },
  { to: '/settings', label: 'Settings', icon: Settings, end: false },
]

/**
 * Which knowledge domain (KB namespace) is shown. Hidden when there is only one.
 * Switching is a full page load to the other domain's URL, so nothing cached for
 * the previous domain carries over.
 */
function CorpusSwitcher() {
  const { data: corpora } = useQuery({
    queryKey: ['kb-corpora'],
    queryFn: listCorpora,
    staleTime: 5 * 60 * 1000,
  })
  if (!corpora || corpora.length < 2) return null
  return (
    <label className="mb-1 flex flex-col gap-1 px-3 pb-2 text-xs text-text-muted">
      <span className="flex items-center gap-1">
        <Library className="h-3.5 w-3.5" /> Knowledge base
      </span>
      <select
        value={CORPUS_NS}
        onChange={(e) => window.location.assign(corpusHref(e.target.value))}
        className="rounded-md border border-gray-200 bg-background px-2 py-1 text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/40"
      >
        {corpora.map((ns) => (
          <option key={ns} value={ns}>{ns}</option>
        ))}
      </select>
    </label>
  )
}

/**
 * Left navigation rail — the knowledge-base switcher (when there is more than one),
 * then links to the Home, Search, Client, and Settings routes, with a quick "jump
 * to case" box (`CaseJump`) directly under the Start entry.
 */
export function Sidebar() {
  return (
    <aside className="hidden w-56 shrink-0 border-r border-gray-200 bg-surface md:block">
      <nav className="flex flex-col gap-1 p-3">
        <CorpusSwitcher />
        {items.map(({ to, label, icon: Icon, end }) => (
          <Fragment key={to}>
            <NavLink
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-2 rounded-md px-3 py-2 text-sm transition focus:outline-none focus:ring-2 focus:ring-primary/40 ${
                  isActive
                    ? 'bg-primary/10 font-medium text-primary'
                    : 'text-text hover:bg-background'
                }`
              }
            >
              <Icon className="h-4 w-4" />
              <span>{label}</span>
            </NavLink>
            {to === '/' && <CaseJump />}
          </Fragment>
        ))}
      </nav>
    </aside>
  )
}
