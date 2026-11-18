import { Plugin, Slot, Store, Style, bindPlugin } from "@opencode/plugin/gui"
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { Budget, BudgetSettings, defaults, unavailable } from "./contract.ts"
import type { Settings, Usage } from "./contract.ts"
import { localWeek, ring } from "./usage.ts"
import { SharedUsage } from "./poller.ts"
import { SettingLabel, settingLabelStyles } from "../settings-label.tsx"

export const budgetStores = { budget: Store.global(BudgetSettings, defaults) }
type SettingsStore = { readonly value: Settings | undefined; set(value: Settings): void }
const localTime = (ms: number | string) => new Date(ms).toLocaleString()

/** `label` and `percent` are null while there is no reading: the ring is drawn dashed, with no text. */
export function presentation(settings: Settings, usage: Usage) {
  const provider = settings.provider === "go" ? "OpenCode Go" : "OpenRouter"
  if (usage.status !== "available")
    return {
      label: null,
      percent: null,
      title: provider,
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
      return { label: null, percent: null, title: provider, lines: ["No Go usage reading yet."] }
    return {
      label: `${Math.round(selected.percent)}%`,
      percent: selected.percent,
      title: `${provider} · ${Math.round(selected.percent)}% of the ${settings.mode === "monthly" ? "monthly" : "5-hour"} allowance`,
      lines: [
        `Monthly ${usage.monthly.percent}% · resets ${localTime(usage.monthly.resetsAt)}`,
        `5-hour ${usage.rolling.percent}% · resets ${localTime(usage.rolling.resetsAt)}`,
      ],
    }
  }
  if (usage.creditUSD === null || usage.byokUSD === null || usage.coverageStart === null)
    return {
      label: null,
      percent: null,
      title: provider,
      lines: ["No spend reading yet for the configured key."],
    }
  const total = usage.creditUSD + usage.byokUSD
  return {
    label: `$${Math.round(total)}`,
    percent: (total / settings.weeklyUSD) * 100,
    title: `${provider} · $${Math.round(total)} of $${settings.weeklyUSD} this week`,
    lines: [
      `Credits $${Math.round(usage.creditUSD)} · BYOK $${Math.round(usage.byokUSD)}`,
      `Configured key · since ${localTime(usage.coverageStart)}`,
      `Resets ${localTime(localWeek().end)} (${localWeek().timezone})`,
    ],
  }
}

/**
 * Registers the session-header usage ring and returns the settings section for the LAZERS page
 * `settingsPage`. The budget has no page of its own.
 */
