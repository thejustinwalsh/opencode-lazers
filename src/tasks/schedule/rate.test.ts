import { expect, test } from "bun:test"
import { BACKFILL_PAGE, backfillPage } from "./backfill.ts"
import { insertTask, openFixture, submitPlan } from "./fixture.ts"
import { installTaskScheduleSchema } from "./schema.ts"

test("backfill rate and per-write refresh cost on 1,000 planned tasks", () => {
  const f = openFixture()
  try {
    const start = Bun.nanoseconds()
    for (let i = 0; i < 1000; i++) submitPlan(f, `p${i}`, [insertTask(f.repository, `t${i}`)])
    const writeMs = (Bun.nanoseconds() - start) / 1e6 / 1000
    f.repository.atomic((db) => installTaskScheduleSchema(db))
    const t0 = Bun.nanoseconds()
    let pages = 0
    for (;;) {
      const done = f.repository.atomic((db) =>
        backfillPage(db, f.repository.projectDirectory, BACKFILL_PAGE),
      ).done
      pages++
      if (done) break
    }
    const seconds = (Bun.nanoseconds() - t0) / 1e9
    console.log(
      `backfill: 1000 tasks in ${(seconds * 1000).toFixed(0)} ms (${(1000 / seconds).toFixed(0)} tasks/s, ${pages} pages); insert+submit with drain ${writeMs.toFixed(2)} ms per task`,
    )
    expect(pages).toBeGreaterThan(1)
  } finally {
    f.close()
  }
})
