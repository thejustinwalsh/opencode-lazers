import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const css = readFileSync(new URL("./panel.css", import.meta.url), "utf8")

test("the Radar pane's own list styles never reach the kit's stat row or identifiers", () => {
  // `.lazers-radar-detail dl { display: grid; grid-template-columns: ... }` once shrank the kit's
  // four-column stat row to a two-column block; every dl rule must now skip kit lists.
  const rules = [...css.matchAll(/^(\.lazers-radar-detail dl[^{]*)\{/gm)].map((match) => match[1]!)
  expect(rules.length).toBeGreaterThan(0)
  for (const selector of rules) expect(selector).toContain(':not([class*="lazers-kit"])')
})

test("the worker pane stacks its sections at one 16 px rhythm with no stray paragraph margins", () => {
  expect(css).toMatch(
    /\.lazers-radar-monitor-inspector \{[^}]*display: flex;[^}]*flex-direction: column;[^}]*gap: 16px/,
  )
  // Higher specificity than `.lazers-radar-detail p { margin: 6px 0 12px }`.
  expect(css).toMatch(/\.lazers-radar-detail\.lazers-radar-monitor-inspector > \* \{[^}]*margin: 0/)
})
