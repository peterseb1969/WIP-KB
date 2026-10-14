import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { BootstrapGate } from './components/BootstrapGate'
import { Layout } from './components/Layout'
import HomePage from './pages/HomePage'
import DocPage from './pages/DocPage'
import SearchPage from './pages/SearchPage'
import ClientPage from './pages/ClientPage'
import SettingsPage from './pages/SettingsPage'
import ProjectPage from './pages/ProjectPage'
import AskBar from './components/AskBar'
import { ROUTER_BASENAME } from './lib/namespaces'

export default function App() {
  return (
    <BootstrapGate>
      <BrowserRouter basename={ROUTER_BASENAME}>
        <Layout>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/client" element={<ClientPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/doc/:id" element={<DocPage />} />
            <Route path="/project/:app" element={<ProjectPage />} />
          </Routes>
        </Layout>
        <AskBar />
      </BrowserRouter>
    </BootstrapGate>
  )
}
