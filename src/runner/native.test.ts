import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { DateTime, Effect, Schema } from "effect"
import { Worktree } from "@opencode/schema/worktree"
import { AbsolutePath } from "@opencode/schema/schema"
import type { Plugin } from "@opencode/plugin/effect"
import { TaskRepository } from "../storage.ts"
import workerInstructions from "../implementor.md" with { type: "text" }
import { latestContextTokens, nativeHost } from "./native.ts"
import type { NativeInboxClient, NativeInboxDependencies } from "./native.ts"
import type { OutcomeInboxEntry, OutcomeOwnership } from "./inbox.ts"
import { registerWorker } from "./roles.ts"
import type { RunnerStore } from "./store.ts"
import { nativeLivenessFixture } from "../../test/runner-native-liveness/fixture.ts"
import { makeFixture as makeTrajectoryFixture } from "../../test/trajectory/fixture.ts"

type NativeRevalidationOptions = {
  messages?: unknown[]
  history?: unknown[]
  sessionError?: unknown
  inboxError?: unknown
  inbox?: unknown[]
  contextAt?: (read: number, messages: unknown[]) => unknown[]
  sessionAt?: (read: number, session: Record<string, unknown>) => Record<string, unknown>
  active?: Record<string, { type: "running" }>
  permissions?: Array<{ id: string; sessionID: string }>
  forms?: Array<{ id: string; sessionID: string }>
  shells?: unknown[]
  permissionDirectory?: (requested: string) => string
  formDirectory?: (requested: string) => string
  shellDirectory?: (requested: string) => string
  omitShellList?: boolean
  /** The worker location is not loaded in the host; default is loaded. */
  unloadedLocation?: boolean
  retainedMessageAt?: (id: string, message: unknown) => unknown
}

function nativeRevalidationHost(
  repository: TaskRepository,
  options: NativeRevalidationOptions = {},
) {
  const assigned = repository.atomic((db) =>
    db
      .query<{ id: string; session_id: string; workspace: string }, [string]>(
        "SELECT id,session_id,workspace FROM runner_attempts WHERE session_id=?",
      )
      .get("ses-accepted"),
  )!
  const binding = {
    sessionID: assigned.session_id,
    projectID: "project",
    attemptID: assigned.id,
    workspace: assigned.workspace,
  }
  const now = DateTime.nowUnsafe()
  const baseSession: Record<string, unknown> = {
    id: binding.sessionID,
    parentID: "ses-owner",
    projectID: binding.projectID,
    agent: "lazers-implementor",
    metadata: { lazersAttemptID: binding.attemptID },
    location: { directory: binding.workspace },
    time: { created: now, updated: now, idle: now },
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    outcome: "succeeded",
    model: { providerID: "openai", id: "gpt-6-luna" },
  }
  const messages = options.messages ?? [
    { id: "msg_current_input", type: "user", text: "Continue" },
    {
      id: "msg_assistant_terminal",
      type: "assistant",
      time: { created: now, completed: now },
      finish: "stop",
      content: [],
    },
  ]
  let contextReads = 0
  let sessionReads = 0
  const locationReads: Array<{ kind: string; requested: string; returned: string }> = []
  const nativeClient = {
    server: { info: async () => ({ pid: 42, version: "2.2.5" }) },
    session: {
      message: {
        get: async ({ messageID }: { messageID: string }) => {
          const message = (options.history ?? messages).find(
            (entry) => testNativeObject(entry)?.id === messageID,
          )
          if (!message) throw new Error("Retained input is unavailable")
          return options.retainedMessageAt?.(messageID, message) ?? message
        },
      },
      active: async () => options.active ?? {},
      inbox: {
        list: async () => {
          if (options.inboxError instanceof Error) throw options.inboxError
          if (typeof options.inboxError === "object" && options.inboxError !== null)
            throw Object.assign(new Error("Simulated native inbox failure"), options.inboxError)
          if (options.inboxError !== undefined) throw new Error("Simulated native inbox failure")
          return options.inbox ?? []
        },
      },
    },
    debug: {
      location: {
        list: async () => (options.unloadedLocation ? [] : [{ directory: binding.workspace }]),
      },
    },
    permission: {
      request: {
        list: async ({ location }: { location?: { directory?: string } } = {}) => {
          const requested = location?.directory ?? ""
          const returned = options.permissionDirectory?.(requested) ?? requested
          locationReads.push({ kind: "permission", requested, returned })
          return { location: { directory: returned }, data: options.permissions ?? [] }
        },
      },
    },
    form: {
      list: async ({ location }: { location?: { directory?: string } } = {}) => {
        const requested = location?.directory ?? ""
        const returned = options.formDirectory?.(requested) ?? requested
        locationReads.push({ kind: "form", requested, returned })
        return { location: { directory: returned }, data: options.forms ?? [] }
      },
    },
    shell: options.omitShellList
      ? undefined
      : {
          list: async ({ location }: { location?: { directory?: string } } = {}) => {
            const requested = location?.directory ?? ""
            const returned = options.shellDirectory?.(requested) ?? requested
            locationReads.push({ kind: "shell", requested, returned })
            return { location: { directory: returned }, data: options.shells ?? [] }
          },
        },
    message: {
      list: async ({ type }: { type: string }) => ({
        data: (options.history ?? messages).filter(
          (message) => testNativeObject(message)?.type === type,
        ),
        cursor: {},
      }),
    },
  } as unknown as NativeInboxClient
  const dependencies: NativeInboxDependencies = {
    discover: async () => ({ url: "https://opencode.localhost", auth: undefined }),
    make: () => nativeClient,
    processID: () => 42,
  }
  const context = {
    app: { version: "2.2.5" },
    location: { directory: repository.projectDirectory, project: { id: binding.projectID } },
    session: {
      get: () => {
        if (options.sessionError !== undefined) return Effect.fail(options.sessionError)
        const read = sessionReads++
        const current = options.sessionAt?.(read, baseSession) ?? baseSession
        return Effect.succeed(current as never)
      },
      context: () => {
        const read = contextReads++
        return Effect.succeed((options.contextAt?.(read, messages) ?? messages) as never)
      },
    },
  } as unknown as Plugin.Context
  return {
    host: nativeHost(context, repository, dependencies),
    binding,
    messages,
    locationReads,
    get contextReads() {
      return contextReads
    },
  }
}

function testNativeObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

import { NativeWorktreeCreationFailure, nativeWorktreeFailureEvidence } from "./startup-recovery.ts"

test("native adapter exposes inbox and paginated history reconciliation without claiming a sealed cutover", () => {
  const host = nativeHost(
    {
      location: { directory: "/project", project: { id: "project" } },
    } as unknown as Plugin.Context,
    {} as TaskRepository,
  )
  expect(typeof host.architectInputPage).toBe("function")
})

test("native worktrees use the host lifecycle with the admitted ref and returned directory", async () => {
  let removed: unknown
  let created: unknown
  let refreshed = false
  const host = nativeHost(
    {
      location: {
        directory: "/project",
        project: { id: "project", canonical: "/canonical-project" },
      },
      worktree: {
        create: (input: unknown) =>
          Effect.sync(() => {
            created = input
            return { directory: "/work/attempt-2" }
          }),
        refresh: () =>
          Effect.sync(() => {
            refreshed = true
          }),
        list: () => Effect.succeed([{ directory: "/work/attempt-2", strategy: "git" }]),
        remove: (input: unknown) =>
          Effect.sync(() => {
            removed = input
          }),
      },
    } as unknown as Plugin.Context,
    { projectDirectory: "/canonical-project" } as TaskRepository,
  )
  expect(await host.worktree({ directory: "/work/attempt", base: "a".repeat(40) })).toBe(
    "/work/attempt-2",
  )
  expect(created).toEqual({
    projectID: "project",
    from: "/canonical-project",
    directory: "/work",
    name: "attempt",
    branch: "a".repeat(40),
  })
  expect(await host.worktrees()).toEqual(["/work/attempt-2"])
  expect(refreshed).toBe(true)
  await host.removeWorktree("/work/attempt-2")
  expect(removed).toEqual({ projectID: "project", directory: "/work/attempt-2", force: false })
})

