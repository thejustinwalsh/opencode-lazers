import { createHash } from "node:crypto"
import { constants } from "node:fs"
import type { Stats } from "node:fs"
import { lstat, mkdir, open, rename, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { MAX_READ_BYTES, MODEL_FILES, MODEL_REVISION, modelURL } from "./manifest.ts"
import type { ModelFile } from "./manifest.ts"

export function modelCacheDirectory(dataDirectory?: string): string {
  const root =
    dataDirectory ??
    join(
      process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
      "opencode",
      "plugins",
      "lazers",
    )
  if (!isAbsolute(root)) throw new Error("LAZERS dataDirectory must be absolute")
  return join(root, "models", MODEL_REVISION)
}

export class ModelCache {
  private verified = new Map<string, string>()
  private operation: Promise<void> | undefined
  private controller: AbortController | undefined
  private phase = "empty"
  private downloadedBytes = 0
  private failure = ""

  private identity(info: Stats) {
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
  }

  constructor(
    readonly directory: string,
    private readonly files: readonly ModelFile[] = MODEL_FILES,
    private readonly download: typeof fetch = fetch,
    private readonly source = modelURL,
  ) {
    if (!isAbsolute(directory)) throw new Error("Cache directory must be absolute")
    for (const file of files) {
      if (!/^[A-Za-z0-9_.-]+$/.test(file.name) || file.name === "." || file.name === "..")
        throw new Error("Invalid model filename")
    }
  }

  private async prepare() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    if (!(await lstat(this.directory)).isDirectory())
      throw new Error("Model cache must be a directory, not a symlink")
  }

  async status() {
    let cachedBytes = 0
    for (const file of this.files) {
      const info = await lstat(join(this.directory, file.name)).catch(() => undefined)
      if (info?.isFile() && info.size === file.bytes) cachedBytes += info.size
    }
    const totalBytes = this.files.reduce((sum, file) => sum + file.bytes, 0)
    return {
      phase: this.operation
        ? this.phase
        : cachedBytes === totalBytes
          ? "cached"
          : this.failure
            ? "error"
            : "empty",
      cachedBytes,
      totalBytes,
      downloadedBytes: this.downloadedBytes,
      directory: this.directory,
      error: this.failure,
    }
  }

  async ensure(signal?: AbortSignal): Promise<void> {
    if (this.operation) throw new Error("A model download or verification is already running")
    this.controller = new AbortController()
    const combined = signal
      ? AbortSignal.any([signal, this.controller.signal])
      : this.controller.signal
    this.failure = ""
    this.downloadedBytes = 0
    this.operation = this.populate(combined)
    try {
      await this.operation
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      this.operation = undefined
      this.controller = undefined
    }
  }

  private async populate(signal: AbortSignal) {
    this.verified.clear()
    await this.prepare()
    for (const file of this.files) {
      signal.throwIfAborted()
      this.phase = "verifying"
      const path = join(this.directory, file.name)
      const info = await lstat(path).catch(() => undefined)
      if (info && !info.isFile()) throw new Error("Model cache contains an unexpected file type")
      if (info?.size === file.bytes) {
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const before = await handle.stat()
          if (!before.isFile() || this.identity(before) !== this.identity(info))
            throw new Error("Model cache changed during verification")
          const hash = createHash("sha256")
          for await (const chunk of handle.createReadStream({ signal, autoClose: false }))
            hash.update(chunk)
          const after = await handle.stat()
          if (this.identity(before) !== this.identity(after))
            throw new Error("Model cache changed during verification")
          if (hash.digest("hex") === file.sha256) {
            signal.throwIfAborted()
            this.verified.set(file.id, this.identity(after))
            this.downloadedBytes += file.bytes
            continue
          }
        } finally {
          await handle.close()
        }
      }
      this.verified.delete(file.id)
      const partial = `${path}.part`
      await rm(partial, { force: true })
      this.phase = "downloading"
      const response = await this.download(this.source(file.name), { signal })
      if (!response.ok || !response.body)
        throw new Error(`Hugging Face download failed: ${response.status}`)
      const handle = await open(partial, "wx", 0o600)
      const hash = createHash("sha256")
      let received = 0
      try {
        for await (const chunk of response.body) {
          signal.throwIfAborted()
          received += chunk.byteLength
          if (received > file.bytes) throw new Error("Model exceeds its pinned size")
          await handle.writeFile(chunk)
          hash.update(chunk)
          this.downloadedBytes += chunk.byteLength
        }
        if (received !== file.bytes || hash.digest("hex") !== file.sha256)
          throw new Error("Model size or SHA-256 checksum mismatch")
        await handle.sync()
        signal.throwIfAborted()
        await rename(partial, path)
        this.verified.set(file.id, this.identity(await handle.stat()))
        await handle.close()
      } catch (error) {
        await handle.close().catch(() => {})
        await rm(partial, { force: true })
        throw error
      }
    }
    this.phase = "cached"
  }

  cancel() {
    this.controller?.abort(new Error("Model download cancelled"))
  }

  async stop() {
    this.cancel()
    await this.operation?.catch(() => {})
  }

  async read(id: string, offset: number, length: number): Promise<string> {
    const file = this.files.find((candidate) => candidate.id === id)
    if (!file || !this.verified.has(id)) throw new Error("Model file is not verified")
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 1 ||
      length > MAX_READ_BYTES ||
      offset + length > file.bytes
    )
      throw new Error("Invalid model read range")
    const handle = await open(
      join(this.directory, file.name),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    )
    try {
      const info = await handle.stat()
      if (!info.isFile() || this.identity(info) !== this.verified.get(id)) {
        this.verified.delete(id)
        throw new Error("Verified model file changed; reload to verify it again")
      }
      const bytes = Buffer.alloc(length)
      let read = 0
      while (read < length) {
        const result = await handle.read(bytes, read, length - read, offset + read)
        if (!result.bytesRead) throw new Error("Cached model was truncated")
        read += result.bytesRead
      }
      if (this.identity(await handle.stat()) !== this.verified.get(id))
        throw new Error("Verified model file changed during a cache read")
      return bytes.toString("base64")
    } finally {
      await handle.close()
    }
  }

  async clear() {
    if (this.operation) throw new Error("Cancel the download before removing cached files")
    await this.prepare()
    for (const file of this.files) {
      await rm(join(this.directory, file.name), { force: true })
      await rm(join(this.directory, `${file.name}.part`), { force: true })
    }
    this.verified.clear()
    this.downloadedBytes = 0
    this.failure = ""
    this.phase = "empty"
  }
}
