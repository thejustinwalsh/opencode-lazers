import { expect, test } from "bun:test"
import type { EffectRow } from "../store.ts"
import { assertGraphWorkspaceQuiescent } from "./graph-workspace.ts"

function effect(input: {
  id: string
  kind: string
  state: EffectRow["state"]
  payload: unknown
  receipt: unknown
}): EffectRow {
  return {
    id: input.id,
    plan_id: "plan",
    task_id: null,
    attempt_id: null,
    kind: input.kind,
    state: input.state,
    payload: JSON.stringify(input.payload),
    receipt: typeof input.receipt === "string" ? input.receipt : JSON.stringify(input.receipt),
    fence: 1,
  }
}

function graphWorkspace(input: {
  workspace: string
  artifact: string
  checkID: string
  command: string
  state?: EffectRow["state"]
  exitCode?: number | null
  processCleanup?: unknown
  receipt?: unknown
}) {
  const check = {
    id: input.checkID,
    command: input.command,
    cwd: input.workspace,
    artifact: input.artifact,
    inputIdentity: input.artifact,
    environmentIdentity: "{}",
    startedAt: 1,
    endedAt: 2,
    exitCode: input.exitCode === undefined ? 0 : input.exitCode,
    timedOut: false,
    stdout: "",
    stderr: "",
    ...(input.processCleanup === undefined ? {} : { processCleanup: input.processCleanup }),
  }
  return [
    effect({
      id: `create-${input.checkID}`,
      kind: "graph-worktree",
      state: "completed",
      payload: { workspace: input.workspace, base: input.artifact },
      receipt: { workspace: input.workspace, base: input.artifact },
    }),
    effect({
      id: `check-${input.checkID}`,
      kind: `graph-verify:${input.checkID}`,
      state: input.state ?? "completed",
      payload: {
        workspace: input.workspace,
        artifact: input.artifact,
        check: { id: input.checkID, command: input.command },
      },
      receipt: input.receipt ?? { check },
    }),
  ]
}

const olderWorkspace = "/project.worktrees/older"
const newerWorkspace = "/project.worktrees/newer"
const olderArtifact = "a".repeat(40)
const newerArtifact = "b".repeat(40)

test("graph workspace settlement follows each candidate's own checks and preserves failed results", () => {
  const oldEffects = graphWorkspace({
    workspace: olderWorkspace,
    artifact: olderArtifact,
    checkID: "old-procedure",
    command: "run old checks",
    exitCode: 7,
  })
  const newEffects = graphWorkspace({
    workspace: newerWorkspace,
    artifact: newerArtifact,
    checkID: "new-procedure",
    command: "run new checks",
  })
  const failedReceipt = oldEffects[1]!.receipt

  expect(() =>
    assertGraphWorkspaceQuiescent([...oldEffects, ...newEffects], olderWorkspace),
  ).not.toThrow()
  expect(() =>
    assertGraphWorkspaceQuiescent([...oldEffects, ...newEffects], newerWorkspace),
  ).not.toThrow()
  expect(oldEffects[1]!.state).toBe("completed")
  expect(oldEffects[1]!.receipt).toBe(failedReceipt)
  expect(JSON.parse(failedReceipt!).check.exitCode).toBe(7)
})

