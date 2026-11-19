import { expect, test } from "bun:test"
import { TOOL_DETAIL_LIMIT, redactCommand, relativize, toolDetail } from "./tool-detail.ts"

test("each built-in tool names what it ran from its own input field", () => {
  expect(
    toolDetail("bash", { command: "bun test src/runner/resume.test.ts", description: "x" }),
  ).toBe("bun test src/runner/resume.test.ts")
  expect(toolDetail("read", { filePath: "src/runner/lifecycle.ts" })).toBe(
    "src/runner/lifecycle.ts",
  )
  expect(toolDetail("edit", { file_path: "src/a.ts", oldString: "BODY", newString: "BODY2" })).toBe(
    "src/a.ts",
  )
  expect(toolDetail("write", { path: "docs/x.md", content: "BODY" })).toBe("docs/x.md")
  expect(toolDetail("grep", { pattern: "interrupted", path: "src/runner" })).toBe(
    '"interrupted" src/runner',
  )
  expect(toolDetail("glob", { pattern: "src/**/*.ts" })).toBe("src/**/*.ts")
  expect(toolDetail("webfetch", { url: "https://example.com/docs/a?token=abc#frag" })).toBe(
    "example.com/docs/a",
  )
  expect(toolDetail("task", { description: "Explore the runner", prompt: "LONG PROMPT" })).toBe(
    "Explore the runner",
  )
  expect(
    toolDetail("patch", {
      patchText:
        "*** Begin Patch\n*** Update File: src/p.ts\n+BODY\n*** Add File: src/q.ts\n*** End Patch",
    }),
  ).toBe("src/p.ts, src/q.ts")
})

test("code mode execute lists the tools its script calls, in every call form", () => {
  expect(
    toolDetail("execute", {
      code: "const a = await tools[\"lz-inspect-plan\"]({ planID })\nawait tools.read({ filePath })\nawait tools['lz-query-tasks']({}); await tools.read({})",
    }),
  ).toBe("lz-inspect-plan · read · lz-query-tasks")
  expect(toolDetail("execute", { code: "await tools[\"bash\"]({ command: 'ls' })" })).toBe("bash")
  expect(toolDetail("execute", { code: "await lz-query-tasks({})" })).toBe("lz-query-tasks")
  // No tool name: the first non-empty line stands in, so the row is never blank.
  expect(toolDetail("execute", { code: "\n\n  const x = 1\nreturn x" })).toBe("const x = 1")
  expect(toolDetail("execute", {})).toBeNull()
})

test("paths are shown relative to where the session works", () => {
  const scope = {
    roots: ["/Users/me/lazers.worktrees/abc-123", "/Users/me/lazers"],
    worktreesBase: "/Users/me/lazers.worktrees",
    home: "/Users/me",
  }
  expect(
    toolDetail("read", { filePath: "/Users/me/lazers.worktrees/abc-123/src/a.ts" }, scope),
  ).toBe("src/a.ts")
  expect(toolDetail("read", { filePath: "/Users/me/lazers/docs/x.md" }, scope)).toBe("docs/x.md")
  expect(toolDetail("read", { filePath: "/Users/me/.config/x.json" }, scope)).toBe(
    "~/.config/x.json",
  )
  expect(
    toolDetail(
      "grep",
      { pattern: "export", path: "/Users/me/lazers.worktrees/abc-123/src/a.ts" },
      scope,
    ),
  ).toBe('"export" src/a.ts')
  // A grep or glob over the workspace root shows just the pattern.
  expect(
    toolDetail(
      "glob",
      { pattern: "**/AGENTS.md", path: "/Users/me/lazers.worktrees/abc-123" },
      scope,
    ),
  ).toBe("**/AGENTS.md")
  expect(toolDetail("grep", { pattern: "x", path: "/Users/me/lazers" }, scope)).toBe('"x"')
  // Inside a shell command, and for any other worktree of the project.
  expect(
    toolDetail(
      "bash",
      { command: "cd /Users/me/lazers.worktrees/other-9 && git diff /Users/me/lazers/src/b.ts" },
      scope,
    ),
  ).toBe("cd . && git diff src/b.ts")
  expect(relativize("/Users/me/lazers.worktrees/abc-123/src/a.ts", scope)).toBe("src/a.ts")
})

test("commands lose environment values, credential flags and secrets before truncation", () => {
  expect(redactCommand("FOO=secret BAR='a b' cmd --flag")).toBe("FOO=… BAR=… cmd --flag")
  expect(
    toolDetail("bash", {
      command: "API_KEY=abc123 curl -H 'Authorization: Bearer abcdef123456' x",
    }),
  ).not.toMatch(/abc123|abcdef123456/)
  expect(toolDetail("bash", { command: "deploy --password hunter2 --force" })).toBe(
    "deploy --password … --force",
  )
  expect(toolDetail("bash", { command: "echo ghp_abcdefghijklmnop1234" })).not.toContain(
    "ghp_abcdefghijklmnop1234",
  )
})

test("a summary is one line, collapsed, and bounded with an ellipsis", () => {
  const detail = toolDetail("bash", { command: `echo   a\n\n\tb ${"x".repeat(500)}` })!
  expect(detail.startsWith("echo a b ")).toBe(true)
  expect(detail).not.toMatch(/[\n\t]/)
  expect(Array.from(detail).length).toBe(TOOL_DETAIL_LIMIT)
  expect(detail.endsWith("…")).toBe(true)
})

test("calls with nothing worth showing record nothing", () => {
  expect(toolDetail("bash", {})).toBeNull()
  expect(toolDetail("bash", "not an object")).toBeNull()
  expect(toolDetail("read", { filePath: "  " })).toBeNull()
  expect(toolDetail("mystery", { other: 1 })).toBeNull()
})
