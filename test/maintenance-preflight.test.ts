import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fingerprint } from "../src/identity.ts"
import { verificationEnvironmentIdentity } from "../src/runner/artifacts.ts"
import type { ProcessObservation } from "../src/verification/opencode/owned-launch.ts"
import type {
  MaintenanceInspection,
  MaintenanceRequest,
} from "../src/verification/maintenance/contract.ts"
import {
  evaluateMaintenancePreflight,
  type MaintenanceReasonCode,
  type MaintenanceReaders,
} from "../src/verification/maintenance/preflight.ts"

const artifact = "e6a58ea5b1c1c0fd687983d257f48a2cf48e7f55"
const planID = "11111111-1111-4111-8111-111111111111"
const taskID = "22222222-2222-4222-8222-222222222222"
const attemptID = "33333333-3333-4333-8333-333333333333"
const projectDirectory = "/project/lazers"
const workspace = "/runner/worktrees/lz72-attempt"
const receiptPath = `/runtime/receipts/${attemptID}/runner-${artifact}.json`
const command = "touch /tmp/maintenance-check-must-not-run"
const effectKind = "verify:runner"
const effectPayload = {
  check: { id: "runner", command, timeoutMs: 120_000 },
  workspace,
  artifact,
  identity: artifact,
  receiptPath,
}
const productionPathForLongIdentity = [
  process.env.PATH ?? "",
  ...Array.from({ length: 64 }, (_, index) => `/runner/toolchain/bin-${index}`),
]
  .filter(Boolean)
  .join(":")
const effectID = fingerprint({
  planID,
  taskID,
  attemptID,
  kind: effectKind,
  payload: effectPayload,
})
const productionEnvironmentIdentity = (() => {
  const originalPath = process.env.PATH
  try {
    process.env.PATH = productionPathForLongIdentity
    return verificationEnvironmentIdentity()
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
  }
})()

type Fixture = { request: MaintenanceRequest; inspection: MaintenanceInspection }

function fixture(): Fixture {
  const binding: MaintenanceRequest["binding"] = {
    projectID: "project-lz72",
    projectDirectory,
    ownerID: "architect-session",
    planID,
    planVersion: 14,
    taskID,
    taskRevision: 1,
    nodeVersion: 9,
    attemptID,
    attemptNumber: 1,
    attemptSessionID: "worker-session",
    attemptMessageID: "assigned-message",
    effectID,
    effectKind,
    effectState: "uncertain",
    artifact,
    workspace,
    checkID: "runner",
    command,
    timeoutMs: 120_000,
    inputIdentity: artifact,
    receiptPath,
  }
  return {
    request: {
      schemaVersion: 1,
      requestID: "lz72-verify-runner-preflight",
      binding,
      originalChild: null,
    },
    inspection: {
      schemaVersion: 1,
      snapshotID: "inspection-lz72",
      capturedAt: 1_793_735_000_000,
      project: { id: binding.projectID, directory: projectDirectory },
      plan: {
        id: planID,
        projectDirectory,
        ownerID: binding.ownerID,
        version: binding.planVersion,
      },
      task: {
        id: taskID,
        revision: binding.taskRevision,
        nodeVersion: binding.nodeVersion,
        state: "running",
        artifact,
      },
      attempts: [
        {
          id: attemptID,
          planID,
          taskID,
          number: 1,
          sessionID: binding.attemptSessionID,
          messageID: binding.attemptMessageID,
          workspace,
          artifact,
          state: "verifying",
        },
      ],
      effects: [
        {
          ordinal: 1,
          id: effectID,
          planID,
          taskID,
          attemptID,
          kind: effectKind,
          state: "uncertain",
          payload: JSON.stringify(effectPayload),
          receipt: null,
        },
      ],
      candidate: { workspace, head: artifact, clean: true, unmerged: false },
      receipt: { status: "missing" },
      claims: { ready: true, containmentProven: true, executionPermitted: true },
    },
  } satisfies Fixture
}

function readers(overrides: Partial<MaintenanceReaders> = {}): MaintenanceReaders {
  const base: MaintenanceReaders = {
    git: () => ({
      kind: "observed",
      root: workspace,
      head: artifact,
      clean: true,
      unmerged: false,
    }),
    receipt: () => ({ kind: "missing" }),
    process: () => ({ kind: "authoritatively-absent" }),
  }
  return { ...base, ...overrides }
}

