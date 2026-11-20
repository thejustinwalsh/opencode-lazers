import { afterAll, beforeAll, expect, test } from "bun:test"
import { Window } from "happy-dom"
import solid from "vite-plugin-solid"
import { build } from "vite"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { ProfileOutcomeView, ProfileView, ProjectView } from "../../src/projects/contract.ts"

type Proof = ProfileView["active"] extends infer A ? NonNullable<A>["proofs"][number] : never
type Revision = NonNullable<ProfileView["active"]>

const proof = (key: string, command: string, over: Partial<Proof> = {}): Proof => ({
  key,
  command,
  outcome: "proven",
  exitCode: 0,
  timedOut: false,
  durationMs: 5,
  stdoutTail: "",
  stderrTail: "",
  ranAt: 1,
  ...over,
})
const revision = (
  number: number,
  profile: Record<string, unknown>,
  proofs: Proof[],
  over: Partial<Revision> = {},
): Revision => ({
  revision: number,
  state: "active",
  profile,
  author: { kind: "architect", sessionID: "s" },
  reason: "init",
  createdAt: 1,
  proofs,
  credentialLikeEnv: [],
  ...over,
})
const base = {
  toolchains: ["cargo"],
  verify: [{ id: "tests", command: "cargo test --locked" }],
  fix: [
    { command: "cargo fmt --", files: ["**/*.rs"] },
    { command: "cargo clippy --fix", files: ["**/*.rs"] },
  ],
  env: [],
  audit: "fallow",
  source: { include: ["src/**/*.rs"], exclude: [] },
}
const project = (profile: ProjectView["profile"] = { state: "none" }): ProjectView => ({
  key: "k",
  code: "ALP",
  name: "alpha",
  checkouts: ["/work/alpha"],
  loaded: true,
  pause: null,
  architectContact: null,
  settings: { limit: null, weight: 1, spendCeilingTokens: null, setupDismissedAt: null },
  profile,
})
const view = (over: Partial<ProfileView>): ProfileView => ({
  key: "k",
  history: [],
  setupDismissedAt: null,
  ...over,
})

