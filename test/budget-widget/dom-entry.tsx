import { createComponent, createRoot, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { Slot, Style } from "@opencode/plugin/gui"
import { PluginContext } from "../../node_modules/@opencode/plugin/dist/gui/internal.js"
import { setupBudget } from "../../src/budget/gui.tsx"
import { defaults, unavailable } from "../../src/budget/contract.ts"
import type { Settings, Usage } from "../../src/budget/contract.ts"
import { parseGo } from "../../src/budget/usage.ts"

export function harness(root: HTMLElement, initial: Settings = defaults) {
  const [settings, setSettings] = createSignal(initial)
  const [active, setActive] = createSignal(true)
  const [compact, setCompact] = createSignal(false)
  const [connected, setConnected] = createSignal(true)
  const [clientVersion, setClientVersion] = createSignal(0)
  let requestCount = 0
  let usage: Usage = parseGo({
    usage: {
      monthly: { percent: 60, status: "ok", resetsAt: "2026-11-23T00:00:00Z" },
      rolling: { percent: 112.3, status: "ok", resetsAt: "2026-11-09T06:00:00Z" },
    },
  })
  const clients = [0, 1].map(() => ({
    rpc: () => ({
      read: async () => {
        requestCount++
        return usage
      },
    }),
    event: { subscribe: async function* () {} },
  }))
  let saved = JSON.stringify(initial)
  const store = {
    get value() {
      return settings()
    },
    set(value: Settings) {
      saved = JSON.stringify(value)
      setSettings(value)
    },
  }
  const contributions: Array<{ token: unknown; value: unknown }> = []
  let openedPage = ""
  const ctx = {
    id: "lazers",
    client: clients[0],
    layout: {
      settings: (page: string) => {
        openedPage = page
      },
    },
    ui: {
      Tooltip: (props: {
        value: import("solid-js").JSX.Element
        children: import("solid-js").JSX.Element
      }) => (
        <span class="fixture-tooltip">
          {props.children}
          <span class="fixture-tooltip-content" role="tooltip">
            {props.value}
          </span>
        </span>
      ),
      SettingsSection: (props: {
        title?: string
        children: import("solid-js").JSX.Element
        footer?: import("solid-js").JSX.Element
      }) => (
        <section aria-label={props.title}>
          <h2>{props.title}</h2>
          {props.children}
          {props.footer}
        </section>
      ),
      SettingsRow: (props: {
        title: import("solid-js").JSX.Element
        description?: import("solid-js").JSX.Element
        children?: import("solid-js").JSX.Element
      }) => (
        <div class="fixture-row">
          <span>{props.title}</span>
          <span>{props.description}</span>
          {props.children}
        </div>
      ),
      Select: (props: {
        label: string
        value: string | undefined
        options: readonly { value: string; label: string }[]
        onChange(value: string): void
      }) => (
        <select
          aria-label={props.label}
          value={props.value}
          onChange={(e) => props.onChange(e.currentTarget.value)}
        >
          {props.options.map((option) => (
            <option value={option.value}>{option.label}</option>
          ))}
        </select>
      ),
      TextInput: (props: { label: string; value: string; onInput(value: string): void }) => (
        <input
          aria-label={props.label}
          value={props.value}
          onInput={(e) => props.onInput(e.currentTarget.value)}
        />
      ),
      Switch: (props: { label: string; checked: boolean; onChange(value: boolean): void }) => (
        <label>
          {props.label}
          <input
            aria-label={props.label}
            type="checkbox"
            role="switch"
            checked={props.checked}
            onChange={(e) => props.onChange(e.currentTarget.checked)}
          />
        </label>
      ),
    },
    add: (token: unknown, value: unknown) => contributions.push({ token, value }),
  }
  let Section!: ReturnType<typeof setupBudget>
  const setupDispose = createRoot((dispose) => {
    createComponent(PluginContext.Provider, {
      value: ctx as never,
      get children() {
        Section = setupBudget(ctx as never, store)
        return null
      },
    })
    return dispose
  })
  const slot = contributions.find((c) => c.token === Slot)!.value as {
    render(input: unknown): import("solid-js").JSX.Element
  }
  const style = document.createElement("style")
  style.textContent = contributions.find((c) => c.token === Style)!.value as string
  root.append(style)
  const dispose = render(
    () =>
      createComponent(PluginContext.Provider, {
        value: ctx as never,
        get children() {
          return (
            <>
              <div class="fixture-header">
                <span>Session · context</span>
                {[0, 1].map(() =>
                  slot.render({
                    get active() {
                      return active()
                    },
                    get compact() {
                      return compact()
                    },
                    session: {
                      server: {
                        get client() {
                          return clients[clientVersion()]
                        },
                        get connected() {
                          return connected()
                        },
                      },
                    },
                  }),
                )}
              </div>
              <Section />
            </>
          )
        },
      }),
    root,
  )
  return {
    settings,
    setSettings: (patch: Partial<Settings>) => store.set({ ...settings(), ...patch }),
    setActive,
    setCompact,
    setConnected,
    replaceClient: () => setClientVersion(1),
    setUsage: (value: Usage) => {
      usage = value
    },
    unavailable,
    get requests() {
      return requestCount
    },
    get openedPage() {
      return openedPage
    },
    reopen: () => setSettings(JSON.parse(saved)),
    dispose() {
      dispose()
      setupDispose()
      style.remove()
    },
  }
}
