import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  assertReviewPackageFiles,
  reviewPackageFiles,
  reviewProducers,
} from "./review-package-files.ts"

test("staged Review package validation catches omitted workers and WASM assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazers-review-package-"))
  try {
    for (const file of reviewPackageFiles) {
      const path = join(root, file)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, "")
    }
    await assertReviewPackageFiles(root)

    for (const producer of reviewProducers) {
      for (const file of [...producer.workers, ...producer.assets]) {
        await rm(join(root, file))
        await expect(assertReviewPackageFiles(root)).rejects.toThrow(
          `Missing Review package runtime file: ${file}`,
        )
        await writeFile(join(root, file), "")
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
