import type {
  AuditScanOutput,
  AuditDetailOutput,
  AuditDecisionRecord,
  AuditQueryOutput,
  FallowCheckOutput,
  FallowConfigOutput,
  FallowConfigSetOutput,
  FallowDeadCodeOutput,
  FallowDupesOutput,
  FallowHealthOutput,
} from "./contract.ts"
import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import type { Plugin } from "@opencode/plugin/effect"
import type { z } from "zod"
import { mkdtempSync, writeFileSync, rmSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "../storage.ts"
import { registerAuditTools } from "./tools.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

async function run(cwd: string, ...args: string[]) {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
  const out = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  return out.trim()
}

async function commit(dir: string, message: string) {
  await run(dir, "add", "-A")
  await run(
    dir,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    message,
  )
}

type Registered = Parameters<ToolEditor["add"]>[0]

/** Shared Code Mode harness: registers the real tools against an in-memory editor/permission stub. */
async function harness(root: string, repository: TaskRepository) {
  const tools = new Map<string, Registered>(),
    actions: string[] = []
  const denied = { value: false }
  const ctx = {
    location: { directory: root },
    tool: {
      transform: (run: (editor: ToolEditor) => void) =>
        Effect.sync(() =>
          run({
            add: (tool: Registered) => tools.set(tool.name, tool),
            list: () => [],
            get: () => undefined,
            namespace: () => {},
            update: () => {},
            remove: () => {},
          } as ToolEditor),
        ),
    },
    permission: {
      assert: (input: { action: string }) => {
        actions.push(input.action)
        return denied.value ? Effect.fail(new Error("Native permission denied")) : Effect.void
      },
    },
  } as unknown as Plugin.Context
  await Effect.runPromise(Effect.scoped(registerAuditTools(ctx, repository)))
  const call = {
    sessionID: "architect",
    agent: "architect",
    messageID: "message",
    id: "native-call",
    progress: () => Effect.void,
  } as never
  const invoke = async <T>(name: string, input: unknown): Promise<T> => {
    const tool = tools.get(name)!
    expect(tool.options?.codemode).toBe(true)
    const parsed = (tool.input as z.ZodType).parse(input)
    const result = await Effect.runPromise(tool.execute(parsed, call))
    const output = (tool.output as z.ZodType).parse(result.output)
    return output as T
  }
  return { invoke, actions, denied }
}

test("Code Mode audit tools expose typed durable reports, history, finding decisions and legacy import", async () => {
  const root = mkdtempSync(join(tmpdir(), "lz-audit-tools-")),
    repository = new TaskRepository(join(root, "data", "tasks.sqlite"), root)
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", main: "index.ts" }))
    writeFileSync(join(root, "index.ts"), "console.log('fixture')")
    writeFileSync(
      join(root, "legacy.json"),
      JSON.stringify({
        reports: {
          deadCode: {
            summary: { total_issues: 1 },
            unused_exports: [{ path: "src/a.ts", export_name: "unused", line: 10 }],
          },
        },
      }),
    )
    const { invoke, actions, denied } = await harness(root, repository)
    const imported = await invoke<z.infer<typeof AuditScanOutput>>("lz-import-audit", {
      path: "legacy.json",
      requestID: "import",
    })
    expect(imported.taskID).toBeNull()
    expect(imported.attemptID).toBeNull()
    expect(actions).toContain("read")
    const detail = await invoke<z.infer<typeof AuditDetailOutput>>("lz-get-audit", {
      runID: imported.runID,
    })
    const findingID = detail.findings[0]!.findingID
    const decision = await invoke<z.infer<typeof AuditDecisionRecord>>("lz-record-audit-finding", {
      runID: imported.runID,
      findingID,
      requestID: "retain",
      disposition: "retained",
      note: "Public plugin entry point",
    })
    expect(decision.sessionID).toBe("architect")
    expect(Number.isInteger(decision.createdAt)).toBe(true)
    expect(
      (await invoke<z.infer<typeof AuditQueryOutput>>("lz-query-audits", {})).runs,
    ).toHaveLength(1)
    rmSync(imported.reportPath)
    await invoke<z.infer<typeof AuditDetailOutput>>("lz-get-audit", {
      runID: imported.runID,
      export: true,
    })
    expect(
      JSON.parse(readFileSync(imported.reportPath, "utf8")).reports.deadCode.unused_exports,
    ).toHaveLength(1)
    const scan = await invoke<z.infer<typeof AuditScanOutput>>("lz-fallow-report", {
      requestID: "real-scan",
      phase: "baseline",
    })
    expect(scan.analyses).toHaveLength(5)
    expect(
      (
        await invoke<z.infer<typeof AuditScanOutput>>("lz-fallow-report", {
          requestID: "real-scan",
          phase: "baseline",
        })
      ).runID,
    ).toBe(scan.runID)
    denied.value = true
    await expect(invoke<z.infer<typeof AuditQueryOutput>>("lz-query-audits", {})).rejects.toThrow(
      "Native permission denied",
    )
  } finally {
    repository.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("Fallow analysis tools expose dupes, health, dead-code, config and a read-only check preview", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lz-fallow-tools-")))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const repository = new TaskRepository(join(root, "data", "tasks.sqlite"), root)
  cleanups.push(() => repository.close())
  await run(root, "init", "-q", "-b", "main")
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture" }))
  const duplicated = Array.from({ length: 30 }, (_, i) => `console.log("line ${i}")`).join("\n")
  writeFileSync(join(root, "a.ts"), `export function a() {\n${duplicated}\n}\n`)
  writeFileSync(join(root, "b.ts"), `export function b() {\n${duplicated}\n}\n`)
  writeFileSync(join(root, "unused.ts"), "export const neverUsed = 1\n")
  await commit(root, "base")

  const { invoke } = await harness(root, repository)

  const dupes = await invoke<z.infer<typeof FallowDupesOutput>>("lz-fallow-dupes", {})
  expect(dupes.groups.length).toBeGreaterThan(0)
  expect(dupes.groups[0]!.instances.length).toBeLessThanOrEqual(5)

  const health = await invoke<z.infer<typeof FallowHealthOutput>>("lz-fallow-health", {
    sort: "cognitive",
  })
  expect(health.thresholds).toEqual({ cyclomatic: 20, cognitive: 15 })

  await expect(
    invoke<z.infer<typeof FallowDeadCodeOutput>>("lz-fallow-dead-code", {}),
  ).rejects.toThrow("dead-code-disabled")

  const config = await invoke<z.infer<typeof FallowConfigOutput>>("lz-fallow-config", {})
  expect(config.source).toBe("defaults")
  expect(config.deadCodeEnabled).toBe(false)

  const draft = await invoke<z.infer<typeof FallowConfigOutput>>("lz-fallow-config", {
    draft: true,
  })
  expect(draft.draft).toBeDefined()

  const set = await invoke<z.infer<typeof FallowConfigSetOutput>>("lz-fallow-config-set", {
    set: { entry: ["a.ts"] },
  })
  expect(set.config).toEqual({ entry: ["a.ts"] })

  const deadCode = await invoke<z.infer<typeof FallowDeadCodeOutput>>("lz-fallow-dead-code", {})
  expect(deadCode.findings.some((f) => f.file === "unused.ts")).toBe(true)

  writeFileSync(
    join(root, "a.ts"),
    `export function a() {\n${duplicated}\nconsole.log("more")\n}\n`,
  )
  await commit(root, "touch a")
  const check = await invoke<z.infer<typeof FallowCheckOutput>>("lz-fallow-check", {})
  expect(["clean", "findings", "unavailable"]).toContain(check.status)
})
