import { existsSync } from "node:fs"
import { basename, dirname, isAbsolute, join } from "node:path"
import type { ProjectProfile } from "./profile.ts"

/**
 * Install knowledge per toolchain the Architect has declared. This module never decides which
 * toolchains a project has; it only maps a declared name to its executable, where that
 * executable usually lives, its lockfiles, where dependencies land and a safe install.
 * Pure apart from lockfile existence checks in `hardenedInstall`.
 */
export type DependencyLocation = "node_modules" | "toolchain-home" | "none"
type Env = Readonly<Record<string, string | undefined>>

export type ToolchainFacts = {
  name: string
  executable: string
  /** Directories to search after PATH, in order; absolute only. */
  homes(env: Env, execPath: string): string[]
  lockfiles: readonly string[]
  dependencies: DependencyLocation
  /** The safe install argv for this workspace, or undefined when the toolchain has none. */
  hardenedInstall(workspace: string): string[] | undefined
  /** Values for profile `env` names the service environment lacks (resolved against the real HOME). */
  envDefaults: Readonly<Record<string, (home: string) => string>>
}

const under = (base: string | undefined, ...parts: string[]) => (base ? [join(base, ...parts)] : [])
const absolute = (paths: string[]) => paths.filter((path) => isAbsolute(path))
const hasAny = (workspace: string, names: readonly string[]) =>
  names.some((name) => existsSync(join(workspace, name)))

const npmHomes = (env: Env) => [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  ...under(env.HOME, ".volta", "bin"),
  ...under(env.HOME, ".local", "bin"),
]

function facts(
  name: string,
  rest: Partial<Omit<ToolchainFacts, "name">> & { executable?: string },
): ToolchainFacts {
  return {
    name,
    executable: rest.executable ?? name,
    homes: rest.homes ? (env, execPath) => absolute(rest.homes!(env, execPath)) : () => [],
    lockfiles: rest.lockfiles ?? [],
    dependencies: rest.dependencies ?? "none",
    hardenedInstall: rest.hardenedInstall ?? (() => undefined),
    envDefaults: rest.envDefaults ?? {},
  }
}

const table: Record<string, ToolchainFacts> = {
  bun: facts("bun", {
    homes: (env, execPath) => [
      ...under(env.BUN_INSTALL, "bin"),
      ...under(env.HOME, ".bun", "bin"),
      ...(/^(?:bun|bun.exe)$/.test(basename(execPath)) ? [dirname(execPath)] : []),
    ],
    lockfiles: ["bun.lock", "bun.lockb"],
    dependencies: "node_modules",
    hardenedInstall: (workspace) => [
      "bun",
      "install",
      ...(hasAny(workspace, ["bun.lock", "bun.lockb"]) ? ["--frozen-lockfile"] : []),
      "--ignore-scripts",
      "--no-save",
      "--no-progress",
    ],
  }),
  npm: facts("npm", {
    homes: npmHomes,
    lockfiles: ["package-lock.json", "npm-shrinkwrap.json"],
    dependencies: "node_modules",
    hardenedInstall: (workspace) =>
      hasAny(workspace, ["package-lock.json", "npm-shrinkwrap.json"])
        ? ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"]
        : ["npm", "install", "--ignore-scripts", "--no-save", "--no-audit", "--no-fund"],
  }),
  pnpm: facts("pnpm", {
    homes: (env) => [
      ...npmHomes(env),
      ...under(env.PNPM_HOME),
      ...under(env.HOME, "Library", "pnpm"),
      ...under(env.HOME, ".local", "share", "pnpm"),
    ],
    lockfiles: ["pnpm-lock.yaml"],
    dependencies: "node_modules",
    hardenedInstall: () => ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"],
  }),
  yarn: facts("yarn", {
    homes: npmHomes,
    lockfiles: ["yarn.lock"],
    dependencies: "node_modules",
    hardenedInstall: (workspace) =>
      existsSync(join(workspace, ".yarnrc.yml"))
        ? ["yarn", "install", "--immutable", "--mode=skip-build"]
        : ["yarn", "install", "--frozen-lockfile", "--ignore-scripts"],
  }),
  cargo: facts("cargo", {
    homes: (env) => [...under(env.CARGO_HOME, "bin"), ...under(env.HOME, ".cargo", "bin")],
    lockfiles: ["Cargo.lock"],
    dependencies: "toolchain-home",
    hardenedInstall: () => ["cargo", "fetch", "--locked"],
    envDefaults: {
      CARGO_HOME: (home) => join(home, ".cargo"),
      RUSTUP_HOME: (home) => join(home, ".rustup"),
    },
  }),
}

/** Facts for a declared toolchain; an unknown name runs as itself with no install knowledge. */
export function toolchainFacts(name: string): ToolchainFacts {
  return Object.hasOwn(table, name) ? table[name]! : facts(name, {})
}

export type EffectiveInstall =
  | { source: "profile"; command: string }
  | { source: "hardened-default"; toolchain: string; argv: string[] }
  | { source: "none" }

/** What dependency setup runs: the profile's own command, else each toolchain's safe default. */
export function effectiveInstall(
  profile: Pick<ProjectProfile, "toolchains" | "install">,
  workspace: string,
): EffectiveInstall[] {
  if (profile.install !== undefined) return [{ source: "profile", command: profile.install }]
  const defaults = profile.toolchains.flatMap((toolchain): EffectiveInstall[] => {
    const argv = toolchainFacts(toolchain).hardenedInstall(workspace)
    return argv ? [{ source: "hardened-default", toolchain, argv }] : []
  })
  return defaults.length > 0 ? defaults : [{ source: "none" }]
}
