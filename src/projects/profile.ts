import { z } from "zod"

/**
 * The project profile: what a project verifies, fixes, installs and treats as source, declared
 * once per project. Pure: no filesystem, no clock. `parseProfile` collects every issue with its
 * field path; a profile that does not parse can never be stored (see `profile-store.ts`).
 */
export type ProjectProfile = {
  toolchains: string[]
  verify: { id: string; command: string }[]
  fix: { command: string; files?: string[] }[]
  install?: string
  env: string[]
  audit: "fallow" | "off"
  source: { include: string[]; exclude: string[] }
}

export type ProfileIssue = {
  code:
    | "VERIFY_EMPTY"
    | "VERIFY_ID_INVALID"
    | "VERIFY_ID_DUPLICATE"
    | "COMMAND_INVALID"
    | "TOOLCHAIN_INVALID"
    | "ENV_INVALID"
    | "ENV_RESERVED"
    | "AUDIT_UNKNOWN"
    | "SOURCE_INCLUDE_EMPTY"
    | "GLOB_INVALID"
    | "EXPORTS_DEFERRED"
    | "FIELD_UNKNOWN"
  /** For example `verify[2].command`. */
  path: string
  message: string
}

/** The names the isolated recheck owns; a profile `env` cannot keep them from the service. */
export const RESERVED_ENV: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "BUN_INSTALL_CACHE_DIR",
  "BUN_CONFIG_DIR",
  "BUN_TMPDIR",
  "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
  "npm_config_cache",
  "NPM_CONFIG_CACHE",
  "COREPACK_HOME",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "LAZERS_VERIFICATION_SQLITE",
  "GIT_TERMINAL_PROMPT",
  "CARGO_TARGET_DIR",
])

export function credentialLikeEnv(name: string): boolean {
  return /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|_KEY$|^KEY_/i.test(name)
}

const TOOLCHAIN = /^[a-z][a-z0-9-]{0,31}$/
const VERIFY_ID = /^[a-z][a-z0-9-]{0,63}$/
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/
const TOP_LEVEL = new Set(["toolchains", "verify", "fix", "install", "env", "audit", "source"])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Control characters other than a tab (newline, carriage return, NUL, escape and the rest). */
function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) return true
  }
  return false
}

