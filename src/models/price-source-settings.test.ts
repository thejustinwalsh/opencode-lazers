import { expect, test } from "bun:test"
import {
  defaultModelPriceSourcePolicy,
  ModelPriceSourceSettingsStore,
  ModelPriceSourceUpdateSchema,
} from "./price-source-settings.ts"

function memoryStorage(initial = new Map<string, unknown>()) {
  const values = initial
  const calls = { get: 0, set: 0 }
  return {
    values,
    calls,
    storage: {
      get: async (key: string) => {
        calls.get += 1
        return values.get(key)
      },
      set: async (key: string, value: unknown) => {
        calls.set += 1
        values.set(key, value)
      },
    },
  }
}

test("price-source policy defaults to OpenRouter then OpenCode and persists across store reopen", async () => {
  const host = memoryStorage()
  const first = new ModelPriceSourceSettingsStore(host.storage, "/project")
  expect(await first.read()).toEqual(defaultModelPriceSourcePolicy())

  expect(
    await first.configure({ expectedRevision: 0, sources: ["opencode", "openrouter"] }),
  ).toMatchObject({
    status: "updated",
    policy: {
      revision: 1,
      sources: ["opencode", "openrouter"],
      fallback: "whole-model",
    },
  })
  expect(await first.configure({ expectedRevision: 1, sources: ["opencode"] })).toMatchObject({
    status: "updated",
    policy: { revision: 2, sources: ["opencode"] },
  })

  const reopened = new ModelPriceSourceSettingsStore(host.storage, "/project")
  // models.dev is keyless: a saved policy without it reads back with it appended.
  expect(await reopened.read()).toMatchObject({
    revision: 2,
    sources: ["opencode", "models-dev"],
    fallback: "whole-model",
  })
  await expect(
    new ModelPriceSourceSettingsStore(host.storage, "/another-project").read(),
  ).resolves.toEqual(defaultModelPriceSourcePolicy())
})

test("source policy input rejects unsupported, duplicate, and credential-shaped entries before storage access", async () => {
  const host = memoryStorage()
  const store = new ModelPriceSourceSettingsStore(host.storage, "/project")

  expect(
    ModelPriceSourceUpdateSchema.safeParse({ expectedRevision: 0, sources: ["openai"] }).success,
  ).toBe(false)
  expect(
    ModelPriceSourceUpdateSchema.safeParse({
      expectedRevision: 0,
      sources: ["openrouter", "openrouter"],
    }).success,
  ).toBe(false)
  expect(() =>
    store.configure({ expectedRevision: 0, sources: ["openrouter", "secret-key-value"] }),
  ).toThrow()
  expect(() =>
    store.configure({ expectedRevision: 0, sources: ["openrouter"], apiKey: "secret-key-value" }),
  ).toThrow()
  expect(host.calls).toEqual({ get: 0, set: 0 })
  expect([...host.values.values()]).toEqual([])
})

test("empty source list disables all price sources without weakening the whole-model rule", async () => {
  const host = memoryStorage()
  const store = new ModelPriceSourceSettingsStore(host.storage, "/project")
  const output = await store.configure({ expectedRevision: 0, sources: [] })

  expect(output).toMatchObject({
    status: "updated",
    policy: { revision: 1, sources: [], fallback: "whole-model" },
  })
})

test("stale and concurrent writes return the current revision without overwriting it", async () => {
  const host = memoryStorage()
  const store = new ModelPriceSourceSettingsStore(host.storage, "/project")

  const [first, second] = await Promise.all([
    store.configure({ expectedRevision: 0, sources: ["opencode"] }),
    store.configure({ expectedRevision: 0, sources: ["openrouter"] }),
  ])
  expect(first).toMatchObject({ status: "updated", policy: { revision: 1, sources: ["opencode"] } })
  expect(second).toMatchObject({
    status: "conflict",
    expectedRevision: 0,
    currentRevision: 1,
    current: { revision: 1, sources: ["opencode", "models-dev"] },
  })
  expect(await store.read()).toMatchObject({ revision: 1, sources: ["opencode", "models-dev"] })
  expect(host.calls.set).toBe(1)

  const stale = await store.configure({ expectedRevision: 0, sources: ["openrouter", "opencode"] })
  expect(stale).toMatchObject({ status: "conflict", expectedRevision: 0, currentRevision: 1 })
  expect(host.calls.set).toBe(1)
})

