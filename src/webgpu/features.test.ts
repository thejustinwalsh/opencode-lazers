import { expect, test } from "bun:test"
import {
  DEFAULT_MODEL_KEEP_ALIVE_MS,
  FeaturePolicy,
  defaultFeatures,
  featureEnabled,
  needsChat,
  usesGPU,
} from "./features.ts"

test("master and dependency switches mask features while retaining individual preferences", async () => {
  let saved = defaultFeatures(true)
  const policy = new FeaturePolicy(
    saved,
    async (value) => {
      saved = value
    },
    () => {},
  )
  await policy.configure({ dictation: false, readAloud: false, questions: false })
  expect(needsChat(policy.read())).toBe(false)
  expect(usesGPU(policy.read())).toBe(true)
  await policy.configure({ decisions: false })
  expect(policy.read().review).toBe(true)
  expect(featureEnabled(policy.read(), "review")).toBe(false)
  expect(usesGPU(policy.read())).toBe(false)
  await policy.configure({ enabled: false })
  const restored = new FeaturePolicy(
    saved,
    async () => {},
    () => {},
  )
  expect(usesGPU(restored.read())).toBe(false)
  await restored.configure({ enabled: true, decisions: true })
  expect(featureEnabled(restored.read(), "review")).toBe(true)
  expect(featureEnabled(restored.read(), "dictation")).toBe(false)
})

test("concurrent partial settings writes preserve each other; failed persistence does not apply a toggle", async () => {
  let fail = false
  const applied: boolean[] = []
  const policy = new FeaturePolicy(
    defaultFeatures(true),
    async () => {
      await Promise.resolve()
      if (fail) throw Error("Storage unavailable")
    },
    (value) => applied.push(value.enabled),
  )
  await Promise.all([
    policy.configure({ dictation: false }),
    policy.configure({ readAloud: false }),
  ])
  expect(policy.read().dictation).toBe(false)
  expect(policy.read().readAloud).toBe(false)
  fail = true
  await expect(policy.configure({ enabled: false })).rejects.toThrow("Storage unavailable")
  expect(policy.read().enabled).toBe(true)
  expect(applied).toEqual([true, true])
  expect(() => policy.configure({ unknown: true })).toThrow()
  fail = false
  await policy.configure({ enabled: false })
  expect(policy.read().enabled).toBe(false)
})

test("resident weights have a finite default idle timeout inside the settings range", () => {
  // Chat plus decision weights are about 2.2 GB; "never unload" must be a choice, not the default.
  expect(DEFAULT_MODEL_KEEP_ALIVE_MS).toBeGreaterThan(0)
  expect(DEFAULT_MODEL_KEEP_ALIVE_MS).toBeLessThanOrEqual(86_400_000)
})
