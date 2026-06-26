import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initFixPrompt } from '@fixprompt/browser'
import './tailwind.css'
import './index.css'
import './styles/mobile-tokens.css'
import App from './App.tsx'
import { initAnalytics } from './services/analytics'

const fpKey = import.meta.env.VITE_FIXPROMPT_KEY as string | undefined
if (fpKey) {
  initFixPrompt({
    projectKey: fpKey,
    source: 'leadbridge-frontend-prod',
    service: 'leadbridge-frontend',
    env: import.meta.env.PROD ? 'prod' : 'dev',
  })
}

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

// PWA: register the mobile service worker. Production-only so dev HMR
// isn't fighting a cache. Scoped to '/' so it can handle navigations
// across the whole origin (the mobile app navigates to /login when
// signed out, and to deep desktop routes from the More tab). The SW
// itself is conservative — API calls always go to the network, and
// only static assets + the app shell get cached. See public/mobile-sw.js.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/mobile-sw.js', { scope: '/' })
      .catch((err) => console.warn('[pwa] sw registration failed:', err));
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
