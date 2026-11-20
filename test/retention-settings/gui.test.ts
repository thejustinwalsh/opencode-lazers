import { expect, test } from "bun:test"
import { Window } from "happy-dom"
import type { HTMLButtonElement, HTMLInputElement, HTMLSelectElement } from "happy-dom"
import solid from "vite-plugin-solid"
import { build } from "vite"
import { fileURLToPath, pathToFileURL } from "node:url"
import { compactionNotice, parseDays } from "../../src/retention/format.ts"
import type {
  RetentionPreviewView,
  RetentionSliceView,
  RetentionStatusView,
} from "../../src/retention/contract.ts"

const status: RetentionStatusView = {
  fileBytes: 2_520_000_000,
  freeBytes: 0,
  autoVacuum: "incremental",
  compactionDiskBytes: 0,
  presets: [
    { days: 7, rows: 9000, bytes: 700_000_000 },
    { days: 14, rows: 100, bytes: 20_000_000 },
    { days: 30, rows: 0, bytes: 0 },
    { days: 60, rows: 0, bytes: 0 },
    { days: 90, rows: 0, bytes: 0 },
  ],
  superseded: { rows: 5, bytes: 5 },
  autoDays: null,
  lastRun: null,
}
const preview = (days: number): RetentionPreviewView => ({
  days,
  asOf: 1_000,
  cutoff: 0,
  kinds: [
    { id: "progress", label: "Worker activity", detail: "d", rows: 6131, bytes: 14_000_000 },
    { id: "notices", label: "Delivered notices", detail: "d", rows: 0, bytes: 0 },
  ],
  rows: 6131,
  bytes: 14_000_000,
  plans: { retired: 3, kept: 9 },
  protected: [
    {
      reason: "tasks with their reference, title, state and disposition",
      count: 255,
      noun: "tasks",
    },
    { reason: "plan is not finished", count: 11, noun: "plans" },
  ],
  worktrees: [
    { path: "/p.worktrees/a", bytes: 3_000_000, action: "remove", reason: "clean and merged" },
    { path: "/p.worktrees/b", bytes: 1_000, action: "keep", reason: "uncommitted changes" },
  ],
  worktreeBytes: 3_000_000,
})
const slice = (done: boolean, rows: number): RetentionSliceView => ({
  runID: 7,
  asOf: 1_000,
  done,
  removed: {},
  rows,
  bytes: rows * 100,
  worktrees: done ? [{ path: "/p.worktrees/a", bytes: 3_000_000 }] : [],
  skipped: [],
  fileBytes: 2_520_000_000,
  freeBytes: 600_000_000,
  reclaimedBytes: done ? 250_000_000 : 0,
})

test("the days field accepts presets and a custom count from 1 to 3650 only", () => {
  expect(parseDays("30", "")).toBe(30)
  expect(parseDays("custom", " 45 ")).toBe(45)
  for (const bad of ["", "0", "-3", "1.5", "abc", "3651"])
    expect(parseDays("custom", bad)).toBeUndefined()
})

test("a database that never returns free pages shows the one-time compaction, its command and disk need", () => {
  const big = {
    ...status,
    autoVacuum: "none" as const,
    freeBytes: 600_000_000,
    compactionDiskBytes: 4_000_000_000,
  }
  const notice = compactionNotice(big)!
  expect(notice).toContain("600 MB of the file is free")
  expect(notice).toContain("bun scripts/compact-database.ts --db <path> --yes")
  expect(notice).toContain("needs 4.0 GB of free disk")
  // Incremental, or little free space: nothing to say.
  expect(compactionNotice({ ...big, autoVacuum: "incremental" })).toBeUndefined()
  expect(compactionNotice({ ...big, freeBytes: 1_000_000 })).toBeUndefined()
})

