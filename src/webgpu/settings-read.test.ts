import { expect, test } from "bun:test"
import { defaultFeatures } from "./features.ts"
import { defaultSettingsAuthority, readFeatureSettings } from "./settings-read.ts"

test("54 staggered location polls share one authority read per interval", async () => {
  const authority = Symbol()
  let calls = 0
  const value = defaultFeatures(true)
  const read = async () => {
    calls++
    return value
  }
  const concurrent = Array.from({ length: 54 }, () => readFeatureSettings(authority, read, 0))
  expect((await Promise.all(concurrent)).every((result) => result === value)).toBe(true)
  expect(calls).toBe(1)
  for (let at = 100; at < 1000; at += 100) await readFeatureSettings(authority, read, at)
  expect(calls).toBe(1)
  await readFeatureSettings(authority, read, 1000)
  expect(calls).toBe(2)
})

test("read errors are retried and cannot publish an old value as a successful refresh", async () => {
  const authority = Symbol()
  await readFeatureSettings(authority, async () => defaultFeatures(false), 0)
  let calls = 0
  const failure = async () => {
    calls++
    throw new Error("service unavailable")
  }
  await expect(readFeatureSettings(authority, failure, 1000)).rejects.toThrow("service unavailable")
  await expect(readFeatureSettings(authority, failure, 1001)).rejects.toThrow("service unavailable")
  const updated = defaultFeatures(true)
  expect(await readFeatureSettings(authority, async () => updated, 1002)).toBe(updated)
  expect(calls).toBe(2)
})

test("different authorities remain independent and independent module copies share default authority", async () => {
  const disabled = defaultFeatures(false),
    enabled = defaultFeatures(true)
  const a = readFeatureSettings(Symbol(), async () => disabled, 0)
  const b = readFeatureSettings(Symbol(), async () => enabled, 0)
  expect(await a).toBe(disabled)
  expect(await b).toBe(enabled)
  const url = new URL(`./settings-read.ts?copy=${crypto.randomUUID()}`, import.meta.url).href
  const copy = await import(url)
  expect(copy.defaultSettingsAuthority).toBe(defaultSettingsAuthority)
  const authority = Symbol()
  let calls = 0
  const read = async () => {
    calls++
    return enabled
  }
  await readFeatureSettings(authority, read, 0)
  await copy.readFeatureSettings(authority, read, 0)
  expect(calls).toBe(1)
})
