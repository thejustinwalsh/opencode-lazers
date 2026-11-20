import { setDefaultTimeout } from "bun:test"

/**
 * Bun's default per-test timeout is 5 seconds. Tests here spawn git and build fixtures, and the
 * machine also runs agents and the live product: a git-heavy test measured 5.2 to 6.2 s at load
 * average ~22, and that 5 s default failed plan verification twice for work that was correct.
 * A timeout here is only a guard against a hung test, never a performance budget, so it is set
 * far above any honest run. A slow test still shows its duration in the output.
 */
setDefaultTimeout(120_000)
