// Reading rules and host-token bridge for Pierre's shadow roots. Adapted from Oaink
// `packages/webviews/diff/pierre-theme.ts` (docs/design.md, "Structural diff reading rules"): quiet gutter
// bars instead of line bands, syntax-colored token marks, neutral one-sided files and readable
// unchanged code. Every color is an OpenCode theme token, so a theme switch restyles in place.
import { registerCustomTheme } from "@pierre/diffs"
import type { ThemeRegistration } from "@pierre/diffs"

/** Name the highlighter knows the host theme by. */
export const HOST_SYNTAX_THEME = "lazers-host-syntax"

const v = (token: string) => `var(--${token})`

/**
 * A TextMate theme whose colors are the host's syntax tokens. Shiki keeps `var()` colors as they are,
 * so highlighting is computed once and every later theme or mode change is CSS only.
 */
export function hostSyntaxTheme() {
  const rule = (scope: string[], token: string, fontStyle?: string) => ({
    scope,
    settings: { foreground: v(token), ...(fontStyle ? { fontStyle } : {}) },
  })
  return {
    name: HOST_SYNTAX_THEME,
    type: "dark" as const,
    colors: {
      "editor.foreground": v("text-base"),
      "editor.background": v("background-base"),
    },
    fg: v("text-base"),
    bg: v("background-base"),
    tokenColors: [
      rule(["comment", "punctuation.definition.comment", "string.comment"], "syntax-comment"),
      rule(["string", "string.quoted", "string.template", "markup.inline.raw"], "syntax-string"),
      rule(["string.regexp", "constant.character.escape"], "syntax-regexp"),
      rule(
        [
          "keyword",
          "storage",
          "storage.type",
          "storage.modifier",
          "keyword.control",
          "variable.language.this",
          "variable.language.self",
        ],
        "syntax-keyword",
      ),
      rule(["keyword.operator", "keyword.operator.expression"], "syntax-operator"),
      rule(
        [
          "entity.name.function",
          "support.function",
          "meta.function-call entity.name.function",
          "variable.function",
        ],
        "syntax-primitive",
      ),
      rule(
        [
          "entity.name.type",
          "entity.name.class",
          "entity.other.inherited-class",
          "support.type",
          "support.class",
          "entity.name.namespace",
          "storage.type.primitive",
        ],
        "syntax-type",
      ),
      rule(
        [
          "constant",
          "constant.numeric",
          "constant.language",
          "support.constant",
          "variable.other.constant",
          "variable.other.enummember",
        ],
        "syntax-constant",
      ),
      rule(
        [
          "variable.other.property",
          "variable.other.object.property",
          "support.variable.property",
          "meta.object-literal.key",
          "entity.other.attribute-name",
          "support.type.property-name",
        ],
        "syntax-property",
      ),
      rule(["variable.other.object", "support.variable"], "syntax-object"),
      rule(["variable", "variable.parameter", "meta.definition.variable"], "syntax-variable"),
      rule(["entity.name.tag", "punctuation.definition.tag"], "syntax-keyword"),
      rule(["punctuation", "meta.brace", "punctuation.separator"], "syntax-punctuation"),
      rule(["markup.inserted"], "syntax-diff-add"),
      rule(["markup.deleted"], "syntax-diff-delete"),
      rule(["markup.heading", "markup.bold"], "text-strong", "bold"),
      rule(["markup.italic"], "text-base", "italic"),
      rule(["invalid", "invalid.illegal"], "syntax-critical"),
    ],
  }
}

let registered = false
/** Registers the host theme with the highlighter once per window. */
export function registerHostSyntaxTheme() {
  if (registered) return
  registered = true
  registerCustomTheme(HOST_SYNTAX_THEME, () =>
    Promise.resolve(hostSyntaxTheme() as unknown as ThemeRegistration),
  )
}

/** Share of the floor in an unchanged token, and the readable lightness limits (Oaink pierre-theme.ts). */
const MUTE = "60%"
const READABLE = { dark: 0.62, light: 0.56 } as const
const LIFT = { dark: "0.72", light: "0.52" } as const