export function parseProfile(
  value: unknown,
): { ok: true; profile: ProjectProfile } | { ok: false; issues: ProfileIssue[] } {
  const issues: ProfileIssue[] = []
  const add = (code: ProfileIssue["code"], path: string, message: string) =>
    issues.push({ code, path, message })

  if (!isRecord(value)) {
    add("FIELD_UNKNOWN", "", "A profile must be a JSON object")
    return { ok: false, issues }
  }
  for (const key of Object.keys(value))
    if (!TOP_LEVEL.has(key)) add("FIELD_UNKNOWN", key, `Unknown profile field "${key}"`)

  const command = (raw: unknown, path: string): string | undefined => {
    if (typeof raw !== "string" || raw.trim() === "") {
      add("COMMAND_INVALID", path, "A command must be a non-empty string")
      return undefined
    }
    if (hasControlCharacter(raw)) {
      add("COMMAND_INVALID", path, "A command must be one line with no control characters")
      return undefined
    }
    return raw
  }
  /** Globs are git forward-slash paths relative to the project root. */
  const glob = (raw: unknown, path: string): string | undefined => {
    if (typeof raw !== "string" || raw.trim() === "") {
      add("GLOB_INVALID", path, "A glob must be a non-empty string")
      return undefined
    }
    if (raw.includes("\\")) add("GLOB_INVALID", path, `Glob "${raw}" must use "/", not "\\"`)
    else if (raw.startsWith("/"))
      add("GLOB_INVALID", path, `Glob "${raw}" must be relative to the project root`)
    else if (raw.split("/").includes(".."))
      add("GLOB_INVALID", path, `Glob "${raw}" must not contain ".."`)
    else if (hasControlCharacter(raw))
      add("GLOB_INVALID", path, "A glob must have no control characters")
    else return raw
    return undefined
  }
  const globs = (raw: unknown, path: string): string[] => {
    if (!Array.isArray(raw)) {
      add("GLOB_INVALID", path, "Expected a list of globs")
      return []
    }
    return raw.flatMap((item, index) => {
      const ok = glob(item, `${path}[${index}]`)
      return ok === undefined ? [] : [ok]
    })
  }

  // toolchains
  const toolchains: string[] = []
  if (value.toolchains !== undefined) {
    if (!Array.isArray(value.toolchains))
      add("TOOLCHAIN_INVALID", "toolchains", "Expected a list of toolchain names")
    else
      value.toolchains.forEach((item, index) => {
        const path = `toolchains[${index}]`
        if (typeof item !== "string" || !TOOLCHAIN.test(item))
          add("TOOLCHAIN_INVALID", path, `Toolchain name must match ${TOOLCHAIN}`)
        else if (toolchains.includes(item))
          add("TOOLCHAIN_INVALID", path, `Toolchain "${item}" is listed twice`)
        else toolchains.push(item)
      })
  }

  // verify
  const verify: ProjectProfile["verify"] = []
  if (!Array.isArray(value.verify) || value.verify.length === 0)
    add("VERIFY_EMPTY", "verify", "A profile needs at least one verify command")
  else
    value.verify.forEach((item, index) => {
      const path = `verify[${index}]`
      if (!isRecord(item)) {
        add("COMMAND_INVALID", path, "A verify entry must be an object with an id and a command")
        return
      }
      for (const key of Object.keys(item))
        if (key !== "id" && key !== "command")
          add("FIELD_UNKNOWN", `${path}.${key}`, `Unknown verify field "${key}"`)
      let id: string | undefined
      if (typeof item.id !== "string" || !VERIFY_ID.test(item.id))
        add("VERIFY_ID_INVALID", `${path}.id`, `Verify id must match ${VERIFY_ID}`)
      else if (verify.some((entry) => entry.id === item.id))
        add("VERIFY_ID_DUPLICATE", `${path}.id`, `Verify id "${item.id}" is used twice`)
      else id = item.id
      const text = command(item.command, `${path}.command`)
      if (id !== undefined && text !== undefined) verify.push({ id, command: text })
    })

  // fix
  const fix: ProjectProfile["fix"] = []
  if (value.fix !== undefined) {
    if (!Array.isArray(value.fix)) add("COMMAND_INVALID", "fix", "Expected a list of fix entries")
    else
      value.fix.forEach((item, index) => {
        const path = `fix[${index}]`
        if (!isRecord(item)) {
          add("COMMAND_INVALID", path, "A fix entry must be an object with a command")
          return
        }
        for (const key of Object.keys(item))
          if (key !== "command" && key !== "files")
            add("FIELD_UNKNOWN", `${path}.${key}`, `Unknown fix field "${key}"`)
        const text = command(item.command, `${path}.command`)
        let files: string[] | undefined
        if (item.files !== undefined) {
          if (Array.isArray(item.files) && item.files.length === 0)
            add("GLOB_INVALID", `${path}.files`, "files must list at least one glob when present")
          else files = globs(item.files, `${path}.files`)
        }
        if (
          text !== undefined &&
          (item.files === undefined || files?.length === (item.files as unknown[]).length)
        )
          fix.push({ command: text, ...(files ? { files } : {}) })
      })
  }

  // install
  let install: string | undefined
  if (value.install !== undefined) install = command(value.install, "install")

  // env
  const env: string[] = []
  if (value.env !== undefined) {
    if (!Array.isArray(value.env)) add("ENV_INVALID", "env", "Expected a list of variable names")
    else
      value.env.forEach((item, index) => {
        const path = `env[${index}]`
        if (typeof item !== "string" || !ENV_NAME.test(item))
          add("ENV_INVALID", path, `Variable name must match ${ENV_NAME}`)
        else if (RESERVED_ENV.has(item))
          add("ENV_RESERVED", path, `${item} is set by the verification environment itself`)
        else if (env.includes(item)) add("ENV_INVALID", path, `${item} is listed twice`)
        else env.push(item)
      })
  }

  // audit: an unset audit is Fallow, which is what a project has today.
  let audit: ProjectProfile["audit"] = "fallow"
  if (value.audit !== undefined) {
    if (value.audit === "fallow" || value.audit === "off") audit = value.audit
    else add("AUDIT_UNKNOWN", "audit", `audit must be "fallow" or "off"`)
  }

  // source
  const source: ProjectProfile["source"] = { include: [], exclude: [] }
  if (!isRecord(value.source))
    add("SOURCE_INCLUDE_EMPTY", "source.include", "A profile needs source.include with a glob")
  else {
    for (const key of Object.keys(value.source)) {
      if (key === "exports")
        add("EXPORTS_DEFERRED", "source.exports", "Export scanning for other languages is deferred")
      else if (key !== "include" && key !== "exclude")
        add("FIELD_UNKNOWN", `source.${key}`, `Unknown source field "${key}"`)
    }
    if (!Array.isArray(value.source.include) || value.source.include.length === 0)
      add("SOURCE_INCLUDE_EMPTY", "source.include", "source.include needs at least one glob")
    else source.include = globs(value.source.include, "source.include")
    if (value.source.exclude !== undefined)
      source.exclude = globs(value.source.exclude, "source.exclude")
  }

  if (issues.length > 0) return { ok: false, issues }
  return {
    ok: true,
    profile: {
      toolchains,
      verify,
      fix,
      ...(install === undefined ? {} : { install }),
      env,
      audit,
      source,
    },
  }
}

export const ProjectProfileSchema: z.ZodType<ProjectProfile> = z
  .unknown()
  .superRefine((raw, context) => {
    const parsed = parseProfile(raw)
    if (!parsed.ok)
      for (const issue of parsed.issues)
        context.addIssue({
          code: "custom",
          path: issue.path === "" ? [] : issue.path.split(/[.[\]]+/).filter(Boolean),
          message: `${issue.code}: ${issue.message}`,
        })
  })
  .transform((raw) => {
    const parsed = parseProfile(raw)
    if (!parsed.ok) throw new Error("unreachable: refined profile failed to parse")
    return parsed.profile
  })

