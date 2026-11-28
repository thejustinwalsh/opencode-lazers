import { access } from "node:fs/promises"
import { join } from "node:path"

export const reviewProducers = [
  {
    specifier: "opencode-lazers/code-review/structural",
    version: "0.71.0",
    api: "dist/code-review-structural.js",
    workers: ["dist/difftastic-worker.js"],
    assets: ["dist/difftastic.wasm.gz"],
  },
  {
    specifier: "opencode-lazers/code-review/cccc",
    version: "1.7.0",
    api: "dist/code-review-cccc.js",
    workers: ["dist/code-review-cccc-worker.js"],
    assets: ["dist/cccc.wasm"],
  },
  {
    specifier: "opencode-lazers/code-review/jscpd",
    version: "5.4.0",
    api: "dist/jscpd-provider.js",
    workers: ["dist/jscpd-worker.js"],
    assets: ["dist/jscpd.wasm"],
  },
  {
    specifier: "opencode-lazers/code-review/gitleaks",
    version: "8.30.1",
    api: "dist/code-review-gitleaks.js",
    workers: ["dist/gitleaks-worker.js"],
    assets: ["dist/gitleaks.wasm"],
  },
] as const

export const reviewPackageFiles = [
  ...new Set(reviewProducers.flatMap(({ api, workers, assets }) => [api, ...workers, ...assets])),
]

export async function assertReviewPackageFiles(
  packageRoot: string,
  files: readonly string[] = reviewPackageFiles,
): Promise<void> {
  for (const file of files) {
    try {
      await access(join(packageRoot, file))
    } catch {
      throw new Error(`Missing Review package runtime file: ${file}`)
    }
  }
}
