import { sizeFromLegacySplit, storedState } from "../details-pane.ts"

export type DetailsView = "monitor" | "map" | "flow" | "lifecycle"

type StoredDetails = Record<string, { open?: boolean; size?: number }>
export type DetailsInput = {
  details?: StoredDetails | undefined
  /** Legacy: the Monitor divider position (percent of the top region). */
  monitorSplit?: number | undefined
  /** Legacy: the lifecycle diagram's divider position. */
  split?: number | undefined
}

/**
 * The stored details pane for one view: closed and 0.45 by default. An old divider position
 * becomes a body size the first time it is read; a stored size always wins.
 */
export function storedDetails(view: DetailsInput, which: DetailsView) {
  const stored = view.details?.[which]
  const legacy =
    which === "monitor" ? view.monitorSplit : which === "lifecycle" ? view.split : undefined
  return storedState({
    open: stored?.open,
    size: stored?.size ?? sizeFromLegacySplit(legacy),
  } as { open?: boolean; size?: number })
}

/** A change to one view's pane. Collapsing passes only `open`, so the stored size is kept. */
export function detailsChange(
  view: DetailsInput,
  which: DetailsView,
  change: { open?: boolean; size?: number },
) {
  return {
    details: { ...(view.details ?? {}), [which]: { ...(view.details?.[which] ?? {}), ...change } },
  }
}