function codes(result: Awaited<ReturnType<typeof evaluateMaintenancePreflight>>) {
  return result.blockers.map((blocker) => blocker.code)
}

function receiptSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: "runner",
    command,
    cwd: workspace,
    artifact,
    inputIdentity: artifact,
    environmentIdentity: productionEnvironmentIdentity,
    startedAt: 100,
    endedAt: 200,
    exitCode: 0,
    timedOut: false,
    stdout: "",
    stderr: "",
    unchanged: true,
    ...overrides,
  }
}

function bindRunnerEffect(value: Fixture) {
  const effect = value.inspection.effects[0]!
  effect.id = fingerprint({
    planID: effect.planID,
    taskID: effect.taskID,
    attemptID: effect.attemptID,
    kind: effect.kind,
    payload: JSON.parse(effect.payload) as unknown,
  })
  value.request.binding.effectID = effect.id
}

test("the production evaluator preserves exact handoff bindings and never authorizes recovery", async () => {
  const value = fixture()
  const result = await evaluateMaintenancePreflight(value.request, value.inspection, readers())

  expect(result).toMatchObject({
    coordinationRequired: true,
    containment: "unproven",
    executionPermitted: false,
    suppliedSnapshot: { snapshotID: "inspection-lz72", bindingMatched: true, claimsIgnored: true },
    candidate: { source: "revalidated", status: "matches", head: artifact, clean: true },
    receipt: { source: "revalidated", status: "missing" },
    originalChild: { source: "not-supplied", status: "not-observed" },
    handoff: {
      binding: value.request.binding,
      nextSteps: [
        { id: "exclusive-window" },
        { id: "contain-old-check" },
        { id: "revalidate-bindings" },
        { id: "fresh-runtime-check" },
      ],
    },
  })
  expect(codes(result)).toEqual(
    expect.arrayContaining([
      "runner-receipt-missing",
      "original-child-identity-missing",
      "old-check-containment-unproven",
    ]),
  )
  expect(result.missingEvidence).toEqual(
    expect.arrayContaining([
      "runner-check-receipt",
      "original-check-process-identity",
      "exclusive-window-runtime-owned-containment-proof",
      "fresh-runtime-owned-check-receipt",
    ]),
  )
})

test("production effect and environment identities are preserved and foreign bindings fail closed", async () => {
  expect(effectID).toMatch(/^[a-f0-9]{64}$/)
  expect(productionEnvironmentIdentity.length).toBeGreaterThan(256)

  const valid = fixture()
  const receipt = receiptSnapshot()
  valid.inspection.receipt = { status: "present", receipt }
  const accepted = await evaluateMaintenancePreflight(
    valid.request,
    valid.inspection,
    readers({ receipt: () => ({ kind: "present", receipt }) }),
  )
  expect(accepted.suppliedSnapshot.bindingMatched).toBe(true)
  expect(accepted.handoff.binding).toEqual(valid.request.binding)
  expect(accepted.receipt.status).toBe("matches")
  expect(codes(accepted)).not.toContain("invalid-request")
  expect(codes(accepted)).not.toContain("invalid-inspection")

  const wrong = fixture()
  wrong.request.binding.effectID = fingerprint("another runner effect")
  const wrongResult = await evaluateMaintenancePreflight(wrong.request, wrong.inspection, readers())
  expect(codes(wrongResult)).toContain("latest-effect-mismatch")
  expect(wrongResult.executionPermitted).toBe(false)

  const malformed = fixture()
  malformed.request.binding.effectID = "not-a-sha256-fingerprint"
  const malformedResult = await evaluateMaintenancePreflight(
    malformed.request,
    malformed.inspection,
    readers(),
  )
  expect(codes(malformedResult)).toEqual(["invalid-request"])
  expect(malformedResult.handoff.binding).toBeNull()

  const foreignPair = fixture()
  const foreignPayload = { ...effectPayload, workspace: "/foreign/workspace" }
  const foreignID = fingerprint({
    planID,
    taskID,
    attemptID,
    kind: effectKind,
    payload: foreignPayload,
  })
  foreignPair.request.binding.effectID = foreignID
  foreignPair.inspection.effects[0]!.id = foreignID
  const foreignResult = await evaluateMaintenancePreflight(
    foreignPair.request,
    foreignPair.inspection,
    readers(),
  )
  expect(codes(foreignResult)).toContain("effect-payload-mismatch")
  expect(foreignResult.suppliedSnapshot.bindingMatched).toBe(false)
  expect(foreignResult.executionPermitted).toBe(false)

  const mismatchedReceipt = fixture()
  const snapshotReceipt = receiptSnapshot({
    environmentIdentity: `${productionEnvironmentIdentity} `,
  })
  const actualReceipt = receiptSnapshot()
  mismatchedReceipt.inspection.receipt = { status: "present", receipt: snapshotReceipt }
  const receiptResult = await evaluateMaintenancePreflight(
    mismatchedReceipt.request,
    mismatchedReceipt.inspection,
    readers({ receipt: () => ({ kind: "present", receipt: actualReceipt }) }),
  )
  expect(codes(receiptResult)).toContain("receipt-snapshot-changed")
  expect(receiptResult.receipt.status).toBe("mismatch")
  expect(receiptResult.executionPermitted).toBe(false)
})

