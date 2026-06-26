import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { BootstrapGate } from './components/BootstrapGate'
import { Layout } from './components/Layout'
import HomePage from './pages/HomePage'
import DocPage from './pages/DocPage'
import SearchPage from './pages/SearchPage'
import ClientPage from './pages/ClientPage'
import SettingsPage from './pages/SettingsPage'
import AskBar from './components/AskBar'

const BASENAME = import.meta.env.BASE_URL.replace(/\/$/, '') || '/'

export default function App() {
  return (
    <BootstrapGate>
      <BrowserRouter basename={BASENAME}>
        <Layout>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/client" element={<ClientPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/doc/:id" element={<DocPage />} />
          </Routes>
        </Layout>
        <AskBar />
      </BrowserRouter>
    </BootstrapGate>
  )
}
