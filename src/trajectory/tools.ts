import type { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { z } from "zod"
import type { RunnerStore } from "../runner/store.ts"
import { acquireReaderPool } from "../streams/pool.ts"
import { openStream } from "../streams/client.ts"
import { trajectoryEventsSource } from "../streams/sources/trajectory.ts"
import { trajectoryEventColumns } from "../streams/sources/trajectory-ref.ts"
import { privacyStats, safeError } from "./privacy.ts"
import { declareInput } from "../tool-input.ts"
import { InspectTrajectoryInput } from "./schema.ts"
import { openReadOnlyTrajectoryStore } from "./store.ts"

type ToolContext = Pick<Plugin.Context, "permission" | "tool">

/**
 * One window of a task's timeline (`trajectory.events`, the stream the Trajectory panel reads),
 * read on the server with the tool's own permission check. The continuation is the edge: the
 * `ref` of the last row, which the next call reads from (a stream anchored on a key starts at it).
 */
async function readTrajectoryWindow(
  path: string,
  projectDirectory: string,
  sessionID: string,
  input: InspectTrajectoryInput,
) {
  // The task is the project's: two point reads on a short read-only connection.
  const connection = openReadOnlyTrajectoryStore(path, projectDirectory)
  let taskID: string | undefined
  try {
    taskID =
      input.taskID ??
      connection.store.read(
        (db) =>
          db
            .query<{ task_id: string }, [string, string]>(
              "SELECT task_id FROM runner_attempts WHERE project_directory=? AND id=?",
            )
            .get(projectDirectory, input.attemptID!)?.task_id,
      )
    const known =
      taskID !== undefined &&
      connection.store.read((db) =>
        db
          .query("SELECT 1 FROM tasks WHERE project_directory=? AND id=?")
          .get(projectDirectory, taskID!),
      )
    if (!known) taskID = undefined
  } finally {
    connection.close()
  }
  if (!taskID) throw new Error("No observation in this scope")
  const lease = acquireReaderPool(path)
  try {
    const stream = openStream(lease.pool, trajectoryEventsSource, {
      filter: {
        projectDirectory,
        scope: { kind: "project", sessionID },
        taskID,
        ...(input.attemptID ? { attemptID: input.attemptID } : {}),
      },
      order: "timeline",
      // One more than the page, so the end is known; a continued page starts on its marker.
      window: input.limit + (input.cursor ? 1 : 0) + 1,
      ...(input.cursor ? { anchor: { key: [input.cursor], place: "start" as const } } : {}),
      transport: "copy",
    })
    try {
      await stream.ready()
      // Rows are views into the frame: copy the fields before the stream closes.
      const rows = stream.items.map(
        (row) =>
          Object.fromEntries(
            Object.keys(trajectoryEventColumns).map((name) => [
              name,
              (row as Record<string, unknown>)[name],
            ]),
          ) as Record<string, unknown>,
      )
      if (input.cursor) {
        if (rows[0]?.ref !== input.cursor) throw new Error("Invalid trajectory cursor")
        rows.shift()
      }
      const events = rows.slice(0, input.limit)
      const more = rows.length > input.limit
      return {
        schemaVersion: 2,
        taskID,
        focusedAttemptID: input.attemptID ?? null,
        trajectory: {
          order: "sort_at, then sort_key, then ref (ascending)",
          limit: input.limit,
          events,
          nextCursor: more ? (events.at(-1)?.ref ?? null) : null,
          hasMore: more,
        },
      }
    } finally {
      stream.close()
    }
  } finally {
    lease.release()
  }
}

export function registerTrajectoryTools(ctx: ToolContext, store: RunnerStore) {
  const path = store.repository.path
  const projectDirectory = store.repository.projectDirectory
  return ctx.tool.transform((editor) => {
    editor.add({
      name: "lz-inspect-trajectory",
      description:
        "Read one window of a project-owned worker task's stored timeline (transitions, effects, checks, progress, model steps with route/tokens/errors, tool calls), oldest first. Provide exactly one taskID or attemptID (an attempt's view keeps the task's plan-level rows); continue with the returned nextCursor and unchanged limit. Rows carry ids, times, states, routes and error names only, never message text, tool input or output.",
      input: declareInput(InspectTrajectoryInput),
      output: z.toJSONSchema(z.record(z.string(), z.unknown()), { io: "output" }),
      options: {
        codemode: true,
        pinned: true,
        permission: "lz-inspect-trajectory",
      },
      execute: (input, call) =>
        ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lz-inspect-trajectory",
            resources: ["*"],
          })
          .pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: async () => {
                  const report = await readTrajectoryWindow(
                    path,
                    projectDirectory,
                    call.sessionID,
                    InspectTrajectoryInput.parse(input),
                  )
                  return { content: JSON.stringify(report), output: report }
                },
                catch: (error) => new Tool.Error({ message: safeError(error, privacyStats()) }),
              }),
            ),
          ),
    })
  })
}
