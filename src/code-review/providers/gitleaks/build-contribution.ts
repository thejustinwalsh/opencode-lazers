/**
 * Provider-owned files for the shared server bundler. The foundation task can consume these
 * entries without editing or duplicating Gitleaks-specific paths in this provider.
 */
export const GITLEAKS_SERVER_ENTRIES = [
  ["src/code-review/providers/gitleaks/gitleaks-worker.ts", "gitleaks-worker.js"],
] as const

export const GITLEAKS_SERVER_ASSETS = [
  ["src/code-review/providers/gitleaks/wasm/gitleaks.wasm", "gitleaks.wasm"],
] as const
