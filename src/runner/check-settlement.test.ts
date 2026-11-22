import { expect, test } from "bun:test"
import type { RunnerCheckReceipt } from "./artifacts.ts"
import type { EffectRow } from "./store.ts"
import { EffectReconciliation } from "./effect-reconciliation.ts"

type Settle = (
  this: unknown,
  effect: EffectRow,
  check: RunnerCheckReceipt,
  fence: number,
  activityIdentity: unknown,
) => boolean

// `settleMatchedCheck` is private; the order of its effects is the contract under test.
const settleMatchedCheck = Reflect.get(
  EffectReconciliation.prototype,
  "settleMatchedCheck",
) as Settle

function harness() {
  const calls: string[] = []
  const runtime = {
    requestRetick: () => calls.push("tick:true"),
    receipt: (_effect: EffectRow, receipt: { reconciled?: boolean }) =>
      calls.push(`receipt:${receipt.reconciled}`),
    uncertain: (_effect: EffectRow, error: unknown) =>
      calls.push(error instanceof Error ? "uncertain:error" : `uncertain:${String(error)}`),
    forgetCheckActivity: () => calls.push("forget"),
    recordVerificationEvidence: () => calls.push("evidence"),
  }
  return {
    calls,
    settle: (effect: EffectRow, check: RunnerCheckReceipt) =>
      settleMatchedCheck.call(runtime, effect, check, 1, {}),
  }
}

const effect = (kind: string, owned = true) =>
  ({
    kind,
    id: "effect-1",
    attempt_id: owned ? "attempt-1" : null,
    task_id: owned ? "task-1" : null,
  }) as EffectRow

const settled = {} as RunnerCheckReceipt
const unsettled = { processCleanup: { state: "uncertain" } } as unknown as RunnerCheckReceipt
const aborted = { aborted: true } as RunnerCheckReceipt

test("a settled check records its receipt, requests a tick, then forgets the activity", () => {
  for (const kind of ["mechanical-fix", "graph-verify:lint"]) {
    const { calls, settle } = harness()
    expect(settle(effect(kind), settled)).toBe(true)
    expect(calls).toEqual(["receipt:true", "tick:true", "forget"])
  }
})

test("a task verify check journals its evidence before the receipt", () => {
  const { calls, settle } = harness()
  settle(effect("verify:test"), settled)
  expect(calls).toEqual(["evidence", "receipt:true", "tick:true", "forget"])
})

test("an aborted or unsettled run is not a receipt: nothing is recorded, so the check runs again", () => {
  for (const kind of ["mechanical-fix", "verify:test", "graph-verify:lint"])
    for (const check of [aborted, unsettled]) {
      const { calls, settle } = harness()
      expect(settle(effect(kind), check)).toBe(false)
      expect(calls).toEqual([])
    }
})
