import { afterEach, expect, test } from "bun:test"
import { makeFixture } from "../../test/trajectory/fixture.ts"
import { meterRepository } from "../runner/read-meter.fixture.ts"
import { RetentionService } from "./service.ts"
import { setAutoDays, startRun } from "./store.ts"

/**
 * Idle behaviour (design/data-handling.md, principle 8): the scheduler calls `autoTick` on every
 * project tick. When no run is due it reads a few settings rows and no history, and it never asks
 * the host for worktrees or sessions.
 */

const fixtures: Array<ReturnType<typeof makeFixture>> = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close()
})

const NOW = Date.UTC(2026, 10, 19)

function setup() {
  const fixture = makeFixture()
  fixtures.push(fixture)
  const hostCalls: string[] = []
  const host = new Proxy(
    {},
    {
      get: (_target, name) =>
        name === "then" ? undefined : () => void hostCalls.push(String(name)),
    },
  ) as never
  const service = new RetentionService({ repository: fixture.repository, host, now: () => NOW })
  return { fixture, service, hostCalls }
}

test("an idle auto-retention tick reads settings rows, no history and no host", async () => {
  const { fixture, service, hostCalls } = setup()
  // History: plans, attempts and transitions already in the store.
  fixture.store.atomic((db) => {
    db.query("UPDATE runner_plans SET state='integrated' WHERE id=?").run(fixture.receipt.planID)
    for (let n = 0; n < 500; n++)
      db.query(
        "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,NULL,1,'RECONCILE_REQUESTED','{}',?)",
      ).run(fixture.receipt.planID, n)
  })

  for (const setting of ["off", "on and ran an hour ago"]) {
    fixture.repository.atomic((db) => {
      if (setting === "off") {
        // With no age set, the superseded-only default pass runs on its interval. A tick is idle
        // once that pass has run within the interval, so record one an hour ago.
        setAutoDays(db, null, NOW)
        const id = startRun(db, { at: NOW - 3_600_000, days: 0, trigger: "auto" })
        db.query("UPDATE retention_runs SET done=1 WHERE id=?").run(id)
      } else {
        setAutoDays(db, 30, NOW)
        const id = startRun(db, { at: NOW - 3_600_000, days: 30, trigger: "auto" })
        db.query("UPDATE retention_runs SET done=1 WHERE id=?").run(id)
      }
    })
    const meter = meterRepository(fixture.repository)
    await service.autoTick()
    meter.stop()
    if (process.env.READ_SWEEP_NUMBERS)
      console.log(
        `[read-sweep] idle autoTick (${setting}) rows=${meter.rows} bytes=${meter.bytes} statements=${meter.statements.length}`,
      )
    expect(hostCalls).toEqual([])
    expect(meter.rows).toBeLessThanOrEqual(3)
    expect(meter.of(/runner_transitions|runner_plans|runner_evidence|runner_progress/).rows).toBe(0)
  }
})
