import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { toolchainFacts } from "../../../src/projects/toolchains.ts"

/**
 * Helpers for tests that need a real toolchain. A missing toolchain is never a silent pass:
 * the test is declared `test.skipIf(!requireToolchain(name, title))`, which warns
 * `SKIPPED (<reason>): <title>`, and under `LAZERS_REQUIRE_TOOLCHAINS=1` throws instead, so an
 * acceptance run cannot succeed by skipping. Fixtures are source files only; `node_modules`
 * and `target/` exist only inside the temporary copies these helpers make.
 */
export type RequiredToolchain = "cargo" | "npm" | "npm-cache"
export type Availability = { available: boolean; reason: string }

const here = import.meta.dir
const IDENTITY = ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid"]
const EXCLUDED = new Set(["node_modules", "target", ".git"])

/** The service-style search: PATH first, then the toolchain's known homes. */
function locate(name: "cargo" | "npm", env: Record<string, string | undefined> = process.env) {
  const homes = toolchainFacts(name).homes({ ...env, HOME: env.HOME ?? homedir() }, process.execPath)
  return Bun.which(name, { PATH: [env.PATH ?? "", ...homes].join(delimiter) }) ?? undefined
}

let cache: Availability | undefined
function npmCacheAvailability(): Availability {
  if (cache) return cache
  const npm = locate("npm")
  if (!npm) return (cache = { available: false, reason: "npm not found on PATH" })
  const copy = mkdtempSync(join(tmpdir(), "lazers-npm-probe-"))
  try {
    cpSync(join(here, "npm-eslint-vitest"), copy, {
      recursive: true,
      filter: (source) => !EXCLUDED.has(source.split("/").pop() ?? ""),
    })
    const result = Bun.spawnSync(
      [npm, "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: copy, stdout: "ignore", stderr: "ignore", timeout: 120_000 },
    )
    return (cache =
      result.exitCode === 0
        ? { available: true, reason: "" }
        : {
            available: false,
            reason:
              `npm cache lacks the fixture's packages; run "npm ci" once in ` +
              "test/fixtures/profile/npm-eslint-vitest with network",
          })
  } finally {
    rmSync(copy, { recursive: true, force: true })
  }
}

export function toolchainAvailable(name: RequiredToolchain): Availability {
  if (name === "npm-cache") return npmCacheAvailability()
  return locate(name)
    ? { available: true, reason: "" }
    : { available: false, reason: `${name} not found on PATH or in its known homes` }
}

/**
 * Warns `SKIPPED (<reason>): <title>` and returns false when the toolchain is missing; throws
 * when `LAZERS_REQUIRE_TOOLCHAINS=1`. `probe` is injectable so the skip path itself is tested.
 */
export function requireToolchain(
  name: RequiredToolchain,
  title: string,
  probe: (name: RequiredToolchain) => Availability = toolchainAvailable,
): boolean {
  const { available, reason } = probe(name)
  if (available) return true
  if (process.env.LAZERS_REQUIRE_TOOLCHAINS === "1")
    throw new Error(`Toolchain ${name} is required by LAZERS_REQUIRE_TOOLCHAINS: ${reason}`)
  console.warn(`SKIPPED (${reason}): ${title}`)
  return false
}

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

/** A temporary git repository holding one commit of the named fixture. */
export function fixtureRepo(name: "cargo-min" | "npm-eslint-vitest"): {
  root: string
  base: string
  cleanup(): void
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `lazers-fixture-${name}-`)))
  cpSync(join(here, name), root, {
    recursive: true,
    filter: (source) => !EXCLUDED.has(source.split("/").pop() ?? ""),
  })
  git(root, ["init", "--initial-branch=main"])
  git(root, ["add", "-A"])
  git(root, [...IDENTITY, "commit", "-m", "fixture baseline"])
  return {
    root,
    base: git(root, ["rev-parse", "HEAD"]),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

/** A temporary bin directory of executable scripts, for always-on fake-toolchain tests. */
export function fakeTools(scripts: Record<string, string>): { bin: string; cleanup(): void } {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), "lazers-fake-tools-")))
  for (const [name, body] of Object.entries(scripts)) {
    const file = join(bin, name)
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, body.endsWith("\n") ? body : `${body}\n`)
    chmodSync(file, 0o755)
  }
  return { bin, cleanup: () => rmSync(bin, { recursive: true, force: true }) }
}
