import type { JsonObject, HandoffReviewCheck } from "./schema.ts"

export const HANDOFF_REVIEW_VERSION = "recovery-handoff-checks-v1"

export interface HandoffReviewDefinition {
  id: string
  path: string
  question: string
  guidance: string
  goodWhen: "yes"
}

export const handoffReviewDefinitions: readonly HandoffReviewDefinition[] = [
  {
    id: "preserve-target",
    path: "target",
    question:
      "Does the handoff preserve the source task's authorized outcome and current contract, while distinguishing original user intent from the worker's interpretation?",
    guidance:
      "Keep the source task outcome, acceptance and applicable recorded decisions intact. Distinguish the original user intent from the worker's interpretation; keep original intent explicitly unknown when no source reference establishes it.",
    goodWhen: "yes",
  },
  {
    id: "observed-failure",
    path: "failure",
    question:
      "Does the handoff describe the observed failed behavior or blocker and distinguish it from an unproven cause?",
    guidance:
      "State the observed behavior and supporting evidence. Keep the cause explicitly unknown unless evidence establishes it; do not turn a hypothesis into a fact.",
    goodWhen: "yes",
  },
  {
    id: "approach-results",
    path: "approaches",
    question:
      "Are attempted approaches and their observed results stated clearly and supported by relevant evidence without requiring hidden reasoning or a transcript dump?",
    guidance:
      "Summarize what was attempted, what happened, and the evidence. Remove unsupported conclusions and do not include hidden reasoning or a transcript dump.",
    goodWhen: "yes",
  },
  {
    id: "assumption-status",
    path: "assumptions",
    question:
      "Are assumptions identified with supported, contradicted, or unknown status and evidence, without presenting an unresolved assumption as established?",
    guidance:
      "Keep unsupported assumptions explicitly unresolved and associate evidence that supports or contradicts each claim.",
    goodWhen: "yes",
  },
  {
    id: "evidence-quality",
    path: "evidence",
    question:
      "Does the handoff point to specific evidence that can substantiate its important failure, progress, and recovery claims?",
    guidance:
      "Add precise artifact, verification, task, trajectory, or message references for important claims. Fluent prose is not evidence.",
    goodWhen: "yes",
  },
  {
    id: "partial-work",
    path: "completedWork,partialWork,workspaceState",
    question:
      "Does the handoff account for useful completed and partial work and accurately state the workspace condition with supporting evidence?",
    guidance:
      "Separate completed from unfinished work, retain useful partial changes, and state workspace condition and evidence without implying unobserved commits or artifacts.",
    goodWhen: "yes",
  },
  {
    id: "preserve-obligations",
    path: "preservedObligations",
    question:
      "Does the handoff retain the still-valid source requirements, constraints, acceptance obligations, and pending checks without weakening them?",
    guidance:
      "Retain each still-valid source obligation and its reference, including acceptance checks that remain necessary. Do not weaken or silently replace the task contract.",
    goodWhen: "yes",
  },
  {
    id: "next-actions-decisions",
    path: "remainingWork,remainingDecisions",
    question:
      "Does the handoff identify actionable remaining work and material decisions without inventing a human answer or escalating routine repair?",
    guidance:
      "Name the next useful investigation or correction and only identify a human decision when it would change behavior, scope, acceptance, or authorization. Keep unanswered decisions unknown.",
    goodWhen: "yes",
  },
  {
    id: "ownership-unknowns",
    path: "reportedOwnership",
    question:
      "Does the handoff distinguish reported writer/background/native activity from runtime proof, keeping ownership or quiescence unknown when it is not independently established?",
    guidance:
      "Keep missing writer, background activity, native effects, and quiescence evidence explicitly unknown. A worker's report that it stopped is not runtime proof of quiescence.",
    goodWhen: "yes",
  },
]

export function handoffReviewChecks(): HandoffReviewCheck[] {
  return handoffReviewDefinitions.map((check) => ({
    id: check.id,
    definition: {
      path: check.path,
      question: check.question,
      guidance: check.guidance,
      goodWhen: check.goodWhen,
    } satisfies JsonObject,
  }))
}
