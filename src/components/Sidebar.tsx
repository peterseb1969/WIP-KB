import { Fragment } from 'react'
import { NavLink } from 'react-router-dom'
import { Home, Search, Terminal, Settings } from 'lucide-react'
import { CaseJump } from './CaseJump'

const items = [
  { to: '/', label: 'Start', icon: Home, end: true },
  { to: '/search', label: 'Search', icon: Search, end: false },
  { to: '/client', label: 'Client', icon: Terminal, end: false },
  { to: '/settings', label: 'Settings', icon: Settings, end: false },
]

/**
 * Left navigation rail — links to the Home, Search, Client, and Settings routes,
 * with a quick "jump to case" box (`CaseJump`) directly under the Start entry.
 */
export function Sidebar() {
  return (
    <aside className="hidden w-56 shrink-0 border-r border-gray-200 bg-surface md:block">
      <nav className="flex flex-col gap-1 p-3">
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
