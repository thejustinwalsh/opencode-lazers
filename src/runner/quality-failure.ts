import type { ProfileCommands } from "../projects/profile-runtime.ts"

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
  if (/^bun run(?: --silent)? [A-Za-z0-9][A-Za-z0-9._:-]*$/.test(command)) return true
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

/** An option token of a profile command: a flag with no shell metacharacter. */
const safeFlag = (value: string) => /^-[A-Za-z0-9_=.,:@+/-]*$/.test(value)

/**
 * With a profile, a step is recognised when it is a profile `verify`/`fix` command, such a
 * command followed by safe flags and file targets, or (when `bun` is declared) a Bun step.
 */
function profileStep(command: string, profile: ProfileCommands): boolean {
  const known = [...profile.verify, ...profile.fix]
  if (known.includes(command)) return true
  for (const prefix of known) {
    if (!command.startsWith(`${prefix} `)) continue
    const rest = command.slice(prefix.length + 1)
    if (rest.split(" ").every((token) => safeFlag(token) || safeTarget(token))) return true
  }
  return profile.toolchains.includes("bun") && recognizedStep(command)
}

/** Preserve simple declared sequencing, not a baseline comparison/classification gate.
 * A previous draft's baseline execution and environment-equality machinery is
 * intentionally not retained: command outcomes apply to the authorized candidate.
 */
export function recognizedVerificationPhases(
  command: string,
  profile?: ProfileCommands,
): string[] | undefined {
  const phases = command.split(" && ")
  const recognised = profile
    ? (phase: string) => profileStep(phase, profile)
    : (phase: string) => recognizedStep(phase)
  if (phases.length === 0 || phases.some((phase) => !recognised(phase))) return undefined
  return phases
}

export function needsMechanicalQualityPreparation(
  commands: string[],
  profile?: ProfileCommands & { runnableFix: number },
): boolean {
  if (profile)
    return (
      profile.runnableFix > 0 &&
      commands.some((command) => recognizedVerificationPhases(command, profile) !== undefined)
    )
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
