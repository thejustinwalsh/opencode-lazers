import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { visibleTicks } from "../../src/trajectory-panel/panel-layout.ts"

const css = readFileSync(
  fileURLToPath(new URL("../../src/trajectory-panel/panel.css", import.meta.url)),
  "utf8",
)

/** Every rule as [selector, declarations]; comments removed. */
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
  (match) => [match[1]!.trim().replace(/\s+/g, " "), match[2]!] as const,
)
const declaration = (name: string) =>
  rules.flatMap(([, body]) => body.split(";")).find((line) => line.trim().startsWith(`${name}:`))
const green = /success|syntax-string|--green|--icon-diff-add|diff-add/

test("no track hue resolves to a success or green token", () => {
  for (const track of ["attempts", "tools", "files", "checks"]) {
    const value = declaration(`--trajectory-hue-${track}`)
    expect(value).toBeDefined()
    expect(value).not.toMatch(green)
  }
  // Tool marks are a violet mixed from the theme's interactive and critical tokens: themes map
  // their named violets to blue or orange, which would match the attempt or files track.
  expect(css).toMatch(
    /--lazers-hue-tools: color-mix\(\s*in oklch,\s*var\(--text-interactive-base[^;]*var\(--icon-critical-base/,
  )
  // The shared definition (also used by Radar) feeds the Trajectory token.
  expect(declaration("--trajectory-hue-tools")).toContain("var(--lazers-hue-tools)")
  expect(declaration("--trajectory-hue-tools")).not.toMatch(/syntax-string|syntax-keyword/)
})

test("no rule that paints a track, mark or rail uses a success token", () => {
  const painted = rules.filter(([selector]) =>
    /mark|rail|segment|check-interval|check-marker|lane|track/.test(selector),
  )
  expect(painted.length).toBeGreaterThan(0)
  for (const [selector, body] of painted)
    expect([selector, body.match(green)]).toEqual([selector, null])
})

test("failure is red on any track", () => {
  const failed = rules.find(([selector]) =>
    selector.includes('.lazers-trajectory-rail[data-failed="true"]'),
  )
  expect(failed?.[1]).toContain("--rail-color: var(--trajectory-failed)")
  expect(declaration("--trajectory-failed")).toContain("--icon-critical-base")
})

test("hatching marks recording gaps only; compressed idle is never hatched", () => {
  const hatched = rules.filter(([, body]) => body.includes("repeating-linear-gradient"))
  expect(hatched.map(([selector]) => selector)).toEqual([
    ".lazers-trajectory-gridlines > .lazers-trajectory-gap-band",
  ])
  const idle = rules.filter(([selector]) => selector.includes("lazers-trajectory-idle"))
  expect(idle.length).toBeGreaterThan(0)
  for (const [, body] of idle) expect(body).not.toContain("repeating-linear-gradient")
  // The unloaded region is a plain wash, not a hatch.
  const unloaded = rules.find(([selector]) => selector.endsWith(".lazers-trajectory-unloaded"))
  expect(unloaded?.[1]).not.toContain("repeating-linear-gradient")
})

test("ruler labels thin by the axis transform, not by linear elapsed time", () => {
  const ticks = [0, 10, 20, 30, 40, 50].map((minutes) => ({
    elapsedMs: minutes * 60_000,
    label: `${minutes}m`,
  }))
  const duration = 50 * 60_000
  // An axis that compresses the middle packs 10m-40m into the first 5 % of the width.
  const squeezed = (elapsed: number) =>
    elapsed <= 10 * 60_000
      ? (elapsed / (10 * 60_000)) * 5
      : elapsed >= 40 * 60_000
        ? 5 + ((elapsed - 40 * 60_000) / (10 * 60_000)) * 95
        : 5
  const shown = visibleTicks(ticks, duration, 400, squeezed).map((tick) => tick.label)
  expect(shown).toContain("0m")
  expect(shown).toContain("50m")
  expect(shown.length).toBeLessThan(ticks.length)
})
