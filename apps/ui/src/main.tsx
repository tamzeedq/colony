import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { StoreProvider } from '@/store/store'
import App from './App'
import './fonts'
import './index.css'

// ?static disables the live simulation (useful for screenshots and tests).
const simulate = !new URLSearchParams(location.search).has('static')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <StoreProvider simulate={simulate}>
        <App />
      </StoreProvider>
    </BrowserRouter>
  </StrictMode>,
)
