import { afterAll, beforeAll, expect, test } from "bun:test"
import { Window } from "happy-dom"
import solid from "vite-plugin-solid"
import { build } from "vite"
import { mkdir, rm } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { installTasksLayout } from "../../../test/observation-panels/virtual-layout.ts"

/**
 * Smoke test: each story's panel mounts in a DOM, every chapter can be entered settled, and every
 * action's selector resolves to a real element of the real panel (the engine warns when not).
 * Happy DOM has no layout, so list panels get the same fake viewport the repo's panel tests use.
 */
const entry = fileURLToPath(new URL("./entry.ts", import.meta.url))
const outDir = fileURLToPath(
  new URL("../../../node_modules/.cache/website-demo-test", import.meta.url),
)
type Bundle = typeof import("./entry.ts")
let bundle: Bundle

const globals = [
  "window",
  "document",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "HTMLDivElement",
  "HTMLDetailsElement",
  "Document",
  "DocumentFragment",
  "Text",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "PointerEvent",
  "WheelEvent",
  "MutationObserver",
  "customElements",
  "navigator",
  "location",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const

beforeAll(async () => {
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
  await build({
    configFile: false,
    logLevel: "silent",
    resolve: { conditions: ["browser", "development", "module"] },
    define: { __LAZERS_RADAR_WORKER_SOURCE__: JSON.stringify("") },
    plugins: [solid()],
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      lib: { entry, formats: ["es"], fileName: "demo-test" },
      rolldownOptions: { output: { codeSplitting: false } },
    },
  })
  bundle = (await import(pathToFileURL(`${outDir}/demo-test.js`).href)) as Bundle
})
afterAll(() => rm(outDir, { recursive: true, force: true }))

async function inDom<T>(run: (dom: Window) => Promise<T>): Promise<T> {
  const dom = new Window({ url: "https://demo.localhost" })
  Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: 420 })
  const uninstall = installTasksLayout(dom)
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const name of globals) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: (dom as unknown as Record<string, unknown>)[name],
    })
  }
  // Reports a size on observe, with both the legacy and the box-size fields panels read.
  class SizedResizeObserver {
    constructor(private readonly callback: (entries: ResizeObserverEntry[]) => void) {}
    observe(target: HTMLElement) {
      queueMicrotask(() => {
        if (!target.isConnected) return
        const width = target.clientWidth || 420
        const height = target.offsetHeight || target.clientHeight || 40
        this.callback([
          {
            target,
            contentRect: { width, height },
            borderBoxSize: [{ inlineSize: width, blockSize: height }],
          } as unknown as ResizeObserverEntry,
        ])
      })
    }
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: SizedResizeObserver,
  })
  Object.defineProperty(dom.window, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: SizedResizeObserver,
  })
  try {
    return await run(dom)
  } finally {
    uninstall()
    for (const [name, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
  }
}

const realStories = () => (bundle?.stories ?? []).map((source) => bundle.compile(source))

/**
 * Panels keep module-level view caches, and Solid delegates events on the first document it sees,
 * so each chapter runs in its own process, as it does in the browser (seeking reloads the page).
 */
test("every chapter of every story performs its actions on real elements", async () => {
  if (process.env.ONLY) return
  for (const story of realStories()) {
    for (const chapter of story.chapters) {
      const child = Bun.spawn(["bun", "test", import.meta.path], {
        env: { ...process.env, ONLY: `${story.id}:${chapter.name}` },
        stdout: "pipe",
        stderr: "pipe",
      })
      const code = await child.exited
      const text =
        (await new Response(child.stdout).text()) + (await new Response(child.stderr).text())
      expect(code, `${story.id}:${chapter.name}\n${text.slice(-1500)}`).toBe(0)
    }
  }
}, 600_000)

test("one chapter performs its actions", async () => {
  if (!process.env.ONLY) return
  // One DOM for the whole run: Solid delegates events on the first document it renders into.
  await inDom(async (dom) => {
    for (const story of realStories()) {
      for (const chapter of story.chapters) {
        if (process.env.ONLY && process.env.ONLY !== `${story.id}:${chapter.name}`) continue
        // A fresh panel per chapter, as seeking reloads the iframe.
        const warnings: string[] = []
        const warn = console.warn
        console.warn = (...args: unknown[]) => void warnings.push(args.join(" "))
        try {
          const module = await bundle.panels[story.panel]()
          const root = dom.document.createElement("div")
          dom.document.body.append(root)
          let current = bundle.dataAt(story, 0)
          const host: { mounted?: { changed(data: never): void; dispose(): void } } = {}
          const engine = new bundle.Engine({
            story,
            root: root as never,
            post: () => {},
            reduced: true,
            applyData(data) {
              current = data as typeof current
              host.mounted?.changed(data as never)
            },
          })
          host.mounted = module.mount(root as never, () => current as never)
          await engine.enter(chapter.name, true)
          expect(root.querySelector("*")).not.toBeNull()
          for (let i = 0; i < 100 && root.querySelector("[aria-busy=true]"); i++)
            await new Promise<void>((resolve) => setTimeout(resolve, 20))
          await new Promise<void>((resolve) => setTimeout(resolve, 600))
          if (process.env.DUMP === `${story.id}:${chapter.name}`) console.log(root.innerHTML)
          if (process.env.WARNS) console.log("WARNS", warnings)
          host.mounted?.dispose()
          root.remove()
        } finally {
          console.warn = warn
        }
        expect(
          warnings.filter((line) => line.includes("[demo]")),
          `${story.id}:${chapter.name}`,
        ).toEqual([])
      }
    }
  })
}, 180_000)
