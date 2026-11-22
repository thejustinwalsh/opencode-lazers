import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "../storage.ts"
import {
  MODEL_PRICE_SOURCES,
  defaultModelPriceSourcePolicy,
  type ModelPriceSourcePolicy,
} from "./price-source-settings.ts"
import {
  refreshModelPriceSourcePolicyFor,
  startModelPriceSourcePolicyProjection,
} from "./price-source-projection.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

test("price policy projection refreshes stored stream rows and stops its timer on disposal", async () => {
  const root = mkdtempSync(join(tmpdir(), "lazers-model-price-policy-"))
  const projectDirectory = join(root, "project")
  const repository = new TaskRepository(join(root, "tasks.sqlite"), projectDirectory)
  let policy: ModelPriceSourcePolicy = defaultModelPriceSourcePolicy()
  let reads = 0
  const projection = startModelPriceSourcePolicyProjection({
    repository,
    projectDirectory,
    read: async () => {
      reads++
      return policy
    },
    refreshMs: 20,
  })
  cleanups.push(() => {
    projection.stop()
    repository.close()
    rmSync(root, { recursive: true, force: true })
  })

  await projection.refresh()
  const stored = () =>
    repository.read((db) =>
      db
        .query<{ revision: number; sources: string }, [string]>(
          "SELECT revision,sources FROM model_price_source_policy WHERE project_directory=?",
        )
        .get(projectDirectory),
    )
  expect(stored()).toEqual({
    revision: 0,
    sources: JSON.stringify(MODEL_PRICE_SOURCES),
  })

  policy = {
    ...policy,
    revision: 1,
    sources: ["models-dev", "openrouter"],
  }
  await refreshModelPriceSourcePolicyFor(projectDirectory)
  expect(stored()).toEqual({
    revision: 1,
    sources: JSON.stringify(["models-dev", "openrouter"]),
  })

  await Bun.sleep(70)
  expect(reads).toBeGreaterThan(2)
  projection.stop()
  const readsWhenStopped = reads
  await Bun.sleep(70)
  expect(reads).toBe(readsWhenStopped)
  await expect(refreshModelPriceSourcePolicyFor(projectDirectory)).rejects.toThrow(
    "Model price-source settings are unavailable",
  )
})
