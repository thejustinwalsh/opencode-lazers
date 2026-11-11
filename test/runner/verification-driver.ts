import { TaskRuntime } from "../../src/runner/runtime.ts"
import { verificationActivitiesForDatabase } from "../../src/runner/verification-activities.ts"

/** Completion-boundary driver. Barrier/race tests must use raw tick() instead. */
export async function settleVerification(runtime: TaskRuntime): Promise<void> {
  await runtime.tick()
  for (let cycle = 0; cycle < 30; cycle++) {
    const active = verificationActivitiesForDatabase(runtime.store.repository.path)
    if (!active.length) return
    await Promise.all(active.map((activity) => activity.settled))
    const advancesWithReceipt = active.every(
      ({ metadata }) =>
        typeof metadata.planID === "string" &&
        runtime.store
          .effects(metadata.planID)
          .some((effect) => effect.id === metadata.effectID && effect.kind.startsWith("verify:")),
    )
    // Apply each final receipt before advancing the candidate. Do not poll
    // delivery again after publication: lost-reply tests observe that boundary.
    for (let receipt = 0; receipt < active.length; receipt++) await runtime.tick()
    if (!advancesWithReceipt) await runtime.tick()
  }
  throw new Error("Verification did not reach its completion boundary")
}
