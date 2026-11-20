import { afterAll, beforeAll, expect, test } from "bun:test"
import { Window } from "happy-dom"
import type { HTMLElement as DomElement, HTMLInputElement } from "happy-dom"
import solid from "vite-plugin-solid"
import { build } from "vite"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { ProjectView } from "../../src/projects/contract.ts"

const project = (
  over: Partial<ProjectView> & Pick<ProjectView, "key" | "code" | "name">,
): ProjectView => ({
  checkouts: [`/work/${over.name}`],
  loaded: true,
  pause: null,
  architectContact: null,
  settings: { limit: null, weight: 1, spendCeilingTokens: null },
  ...over,
})
const seed = [
  project({ key: "a", code: "ALP", name: "alpha" }),
  project({
    key: "b",
    code: "BET",
    name: "beta",
    checkouts: ["/work/beta", "/work/beta.worktrees/x"],
    pause: { reason: "Rebuild", by: "owner", at: 1 },
  }),
  project({ key: "c", code: "GAM", name: "gamma", loaded: false }),
]

const dom = new Window({ url: "https://projects-settings.localhost" })
const globals = [
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
let mount!: typeof import("./dom-entry.tsx").harness

beforeAll(async () => {
  for (const name of globals) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value: dom[name] })
  }
  const outDir = fileURLToPath(
    new URL("../../node_modules/.cache/projects-settings-dom", import.meta.url),
  )
  await build({
    configFile: false,
    logLevel: "silent",
    resolve: { conditions: ["browser", "development", "module"] },
    plugins: [solid()],
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      lib: {
        entry: fileURLToPath(new URL("./dom-entry.tsx", import.meta.url)),
        formats: ["es"],
        fileName: "projects-dom",
      },
      rolldownOptions: { output: { codeSplitting: false } },
    },
  })
  mount = (
    (await import(
      pathToFileURL(`${outDir}/projects-dom.js`).href
    )) as typeof import("./dom-entry.tsx")
  ).harness
})
afterAll(() => {
  for (const [name, descriptor] of previous)
    descriptor
      ? Object.defineProperty(globalThis, name, descriptor)
      : delete (globalThis as never as Record<string, unknown>)[name]
})

const tick = async () => {
  await Bun.sleep(0)
  await Bun.sleep(0)
}
async function open(projects = seed, options?: { reachable?: boolean }) {
  const root = dom.document.createElement("main")
  dom.document.body.append(root)
  const api = mount(root as never, projects, options)
  await tick()
  const q = <T extends DomElement = HTMLInputElement>(label: string) =>
    root.querySelector<T>(`[aria-label="${label}"]`) as unknown as T
  const type = async (label: string, value: string) => {
    const input = q(label)
    input.value = value
    input.dispatchEvent(new dom.Event("input", { bubbles: true }))
    await tick()
  }
  const enter = async (label: string) => {
    q(label).dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await tick()
  }
  const flip = async (label: string, checked: boolean) => {
    const input = q(label)
    input.checked = checked
    input.dispatchEvent(new dom.Event("change", { bubbles: true }))
    await tick()
  }
  const press = async (text: string) => {
    ;[...root.querySelectorAll("button")]
      .find((b) => b.textContent === text)!
      .dispatchEvent(new dom.MouseEvent("click", { bubbles: true }))
    await tick()
  }
  const rows = () => [...root.querySelectorAll(".fixture-row")]
  const row = (name: string) => rows().find((r) => r.textContent!.includes(name))!
  return {
    root,
    api,
    q,
    type,
    enter,
    flip,
    press,
    row,
    close: () => {
      api.dispose()
      root.remove()
    },
  }
}

test("the section lists each project by code, name and checkouts", async () => {
  const ui = await open()
  expect(ui.root.querySelector("h2")!.textContent).toBe("Projects")
  expect(ui.q("Code of alpha").value).toBe("ALP")
  expect(ui.q("Code of beta").value).toBe("BET")
  expect(ui.row("beta").textContent).toContain("/work/beta.worktrees/x")
  expect(ui.row("beta").textContent).toContain("/work/beta")
  ui.close()
})

test("a paused project shows who paused it and why; others show nothing of the kind", async () => {
  const ui = await open()
  expect(ui.row("beta").querySelector(".lazers-kit-label")!.textContent).toBe("Paused")
  expect(ui.row("beta").textContent).toContain("owner · Rebuild")
  expect(ui.row("alpha").textContent).not.toContain("Paused")
  expect(ui.row("alpha").textContent).not.toMatch(/unknown|undefined|null/i)
  expect(ui.q("Pause beta").checked).toBe(true)
  expect(ui.q("Pause alpha").checked).toBe(false)
  ui.close()
})

test("pausing a row asks for a reason and calls setPause for that project only", async () => {
  const ui = await open()
  await ui.flip("Pause alpha", true)
  expect(ui.api.calls.filter((c) => c.method === "setPause")).toEqual([])
  await ui.type("Reason to pause alpha", "Rebuild index")
  await ui.press("Pause")
  expect(ui.api.calls.filter((c) => c.method === "setPause")).toEqual([
    {
      method: "setPause",
      input: { scope: { kind: "project", key: "a" }, paused: true, reason: "Rebuild index" },
    },
  ])
  // The re-read shows the stored pause with its owner and reason.
  expect(ui.row("alpha").textContent).toContain("owner · Rebuild index")
  expect(ui.q("Pause gamma").checked).toBe(false)
  ui.close()
})

