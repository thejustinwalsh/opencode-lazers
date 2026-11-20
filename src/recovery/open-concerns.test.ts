import { expect, test } from "bun:test"
import { makeFixture, taskID, firstAttemptID } from "../../test/trajectory/fixture.ts"
import { HandoffStore } from "./handoff/store.ts"
import { DETECTOR_ACTOR, openConcerns } from "./detector.ts"

test("open concerns are filtered by task in SQL and other tasks' payloads are never parsed", () => {
  const fixture = makeFixture()
  try {
    fixture.store.atomic((db) => {
      db.query("UPDATE runner_nodes SET state='running'").run()
    })
    new HandoffStore(fixture.store.repository).recordConcern(
      {
        requestID: "concern-request",
        concernID: crypto.randomUUID(),
        sourceAttemptID: firstAttemptID,
        ruleID: "verify-rounds-repeated",
        reason: "3 verification rounds",
        evidenceBoundary: { fromSequence: 0, throughSequence: 1 },
        evidence: [
          {
            kind: "trajectory",
            reference: "runner:1",
            note: "n; magnitude=3; action=takeover; because=Rounds keep failing",
          },
        ],
      },
      DETECTOR_ACTOR,
    )
    const directory = fixture.store.repository.projectDirectory
    const parse = JSON.parse
    let concernParses = 0
    JSON.parse = ((text: string, ...rest: []) => {
      if (text.includes("evidenceBoundary")) concernParses++
      return parse(text, ...rest)
    }) as typeof JSON.parse
    try {
      const other = fixture.store.read((db) =>
        openConcerns(db, directory, { taskID: "00000000-0000-4000-8000-000000000000" }),
      )
      expect(other).toEqual([])
      expect(concernParses).toBe(0)
      const mine = fixture.store.read((db) => openConcerns(db, directory, { taskID }))
      expect(mine.map((concern) => concern.attemptID)).toEqual([firstAttemptID])
      expect(concernParses).toBe(1)
    } finally {
      JSON.parse = parse
    }
  } finally {
    fixture.close()
  }
})