test("the evaluator is deterministic and calls only injected read-only evidence readers", async () => {
  const value = fixture()
  const calls = { git: 0, receipt: 0, process: 0 }
  const forbidden: string[] = []
  const base = readers({
    git: () => {
      calls.git += 1
      return { kind: "observed", root: workspace, head: artifact, clean: true, unmerged: false }
    },
    receipt: () => {
      calls.receipt += 1
      return { kind: "missing" }
    },
    process: () => {
      calls.process += 1
      return { kind: "authoritatively-absent" }
    },
  })
  const monitored = new Proxy(base, {
    get(target, key, receiver) {
      if (!new Set(["git", "receipt", "process"]).has(String(key))) forbidden.push(String(key))
      return Reflect.get(target, key, receiver) as unknown
    },
  })
  const beforeRows = structuredClone({ request: value.request, inspection: value.inspection })
  const first = await evaluateMaintenancePreflight(value.request, value.inspection, monitored)
  const second = await evaluateMaintenancePreflight(value.request, value.inspection, monitored)

  expect(second).toEqual(first)
  expect(calls).toEqual({ git: 4, receipt: 2, process: 0 })
  expect(forbidden).toEqual([])
  expect({ request: value.request, inspection: value.inspection }).toEqual(beforeRows)
  expect(first.executionPermitted).toBe(false)
})

test("dirty, wrong, changed, unmerged and snapshot-mismatched candidates fail closed", async () => {
  const cases: Array<{
    name: string
    make: (value: Fixture) => MaintenanceReaders
    snapshot?: (value: Fixture) => void
    expected: MaintenanceReasonCode
  }> = [
    {
      name: "dirty working tree",
      make: () =>
        readers({
          git: () => ({
            kind: "observed",
            root: workspace,
            head: artifact,
            clean: false,
            unmerged: false,
          }),
        }),
      expected: "candidate-dirty",
    },
    {
      name: "wrong commit",
      make: () =>
        readers({
          git: () => ({
            kind: "observed",
            root: workspace,
            head: "c".repeat(40),
            clean: true,
            unmerged: false,
          }),
        }),
      expected: "candidate-head-mismatch",
    },
    {
      name: "wrong workspace root",
      make: () =>
        readers({
          git: () => ({
            kind: "observed",
            root: "/elsewhere",
            head: artifact,
            clean: true,
            unmerged: false,
          }),
        }),
      expected: "candidate-root-mismatch",
    },
    {
      name: "unmerged index",
      make: () =>
        readers({
          git: () => ({
            kind: "observed",
            root: workspace,
            head: artifact,
            clean: true,
            unmerged: true,
          }),
        }),
      expected: "candidate-unmerged",
    },
    {
      name: "candidate changes during observation",
      make: () => {
        let reads = 0
        return readers({
          git: () => {
            reads += 1
            return {
              kind: "observed",
              root: workspace,
              head: reads === 1 ? artifact : "c".repeat(40),
              clean: true,
              unmerged: false,
            }
          },
        })
      },
      expected: "candidate-changed-during-inspection",
    },
    {
      name: "contradictory candidate snapshot",
      make: () => readers(),
      snapshot: (value) => {
        value.inspection.candidate.clean = false
      },
      expected: "candidate-snapshot-mismatch",
    },
  ]

  for (const example of cases) {
    const value = fixture()
    example.snapshot?.(value)
    const result = await evaluateMaintenancePreflight(
      value.request,
      value.inspection,
      example.make(value),
    )
    expect(codes(result)).toContain(example.expected)
    expect(result.executionPermitted).toBe(false)
  }
})