test("a nested uncertain check only settles workspace cleanup when its process receipt is conclusive", () => {
  const effects = graphWorkspace({
    workspace: olderWorkspace,
    artifact: olderArtifact,
    checkID: "interrupted",
    command: "exit 9",
    state: "uncertain",
    exitCode: 9,
    processCleanup: {
      state: "uncertain",
      capability: "process-group",
      rootPID: 42,
    },
    receipt: {
      error: "check effect journal was interrupted",
      result: {
        check: {
          id: "interrupted",
          command: "exit 9",
          cwd: olderWorkspace,
          artifact: olderArtifact,
          inputIdentity: olderArtifact,
          environmentIdentity: "{}",
          startedAt: 1,
          endedAt: 2,
          exitCode: 9,
          timedOut: false,
          aborted: true,
          stdout: "",
          stderr: "",
          processCleanup: {
            state: "terminated",
            capability: "process-group",
            rootPID: 42,
          },
        },
      },
    },
  })
  const receiptBeforeCleanup = effects[1]!.receipt

  expect(() => assertGraphWorkspaceQuiescent(effects, olderWorkspace)).not.toThrow()
  expect(effects[1]!.state).toBe("uncertain")
  expect(effects[1]!.receipt).toBe(receiptBeforeCleanup)
  expect(JSON.parse(receiptBeforeCleanup!).result.check).toMatchObject({
    exitCode: 9,
    aborted: true,
  })
})

test("active, unsettled, malformed, or mismatched graph check evidence holds cleanup", () => {
  const cases: EffectRow[] = []
  const addCase = (
    input: Parameters<typeof graphWorkspace>[0],
    mutate: (effect: EffectRow) => void,
  ) => {
    const entries = graphWorkspace(input)
    mutate(entries[1]!)
    cases.push(entries[1]!)
  }

  addCase(
    {
      workspace: olderWorkspace,
      artifact: olderArtifact,
      checkID: "active",
      command: "run",
    },
    (entry) => {
      entry.state = "intended"
    },
  )
  addCase(
    {
      workspace: olderWorkspace,
      artifact: olderArtifact,
      checkID: "uncertain",
      command: "run",
      processCleanup: { state: "uncertain", capability: "process-group", rootPID: 42 },
    },
    () => {},
  )
  addCase(
    {
      workspace: olderWorkspace,
      artifact: olderArtifact,
      checkID: "malformed",
      command: "run",
    },
    (entry) => {
      entry.receipt = "{"
    },
  )
  addCase(
    {
      workspace: olderWorkspace,
      artifact: olderArtifact,
      checkID: "wrong-cwd",
      command: "run",
    },
    (entry) => {
      const receipt = JSON.parse(entry.receipt!) as { check: { cwd: string } }
      receipt.check.cwd = newerWorkspace
      entry.receipt = JSON.stringify(receipt)
    },
  )
  addCase(
    {
      workspace: olderWorkspace,
      artifact: olderArtifact,
      checkID: "wrong-artifact",
      command: "run",
    },
    (entry) => {
      const receipt = JSON.parse(entry.receipt!) as { check: { artifact: string } }
      receipt.check.artifact = newerArtifact
      entry.receipt = JSON.stringify(receipt)
    },
  )
  addCase(
    {
      workspace: olderWorkspace,
      artifact: olderArtifact,
      checkID: "bad-process",
      command: "run",
      processCleanup: { state: "maybe", capability: "process-group" },
    },
    () => {},
  )

  for (const checkEffect of cases) {
    const sourceEffects = graphWorkspace({
      workspace: olderWorkspace,
      artifact: olderArtifact,
      checkID: "unused",
      command: "unused",
    })[0]!
    expect(() =>
      assertGraphWorkspaceQuiescent([sourceEffects, checkEffect], olderWorkspace),
    ).toThrow("Combined worktree check activity is not conclusively complete")
  }
})

test("malformed or duplicate workspace creation evidence is preserved", () => {
  const effects = graphWorkspace({
    workspace: olderWorkspace,
    artifact: olderArtifact,
    checkID: "check",
    command: "run",
  })
  const source = effects[0]!

  expect(() =>
    assertGraphWorkspaceQuiescent([{ ...source, receipt: "{" }, effects[1]!], olderWorkspace),
  ).toThrow("Combined worktree creation evidence")
  expect(() =>
    assertGraphWorkspaceQuiescent([...effects, { ...source, id: "duplicate" }], olderWorkspace),
  ).toThrow("Combined worktree creation evidence")
})