test("retire needs a preview of the chosen age, then a confirmation, then reports progress and result", async () => {
  const dom = new Window({ url: "https://retention.localhost" })
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
    const outDir = fileURLToPath(
      new URL("../../node_modules/.cache/retention-dom", import.meta.url),
    )
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
          fileName: "retention-dom",
        },
        rolldownOptions: { output: { codeSplitting: false } },
      },
    })
    const { harness } = (await import(
      pathToFileURL(`${outDir}/retention-dom.js`).href
    )) as typeof import("./dom-entry.tsx")
    const root = dom.document.createElement("main")
    dom.document.body.append(root)
    let agree = false
    const api = harness(root as unknown as HTMLElement, {
      status,
      preview,
      slices: [slice(false, 4000), slice(true, 2131)],
      confirm: () => agree,
    })
    dispose = api.dispose
    const tick = () => Bun.sleep(0)
    await tick()
    const button = (text: string) =>
      [...root.querySelectorAll<HTMLButtonElement>("button")].find(
        (item) => item.textContent === text,
      )!
    const select = root.querySelector<HTMLSelectElement>(
      '[aria-label="Retire history older than"]',
    )!
    const labels = [...select.querySelectorAll("option")].map((option) => option.textContent)
    expect(labels[0]).toBe("7 days · 700 MB")
    expect(labels[2]).toBe("30 days")
    expect(labels.at(-1)).toBe("Custom…")
    expect(root.textContent).toContain("2.5 GB on disk · 0 B reusable")
    expect(root.querySelector(".fixture-description")!.textContent).toBe("")

    // No preview: Retire cannot be pressed.
    expect(button("Retire").disabled).toBe(true)
    expect(button("Preview").disabled).toBe(false)
    button("Preview").click()
    await tick()
    expect(api.calls.filter((call) => call.method === "preview")).toEqual([
      { method: "preview", input: { days: 30 } },
    ])
    const shown = root.querySelector(".lazers-retention-preview")!.textContent!
    expect(shown).toContain("Will retire 6,131 records · 14.0 MB")
    expect(shown).toContain("Worker activity6,131 · 14.0 MB")
    expect(shown).not.toContain("Delivered notices")
    expect(shown).toContain("Worktrees1 · 3.0 MB")
    expect(shown).toContain("255 tasks: tasks with their reference")
    expect(shown).toContain("Worktree b (1 KB): uncommitted changes")
    expect(button("Retire").disabled).toBe(false)

    // A changed age invalidates the preview.
    select.value = "60"
    select.dispatchEvent(new dom.Event("change", { bubbles: true }))
    await tick()
    expect(root.querySelector(".lazers-retention-preview")).toBeNull()
    expect(button("Retire").disabled).toBe(true)
    select.value = "custom"
    select.dispatchEvent(new dom.Event("change", { bubbles: true }))
    await tick()
    const days = root.querySelector<HTMLInputElement>('[aria-label="Days"]')!
    days.value = "0"
    days.dispatchEvent(new dom.Event("input", { bubbles: true }))
    await tick()
    expect(button("Preview").disabled).toBe(true)
    days.value = "45"
    days.dispatchEvent(new dom.Event("input", { bubbles: true }))
    await tick()
    button("Preview").click()
    await tick()
    expect(api.calls.at(-1)).toEqual({ method: "preview", input: { days: 45 } })

    // Declined confirmation retires nothing.
    button("Retire").click()
    await tick()
    expect(api.confirmations).toHaveLength(1)
    expect(api.confirmations[0]).toMatchObject({ danger: true })
    expect(api.confirmations[0]!.title).toBe("Retire 6,131 records and 1 worktree?")
    expect(api.confirmations[0]!.description).toContain("cannot be undone")
    expect(api.calls.some((call) => call.method === "retire")).toBe(false)

    agree = true
    button("Retire").click()
    await Bun.sleep(20)
    const retires = api.calls.filter((call) => call.method === "retire")
    expect(retires).toEqual([
      { method: "retire", input: { days: 45, asOf: 1000, confirmed: true } },
      { method: "retire", input: { days: 45, asOf: 1000, confirmed: true, runID: 7 } },
    ])
    expect(root.querySelector('[role="status"]')?.textContent).toContain(
      "Retired 6,131 records (613 KB) and 1 worktree (3.0 MB).",
    )
    expect(root.querySelector('[role="status"]')?.textContent).toContain("Returned 250 MB to disk.")
    expect(root.querySelector('[role="status"]')?.textContent).toContain(
      "600 MB inside the database file is free for reuse; later retention passes return it to disk.",
    )
    expect(root.querySelector(".lazers-retention-preview")).toBeNull()

    // Automatic retention is off until switched on, and off again by the same switch.
    const auto = root.querySelector<HTMLInputElement>('[aria-label="Retire automatically"]')!
    expect(auto.checked).toBe(false)
    auto.checked = true
    auto.dispatchEvent(new dom.Event("change", { bubbles: true }))
    await tick()
    expect(api.calls.at(-1)).toEqual({ method: "setAuto", input: { days: 45 } })
    auto.checked = false
    auto.dispatchEvent(new dom.Event("change", { bubbles: true }))
    await tick()
    expect(api.calls.at(-1)).toEqual({ method: "setAuto", input: { days: null } })
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