test("manifest-free and legacy-manifest inspections reach candidate and receipt evaluation", async () => {
  const cases: Array<{ name: string; manifest?: unknown }> = [
    { name: "without manifest" },
    {
      name: "stale manifest entries",
      manifest: [{ path: "deleted.ts", mode: "100644", type: "blob", objectID: "d".repeat(40) }],
    },
    { name: "malformed manifest entries", manifest: [{ path: null, unexpected: true }] },
  ]

  for (const example of cases) {
    const value = fixture()
    if ("manifest" in example) value.inspection.candidate.manifest = example.manifest
    const receipt = receiptSnapshot()
    value.inspection.receipt = { status: "present", receipt }
    let receiptReads = 0
    const result = await evaluateMaintenancePreflight(
      value.request,
      value.inspection,
      readers({
        receipt: () => {
          receiptReads += 1
          return { kind: "present", receipt }
        },
      }),
    )

    expect(result.suppliedSnapshot.bindingMatched).toBe(true)
    expect(result.candidate.status).toBe("matches")
    expect(result.receipt.status).toBe("matches")
    expect(receiptReads).toBe(1)
    expect(result.executionPermitted).toBe(false)
    expect(codes(result)).not.toContain("invalid-inspection")
  }

  const unknownField = fixture()
  ;(unknownField.inspection.candidate as unknown as Record<string, unknown>).fileInventory = []
  const rejected = await evaluateMaintenancePreflight(
    unknownField.request,
    unknownField.inspection,
    readers(),
  )
  expect(codes(rejected)).toContain("invalid-inspection")
})

test("candidate Git observations bracket successful and throwing receipt reads", async () => {
  const cases = [{ fail: false }, { fail: true }] as const

  for (const example of cases) {
    const value = fixture()
    const events: string[] = []
    let currentHead = artifact
    const mutation: MaintenanceReaders = {
      git: () => {
        events.push("git")
        return {
          kind: "observed",
          root: workspace,
          head: currentHead,
          clean: true,
          unmerged: false,
        }
      },
      receipt: () => {
        events.push("receipt")
        currentHead = "c".repeat(40)
        if (example.fail) throw new Error("receipt read failed after mutation")
        return { kind: "missing" }
      },
      process: () => ({ kind: "authoritatively-absent" }),
    }

    const result = await evaluateMaintenancePreflight(value.request, value.inspection, mutation)
    expect(events).toEqual(["git", "receipt", "git"])
    expect(codes(result)).toContain("candidate-changed-during-inspection")
    expect(result.candidate.status).toBe("mismatch")
    expect(result.receipt.status).toBe(example.fail ? "unavailable" : "missing")
    expect(result.executionPermitted).toBe(false)
  }
})

