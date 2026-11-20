import { createSignal, For, Show, onCleanup, splitProps } from "solid-js"
import type { JSX } from "solid-js"
import { iconPaths } from "./icons.ts"

/**
 * A stand-in for the `ctx.ui` components OpenCode Desktop supplies to plugins. It renders real DOM
 * with the host's semantics (roles, labels, aria state) so the LAZERS panels run unchanged; only
 * the look is the demo shell's own (see theme.css, `.oc-*`).
 */
type IconProps = { name: string; size?: "small" | "normal" | "large"; class?: string }
export function Icon(props: IconProps) {
  const px = () => (props.size === "large" ? 24 : props.size === "small" ? 16 : 20)
  return (
    <svg
      class={`oc-icon ${props.class ?? ""}`}
      viewBox="0 0 20 20"
      width={px()}
      height={px()}
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      data-icon={props.name}
    >
      <path d={iconPaths[props.name] ?? "M10 16a6 6 0 1 0 0-12 6 6 0 0 0 0 12z"} />
    </svg>
  )
}

type ButtonProps = {
  children?: JSX.Element
  onClick?: (event: MouseEvent) => void
  variant?: string
  size?: string
  icon?: string
  disabled?: boolean
  busy?: boolean
  class?: string
  "aria-label"?: string
}
function Button(props: ButtonProps) {
  return (
    <button
      type="button"
      class={`oc-button ${props.class ?? ""}`}
      data-variant={props.variant ?? "neutral"}
      data-size={props.size ?? "normal"}
      disabled={props.disabled || props.busy}
      aria-busy={props.busy ? "true" : undefined}
      aria-label={props["aria-label"]}
      onClick={(event) => props.onClick?.(event)}
    >
      <Show when={props.icon}>{(name) => <Icon name={name()} size="small" />}</Show>
      {props.children}
    </button>
  )
}

function IconButton(props: {
  icon: string
  label: string
  onClick?: (event: MouseEvent) => void
  variant?: string
  size?: string
  disabled?: boolean
  pressed?: boolean
  busy?: boolean
  class?: string
}) {
  return (
    <button
      type="button"
      class={`oc-button oc-icon-button ${props.class ?? ""}`}
      data-variant={props.variant ?? "ghost"}
      data-size={props.size ?? "normal"}
      aria-label={props.label}
      aria-pressed={props.pressed}
      disabled={props.disabled || props.busy}
      onClick={(event) => props.onClick?.(event)}
    >
      <Icon name={props.icon} size="small" />
    </button>
  )
}

function Tooltip(props: { value: JSX.Element; children: JSX.Element }) {
  const text = () => (typeof props.value === "string" ? props.value : "")
  return (
    <span
      class="oc-tooltip"
      data-tooltip={text()}
      onPointerOver={(event) => event.currentTarget.setAttribute("data-shown", "")}
      onPointerOut={(event) => event.currentTarget.removeAttribute("data-shown")}
    >
      {props.children}
    </span>
  )
}

type MenuEntry =
  | { type?: "item"; label: string; icon?: string; disabled?: boolean; onSelect(): void }
  | { type: "separator" }
  | { type: "group"; label: string; items: readonly MenuEntry[] }
function Menu(props: {
  label: string
  items: readonly MenuEntry[]
  trigger?: "icon" | "button"
  icon?: string
  disabled?: boolean
}) {
  const [open, setOpen] = createSignal(false)
  const close = (event: Event) => {
    if (!(event.target as Element | null)?.closest?.(".oc-menu")) setOpen(false)
  }
  document.addEventListener("pointerdown", close)
  onCleanup(() => document.removeEventListener("pointerdown", close))
  const flat = (entries: readonly MenuEntry[]): MenuEntry[] =>
    entries.flatMap((entry) => (entry.type === "group" ? flat(entry.items) : [entry]))
  return (
    <div class="oc-menu">
      <button
        type="button"
        class={props.trigger === "button" ? "oc-button" : "oc-button oc-icon-button"}
        data-variant="ghost-muted"
        aria-label={props.label}
        aria-haspopup="menu"
        aria-expanded={open()}
        disabled={props.disabled}
        onClick={() => setOpen(!open())}
      >
        <Show when={props.trigger === "button"}>{props.label}</Show>
        <Icon name={props.icon ?? "outline-dots"} size="small" />
      </button>
      <Show when={open()}>
        <div role="menu" class="oc-menu-list">
          <For each={flat(props.items)}>
            {(entry) =>
              entry.type === "separator" ? (
                <hr role="separator" />
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  disabled={(entry as { disabled?: boolean }).disabled}
                  onClick={() => {
                    ;(entry as { onSelect(): void }).onSelect()
                    setOpen(false)
                  }}
                >
                  {(entry as { label: string }).label}
                </button>
              )
            }
          </For>
        </div>
      </Show>
    </div>
  )
}

function TextInput(props: {
  value: string
  onInput: (value: string) => void
  onSubmit?: (value: string) => void
  label: string
  placeholder?: string
  type?: string
  disabled?: boolean
  class?: string
}) {
  return (
    <input
      class={`oc-input ${props.class ?? ""}`}
      aria-label={props.label}
      placeholder={props.placeholder}
      value={props.value}
      disabled={props.disabled}
      onInput={(event) => props.onInput(event.currentTarget.value)}
      onKeyDown={(event) => event.key === "Enter" && props.onSubmit?.(event.currentTarget.value)}
    />
  )
}

function Loader() {
  return <span class="oc-loader" role="status" aria-label="Loading" />
}

function Markdown(props: { text: string; class?: string }) {
  return <div class={`oc-markdown ${props.class ?? ""}`}>{props.text}</div>
}
function Code(props: { content: string; class?: string }) {
  return <pre class={`oc-code ${props.class ?? ""}`}>{props.content}</pre>
}

function Select(props: {
  label: string
  value: string | undefined
  options: readonly { value: string; label: string }[]
  onChange(value: string): void
}) {
  const [local] = splitProps(props, ["label", "value", "options", "onChange"])
  return (
    <select
      class="oc-input"
      aria-label={local.label}
      onChange={(event) => local.onChange(event.currentTarget.value)}
    >
      <For each={local.options}>
        {(option) => (
          <option value={option.value} selected={option.value === local.value}>
            {option.label}
          </option>
        )}
      </For>
    </select>
  )
}

function Switch(props: { checked: boolean; onChange(value: boolean): void; label: string }) {
  return (
    <input
      type="checkbox"
      role="switch"
      aria-label={props.label}
      checked={props.checked}
      onChange={(event) => props.onChange(event.currentTarget.checked)}
    />
  )
}

export function createUi() {
  return {
    Icon,
    Button,
    IconButton,
    Tooltip,
    Menu,
    TextInput,
    Loader,
    Markdown,
    Code,
    Select,
    Switch,
    SettingsSection: (props: { title?: string; children: JSX.Element }) => (
      <section aria-label={props.title}>{props.children}</section>
    ),
    SettingsRow: (props: { title: JSX.Element; children?: JSX.Element }) => (
      <div>
        <span>{props.title}</span>
        {props.children}
      </div>
    ),
  }
}
