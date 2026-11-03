import {
  classifyOwnedProcessObservation,
  type ProcessObservation,
} from "../opencode/owned-launch.ts"
import { canonical, fingerprint } from "../../identity.ts"
import {
  CheckReceiptSchema,
  MaintenanceInspectionSchema,
  MaintenanceRequestSchema,
  type CheckReceipt,
  type GitWorkspaceObservation,
  type MaintenanceBinding,
  type MaintenanceInspection,
  type MaintenanceProcessIdentity,
  type MaintenanceRequest,
  type ManifestEntry,
  type ManifestObservation,
  type ReceiptObservation,
} from "./contract.ts"

export type MaintenanceReaders = {
  git(
    workspace: string,
    artifact: string,
  ): GitWorkspaceObservation | Promise<GitWorkspaceObservation>
  manifest(workspace: string, artifact: string): ManifestObservation | Promise<ManifestObservation>
  receipt(path: string): ReceiptObservation | Promise<ReceiptObservation>
  process(identity: MaintenanceProcessIdentity): ProcessObservation | Promise<ProcessObservation>
}

export type MaintenanceReasonCode =
  | "invalid-request"
  | "invalid-inspection"
  | "project-binding-mismatch"
  | "plan-binding-mismatch"
  | "plan-version-mismatch"
  | "task-binding-mismatch"
  | "snapshot-contradictory"
  | "latest-attempt-mismatch"
  | "attempt-binding-mismatch"
  | "latest-effect-mismatch"
  | "effect-binding-mismatch"
  | "effect-payload-mismatch"
  | "candidate-reader-unavailable"
  | "candidate-root-mismatch"
  | "candidate-head-mismatch"
  | "candidate-dirty"
  | "candidate-unmerged"
  | "candidate-changed-during-inspection"
  | "candidate-snapshot-mismatch"
  | "manifest-reader-unavailable"
  | "candidate-manifest-mismatch"
  | "receipt-reader-unavailable"
  | "receipt-snapshot-unavailable"
  | "receipt-snapshot-changed"
  | "runner-receipt-missing"
  | "runner-receipt-invalid"
  | "runner-receipt-mismatch"
  | "runner-receipt-not-passing"
  | "original-child-identity-missing"
  | "process-observation-unavailable"
  | "process-identity-changed"
  | "original-check-still-live"
  | "original-check-absent"
  | "old-check-containment-unproven"

export type MaintenanceBlocker = {
  code: MaintenanceReasonCode
  missingEvidence?: string
}

export type MaintenancePreflightResult = {
  schemaVersion: 1
  status: "preflight"
  requestID: string | null
  coordinationRequired: true
  containment: "unproven"
  executionPermitted: false
  suppliedSnapshot: {
    snapshotID: string | null
    bindingMatched: boolean
    claimsIgnored: boolean
  }
  candidate: {
    source: "revalidated"
    status: "matches" | "mismatch" | "unavailable" | "not-read"
    workspace: string | null
    head: string | null
    clean: boolean | null
  }
  receipt: {
    source: "revalidated"
    status: "matches" | "missing" | "mismatch" | "unavailable" | "not-read"
  }
  originalChild: {
    source: "revalidated" | "not-supplied"
    status: "matching-live" | "absent" | "identity-changed" | "unavailable" | "not-observed"
  }
  handoff: {
    binding: MaintenanceBinding | null
    nextSteps: Array<{ id: string; action: string }>
  }
  blockers: MaintenanceBlocker[]
  missingEvidence: string[]
}

const handoffSteps = [
  {
    id: "exclusive-window",
    action:
      "Obtain a separately authorized runtime-owned exclusive maintenance window that prevents new dispatch and verification for this resource.",
  },
  {
    id: "contain-old-check",
    action:
      "Within that window, establish positive runtime-owned containment of the old check and its descendants; supplied snapshots, PID match or absence, elapsed time, worker idle, and service stop are insufficient.",
  },
  {
    id: "revalidate-bindings",
    action:
      "While the same window is held, re-read the project, owner, plan version, task revision/node version, latest attempt, uncertain effect, artifact, workspace, and receipt; stop if any binding changed.",
  },
  {
    id: "fresh-runtime-check",
    action:
      "Only after containment and revalidation, separately authorize a fresh check through the runtime's ordinary verification and acceptance gates and retain its new receipt.",
  },
]