test("unavailable readers and stale or contradictory durable snapshots have stable blockers", async () => {
  const unavailable = fixture()
  const missingReaders = await evaluateMaintenancePreflight(
    unavailable.request,
    unavailable.inspection,
    readers({
      git: () => ({ kind: "unavailable" }),
      receipt: () => ({ kind: "unavailable" }),
    }),
  )
  expect(codes(missingReaders)).toEqual(
    expect.arrayContaining([
      "candidate-reader-unavailable",
      "receipt-reader-unavailable",
      "original-child-identity-missing",
      "old-check-containment-unproven",
    ]),
  )

  const stale = fixture()
  stale.inspection.plan.version -= 1
  stale.inspection.task.revision += 1
  const staleFirst = await evaluateMaintenancePreflight(stale.request, stale.inspection, readers())
  const staleSecond = await evaluateMaintenancePreflight(stale.request, stale.inspection, readers())
  expect(codes(staleFirst)).toContain("plan-version-mismatch")
  expect(codes(staleFirst)).toContain("task-binding-mismatch")
  expect(codes(staleSecond)).toEqual(codes(staleFirst))

  const contradiction = fixture()
  contradiction.inspection.attempts.push({ ...contradiction.inspection.attempts[0]! })
  const contradictoryResult = await evaluateMaintenancePreflight(
    contradiction.request,
    contradiction.inspection,
    readers(),
  )
  expect(codes(contradictoryResult)).toContain("snapshot-contradictory")

  const unavailableProcess = fixture()
  unavailableProcess.request.originalChild = {
    pid: 7123,
    startedAt: "Mon Nov  2 10:00:00 2026",
    command: "/bin/sh -c check",
  }
  const unavailableProcessResult = await evaluateMaintenancePreflight(
    unavailableProcess.request,
    unavailableProcess.inspection,
    readers({ process: () => ({ kind: "observation-unavailable", reason: "probe-error" }) }),
  )
  expect(codes(unavailableProcessResult)).toContain("process-observation-unavailable")
})

test("new, missing, malformed and mismatched receipts never repair an uncertain effect", async () => {
  const appeared = fixture()
  const appearedResult = await evaluateMaintenancePreflight(
    appeared.request,
    appeared.inspection,
    readers({
      receipt: () => ({ kind: "present", receipt: receiptSnapshot() }),
    }),
  )
  expect(codes(appearedResult)).toContain("receipt-snapshot-changed")
  expect(appearedResult.receipt.status).toBe("mismatch")
  expect(appearedResult.executionPermitted).toBe(false)

  const malformed = fixture()
  malformed.inspection.receipt = { status: "present", receipt: { exitCode: 0 } }
  const malformedResult = await evaluateMaintenancePreflight(
    malformed.request,
    malformed.inspection,
    readers({
      receipt: () => ({ kind: "present", receipt: { exitCode: 0 } }),
    }),
  )
  expect(codes(malformedResult)).toContain("runner-receipt-invalid")

  const mismatched = fixture()
  const different = receiptSnapshot({ artifact: "f".repeat(40) })
  mismatched.inspection.receipt = { status: "present", receipt: different }
  const mismatchedResult = await evaluateMaintenancePreflight(
    mismatched.request,
    mismatched.inspection,
    readers({
      receipt: () => ({ kind: "present", receipt: different }),
    }),
  )
  expect(codes(mismatchedResult)).toContain("runner-receipt-mismatch")

  const valid = fixture()
  const goodReceipt = receiptSnapshot()
  valid.inspection.receipt = { status: "present", receipt: goodReceipt }
  const validResult = await evaluateMaintenancePreflight(
    valid.request,
    valid.inspection,
    readers({
      receipt: () => ({ kind: "present", receipt: goodReceipt }),
    }),
  )
  expect(validResult.receipt.status).toBe("matches")
  expect(validResult.containment).toBe("unproven")
  expect(validResult.executionPermitted).toBe(false)

  const failedReceipt = fixture()
  const notPassing = receiptSnapshot({ exitCode: 1 })
  failedReceipt.inspection.receipt = { status: "present", receipt: notPassing }
  const failedResult = await evaluateMaintenancePreflight(
    failedReceipt.request,
    failedReceipt.inspection,
    readers({
      receipt: () => ({ kind: "present", receipt: notPassing }),
    }),
  )
  expect(codes(failedResult)).toContain("runner-receipt-not-passing")
})