const mutedToken = (token: string, scheme: "dark" | "light") =>
  `oklch(from color-mix(in oklab, ${token}, var(--lz-review-floor) ${MUTE}) ${
    scheme === "dark" ? `clamp(${READABLE.dark}, l, 1)` : `clamp(0, l, ${READABLE.light})`
  } c h)`
const markedToken = (token: string, scheme: "dark" | "light") =>
  `oklch(from ${token} ${scheme === "dark" ? `clamp(${LIFT.dark}, l, 1)` : `clamp(0, l, ${LIFT.light})`} c h)`

/**
 * Custom properties set on the CodeView host element; they inherit into each shadow root. Values
 * are host tokens; only their mix differs by mode.
 */
export function bridgeStyle(mode: "light" | "dark", mono: string): Record<string, string> {
  const fill = mode === "dark" ? { add: "26%", remove: "30%" } : { add: "22%", remove: "18%" }
  const border = mode === "dark" ? { add: "48%", remove: "62%" } : { add: "58%", remove: "48%" }
  return {
    "color-scheme": mode,
    "--diffs-font-family": mono,
    "--diffs-header-font-family": "inherit",
    "--diffs-font-size": "12px",
    "--diffs-line-height": "18px",
    "--diffs-bg-context-override": v("background-base"),
    "--diffs-bg-separator-override": v("background-base"),
    "--diffs-fg-number-override": v("text-weaker"),
    "--diffs-gap-style": `1px solid ${v("background-base")}`,
    "--lz-review-bg": v("background-base"),
    "--lz-review-fg": v("text-base"),
    "--lz-review-floor": `color-mix(in oklab, ${v("text-base")}, ${v("background-base")} 36%)`,
    "--lz-review-bar-added": v("icon-diff-add-base"),
    "--lz-review-bar-deleted": v("icon-diff-delete-base"),
    "--lz-review-inserted-fill": `color-mix(in srgb, ${v("icon-diff-add-base")} ${fill.add}, transparent)`,
    "--lz-review-removed-fill": `color-mix(in srgb, ${v("icon-diff-delete-base")} ${fill.remove}, transparent)`,
    "--lz-review-inserted-border": `color-mix(in oklab, ${v("icon-diff-add-base")} ${border.add}, ${v("background-base")})`,
    "--lz-review-removed-border": `color-mix(in oklab, ${v("icon-diff-delete-base")} ${border.remove}, ${v("background-base")})`,
    "--lz-review-filler": `color-mix(in srgb, ${v("text-base")} 5%, transparent)`,
    "--lz-review-pane-border": v("border-weak-base"),
    "--lz-review-selection": v("border-interactive-focus"),
    "--lz-review-text-selection": `color-mix(in srgb, ${v("text-interactive-base")} 30%, transparent)`,
    "--lz-review-unchanged-fg": v("text-weak"),
    "--lz-review-focus": v("border-interactive-focus"),
  }
}

/** Attribute on a file's host element whose rows are a line diff, not a structural comparison. */
export const FALLBACK_ATTRIBUTE = "data-lz-review-fallback"
const COMPARED = `:host(:not([${FALLBACK_ATTRIBUTE}]))`