test("concurrent writes from independently loaded module instances share the project lock", async () => {
  const host = memoryStorage()
  const isolatedURL = new URL("./price-source-settings.ts", import.meta.url)
  isolatedURL.searchParams.set("generation", crypto.randomUUID())
  const isolatedModule = await import(isolatedURL.href)
  const first = new ModelPriceSourceSettingsStore(host.storage, "/project")
  const second = new isolatedModule.ModelPriceSourceSettingsStore(host.storage, "/project")
  const independentProject = new isolatedModule.ModelPriceSourceSettingsStore(
    host.storage,
    "/another-project",
  )

  const [firstWrite, secondWrite, independentWrite] = await Promise.all([
    first.configure({ expectedRevision: 0, sources: ["opencode"] }),
    second.configure({ expectedRevision: 0, sources: ["openrouter"] }),
    independentProject.configure({ expectedRevision: 0, sources: [] }),
  ])
  const projectWrites = [firstWrite, secondWrite]
  const successful = projectWrites.filter((write) => write.status === "updated")
  const conflicts = projectWrites.filter((write) => write.status === "conflict")
  expect(successful).toHaveLength(1)
  expect(conflicts).toHaveLength(1)
  expect(successful[0]?.policy.revision).toBe(1)
  expect(conflicts[0]).toMatchObject({
    status: "conflict",
    expectedRevision: 0,
    currentRevision: 1,
    current: { ...successful[0]?.policy, sources: ["opencode", "models-dev"] },
  })
  expect(independentWrite).toMatchObject({
    status: "updated",
    policy: { revision: 1, sources: [], fallback: "whole-model" },
  })

  const reopened = new isolatedModule.ModelPriceSourceSettingsStore(host.storage, "/project")
  expect(await reopened.read()).toEqual({
    ...successful[0]?.policy,
    sources: [...(successful[0]?.policy.sources ?? []), "models-dev"],
  })
  expect(await independentProject.read()).toEqual(independentWrite.policy)
  expect(host.calls.set).toBe(2)
})

test("corrupt stored settings fail closed without echoing stored values", async () => {
  const host = memoryStorage()
  host.values.set("models.price-source-policy.%2Fproject", {
    schemaVersion: 1,
    revision: 4,
    sources: ["openrouter", "unsupported-source"],
    fallback: "whole-model",
    token: "unexpected-field-value",
  })
  const store = new ModelPriceSourceSettingsStore(host.storage, "/project")

  const readError = await store.read().then(
    () => {
      throw new Error("Expected invalid storage to fail")
    },
    (error: unknown) => error,
  )
  expect(readError).toMatchObject({ message: "Stored model price-source policy is invalid" })
  expect(String(readError)).not.toContain("unexpected-field-value")
  const writeError = await store.configure({ expectedRevision: 4, sources: ["opencode"] }).then(
    () => {
      throw new Error("Expected invalid storage to fail")
    },
    (error: unknown) => error,
  )
  expect(writeError).toMatchObject({ message: "Stored model price-source policy is invalid" })
  expect(String(writeError)).not.toContain("unsupported-source")
  expect(host.calls.set).toBe(0)
})

test("aborted writes do not mutate policy", async () => {
  const host = memoryStorage()
  const store = new ModelPriceSourceSettingsStore(host.storage, "/project")
  const controller = new AbortController()
  controller.abort(new Error("cancelled"))

  await expect(
    store.configure({ expectedRevision: 0, sources: ["opencode"] }, controller.signal),
  ).rejects.toThrow("cancelled")
  expect(host.calls.set).toBe(0)
  expect(await new ModelPriceSourceSettingsStore(host.storage, "/project").read()).toEqual(
    defaultModelPriceSourcePolicy(),
  )
})

test("a policy saved before models.dev existed gains it, last, without a new revision", async () => {
  const host = memoryStorage()
  await host.storage.set("models.price-source-policy.%2Fproject", {
    schemaVersion: 1,
    revision: 3,
    sources: ["opencode", "openrouter"],
    fallback: "whole-model",
  } as never)
  const store = new ModelPriceSourceSettingsStore(host.storage, "/project")
  expect(await store.read()).toEqual({
    schemaVersion: 1,
    revision: 3,
    sources: ["opencode", "openrouter", "models-dev"],
    fallback: "whole-model",
  })
})
