import { createComponent, createRoot, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { LinkHandler, Panel, Style } from "@opencode/plugin/gui"
import type { Panel as PanelContribution } from "@opencode/plugin/gui"
import {
  PanelContext,
  PluginContext,
} from "../../../node_modules/@opencode/plugin/dist/gui/internal.js"
import type { PanelAdapter } from "./adapter.ts"
import { createUi } from "./ui.tsx"
import { nativeBusyStyles } from "../../../src/native-busy-styles.ts"
import { panelStatusStyles } from "../../../src/panel-status.tsx"
import { detailsPaneStyles } from "../../../src/details-pane.css.ts"
import { detailsKitStyles } from "../../../src/details/styles.ts"

function store<T>(initial: T) {
  const [read, write] = createSignal(initial, { equals: false })
  return {
    get value() {
      return read()
    },
    ready: () => true,
    update(change: (draft: T) => void) {
      const draft = structuredClone(read())
      change(draft)
      write(() => draft)
    },
    snapshot: read,
  }
}

/** A tiny pub/sub that backs `client.event.subscribe` and `rpc(...).events.subscribe`. */
function createBus(directory: string) {
  type BusEvent = { type: string; data: unknown; location?: { directory: string } }
  const subs = new Set<(event: BusEvent) => void>()
  const emit = (type: string, data: unknown) => {
    // Native events carry the location they belong to; panels filter on it.
    for (const sub of subs) sub({ type, data, location: { directory } })
  }
  async function* stream(
    accept: (type: string) => boolean,
    signal: AbortSignal,
  ): AsyncGenerator<BusEvent> {
    const queue: BusEvent[] = []
    let wake: (() => void) | undefined
    const sub = (event: BusEvent) => {
      if (!accept(event.type)) return
      queue.push(event)
      wake?.()
    }
    subs.add(sub)
    signal.addEventListener("abort", () => wake?.(), { once: true })
    try {
      // The native shared stream announces every connection first.
      yield { type: "server.connected", data: {} }
      while (!signal.aborted) {
        if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve))
        wake = undefined
        const next = queue.shift()
        if (next) yield next
      }
    } finally {
      subs.delete(sub)
    }
  }
  return { emit, stream }
}

export interface MountedHost<D> {
  /** Tell the panel the data changed: the host emits the adapter's change events. */
  changed(data: D): void
  dispose(): void
}