/** Rules for Pierre's shadow root (`unsafeCSS`), for the given mode. */
export function reviewShadowCSS(mode: "light" | "dark"): string {
  const token = `var(--diffs-token-${mode}, var(--diffs-${mode}))`
  return /* css */ `
:host {
  --diffs-bg: var(--lz-review-bg);
  --diffs-fg: var(--lz-review-fg);
  --diffs-selection-base: var(--lz-review-selection);
  --diffs-gap-block: 0px;
}
/* No line bands, no signs: a changed row keeps the code background and gets a thin bar at the
   inner edge of its line-number gutter. */
:is([data-line], [data-no-newline], [data-column-number], [data-gutter-buffer]):is([data-line-type=change-addition], [data-line-type=change-deletion]) {
  --diffs-computed-diff-line-bg: var(--diffs-bg);
}
:is([data-column-number], [data-gutter-buffer]):is([data-line-type=change-addition], [data-line-type=change-deletion]) { color: var(--diffs-fg-number); }
[data-line-type=change-addition]:is([data-column-number], [data-gutter-buffer=annotation]) { box-shadow: inset -2px 0 0 var(--lz-review-bar-added); }
[data-line-type=change-deletion]:is([data-column-number], [data-gutter-buffer=annotation]) { box-shadow: inset -2px 0 0 var(--lz-review-bar-deleted); }

/* Unchanged code recedes where the file compares by structure; each token keeps its hue and stays
   readable. A line-diff fallback keeps the theme's colors. */
${COMPARED} [data-line]:is([data-line-type=context], [data-line-type=context-expanded]) span { color: ${mutedToken(token, mode)}; }
${COMPARED} [data-line]:is([data-line-type=context], [data-line-type=context-expanded]) { color: var(--lz-review-floor); }

/* A changed token: a translucent fill and a thin border in its side's color; the text keeps its
   syntax color, lifted only where it would be unreadable on the fill. A run is one box. */
[data-diff-span] { border-radius: 2px; padding-block: 1px; padding-inline: 1px; margin-inline: -1px; -webkit-box-decoration-break: slice; box-decoration-break: slice; }
[data-line] [data-diff-span] span { color: ${markedToken(token, mode)}; }
[data-line-type=change-addition] [data-diff-span] { background-color: var(--lz-review-inserted-fill); box-shadow: inset 0 0 0 1px var(--lz-review-inserted-border); }
[data-line-type=change-deletion] [data-diff-span] { background-color: var(--lz-review-removed-fill); box-shadow: inset 0 0 0 1px var(--lz-review-removed-border); }

/* The empty side of a one-sided row: a flat wash. One line between the panes. */
[data-content-buffer] { background-image: none; background-color: var(--lz-review-filler); }
[data-diff-type=split][data-overflow=scroll] [data-deletions] { border-right: 1px solid var(--lz-review-pane-border); }
[data-diff-type=split][data-overflow=scroll] [data-additions] { border-left-width: 0; }
[data-diff-type=split][data-overflow=wrap] [data-additions] [data-gutter] { box-shadow: -1px 0 0 var(--lz-review-pane-border); }

/* The selected lines: a mark in the gutter, the line keeps its diff color. */
:is([data-line], [data-no-newline])[data-selected-line] { --diffs-computed-selected-line-bg: color-mix(in srgb, var(--lz-review-selection) 10%, transparent); }
:is([data-column-number], [data-gutter-buffer])[data-selected-line] {
  --diffs-computed-selected-line-bg: var(--diffs-computed-diff-line-bg);
  color: var(--lz-review-selection);
  box-shadow: inset 2px 0 0 var(--lz-review-selection);
}
[data-column-number] { font-variant-numeric: tabular-nums; }

/* A collapsed unchanged region: a quiet row with the host's weak text. */
[data-separator=line-info] { margin-block: 0; height: 22px; background-color: var(--diffs-bg); box-shadow: inset 0 1px 0 var(--lz-review-pane-border), inset 0 -1px 0 var(--lz-review-pane-border); }
[data-separator=line-info] [data-separator-wrapper], [data-separator=line-info] [data-separator-content], [data-separator=line-info] [data-expand-button] { background-color: transparent; border-radius: 0; }
[data-separator=line-info] [data-expand-button] { border-right-width: 0; }
[data-additions] [data-gutter] [data-separator=line-info] [data-separator-wrapper], [data-additions] [data-content] [data-separator=line-info] { background-color: transparent; border-radius: 0; }
[data-separator-content], [data-expand-button] { color: var(--lz-review-unchanged-fg); }
[data-separator-content], [data-diffs-header], [data-separator] { font-size: 11px; line-height: 16px; }
[data-expand-button]:focus-visible, [data-separator-content]:focus-visible { outline: 1px solid var(--lz-review-focus); outline-offset: -1px; }

[data-diffs-header=custom] { display: block; }
::selection { background-color: var(--lz-review-text-selection); }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; scroll-behavior: auto !important; }
}
`
}
