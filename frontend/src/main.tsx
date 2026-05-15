import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './tailwind.css'
import './index.css'
import App from './App.tsx'
import { initAnalytics } from './services/analytics'

void initAnalytics()

// When a new deploy invalidates the chunk hashes referenced by the currently
// loaded index.html, lazy-loaded route chunks 404 and Vercel serves the SPA
// fallback (index.html) — the browser then rejects HTML as a JS module. Reload
// once to pick up the fresh index.html. Guard against reload loops with a
// session marker so a genuinely-broken chunk doesn't trap us in a loop.
window.addEventListener('vite:preloadError', () => {
  const KEY = 'lb_chunk_reload_at'
  const last = Number(sessionStorage.getItem(KEY) ?? '0')
  if (Date.now() - last < 10_000) return
  sessionStorage.setItem(KEY, String(Date.now()))
  window.location.reload()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
