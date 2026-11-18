/** Added once by the plugin root; every inspector panel shares it. */
export const detailsPaneStyles = `
  .lazers-details {
    position: relative; display: flex; flex-direction: column; width: 100%; height: 100%;
    min-width: 0; min-height: 0; container-type: size; --details-header: 32px;
  }
  .lazers-details-top {
    flex: 1 1 0; min-height: 0; min-width: 0; overflow: auto; display: grid;
    grid-template: minmax(0, 1fr) / minmax(0, 1fr); overscroll-behavior: contain;
  }
  .lazers-details-pane { flex: none; display: flex; flex-direction: column; min-width: 0; }
  .lazers-details-bar {
    position: relative; flex: none; display: flex; align-items: center; gap: 4px;
    height: var(--details-header); min-width: 0; padding: 0 8px 0 4px; box-sizing: border-box;
    border-top: 1px solid var(--border-weak-base); background: var(--background-base);
    font-size: 12.5px; line-height: 1.3; color: var(--text-base);
  }
  .lazers-details-bar:hover { background: var(--surface-base-hover); }
  .lazers-details-resize {
    position: absolute; top: -1px; left: 0; right: 0; height: 5px; z-index: 1;
    cursor: row-resize; touch-action: none;
  }
  .lazers-details-resize::after {
    content: ""; position: absolute; top: 1px; left: 50%; width: 22px; height: 2px;
    margin-left: -11px; border-radius: 1px; background: var(--border-base, var(--text-weak));
    opacity: 0; pointer-events: none;
  }
  .lazers-details-resize:hover::after, .lazers-details-resize:focus-visible::after,
  .lazers-details[data-dragging="true"] .lazers-details-resize::after { opacity: 1; }
  .lazers-details-resize:focus-visible { outline: none; }
  .lazers-details-chevron {
    flex: none; display: inline-grid; place-items: center; width: 20px; height: 24px; padding: 0;
    border: 0; border-radius: 4px; background: none; color: var(--text-weak); cursor: pointer;
  }
  .lazers-details-chevron:hover { color: var(--text-strong); }
  .lazers-details-chevron:focus-visible { outline: 2px solid var(--border-selected); outline-offset: -2px; }
  .lazers-details-chevron > * { transition: transform 120ms ease; }
  .lazers-details[data-open="false"] .lazers-details-chevron > * { transform: rotate(180deg); }
  .lazers-details-header {
    flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--text-base);
  }
  .lazers-details-header[data-empty="true"] { color: var(--text-weak); }
  .lazers-details-actions { flex: none; display: flex; align-items: center; gap: 4px; }
  .lazers-details-body {
    flex: none; min-height: 0; overflow: auto; overscroll-behavior: contain; box-sizing: border-box;
    height: clamp(72px, calc(var(--details-size) * 100cqh), max(72px, calc(100cqh - 120px)));
    border-top: 1px solid var(--border-weak-base);
  }
  @media (prefers-reduced-motion: reduce) {
    .lazers-details-chevron > * { transition: none; }
  }
`
