import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/** Style rules that keep the chat inside its column and the viewport (the browser check is
 *  test/e2e/live-chat-fit.mjs). */
const css = readFileSync(join(import.meta.dir, "../src/live/live.css"), "utf8")
const global = readFileSync(join(import.meta.dir, "../src/global.css"), "utf8")

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\>]/g, "\\$&")
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css)
  if (!match) throw new Error(`no rule for ${selector}`)
  const out: Record<string, string> = {}
  for (const line of match[1]!.replace(/\/\*[\s\S]*?\*\//g, "").split(";")) {
    const [key, ...value] = line.split(":")
    if (key?.trim()) out[key.trim()] = value.join(":").trim()
  }
  return out
}

describe("live chat frame", () => {
  const frame = rule(".lc")
  test("its height comes from one viewport-relative variable, not a pixel size", () => {
    expect(frame.height).toBe("var(--lc-height)")
    expect(global).toMatch(/--lc-height:\s*min\([^;]*svh[^;]*\)/)
  })
  test("it can never be taller than the viewport", () => {
    expect(frame["max-height"]).toMatch(/100svh/)
  })
  test("it fills its column and may shrink inside a grid or flex parent", () => {
    expect(frame.width).toBe("100%")
    expect(frame["min-width"]).toBe("0")
    expect(frame["grid-template-columns"]).toBe("minmax(0, 1fr)")
  })
  test("header and composer keep their size; only the message list takes the slack", () => {
    expect(frame["grid-template-rows"]).toBe("auto minmax(0, 1fr) auto")
  })
})

describe("message list", () => {
  const list = rule(".lc-list")
  test("is the scrolling region and may shrink below its content", () => {
    expect(list["overflow-y"]).toBe("auto")
    expect(list["min-height"]).toBe("0")
  })
  test("hands wheel scrolling back to the page at its ends", () => {
    expect(list["overscroll-behavior"]).toBe("auto")
  })
  test("long words and URLs wrap instead of widening it", () => {
    expect(rule(".lc-msg")["overflow-wrap"]).toBe("anywhere")
  })
})

describe("plate", () => {
  test("the figure's column can shrink with its parent", () => {
    expect(rule(".lc-figure")["grid-template-columns"]).toBe("minmax(0, 1fr)")
  })
  test("the pill row and footer cannot force the frame wider", () => {
    expect(rule(".lc-foot")["grid-template-columns"]).toBe("minmax(0, 1fr)")
    expect(rule(".lc-status")["min-width"]).toBe("0")
  })
})
