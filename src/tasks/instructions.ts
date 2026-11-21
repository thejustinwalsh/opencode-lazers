import type { TaskDetail } from "./contract.ts"
import { TaskProposalSchema } from "../task.ts"
import { workerVerificationSection } from "../projects/profile-guidance.ts"
import type { ActiveProfile } from "../projects/profile-store.ts"
import { taskPersonaInstructions } from "./persona-instructions.ts"

/** Human-readable task instructions for the implementor's readable fetch path. */
export function taskInstructions(detail: TaskDetail, profile?: ActiveProfile): string {
  if (detail.status !== "found") return `Task ${detail.status}.`
  const { task } = detail,
    proposal = task.proposal
  if (detail.disposition?.disposition === "superseded") {
    const successors = detail.disposition.relatedTaskIDs
    const currentContract =
      successors.length === 1
        ? `The supersession record identifies task ${successors[0]} as the replacement. Retrieve it with \`lz-get-task\` using that exact task ID, then follow only the replacement's current objective, acceptance, scope, constraints, and verification. Do not combine this historical contract with the replacement.`
        : successors.length > 1
          ? `The supersession record lists related tasks ${successors.join(", ")}, but does not identify one replacement. Ask the current Architect which task is authoritative before continuing.`
          : "The supersession record does not identify a replacement task. Ask the current Architect for the authoritative contract before continuing."
    return (
      `# Task ${task.id} (${detail.reference}), revision ${task.revision} — superseded history` +
      `\n\nThis immutable task is superseded, not an active implementation contract. Do not treat its objective, Done conditions, write scope, exclusions, constraints, assumptions, guidance, or verification as current obligations.` +
      `\n\n## Current contract\n${currentContract}` +
      `\n\n## Supersession record\n${detail.disposition.reason}` +
      `\nEvidence: ${detail.disposition.evidence.map((item) => item.reference).join("; ")}` +
      `\n\nThe full historical specification remains inspectable with \`lz-get-task\` for taskID \`${task.id}\` and \`format: "structured"\`; use it only as history.`
    )
  }
  const amendment = detail.activity?.findLast((event) => event.event === "SCOPE_AMENDED")
  let amendedScope: string[] = []
  if (amendment) {
    try {
      amendedScope = TaskProposalSchema.shape.writeScope.parse(
        JSON.parse(amendment.payload).writeScope,
      )
    } catch {
      // Malformed historical metadata must not invent an execution authorization.
    }
  }
  const section = (name: string, items: string[]) =>
    items.length ? `\n\n## ${name}\n${items.map((item) => `- ${item}`).join("\n")}` : ""
  const skills = proposal.requirements.skills.map((suggestion) => {
    const line = suggestion.split(/\r?\n/, 1)[0]!.trim()
    const separator = line.indexOf(" — ")
    const name = (separator < 0 ? line : line.slice(0, separator)).slice(0, 120)
    const rawDescription =
      separator < 0
        ? ""
        : line
            .slice(separator + 3)
            .trim()
            .slice(0, 240)
    const description =
      rawDescription || "Description unavailable (legacy suggestion stores only a name)."
    return `${name}: ${description}`
  })
  const advice = detail.advice?.current
  const attachedAdvice = advice
    ? `\n\n## Task-attached advice (advisory, revision ${advice.revision})` +
      section("Research findings", advice.findings) +
      section("Implementation advice", advice.implementationAdvice) +
      section(
        "Optional references",
        advice.references.map(
          (reference) =>
            `${reference.kind}: ${reference.reference}${reference.description ? ` — ${reference.description}` : ""}`,
        ),
      )
    : ""
  return (
    `# Task ${task.id} (${detail.reference}), revision ${task.revision}\n\n${proposal.objective}` +
    taskPersonaInstructions(proposal.persona) +
    (detail.disposition
      ? `\n\n## Disposition\n${detail.disposition.disposition}: ${detail.disposition.reason}\nEvidence: ${detail.disposition.evidence.map((item) => item.reference).join("; ")}`
      : "") +
    section(
      "Done when",
      proposal.acceptance.map(
        (item) =>
          `${item.id}: ${item.assertion}\n  Evidence: ${item.evidence.map((e) => (e.kind === "verification" ? e.verificationID : e.reference)).join("; ")}`,
      ),
    ) +
    section("Write scope", proposal.writeScope) +
    section(
      "Expected new files and folders (create)",
      (proposal.createScope ?? []).map((entry) => `${entry.path} — ${entry.purpose}`),
    ) +
    section("Protected (do not touch)", proposal.protectedScope ?? []) +
    (proposal.createScope?.length || proposal.protectedScope?.length || proposal.writeScope.length
      ? "\n\nScope: Write scope lists the existing files you may edit. New files beside them, or in the expected folders above, are fine; put new behavior in a well-named new file instead of growing a large one. Protected paths are off limits. If you must change an existing file outside the write scope, do it only when necessary and say why in one line in your final message."
      : "") +
    section(
      "Authorized execution scope (additive amendment; specification unchanged)",
      amendedScope,
    ) +
    section("Exclusions", proposal.exclusions) +
    section("Constraints", proposal.constraints) +
    section("Assumptions", proposal.assumptions) +
    (proposal.guidance ? `\n\n## Implementation guidance (advisory)\n${proposal.guidance}` : "") +
    attachedAdvice +
    (detail.auditHistory
      ? `\n\n## Audit history\n${detail.auditHistory.runCount} saved runs; latest ${detail.auditHistory.latestRunID}. Use lz-query-audits with taskID ${task.id}, then lz-get-audit for relevant findings and decisions.`
      : "") +
    section(
      "Verification",
      proposal.verification.map((check) => {
        const timing = (value: number | undefined) =>
          value === undefined
            ? "project default (resolved by runtime at execution)"
            : `${value}ms (authored)`
        const values = [
          `inactivity allowance: ${timing(check.inactivityTimeoutMs)}`,
          `hard backstop: ${timing(check.hardTimeoutMs)}`,
        ]
        if (check.timeoutMs !== undefined)
          values.push(`legacy timeout: ${check.timeoutMs}ms (historical; not used for execution)`)
        return `${check.id}: ${check.command} (${values.join("; ")})`
      }),
    ) +
    (profile
      ? workerVerificationSection(profile)
      : "\n\nRun the project's formatter and linter automatic fixes before these checks, then commit the fixes. Report only failures that remain after automatic fixes.") +
    section(
      "Context references",
      proposal.context.map((ref) =>
        ref.revision ? `${ref.reference} (revision ${ref.revision})` : ref.reference,
      ),
    ) +
    section("Required capabilities", proposal.requirements.capabilities) +
    section("Optional skill suggestions", skills)
  )
}
