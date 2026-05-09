import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { BootstrapGate } from './components/BootstrapGate'
import { Layout } from './components/Layout'
import HomePage from './pages/HomePage'
import DocPage from './pages/DocPage'
import SearchPage from './pages/SearchPage'
import AskBar from './components/AskBar'

export default function App() {
  return (
    <BootstrapGate>
      <BrowserRouter>
        <Layout>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/doc/:id" element={<DocPage />} />
          </Routes>
        </Layout>
        <AskBar />
      </BrowserRouter>
    </BootstrapGate>
  )
}
