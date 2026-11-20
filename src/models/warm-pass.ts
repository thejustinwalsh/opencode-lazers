import { StampGate } from "../core/stamp-gate.ts"

/**
 * The keep-warm pass of one project, gated on the project's observation revision. The pass
 * runs when the revision or the set of overview inputs to keep warm moved since the last
 * complete pass; otherwise the gate answers from its cache and the reader is not touched, not
 * even to compare revisions. A pass cut short by a person's read, or one whose warm failed, is
 * never cached, so the next tick finishes it.
 *
 * Budget: one entry per project holding `true` (a few bytes); 64 KiB covers thousands of
 * projects, and an evicted entry only costs one revision comparison inside `reader.warm`.
 */
export class WarmGate {
  private readonly gate = new StampGate<true>({ maxBytes: 64 * 1024, sizeOf: () => 8 })

  get counts() {
    return this.gate.counts
  }

  clear() {
    this.gate.clear()
  }

  async pass(
    projectDirectory: string,
    revision: number | string,
    inputs: ReadonlyMap<string, { input: unknown }>,
    warm: (input: unknown) => Promise<unknown>,
    interrupted: () => boolean,
  ): Promise<void> {
    const stamp = `${revision}|${[...inputs.keys()].join(",")}`
    await this.gate
      .run(`warm:${projectDirectory}`, stamp, async () => {
        for (const { input } of inputs.values()) {
          if (interrupted()) throw new Error("warm pass interrupted")
          await warm(input)
        }
        return true as const
      })
      .catch(() => undefined)
  }
}