test("native worktree creation preserves typed terminal failure and uses canonical project source", async () => {
  let created: unknown
  class DirectoryUnavailableError extends Schema.TaggedError<DirectoryUnavailableError>()(
    "Worktree.DirectoryUnavailableError",
    { directory: AbsolutePath },
  ) {}

  const invoke = async (failureEffect: Effect.Effect<never, unknown>) => {
    const host = nativeHost(
      {
        location: {
          directory: "/removed-participant",
          project: { id: "project", canonical: "/canonical-project" },
        },
        worktree: {
          create: (input: unknown) => {
            created = input
            return failureEffect
          },
        },
      } as unknown as Plugin.Context,
      { projectDirectory: "/canonical-project" } as TaskRepository,
    )
    try {
      await host.worktree({ directory: "/work/attempt", base: "a".repeat(40) })
    } catch (error) {
      return error
    }
    throw new Error("Expected native worktree creation to fail")
  }

  const operationFailure = new Worktree.OperationError({
    message: "Native setup failed",
    forceRequired: false,
  })
  const operationError = await invoke(Effect.fail(operationFailure))
  expect(created).toEqual({
    projectID: "project",
    from: "/canonical-project",
    directory: "/work",
    name: "attempt",
    branch: "a".repeat(40),
  })
  expect(operationError).toBeInstanceOf(NativeWorktreeCreationFailure)
  expect(nativeWorktreeFailureEvidence(operationError)).toEqual({
    schema: "lazers-native-worktree-failure/v2",
    api: "worktree.create",
    nativeTag: "Worktree.OperationError",
    message: "Native setup failed",
    forceRequired: false,
  })

  const directoryError = await invoke(
    Effect.fail(new DirectoryUnavailableError({ directory: AbsolutePath.make("/missing-source") })),
  )
  expect(directoryError).toBeInstanceOf(NativeWorktreeCreationFailure)
  expect(nativeWorktreeFailureEvidence(directoryError)).toEqual({
    schema: "lazers-native-worktree-failure/v2",
    api: "worktree.create",
    nativeTag: "Worktree.DirectoryUnavailableError",
    directory: "/missing-source",
  })
})

