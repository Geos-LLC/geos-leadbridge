/// <reference types="vite/client" />

declare module '*.css' {
  const content: string;
  export default content;
}

// Injected at build time by vite.config.ts via `define`. Either the short
// git SHA of the deploy, or a `t<base36-timestamp>` fallback when git isn't
// available. Compared at runtime against `/version.json` to surface the
// "Update available" banner when a new build has shipped.
declare const __BUILD_VERSION__: string;
