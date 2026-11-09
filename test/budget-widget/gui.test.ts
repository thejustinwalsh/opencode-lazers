import { expect, test } from "bun:test"
import { Window } from "happy-dom"
import type { HTMLButtonElement, HTMLInputElement } from "happy-dom"
import solid from "vite-plugin-solid"
import { build } from "vite"
import { fileURLToPath, pathToFileURL } from "node:url"
import { unavailable } from "../../src/budget/contract.ts"

test("native header/settings remain reactive, compact, shared and opt-in across reopen", async () => {
  const dom = new Window({ url: "https://budget-widget.localhost" })
  const names = [
    "window",
    "document",
    "Node",
    "Element",
    "HTMLElement",
    "Document",
    "DocumentFragment",
    "Text",
    "Event",
    "MouseEvent",
    "KeyboardEvent",
    "navigator",
  ] as const
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const name of names) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value: dom[name] })
  }
  let dispose: (() => void) | undefined
  try {
    const outDir = fileURLToPath(new URL("../../node_modules/.cache/budget-dom", import.meta.url))
    await build({
      configFile: false,
      resolve: { conditions: ["browser", "development", "module"] },
      plugins: [solid()],
      build: {
        outDir,
        emptyOutDir: true,
        minify: false,
        lib: {
          entry: fileURLToPath(new URL("./dom-entry.tsx", import.meta.url)),
          formats: ["es"],
          fileName: "budget-dom",
        },
        rolldownOptions: { output: { codeSplitting: false } },
      },
    })
    const { harness } = (await import(
      pathToFileURL(`${outDir}/budget-dom.js`).href
    )) as typeof import("./dom-entry.tsx")
    const root = dom.document.createElement("main")
    dom.document.body.append(root)
    const api = harness(root as unknown as HTMLElement)
    dispose = api.dispose
    const tick = () => Bun.sleep(0)
    expect(root.querySelectorAll(".lazers-budget").length).toBe(0)
    expect(api.requests).toBe(0)
    const enable = root.querySelector<HTMLInputElement>('[role="switch"]')!
    enable.checked = true
    enable.dispatchEvent(new dom.Event("change", { bubbles: true }))
    await tick()
    expect(api.requests).toBe(1)
    expect(root.querySelectorAll(".lazers-budget").length).toBe(2)
    expect(root.querySelector(".lazers-budget")?.textContent).toBe("60%")
    expect(root.querySelector(".lazers-budget")?.getAttribute("data-tone")).toBe("warning")
    expect(root.querySelector(".lazers-budget")?.getAttribute("aria-label")).toContain(
      "5-hour 112.3%",
    )
    api.setSettings({ mode: "rolling" })
    await tick()
    expect(root.querySelector(".lazers-budget")?.textContent).toBe("112%")
    expect(root.querySelector(".budget-value")?.getAttribute("stroke-dasharray")).toBe("100 100")
    api.setCompact(true)
    await tick()
    expect(root.querySelector(".lazers-budget span")).toBeNull()
    const button = root.querySelector<HTMLButtonElement>(".lazers-budget")!
    button.focus()
    expect(dom.document.activeElement).toBe(button)
    button.click()
    expect(api.openedPage).toBe("budget")
    api.setCompact(false)
    api.setUsage({
      ...unavailable(),
      status: "available",
      creditUSD: 120.4,
      byokUSD: 60.2,
      coverageStart: Date.now() - 3600000,
      observedAt: Date.now(),
      reason: "Configured key only; earlier weekly usage unknown.",
    })
    api.setSettings({ provider: "openrouter" })
    await tick()
    expect(root.querySelector(".lazers-budget")?.textContent).toBe("$181*")
    expect(root.querySelector(".lazers-budget")?.getAttribute("aria-label")).toContain(
      "Credits $120 · BYOK $60",
    )
    expect(root.querySelector(".lazers-budget")?.getAttribute("data-tone")).toBe("warning")
    api.setSettings({ weeklyUSD: 200 })
    await tick()
    expect(root.querySelector(".lazers-budget")?.getAttribute("data-tone")).toBe("critical")
    const budget = root.querySelector<HTMLInputElement>('input[type="number"]')!
    budget.value = "0"
    budget.dispatchEvent(new dom.Event("change", { bubbles: true }))
    await tick()
    expect(api.settings().weeklyUSD).toBe(200)
    expect(root.querySelector('[role="status"]')?.textContent).toContain("greater than zero")
    api.setConnected(false)
    await tick()
    expect(root.querySelector(".lazers-budget")?.textContent).toBe("—")
    api.setConnected(true)
    api.replaceClient()
    await tick()
    api.setSettings({ enabled: false })
    await tick()
    const calls = api.requests
    api.setActive(false)
    api.setActive(true)
    await tick()
    expect(api.requests).toBe(calls)
    expect(root.querySelector(".lazers-budget")).toBeNull()
    api.reopen()
    await tick()
    expect(api.settings()).toMatchObject({ enabled: false, provider: "openrouter", weeklyUSD: 200 })
    const savedSettings = JSON.parse(JSON.stringify(api.settings()))
    api.dispose()
    const reopened = harness(root as unknown as HTMLElement, savedSettings)
    dispose = reopened.dispose
    await tick()
    expect(reopened.settings()).toMatchObject({
      enabled: false,
      provider: "openrouter",
      weeklyUSD: 200,
    })
    expect(reopened.requests).toBe(0)
  } finally {
    dispose?.()
    for (const name of names) {
      const value = previous.get(name)
      if (value) Object.defineProperty(globalThis, name, value)
      else Reflect.deleteProperty(globalThis, name)
    }
    await dom.happyDOM.close()
  }
}, 60_000)