export function setupBudget(
  ctx: Parameters<Plugin.Setup>[0],
  store: SettingsStore,
  settingsPage = "lazers",
) {
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
      const accessibleLabel = () =>
        `${view().label === null ? `${view().title} usage, no reading yet` : view().title}. Open LAZERS settings.`
      return (
        <Show when={settings().enabled}>
          <Ui.Tooltip
            value={
              <div class="lazers-budget-tooltip">
                <div>{view().title}</div>
                <For each={view().lines}>{(line) => <div>{line}</div>}</For>
              </div>
            }
          >
            <button
              type="button"
              class="lazers-budget"
              aria-label={accessibleLabel()}
              data-tone={ring(view().percent).tone}
              onClick={() => ctx.layout.settings(settingsPage)}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="8" cy="8" r="6" class="budget-track" />
                <Show when={view().percent !== null}>
                  <circle
                    cx="8"
                    cy="8"
                    r="6"
                    class="budget-value"
                    pathLength="100"
                    stroke-dasharray={`${ring(view().percent).fraction * 100} 100`}
                    transform="rotate(-90 8 8)"
                  />
                </Show>
              </svg>
              <Show when={!props.compact && view().label}>{(label) => <span>{label()}</span>}</Show>
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
  const Section = bindPlugin(() => {
    const [error, setError] = createSignal("")
    const [budgetDraft, setBudgetDraft] = createSignal<string>()
    const save = (patch: Partial<Settings>) => {
      try {
        store.set({ ...settings(), ...patch })
        setError("")
      } catch {
        setError("Could not save provider usage settings.")
      }
    }
    return (
      <Ui.SettingsSection
        title="Provider usage in the session header"
        footer={
          <>
            <Show when={settings().provider === "openrouter"}>
              <p class="lazers-settings-hint">
                Counts the configured key’s credit and BYOK spend from when LAZERS first saw it this
                week, not the whole account. Spend from earlier in the week is not included.
              </p>
            </Show>
            <Show when={error()}>
              <p class="lazers-settings-hint" role="alert">
                {error()}
              </p>
            </Show>
          </>
        }
      >
        <Ui.SettingsRow
          title={<SettingLabel name="Show usage ring" hint="read-only; never limits or reroutes" />}
        >
          <Ui.Switch
            label="Show usage ring"
            hideLabel
            checked={settings().enabled}
            onChange={(enabled) => save({ enabled })}
          />
        </Ui.SettingsRow>
        <Ui.SettingsRow title="Provider">
          <Ui.Select
            label="Provider"
            value={settings().provider}
            options={[
              { value: "openrouter", label: "OpenRouter" },
              { value: "go", label: "OpenCode Go" },
            ]}
            onChange={(provider) => save({ provider })}
          />
        </Ui.SettingsRow>
        <Show when={settings().provider === "go"}>
          <Ui.SettingsRow
            title={<SettingLabel name="Allowance" hint="the Go meter the ring follows" />}
          >
            <Ui.Select
              label="Allowance"
              value={settings().mode}
              options={[
                { value: "monthly", label: "Monthly" },
                { value: "rolling", label: "Rolling 5-hour" },
              ]}
              onChange={(mode) => save({ mode })}
            />
          </Ui.SettingsRow>
        </Show>
        <Show when={settings().provider === "openrouter"}>
          <Ui.SettingsRow
            title={<SettingLabel name="Weekly budget" hint="week starts Sunday, local time" />}
          >
            <Ui.TextInput
              label="Weekly budget in US dollars"
              class="lazers-settings-number"
              value={budgetDraft() ?? String(settings().weeklyUSD)}
              invalid={Boolean(error())}
              onInput={(text) => {
                setBudgetDraft(text)
                const weeklyUSD = Number(text)
                if (text.trim() && Number.isFinite(weeklyUSD) && weeklyUSD > 0) save({ weeklyUSD })
                else setError("Enter a weekly budget greater than zero.")
              }}
            />
          </Ui.SettingsRow>
        </Show>
      </Ui.SettingsSection>
    )
  })
  ctx.add(Style, budgetStyles)
  return Section
}

export const budgetStyles = `
${settingLabelStyles}
.lazers-budget { display:inline-flex; align-items:center; justify-content:center; gap:5px; flex-shrink:0; height:26px; min-width:26px; padding:0 7px; border:0; border-radius:6px; background:transparent; color:var(--text-base); font:inherit; font-size:12px; font-variant-numeric:tabular-nums; white-space:nowrap; cursor:pointer; }
.lazers-budget:hover { background:var(--surface-base-hover); }
.lazers-budget:focus-visible { outline:2px solid var(--text-base); outline-offset:-2px; }
.lazers-budget svg { flex-shrink:0; fill:none; stroke:var(--icon-base); stroke-width:1.5; }
.lazers-budget .budget-track { opacity:.25; }
.lazers-budget .budget-value { stroke-opacity:.85; stroke-linecap:round; }
.lazers-budget[data-tone=warning] { color:var(--text-warning-base, var(--icon-warning-base)); }
.lazers-budget[data-tone=warning] .budget-value { stroke:var(--icon-warning-base); }
.lazers-budget[data-tone=critical] { color:var(--text-critical-base, var(--icon-critical-base)); }
.lazers-budget[data-tone=critical] .budget-value { stroke:var(--icon-critical-base); }
.lazers-budget[data-tone=none] .budget-track { opacity:.55; stroke-dasharray:2 2.7; }
.lazers-budget-tooltip { display:grid; gap:4px; max-width:38ch; white-space:normal; overflow-wrap:anywhere; text-align:left; }
.lazers-budget-tooltip > :first-child { color:var(--text-strong); }
`
