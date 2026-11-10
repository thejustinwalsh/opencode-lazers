import { Plugin, SettingsPage, Slot, Store, Style, bindPlugin } from "@opencode/plugin/gui"
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { Budget, BudgetSettings, defaults, unavailable } from "./contract.ts"
import type { Settings, Usage } from "./contract.ts"
import { localWeek, ring } from "./usage.ts"
import { SharedUsage } from "./poller.ts"

export const budgetStores = { budget: Store.global(BudgetSettings, defaults) }
type SettingsStore = { readonly value: Settings | undefined; set(value: Settings): void }
const localTime = (ms: number | string) => new Date(ms).toLocaleString()

export function presentation(settings: Settings, usage: Usage) {
  if (usage.status !== "available")
    return {
      label: "—",
      percent: null,
      lines: [
        usage.reason,
        ...(settings.provider === "openrouter" && usage.coverageStart !== null
          ? [`Configured key · since ${localTime(usage.coverageStart)}`]
          : []),
      ],
    }
  if (settings.provider === "go") {
    const selected = usage[settings.mode]
    if (!selected || !usage.monthly || !usage.rolling)
      return { label: "—", percent: null, lines: ["Go usage unavailable."] }
    return {
      label: `${Math.round(selected.percent)}%`,
      percent: selected.percent,
      lines: [
        `Monthly ${usage.monthly.percent}% · resets ${localTime(usage.monthly.resetsAt)}`,
        `5-hour ${usage.rolling.percent}% · resets ${localTime(usage.rolling.resetsAt)}`,
      ],
    }
  }
  if (usage.creditUSD === null || usage.byokUSD === null || usage.coverageStart === null)
    return { label: "—", percent: null, lines: ["Configured-key spend unavailable."] }
  const total = usage.creditUSD + usage.byokUSD
  return {
    label: `$${Math.round(total)}`,
    percent: (total / settings.weeklyUSD) * 100,
    lines: [
      `Credits $${Math.round(usage.creditUSD)}`,
      `BYOK $${Math.round(usage.byokUSD)}`,
      `Configured key · since ${localTime(usage.coverageStart)}`,
      "Earlier weekly usage unknown",
      `Resets ${localTime(localWeek().end)} (${localWeek().timezone})`,
    ],
  }
}

