import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Stream } from "effect"
import { ProgressRecorder } from "../progress/recorder.ts"
import { registerObservability } from "./rpc.ts"
import type { ObservationReads } from "./read.ts"
import type { LiveRadarResponse } from "./contract.ts"
import { firstAttemptID, makeFixture } from "../../test/trajectory/fixture.ts"
import { operationalReads } from "../../test/radar/operational.ts"

type Scope = { kind: "session"; sessionID: string } | { kind: "project"; sessionID: string }
type Handlers = {
  liveRadar(input: { scope: Scope; includeUnmanagedSessions: boolean }): Effect.Effect<unknown>
}

test("registered liveRadar and progressive history expose supported targets without arguments", async () => {
  const fixture = makeFixture()
  try {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(firstAttemptID),
    )
    const recorder = new ProgressRecorder(fixture.store, "project")
    const observations = [
      {
        tool: "read",
        messageID: "msg-read-target",
        callID: "call-read-target",
        input: { path: "src/read.ts", content: "READ CONTENT DECOY", token: "READ SECRET DECOY" },
      },
      {
        tool: "edit",
        messageID: "msg-edit-target",
        callID: "call-edit-target",
        input: {
          path: `${fixture.directory}/src/edit.ts`,
          oldText: "EDIT BODY DECOY",
          newText: "PROPOSED WRITE DECOY",
          attachment: "ATTACHMENT DECOY",
        },
      },
      {
        tool: "patch",
        messageID: "msg-patch-target",
        callID: "call-patch-target",
        input: {
          patchText: [
            "*** Begin Patch",
            "*** Update File: src/patched.ts",
            "+PATCH BODY DECOY",
            "*** End Patch",
          ].join("\n"),
          password: "PATCH SECRET DECOY",
        },
      },
      {
        tool: "patch",
        messageID: "msg-malformed-target",
        callID: "call-malformed-target",
        input: { patchText: `*** Begin Patch\n${"x".repeat(17_000)}` },
      },
    ]
    for (const [index, call] of observations.entries()) {
      recorder.recordToolTargets({
        ...call,
        sessionID: "ses-failed",
        agent: "lazers-implementor",
      })
      recorder.recordNativeEvent({
        id: `evt-target-start-${index}`,
        type: "session.tool.input.started",
        created: 60_000 + index,
        data: {
          sessionID: "ses-failed",
          assistantMessageID: call.messageID,
          id: call.callID,
          name: call.tool,
        },
      })
      if (call.callID === "call-edit-target")
        recorder.recordNativeEvent({
          id: "evt-target-failed",
          type: "session.tool.failed",
          created: 60_100,
          data: {
            sessionID: "ses-failed",
            assistantMessageID: call.messageID,
            id: call.callID,
            error: { type: "ToolError", message: "native edit failed" },
          },
        })
    }

    const reads = operationalReads(fixture) as ObservationReads
    const scope: Scope = { kind: "project", sessionID: "ses-owner" }
    let handlers: Handlers | undefined
    const context = {
      rpc: {
        register: (_definition: unknown, methods: Handlers) => {
          handlers = methods
          return Effect.succeed({ dispose: Effect.void, events: { emit: () => Effect.void } })
        },
      },
      permission: { assert: () => Effect.void },
      session: {
        get: ({ sessionID }: { sessionID: string }) =>
          Effect.succeed({
            id: sessionID,
            projectID: "project",
            agent: "architect",
            time: { archived: undefined },
          }),
      },
      event: { subscribe: () => Stream.empty },
    } as unknown as Pick<Plugin.Context, "rpc" | "permission" | "session" | "event">
    const rpcContext = {
      error: (type: string, message: string, data: unknown) => ({ type, message, data }),
    }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerObservability(context, reads, "project")
          const projectLive = (yield* handlers!.liveRadar({
            scope,
            includeUnmanagedSessions: false,
          })) as LiveRadarResponse
          expect(projectLive.freshness.runner).toBe("current")
          expect(projectLive.coverage.nativeContextLoads).toBe(0)
          const calls = new Map(projectLive.calls.map((call) => [call.callID, call]))
          expect(calls.get("call-read-target")?.fileTargets).toEqual({
            coverage: "observed",
            operation: "read",
            paths: ["src/read.ts"],
          })
          expect(calls.get("call-edit-target")).toMatchObject({
            status: "failed",
            fileTargets: { coverage: "observed", operation: "edit", paths: ["src/edit.ts"] },
          })
          expect(calls.get("call-patch-target")?.fileTargets).toEqual({
            coverage: "observed",
            operation: "patch",
            paths: ["src/patched.ts"],
          })
          expect(calls.get("call-malformed-target")?.fileTargets).toEqual({
            coverage: "omitted",
            operation: "patch",
            paths: [],
          })

          const sessionLive = (yield* handlers!.liveRadar({
            scope: { kind: "session", sessionID: "ses-failed" },
            includeUnmanagedSessions: false,
          })) as LiveRadarResponse
          expect(sessionLive.calls.map((call) => call.callID)).toContain("call-edit-target")
          const history = fixture.store.read((db) =>
            db
              .query<{ call_id: string; file_targets_json: string | null }, []>(
                "SELECT call_id,file_targets_json FROM runner_progress_display WHERE file_targets_json IS NOT NULL",
              )
              .all(),
          )
          expect(
            JSON.parse(
              history.find((row) => row.call_id === "call-edit-target")!.file_targets_json!,
            ),
          ).toEqual({
            coverage: "observed",
            operation: "edit",
            paths: ["src/edit.ts"],
          })
          const exposed = JSON.stringify({ projectLive, sessionLive, history })
          for (const decoy of [
            "READ CONTENT DECOY",
            "READ SECRET DECOY",
            "EDIT BODY DECOY",
            "PROPOSED WRITE DECOY",
            "ATTACHMENT DECOY",
            "PATCH BODY DECOY",
            "PATCH SECRET DECOY",
          ])
            expect(exposed).not.toContain(decoy)
          const stored = fixture.store.progressFacts([firstAttemptID])
          expect(stored.some((fact) => fact.payload.includes("PATCH BODY DECOY"))).toBe(false)
          expect(stored.some((fact) => fact.payload.includes("PROPOSED WRITE DECOY"))).toBe(false)
        }),
      ),
    )
  } finally {
    fixture.close()
  }
})