test("native adapter leaves defects, interruption, lost responses and lookalikes uncertain", async () => {
  const lookalike = Object.assign(new Error("message only"), {
    _tag: "Worktree.OperationError",
    message: 42,
    forceRequired: false,
  })
  const httpEnvelope = {
    _tag: "WorktreeError",
    name: "WorktreeError",
    data: { message: "HTTP only" },
  }
  const directoryLookalike = Object.assign(new Error(""), {
    _tag: "Worktree.DirectoryUnavailableError",
    directory: "relative/source",
  })
  const defects = [
    Effect.fail(new Error("response lost")),
    Effect.fail(lookalike),
    Effect.fail(httpEnvelope),
    Effect.fail(directoryLookalike),
    Effect.die(new Worktree.OperationError({ message: "Defect, not a typed failure" })),
    Effect.interrupt,
  ]
  for (const failureEffect of defects) {
    const host = nativeHost(
      {
        location: { directory: "/project", project: { id: "project", canonical: "/project" } },
        worktree: { create: () => failureEffect },
      } as unknown as Plugin.Context,
      { projectDirectory: "/project" } as TaskRepository,
    )
    let failure: unknown
    try {
      await host.worktree({ directory: "/work/attempt", base: "a".repeat(40) })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeDefined()
    expect(failure).not.toBeInstanceOf(NativeWorktreeCreationFailure)
    expect(nativeWorktreeFailureEvidence(failure)).toBeUndefined()
  }
})

test("native adapter recognizes tagged failures from an independent temporary schema module", async () => {
  const sourceURL = import.meta.resolve("@opencode/schema/worktree")
  const sourcePath = fileURLToPath(sourceURL)
  const schemaDirectory = dirname(sourcePath)
  const independentDirectory = mkdtempSync(join(tmpdir(), "lazers-independent-schema-"))
  try {
    let independentSource = readFileSync(sourcePath, "utf8")
    const selfExport = 'export * as Worktree from "./worktree.js";\n'
    expect(independentSource.startsWith(selfExport)).toBe(true)
    independentSource = independentSource.slice(selfExport.length)
    expect(independentSource).toContain('from "effect";')
    independentSource = independentSource.replace(
      'from "effect";',
      `from ${JSON.stringify(import.meta.resolve("effect"))};`,
    )
    for (const dependency of ["event.js", "schema.js", "project.js"]) {
      const importPath = `from "./${dependency}";`
      expect(independentSource).toContain(importPath)
      independentSource = independentSource.replace(
        importPath,
        `from ${JSON.stringify(pathToFileURL(join(schemaDirectory, dependency)).href)};`,
      )
    }
    const implementationPath = join(independentDirectory, "worktree-copy-implementation.mjs")
    const modulePath = join(independentDirectory, "worktree-copy.mjs")
    writeFileSync(
      implementationPath,
      `${independentSource}\nexport class DirectoryUnavailableError extends Schema.TaggedError()("Worktree.DirectoryUnavailableError", { directory: AbsolutePath }) {}\n`,
    )
    writeFileSync(
      modulePath,
      'export * as Worktree from "./worktree-copy-implementation.mjs";\nexport { DirectoryUnavailableError } from "./worktree-copy-implementation.mjs";\n',
    )
    const independentSchema = await import(pathToFileURL(modulePath).href)
    const operationFailure = new independentSchema.Worktree.OperationError({
      message: "Independent strategy failure",
      forceRequired: true,
    })
    expect(operationFailure).not.toBeInstanceOf(Worktree.OperationError)
    operationFailure.name = "Untrusted constructor name"

    const directoryFailure = new independentSchema.DirectoryUnavailableError({
      directory: "/removed-source",
    })
    directoryFailure.name = "Untrusted constructor name"
    expect(directoryFailure).not.toBeInstanceOf(independentSchema.Worktree.OperationError)
    expect(nativeWorktreeFailureEvidence(operationFailure)).toEqual({
      schema: "lazers-native-worktree-failure/v2",
      api: "worktree.create",
      nativeTag: "Worktree.OperationError",
      message: "Independent strategy failure",
      forceRequired: true,
    })
    expect(nativeWorktreeFailureEvidence(directoryFailure)).toEqual({
      schema: "lazers-native-worktree-failure/v2",
      api: "worktree.create",
      nativeTag: "Worktree.DirectoryUnavailableError",
      directory: "/removed-source",
    })

    const runAdapter = async (typedFailure: unknown) => {
      const host = nativeHost(
        {
          location: {
            directory: "/removed-participant",
            project: { id: "project", canonical: "/canonical-project" },
          },
          worktree: {
            create: () => Effect.fail(typedFailure),
          },
        } as unknown as Plugin.Context,
        { projectDirectory: "/canonical-project" } as TaskRepository,
      )
      try {
        await host.worktree({ directory: "/work/attempt", base: "a".repeat(40) })
      } catch (error) {
        return error
      }
      throw new Error("Expected native worktree creation to fail")
    }

    expect(nativeWorktreeFailureEvidence(await runAdapter(operationFailure))).toEqual({
      schema: "lazers-native-worktree-failure/v2",
      api: "worktree.create",
      nativeTag: "Worktree.OperationError",
      message: "Independent strategy failure",
      forceRequired: true,
    })
    expect(nativeWorktreeFailureEvidence(await runAdapter(directoryFailure))).toEqual({
      schema: "lazers-native-worktree-failure/v2",
      api: "worktree.create",
      nativeTag: "Worktree.DirectoryUnavailableError",
      directory: "/removed-source",
    })
  } finally {
    rmSync(independentDirectory, { recursive: true, force: true })
  }
})

test("child prompt uses native move and verifies location before any model work", async () => {
  const calls: string[] = []
  let directory = "/parent"
  const host = nativeHost(
    {
      session: {
        get: () => Effect.sync(() => ({ location: { directory } })),
        instructions: { entry: { remove: () => Effect.void } },
        move: (_input: { directory: string }) =>
          Effect.sync(() => {
            calls.push("move")
          }),
        wait: () =>
          Effect.sync(() => {
            calls.push("wait")
            directory = "/worker"
          }),
        prompt: () =>
          Effect.sync(() => {
            calls.push("prompt")
            expect(directory).toBe("/worker")
          }),
      },
    } as unknown as Plugin.Context,
    {} as TaskRepository,
  )
  await host.prompt({
    sessionID: "ses_worker",
    id: "msg_work",
    directory: "/worker",
    text: "Fetch the task and implement it.",
  })
  expect(calls).toEqual(["move", "wait", "prompt"])
  await host.prompt({
    sessionID: "ses_worker",
    id: "msg_next",
    directory: "/worker",
    text: "Continue.",
  })
  expect(calls).toEqual(["move", "wait", "prompt", "prompt"])
})

test("retained repair uses public foreground wait and refuses to move a worker", async () => {
  const calls: string[] = []
  const host = nativeHost(
    {
      session: {
        get: () => Effect.succeed({ location: { directory: "/elsewhere" } }),
        wait: () =>
          Effect.sync(() => {
            calls.push("wait")
          }),
        move: () => {
          calls.push("move")
          return Effect.void
        },
        instructions: { entry: { remove: () => Effect.void } },
        prompt: () => {
          calls.push("prompt")
          return Effect.void
        },
      },
    } as unknown as Plugin.Context,
    {} as TaskRepository,
  )
  await host.waitForSession!("ses_worker")
  await expect(
    host.prompt({
      sessionID: "ses_worker",
      id: "msg_repair",
      directory: "/worker",
      moveIfNeeded: false,
      text: "Concrete defect: preserve the current worker location.",
    }),
  ).rejects.toThrow("refusing to move")
  expect(calls).toEqual(["wait"])
})

test("scope instructions use native durable keyed entries with lost-reply recovery and no model work", async () => {
  const entries = new Map<string, unknown>([["other-plugin", "preserve"]])
  let puts = 0
  let loseReply = true
  const host = nativeHost(
    {
      location: { project: { id: "project" } },
      session: {
        get: () =>
          Effect.succeed({
            id: "ses_worker",
            agent: "lazers-implementor",
            projectID: "project",
            location: { directory: "/worker" },
            metadata: { lazersAttemptID: "attempt" },
            time: {},
          }),
        instructions: {
          entry: {
            list: () => Effect.sync(() => [...entries].map(([key, value]) => ({ key, value }))),
            put: (input: { sessionID: string; key: string; value: unknown }) =>
              Effect.sync(() => {
                expect(input.sessionID).toBe("ses_worker")
                puts++
                entries.set(input.key, input.value)
                if (loseReply) throw new Error("Lost native put response")
              }),
          },
        },
        prompt: () => {
          throw new Error("Must not prompt")
        },
        synthetic: () => {
          throw new Error("Must not enqueue input")
        },
        move: () => {
          throw new Error("Must not move")
        },
        interrupt: () => {
          throw new Error("Must not interrupt")
        },
      },
    } as unknown as Plugin.Context,
    {} as TaskRepository,
  )
  const input = {
    sessionID: "ses_worker",
    projectID: "project",
    directory: "/worker",
    attemptID: "attempt",
    key: "lazers-scope-attempt-authorization",
    text: "Reviewed additive execution scope; original checks still apply.",
  }
  await expect(host.updateInstruction(input)).rejects.toThrow("Lost native put response")
  loseReply = false
  await host.updateInstruction(input)
  await host.updateInstruction(input)
  expect(puts).toBe(1)
  expect(entries.get("other-plugin")).toBe("preserve")
  expect(entries.get(input.key)).toBe(input.text)
})

test("scope instruction ownership rejects foreign, moved, replaced and archived targets before native mutation", async () => {
  for (const mismatch of [
    "session",
    "agent",
    "project",
    "directory",
    "attempt",
    "archived",
    "host-project",
  ]) {
    let instructionCalls = 0
    const host = nativeHost(
      {
        location: { project: { id: mismatch === "host-project" ? "foreign" : "project" } },
        session: {
          get: () =>
            Effect.succeed({
              id: mismatch === "session" ? "ses_foreign" : "ses_worker",
              agent: mismatch === "agent" ? "architect" : "lazers-implementor",
              projectID: mismatch === "project" ? "foreign" : "project",
              location: { directory: mismatch === "directory" ? "/elsewhere" : "/worker" },
              metadata: { lazersAttemptID: mismatch === "attempt" ? "replaced" : "attempt" },
              time: mismatch === "archived" ? { archived: DateTime.nowUnsafe() } : {},
            }),
          instructions: {
            entry: {
              list: () =>
                Effect.sync(() => {
                  instructionCalls++
                  return []
                }),
              put: () =>
                Effect.sync(() => {
                  instructionCalls++
                }),
            },
          },
        },
      } as unknown as Plugin.Context,
      {} as TaskRepository,
    )
    await expect(
      host.updateInstruction({
        sessionID: "ses_worker",
        projectID: "project",
        directory: "/worker",
        attemptID: "attempt",
        key: "scope",
        text: "Allow test",
      }),
    ).rejects.toThrow("owned worker attempt")
    expect(instructionCalls).toBe(0)
  }
})

test("scope instructions require matching readback rather than trusting a successful native reply", async () => {
  let puts = 0
  const host = nativeHost(
    {
      location: { project: { id: "project" } },
      session: {
        get: () =>
          Effect.succeed({
            id: "ses_worker",
            agent: "lazers-implementor",
            projectID: "project",
            location: { directory: "/worker" },
            metadata: { lazersAttemptID: "attempt" },
            time: {},
          }),
        instructions: {
          entry: {
            list: () => Effect.succeed([{ key: "scope", value: "old value" }]),
            put: () =>
              Effect.sync(() => {
                puts++
              }),
          },
        },
      },
    } as unknown as Plugin.Context,
    {} as TaskRepository,
  )
  await expect(
    host.updateInstruction({
      sessionID: "ses_worker",
      projectID: "project",
      directory: "/worker",
      attemptID: "attempt",
      key: "scope",
      text: "Allow test",
    }),
  ).rejects.toThrow("no native readback")
  expect(puts).toBe(1)
})

test("worker guidance teaches bundled task discovery and optional progressive skill use", () => {
  expect(workerInstructions).toContain('tools["lz-get-task"](...)')
  expect(workerInstructions).toContain("read the working source directly as needed")
  expect(workerInstructions).toContain("optional\nnative skill")
  expect(workerInstructions).toContain("unavailable suggestion does not block")
  expect(workerInstructions).toContain("Do not launch subagents")
  expect(workerInstructions).toContain("relative to the assigned LAZERS checkout")
  expect(workerInstructions).toContain("mandatory task\nconstraint may separately authorize")
  expect(workerInstructions).toContain("specifically named external\ncheckout")
  expect(workerInstructions).toContain("limited to explicitly bounded paths")
  expect(workerInstructions).toContain("not implied by context, guidance, read access")
  expect(workerInstructions).toContain("Follow normal native host permissions")
  expect(workerInstructions).toContain("never bypass a denial")
})

test("optional skills are not resolved, and only the legacy LAZERS entry is removed before prompting", async () => {
  const entries = new Map<string, unknown>([
    ["lazers-required-skills", "SECRET_SKILL_BODY_CANARY"],
    ["other-plugin", "keep this entry"],
  ])
  let prompts = 0
  let skillLists = 0
  let skillPermissions = 0
  let removals = 0
  const host = nativeHost(
    {
      skill: {
        list: () => {
          skillLists++
          throw new Error("A suggestion is unavailable")
        },
      },
      permission: {
        assert: () => {
          skillPermissions++
          throw new Error("Skill permission denied")
        },
      },
      session: {
        get: () => Effect.succeed({ location: { directory: "/worker" } }),
        instructions: {
          entry: {
            remove: (input: { key: string }) =>
              Effect.sync(() => {
                removals++
                expect(input.key).toBe("lazers-required-skills")
                entries.delete(input.key)
              }),
          },
        },
        prompt: () =>
          Effect.sync(() => {
            expect(entries.has("lazers-required-skills")).toBe(false)
            prompts++
          }),
      },
    } as unknown as Plugin.Context,
    {} as TaskRepository,
  )
  const input = {
    sessionID: "ses_worker",
    id: "msg_worker",
    directory: "/worker",
    text: "Implement the task",
  }
  await host.prompt(input)
  await host.prompt(input)
  expect(entries).toEqual(new Map([["other-plugin", "keep this entry"]]))
  expect(removals).toBe(2)
  expect(skillLists).toBe(0)
  expect(skillPermissions).toBe(0)
  expect(prompts).toBe(2)
})

test("a host that fails to move the child cannot receive its work prompt", async () => {
  let prompted = false
  const host = nativeHost(
    {
      session: {
        get: () => Effect.succeed({ location: { directory: "/parent" } }),
        move: () => Effect.void,
        wait: () => Effect.void,
        prompt: () =>
          Effect.sync(() => {
            prompted = true
          }),
      },
    } as unknown as Plugin.Context,
    {} as TaskRepository,
  )
  await expect(
    host.prompt({
      sessionID: "ses_worker",
      id: "msg_work",
      directory: "/worker",
      text: "Implement.",
    }),
  ).rejects.toThrow("assigned worktree")
  expect(prompted).toBe(false)
})

test("native worker selection survives role registration and reaches native creation unchanged", async () => {
  const model = { providerID: "custom-provider", id: "native-selected", variant: "deep" }
  const routes = [
    model,
    { providerID: "opencode-go", id: "qwen3.8-flash", variant: "xhigh" },
    { providerID: "private-provider", id: "missing-capability-metadata", variant: "max" },
    { providerID: "custom-provider", id: "empty-variant-route", variant: "" },
  ]
  const agent = { model, permissions: [] }
  const created: { model: unknown }[] = []
  let catalogReads = 0
  let fail = false
  const ctx = {
    location: { directory: "/work" },
    permission: { hook: () => Effect.void },
    agent: {
      get: () => Effect.succeed({ data: agent }),
      transform: (transform: (editor: unknown) => void) =>
        Effect.sync(() =>
          transform({
            update: (_id: string, update: (value: typeof agent) => void) => update(agent),
          }),
        ),
    },
    model: {
      list: () =>
        Effect.sync(() => {
          catalogReads++
          return {
            data: [
              {
                providerID: "opencode-go",
                id: "qwen3.8-flash",
                enabled: false,
                capabilities: { tools: false, input: ["text"], output: ["text"] },
              },
              {
                providerID: "private-provider",
                id: "missing-capability-metadata",
                enabled: true,
              },
            ],
          }
        }),
    },
    session: {
      hook: () => Effect.void,
      create: (input: { model: unknown }) =>
        Effect.sync(() => {
          if (fail) throw new Error("Native route error")
          created.push(input)
        }),
    },
    tool: { hook: () => Effect.void },
  } as unknown as Plugin.Context
  await Effect.runPromise(
    Effect.scoped(
      registerWorker(ctx, {
        repository: { path: "/synthetic/native-roles.sqlite", projectDirectory: "/work" },
      } as RunnerStore),
    ),
  )
  const host = nativeHost(ctx, {} as TaskRepository)
  for (const [index, route] of routes.entries()) {
    agent.model = route
    expect(await host.workerModel!()).toEqual(route)
    await host.create({
      id: `ses_child_${index}`,
      parentID: "ses_owner",
      agent: "lazers-implementor",
      model: route,
      directory: "/work",
      title: "task",
      attemptID: "attempt",
    })
  }
  expect(created.map(({ model: selected }) => selected)).toEqual(routes)
  // Catalog metadata is advice; native create forwards each selected route directly.
  expect(catalogReads).toBe(0)
  fail = true
  await expect(
    host.create({
      id: "ses_child",
      parentID: "ses_owner",
      agent: "lazers-implementor",
      model,
      directory: "/work",
      title: "task",
      attemptID: "attempt",
    }),
  ).rejects.toThrow("Native route error")
  expect(created).toHaveLength(routes.length)
})

function nativeOutcomeFixture(options: {
  updatedAt?: () => number
  pid?: number
  unavailable?: boolean
  archiveReadback?: boolean
  loseUpdateResponse?: boolean
  loadedLocations?: string[]
  retainedSessionDirectories?: string[]
  activeSessionDirectories?: string[]
  activeInventoryUnavailable?: boolean
  inbox?: OutcomeInboxEntry[]
  messagePage?: (cursor?: string) => {
    data: {
      id: string
      type: string
      metadata?: Record<string, unknown>
      content?: unknown[]
      finish?: string | null
      time?: { completed?: number }
      error?: unknown
    }[]
    cursor: { next?: string | null }
  }
  sourceMessage?: (input: {
    sessionID: string
    messageID: string
  }) => Record<string, unknown> | Promise<Record<string, unknown>>
  onUpdate?: (input: { sessionID: string; archived: boolean }) => void
  onCancel?: (inboxID: string) => void
  onSynthetic?: (input: unknown) => void
}) {
  const entries = options.inbox ?? []
  const loadedLocations = options.loadedLocations ?? []
  const evictedLocations: string[] = []
  const activeSessions = new Map(
    (options.activeSessionDirectories ?? []).map((directory, index) => [
      `ses_active_${index}`,
      directory,
    ]),
  )
  let listCalls = 0
  let archived = false
  const messageQueries: { sessionID?: string; cursor?: string; order?: string; limit?: number }[] =
    []
  const client = {
    server: { info: async () => ({ pid: options.pid ?? 42, version: "2.2.5" }) },
    session: {
      get: async (input?: { sessionID?: string }) => ({
        projectID: "project",
        agent: activeSessions.has(input?.sessionID ?? "") ? "lazers-implementor" : "architect",
        location: { directory: activeSessions.get(input?.sessionID ?? "") ?? "/project" },
        time: {
          ...(archived ? { archived: 1 } : {}),
          ...(options.updatedAt ? { updated: options.updatedAt() } : {}),
        },
      }),
      active: async () => {
        if (options.activeInventoryUnavailable)
          throw new Error("Active execution inventory unavailable")
        return Object.fromEntries(
          Array.from(activeSessions.keys(), (sessionID) => [sessionID, { type: "running" }]),
        )
      },
      synthetic: async (input: unknown) => options.onSynthetic?.(input),
      update: async (input: { sessionID: string; archived: boolean }) => {
        options.onUpdate?.(input)
        if (options.archiveReadback !== false) archived = input.archived
        if (options.loseUpdateResponse) throw new Error("update response lost")
      },
      list: async (input?: { directory?: string; cursor?: string }) => ({
        data: [
          ...(options.retainedSessionDirectories ?? []),
          ...(options.activeSessionDirectories ?? []),
        ]
          .filter((directory) => !input?.directory || directory === input.directory)
          .map((directory, index) => ({ id: `listed-${index}`, location: { directory } })),
        cursor: {},
      }),
      inbox: {
        list: async () => {
          listCalls++
          return entries.map((entry) => ({
            id: entry.id,
            sessionID: "ses_owner",
            time: { created: 1 },
            type: entry.type,
            delivery: entry.delivery,
            payload: { text: "fixture", ...(entry.metadata ? { metadata: entry.metadata } : {}) },
          }))
        },
        cancel: async (input: { inboxID: string }) => {
          options.onCancel?.(input.inboxID)
          const index = entries.findIndex((entry) => entry.id === input.inboxID)
          if (index >= 0) entries.splice(index, 1)
        },
      },
      message: {
        get: async (input: { sessionID: string; messageID: string }) =>
          options.sourceMessage?.(input),
      },
    },
    message: {
      list: async (input: {
        sessionID?: string
        cursor?: string
        order?: string
        limit?: number
      }) => {
        messageQueries.push(structuredClone(input))
        if (input.cursor !== undefined && input.order !== undefined)
          throw new Error("Cursor cannot be combined with order")
        return options.messagePage?.(input.cursor) ?? { data: [], cursor: { next: null } }
      },
    },
    debug: {
      location: {
        list: async () => loadedLocations.map((directory) => ({ directory })),
        evict: async (input?: { location?: { directory?: string } }) => {
          const directory = input?.location?.directory
          if (!directory) throw new Error("Missing explicit location for eviction")
          evictedLocations.push(directory)
          const index = loadedLocations.indexOf(directory)
          if (index >= 0) loadedLocations.splice(index, 1)
        },
      },
    },
  } as unknown as NativeInboxClient
  const dependencies = {
    discover: async () =>
      options.unavailable ? undefined : { url: "https://opencode.localhost", auth: undefined },
    make: () => client,
    processID: () => 42,
  } as NativeInboxDependencies
  const host = nativeHost(
    {
      app: { version: "2.2.5" },
      location: { directory: "/project", project: { id: "project" } },
    } as unknown as Plugin.Context,
    { projectDirectory: "/project" } as TaskRepository,
    dependencies,
  )
  return {
    host,
    entries,
    get listCalls() {
      return listCalls
    },
    messageQueries,
    evictedLocations,
    client,
  }
}

const ownership: OutcomeOwnership = {
  lazersKind: "runner-outcome",
  lazersProjectID: "project",
  lazersProjectDirectory: "/project",
  lazersPlanID: "plan-1",
  lazersOutboxID: "outbox-1",
  lazersMessageID: "msg_durable",
  lazersSessionID: "ses_owner",
  lazersStatus: "accepted",
  lazersVersion: 7,
}

test("native selected source-message reads are authenticated, bounded and privacy-filtered", async () => {
  const calls: string[] = []
  const fixture = nativeOutcomeFixture({
    sourceMessage: ({ sessionID, messageID }) => {
      calls.push(`${sessionID}:${messageID}`)
      if (messageID === "msg_private_input")
        return {
          id: messageID,
          type: "user",
          text: "Keep https://private.example/path and ghp_ABCDEFGHIJKLMNOPQRSTUVWX out of history",
          files: [{ name: "private.txt" }],
          agents: [{ name: "private-agent" }],
          skills: [{ name: "private-skill" }],
          metadata: { authorization: "private metadata" },
        }
      if (messageID === "msg_private_result")
        return {
          id: messageID,
          type: "assistant",
          metadata: { secret: "do not expose" },
          content: [
            { type: "text", text: "A useful answer with token=private12345678901234567890" },
            { type: "reasoning", text: "private chain of thought" },
            { type: "tool", callID: "call_private", state: { status: "completed" } },
            { type: "file", name: "private-attachment.txt" },
          ],
        }
      if (messageID === "msg_long_input")
        return { id: messageID, type: "synthetic", text: "x".repeat(4_100) }
      if (messageID === "msg_long_result")
        return {
          id: messageID,
          type: "assistant",
          content: [
            { type: "text", text: "a".repeat(3_995) },
            { type: "text", text: "b".repeat(100) },
          ],
        }
      return { id: messageID, type: "system", text: "not a supported source message" }
    },
  })

  const input = await fixture.host.architectSourceMessage!("ses_owner", "msg_private_input")
  expect(calls[0]).toBe("ses_owner:msg_private_input")
  expect(input).toMatchObject({ id: "msg_private_input", type: "user" })
  expect(input.text).toContain("[REDACTED]")
  expect(input.text).not.toContain("private.example")
  expect(input.text).not.toContain("ghp_ABCDEFGHIJKLMNOP")
  expect(input).not.toHaveProperty("metadata")
  expect(input.privacy).toMatchObject({ omittedAttachments: 3 })

  const result = await fixture.host.architectSourceMessage!("ses_owner", "msg_private_result")
  expect(result).toMatchObject({ id: "msg_private_result", type: "assistant" })
  expect(result.text).toContain("A useful answer")
  expect(result.text).toContain("[REDACTED]")
  expect(result.text).not.toContain("private chain of thought")
  expect(result.text).not.toContain("call_private")
  expect(result.text).not.toContain("private-attachment")
  expect(result).not.toHaveProperty("metadata")
  expect(result.privacy).toMatchObject({ omittedReasoning: 1, omittedUnsupportedParts: 2 })

  const long = await fixture.host.architectSourceMessage!("ses_owner", "msg_long_input")
  expect(Array.from(long.text).length).toBeLessThanOrEqual(4_012)
  expect(long.text).toContain("[truncated]")
  expect(long.privacy.truncated).toBe(1)
  const longResult = await fixture.host.architectSourceMessage!("ses_owner", "msg_long_result")
  expect(Array.from(longResult.text).length).toBeLessThanOrEqual(4_012)
  expect(longResult.text).toContain("[truncated]")
  expect(longResult.privacy.truncated).toBe(1)
  await expect(
    fixture.host.architectSourceMessage!("ses_owner", "msg_unsupported"),
  ).rejects.toThrow("not a user, synthetic or assistant message")
  expect(calls).toEqual([
    "ses_owner:msg_private_input",
    "ses_owner:msg_private_result",
    "ses_owner:msg_long_input",
    "ses_owner:msg_long_result",
    "ses_owner:msg_unsupported",
  ])
})

test("actionable notifications use the authenticated native client with durable ownership", async () => {
  let received: unknown
  const { host } = nativeOutcomeFixture({ onSynthetic: (input) => (received = input) })
  await host.notify({
    sessionID: "ses_owner",
    id: "msg_durable",
    text: "Review accepted artifact now",
    resume: true,
    metadata: ownership,
  })
  expect(received).toEqual({
    sessionID: "ses_owner",
    id: "msg_durable",
    text: "Review accepted artifact now",
    metadata: ownership,
    resume: true,
    delivery: "queue",
    description: "LAZERS task outcome",
  })
})

test("native cancellation rechecks exact ownership and preserves user, worker, and foreign inputs", async () => {
  const user: OutcomeInboxEntry = { id: "msg_user", type: "user", delivery: "queue" }
  const worker: OutcomeInboxEntry = {
    id: "msg_worker",
    type: "synthetic",
    delivery: "queue",
    metadata: { lazersKind: "worker-prompt" },
  }
  const foreign: OutcomeInboxEntry = {
    id: "msg_foreign",
    type: "synthetic",
    delivery: "queue",
    metadata: { ...ownership, lazersPlanID: "foreign-plan", lazersMessageID: "msg_foreign" },
  }
  const owned: OutcomeInboxEntry = {
    id: ownership.lazersMessageID,
    type: "synthetic",
    delivery: "queue",
    metadata: ownership,
  }
  const cancelled: string[] = []
  const fixture = nativeOutcomeFixture({
    inbox: [user, worker, foreign, owned],
    onCancel: (id) => cancelled.push(id),
  })
  expect(await fixture.host.outcomeInbox!("ses_owner")).toHaveLength(4)
  await fixture.host.cancelOutcome!({
    sessionID: "ses_owner",
    inboxID: owned.id,
    ownership,
  })
  expect(cancelled).toEqual([owned.id])
  expect(fixture.entries).toEqual([user, worker, foreign])
  await expect(
    fixture.host.cancelOutcome!({ sessionID: "ses_owner", inboxID: user.id, ownership }),
  ).rejects.toThrow("mismatched durable ownership")
  expect(cancelled).toEqual([owned.id])
})

test("native inbox refuses a discovered service owned by another process", async () => {
  const fixture = nativeOutcomeFixture({ pid: 900 })
  await expect(fixture.host.outcomeInbox!("ses_owner")).rejects.toThrow(
    "not this OpenCode host process",
  )
  expect(fixture.listCalls).toBe(0)
})

test("native cache retirement ignores retained history but refuses active or unknown execution", async () => {
  const clean = nativeOutcomeFixture({
    loadedLocations: ["/work/clean"],
    retainedSessionDirectories: ["/work/clean"],
  })
  expect(
    (await clean.client.session.list({ directory: "/work/clean", archived: false })).data,
  ).toHaveLength(1)
  expect(await clean.client.session.active()).toEqual({})
  expect(await clean.host.retireWorktreeLocation!("/work/clean")).toBe("evicted")
  expect(clean.evictedLocations).toEqual(["/work/clean"])

  const active = nativeOutcomeFixture({
    loadedLocations: ["/work/active"],
    activeSessionDirectories: ["/work/active"],
  })
  expect(await active.host.retireWorktreeLocation!("/work/active")).toBe("active-session")
  expect(active.evictedLocations).toEqual([])

  const unknown = nativeOutcomeFixture({
    loadedLocations: ["/work/unknown"],
    activeInventoryUnavailable: true,
  })
  expect(await unknown.host.retireWorktreeLocation!("/work/unknown")).toBe("unavailable")
  expect(unknown.evictedLocations).toEqual([])

  const absent = nativeOutcomeFixture({ loadedLocations: [] })
  expect(await absent.host.retireWorktreeLocation!("/work/absent")).toBe("not-loaded")
  expect(absent.evictedLocations).toEqual([])

  const current = nativeOutcomeFixture({ loadedLocations: ["/project"] })
  expect(await current.host.retireWorktreeLocation!("/project")).toBe("current-location")
  expect(current.evictedLocations).toEqual([])
})

test("native inbox does not start or substitute an unavailable service", async () => {
  const fixture = nativeOutcomeFixture({ unavailable: true })
  await expect(fixture.host.outcomeInbox!("ses_owner")).rejects.toThrow(
    "Native outcome inbox is unavailable",
  )
  expect(fixture.listCalls).toBe(0)
})

test("native archive uses the public client route and requires archived-state readback", async () => {
  const updates: { sessionID: string; archived: boolean }[] = []
  const fixture = nativeOutcomeFixture({ onUpdate: (input) => updates.push(input) })
  await fixture.host.updateSession!({ sessionID: "ses_owner", archived: true })
  expect(updates).toEqual([{ sessionID: "ses_owner", archived: true }])

  const noReadback = nativeOutcomeFixture({ archiveReadback: false })
  await expect(
    noReadback.host.updateSession!({ sessionID: "ses_owner", archived: true }),
  ).rejects.toThrow("public session readback")

  const lostResponse = nativeOutcomeFixture({ loseUpdateResponse: true })
  await expect(
    lostResponse.host.updateSession!({ sessionID: "ses_owner", archived: true }),
  ).rejects.toThrow("confirmed by public readback")
})

test("native Architect input reconciliation follows public message pagination and keeps original IDs", async () => {
  const cursors: (string | undefined)[] = []
  const fixture = nativeOutcomeFixture({
    inbox: [{ id: "msg_queued", type: "synthetic", delivery: "queue" }],
    messagePage: (cursor) => {
      cursors.push(cursor)
      return cursor
        ? {
            data: [{ id: "msg_late", type: "user" }],
            cursor: { next: null },
          }
        : {
            data: [
              { id: "msg_history", type: "user" },
              { id: "msg_queued", type: "synthetic" },
              { id: "msg_assistant", type: "assistant" },
            ],
            cursor: { next: "page-2" },
          }
    },
  })

  const first = await fixture.host.architectInputPage!("ses_owner")
  const second = await fixture.host.architectInputPage!("ses_owner", first.nextCursor ?? undefined)
  expect(cursors).toEqual([undefined, "page-2"])
  expect(fixture.messageQueries).toEqual([
    { sessionID: "ses_owner", limit: 100, order: "asc" },
    { sessionID: "ses_owner", limit: 100, cursor: "page-2" },
  ])
  expect(first.inbox.map((entry) => entry.id)).toEqual(["msg_queued"])
  expect(first.messages.map((entry) => entry.id)).toEqual([
    "msg_history",
    "msg_queued",
    "msg_assistant",
  ])
  expect(first.nextCursor).toBe("page-2")
  expect(second.messages.map((entry) => entry.id)).toEqual(["msg_late"])
  expect(second.nextCursor).toBeNull()
})

test("F-S3-1 native source hints skip unchanged history but detect session and inbox changes", async () => {
  let updatedAt = 1
  const inbox: OutcomeInboxEntry[] = []
  const f = nativeOutcomeFixture({ updatedAt: () => updatedAt, inbox })
  const first = await f.host.architectInputPage!("ses_owner")
  expect(first.observation).toEqual({ updatedAt: 1, inbox: "[]" })
  expect(f.messageQueries).toHaveLength(1)
  expect(await f.host.architectInputPage!("ses_owner", undefined, first.observation)).toMatchObject(
    { unchanged: true },
  )
  expect(f.messageQueries).toHaveLength(1)
  updatedAt = 2
  const changed = await f.host.architectInputPage!("ses_owner", undefined, first.observation)
  expect(changed.unchanged).toBeUndefined()
  expect(f.messageQueries).toHaveLength(2)
  inbox.push({ id: "msg_new", type: "synthetic", delivery: "queue" })
  expect(
    (await f.host.architectInputPage!("ses_owner", undefined, changed.observation)).inbox,
  ).toHaveLength(1)
  expect(f.messageQueries).toHaveLength(3)
})

test("native Architect history projects mutable assistant/tool status without private payloads", async () => {
  const privateCanary = "PRIVATE_TOOL_ARGUMENT_AND_REASONING_CANARY"
  const fixture = nativeOutcomeFixture({
    messagePage: () => ({
      data: [
        {
          id: "msg_tool_running",
          type: "assistant",
          time: {},
          content: [
            {
              type: "tool",
              name: "private-tool-name",
              state: { status: "running", input: { secret: privateCanary } },
            },
            { type: "reasoning", text: privateCanary },
          ],
        },
        {
          id: "msg_tool_failed",
          type: "assistant",
          finish: "error",
          error: { message: privateCanary },
          time: { completed: 7 },
          content: [
            {
              type: "tool",
              name: "private-tool-name",
              state: { status: "error", input: { secret: privateCanary } },
            },
          ],
        },
      ],
      cursor: { next: null },
    }),
  })

  const page = await fixture.host.architectInputPage!("ses_owner")
  expect(page.messages).toEqual([
    {
      id: "msg_tool_running",
      type: "assistant",
      result: {
        state: "running",
        finish: null,
        toolCounts: { running: 1, completed: 0, failed: 0, other: 0 },
      },
    },
    {
      id: "msg_tool_failed",
      type: "assistant",
      result: {
        state: "failed",
        finish: "error",
        toolCounts: { running: 0, completed: 0, failed: 1, other: 0 },
      },
    },
  ])
  expect(JSON.stringify(page)).not.toContain(privateCanary)
  expect(JSON.stringify(page)).not.toContain("private-tool-name")
})

test("a detailed worker read pages the current turn and never reads session.context", async () => {
  const now = DateTime.nowUnsafe()
  const fixture = nativeLivenessFixture({
    busy: now,
    idle: now,
    messages: [
      { id: "msg_user", type: "user", text: "Implement it" },
      {
        id: "msg_done",
        type: "assistant",
        time: { completed: 1 },
        finish: "stop",
        content: [
          { type: "tool", name: "edit", state: { status: "completed" } },
          { type: "text", text: "Done" },
        ],
      },
    ],
  })

  const heartbeat = await fixture.host.session("ses_worker")
  expect(fixture.messageListCalls).toHaveLength(0)
  expect(heartbeat?.tokens).toBe(20)
  expect(heartbeat?.tools).toBe(0)
  expect(heartbeat?.messages).toEqual([])
  expect(heartbeat?.busy).toBe(false)

  const detailed = await fixture.host.session("ses_worker", { messages: true })
  // One descending page ends at the turn's input; the whole conversation is never read.
  expect(fixture.messageListCalls).toEqual([
    { type: undefined, order: "desc", limit: 50, cursor: undefined },
  ])
  expect(fixture.contextReads).toBe(0)
  expect(detailed?.tools).toBe(1)
  expect(detailed?.turn).toEqual({ inputID: "msg_user", state: "completed" })
  expect(detailed?.messages).toEqual([
    { id: "msg_user", text: "Implement it" },
    { id: "msg_done", text: "Done" },
  ])
})

test("live idle check needs no hook report: a quiet worker reports zero shells and children", async () => {
  const fixture = nativeLivenessFixture({ idle: DateTime.nowUnsafe() })
  // A freshly constructed host has seen no experimental.idle hook (restart, eviction).
  for (const options of [undefined, { messages: true }]) {
    const session = await fixture.host.session("ses_worker", options)
    expect(session).toMatchObject({ busy: false, runningShells: 0, activeChildren: 0 })
    expect(session).not.toHaveProperty("background")
  }
})

test("live idle check counts only running shells whose cwd is inside the worktree", async () => {
  const directory = "/project/.worktrees/attempt"
  const fixture = nativeLivenessFixture({
    idle: DateTime.nowUnsafe(),
    directory,
    shells: [
      { id: "inside", status: "running", cwd: `${directory}/packages/a`, time: { started: 1 } },
      { id: "root", status: "running", cwd: directory, time: { started: 2 } },
      { id: "ended", status: "completed", cwd: directory, time: { started: 3, completed: 4 } },
      { id: "outside", status: "running", cwd: "/project", time: { started: 5 } },
      { id: "sibling", status: "running", cwd: `${directory}-other`, time: { started: 6 } },
    ],
  })
  expect((await fixture.host.session("ses_worker"))?.runningShells).toBe(2)
})

test("live idle check counts active descendants of the worker but not unrelated sessions", async () => {
  const fixture = nativeLivenessFixture({
    idle: DateTime.nowUnsafe(),
    active: {
      ses_child: { type: "running" },
      ses_grandchild: { type: "running" },
      ses_other: { type: "running" },
    },
    sessions: {
      ses_child: { parentID: "ses_worker", directory: "/project/.worktrees/attempt" },
      ses_grandchild: { parentID: "ses_child", directory: "/project/.worktrees/attempt" },
      ses_other: { parentID: "ses_unrelated", directory: "/elsewhere" },
      ses_unrelated: { directory: "/elsewhere" },
    },
  })
  expect((await fixture.host.session("ses_worker"))?.activeChildren).toBe(2)
})

test("compacted worker turns retain the actual latest input without replaying history", async () => {
  for (const latestType of ["user", "synthetic"] as const) {
    const fixture = nativeLivenessFixture({
      busy: DateTime.nowUnsafe(),
      idle: DateTime.nowUnsafe(),
      history: [
        { id: "msg_z_old", type: latestType === "user" ? "synthetic" : "user" },
        { id: "msg_a_current", type: latestType },
      ],
      messages: [
        { id: "msg_compaction", type: "compaction", status: "completed" },
        { id: "msg_done", type: "assistant", time: { completed: 1 }, finish: "stop", content: [] },
      ],
    })
    expect((await fixture.host.session("ses_worker", { messages: true }))?.turn).toEqual({
      inputID: "msg_a_current",
      state: "completed",
    })
  }
})

test("compacted worker with no response remains pending and no durable input stays unknown", async () => {
  for (const history of [[], [{ id: "msg_assigned", type: "user" }]]) {
    const fixture = nativeLivenessFixture({
      history,
      messages: [{ id: "msg_compaction", type: "compaction", status: "completed" }],
    })
    expect((await fixture.host.session("ses_worker", { messages: true }))?.turn).toEqual({
      inputID: history[0]?.id ?? null,
      state: history.length ? "pending" : "unknown",
    })
  }
})

test("a current failed idle marker completes an input that never received an assistant response", async () => {
  const now = DateTime.nowUnsafe()
  // The host's message list carries times as epoch milliseconds.
  const nowMillis = DateTime.toEpochMillis(now)
  for (const markerTime of [nowMillis, nowMillis - 1]) {
    const fixture = nativeLivenessFixture({
      idle: now,
      outcome: "failed",
      messages: [
        { id: "msg_assigned", type: "user", time: { created: nowMillis } },
        { id: "msg_idle", type: "idle", outcome: "failed", time: { created: markerTime } },
      ],
    })
    expect(await fixture.host.session("ses_worker", { messages: true })).toMatchObject({
      outcome: "failed",
      turn: {
        inputID: "msg_assigned",
        state: markerTime === nowMillis ? "completed" : "pending",
      },
    })
  }
})

test("orphaned busy timestamps and unfinished latest assistant override historical success", async () => {
  const unfinished = nativeLivenessFixture({
    sessionID: "ses_unfinished",
    busy: DateTime.nowUnsafe(),
    outcome: "succeeded",
    messages: [
      { id: "msg_assigned", type: "user", text: "Continue work" },
      {
        id: "msg_partial",
        type: "assistant",
        time: { created: 1 },
        content: [{ type: "tool", state: { status: "running" } }],
      },
    ],
  })
  const result = await unfinished.host.session("ses_unfinished", { messages: true })
  expect(result).toMatchObject({
    busy: false,
    outcome: "interrupted",
    turn: { inputID: "msg_assigned", state: "interrupted" },
  })

  const staleSucceeded = nativeLivenessFixture({
    sessionID: "ses_stale_success",
    busy: DateTime.nowUnsafe(),
    outcome: "succeeded",
  })
  expect(await staleSucceeded.host.session("ses_stale_success")).toMatchObject({
    busy: false,
    outcome: "interrupted",
  })
})

test("pending worker input and location-scoped approvals prevent terminal projection", async () => {
  const fixture = nativeLivenessFixture({
    sessionID: "ses_pending",
    busy: DateTime.nowUnsafe(),
    outcome: "succeeded",
    inbox: [{ id: "msg_queued", type: "user", delivery: "queue" }],
    permissions: [{ id: "permission", sessionID: "ses_pending" }],
    forms: [{ id: "form", sessionID: "ses_pending" }],
    messages: [
      { id: "msg_current", type: "user", text: "Continue" },
      {
        id: "msg_done",
        type: "assistant",
        time: { completed: 1 },
        finish: "stop",
        content: [{ type: "text", text: "Done" }],
      },
    ],
  })

  const result = await fixture.host.session("ses_pending", { messages: true })
  expect(result).toMatchObject({
    pendingInput: true,
    pendingPermissions: 1,
    pendingForms: 1,
    outcome: undefined,
  })
  expect(fixture.locationReads).toHaveLength(6)
  expect(
    fixture.locationReads.every((read) => read.directory === "/project/.worktrees/attempt"),
  ).toBe(true)
})

test("active/detail-read changes remain explicitly unstable and fail closed", async () => {
  const fixture = nativeLivenessFixture({
    sessionID: "ses_race",
    activeSnapshots: [{}, { ses_race: { type: "running" } }],
    outcome: "succeeded",
    messages: [
      { id: "msg_current", type: "user", text: "Complete" },
      {
        id: "msg_done",
        type: "assistant",
        time: { completed: 1 },
        finish: "stop",
        content: [{ type: "text", text: "Done" }],
      },
    ],
  })

  expect(await fixture.host.session("ses_race", { messages: true })).toMatchObject({
    busy: true,
    observationUnstable: true,
    outcome: undefined,
  })
})

test("cached native transport invalidates on process replacement and rediscovers current host", async () => {
  let expectedPID = 42
  let transportFailure: Error | undefined
  const fixture = nativeLivenessFixture({
    sessionID: "ses_replaced",
    active: { ses_replaced: { type: "running" } },
    expectedPID: () => expectedPID,
    activeError: () => transportFailure,
    serverInfo: (clientNumber) => ({ pid: clientNumber === 1 ? 42 : 43, version: "2.2.5" }),
  })
  expect((await fixture.host.session("ses_replaced"))?.busy).toBe(true)
  expect(fixture.identityReads).toBe(1)
  transportFailure = new Error("host process was replaced")
  await expect(fixture.host.session("ses_replaced")).rejects.toThrow("host process was replaced")
  expectedPID = 43
  transportFailure = undefined
  expect((await fixture.host.session("ses_replaced"))?.busy).toBe(true)
  expect(fixture.discoveries).toBe(2)
  expect(fixture.clients).toBe(2)
  expect(fixture.identityReads).toBe(2)
})

test("discovery, authentication, inventory, PID, and version failures remain explicit", async () => {
  const cases = [
    { options: { unavailable: true }, message: "Native outcome inbox is unavailable" },
    { options: { discoveryError: new Error("discovery failed") }, message: "discovery failed" },
    {
      options: { infoError: new Error("authentication failed") },
      message: "authentication failed",
    },
    { options: { activeError: new Error("inventory failed") }, message: "inventory failed" },
    {
      options: { serverInfo: () => ({ pid: 900, version: "2.2.5" }) },
      message: "not this OpenCode host process",
    },
    {
      options: { serverInfo: () => ({ pid: 42, version: "wrong" }) },
      message: "not this OpenCode host process",
    },
  ] as const

  for (const [index, scenario] of cases.entries()) {
    const fixture = nativeLivenessFixture({
      sessionID: `ses_unavailable_${index}`,
      ...scenario.options,
    })
    await expect(fixture.host.session(`ses_unavailable_${index}`)).rejects.toThrow(scenario.message)
    expect(fixture.discoveries).toBe(1)
  }
})

// Pinned core session/error.ts uses this tag, unlike the HTTP protocol error.
class CoreSessionNotFound extends Schema.TaggedError<CoreSessionNotFound>()(
  "Session.NotFoundError",
  { sessionID: Schema.String },
) {}

test("native session absence accepts the pinned core and protocol tags only for the requested ID", async () => {
  const fixture = makeTrajectoryFixture()
  try {
    for (const sessionError of [
      new CoreSessionNotFound({ sessionID: "ses-absent" }),
      { _tag: "SessionNotFoundError", sessionID: "ses-absent", message: "absent" },
    ]) {
      const adapter = nativeRevalidationHost(fixture.repository, { sessionError })
      expect(await adapter.host.session("ses-absent")).toBeNull()
      expect(adapter.contextReads).toBe(0)
    }
    for (const sessionError of [
      new CoreSessionNotFound({ sessionID: "ses-different" }),
      { _tag: "SessionNotFoundError", sessionID: "ses-different", message: "absent" },
      new Error("transport unavailable"),
      { _tag: "UnauthorizedError", message: "unauthorized" },
    ]) {
      const adapter = nativeRevalidationHost(fixture.repository, { sessionError })
      await expect(adapter.host.session("ses-absent")).rejects.toBeDefined()
      expect(adapter.contextReads).toBe(0)
    }
    const active = nativeRevalidationHost(fixture.repository, {
      sessionError: new CoreSessionNotFound({ sessionID: "ses-absent" }),
      active: { "ses-absent": { type: "running" } },
    })
    await expect(active.host.session("ses-absent")).rejects.toThrow(
      "absent while execution or input is observed",
    )
  } finally {
    fixture.close()
  }
})

test("only confirmed native absence permits a same-session missing inbox", async () => {
  const fixture = makeTrajectoryFixture()
  try {
    const sessionError = new CoreSessionNotFound({ sessionID: "ses-absent" })
    const inboxError = {
      _tag: "SessionNotFoundError",
      sessionID: "ses-absent",
      message: "Session not found: ses-absent",
    }
    expect(
      await nativeRevalidationHost(fixture.repository, {
        sessionError,
        inboxError,
      }).host.session("ses-absent"),
    ).toBeNull()
    for (const options of [
      { sessionError, inboxError: { ...inboxError, sessionID: "ses-other" } },
      { sessionError, inboxError: new Error("inbox transport unavailable") },
      { sessionError, inboxError, active: { "ses-absent": { type: "running" as const } } },
      { sessionError, inbox: [{ id: "pending", type: "user", delivery: "queue" }] },
      { inboxError: { ...inboxError, sessionID: "ses-accepted" } },
    ]) {
      await expect(
        nativeRevalidationHost(fixture.repository, options).host.session(
          options.sessionError ? "ses-absent" : "ses-accepted",
        ),
      ).rejects.toBeDefined()
    }
  } finally {
    fixture.close()
  }
})

test("Auditor prompt accepts native default readback and still rejects changed explicit effort", async () => {
  const model = { providerID: "opencode-go", id: "muse-spark-1.3-contributor" }
  let prompts = 0
  const host = nativeHost(
    {
      location: { project: { id: "project" } },
      session: {
        get: () =>
          Effect.succeed({
            id: "ses_auditor",
            agent: "auditor",
            projectID: "project",
            model: { ...model, variant: "default" },
            metadata: { lazersAttemptID: "attempt" },
            time: {},
            location: { directory: "/worker" },
          }),
        instructions: { entry: { remove: () => Effect.void } },
        prompt: () =>
          Effect.sync(() => {
            prompts++
          }),
      },
    } as unknown as Plugin.Context,
    {} as TaskRepository,
  )
  const input = {
    sessionID: "ses_auditor",
    id: "msg_work",
    directory: "/worker",
    attemptID: "attempt",
    model,
    text: "Audit the system",
  }
  await host.prompt(input)
  expect(prompts).toBe(1)
  await expect(host.prompt({ ...input, model: { ...model, variant: "high" } })).rejects.toThrow(
    "exact assigned session and route",
  )
  expect(prompts).toBe(1)
})

test("an unloaded worker location is observed without booting it", async () => {
  const fixture = nativeLivenessFixture({ idle: DateTime.nowUnsafe(), unloadedLocation: true })
  const session = await fixture.host.session("ses_worker")
  expect(session).toMatchObject({
    busy: false,
    runningShells: 0,
    pendingPermissions: 0,
    pendingForms: 0,
  })
  expect(fixture.locationReads).toEqual([])
})

test("a loaded worker location is still inspected for permissions, forms and shells", async () => {
  const fixture = nativeLivenessFixture({ idle: DateTime.nowUnsafe() })
  await fixture.host.session("ses_worker")
  expect(fixture.locationReads.map((read) => read.kind).sort()).toEqual([
    "form",
    "permission",
    "shell",
  ])
})

test("a step aborted by a location shutdown is not a completed turn while the session is active", async () => {
  // OpenCode resumes the session after the location reboots; the aborted step is the newest
  // message only until the resumed step appears.
  const aborted = [
    { id: "msg_user", type: "user", text: "Implement it" },
    {
      id: "msg_aborted",
      type: "assistant",
      time: { completed: 1 },
      finish: "error",
      error: { type: "aborted", message: "Step interrupted" },
      content: [
        {
          type: "tool",
          state: {
            status: "error",
            error: {
              type: "aborted",
              message: "Interaction cancelled because the location shut down",
            },
          },
        },
      ],
    },
  ]
  const rebooting = nativeLivenessFixture({
    busy: DateTime.nowUnsafe(),
    active: { ses_worker: { type: "running" } },
    messages: aborted,
  })
  for (const options of [undefined, { messages: true }]) {
    const session = await rebooting.host.session("ses_worker", options)
    expect(session).toMatchObject({ busy: true })
    expect(session).not.toHaveProperty("staleActive")
  }
})

test("an active entry contradicted by a completed turn, empty inbox and no shells counts as idle", async () => {
  const messages = [
    { id: "msg_user", type: "user", text: "Implement it" },
    {
      id: "msg_done",
      type: "assistant",
      time: { completed: 1 },
      finish: "stop",
      content: [{ type: "text", text: "Done" }],
    },
  ]
  const stale = nativeLivenessFixture({
    busy: DateTime.nowUnsafe(),
    active: { ses_worker: { type: "running" } },
    messages,
  })
  for (const options of [undefined, { messages: true }]) {
    expect(await stale.host.session("ses_worker", options)).toMatchObject({
      busy: false,
      staleActive: { cause: "completed-turn" },
    })
  }

  const streaming = nativeLivenessFixture({
    busy: DateTime.nowUnsafe(),
    active: { ses_worker: { type: "running" } },
    messages: [
      messages[0],
      { id: "msg_part", type: "assistant", time: { created: 1 }, content: [] },
    ],
  })
  expect(await streaming.host.session("ses_worker")).toMatchObject({ busy: true })

  const pending = nativeLivenessFixture({
    busy: DateTime.nowUnsafe(),
    active: { ses_worker: { type: "running" } },
    messages,
    inbox: [{ id: "inbox_1", type: "synthetic", delivery: "queue" }],
  })
  expect(await pending.host.session("ses_worker")).toMatchObject({ busy: true })

  const shell = nativeLivenessFixture({
    busy: DateTime.nowUnsafe(),
    active: { ses_worker: { type: "running" } },
    messages,
    shells: [
      { id: "sh", status: "running", cwd: "/project/.worktrees/attempt", time: { started: 1 } },
    ],
  })
  expect(await shell.host.session("ses_worker")).toMatchObject({ busy: true })
})

test("an Architect's context size is the newest request's prompt, not its cumulative spend", () => {
  const assistant = (input: number, read: number, write: number) =>
    ({
      type: "assistant",
      tokens: { input, output: 5, reasoning: 0, cache: { read, write } },
    }) as never
  expect(latestContextTokens([assistant(9, 90_000_000, 1), assistant(10, 40_000, 2_000)])).toBe(
    42_010,
  )
  expect(latestContextTokens([{ type: "user" } as never])).toBeUndefined()
})

function assistantMessage(id: string, text: string) {
  return {
    id,
    type: "assistant",
    time: { completed: 1 },
    finish: "stop",
    content: [{ type: "text", text }],
  }
}

test("a detailed read of a long conversation costs the current turn's pages, not the conversation", async () => {
  // 200 earlier messages, then one input and a short reply.
  const earlier = Array.from({ length: 100 }, (_, index) => [
    { id: `msg_in_${index}`, type: "user", text: `input ${index}` },
    assistantMessage(`msg_out_${index}`, `reply ${index}`),
  ]).flat()
  const fixture = nativeLivenessFixture({
    idle: DateTime.nowUnsafe(),
    messages: [
      ...earlier,
      { id: "msg_current", type: "user", text: "latest" },
      assistantMessage("msg_latest_reply", "done"),
    ],
  })
  const session = await fixture.host.session("ses_worker", { messages: true })
  // Before: two whole-conversation reads of 202 messages. Now: one page.
  expect(fixture.messageListCalls).toHaveLength(1)
  expect(fixture.contextReads).toBe(0)
  expect(session?.messages.map((message) => message.id)).toEqual([
    "msg_current",
    "msg_latest_reply",
  ])
  expect(session?.turn).toEqual({ inputID: "msg_current", state: "completed" })
})

test("a turn longer than one page reads exactly the pages it spans", async () => {
  const work = Array.from({ length: 120 }, (_, index) => assistantMessage(`msg_step_${index}`, "x"))
  const fixture = nativeLivenessFixture({
    idle: DateTime.nowUnsafe(),
    messages: [
      { id: "msg_old", type: "user", text: "old" },
      { id: "msg_current", type: "user", text: "latest" },
      ...work,
    ],
  })
  const session = await fixture.host.session("ses_worker", { messages: true })
  // 120 replies plus the input: three descending pages, then it stops at the input.
  expect(fixture.messageListCalls).toHaveLength(3)
  expect(session?.messages).toHaveLength(121)
  expect(session?.turn?.inputID).toBe("msg_current")
})

test("an Architect heartbeat reads one assistant page for its prompt size, never the conversation", async () => {
  const fixture = nativeLivenessFixture({
    messages: [
      { id: "msg_in", type: "user", text: "hi" },
      {
        ...assistantMessage("msg_out", "ok"),
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 40_000, write: 2_000 } },
      },
    ],
  })
  fixture.session.agent = "architect"
  const session = await fixture.host.session("ses_worker")
  expect(session?.contextTokens).toBe(42_010)
  expect(fixture.messageListCalls).toEqual([
    { type: "assistant", order: "desc", limit: 8, cursor: undefined },
  ])
  expect(fixture.contextReads).toBe(0)
})

test("a single message is a point read, and an absent one is undefined", async () => {
  const fixture = nativeLivenessFixture({
    history: [{ id: "msg_present", type: "synthetic" }],
  })
  expect(await fixture.host.message?.("ses_worker", "msg_present")).toMatchObject({
    id: "msg_present",
    type: "synthetic",
  })
  expect(fixture.messageListCalls).toHaveLength(0)
})