test("latest-attempt/effect and effect payload bindings are exact", async () => {
  const latestAttempt = fixture()
  latestAttempt.inspection.attempts.push({
    ...latestAttempt.inspection.attempts[0]!,
    id: "55555555-5555-4555-8555-555555555555",
    number: 2,
  })
  const attemptResult = await evaluateMaintenancePreflight(
    latestAttempt.request,
    latestAttempt.inspection,
    readers(),
  )
  expect(codes(attemptResult)).toContain("latest-attempt-mismatch")

  const latestEffect = fixture()
  latestEffect.inspection.effects.push({
    ...latestEffect.inspection.effects[0]!,
    ordinal: 2,
    id: fingerprint("foreign latest effect"),
  })
  const effectResult = await evaluateMaintenancePreflight(
    latestEffect.request,
    latestEffect.inspection,
    readers(),
  )
  expect(codes(effectResult)).toContain("latest-effect-mismatch")

  const malformedNewerEffect = fixture()
  const originalEffect = malformedNewerEffect.inspection.effects[0]!
  const malformedPayload = {}
  malformedNewerEffect.inspection.effects.push({
    ...originalEffect,
    ordinal: 2,
    id: fingerprint({
      planID: originalEffect.planID,
      taskID: originalEffect.taskID,
      attemptID: originalEffect.attemptID,
      kind: originalEffect.kind,
      payload: malformedPayload,
    }),
    payload: JSON.stringify(malformedPayload),
  })
  const malformedNewerResult = await evaluateMaintenancePreflight(
    malformedNewerEffect.request,
    malformedNewerEffect.inspection,
    readers(),
  )
  expect(codes(malformedNewerResult)).toContain("latest-effect-mismatch")
  expect(codes(malformedNewerResult)).toContain("effect-payload-mismatch")
  expect(malformedNewerResult.suppliedSnapshot.bindingMatched).toBe(false)

  const payloadMismatch = fixture()
  const mismatchEffect = payloadMismatch.inspection.effects[0]!
  const payload = JSON.parse(mismatchEffect.payload) as Record<string, unknown>
  payload.workspace = "/different/workspace"
  mismatchEffect.payload = JSON.stringify(payload)
  const payloadResult = await evaluateMaintenancePreflight(
    payloadMismatch.request,
    payloadMismatch.inspection,
    readers(),
  )
  expect(codes(payloadResult)).toContain("effect-payload-mismatch")

  const wrongProject = fixture()
  wrongProject.inspection.project.id = "another-project"
  const projectResult = await evaluateMaintenancePreflight(
    wrongProject.request,
    wrongProject.inspection,
    readers(),
  )
  expect(codes(projectResult)).toContain("project-binding-mismatch")

  const wrongOwner = fixture()
  wrongOwner.inspection.plan.ownerID = "another-owner"
  const ownerResult = await evaluateMaintenancePreflight(
    wrongOwner.request,
    wrongOwner.inspection,
    readers(),
  )
  expect(codes(ownerResult)).toContain("plan-binding-mismatch")

  const wrongAttemptPlan = fixture()
  wrongAttemptPlan.inspection.attempts[0]!.planID = "77777777-7777-4777-8777-777777777777"
  const attemptPlanResult = await evaluateMaintenancePreflight(
    wrongAttemptPlan.request,
    wrongAttemptPlan.inspection,
    readers(),
  )
  expect(codes(attemptPlanResult)).toContain("attempt-binding-mismatch")

  const wrongTimeout = fixture()
  const timeoutEffect = wrongTimeout.inspection.effects[0]!
  const timeoutPayload = JSON.parse(timeoutEffect.payload) as {
    check: { timeoutMs: number }
  }
  timeoutPayload.check.timeoutMs += 1
  timeoutEffect.payload = JSON.stringify(timeoutPayload)
  const timeoutResult = await evaluateMaintenancePreflight(
    wrongTimeout.request,
    wrongTimeout.inspection,
    readers(),
  )
  expect(codes(timeoutResult)).toContain("effect-payload-mismatch")
})

test("snapshot age alone is not treated as freshness evidence", async () => {
  const old = fixture()
  old.inspection.capturedAt = 1
  const result = await evaluateMaintenancePreflight(old.request, old.inspection, readers())
  expect(result.suppliedSnapshot.bindingMatched).toBe(true)
  expect(codes(result)).not.toContain("plan-version-mismatch")
  expect(codes(result)).toContain("old-check-containment-unproven")
})

