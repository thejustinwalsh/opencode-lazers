/**
 * OpenCode 2.2.5 TextShimmer compatibility repair, contributed through public Style.
 * Its continuous text animation drives renderer/GPU-process CPU even with opacity.
 * Keep readable busy text, native active/inactive fades and separate busy spinners.
 * These native DOM selectors are version-specific; recheck on host upgrades and
 * remove this contribution when the native component no longer needs it.
 */
export const nativeBusyStyles = `
  :root:not([data-motion="reduce"]) [data-component="text-shimmer"] [data-slot="text-shimmer-char-shimmer"][data-run="true"] {
    animation-name: none;
    background-image: none;
    color: var(--text-shimmer-base-color, var(--text-weak));
    -webkit-text-fill-color: currentColor;
    will-change: auto;
  }
`
