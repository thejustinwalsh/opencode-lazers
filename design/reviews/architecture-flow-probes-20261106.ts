/** One-shot, isolated architecture probes. No production database or native session access. */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRuntime } from "../../src/runner/runtime.ts"
import { git, runCheck } from "../../src/runner/artifacts.ts"

const root = mkdtempSync(join(tmpdir(), "lazers-architecture-probe-"))
try {
  git(root, ["init", "--initial-branch=main"])
  writeFileSync(join(root, "seed.txt"), "seed\n")
  git(root, ["add", "seed.txt"])
  git(root, [
    "-c",
    "user.name=probe",
    "-c",
    "user.email=probe@example.invalid",
    "commit",
    "-m",
    "seed",
  ])
  const artifact = git(root, ["rev-parse", "HEAD"])
  const calls: string[] = []
  const start = performance.now()
  // Use the real tick implementation and real subprocess runner. Only native and
  // SQLite boundaries/step admission are fakes, so this is a flow probe, not a
  // production cancellation test or an end-to-end runtime fixture.
  const runtime = Object.assign(Object.create(TaskRuntime.prototype), {
    owner: "architecture-probe",
    running: false,
    stopped: false,
    idleWaiters: [],
    store: {
      claim: () => 1,
      renew: () => {},
      architectRenewalsNeedingRecovery: () => [],
      atomic: () => [],
      plans: () => [
        { id: "check-plan", state: "running" },
        { id: "other-plan", state: "running" },
      ],
    },
    reconcileArchitectSources: async () => {},
    advanceSourceQuarantines: async () => {},
    step: async (plan: { id: string }) => {
      calls.push(`step:${plan.id}`)
      if (plan.id === "check-plan")
        await runCheck(
          root,
          artifact,
          { id: "slow", command: "sleep 0.35", timeoutMs: 2000 },
          join(root, "receipt.json"),
        )
    },
    deliver: async () => {
      calls.push("deliver")
    },
  }) as TaskRuntime
  const firstTick = runtime.tick()
  await Bun.sleep(50)
  const duringCheck = { elapsedMs: Math.round(performance.now() - start), calls: [...calls] }
  await runtime.tick() // The running guard returns; it does not advance the second plan.
  const afterSecondTick = { calls: [...calls] }
  await firstTick
  const afterCheck = { elapsedMs: Math.round(performance.now() - start), calls: [...calls] }
  const predicate = (
    TaskRuntime.prototype as unknown as {
      retainedRepairWorkerProblem: (...args: unknown[]) => string | undefined
    }
  ).retainedRepairWorkerProblem
  const route = { providerID: "example", id: "model", variant: "high" }
  const worker = {
    id: "worker",
    parentID: "launch-owner",
    projectID: "project",
    directory: root,
    agent: "lazers-implementor",
    archived: false,
    metadata: { lazersAttemptID: "attempt" },
    model: route,
    busy: false,
    pendingInput: false,
    observationUnstable: false,
    pendingPermissions: 0,
    pendingForms: 0,
    outcome: "succeeded",
    turn: { state: "completed", inputID: "input" },
  }
  const receiver = { projectID: "project", sameModel: () => true }
  const attempt = { id: "attempt", session_id: "worker", workspace: root }
  const sameOwner = predicate.call(
    receiver,
    { owner: "launch-owner" },
    attempt,
    worker,
    "input",
    route,
  )
  const transferredOwner = predicate.call(
    receiver,
    { owner: "current-owner" },
    attempt,
    worker,
    "input",
    route,
  )
  console.log(
    JSON.stringify(
      {
        observedAt: new Date().toISOString(),
        scope: "isolated fake-boundary flow probes; no production/native access",
        sameProjectTick: { duringCheck, afterSecondTick, afterCheck },
        retainedRepairOwnership: { sameOwner: sameOwner ?? "allowed", transferredOwner },
      },
      null,
      2,
    ),
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}