test("two projects pause and resume independently", async () => {
  const ui = await open()
  await ui.flip("Pause alpha", true)
  await ui.press("Pause")
  await ui.flip("Pause beta", false)
  expect(ui.api.calls.filter((c) => c.method === "setPause").map((c) => c.input)).toEqual([
    { scope: { kind: "project", key: "a" }, paused: true, reason: "" },
    { scope: { kind: "project", key: "b" }, paused: false, reason: "" },
  ])
  expect(ui.q("Pause alpha").checked).toBe(true)
  expect(ui.q("Pause beta").checked).toBe(false)
  expect(ui.row("beta").textContent).not.toContain("Paused")
  ui.close()
})

test("cancelling the reason prompt pauses nothing", async () => {
  const ui = await open()
  await ui.flip("Pause alpha", true)
  await ui.press("Cancel")
  expect(ui.api.calls.some((c) => c.method === "setPause")).toBe(false)
  expect(ui.q("Pause alpha").checked).toBe(false)
  ui.close()
})

test("Pause all calls setPause with the global scope and shows its reason", async () => {
  const ui = await open()
  await ui.flip("Pause all", true)
  await ui.type("Reason to pause all", "Battery")
  await ui.press("Pause")
  expect(ui.api.calls.filter((c) => c.method === "setPause")).toEqual([
    { method: "setPause", input: { scope: { kind: "global" }, paused: true, reason: "Battery" } },
  ])
  expect(ui.q("Pause all").checked).toBe(true)
  expect(ui.root.textContent).toContain("owner · Battery")
  await ui.flip("Pause all", false)
  expect(ui.api.calls.at(-2)!.input).toEqual({
    scope: { kind: "global" },
    paused: false,
    reason: "",
  })
  expect(ui.root.textContent).not.toContain("owner · Battery")
  ui.close()
})

test("a code already taken shows the refusal and keeps the old code", async () => {
  const ui = await open()
  await ui.type("Code of alpha", "BET")
  await ui.enter("Code of alpha")
  expect(ui.row("alpha").querySelector("[role=alert]")!.textContent).toBe(
    "Another project already uses that code.",
  )
  expect(ui.q("Code of alpha").value).toBe("ALP")
  expect(ui.q("Code of beta").value).toBe("BET")
  await ui.type("Code of alpha", "NEW")
  await ui.enter("Code of alpha")
  expect(ui.q("Code of alpha").value).toBe("NEW")
  expect(ui.row("alpha").querySelector("[role=alert]")).toBeNull()
  ui.close()
})

test("limit and weight save on change; clearing a value falls back to the default", async () => {
  const ui = await open()
  await ui.type("Limit of alpha", "3")
  await ui.type("Weight of alpha", "2.5")
  await ui.type("Spend ceiling of alpha", "100")
  expect(ui.api.calls.filter((c) => c.method === "setSetting").map((c) => c.input)).toEqual([
    { scope: { kind: "project", key: "a" }, name: "limit", value: 3 },
    { scope: { kind: "project", key: "a" }, name: "weight", value: 2.5 },
    { scope: { kind: "project", key: "a" }, name: "spendCeilingTokens", value: 100 },
  ])
  expect(ui.q("Limit of beta").value).toBe("")
  await ui.type("Spend ceiling of alpha", "")
  expect(ui.api.calls.at(-2)!.input).toEqual({
    scope: { kind: "project", key: "a" },
    name: "spendCeilingTokens",
    value: null,
  })
  expect(ui.q("Spend ceiling of alpha").value).toBe("5000")
  ui.close()
})

test("an invalid number is refused in the row and not sent", async () => {
  const ui = await open()
  await ui.type("Limit of alpha", "0")
  expect(ui.api.calls.some((c) => c.method === "setSetting")).toBe(false)
  expect(ui.row("alpha").querySelector("[role=alert]")!.textContent).toBe(
    "Enter a whole number of 1 or more.",
  )
  ui.close()
})

test("a project that is not loaded is shown, labelled and editable", async () => {
  const ui = await open()
  expect(ui.row("gamma").textContent).toContain("Not loaded")
  expect(ui.row("alpha").textContent).not.toContain("Not loaded")
  await ui.type("Limit of gamma", "2")
  expect(ui.api.calls.at(-2)!.input).toEqual({
    scope: { kind: "project", key: "c" },
    name: "limit",
    value: 2,
  })
  await ui.flip("Pause gamma", true)
  await ui.press("Pause")
  expect(ui.row("gamma").textContent).toContain("Paused")
  ui.close()
})

test("the Architect contact pause shows under its own label", async () => {
  const ui = await open([
    project({ key: "a", code: "ALP", name: "alpha", architectContact: { reason: "Fallow" } }),
    seed[1]!,
  ])
  expect(ui.row("alpha").textContent).toContain("Architect contact")
  expect(ui.row("beta").textContent).not.toContain("Architect contact")
  ui.close()
})

test("an unreachable service shows a notice, not stale or empty rows", async () => {
  const ui = await open(seed, { reachable: false })
  expect(ui.root.querySelector("[role=alert]")!.textContent).toBe(
    "Projects are unavailable. Reconnecting…",
  )
  expect(ui.root.querySelector("[aria-label='Code of alpha']")).toBeNull()
  ui.close()
})