export function setupBudget(ctx: Parameters<Plugin.Setup>[0], store: SettingsStore) {
  const settings = () => store.value ?? defaults
  const Ui = ctx.ui
  const [visible, setVisible] = createSignal(document.visibilityState !== "hidden")
  const visibility = () => setVisible(document.visibilityState !== "hidden")
  document.addEventListener("visibilitychange", visibility)
  onCleanup(() => document.removeEventListener("visibilitychange", visibility))
  const clients = new WeakMap<object, Map<Settings["provider"], SharedUsage>>()
  const Header = bindPlugin(
    (props: {
      active: boolean
      compact: boolean
      client: typeof ctx.client
      connected: boolean
    }) => {
      const [usage, setUsage] = createSignal<Usage>(unavailable("Loading provider usage…"))
      createEffect(() => {
        const enabled = settings().enabled
        const provider = settings().provider
        const client = props.client
        const connected = props.connected
        setUsage(
          unavailable(connected ? "Loading provider usage…" : "Provider server is disconnected."),
        )
        if (!enabled || !props.active || !visible() || !connected) return
        let providers = clients.get(client)
        if (!providers) {
          providers = new Map()
          clients.set(client, providers)
        }
        let shared = providers.get(provider)
        if (!shared) {
          shared = new SharedUsage(
            async (signal) => {
              const week = localWeek()
              const result = await client
                .rpc(Budget)
                .read(
                  { provider, ...week },
                  { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) },
                )
              const current = localWeek()
              return week.start === current.start && week.timezone === current.timezone
                ? result
                : unavailable("Local week changed; refreshing baseline.")
            },
            () => Math.max(1, Math.min(60_000, localWeek().end - Date.now())),
            async (invalidate, signal) => {
              let connected = false
              for await (const event of client.event.subscribe({
                types: ["credential.switched", "credential.updated", "integration.updated"],
                signal,
              })) {
                if (signal.aborted) return
                if (event.type === "server.connected" && !connected) {
                  connected = true
                  continue
                }
                invalidate()
              }
            },
          )
          providers.set(provider, shared)
        }
        onCleanup(shared.subscribe(setUsage))
      })
      const view = () => presentation(settings(), usage())
      const providerName = () => (settings().provider === "go" ? "OpenCode Go" : "OpenRouter")
      const title = () =>
        `${providerName()} · ${view().label}${settings().provider === "openrouter" ? ` / $${settings().weeklyUSD} weekly budget` : ""}`
      const accessibleLabel = () =>
        `${providerName()} ${view().label}, ${settings().provider === "go" ? `${settings().mode === "monthly" ? "monthly" : "5-hour"} allowance` : "configured-key tracked spend"}. Open provider budget settings.`
      return (
        <Show when={settings().enabled}>
          <Ui.Tooltip
            value={
              <div class="lazers-budget-tooltip">
                <div>{title()}</div>
                <For each={view().lines}>{(line) => <div>{line}</div>}</For>
              </div>
            }
          >
            <button
              type="button"
              class="lazers-budget"
              aria-label={accessibleLabel()}
              data-tone={ring(view().percent).tone}
              onClick={() => ctx.layout.settings("budget")}
            >
              <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
                <circle cx="10" cy="10" r="7.5" class="budget-track" />
                <Show when={view().percent !== null}>
                  <circle
                    cx="10"
                    cy="10"
                    r="7.5"
                    class="budget-value"
                    pathLength="100"
                    stroke-dasharray={`${ring(view().percent).fraction * 100} 100`}
                    transform="rotate(-90 10 10)"
                  />
                </Show>
                <Show when={view().percent === null}>
                  <path d="M8 10h4" class="budget-value" />
                </Show>
              </svg>
              <Show when={!props.compact}>
                <span>{view().label}</span>
              </Show>
            </button>
          </Ui.Tooltip>
        </Show>
      )
    },
  )
  ctx.add(Slot, {
    at: "session.header",
    render: (input) => (
      <Header
        active={input.active}
        compact={input.compact}
        client={input.session.server.client}
        connected={input.session.server.connected}
      />
    ),
  })
  const Page = bindPlugin(() => {
    const [error, setError] = createSignal("")
    const save = (patch: Partial<Settings>) => {
      try {
        store.set({ ...settings(), ...patch })
        setError("")
      } catch {
        setError("Could not save provider budget settings.")
      }
    }
    return (
      <div class="lazers-budget-settings">
        <h1>Provider budget</h1>
        <p>Read-only provider usage. This does not enforce a budget or change model routing.</p>
        <Ui.Switch
          checked={settings().enabled}
          onChange={(enabled) => save({ enabled })}
          label="Show session-header budget"
        />
        <label>
          Provider
          <select
            value={settings().provider}
            onChange={(e) => save({ provider: e.currentTarget.value as Settings["provider"] })}
          >
            <option value="go">OpenCode Go</option>
            <option value="openrouter">OpenRouter</option>
          </select>
        </label>
        <label>
          Go allowance
          <select
            value={settings().mode}
            onChange={(e) => save({ mode: e.currentTarget.value as Settings["mode"] })}
          >
            <option value="monthly">Monthly</option>
            <option value="rolling">Rolling 5-hour</option>
          </select>
        </label>
        <label>
          OpenRouter weekly budget (USD)
          <input
            type="number"
            min="0.01"
            step="any"
            value={settings().weeklyUSD}
            onChange={(e) => {
              const weeklyUSD = Number(e.currentTarget.value)
              if (Number.isFinite(weeklyUSD) && weeklyUSD > 0) save({ weeklyUSD })
              else setError("Enter a weekly budget greater than zero.")
            }}
          />
        </label>
        <p>
          OpenRouter uses the configured key’s credit + BYOK counters, not account-wide spending.
          Weeks start Sunday at midnight in this computer’s local timezone. First use, missed
          Sunday, timezone changes or counter resets start a new observed baseline; earlier spending
          is unknown, not zero.
        </p>
        <p role="status">{error()}</p>
      </div>
    )
  })
  ctx.add(SettingsPage, {
    id: "budget",
    title: "Provider budget",
    icon: "settings-gear",
    render: () => <Page />,
  })
  ctx.add(Style, budgetStyles)
}

export const budgetStyles = `
.lazers-budget { display:inline-flex; align-items:center; justify-content:center; gap:6px; flex-shrink:0; height:40px; min-width:36px; padding:0 8px; border:0; border-radius:8px; background:transparent; color:var(--text-base); font:inherit; font-size:12px; white-space:nowrap; cursor:pointer; }
.lazers-budget:hover { background:var(--surface-base-hover); }
.lazers-budget:focus-visible { outline:2px solid var(--text-base); outline-offset:-2px; }
.lazers-budget svg { flex-shrink:0; fill:none; stroke:var(--icon-base); stroke-width:1.5; }
.lazers-budget .budget-track { opacity:.2; }
.lazers-budget .budget-value { stroke-opacity:.85; }
.lazers-budget[data-tone=warning] .budget-value { stroke:var(--icon-warning-base); }
.lazers-budget[data-tone=critical] .budget-value { stroke:var(--icon-critical-base); }
.lazers-budget[data-tone=unknown] { color:var(--text-weak); }
.lazers-budget-tooltip { display:grid; gap:4px; max-width:38ch; white-space:normal; overflow-wrap:anywhere; text-align:left; }
.lazers-budget-settings { padding:24px; max-width:640px; color:var(--text-base); font:inherit; }
.lazers-budget-settings h1 { font-size:20px; font-weight:500; }
.lazers-budget-settings p { color:var(--text-weak); font-size:13px; line-height:1.5; overflow-wrap:anywhere; margin:12px 0; }
.lazers-budget-settings label { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px; margin:16px 0; font-size:13px; }
.lazers-budget-settings select,.lazers-budget-settings input { font:inherit; color:var(--text-base); background:var(--surface-base); border:1px solid var(--border-weak-base); border-radius:6px; padding:6px 8px; max-width:100%; min-width:0; }
.lazers-budget-settings :is(select,input):focus-visible { outline:2px solid var(--border-selected); }
`