test("PID reuse, start-time mismatch, live identity and absence all leave containment unproven", async () => {
  const reused = fixture()
  reused.request.originalChild = {
    pid: 7123,
    startedAt: "Mon Nov  2 10:00:00 2026",
    command: "/bin/sh -c check",
  }
  const reusedResult = await evaluateMaintenancePreflight(
    reused.request,
    reused.inspection,
    readers({
      process: (): ProcessObservation => ({
        kind: "live",
        identity: {
          pid: 7123,
          startedAt: "Tue Nov  3 10:00:00 2026",
          command: "/bin/sh -c unrelated",
        },
      }),
    }),
  )
  expect(codes(reusedResult)).toContain("process-identity-changed")
  expect(reusedResult.originalChild.status).toBe("identity-changed")
  expect(reusedResult.containment).toBe("unproven")

  const live = fixture()
  live.request.originalChild = {
    pid: 7123,
    startedAt: "Mon Nov  2 10:00:00 2026",
    command: "/bin/sh -c check",
  }
  const liveResult = await evaluateMaintenancePreflight(
    live.request,
    live.inspection,
    readers({
      process: (): ProcessObservation => ({
        kind: "live",
        identity: { ...live.request.originalChild! },
      }),
    }),
  )
  expect(codes(liveResult)).toContain("original-check-still-live")
  expect(liveResult.executionPermitted).toBe(false)

  const absent = fixture()
  absent.request.originalChild = {
    pid: 7123,
    startedAt: "Mon Nov  2 10:00:00 2026",
    command: "/bin/sh -c check",
  }
  const absentResult = await evaluateMaintenancePreflight(
    absent.request,
    absent.inspection,
    readers({
      process: () => ({ kind: "authoritatively-absent" }),
    }),
  )
  expect(codes(absentResult)).toContain("original-check-absent")

  for (const result of [reusedResult, liveResult, absentResult]) {
    expect(result.containment).toBe("unproven")
    expect(result.executionPermitted).toBe(false)
    expect(codes(result)).toContain("old-check-containment-unproven")
  }
})

