import { expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  readdir,
  mkdir,
  symlink,
  rename,
  open,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ModelCache } from "./cache.ts"

const bytes = new TextEncoder().encode("GGUF-test")
const file = {
  id: "model",
  name: "test.gguf",
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
}
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "lazers-cache-"))
  const directory = join(root, "models")
  let requests = 0
  const download = Object.assign(
    async () => {
      requests++
      return new Response(bytes)
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch
  return {
    root,
    directory,
    download,
    requests: () => requests,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

test("verified files persist across cache instances without another network request", async () => {
  const f = await fixture()
  try {
    const first = new ModelCache(f.directory, [file], f.download)
    await first.ensure()
    expect((await first.status()).phase).toBe("cached")
    expect(Buffer.from(await first.read("model", 0, bytes.length), "base64")).toEqual(
      Buffer.from(bytes),
    )
    const reopened = new ModelCache(f.directory, [file], f.download)
    await reopened.ensure()
    expect(f.requests()).toBe(1)
    await expect(reopened.read("../tasks.sqlite", 0, 1)).rejects.toThrow()
    await expect(reopened.read("model", 0, 2_097_153)).rejects.toThrow()
  } finally {
    await f.cleanup()
  }
})

test("F-S13-1 unchanged cache identity reuses verification; first use and mutation still hash", async () => {
  const f = await fixture()
  await mkdir(f.directory)
  await writeFile(join(f.directory, file.name), bytes)
  const handle = await open(join(f.directory, file.name), "r")
  const streams = spyOn(Object.getPrototypeOf(handle), "createReadStream")
  await handle.close()
  try {
    const cache = new ModelCache(f.directory, [file], f.download)
    await cache.ensure()
    expect(streams).toHaveBeenCalledTimes(1)
    await cache.ensure()
    await cache.ensure()
    expect(streams).toHaveBeenCalledTimes(1)
    expect(Buffer.from(await cache.read(file.id, 0, bytes.length), "base64")).toEqual(
      Buffer.from(bytes),
    )
    const reopened = new ModelCache(f.directory, [file], f.download)
    await reopened.ensure()
    expect(streams).toHaveBeenCalledTimes(2)
    await writeFile(join(f.directory, file.name), "XXXXXXXXX")
    await cache.ensure()
    expect(streams).toHaveBeenCalledTimes(3)
    expect(f.requests()).toBe(1)
    expect(await readFile(join(f.directory, file.name))).toEqual(Buffer.from(bytes))
  } finally {
    streams.mockRestore()
    await f.cleanup()
  }
})

test("corrupted files are reverified and replaced; incomplete downloads never become cached", async () => {
  const f = await fixture()
  try {
    const cache = new ModelCache(f.directory, [file], f.download)
    await cache.ensure()
    await writeFile(join(f.directory, file.name), "XXXXXXXXX")
    await cache.ensure()
    expect(f.requests()).toBe(2)
    expect(await readFile(join(f.directory, file.name))).toEqual(Buffer.from(bytes))
    const bad = new ModelCache(
      join(f.root, "bad"),
      [file],
      Object.assign(async () => new Response("wrong"), {
        preconnect: fetch.preconnect,
      }) as typeof fetch,
    )
    await expect(bad.ensure()).rejects.toThrow("checksum")
    expect(await readdir(join(f.root, "bad"))).toEqual([])
    expect((await bad.status()).phase).toBe("error")
  } finally {
    await f.cleanup()
  }
})

test("cleanup only removes named model files, preserving task records and unrelated files", async () => {
  const f = await fixture()
  try {
    const cache = new ModelCache(f.directory, [file], f.download)
    await cache.ensure()
    await writeFile(join(f.root, "tasks.sqlite"), "task records")
    await writeFile(join(f.directory, "unrelated.bin"), "keep")
    await cache.clear()
    expect(await readFile(join(f.root, "tasks.sqlite"), "utf8")).toBe("task records")
    expect(await readdir(f.directory)).toEqual(["unrelated.bin"])
    await expect(cache.read("model", 0, 1)).rejects.toThrow("verified")
  } finally {
    await f.cleanup()
  }
})

test("cache refuses directory symlinks and respects cancellation before downloading", async () => {
  const f = await fixture()
  try {
    await mkdir(join(f.root, "target"))
    await symlink(join(f.root, "target"), f.directory)
    const cache = new ModelCache(f.directory, [file], f.download)
    await expect(cache.ensure()).rejects.toThrow("symlink")
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(
      new ModelCache(join(f.root, "cancelled"), [file], f.download).ensure(cancelled.signal),
    ).rejects.toThrow()
    expect(f.requests()).toBe(0)
  } finally {
    await f.cleanup()
  }
})

test("verified reads reject subsequent file replacement, same-size mutation and symlinks", async () => {
  const f = await fixture()
  try {
    const cache = new ModelCache(f.directory, [file], f.download)
    await cache.ensure()
    await writeFile(join(f.directory, "replacement"), bytes)
    await rename(join(f.directory, "replacement"), join(f.directory, file.name))
    await expect(cache.read(file.id, 0, 1)).rejects.toThrow("changed")
    await cache.ensure()
    await writeFile(join(f.directory, file.name), "XXXXXXXXX")
    await expect(cache.read(file.id, 0, 1)).rejects.toThrow("changed")
    await cache.ensure()
    await rm(join(f.directory, file.name))
    await writeFile(join(f.root, "outside"), bytes)
    await symlink(join(f.root, "outside"), join(f.directory, file.name))
    await expect(cache.read(file.id, 0, 1)).rejects.toThrow()
    await expect(cache.ensure()).rejects.toThrow("unexpected file type")
    await expect(cache.read(file.id, 0, 1)).rejects.toThrow("verified")
  } finally {
    await f.cleanup()
  }
})

test("stopping a download drains its partial file before a new owner can verify", async () => {
  const f = await fixture()
  const started = Promise.withResolvers<void>()
  try {
    const download = Object.assign(
      async (_: unknown, init?: RequestInit) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.subarray(0, 2))
              init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), {
                once: true,
              })
              started.resolve()
            },
          }),
        ),
      { preconnect: fetch.preconnect },
    ) as typeof fetch
    const cache = new ModelCache(f.directory, [file], download)
    const loading = cache.ensure().catch((error: unknown) => String(error))
    await started.promise
    await expect(cache.clear()).rejects.toThrow("download")
    await cache.stop()
    expect(await loading).toContain("cancelled")
    expect(await readdir(f.directory)).toEqual([])
    await expect(cache.read(file.id, 0, 1)).rejects.toThrow("verified")
  } finally {
    await f.cleanup()
  }
})