export type ProfileChange = {
  field:
    | "toolchains"
    | "verify"
    | "fix"
    | "install"
    | "env"
    | "audit"
    | "source.include"
    | "source.exclude"
  kind: "added" | "removed" | "changed"
  /** The verify id, fix index, glob, env name or toolchain name; `order` for a reorder. */
  key: string
  before?: string
  after?: string
}

const fixText = (entry: ProjectProfile["fix"][number]) => entry.command
const fixFiles = (entry: ProjectProfile["fix"][number]) => (entry.files ?? []).join(",")

/** What a new profile changes against the active one (none: everything is added). */
export function profileDiff(
  active: ProjectProfile | undefined,
  proposed: ProjectProfile,
): ProfileChange[] {
  const before: ProjectProfile = active ?? {
    toolchains: [],
    verify: [],
    fix: [],
    env: [],
    audit: undefined as unknown as "fallow",
    source: { include: [], exclude: [] },
  }
  const changes: ProfileChange[] = []

  const setDiff = (
    field: ProfileChange["field"],
    was: readonly string[],
    now: readonly string[],
  ) => {
    for (const key of now)
      if (!was.includes(key)) changes.push({ field, kind: "added", key, after: key })
    for (const key of was)
      if (!now.includes(key)) changes.push({ field, kind: "removed", key, before: key })
    const kept = (list: readonly string[], other: readonly string[]) =>
      list.filter((k) => other.includes(k))
    if (kept(was, now).join("\0") !== kept(now, was).join("\0"))
      changes.push({
        field,
        kind: "changed",
        key: "order",
        before: kept(was, now).join(","),
        after: kept(now, was).join(","),
      })
  }

  setDiff("toolchains", before.toolchains, proposed.toolchains)

  const was = new Map(before.verify.map((entry) => [entry.id, entry.command]))
  const now = new Map(proposed.verify.map((entry) => [entry.id, entry.command]))
  for (const [id, command] of now) {
    const old = was.get(id)
    if (old === undefined) changes.push({ field: "verify", kind: "added", key: id, after: command })
    else if (old !== command)
      changes.push({ field: "verify", kind: "changed", key: id, before: old, after: command })
  }
  for (const [id, command] of was)
    if (!now.has(id)) changes.push({ field: "verify", kind: "removed", key: id, before: command })
  const keptWas = before.verify.filter((entry) => now.has(entry.id)).map((entry) => entry.id)
  const keptNow = proposed.verify.filter((entry) => was.has(entry.id)).map((entry) => entry.id)
  if (keptWas.join("\0") !== keptNow.join("\0"))
    changes.push({
      field: "verify",
      kind: "changed",
      key: "order",
      before: keptWas.join(","),
      after: keptNow.join(","),
    })

  for (let index = 0; index < Math.max(before.fix.length, proposed.fix.length); index++) {
    const key = String(index)
    const old = before.fix[index]
    const next = proposed.fix[index]
    if (old && !next) changes.push({ field: "fix", kind: "removed", key, before: fixText(old) })
    else if (!old && next) changes.push({ field: "fix", kind: "added", key, after: fixText(next) })
    else if (old && next) {
      const commandChanged = old.command !== next.command
      const filesChanged = fixFiles(old) !== fixFiles(next)
      if (commandChanged && filesChanged)
        changes.push({
          field: "fix",
          kind: "changed",
          key,
          before: `${old.command} [${fixFiles(old)}]`,
          after: `${next.command} [${fixFiles(next)}]`,
        })
      else if (commandChanged)
        changes.push({
          field: "fix",
          kind: "changed",
          key,
          before: old.command,
          after: next.command,
        })
      else if (filesChanged)
        changes.push({
          field: "fix",
          kind: "changed",
          key,
          before: fixFiles(old),
          after: fixFiles(next),
        })
    }
  }

  if (before.install === undefined && proposed.install !== undefined)
    changes.push({ field: "install", kind: "added", key: "install", after: proposed.install })
  else if (before.install !== undefined && proposed.install === undefined)
    changes.push({ field: "install", kind: "removed", key: "install", before: before.install })
  else if (before.install !== proposed.install)
    changes.push({
      field: "install",
      kind: "changed",
      key: "install",
      before: before.install,
      after: proposed.install,
    })

  setDiff("env", before.env, proposed.env)

  if (active === undefined)
    changes.push({ field: "audit", kind: "added", key: "audit", after: proposed.audit })
  else if (before.audit !== proposed.audit)
    changes.push({
      field: "audit",
      kind: "changed",
      key: "audit",
      before: before.audit,
      after: proposed.audit,
    })

  setDiff("source.include", before.source.include, proposed.source.include)
  setDiff("source.exclude", before.source.exclude, proposed.source.exclude)
  return changes
}
