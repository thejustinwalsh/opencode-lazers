export type FixStep = { index: number; command: string; paths: string[] }

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

/**
 * The mechanical fix chain of a profile: each `fix` entry in profile order, run on the changed
 * paths its `files` globs select (all of them when it has none), the paths appended as quoted
 * arguments. An entry with no matching path is omitted. The steps are joined with `&&`, so the
 * shell stops at the first failure. Paths come from git, so they always use `/`.
 */
export function profileFixChain(
  fix: readonly { index: number; command: string; files?: readonly string[] }[],
  paths: readonly string[],
): { command: string; steps: FixStep[] } | undefined {
  const steps: FixStep[] = []
  for (const entry of fix) {
    const selected = entry.files
      ? paths.filter((path) => entry.files!.some((glob) => new Bun.Glob(glob).match(path)))
      : [...paths]
    if (selected.length > 0)
      steps.push({ index: entry.index, command: entry.command, paths: selected })
  }
  if (steps.length === 0) return undefined
  return {
    command: steps.map((step) => `${step.command} ${step.paths.map(quote).join(" ")}`).join(" && "),
    steps,
  }
}
