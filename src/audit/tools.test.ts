import type {
  AuditScanOutput,
  AuditDetailOutput,
  AuditDecisionRecord,
  AuditQueryOutput,
} from "./contract.ts"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import type { Plugin } from "@opencode/plugin/effect"
import type { z } from "zod"
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "../storage.ts"
import { registerAuditTools } from "./tools.ts"

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
    type Registered = Parameters<ToolEditor["add"]>[0]
    const tools = new Map<string, Registered>(),
      actions: string[] = []
    let denied = false
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
          return denied ? Effect.fail(new Error("Native permission denied")) : Effect.void
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
    denied = true
    await expect(invoke<z.infer<typeof AuditQueryOutput>>("lz-query-audits", {})).rejects.toThrow(
      "Native permission denied",
    )
  } finally {
    repository.close()
    rmSync(root, { recursive: true, force: true })
  }
})
