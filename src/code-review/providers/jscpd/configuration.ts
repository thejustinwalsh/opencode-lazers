import type { JscpdConfig, JscpdIgnoreFile } from "./contract.ts"

export const DEFAULT_JSCPD_IGNORES = ["**/node_modules/**", "**/.git/**"]
const SUPPORTED_CONFIG_KEYS = new Set([
  "mode",
  "ignoreCase",
  "ignoreIdentifiers",
  "ignoreLiterals",
  "ignoreAnnotations",
  "formats",
  "formatsExts",
  "formatsNames",
  "ignore",
  "ignorePattern",
  "codeIgnorePatterns",
  "crossFormats",
  "maxLines",
  "maxSize",
  "maxGapLines",
  "similarity",
  "noGitignore",
  "skipLocal",
  "skipIsolated",
  "pattern",
])

function cloneMapping(
  mapping: Readonly<Record<string, readonly string[]>> | undefined,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(mapping ?? {}).map(([name, values]) => [name, [...values]]),
  )
}

function defaulted<T>(value: T | undefined, fallback: T): T {
  return value ?? fallback
}

function cloneList<T>(values: readonly T[] | undefined): T[] {
  return [...(values ?? [])]
}

function cloneGroups(groups: readonly (readonly string[])[] | undefined): string[][] {
  return (groups ?? []).map((group) => [...group])
}

function optionalPattern(pattern: string | undefined): Pick<JscpdConfig, "pattern"> {
  return pattern === undefined ? {} : { pattern }
}

function codeIgnorePatterns(config: JscpdConfig | undefined): string[] {
  return cloneList(config?.ignorePattern ?? config?.codeIgnorePatterns)
}

function detectorConfig(config: JscpdConfig | undefined): Partial<JscpdConfig> {
  return {
    mode: defaulted(config?.mode, "mild"),
    ignoreCase: defaulted(config?.ignoreCase, false),
    ignoreIdentifiers: defaulted(config?.ignoreIdentifiers, false),
    ignoreLiterals: defaulted(config?.ignoreLiterals, false),
    ignoreAnnotations: defaulted(config?.ignoreAnnotations, false),
  }
}

function formatConfig(config: JscpdConfig | undefined): Partial<JscpdConfig> {
  return {
    formats: cloneList(config?.formats),
    formatsExts: cloneMapping(config?.formatsExts),
    formatsNames: cloneMapping(config?.formatsNames),
    crossFormats: cloneGroups(config?.crossFormats),
  }
}

function ignoreConfig(config: JscpdConfig | undefined): Partial<JscpdConfig> {
  return {
    ignore: cloneList(config?.ignore),
    codeIgnorePatterns: codeIgnorePatterns(config),
    noGitignore: defaulted(config?.noGitignore, false),
    skipLocal: defaulted(config?.skipLocal, false),
    skipIsolated: cloneGroups(config?.skipIsolated),
    ...optionalPattern(config?.pattern),
  }
}

function thresholdConfig(config: JscpdConfig | undefined): Partial<JscpdConfig> {
  return {
    ...(config?.maxLines === undefined ? {} : { maxLines: config.maxLines }),
    ...(config?.maxSize === undefined ? {} : { maxSize: config.maxSize }),
    ...(config?.maxGapLines === undefined ? {} : { maxGapLines: config.maxGapLines }),
    ...(config?.similarity === undefined ? {} : { similarity: config.similarity }),
  }
}

/** A stable, complete projection of the captured `.jscpd.json` settings we consume. */
function normalizeJscpdConfig(config: JscpdConfig | undefined): JscpdConfig {
  return {
    ...detectorConfig(config),
    ...formatConfig(config),
    ...ignoreConfig(config),
    ...thresholdConfig(config),
  }
}

/** Fixed Oaink flags win over `.jscpd.json`, matching its pinned CLI invocation. */
export function effectiveJscpdConfig(config: JscpdConfig | undefined): JscpdConfig {
  return {
    ...normalizeJscpdConfig(config),
    ignore: [...DEFAULT_JSCPD_IGNORES],
  }
}

export function unsupportedJscpdConfigKeys(config: JscpdConfig | undefined): string[] {
  return Object.keys(config ?? {})
    .filter((key) => !SUPPORTED_CONFIG_KEYS.has(key))
    .map((key) => (/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) ? key : "unknown"))
    .sort((left, right) => left.localeCompare(right))
    .filter((key, index, keys) => index === 0 || key !== keys[index - 1])
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`
  if (!value || typeof value !== "object") return JSON.stringify(value) ?? "null"
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  )
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableValue(child)}`).join(",")}}`
}

export function capturedConfigurationChanged(
  base: {
    config?: JscpdConfig
    ignoreFiles: readonly JscpdIgnoreFile[]
    ignoreFilesComplete: boolean
    unsupportedConfig?: readonly string[]
  },
  head: {
    config?: JscpdConfig
    ignoreFiles: readonly JscpdIgnoreFile[]
    ignoreFilesComplete: boolean
    unsupportedConfig?: readonly string[]
  },
): boolean {
  const identity = (side: typeof base) =>
    stableValue({
      config: effectiveJscpdConfig(side.config),
      unsupportedConfig: [
        ...new Set([...(side.unsupportedConfig ?? []), ...unsupportedJscpdConfigKeys(side.config)]),
      ].sort(),
      ignoreFilesComplete: side.ignoreFilesComplete,
      ignoreFiles: [...side.ignoreFiles]
        .map(({ path, contents }) => ({ path, contents }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    })
  return identity(base) !== identity(head)
}
