import { createComponent, createRoot } from "solid-js"
import { render } from "solid-js/web"
import { Style } from "@opencode/plugin/gui"
import { PluginContext } from "../../node_modules/@opencode/plugin/dist/gui/internal.js"
import { setupRetention } from "../../src/retention/gui.tsx"
import type {
  RetentionPreviewView,
  RetentionSliceView,
  RetentionStatusView,
} from "../../src/retention/contract.ts"

type Calls = Array<{ method: string; input: unknown }>
type JSXElement = import("solid-js").JSX.Element

export function harness(
  root: HTMLElement,
  fake: {
    status: RetentionStatusView
    preview: (days: number) => RetentionPreviewView
    slices: RetentionSliceView[]
    confirm: () => boolean
  },
) {
  const calls: Calls = []
  const confirmations: Array<{ title: string; description?: string; danger?: boolean }> = []
  const slices = [...fake.slices]
  let status = fake.status
  const ctx = {
    id: "lazers",
    signal: new AbortController().signal,
    client: {
      rpc: () => ({
        status: async (input: unknown) => {
          calls.push({ method: "status", input })
          return status
        },
        preview: async (input: { days: number }) => {
          calls.push({ method: "preview", input })
          return fake.preview(input.days)
        },
        retire: async (input: unknown) => {
          calls.push({ method: "retire", input })
          const next = slices.shift()!
          status = { ...status, freeBytes: next.freeBytes }
          return next
        },
        setAuto: async (input: { days: number | null }) => {
          calls.push({ method: "setAuto", input })
          status = { ...status, autoDays: input.days }
          return { autoDays: input.days }
        },
      }),
    },
    dialogs: {
      confirm: async (options: { title: string; description?: string; danger?: boolean }) => {
        confirmations.push(options)
        return fake.confirm()
      },
    },
    add: () => undefined,
    ui: {
      SettingsSection: (props: { title?: string; children: JSXElement; footer?: JSXElement }) => (
        <section aria-label={props.title}>
          <h2>{props.title}</h2>
          {props.children}
          {props.footer}
        </section>
      ),
      SettingsRow: (props: {
        title: JSXElement
        description?: JSXElement
        children?: JSXElement
      }) => (
        <div class="fixture-row">
          <span>{props.title}</span>
          <p class="fixture-description">{props.description}</p>
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
            <option value={option.value} selected={option.value === props.value}>
              {option.label}
            </option>
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
        <input
          aria-label={props.label}
          type="checkbox"
          role="switch"
          checked={props.checked}
          onChange={(e) => props.onChange(e.currentTarget.checked)}
        />
      ),
      Button: (props: {
        children: JSXElement
        onClick?: () => void
        disabled?: boolean
        busy?: boolean
        variant?: string
      }) => (
        <button
          type="button"
          data-variant={props.variant}
          disabled={props.disabled || props.busy}
          onClick={() => props.onClick?.()}
        >
          {props.children}
        </button>
      ),
    },
  }
  let Section!: ReturnType<typeof setupRetention>
  const disposeSetup = createRoot((dispose) => {
    createComponent(PluginContext.Provider, {
      value: ctx as never,
      get children() {
        Section = setupRetention(ctx as never)
        return null
      },
    })
    return dispose
  })
  const dispose = render(
    () =>
      createComponent(PluginContext.Provider, {
        value: ctx as never,
        get children() {
          return <Section />
        },
      }),
    root,
  )
  void Style
  return {
    calls,
    confirmations,
    dispose() {
      dispose()
      disposeSetup()
    },
  }
}