const evidenceByReason: Partial<Record<MaintenanceReasonCode, string>> = {
  "runner-receipt-missing": "runner-check-receipt",
  "runner-receipt-invalid": "valid-runner-check-receipt",
  "runner-receipt-mismatch": "receipt-bound-to-requested-check-artifact-and-workspace",
  "original-child-identity-missing": "original-check-process-identity",
  "process-observation-unavailable": "readable-original-check-process-observation",
  "process-identity-changed": "original-check-process-identity-confirmation",
  "original-check-still-live": "runtime-owned-old-check-containment",
  "original-check-absent": "runtime-owned-old-check-containment",
  "old-check-containment-unproven": "exclusive-window-runtime-owned-containment-proof",
}

function resultBase(input?: {
  requestID?: string
  snapshotID?: string
  bindingMatched?: boolean
  claimsIgnored?: boolean
}): MaintenancePreflightResult {
  return {
    schemaVersion: 1,
    status: "preflight",
    requestID: input?.requestID ?? null,
    coordinationRequired: true,
    containment: "unproven",
    executionPermitted: false,
    suppliedSnapshot: {
      snapshotID: input?.snapshotID ?? null,
      bindingMatched: input?.bindingMatched ?? false,
      claimsIgnored: input?.claimsIgnored ?? false,
    },
    candidate: {
      source: "revalidated",
      status: "not-read",
      workspace: null,
      head: null,
      clean: null,
    },
    receipt: { source: "revalidated", status: "not-read" },
    originalChild: { source: "not-supplied", status: "not-observed" },
    handoff: { binding: null, nextSteps: handoffSteps },
    blockers: [],
    missingEvidence: [],
  }
}

