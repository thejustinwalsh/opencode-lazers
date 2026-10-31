import { createHash } from "node:crypto"
import type { TaskProposal } from "../task.ts"
import type { SystemOneQuestion } from "./system-one.ts"

export const REVIEW_VERSION = "task-hardening-v2"
export const REVIEW_ROUNDS = 3
export const REVIEW_THRESHOLD = 0.7

export interface ReviewCheck {
  id: string
  family: "coverage" | "verification" | "conflicts" | "assumptions" | "scope"
  path: string
  question: string
  goodWhen: "yes" | "no"
  guidance: string
  appliesWhen?: "cancellation_requested" | "performance_requested"
}

/** Question text stays here. Each judgment has its own answer and corrective instruction. */
export function reviewChecks(task: TaskProposal): ReviewCheck[] {
  const checks: ReviewCheck[] = []
  const add = (check: Omit<ReviewCheck, "id">) => {
    const id = "q_" + createHash("sha256").update(JSON.stringify(check)).digest("hex").slice(0, 16)
    checks.push({ id, ...check })
  }
  add({
    family: "coverage",
    path: "acceptance",
    goodWhen: "yes",
    question: "Does task.acceptance explicitly cover the behavior requested in intent.request?",
    guidance:
      "Compare each requested behavior with acceptance. Add the missing assertion; ask a focused question if the intended behavior is unclear.",
  })
  add({
    family: "scope",
    path: "constraints",
    goodWhen: "no",
    question:
      "Does the task impose requirements unsupported by the recorded intent, repository contracts or evidence?",
    guidance:
      "Remove unsupported requirements. Keep useful implementation suggestions as advisory guidance rather than obligations.",
  })
  add({
    family: "scope",
    path: "constraints",
    goodWhen: "no",
    question:
      "Does the task repeat instructions that can be removed without changing its required behavior, boundaries or verification?",
    guidance:
      "Remove repetition while preserving necessary requirements and useful code-grounded advice. Do not replace it with a length limit.",
  })
  add({
    family: "coverage",
    path: "acceptance",
    goodWhen: "yes",
    appliesWhen: "cancellation_requested",
    question: "Does task.acceptance explicitly cover cancellation?",
    guidance:
      "Specify the observable cancellation outcome in acceptance, or clarify what cancellation should do.",
  })
  add({
    family: "coverage",
    path: "acceptance",
    goodWhen: "yes",
    appliesWhen: "performance_requested",
    question: "Does task.acceptance state a measurable performance target?",
    guidance:
      "State the requested measurable performance target. Ask the user for a target if choosing it would invent a requirement.",
  })
  for (const assertion of task.acceptance) {
    add({
      family: "verification",
      path: `acceptance.${assertion.id}`,
      goodWhen: "no",
      question: `Could the proposed verification pass while this assertion is false: ${JSON.stringify(assertion.assertion)}?`,
      guidance: `Harden verification for acceptance ${assertion.id}: name a check that would fail for a plausible broken implementation. Supply the test procedure or source in evidence when a command alone cannot show coverage.`,
    })
  }
  for (const [index, exclusion] of task.exclusions.entries()) {
    add({
      family: "conflicts",
      path: `exclusions.${index}`,
      goodWhen: "no",
      question: `Does implementing task.objective conflict with this exclusion: ${JSON.stringify(exclusion)}?`,
      guidance:
        "Resolve this objective/exclusion conflict. Clarify intent when changing either side would change the authorized scope.",
    })
  }
  for (const [index, constraint] of task.constraints.entries()) {
    add({
      family: "conflicts",
      path: `constraints.${index}`,
      goodWhen: "no",
      question: `Does implementing task.objective conflict with this constraint: ${JSON.stringify(constraint)}?`,
      guidance:
        "Reconcile the objective with this constraint using the recorded intent and repository evidence.",
    })
  }
  for (const [index, assumption] of task.assumptions.entries()) {
    add({
      family: "assumptions",
      path: `assumptions.${index}`,
      goodWhen: "yes",
      question: `Does the recorded intent or evidence establish this assumption: ${JSON.stringify(assumption)}?`,
      guidance:
        "Verify this assumption from evidence or clarify it. Keep unverified assumptions explicit instead of presenting them as established facts.",
    })
  }
  for (const assertion of task.acceptance) {
    add({
      family: "scope",
      path: `acceptance.${assertion.id}`,
      goodWhen: "no",
      question: `Does delivering this assertion require work outside task.writeScope: ${JSON.stringify(assertion.assertion)}?`,
      guidance: `Check the permitted paths against work needed for acceptance ${assertion.id}. Supply relevant repository facts in evidence; clarify scope if the needed work is unauthorized.`,
    })
  }
  return checks
}

export function reviewQuestions(checks: readonly ReviewCheck[]): Record<string, SystemOneQuestion> {
  return {
    cancellation_requested: {
      type: "noul",
      instructions: "Does intent.request ask for cancellation behavior?",
    },
    performance_requested: {
      type: "noul",
      instructions: "Does intent.request ask for improved execution speed?",
    },
    ...Object.fromEntries(
      checks.map((check) => [check.id, { type: "noul" as const, instructions: check.question }]),
    ),
  }
}
