import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const css = readFileSync(
  fileURLToPath(new URL("../../src/tasks/panel.css", import.meta.url)),
  "utf8",
)

/** Every rule as [selector, declarations]; comments removed. */
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
  (match) => [match[1]!.trim().replace(/\s+/g, " "), match[2]!] as const,
)
// Declarations that paint with a status token; the root rule only defines the tokens.
const paints = (body: string, token: RegExp) =>
  body
    .split(";")
    .some(
      (declaration) =>
        /^\s*(color|background|border-color|fill)\s*:/.test(declaration) && token.test(declaration),
    )
const statusColor = /--task-tone-|--icon-(success|warning|critical)|--icon-interactive/
const successColor = /--task-tone-success|--icon-success/

test("green appears only on success states", () => {
  const green = rules.filter(([, body]) => paints(body, successColor))
  expect(green.length).toBeGreaterThan(0)
  for (const [selector] of green) {
    // Every selector listed in a green rule is a succeeded, completed state (integrated).
    for (const part of selector.replace(/:is\([^)]*\)/g, "X").split(",")) {
      expect(part).toMatch(/data-tone="integrated"/)
    }
  }
  const text = green.map(([selector]) => selector).join(" ")
  for (const tone of ["running", "queued", "waiting", "attention", "ready", "failed", "cancelled"])
    expect(text).not.toContain(`"${tone}"`)
  // The foreground-active worker dot is running, not success.
  expect(css).toMatch(
    /activity-indicator\[data-state="active"\]\s*\{\s*background: var\(--task-tone-running\)/,
  )
})

test("the link icons carry no status color and no sequencing icon exists", () => {
  expect(css).not.toContain("lazers-tasks-sequence")
  for (const name of ["row-blocker", "dependency-icon"]) {
    const own = rules.filter(([selector]) => selector.includes(`lazers-tasks-${name}`))
    expect(own.length).toBeGreaterThan(0)
    for (const [selector, body] of own) {
      expect(paints(body, statusColor)).toBe(false)
      expect(selector).not.toContain("data-tone")
      expect(selector).not.toContain("data-sequence")
    }
  }
  // The shared state tone map no longer reaches the blocker link.
  for (const [selector, body] of rules)
    if (paints(body, statusColor)) expect(selector).not.toContain("lazers-tasks-row-blocker")
})

test("accepted is neutral with its own outlined glyph; only integrated is a filled disc", async () => {
  const { taskRowPresentation } = await import("../../src/tasks/row-presentation.ts")
  const row = (status: string) => ({
    taskID: "t",
    title: "t",
    status,
    reason: null,
    waiting: false,
    holdReason: null,
    ordinal: 0,
    contextOnly: false,
    prerequisites: [],
    successors: [],
  })
  expect(taskRowPresentation(row("accepted")).icon).toBe("ring-check")
  expect(taskRowPresentation(row("incorporated")).icon).toBe("disc-check")
  const accepted = rules.filter(([selector]) => selector.includes('data-tone="accepted"'))
  expect(accepted.length).toBeGreaterThan(0)
  for (const [, body] of accepted) expect(paints(body, successColor)).toBe(false)
})
