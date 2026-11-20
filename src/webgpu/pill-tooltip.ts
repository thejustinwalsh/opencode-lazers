/**
 * The host shows a composer pill's `title` only as its accessible name (`aria-label`), never as a
 * visible tooltip. LAZERS pills identify themselves by a stable aria-label prefix so their own
 * Style block can draw icons and a hover tooltip without touching host DOM. Titles are built from
 * these prefixes, and a test keeps titles and selectors in agreement.
 */
export const SPEAKER_PREFIX = "LAZERS speaker:"
export const MICROPHONE_PREFIX = "LAZERS microphone:"

export const pillSelector = (prefix: string) => `[data-composer-pill][aria-label^="${prefix}"]`

/** Hover/focus tooltip above the pill, drawn from its aria-label. Reduced motion: shown without a fade. */
export function pillTooltipCss(prefix: string): string {
  const pill = pillSelector(prefix)
  return `
    ${pill} { position:relative; }
    ${pill}::after { content:attr(aria-label); position:absolute; left:0; bottom:calc(100% + 6px); z-index:50; width:max-content; max-width:min(280px,calc(100vw - 32px)); box-sizing:border-box; padding:6px 8px; border-radius:6px; border:1px solid var(--border-weak-base,rgba(128,128,128,.3)); background:var(--surface-raised-stronger-non-alpha,#222); color:var(--text-strong,#eee); font:12px/16px var(--font-family-sans,system-ui,sans-serif); text-align:left; white-space:normal; pointer-events:none; opacity:0; visibility:hidden; transition:opacity .12s ease .4s,visibility 0s linear .4s; }
    ${pill}:hover::after, ${pill}:focus-visible::after { opacity:1; visibility:visible; }
    @media(prefers-reduced-motion:reduce) { ${pill}::after { transition:none; } }
  `
}
