import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { Database } from "bun:sqlite"
import { auditLive } from "./live-audit.ts"
import { insertTask, openFixture, submitPlan } from "./fixture.ts"

test("the read-only audit builds the projection beside the file, matches the old read and writes nothing", () => {
  const f = openFixture()
  try {
    const a = insertTask(f.repository, "alpha")
    const b = insertTask(f.repository, "beta")
    insertTask(f.repository, "loose")
    submitPlan(f, "p", [a, b], { dependencies: [[a, b]] })
    f.repository.atomic((db) =>
      db.query("UPDATE runner_nodes SET state='accepted' WHERE task_id=?").run(a),
    )
    f.repository.close()
    const digest = () => createHash("sha256").update(readFileSync(f.repository.path)).digest("hex")
    const before = digest()
    const [report] = auditLive(f.repository.path)
    expect(report!.scheduleOrder).toEqual({ equal: true })
    expect(report!.kinds).toEqual({})
    expect(report!.tasks).toBe(3)
    expect(digest()).toBe(before)
    // The attachment itself refuses writes.
    const probe = new Database("file::memory:")
    probe.query("ATTACH DATABASE ? AS live").run(`file:${f.repository.path}?mode=ro`)
    expect(() => probe.exec("DELETE FROM live.tasks")).toThrow()
    probe.close()
  } finally {
    f.close()
  }
})