const dom = new Window({ url: "https://projects-verification.localhost" })
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
    new URL("../../node_modules/.cache/projects-verification-dom", import.meta.url),
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
        fileName: "verification-dom",
      },
      rolldownOptions: { output: { codeSplitting: false } },
    },
  })
  mount = (
    (await import(
      pathToFileURL(`${outDir}/verification-dom.js`).href
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
  await Bun.sleep(0)
}
async function open(
  profile: ProfileView | undefined,
  summary: ProjectView["profile"],
  options: { save?: ProfileOutcomeView } = {},
) {
  const root = dom.document.createElement("main")
  dom.document.body.append(root)
  const api = mount(root as never, [project(summary)], {
    ...(profile ? { profiles: { k: profile } } : {}),
    ...options,
  })
  await tick()
  const press = async (text: string) => {
    ;[...root.querySelectorAll("button")]
      .find((b) => b.textContent === text)!
      .dispatchEvent(new dom.MouseEvent("click", { bubbles: true }))
    await tick()
  }
  const type = async (label: string, value: string) => {
    const input = root.querySelector(`[aria-label="${label}"]`) as unknown as HTMLInputElement
    input.value = value
    input.dispatchEvent(new dom.Event("input", { bubbles: true }))
    await tick()
  }
  const calls = (method: string) => api.calls.filter((call) => call.method === method)
  return {
    root,
    api,
    press,
    type,
    calls,
    text: () => root.textContent ?? "",
    close: () => {
      api.dispose()
      root.remove()
    },
  }
}

const active = revision(
  1,
  base,
  [
    proof("verify:tests", "cargo test --locked"),
    proof("fix:0", "cargo fmt --"),
    proof("fix:1", "cargo clippy --fix", {
      outcome: "failed",
      exitCode: 101,
      stderrTail: "warning\nerror: could not compile",
    }),
  ],
  { credentialLikeEnv: [] },
)

test("a project without a profile shows only No profile and a way to set one up", async () => {
  const ui = await open(undefined, { state: "none" })
  expect(ui.text()).toContain("Verification")
  expect(ui.text()).toContain("No profile")
  expect(ui.text()).not.toContain("Revision")
  expect([...ui.root.querySelectorAll("button")].map((b) => b.textContent)).toContain("Set up")
  ui.close()
})

test("the active profile lists every command verbatim with its proof", async () => {
  const ui = await open(view({ active }), { state: "active", revision: 1 })
  const text = ui.text()
  expect(text).toContain("cargo test --locked")
  expect(text).toContain("cargo fmt --")
  expect(text).toContain("Proven")
  expect(text).toContain("Fallow")
  expect(text).toContain("src/**/*.rs")
  ui.close()
})

test("a failed proof shows Failed, its exit code and its last output line", async () => {
  const ui = await open(view({ active }), { state: "active", revision: 1 })
  expect(ui.text()).toContain("Failed")
  expect(ui.text()).toContain("exit 101: error: could not compile")
  ui.close()
})

test("a credential-looking env name carries Credential", async () => {
  const withEnv = revision(
    1,
    { ...base, env: ["NPM_TOKEN", "CARGO_HOME"] },
    [proof("verify:tests", "cargo test --locked")],
    { credentialLikeEnv: ["NPM_TOKEN"] },
  )
  const ui = await open(view({ active: withEnv }), { state: "active", revision: 1 })
  const rows = [...ui.root.querySelectorAll("div")].filter(
    (d) => d.textContent === "NPM_TOKENCredential",
  )
  expect(rows.length).toBe(1)
  expect(ui.text()).toContain("CARGO_HOME")
  ui.close()
})

test("a failing fix or install shows as failing and is not run unattended", async () => {
  const ui = await open(view({ active }), { state: "active", revision: 1 })
  expect(ui.text()).toContain("Not run unattended")
  // Only the failing fix carries it; the proven one does not.
  expect(ui.text().match(/Not run unattended/g)).toHaveLength(1)
  ui.close()
})

test("Settings has no confirmation step: no Confirm or Discard, and no dialog", async () => {
  const ui = await open(view({ active }), { state: "active", revision: 1 })
  const labels = [...ui.root.querySelectorAll("button")].map((b) => b.textContent)
  expect(labels).not.toContain("Confirm")
  expect(labels).not.toContain("Discard")
  expect(ui.text()).not.toMatch(/pending|proposed|not active|confirm/i)
  expect(ui.api.confirms).toEqual([])
  ui.close()
})

test("earlier revisions are listed with who set them and why", async () => {
  const earlier = revision(1, base, [], {
    state: "superseded",
    author: { kind: "owner" },
    reason: "first setup",
  })
  const ui = await open(
    view({
      active: revision(2, base, [proof("verify:tests", "cargo test --locked")]),
      history: [earlier],
    }),
    { state: "active", revision: 2 },
  )
  expect(ui.text()).toContain("Earlier revisions")
  expect(ui.text()).toContain("Revision 1, set by owner")
  expect(ui.text()).toContain("first setup")
  ui.close()
})

test("saving invalid JSON shows the parse error and calls nothing", async () => {
  const ui = await open(view({ active }), { state: "active", revision: 1 })
  await ui.press("Edit")
  await ui.type("Profile JSON", "{ nope")
  await ui.type("Reason", "x")
  await ui.press("Save")
  expect(ui.text()).toContain("Not valid JSON")
  expect(ui.calls("saveProfile")).toEqual([])
  ui.close()
})

test("a refusal is shown beside the editor and the old profile stays displayed", async () => {
  const ui = await open(view({ active }), { state: "active", revision: 1 })
  await ui.press("Edit")
  await ui.type("Profile JSON", JSON.stringify({ ...base, verify: [] }))
  await ui.type("Reason", "drop verify")
  await ui.press("Save")
  expect(ui.calls("saveProfile")).toHaveLength(1)
  expect(ui.calls("saveProfile")[0]!.input).toMatchObject({
    key: "k",
    reason: "drop verify",
    profile: { verify: [] },
  })
  expect(ui.text()).toContain("verify: A profile needs at least one verify command")
  expect(ui.text()).toContain("cargo test --locked")
  expect(ui.api.toasts.every((toast) => !toast.open)).toBe(true)
  expect(ui.api.toasts).toHaveLength(1)
  ui.close()
})

test("a Settings save is the new active revision at once: the editor closes and no confirmation is asked", async () => {
  const ui = await open(
    view({ active }),
    { state: "active", revision: 1 },
    {
      save: {
        ok: true,
        revision: 2,
        proofs: [],
        mapPreview: {
          files: 0,
          names: 0,
          tokens: 0,
          largestFolders: [],
          currentFiles: 0,
          currentTokens: 0,
        },
        changes: [],
      },
    },
  )
  await ui.press("Edit")
  await ui.type("Reason", "tweak")
  await ui.press("Save")
  expect(ui.calls("saveProfile")).toHaveLength(1)
  expect(ui.api.confirms).toEqual([])
  expect(ui.root.querySelector('[aria-label="Profile JSON"]')).toBeNull()
  ui.close()
})
