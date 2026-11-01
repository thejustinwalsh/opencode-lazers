import { makeFixture, cursorSecret, taskID } from "../../../../test/trajectory/fixture.ts"
import { inspectTrajectory } from "../../../../src/trajectory/read.ts"
import { InspectTrajectoryInput } from "../../../../src/trajectory/schema.ts"

const fixture = makeFixture()
try {
  const session = fixture.sessions.get("ses-failed")!
  session.messages.push({
    id: "audit-canary-message",
    type: "assistant",
    time: { created: 1100 },
    content: [
      {
        type: "tool",
        id: "audit-canary-call",
        name: "execute",
        state: {
          status: "completed",
          input: {
            context: { messages: [{ type: "reasoning", text: "AUDIT_PRIVATE_INPUT_CANARY" }] },
          },
          content: [
            {
              type: "text",
              text: JSON.stringify({
                messages: [{ type: "reasoning", text: "AUDIT_PRIVATE_RESULT_CANARY" }],
                state: { input: "AUDIT_FULL_INPUT_CANARY" },
              }),
            },
          ],
        },
        time: { ran: 1100, completed: 1110 },
      },
    ],
  } as never)
  const report = await inspectTrajectory(
    fixture.store,
    fixture.host,
    "project",
    InspectTrajectoryInput.parse({ taskID, limit: 50 }),
    cursorSecret,
  )
  const serialized = JSON.stringify(report.trajectory.events)
  console.log(
    JSON.stringify({
      fixture: "Existing isolated temporary SQLite trajectory fixture",
      boundary: "Real inspectTrajectory report",
      retainsNestedInputReasoning: serialized.includes("AUDIT_PRIVATE_INPUT_CANARY"),
      retainsNestedResultReasoning: serialized.includes("AUDIT_PRIVATE_RESULT_CANARY"),
      retainsFullResultInput: serialized.includes("AUDIT_FULL_INPUT_CANARY"),
      applicationDataRead: false,
      applicationDataModified: false,
    }),
  )
} finally {
  fixture.close()
}
