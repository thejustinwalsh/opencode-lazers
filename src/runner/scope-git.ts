import { gitAsync } from "./artifacts.ts"
import {
  FILE_SIZE_WARNING_LINES,
  TEST_PATH,
  SIZED_SOURCE,
  sizeWarning,
  type ScopeChange,
  type ScopeReport,
} from "./scope.ts"

const SIZE_FILES_LIMIT = 50

/** `git diff` between two commits as classified-ready changes, with line counts. */
export async function collectScopeChanges(
  directory: string,
  base: string,
  head: string,
): Promise<ScopeChange[]> {
  const [status, numstat] = await Promise.all([
    gitAsync(directory, ["diff", "--name-status", "--no-renames", "-z", base, head]),
    gitAsync(directory, ["diff", "--numstat", "--no-renames", "-z", base, head]),
  ])
  const counts = new Map<string, { added: number; removed: number }>()
  for (const row of numstat.split("\0").filter(Boolean)) {
    const [added, removed, ...rest] = row.split("\t")
    const path = rest.join("\t")
    if (path) counts.set(path, { added: Number(added) || 0, removed: Number(removed) || 0 })
  }
  const tokens = status.split("\0").filter(Boolean)
  const changes: ScopeChange[] = []
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const code = tokens[index]![0]
    const path = tokens[index + 1]!
    changes.push({
      path,
      status: code === "A" ? "added" : code === "D" ? "deleted" : "modified",
      ...(counts.get(path) ?? {}),
    })
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path))
}

async function lineCount(directory: string, revision: string, path: string): Promise<number> {
  try {
    const body = await gitAsync(directory, ["show", `${revision}:${path}`])
    return body ? body.split("\n").length : 0
  } catch {
    return 0
  }
}

/** The size signal for the changed source files, measured on the two commits. */
export async function sizeWarnings(
  directory: string,
  base: string,
  head: string,
  changes: readonly ScopeChange[],
): Promise<ScopeReport["warnings"]> {
  const sized = changes
    .filter(
      (change) =>
        change.status !== "deleted" &&
        (change.added ?? 0) > (change.removed ?? 0) &&
        SIZED_SOURCE.test(change.path) &&
        !TEST_PATH.test(change.path),
    )
    .slice(0, SIZE_FILES_LIMIT)
  const warnings: ScopeReport["warnings"] = []
  for (const change of sized) {
    const lines = await lineCount(directory, head, change.path)
    if (lines <= FILE_SIZE_WARNING_LINES) continue
    const baseLines = change.status === "added" ? 0 : await lineCount(directory, base, change.path)
    const warning = sizeWarning({
      path: change.path,
      lines,
      baseLines,
      added: change.added ?? 0,
      removed: change.removed ?? 0,
    })
    if (warning) warnings.push(warning)
  }
  return warnings
}
