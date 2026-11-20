import { afterAll, beforeAll, expect, test } from "bun:test"
import { Window } from "happy-dom"
import solid from "vite-plugin-solid"
import { build } from "vite"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { ProfileView, ProjectView } from "../../src/projects/contract.ts"

const dom = new Window({ url: "https://projects-notice.localhost" })
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
let notice!: typeof import("./notice-entry.tsx").noticeHarness
let settings!: typeof import("./dom-entry.tsx").harness

async function bundle(entry: string, name: string) {
  const outDir = fileURLToPath(new URL(`../../node_modules/.cache/${name}`, import.meta.url))
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
        entry: fileURLToPath(new URL(entry, import.meta.url)),
        formats: ["es"],
        fileName: name,
      },
      rolldownOptions: { output: { codeSplitting: false } },
    },
  })
  return import(pathToFileURL(`${outDir}/${name}.js`).href)
}

beforeAll(async () => {
  for (const name of globals) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value: dom[name] })
  }
  notice = (await bundle("./notice-entry.tsx", "setup-notice-dom")).noticeHarness
  settings = (await bundle("./dom-entry.tsx", "setup-settings-dom")).harness
})
afterAll(() => {
  for (const [name, descriptor] of previous)
    descriptor
      ? Object.defineProperty(globalThis, name, descriptor)
      : delete (globalThis as never as Record<string, unknown>)[name]
})
const tick = async () => {
  for (let i = 0; i < 4; i++) await Bun.sleep(0)
}
const none = { ok: true as const, key: "k", code: "ALP", state: "none" as const, dismissed: false }

test("a session of a project without a profile raises one toast with Set up and Dismiss", async () => {
  const w = notice({ status: none })
  w.mount("ses_1")
  await tick()
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toMatchObject({ title: "Set up LAZERS for ALP", persistent: true })
  expect(w.toasts[0]!.actions!.map((a) => a.label)).toEqual(["Set up", "Dismiss"])
  expect(w.calls[0]).toMatchObject({
    method: "setupStatus",
    input: { sessionID: "ses_1" },
    location: { directory: "/work/alpha" },
  })
  w.mount("ses_2")
  await tick()
  expect(w.toasts).toHaveLength(1)
  w.dispose()
})

test("Set up starts the session and opens its tab focused", async () => {
  const w = notice({ status: none })
  w.mount("ses_1")
  await tick()
  w.toasts[0]!.actions![0]!.run()
  await tick()
  expect(w.calls.some((c) => c.method === "startSetup")).toBe(true)
  expect(w.tabs).toEqual([{ session: { server: "srv", id: "setup-1" }, options: { focus: true } }])
  w.dispose()
})

test("a refused start is shown as a toast and opens nothing", async () => {
  const w = notice({
    status: none,
    started: { ok: false, refusal: "PROJECT_NOT_LOADED", message: "no model" },
  })
  w.mount("ses_1")
  await tick()
  w.toasts[0]!.actions![0]!.run()
  await tick()
  expect(w.tabs).toEqual([])
  expect(w.toasts.at(-1)).toMatchObject({ title: "Could not start setup", description: "no model" })
  w.dispose()
})

test("Dismiss stores the dismissal for the project", async () => {
  const w = notice({ status: none })
  w.mount("ses_1")
  await tick()
  w.toasts[0]!.actions![1]!.run()
  await tick()
  expect(w.calls.find((c) => c.method === "dismissSetup")).toMatchObject({ input: { key: "k" } })
  w.dispose()
})

test("a dismissed project and an active profile show nothing", async () => {
  for (const status of [
    { ...none, dismissed: true },
    { ...none, state: "active" as const },
  ]) {
    const w = notice({ status })
    w.mount("ses_1")
    await tick()
    expect(w.toasts).toEqual([])
    w.dispose()
  }
})

test("an unreachable RPC shows nothing and throws nothing", async () => {
  const w = notice({ status: "offline" })
  w.mount("ses_1")
  await tick()
  expect(w.toasts).toEqual([])
  w.dispose()
})

test("Settings: Run setup again starts setup through a session of the project and opens its tab", async () => {
  const project: ProjectView = {
    key: "k",
    code: "ALP",
    name: "alpha",
    checkouts: ["/work/alpha"],
    loaded: true,
    pause: null,
    architectContact: null,
    settings: { limit: null, weight: 1, spendCeilingTokens: null, setupDismissedAt: null },
    profile: { state: "active", revision: 1 },
  }
  const profile: ProfileView = { key: "k", history: [], setupDismissedAt: null }
  const root = dom.document.createElement("main")
  dom.document.body.append(root)
  const api = settings(root as never, [project], {
    profiles: { k: profile },
    sessions: [{ id: "ses_1", directory: "/work/alpha" }],
  })
  await tick()
  ;[...root.querySelectorAll("button")]
    .find((b) => b.textContent === "Run setup again")!
    .dispatchEvent(new dom.MouseEvent("click", { bubbles: true }))
  await tick()
  expect(api.calls.some((c) => c.method === "startSetup")).toBe(true)
  expect(api.tabs).toEqual([{ id: "setup-1", focus: true }])
  api.dispose()
  root.remove()
})
