import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { BootstrapGate } from './components/BootstrapGate'
import HomePage from './pages/HomePage'
import AskBar from './components/AskBar'

export default function App() {
  return (
    <BootstrapGate>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<HomePage />} />
        </Routes>
        <AskBar />
      </BrowserRouter>
    </BootstrapGate>
  )
}
