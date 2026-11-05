import type { TaskDetail } from "./contract.ts"
import { TaskProposalSchema } from "../task.ts"

/** Human-readable task instructions for the implementor's readable fetch path. */
export function taskInstructions(detail: TaskDetail): string {
  if (detail.status !== "found") return `Task ${detail.status}.`
  const { task } = detail,
    proposal = task.proposal
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
    ? `\n\n## Task-attached advice (advisory, revision ${advice.revision})\n` +
      `Recorded by ${advice.provenance.agent} in session ${advice.provenance.sessionID} at ${advice.provenance.createdAt}. This does not change approved requirements, acceptance, or scope.` +
      section("Research findings", advice.findings) +
      section("Implementation advice", advice.implementationAdvice) +
      section(
        "Optional references (not retrieved)",
        advice.references.map(
          (reference) =>
            `${reference.kind}: ${reference.reference}${reference.description ? ` — ${reference.description}` : ""}`,
        ),
      )
    : ""
  return (
    `# Task ${task.id} (${detail.reference}), revision ${task.revision}\n\n${proposal.objective}` +
    (detail.disposition
      ? `\n\n## Disposition\n${detail.disposition.disposition}: ${detail.disposition.reason}\nEvidence: ${detail.disposition.evidence.map((item) => item.reference).join("; ")}`
      : "") +
    section(
      "Done when",
      proposal.acceptance.map(
        (item) =>
          `${item.id}: ${item.assertion}\n  Evidence: ${item.evidence.map((e) => (e.kind === "verification" ? e.verificationID : e.kind === "artifact" ? e.reference : e.decision)).join("; ")}`,
      ),
    ) +
    section("Write scope", proposal.writeScope) +
    section(
      "Authorized execution scope (additive amendment; specification unchanged)",
      amendedScope,
    ) +
    section("Exclusions", proposal.exclusions) +
    section("Constraints", proposal.constraints) +
    section("Assumptions", proposal.assumptions) +
    (proposal.guidance ? `\n\n## Implementation guidance (advisory)\n${proposal.guidance}` : "") +
    attachedAdvice +
    section(
      "Verification",
      proposal.verification.map(
        (check) => `${check.id}: ${check.command} (timeout ${check.timeoutMs}ms)`,
      ),
    ) +
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
