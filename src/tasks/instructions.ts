import type { TaskDetail } from "./contract.ts"

/** Human-readable task instructions; the tool's output retains the typed record. */
export function taskInstructions(detail: TaskDetail): string {
  if (detail.status !== "found") return `Task ${detail.status}.`
  const { task } = detail,
    proposal = task.proposal
  const section = (name: string, items: string[]) =>
    items.length ? `\n\n## ${name}\n${items.map((item) => `- ${item}`).join("\n")}` : ""
  return (
    `# Task ${task.id}, revision ${task.revision}\n\n${proposal.objective}` +
    section("Write scope", proposal.writeScope) +
    section("Exclusions", proposal.exclusions) +
    section("Constraints", proposal.constraints) +
    section("Assumptions", proposal.assumptions) +
    section(
      "Done when",
      proposal.acceptance.map(
        (item) =>
          `${item.id}: ${item.assertion}\n  Evidence: ${item.evidence.map((e) => (e.kind === "verification" ? e.verificationID : e.kind === "artifact" ? e.reference : e.decision)).join("; ")}`,
      ),
    ) +
    section(
      "Verification",
      proposal.verification.map(
        (check) => `${check.id}: ${check.command} (timeout ${check.timeoutMs}ms)`,
      ),
    ) +
    section(
      "Context references",
      proposal.context.map((ref) => ref.reference),
    ) +
    section("Required capabilities", proposal.requirements.capabilities) +
    section("Required skills", proposal.requirements.skills) +
    `\n\nRisk: ${proposal.requirements.risk}. Policy: ${proposal.requirements.policyReference}.`
  )
}
