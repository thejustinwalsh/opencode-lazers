/**
 * Plan priority is 1 = top, larger = lower, 0 = none. Several fixtures were written in the earlier
 * "higher value first" direction; this maps such a value to the current direction so the fixture
 * keeps its intended relative order. Zero and negative values mean no priority.
 */
export const priorityFromHigherFirst = (value: number) => (value > 0 ? 1_000_000 - value : 0)
