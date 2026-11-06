import { strict as assert } from "node:assert"
import { createComputed, createRoot, createSignal, onCleanup } from "solid-js"
import { mapByKey } from "../../../src/tasks/keyed.ts"

type Row = { taskID: string; title: string; status: string }
type Group = { planID: string; rows: Row[] }

createRoot((dispose) => {
  const initial: Group[] = [
    { planID: "chain", rows: [{ taskID: "first", title: "First", status: "ready" }] },
    { planID: "b50", rows: [{ taskID: "projection", title: "Projection", status: "ready" }] },
  ]
  const [groups, setGroups] = createSignal(initial)
  let mounts = 0
  let removals = 0
  const mounted = mapByKey(
    groups,
    (group) => group.planID,
    (group) => {
      mounts++
      onCleanup(() => removals++)
      const rows = mapByKey(
        () => group().rows,
        (row) => row.taskID,
        (row) => {
          mounts++
          createComputed(() => assert.equal(typeof row().status, "string"))
          onCleanup(() => removals++)
          return { row, target: {} }
        },
      )
      return { group, rows, target: {} }
    },
  )
  const before = mounted()
  const projection = before[1]!.rows()[0]!
  before[0]!.rows()
  const focusedTarget = projection.target
  assert.equal(mounts, 4)

  // A disclosure preference/scroll save can recompute entirely fresh models.
  for (let update = 0; update < 5; update++) {
    setGroups(structuredClone(initial))
    const next = mounted()
    assert.equal(next[1], before[1])
    assert.equal(next[1]!.rows()[0]!.target, focusedTarget)
    assert.equal(mounts, 4)
    assert.equal(removals, 0)
  }

  // Live status updates flow through retained views; no stale captured object.
  const changed = structuredClone(initial)
  changed[1]!.rows[0]!.status = "running"
  setGroups(changed)
  assert.equal(mounted()[1]!.rows()[0], projection)
  assert.equal(projection.row().status, "running")

  // Canonical keys survive reordered groups and added/removed siblings too.
  setGroups([changed[1]!, changed[0]!])
  assert.equal(mounted()[0], before[1])
  assert.equal(mounted()[0]!.rows()[0]!.target, focusedTarget)
  assert.equal(removals, 0)
  const extra = { taskID: "extra", title: "Extra", status: "ready" }
  setGroups([{ ...changed[1]!, rows: [...changed[1]!.rows, extra] }, changed[0]!])
  assert.equal(mounted()[0]!.rows()[0], projection)
  assert.equal(mounted()[0]!.rows().length, 2)
  assert.equal(mounts, 5)
  setGroups([changed[1]!, changed[0]!])
  mounted()[0]!.rows()
  assert.equal(removals, 1)
  assert.equal(mounts, 5)
  dispose()
  assert.equal(removals, 5)
})
console.log("Canonical group/row identities retained; live values updated; disposal exact")
