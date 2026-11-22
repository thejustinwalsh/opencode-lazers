/**
 * Shared details-pane pieces (design/details-panes/spec.md). Added once by the plugin root.
 * Colors are host tokens or `color-mix(in oklch, ...)` of them; type follows the Trajectory scale.
 */
export const detailsKitStyles = `
  :root {
    --lazers-kit-mono: var(--font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    --lazers-kit-tools: var(
      --lazers-hue-tools,
      color-mix(in oklch, var(--text-interactive-base, var(--text-base)) 58%, var(--icon-critical-base, var(--text-base)))
    );
  }
  [data-lazers-tone="warning"] { --lazers-kit-hue: var(--icon-warning-base, var(--text-base)); }
  [data-lazers-tone="critical"] { --lazers-kit-hue: var(--icon-critical-base, var(--text-base)); }
  [data-lazers-tone="success"] { --lazers-kit-hue: var(--icon-success-base, var(--text-base)); }
  [data-lazers-tone="interactive"] { --lazers-kit-hue: var(--text-interactive-base, var(--text-base)); }
  [data-lazers-tone="neutral"] { --lazers-kit-hue: var(--text-base); }

  .lazers-kit-mono { font-family: var(--lazers-kit-mono); }

  /* Stat row */
  .lazers-kit-stats {
    display: grid; grid-template-columns: repeat(var(--lazers-kit-columns, 4), minmax(0, 1fr));
    gap: 16px; padding: 10px 0; margin: 0;
    border-top: 1px solid var(--border-weak-base); border-bottom: 1px solid var(--border-weak-base);
  }
  .lazers-kit-stat { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .lazers-kit-stat > dt { margin: 0; font-size: 12px; color: var(--text-weak); }
  .lazers-kit-stat > dd {
    margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-family: var(--lazers-kit-mono); font-size: 12.5px; color: var(--text-strong);
  }

  /* Label */
  .lazers-kit-label {
    display: inline-flex; align-items: center; box-sizing: border-box; padding: 0 5px; height: 18px;
    border: 1px solid var(--lazers-kit-hue); border-radius: 3px; vertical-align: middle;
    background: color-mix(in oklch, var(--lazers-kit-hue) 22%, transparent);
    color: var(--text-strong); font-size: 11px; line-height: 1; white-space: nowrap;
  }

  /* Section title row (Progress, Activity, Coverage, ...) */
  .lazers-kit-section { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .lazers-kit-section-head {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    font-size: 12px; color: var(--text-weak);
  }

  /* Progress */
  .lazers-kit-progress {
    display: grid; grid-template-columns: repeat(var(--lazers-kit-steps, 5), minmax(0, 1fr));
    gap: 4px; margin: 0; padding: 0; list-style: none;
  }
  .lazers-kit-step { display: flex; flex-direction: column; gap: 6px; min-width: 0; font-size: 12px; }
  .lazers-kit-step::before { content: ""; height: 2px; background: var(--border-base, var(--border-weak-base)); }
  .lazers-kit-step[data-state="passed"]::before { background: var(--text-base); }
  .lazers-kit-step[data-state="current"]::before { background: var(--lazers-kit-hue); }
  .lazers-kit-step[data-state="current"] { color: var(--lazers-kit-hue); }
  .lazers-kit-step[data-state="passed"] { color: var(--text-base); }
  .lazers-kit-step[data-state="later"] { color: var(--text-weak); }

  /* Activity lane */
  .lazers-kit-lane {
    position: relative; display: flex; align-items: stretch; height: 26px;
    background: var(--surface-raised-base, var(--surface-base));
    border-top: 1px solid var(--border-weak-base); border-bottom: 1px solid var(--border-weak-base);
  }
  .lazers-kit-lane-active { position: relative; flex: none; min-width: 0; }
  .lazers-kit-tick {
    position: absolute; top: 50%; width: 2px; height: 12px; margin: -6px 0 0 -1px;
    border-radius: 1px; background: var(--lazers-kit-tools);
  }
  .lazers-kit-tick[data-failed="true"] { height: 16px; margin-top: -8px; background: var(--icon-critical-base); }
  .lazers-kit-tick[data-selected="true"] {
    width: 8px; height: 18px; margin: -9px 0 0 -5px; box-sizing: border-box; border-radius: 3px;
    border: 1px solid var(--text-strong);
    background: linear-gradient(var(--lazers-kit-tools), var(--lazers-kit-tools)) center / 2px calc(100% - 4px) no-repeat;
  }
  .lazers-kit-tick[data-selected="true"][data-failed="true"] {
    background: linear-gradient(var(--icon-critical-base), var(--icon-critical-base)) center / 2px calc(100% - 4px) no-repeat;
  }
  .lazers-kit-lane-idle {
    flex: none; box-sizing: border-box; position: relative;
    border-left: 1px solid var(--border-weak-base); border-right: 1px solid var(--border-weak-base);
    background: repeating-linear-gradient(135deg, color-mix(in oklch, var(--text-strong) 10%, transparent) 0 2px, transparent 2px 5px);
  }
  /* Hover detail: one CSS tip per mark, quiet stretch or the bare track; no node per tick. */
  .lazers-kit-lane:focus-visible { outline: 2px solid var(--border-selected); outline-offset: 2px; }
  .lazers-kit-tick::before { content: ""; position: absolute; inset: -6px -4px; }
  .lazers-kit-lane [data-tip]::after, .lazers-kit-lane[data-tip]::after {
    content: attr(data-tip); position: absolute; bottom: calc(100% + 6px); left: 50%; z-index: 2;
    transform: translateX(-50%); display: none; padding: 3px 7px; border-radius: 6px;
    background: var(--surface-raised-stronger-non-alpha, var(--surface-raised-base, var(--background-base)));
    border: 1px solid var(--border-weak-base); box-shadow: 0 2px 8px color-mix(in oklch, black 25%, transparent);
    color: var(--text-strong); font-family: var(--lazers-kit-mono); font-size: 11px; font-style: normal;
    line-height: 1.4; white-space: nowrap; pointer-events: none;
  }
  .lazers-kit-tick[data-edge="start"]::after { left: 0; transform: none; }
  .lazers-kit-tick[data-edge="end"]::after { left: auto; right: 0; transform: none; }
  .lazers-kit-lane-idle[data-tip]::after { left: 0; transform: none; }
  .lazers-kit-lane [data-tip]:hover::after, .lazers-kit-lane [data-active="true"]::after { display: block; }
  .lazers-kit-lane[data-tip]:hover:not(:has([data-tip]:hover))::after { display: block; left: 50%; }

  /* Coverage */
  .lazers-kit-coverage-bar {
    display: flex; height: 4px; overflow: hidden; background: var(--border-weak-base);
  }
  .lazers-kit-coverage-priced { background: var(--text-interactive-base, var(--text-base)); }
  .lazers-kit-coverage-unpriced { background: var(--icon-warning-base, var(--text-base)); }
  .lazers-kit-coverage-caption { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; }
  .lazers-kit-coverage-note { color: var(--icon-warning-base, var(--text-base)); text-align: right; }

  /* Rows */
  /* One grid for the whole table; each row is a subgrid of it, so an \`auto\` or \`fr\` column has one
     width in the header and in every row (each row as its own grid sized them apart). */
  .lazers-kit-rows {
    display: grid; grid-template-columns: var(--lazers-kit-columns); column-gap: 12px; min-width: 0;
  }
  .lazers-kit-row {
    grid-column: 1 / -1; display: grid; grid-template-columns: subgrid; align-items: center; gap: 12px;
    min-height: 28px; padding: 0; border: 0; border-bottom: 1px solid var(--border-weak-base);
    background: none; color: var(--text-base); font: inherit; font-size: 12.5px; text-align: left;
    min-width: 0; width: 100%; box-sizing: border-box;
  }
  .lazers-kit-row:last-child { border-bottom: 0; }
  .lazers-kit-row > * { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  button.lazers-kit-row { cursor: pointer; }
  button.lazers-kit-row:hover { background: var(--surface-base-hover); }
  button.lazers-kit-row:focus-visible { outline: 2px solid var(--border-selected); outline-offset: -2px; }
  .lazers-kit-rows-head {
    min-height: 26px; color: var(--text-weak); font-size: 12px; cursor: default;
  }

  /* Disclosure */
  .lazers-kit-disclosure { display: flex; flex-direction: column; min-width: 0; }
  .lazers-kit-disclosure-toggle {
    display: flex; align-items: center; gap: 8px; height: 28px; padding: 0; border: 0;
    background: none; color: var(--text-base); font: inherit; font-size: 12.5px; text-align: left;
    cursor: pointer;
  }
  .lazers-kit-disclosure-toggle:focus-visible { outline: 2px solid var(--border-selected); outline-offset: 2px; border-radius: 4px; }
  .lazers-kit-disclosure-toggle:hover .lazers-kit-chevron { color: var(--text-strong); }
  .lazers-kit-chevron { flex: none; width: 10px; height: 10px; color: var(--text-weak); transition: transform 120ms ease; }
  .lazers-kit-disclosure-toggle[aria-expanded="true"] .lazers-kit-chevron { transform: rotate(90deg); }
  .lazers-kit-disclosure-count { color: var(--text-weak); }
  .lazers-kit-disclosure-body { padding: 4px 0 8px 18px; min-width: 0; }
  @media (prefers-reduced-motion: reduce) { .lazers-kit-chevron { transition: none; } }

  /* Callout */
  .lazers-callout {
    display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border-radius: 8px;
    background: var(--surface-raised-base, var(--surface-base)); color: var(--text-base);
    font-size: 13px; line-height: 1.45;
  }
  .lazers-callout-icon {
    display: inline-grid; place-items: center; flex: none; width: 16px; height: 20px;
    color: var(--lazers-kit-hue, var(--icon-base));
  }
  .lazers-callout-icon :is(svg, [data-component="icon"]) { width: 16px; height: 16px; }
  .lazers-callout-body { min-width: 0; flex: 1 1 auto; }
  .lazers-callout-text { overflow-wrap: anywhere; }
  .lazers-callout-toggle {
    display: inline; padding: 0; border: 0; background: transparent; color: var(--text-weak);
    font: inherit; cursor: pointer;
  }
  .lazers-callout-toggle:hover { color: var(--text-strong); text-decoration: underline; }
  .lazers-callout-raw {
    margin: 8px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-weak);
    font: inherit; font-size: 12px;
  }
  .lazers-callout-raw[hidden] { display: none; }

  /* Identifiers */
  .lazers-kit-ids { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; column-gap: 12px; margin: 0; }
  .lazers-kit-id { display: contents; }
  .lazers-kit-id > dt, .lazers-kit-id > dd { display: flex; align-items: center; min-height: 28px; margin: 0; border-bottom: 1px solid var(--border-weak-base); }
  .lazers-kit-id > dt { font-size: 12px; color: var(--text-weak); }
  .lazers-kit-id > dd { min-width: 0; }
  .lazers-kit-id-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--lazers-kit-mono); font-size: 11.5px; color: var(--text-strong); }
  .lazers-kit-id > .lazers-kit-id-copy-cell { justify-content: flex-end; }
  .lazers-kit-copy {
    height: 22px; padding: 0 6px; border: 0; border-radius: 4px; background: none;
    color: var(--text-weak); font: inherit; font-size: 11.5px; cursor: pointer;
  }
  .lazers-kit-copy:hover { color: var(--text-strong); background: var(--surface-base-hover); }
  .lazers-kit-copy:focus-visible { outline: 2px solid var(--border-selected); outline-offset: -2px; }
`
