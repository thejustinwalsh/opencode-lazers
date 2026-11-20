/**
 * The only module that knows how `bun test` spells its per-test timeout. A per-project
 * verification profile will supply other runners' equivalents here; callers only ask for the
 * effective command.
 *
 * Bun's per-test timeout defaults to 5 s. On this Bun (1.4.4-canary) nothing but the command-line
 * flag applies to every test file in a run: `setDefaultTimeout` from a preload or a shared import
 * reaches the first file only, and neither `bunfig.toml` keys nor environment variables exist. So
 * the flag is added to the command itself.
 */

/**
 * Per-test timeout for `bun test` runs. A hang guard, never a performance budget: git-heavy tests
 * measured 5.2 to 6.5 s under load and a 5 s limit failed correct work. It sits far above any
 * honest run, and the check's own inactivity and hard backstops still bound the whole command.
 */
export const TEST_HANG_GUARD_MS = 120_000

/** The command contributors and workers type to run tests with the guard. */
export const GUARDED_TEST_COMMAND = `bun test --timeout ${TEST_HANG_GUARD_MS}`

const separator = /(\s*(?:&&|\|\||;)\s*)/
const bunTest = /^(\s*)bun test(?=\s|$)/
const explicitTimeout = /(?:^|\s)--timeout(?:=|\s|$)/

/**
 * Add the hang guard to every `bun test` segment of a shell command (segments split on `&&`, `||`
 * and `;`) that does not already carry `--timeout`. An author's explicit value always wins, and
 * non-Bun commands are returned unchanged. The flag goes right after `bun test` so trailing
 * redirects or pipes are untouched. Returns the original string when nothing changes.
 */
export function withTestHangGuard(command: string): string {
  return command
    .split(separator)
    .map((part, index) => {
      if (index % 2 === 1) return part
      if (!bunTest.test(part) || explicitTimeout.test(part)) return part
      return part.replace(bunTest, `$1bun test --timeout ${TEST_HANG_GUARD_MS}`)
    })
    .join("")
}
