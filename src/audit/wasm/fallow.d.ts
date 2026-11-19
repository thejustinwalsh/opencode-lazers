/* tslint:disable */
/* eslint-disable */

export class Project {
  free(): void
  [Symbol.dispose](): void
  /**
   * Functions over the configured complexity thresholds in `paths` (all files
   * when empty), worst first.
   */
  complexity(paths: string[]): string
  /**
   * Clone groups of the full run. With `changed` non-empty, only the groups that touch a
   * changed path are reported, exactly as the full run groups them.
   */
  duplication(changed: string[], options_json: string): string
  /**
   * Feature-flag uses the extractor recognises: environment variables with a
   * flag prefix, SDK calls and config-object reads. `paths` limits the files
   * (all files when empty).
   */
  featureFlags(paths: string[]): string
  /**
   * Number of analysable files after extension and ignore filtering.
   */
  fileCount(): number
  /**
   * `paths` are relative to `root` and parallel to `contents`. `config_name`
   * selects the dialect by extension (`.json`, `.jsonc`, otherwise TOML).
   */
  constructor(
    root: string,
    paths: string[],
    contents: string[],
    config_name: string,
    config_text: string,
  )
}

/**
 * Per-function cyclomatic and cognitive complexity for one file, as JSON.
 */
export function complexity(path: string, content: string): string

/**
 * Record a panic message before the abort so the host can read it after the
 * resulting `RuntimeError: unreachable`. No host import is involved.
 */
export function install_panic_hook(): void

/**
 * The message of the last panic, or an empty string.
 */
export function lastPanic(): string

/**
 * Parse one file and return a JSON summary of its imports and exports.
 */
export function parse(path: string, content: string): string

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module

export interface InitOutput {
  readonly memory: WebAssembly.Memory
  readonly __getrandom_v03_custom: (a: number, b: number) => number
  readonly __wbg_project_free: (a: number, b: number) => void
  readonly complexity: (a: number, b: number, c: number, d: number) => [number, number]
  readonly install_panic_hook: () => void
  readonly lastPanic: () => [number, number]
  readonly parse: (a: number, b: number, c: number, d: number) => [number, number]
  readonly project_complexity: (a: number, b: number, c: number) => [number, number]
  readonly project_duplication: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
  ) => [number, number]
  readonly project_featureFlags: (a: number, b: number, c: number) => [number, number]
  readonly project_fileCount: (a: number) => number
  readonly project_new: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
    i: number,
    j: number,
  ) => number
  readonly __wbindgen_malloc: (a: number, b: number) => number
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number
  readonly __wbindgen_free: (a: number, b: number, c: number) => void
  readonly __wbindgen_externrefs: WebAssembly.Table
  readonly __externref_table_alloc: () => number
  readonly __externref_drop_slice: (a: number, b: number) => void
  readonly __wbindgen_start: () => void
}

export type SyncInitInput = BufferSource | WebAssembly.Module

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init(
  module_or_path?:
    { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>,
): Promise<InitOutput>
