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
          status: "error",
          input: {
            command: "bun test src/trajectory",
            summary: "AUDIT_SAFE_ARGUMENT_CANARY",
            arguments: {
              context: { messages: [{ type: "reasoning", text: "AUDIT_PRIVATE_INPUT_CANARY" }] },
              state: { input: "AUDIT_FULL_INPUT_CANARY" },
            },
          },
          content: [
            {
              type: "text",
              text: JSON.stringify({
                summary: "AUDIT_SAFE_RESULT_CANARY",
                messages: [{ type: "reasoning", text: "AUDIT_PRIVATE_RESULT_CANARY" }],
                state: { input: "AUDIT_FULL_INPUT_CANARY" },
              }),
            },
          ],
          error: {
            type: "ToolError",
            message: JSON.stringify({
              summary: "AUDIT_SAFE_ERROR_CANARY",
              details: [{ type: "reasoning", text: "AUDIT_PRIVATE_ERROR_CANARY" }],
            }),
          },
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
      retainsNestedErrorReasoning: serialized.includes("AUDIT_PRIVATE_ERROR_CANARY"),
      retainsSafeArgumentSummary: serialized.includes("AUDIT_SAFE_ARGUMENT_CANARY"),
      retainsSafeResultSummary: serialized.includes("AUDIT_SAFE_RESULT_CANARY"),
      retainsSafeErrorSummary: serialized.includes("AUDIT_SAFE_ERROR_CANARY"),
      applicationDataRead: false,
      applicationDataModified: false,
    }),
  )
} finally {
  fixture.close()
}
