import { DEFAULT_CCCC_SETTINGS, type CcccSettings } from "./types.ts"

export function validateCcccSettings(settings: CcccSettings): CcccSettings {
  if (!Number.isSafeInteger(settings.timeoutMs) || settings.timeoutMs < 1)
    throw new TypeError("cccc timeoutMs must be a positive integer")
  if (
    !Number.isFinite(settings.complexity.cyclomatic) ||
    settings.complexity.cyclomatic <= 0 ||
    !Number.isFinite(settings.complexity.cognitive) ||
    settings.complexity.cognitive <= 0 ||
    !Number.isFinite(settings.complexity.primaryDelta) ||
    settings.complexity.primaryDelta < 0
  )
    throw new TypeError("cccc complexity thresholds must be positive and primaryDelta non-negative")
  return settings
}

export function ccccSettings(settings?: CcccSettings): CcccSettings {
  return validateCcccSettings(settings ?? DEFAULT_CCCC_SETTINGS)
}
