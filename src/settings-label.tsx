import { Show } from "solid-js"
import type { JSX } from "solid-js"

/**
 * A settings row title that carries its hint on the same line: the name, then the hint in muted
 * text. The host row is single-line when it has a title and no description. A child row is
 * indented under the setting that gates it and dims while that setting is off.
 */
export function SettingLabel(props: {
  name: string
  hint?: string
  child?: boolean
  off?: boolean
}): JSX.Element {
  return (
    <span
      class="lazers-setting-label"
      data-child={props.child ? "" : undefined}
      data-off={props.off ? "" : undefined}
    >
      <span class="lazers-setting-name">{props.name}</span>
      <Show when={props.hint}>{(hint) => <span class="lazers-setting-hint">{hint()}</span>}</Show>
    </span>
  )
}

export const settingLabelStyles = `
.lazers-setting-label { display:inline-flex; align-items:baseline; flex-wrap:wrap; gap:2px 8px; min-width:0; }
.lazers-setting-label[data-child] { padding-left:24px; }
.lazers-setting-label[data-off] { opacity:.55; }
.lazers-setting-name { color:var(--text-strong); }
.lazers-setting-hint { color:var(--text-weak); font-size:12.5px; }
`