function manifestKey(entries: ReadonlyArray<ManifestEntry>): string {
  return JSON.stringify(
    [...entries]
      .map(({ path, mode, type, objectID }) => ({ path, mode, type, objectID }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  )
}

function sameGitObservation(
  left: GitWorkspaceObservation,
  right: GitWorkspaceObservation,
): boolean {
  return canonical(left) === canonical(right)
}

function requestHandoff(binding: MaintenanceBinding): MaintenanceBinding {
  return { ...binding }
}

function validateSnapshots(
  binding: MaintenanceBinding,
  inspection: MaintenanceInspection,
): MaintenanceReasonCode[] {
  const reasons = new Set<MaintenanceReasonCode>()
  const project = inspection.project
  if (project.id !== binding.projectID || project.directory !== binding.projectDirectory)
    reasons.add("project-binding-mismatch")

  if (
    inspection.plan.id !== binding.planID ||
    inspection.plan.projectDirectory !== binding.projectDirectory ||
    inspection.plan.ownerID !== binding.ownerID
  )
    reasons.add("plan-binding-mismatch")
  if (inspection.plan.version !== binding.planVersion) reasons.add("plan-version-mismatch")

  if (
    inspection.task.id !== binding.taskID ||
    inspection.task.revision !== binding.taskRevision ||
    inspection.task.nodeVersion !== binding.nodeVersion
  )
    reasons.add("task-binding-mismatch")

  const attemptsForTask = inspection.attempts.filter((attempt) => attempt.taskID === binding.taskID)
  const attemptNumbers = attemptsForTask.map((attempt) => attempt.number)
  if (new Set(attemptNumbers).size !== attemptNumbers.length) reasons.add("snapshot-contradictory")
  const latestAttempt = [...attemptsForTask].sort((left, right) => right.number - left.number)[0]
  if (
    !latestAttempt ||
    latestAttempt.id !== binding.attemptID ||
    latestAttempt.number !== binding.attemptNumber
  )
    reasons.add("latest-attempt-mismatch")
  if (
    !latestAttempt ||
    latestAttempt.sessionID !== binding.attemptSessionID ||
    latestAttempt.messageID !== binding.attemptMessageID ||
    latestAttempt.planID !== binding.planID ||
    latestAttempt.workspace !== binding.workspace ||
    latestAttempt.artifact !== binding.artifact
  )
    reasons.add("attempt-binding-mismatch")

  const matchingEffects = inspection.effects
    .filter(
      (effect) => effect.attemptID === binding.attemptID && effect.kind === binding.effectKind,
    )
    .sort((left, right) => right.ordinal - left.ordinal)
  const latestEffect = matchingEffects[0]
  const duplicateOrdinals =
    new Set(inspection.effects.map((effect) => effect.ordinal)).size !== inspection.effects.length
  if (duplicateOrdinals) reasons.add("snapshot-contradictory")
  if (!latestEffect || latestEffect.id !== binding.effectID) reasons.add("latest-effect-mismatch")
  if (
    !latestEffect ||
    latestEffect.id !== binding.effectID ||
    latestEffect.planID !== binding.planID ||
    latestEffect.taskID !== binding.taskID ||
    latestEffect.attemptID !== binding.attemptID ||
    latestEffect.kind !== binding.effectKind ||
    latestEffect.state !== binding.effectState
  )
    reasons.add("effect-binding-mismatch")

  if (latestEffect) {
    try {
      const payload: unknown = JSON.parse(latestEffect.payload)
      if (
        latestEffect.id !==
        fingerprint({
          planID: latestEffect.planID,
          taskID: latestEffect.taskID,
          attemptID: latestEffect.attemptID,
          kind: latestEffect.kind,
          payload,
        })
      )
        reasons.add("effect-payload-mismatch")
      const check =
        typeof payload === "object" && payload !== null && "check" in payload
          ? payload.check
          : undefined
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("workspace" in payload) ||
        payload.workspace !== binding.workspace ||
        !("artifact" in payload) ||
        payload.artifact !== binding.artifact ||
        !("identity" in payload) ||
        payload.identity !== binding.inputIdentity ||
        !("receiptPath" in payload) ||
        payload.receiptPath !== binding.receiptPath ||
        typeof check !== "object" ||
        check === null ||
        !("id" in check) ||
        check.id !== binding.checkID ||
        !("command" in check) ||
        check.command !== binding.command ||
        !("timeoutMs" in check) ||
        check.timeoutMs !== binding.timeoutMs
      )
        reasons.add("effect-payload-mismatch")
    } catch {
      reasons.add("effect-payload-mismatch")
    }
  }

  if (
    inspection.candidate.workspace !== binding.workspace ||
    inspection.candidate.head !== binding.artifact ||
    inspection.candidate.clean !== true ||
    inspection.candidate.unmerged !== false
  )
    reasons.add("candidate-snapshot-mismatch")
  if (inspection.task.artifact !== binding.artifact) reasons.add("task-binding-mismatch")

  return [...reasons].sort()
}

function receiptMatches(receipt: CheckReceipt, binding: MaintenanceBinding): boolean {
  return (
    receipt.id === binding.checkID &&
    receipt.command === binding.command &&
    receipt.cwd === binding.workspace &&
    receipt.artifact === binding.artifact &&
    receipt.inputIdentity === binding.inputIdentity &&
    receipt.endedAt >= receipt.startedAt
  )
}

/**
 * Evaluate a supplied offline inspection and revalidate only read-only candidate,
 * manifest, receipt, and optional process identity evidence. This function has
 * no runtime/database handle and never grants execution authority.
 */
export async function evaluateMaintenancePreflight(
  requestInput: unknown,
  inspectionInput: unknown,
  readers: MaintenanceReaders,
): Promise<MaintenancePreflightResult> {
  const requestResult = MaintenanceRequestSchema.safeParse(requestInput)
  if (!requestResult.success) {
    const result = resultBase()
    result.blockers.push({ code: "invalid-request" })
    return result
  }
  const request = requestResult.data satisfies MaintenanceRequest
  const inspectionResult = MaintenanceInspectionSchema.safeParse(inspectionInput)
  if (!inspectionResult.success) {
    const result = resultBase({ requestID: request.requestID })
    result.handoff.binding = requestHandoff(request.binding)
    result.blockers.push({ code: "invalid-inspection" })
    result.missingEvidence.push("valid-bound-inspection-snapshot")
    return result
  }
  const inspection = inspectionResult.data satisfies MaintenanceInspection
  const snapshotReasons = validateSnapshots(request.binding, inspection)
  const bindingMatched = snapshotReasons.length === 0
  const result = resultBase({
    requestID: request.requestID,
    snapshotID: inspection.snapshotID,
    bindingMatched,
    claimsIgnored: inspection.claims !== undefined,
  })
  result.handoff.binding = requestHandoff(request.binding)

  const reasons = new Set<MaintenanceReasonCode>(snapshotReasons)
  const add = (code: MaintenanceReasonCode) => reasons.add(code)

  let before: GitWorkspaceObservation
  let after: GitWorkspaceObservation
  try {
    before = await readers.git(request.binding.workspace, request.binding.artifact)
  } catch {
    before = { kind: "unavailable" }
  }
  let manifest: ManifestObservation
  try {
    manifest = await readers.manifest(request.binding.workspace, request.binding.artifact)
  } catch {
    manifest = { kind: "unavailable" }
  }
  let receiptObservation: ReceiptObservation
  try {
    receiptObservation = await readers.receipt(request.binding.receiptPath)
  } catch {
    receiptObservation = { kind: "unavailable" }
  }
  try {
    after = await readers.git(request.binding.workspace, request.binding.artifact)
  } catch {
    after = { kind: "unavailable" }
  }

  if (before.kind === "unavailable" || after.kind === "unavailable") {
    result.candidate.status = "unavailable"
    add("candidate-reader-unavailable")
  } else {
    result.candidate.workspace = after.root
    result.candidate.head = after.head
    result.candidate.clean = after.clean
    if (!sameGitObservation(before, after)) add("candidate-changed-during-inspection")
    if (after.root !== request.binding.workspace) add("candidate-root-mismatch")
    if (after.head !== request.binding.artifact) add("candidate-head-mismatch")
    if (!after.clean) add("candidate-dirty")
    if (after.unmerged) add("candidate-unmerged")
    if (manifest.kind === "unavailable") {
      result.candidate.status = "unavailable"
      add("manifest-reader-unavailable")
    } else {
      const sameManifest =
        manifestKey(manifest.entries) === manifestKey(inspection.candidate.manifest)
      if (!sameManifest) add("candidate-manifest-mismatch")
      result.candidate.status =
        after.root === request.binding.workspace &&
        after.head === request.binding.artifact &&
        after.clean &&
        !after.unmerged &&
        sameManifest &&
        sameGitObservation(before, after)
          ? "matches"
          : "mismatch"
    }
  }

  if (receiptObservation.kind === "unavailable") {
    result.receipt.status = "unavailable"
    add("receipt-reader-unavailable")
  } else if (inspection.receipt.status === "unavailable") {
    result.receipt.status = receiptObservation.kind === "missing" ? "missing" : "mismatch"
    add("receipt-snapshot-unavailable")
    if (receiptObservation.kind === "missing") add("runner-receipt-missing")
  } else if (
    (inspection.receipt.status === "missing" && receiptObservation.kind !== "missing") ||
    (inspection.receipt.status === "present" && receiptObservation.kind !== "present")
  ) {
    result.receipt.status = "mismatch"
    add("receipt-snapshot-changed")
    if (receiptObservation.kind === "missing") add("runner-receipt-missing")
  } else if (receiptObservation.kind === "missing") {
    result.receipt.status = "missing"
    add("runner-receipt-missing")
  } else if (inspection.receipt.status === "present") {
    const actualReceiptResult = CheckReceiptSchema.safeParse(receiptObservation.receipt)
    const snapshotReceiptResult = CheckReceiptSchema.safeParse(inspection.receipt.receipt)
    if (!actualReceiptResult.success || !snapshotReceiptResult.success) {
      result.receipt.status = "mismatch"
      add("runner-receipt-invalid")
    } else {
      const actualReceipt = actualReceiptResult.data
      const snapshotReceipt = snapshotReceiptResult.data
      if (canonical(actualReceipt) !== canonical(snapshotReceipt)) {
        result.receipt.status = "mismatch"
        add("receipt-snapshot-changed")
      } else if (!receiptMatches(actualReceipt, request.binding)) {
        result.receipt.status = "mismatch"
        add("runner-receipt-mismatch")
      } else if (
        actualReceipt.exitCode !== 0 ||
        actualReceipt.timedOut ||
        !actualReceipt.unchanged
      ) {
        result.receipt.status = "mismatch"
        add("runner-receipt-not-passing")
      } else {
        result.receipt.status = "matches"
      }
    }
  }

  if (request.originalChild === null) {
    result.originalChild = { source: "not-supplied", status: "not-observed" }
    add("original-child-identity-missing")
  } else {
    result.originalChild = { source: "revalidated", status: "unavailable" }
    let observation: ProcessObservation
    try {
      observation = await readers.process(request.originalChild)
    } catch {
      observation = { kind: "observation-unavailable", reason: "probe-error" }
    }
    const classified = classifyOwnedProcessObservation(request.originalChild, observation)
    switch (classified.kind) {
      case "matching-live":
        result.originalChild.status = "matching-live"
        add("original-check-still-live")
        break
      case "authoritatively-absent":
        result.originalChild.status = "absent"
        add("original-check-absent")
        break
      case "identity-changed":
        result.originalChild.status = "identity-changed"
        add("process-identity-changed")
        break
      case "observation-unavailable":
        result.originalChild.status = "unavailable"
        add("process-observation-unavailable")
        break
    }
  }

  // A process sample, including absence, cannot prove that the old process tree
  // is contained. Containment needs a separately authorized runtime-owned window.
  add("old-check-containment-unproven")
  result.blockers = [...reasons].sort().map((code) => ({
    code,
    ...(evidenceByReason[code] ? { missingEvidence: evidenceByReason[code] } : {}),
  }))
  const missingEvidence = new Set<string>([
    ...result.blockers.flatMap((blocker) =>
      blocker.missingEvidence ? [blocker.missingEvidence] : [],
    ),
    "fresh-runtime-owned-check-receipt",
  ])
  result.missingEvidence = [...missingEvidence].sort()
  return result
}
