const qualitySteps = new Set([
  "bun fmt",
  "bun fmt --check",
  "bun lint --fix",
  "bun lint",
  "bun check",
  "git diff --check",
])

const safeTarget = (value: string) =>
  /^(?:[A-Za-z0-9_@.-]+\/)*[A-Za-z0-9_@.-]+$/.test(value) &&
  !value.split("/").some((part) => part === "." || part === "..")

function recognizedStep(command: string): boolean {
  if (qualitySteps.has(command)) return true
  if (/^bun run [A-Za-z0-9][A-Za-z0-9._:-]*$/.test(command)) return true
  const scopedFormat = /^bun fmt(?: --check)? (.+)$/.exec(command)
  if (scopedFormat) return scopedFormat[1]!.split(" ").every(safeTarget)
  const tests = /^bun test(?: (.+))?$/.exec(command)
  if (tests)
    return (
      !tests[1] ||
      tests[1].split(" ").every((target) => target.startsWith("-") || safeTarget(target))
    )
  return false
}

/** Preserve simple declared sequencing, not a baseline comparison/classification gate.
 * A previous draft's baseline execution and environment-equality machinery is
 * intentionally not retained: command outcomes apply to the authorized candidate.
 */
export function recognizedVerificationPhases(command: string): string[] | undefined {
  const phases = command.split(" && ")
  if (phases.length === 0 || phases.some((phase) => !recognizedStep(phase))) return undefined
  return phases
}

export function needsMechanicalQualityPreparation(commands: string[]): boolean {
  return commands.some((command) => {
    const phases = recognizedVerificationPhases(command)
    return Boolean(
      phases?.some(
        (phase) =>
          qualitySteps.has(phase) ||
          phase === "bun run verify" ||
          phase.startsWith("bun fmt --check"),
      ),
    )
  })
}
