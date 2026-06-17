import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Stable identifier for the bundle we're about to ship. Prefers git short
// SHA so two builds on the same commit are byte-stable; falls back to a
// build timestamp if we're outside a git work tree (e.g. some CI sandboxes).
function computeBuildVersion(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return `t${Date.now().toString(36)}`
  }
}

// Emits `dist/version.json` after the build finishes. The running app polls
// this file to detect that a new deploy has shipped (see
// src/hooks/useBuildVersion.ts + src/components/UpdateAvailableBanner.tsx).
//
// The file is intentionally tiny and static-cacheable for ~0s — Vercel's
// default index.html cache headers (max-age=0, must-revalidate) also apply
// to this asset path because it sits alongside the SPA entry. The runtime
// fetch sends `cache: 'no-store'` belt-and-suspenders.
function emitVersionJson(version: string): Plugin {
  return {
    name: 'lb-version-json',
    apply: 'build',
    writeBundle(opts) {
      const outDir = opts.dir ?? 'dist'
      const payload = JSON.stringify({ version, builtAt: new Date().toISOString() })
      writeFileSync(resolve(outDir, 'version.json'), payload)
    },
  }
}

const BUILD_VERSION = computeBuildVersion()

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), emitVersionJson(BUILD_VERSION)],
  define: {
    // Inject as a JSON-stringified literal so the bundler swaps it inline.
    // `globalThis.__BUILD_VERSION__` becomes `"abc1234"` (a string literal)
    // at every read site. In dev (`vite serve`), `define` still substitutes,
    // so the constant is always populated.
    __BUILD_VERSION__: JSON.stringify(BUILD_VERSION),
  },
})
