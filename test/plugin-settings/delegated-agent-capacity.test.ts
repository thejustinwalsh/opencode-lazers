import { expect, test } from "bun:test"
import { Window } from "happy-dom"
import type { HTMLButtonElement, HTMLInputElement } from "happy-dom"
import solid from "vite-plugin-solid"
import { build } from "vite"
import { fileURLToPath, pathToFileURL } from "node:url"
import { join } from "node:path"
import type {
  CapacityClient,
  ConfigureInput,
  ConfigureResult,
  TestSession,
} from "./delegated-agent-capacity-dom.tsx"
import type { DelegatedAgentStatus } from "../../src/runner/delegated-agent-capacity.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function status(projectDirectory: string, limit: number, revision: number): DelegatedAgentStatus {
  return { projectDirectory, limit, revision, active: 1, queued: 2, reason: null }
}

function makeClient(
  reads: Array<Promise<DelegatedAgentStatus>>,
  configureResults: Array<Promise<ConfigureResult>>,
) {
  const readSessions: string[] = []
  const configured: ConfigureInput[] = []
  const client: CapacityClient = {
    rpc: () => ({
      read: (input) => {
        readSessions.push(input.sessionID)
        const result = reads.shift()
        if (!result) throw new Error("Unexpected capacity read")
        return result
      },
      configure: (input) => {
        configured.push(input)
        const result = configureResults.shift()
        if (!result) throw new Error("Unexpected capacity write")
        return result
      },
    }),
  }
  return { client, readSessions, configured }
}

function session(
  id: string,
  key: string,
  directory: string,
  serverID: string,
  client: CapacityClient,
  visit: object = {},
): TestSession {
  return {
    id,
    key,
    tab: "tab",
    visit,
    pending: false,
    directory,
    location: { directory },
    server: { id: serverID, connected: true, client },
  }
}

test("capacity settings identify the canonical project and ignore late scope and connection replies", async () => {
  const dom = new Window({ url: "https://capacity-settings.localhost" })
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
  for (const name of globals) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value: dom[name] })
  }
  let dispose: (() => void) | undefined
  try {
    const outDir = fileURLToPath(
      new URL("../../node_modules/.cache/delegated-agent-capacity-dom", import.meta.url),
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
          entry: fileURLToPath(new URL("./delegated-agent-capacity-dom.tsx", import.meta.url)),
          formats: ["es"],
          fileName: "capacity-dom",
        },
        rolldownOptions: { output: { codeSplitting: false } },
      },
    })
    const { harness } = (await import(
      pathToFileURL(join(outDir, "capacity-dom.js")).href
    )) as typeof import("./delegated-agent-capacity-dom.tsx")
    const root = dom.document.createElement("main")
    dom.document.body.append(root)
    const tick = () => Bun.sleep(0)

    const firstRead = deferred<DelegatedAgentStatus>()
    const first = makeClient([firstRead.promise], [])
    const firstSession = session(
      "ses-first",
      "server-one\nses-first",
      "/work/one",
      "server-one",
      first.client,
    )
    const api = harness(root as unknown as HTMLElement, firstSession)
    dispose = api.dispose
    await tick()
    expect(first.readSessions).toEqual(["ses-first"])

    const secondRead = deferred<DelegatedAgentStatus>()
    const second = makeClient([secondRead.promise], [])
    const secondVisit = {}
    api.setSession(
      session(
        "ses-second",
        "server-one\nses-second",
        "/work/two",
        "server-one",
        second.client,
        secondVisit,
      ),
    )
    await tick()
    expect(second.readSessions).toEqual(["ses-second"])

    const currentRead = deferred<DelegatedAgentStatus>()
    const lateConfigure = deferred<ConfigureResult>()
    const current = makeClient(
      [currentRead.promise, Promise.resolve(status("/canonical/current", 5, 5))],
      [
        Promise.resolve({
          status: "updated",
          settings: { projectDirectory: "/canonical/current", revision: 5, limit: 5 },
        }),
        lateConfigure.promise,
      ],
    )
    // Same mounted session and server identity, with a newly authenticated connection client.
    api.setSession(
      session(
        "ses-second",
        "server-one\nses-second",
        "/work/two",
        "server-one",
        current.client,
        secondVisit,
      ),
    )
    await tick()
    expect(current.readSessions).toEqual(["ses-second"])
    currentRead.resolve(status("/canonical/current", 3, 4))
    await tick()
    expect(root.textContent).toContain("Canonical project:")
    expect(root.textContent).toContain("/canonical/current")

    firstRead.resolve(status("/canonical/old-project", 9, 1))
    secondRead.resolve(status("/canonical/old-connection", 8, 2))
    await tick()
    expect(root.textContent).toContain("/canonical/current")
    expect(root.textContent).not.toContain("/canonical/old-project")
    expect(root.textContent).not.toContain("/canonical/old-connection")

    const input = root.querySelector<HTMLInputElement>("#lazers-agent-capacity-limit")!
    const save = root.querySelector<HTMLButtonElement>("button")!
    input.value = "1.5"
    input.dispatchEvent(new dom.Event("input", { bubbles: true }))
    save.click()
    await tick()
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      "positive whole-number limit",
    )
    expect(current.configured).toHaveLength(0)

    input.value = "5"
    input.dispatchEvent(new dom.Event("input", { bubbles: true }))
    save.click()
    await tick()
    expect(current.configured).toEqual([{ sessionID: "ses-second", expectedRevision: 4, limit: 5 }])
    await tick()
    expect(input.value).toBe("5")

    input.value = "6"
    input.dispatchEvent(new dom.Event("input", { bubbles: true }))
    save.click()
    await tick()
    expect(current.configured).toHaveLength(2)
    const other = makeClient([Promise.resolve(status("/canonical/other", 2, 1))], [])
    api.setSession(
      session("ses-other", "server-two\nses-other", "/work/other", "server-two", other.client),
    )
    await tick()
    expect(root.textContent).toContain("/canonical/other")
    lateConfigure.resolve({
      status: "updated",
      settings: { projectDirectory: "/canonical/current", revision: 6, limit: 6 },
    })
    await tick()
    expect(root.textContent).toContain("/canonical/other")
    expect(root.textContent).not.toContain("/canonical/current")
    expect(root.querySelector<HTMLInputElement>("#lazers-agent-capacity-limit")?.value).toBe("2")
  } finally {
    dispose?.()
    dom.happyDOM.abort()
    for (const name of globals) {
      const descriptor = previous.get(name)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})