function git(cwd: string, args: string[]): string {
  const result = spawnSync(
    "git",
    [
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_ALLOW_PROTOCOL: "file",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  )
  if (result.error || result.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.error?.message}`)
  return result.stdout
}

function byteManifest(directory: string): string[] {
  const rows: string[] = []
  const visit = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const absolute = join(current, entry.name)
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const stat = lstatSync(absolute)
      if (entry.isSymbolicLink()) rows.push(`${relative}\0link\0${readlinkSync(absolute)}`)
      else if (entry.isDirectory()) {
        rows.push(`${relative}\0directory`)
        visit(absolute, relative)
      } else if (entry.isFile())
        rows.push(`${relative}\0file\0${readFileSync(absolute).toString("base64")}`)
      else rows.push(`${relative}\0other\0${stat.mode}`)
    }
  }
  visit(directory, "")
  return rows
}

function createE6Fixture(root: string): string {
  const source = realpathSync(resolve(new URL("../", import.meta.url).pathname))
  const worktree = join(root, "candidate")
  git(root, ["clone", "--quiet", "--shared", "--no-checkout", source, worktree])
  // Exercise the real captured commit without materializing unrelated product artifacts.
  git(worktree, ["sparse-checkout", "set", "--no-cone", "/src/task.ts"])
  git(root, ["-C", worktree, "checkout", "--quiet", "--detach", artifact])
  return worktree
}

test("spawned offline CLI accepts production bindings and leaves candidate and receipts unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "lazers-maintenance-preflight-"))
  try {
    const candidate = createE6Fixture(root)
    expect(readFileSync(join(candidate, "src/task.ts"), "utf8").length).toBeGreaterThan(0)
    const fixtureData = fixture()
    const projectPath = realpathSync(dirname(candidate))
    const workspacePath = realpathSync(candidate)
    const marker = join(root, "must-not-run")
    const checkCommand = `touch ${marker}`
    fixtureData.request.binding.projectDirectory = projectPath
    fixtureData.request.binding.workspace = workspacePath
    fixtureData.request.binding.command = checkCommand
    fixtureData.request.binding.receiptPath = join(
      root,
      "runtime",
      "receipts",
      attemptID,
      `runner-${artifact}.json`,
    )
    const effect = fixtureData.inspection.effects[0]!
    const payload = JSON.parse(effect.payload) as { check: Record<string, unknown> } & Record<
      string,
      unknown
    >
    payload.workspace = workspacePath
    payload.receiptPath = fixtureData.request.binding.receiptPath
    payload.check.command = checkCommand
    effect.payload = JSON.stringify(payload)
    bindRunnerEffect(fixtureData)
    fixtureData.inspection.project.directory = projectPath
    fixtureData.inspection.plan.projectDirectory = projectPath
    fixtureData.inspection.attempts[0]!.workspace = workspacePath
    fixtureData.inspection.candidate.workspace = workspacePath
    expect(fixtureData.inspection.candidate).not.toHaveProperty("manifest")

    const requestFile = join(root, "request.json")
    const inspectionFile = join(root, "inspection.json")
    const receiptFile = fixtureData.request.binding.receiptPath
    const actualReceipt = receiptSnapshot({ command: checkCommand, cwd: workspacePath })
    fixtureData.inspection.receipt = { status: "present", receipt: actualReceipt }
    mkdirSync(dirname(receiptFile), { recursive: true, mode: 0o700 })
    writeFileSync(requestFile, JSON.stringify(fixtureData.request), { mode: 0o600 })
    writeFileSync(inspectionFile, JSON.stringify(fixtureData.inspection), { mode: 0o600 })
    writeFileSync(receiptFile, JSON.stringify(actualReceipt), { mode: 0o600 })

    const beforeCandidate = byteManifest(candidate)
    const beforeReceipt = readFileSync(receiptFile).toString("base64")
    const beforeInputs = [
      readFileSync(requestFile).toString("base64"),
      readFileSync(inspectionFile).toString("base64"),
    ]
    const beforeRows = JSON.stringify({
      project: fixtureData.inspection.project,
      plan: fixtureData.inspection.plan,
      task: fixtureData.inspection.task,
      attempts: fixtureData.inspection.attempts,
      effects: fixtureData.inspection.effects,
    })
    const cli = spawnSync(
      process.execPath,
      [
        "src/verification/maintenance/cli.ts",
        "prepare",
        "--request",
        requestFile,
        "--inspection",
        inspectionFile,
      ],
      {
        cwd: realpathSync(resolve(new URL("../", import.meta.url).pathname)),
        encoding: "utf8",
        timeout: 60_000,
        env: {
          ...process.env,
          PATH: productionPathForLongIdentity,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    )
    expect(cli.error).toBeUndefined()
    expect(cli.status).toBe(0)
    expect(cli.stderr).toBe("")
    const result = JSON.parse(cli.stdout) as Awaited<
      ReturnType<typeof evaluateMaintenancePreflight>
    >
    expect(result).toMatchObject({
      coordinationRequired: true,
      containment: "unproven",
      executionPermitted: false,
      suppliedSnapshot: { bindingMatched: true, claimsIgnored: true },
      candidate: { source: "revalidated", status: "matches", head: artifact, clean: true },
      receipt: { source: "revalidated", status: "matches" },
    })
    expect(result.handoff.binding).toEqual(fixtureData.request.binding)
    expect(result.handoff.binding?.effectID).toBe(fixtureData.inspection.effects[0]!.id)
    expect(actualReceipt.environmentIdentity).toBe(productionEnvironmentIdentity)
    expect(actualReceipt.environmentIdentity.length).toBeGreaterThan(256)
    expect(codes(result)).toEqual(
      expect.arrayContaining(["original-child-identity-missing", "old-check-containment-unproven"]),
    )
    expect(result.handoff.nextSteps.map((step) => step.id)).toEqual([
      "exclusive-window",
      "contain-old-check",
      "revalidate-bindings",
      "fresh-runtime-check",
    ])
    expect(byteManifest(candidate)).toEqual(beforeCandidate)
    expect(readFileSync(receiptFile).toString("base64")).toBe(beforeReceipt)
    expect([
      readFileSync(requestFile).toString("base64"),
      readFileSync(inspectionFile).toString("base64"),
    ]).toEqual(beforeInputs)
    expect(
      JSON.stringify({
        project: fixtureData.inspection.project,
        plan: fixtureData.inspection.plan,
        task: fixtureData.inspection.task,
        attempts: fixtureData.inspection.attempts,
        effects: fixtureData.inspection.effects,
      }),
    ).toBe(beforeRows)
    expect(() => readFileSync(marker)).toThrow()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
