import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { StoreProvider, type Mode } from '@/store/store'
import { consumePairHash } from '@/api/token'
import App from './App'
import './fonts'
import './index.css'

// Data mode (docs/phase2.md): live by default; `?mock` uses the design's seed data and simulation,
// `?mock&static` freezes it. The choice sticks for this tab (in-app navigation drops the query);
// `?live` switches back.
const params = new URLSearchParams(location.search)
const MODE_KEY = 'colony.mode'
function pickMode(): Mode {
  let stored: string | null = null
  try { stored = sessionStorage.getItem(MODE_KEY) } catch { /* blocked */ }
  const mode: Mode = params.has('mock') ? 'mock' : params.has('live') ? 'live' : stored === 'mock' ? 'mock' : 'live'
  try { sessionStorage.setItem(MODE_KEY, mode) } catch { /* blocked */ }
  return mode
}
const mode = pickMode()
const simulate = !params.has('static')

// `#pair=<token>` from the link the control plane prints.
consumePairHash()
// Opening the pairing link in a tab that already shows the Ops Deck only changes the hash
// (no reload), so pick it up then too.
window.addEventListener('hashchange', consumePairHash)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <StoreProvider mode={mode} simulate={simulate}>
        <App />
      </StoreProvider>
    </BrowserRouter>
  </StrictMode>,
)
