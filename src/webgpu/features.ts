import { z } from "zod"

/**
 * How long resident weights stay loaded with no inference when no setting says otherwise.
 * Negative means never unload when idle. The chat weights are 1.6 GB (manifest MODEL_BYTES) and
 * the decision weights 0.6 GB, held in GPU and host memory while resident; a reload reads them
 * from the verified cache, not the network. Fifteen minutes spans a work session's gaps between
 * questions and is one of the choices the settings list already offers. A saved setting wins.
 */
export const DEFAULT_MODEL_KEEP_ALIVE_MS = 15 * 60_000

/** The stored "Always" choice: weights stay loaded when idle. Only a user picks it. */
export const NEVER_UNLOAD_MS = -1

/**
 * The "Keep model loaded" setting before the user has chosen. The store persists only a value
 * somebody set, so this reaches users who never chose and leaves every stored value (including an
 * explicit Always) as it is.
 */
export const RUNTIME_SETTINGS_INITIAL = { keepAliveMs: DEFAULT_MODEL_KEEP_ALIVE_MS }

export const FeatureSettings = z.strictObject({
  enabled: z.boolean(),
  questions: z.boolean(),
  decisions: z.boolean(),
  review: z.boolean(),
  dictation: z.boolean(),
  readAloud: z.boolean(),
})
export const FeaturePatch = FeatureSettings.partial()
export type Features = z.infer<typeof FeatureSettings>
export type LocalFeature = Exclude<keyof Features, "enabled">
export const defaultFeatures = (enabled = false): Features => ({
  enabled,
  questions: true,
  decisions: true,
  review: true,
  dictation: true,
  readAloud: true,
})
export const featureEnabled = (settings: Features, feature: LocalFeature): boolean =>
  settings.enabled && settings[feature] && (feature !== "review" || settings.decisions)
export const usesGPU = (settings: Features) =>
  (["questions", "decisions", "review", "dictation", "readAloud"] as const).some((key) =>
    featureEnabled(settings, key),
  )
export const needsChat = (settings: Features) =>
  (["questions", "dictation", "readAloud"] as const).some((key) => featureEnabled(settings, key))

/** Serializes partial preference writes; a failed save never claims the change was persisted. */
export class FeaturePolicy {
  private value: Features
  private writes: Promise<unknown> = Promise.resolve()
  constructor(
    initial: Features,
    private readonly persist: (value: Features) => Promise<void>,
    private readonly changed: (value: Features) => void,
  ) {
    this.value = FeatureSettings.parse(initial)
  }
  read = (): Features => ({ ...this.value })
  configure(input: unknown): Promise<Features> {
    const patch = FeaturePatch.parse(input)
    const operation = this.writes
      .catch(() => {})
      .then(async () => {
        const next = FeatureSettings.parse({ ...this.value, ...patch })
        await this.persist(next)
        this.value = next
        this.changed(next)
        return this.read()
      })
    this.writes = operation
    return operation
  }
}