export function mountPanel<D>(
  adapter: PanelAdapter<D>,
  container: HTMLElement,
  getData: () => D,
): MountedHost<D> {
  const bus = createBus(adapter.project.canonical)
  const table = adapter.rpc(getData)
  const client = {
    location: { get: async () => ({ project: adapter.project }) },
    // The global project list: how a panel identifies the project that owns its directory.
    project: { list: async () => [adapter.project] },
    rpc: (contract: { id: string }) =>
      new Proxy(
        {},
        {
          get(_target, method: string) {
            if (method === "events")
              return {
                subscribe: (name: string, options: { signal: AbortSignal }) =>
                  bus.stream((type) => type === `rpc.${contract.id}.${name}`, options.signal),
              }
            return async (input: unknown) => {
              const handler = table[contract.id]?.[method]
              if (!handler)
                throw new Error(`The demo host has no answer for ${contract.id}.${method}`)
              await new Promise<void>((resolve) => setTimeout(resolve, 12))
              // A handler may answer later (a slow source in a test): the reply is what it settles to.
              return structuredClone(await handler(input as never))
            }
          },
        },
      ),
    event: {
      subscribe: (options: { types?: readonly string[]; signal: AbortSignal }) =>
        bus.stream((type) => !options.types || options.types.includes(type), options.signal),
    },
  }
  const server = { id: "demo", connected: true, client }
  const session = {
    id: "ses-demo",
    key: "demo\nses-demo",
    tab: "demo",
    pending: false,
    location: { directory: adapter.project.canonical },
    directory: adapter.project.canonical,
    server,
  }
  const registrations: { token: unknown; value: unknown }[] = []
  const stores = new Map<string, ReturnType<typeof store>>()
  const named = (name: string) => {
    let found = stores.get(name)
    if (!found) {
      found = store(adapter.stores?.[name] ?? { projects: {} })
      stores.set(name, found)
    }
    return found
  }
  const openPanel = (id: string) => console.info(`[demo] open panel ${id}`)
  const ctx = {
    id: "lazers",
    app: { platform: "web" },
    signal: new AbortController().signal,
    ui: createUi(),
    appearance: {
      mode: () => "dark",
      font: (kind?: string) =>
        kind === "mono"
          ? 'ui-monospace, "SF Mono", Menlo, Consolas, monospace'
          : "system-ui, sans-serif",
    },
    add: (token: unknown, value: unknown) => {
      registrations.push({ token, value })
      if (token === Style && typeof value === "string") {
        const style = document.createElement("style")
        style.textContent = value
        document.head.append(style)
      }
    },
    sessions: { current: () => session, list: () => [session] },
    layout: { open: (id: string) => openPanel(id) },
    tabs: { open: () => {} },
    // A per-session store is called (`ctx.stores.taskView(session)`); a global one is read
    // directly (`ctx.stores.taskStateDefaults.ready()`): one stand-in answers both.
    stores: new Proxy(
      {},
      {
        get: (_target, name: string) =>
          new Proxy(() => named(name), {
            get: (target, key) =>
              key in target ? Reflect.get(target, key) : Reflect.get(named(name), key),
          }),
      },
    ),
    links: { open: () => {} },
    system: { copy: async () => {} },
    servers: { get: () => server },
    dialogs: {
      confirm: async () => true,
      /** A searchable list in a layer over the panel; resolves to the chosen value. */
      select: (options: {
        title: string
        options: { title: string; value: string; group?: string; description?: string }[]
      }) =>
        new Promise<string | undefined>((resolve) => {
          const layer = document.createElement("div")
          layer.className = "oc-dialog"
          layer.setAttribute("role", "dialog")
          layer.setAttribute("aria-label", options.title)
          const list = document.createElement("div")
          list.className = "oc-dialog-list"
          const heading = document.createElement("strong")
          heading.textContent = options.title
          list.append(heading)
          const done = (value: string | undefined) => {
            layer.remove()
            resolve(value)
          }
          let group = ""
          for (const option of options.options) {
            if (option.group && option.group !== group) {
              group = option.group
              const name = document.createElement("small")
              name.textContent = group
              list.append(name)
            }
            const item = document.createElement("button")
            item.type = "button"
            item.setAttribute("role", "option")
            item.dataset.value = option.value
            item.textContent = option.title
            item.addEventListener("click", () => done(option.value))
            list.append(item)
          }
          layer.addEventListener(
            "pointerdown",
            (event) => event.target === layer && done(undefined),
          )
          layer.append(list)
          container.append(layer)
        }),
    },
  }

  const frame = {
    visible: () => true,
    present: () => true,
    placement: () => "side" as const,
    reserve: () => false,
    animate: () => false,
    sidebar: {
      opened: () => false,
      width: () => 0,
      transition: () => false,
      resize: () => {},
      toggle: () => {},
    },
    open: () => [adapter.panelID],
  }

  let disposeSetup = () => {}
  createRoot((dispose) => {
    disposeSetup = dispose
    createComponent(PluginContext.Provider, {
      value: ctx as never,
      get children() {
        // The plugin root registers the shared styles before any panel (src/gui.tsx setup).
        for (const css of [
          nativeBusyStyles,
          panelStatusStyles,
          detailsPaneStyles,
          detailsKitStyles,
        ])
          ctx.add(Style, css)
        adapter.setup(ctx as never, { openPanel })
        return null
      },
    })
  })
  const panel = registrations.find(
    (entry) => entry.token === Panel && (entry.value as { id?: string }).id === adapter.panelID,
  )?.value as PanelContribution | undefined
  if (!panel) throw new Error(`The ${adapter.panelID} panel did not register`)
  void LinkHandler

  const dispose = render(
    () =>
      createComponent(PluginContext.Provider, {
        value: ctx as never,
        get children() {
          return createComponent(PanelContext.Provider, {
            value: frame as never,
            get children() {
              return panel.render({
                tab: {
                  id: adapter.panelID,
                  title: adapter.tabTitle,
                  closable: "hover",
                  label: () => null,
                },
                session,
                screen: {
                  file: {
                    sync: async () => {},
                    get: () => undefined,
                    selection: { set: () => {} },
                  },
                },
              } as never)
            },
          })
        },
      }),
    container,
  )
  return {
    changed: (data) => adapter.changed(data, bus.emit),
    dispose() {
      dispose()
      disposeSetup()
    },
  }
}
