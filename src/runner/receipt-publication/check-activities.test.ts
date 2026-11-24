import { expect, spyOn, test } from "bun:test"
import * as fsPromises from "node:fs/promises"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TaskProposal } from "../../task.ts"
import { CheckActivities } from "../check-activities.ts"
import type { CheckActivitiesDeps } from "../check-activities.ts"
import { checkSucceeded } from "../checks.ts"
import type { RunnerCheckReceipt } from "../artifacts.ts"
import type { RuntimeCore } from "../runtime-core.ts"
import type { AdoptionExecution } from "../adoption-execution.ts"
import type { RetainedVerificationExecution } from "../retained-verification-execution.ts"
import { verificationDeadline, verificationReceiptDeadline } from "../verification-timeout.ts"

const cases = [
  { label: "successful", command: "printf passed", exitCode: 0, timedOut: false, aborted: false },
  { label: "failed", command: "exit 17", exitCode: 17, timedOut: false, aborted: false },
  {
    label: "interrupted",
    command: "sleep 30",
    exitCode: null,
    timedOut: false,
    aborted: true,
  },
] as const

function createCheckActivities(): CheckActivities {
  const dependencies: CheckActivitiesDeps = {
    requestTick: async () => {},
    verificationTimeoutDefaults: { inactivityTimeoutMs: 5_000, hardTimeoutMs: 10_000 },
    retainedVerificationAborts: new Map(),
    retainedVerificationExecution: () => ({}) as RetainedVerificationExecution,
    adoptionExecution: () => ({}) as AdoptionExecution,
    reconcileEffect: async () => {},
    checkProfile: () => undefined,
  }
  return new CheckActivities({} as RuntimeCore, dependencies)
}

function deadlineFor(workspace: string, check: TaskProposal["verification"][number]) {
  return verificationDeadline([], {
    projectID: "fixture",
    projectDirectory: workspace,
    planID: crypto.randomUUID(),
    planRevision: 1,
    phase: "task",
    taskID: crypto.randomUUID(),
    taskRevision: 1,
    attemptID: crypto.randomUUID(),
    artifact: "a".repeat(40),
    checkID: check.id,
    command: check.command,
    authoredTimeoutMs: check.timeoutMs ?? null,
    authoredInactivityTimeoutMs: check.inactivityTimeoutMs ?? null,
    authoredHardTimeoutMs: check.hardTimeoutMs ?? null,
    defaultInactivityTimeoutMs: 5_000,
    defaultHardTimeoutMs: 10_000,
  })
}

test.each(cases)(
  "$label check publishes a complete recoverable receipt in one rename",
  async ({ label, command, exitCode, timedOut, aborted }) => {
    const workspace = mkdtempSync(join(tmpdir(), `lazers-receipt-${label}-`))
    const check: TaskProposal["verification"][number] = {
      id: `receipt-${label}`,
      command,
      timeoutMs: 1_000,
    }
    const receiptPath = join(workspace, "check.json")
    const deadline = deadlineFor(workspace, check)
    const published: RunnerCheckReceipt[] = []
    const rename = fsPromises.rename.bind(fsPromises)
    const renameSpy = spyOn(fsPromises, "rename").mockImplementation(
      async (source, destination) => {
        await rename(source, destination)
        if (String(destination) === receiptPath)
          published.push(JSON.parse(readFileSync(receiptPath, "utf8")) as RunnerCheckReceipt)
      },
    )
    const controller = aborted ? new AbortController() : undefined
    let interruptTimer: ReturnType<typeof setTimeout> | undefined

    try {
      const running = createCheckActivities().runVerificationCheck(
        workspace,
        "a".repeat(40),
        check,
        deadline,
        receiptPath,
        controller ? { signal: controller.signal } : undefined,
      )
      if (controller) interruptTimer = setTimeout(() => controller.abort(), 40)
      const receipt = await running
      const persisted = JSON.parse(readFileSync(receiptPath, "utf8")) as RunnerCheckReceipt

      if (aborted) expect(receipt.exitCode).not.toBe(0)
      else expect(receipt.exitCode).toBe(exitCode)
      expect(receipt.timedOut).toBe(timedOut)
      expect(receipt.aborted).toBe(aborted)
      expect(checkSucceeded(receipt)).toBe(!aborted && !timedOut && exitCode === 0)
      expect(receipt.verificationDeadline).toEqual(verificationReceiptDeadline(deadline))
      expect(persisted).toEqual(receipt)
      // The rename callback is the exact point where recovery can first observe this path.
      expect(published).toEqual([expect.objectContaining(receipt)])
      expect(published[0]?.verificationDeadline).toEqual(verificationReceiptDeadline(deadline))
    } finally {
      if (interruptTimer !== undefined) clearTimeout(interruptTimer)
      renameSpy.mockRestore()
      rmSync(workspace, { recursive: true, force: true })
    }
  },
)

test("recognized multi-phase checks publish deadline metadata on their final receipt", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "lazers-receipt-phases-"))
  const check: TaskProposal["verification"][number] = {
    id: "receipt-phases",
    command: "bun run first && bun run second",
    timeoutMs: 1_000,
  }
  const receiptPath = join(workspace, "phases.json")
  const deadline = deadlineFor(workspace, check)
  writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify({ scripts: { first: "printf first", second: "printf second" } }),
  )
  const published: RunnerCheckReceipt[] = []
  const rename = fsPromises.rename.bind(fsPromises)
  const renameSpy = spyOn(fsPromises, "rename").mockImplementation(async (source, destination) => {
    await rename(source, destination)
    if (String(destination) === receiptPath)
      published.push(JSON.parse(readFileSync(receiptPath, "utf8")) as RunnerCheckReceipt)
  })

  try {
    const receipt = await createCheckActivities().runVerificationCheck(
      workspace,
      "a".repeat(40),
      check,
      deadline,
      receiptPath,
    )
    expect(receipt.phases).toHaveLength(2)
    expect(receipt.phasesComplete).toBe(true)
    expect(receipt.stdout).toBe("firstsecond")
    expect(receipt.verificationDeadline).toEqual(verificationReceiptDeadline(deadline))
    expect(published).toEqual([receipt])
  } finally {
    renameSpy.mockRestore()
    rmSync(workspace, { recursive: true, force: true })
  }
})
