/**
 * Browser weight cache on the Origin Private File System (OPFS): the one scheme ruNNtime's own
 * browser cache uses (`createOpfsCache`), applied here to multi-gigabyte files that must never sit
 * in memory. Each file is downloaded in ranged segments straight into an OPFS file through a sync
 * access handle (workers only), hashed as it streams, and verified against the pinned SHA-256 from
 * the product's manifest. An interrupted download resumes from its last whole segment. Reads for
 * ruNNtime are `File.slice` ranges. Runs in the worker.
 */
import { MODEL_FILES, MODEL_REVISION, modelURL } from "../../../src/webgpu/manifest"
import type { FileProgress } from "./machine"
import { Sha256 } from "./sha256"

export const SEGMENT_BYTES = 32 * 1024 * 1024
const RETRIES = 3

export class DownloadError extends Error {
  constructor(
    readonly reason: "offline" | "storage" | "error",
    message: string,
  ) {
    super(message)
  }
}

export const isAbort = (error: unknown) =>
  error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")

export const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`

/** Where an interrupted download picks up: the last whole segment inside what was written. */
export const resumeOffset = (written: number, total: number, segment = SEGMENT_BYTES) =>
  written >= total ? total : Math.floor(written / segment) * segment

async function directory() {
  const root = await navigator.storage.getDirectory()
  const base = await root.getDirectoryHandle("lazers-live-demo", { create: true })
  return base.getDirectoryHandle(MODEL_REVISION, { create: true })
}

type Marker = { bytes: number; sha256: string }

async function readMarker(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<Marker | undefined> {
  try {
    const file = await (await dir.getFileHandle(`${name}.ok`)).getFile()
    return JSON.parse(await file.text()) as Marker
  } catch {
    return undefined
  }
}

async function isCached(dir: FileSystemDirectoryHandle, file: (typeof MODEL_FILES)[number]) {
  const marker = await readMarker(dir, file.name)
  if (marker?.bytes !== file.bytes || marker.sha256 !== file.sha256) return false
  try {
    return (await (await dir.getFileHandle(file.name)).getFile()).size === file.bytes
  } catch {
    return false
  }
}

export async function weightsCached(): Promise<boolean> {
  const dir = await directory()
  for (const file of MODEL_FILES) if (!(await isCached(dir, file))) return false
  return true
}

/** Removes every downloaded byte (used when a file fails verification). */
async function discard(dir: FileSystemDirectoryHandle, name: string) {
  await dir.removeEntry(name).catch(() => undefined)
  await dir.removeEntry(`${name}.ok`).catch(() => undefined)
}

export async function removeWeights(): Promise<void> {
  const root = await navigator.storage.getDirectory()
  await root.removeEntry("lazers-live-demo", { recursive: true }).catch(() => undefined)
}

type Progress = (files: FileProgress[]) => void

/** Downloads whatever is not cached. Resolves when every file is present and verified. */
export async function ensureWeights(signal: AbortSignal, onProgress: Progress): Promise<void> {
  const dir = await directory()
  const files: FileProgress[] = MODEL_FILES.map((f) => ({
    id: f.id,
    name: f.name,
    done: 0,
    total: f.bytes,
  }))
  const missing = []
  for (const [index, file] of MODEL_FILES.entries()) {
    if (await isCached(dir, file)) files[index]!.done = file.bytes
    else missing.push({ file, index })
  }
  if (!missing.length) return
  await checkSpace(
    dir,
    missing.map((m) => m.file.bytes),
  )
  let last = 0
  const report = (force = false) => {
    const now = performance.now()
    if (!force && now - last < 100) return
    last = now
    onProgress(files.map((f) => ({ ...f })))
  }
  report(true)
  for (const { file, index } of missing) {
    await downloadFile(dir, file, signal, (done) => {
      files[index]!.done = done
      report()
    })
    files[index]!.done = file.bytes
    report(true)
  }
}

/** Fails early, in plain words, when the browser will not store the weights. */
async function checkSpace(dir: FileSystemDirectoryHandle, sizes: number[]) {
  const { quota, usage } = await navigator.storage.estimate()
  if (quota === undefined || usage === undefined) return
  let partial = 0
  for await (const [name, handle] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
    if (handle.kind === "file" && !name.endsWith(".ok"))
      partial += (await (handle as FileSystemFileHandle).getFile()).size
  }
  const needed = sizes.reduce((a, b) => a + b, 0) - partial
  const free = quota - usage
  if (needed > free)
    throw new DownloadError(
      "storage",
      `This browser will only store ${gb(Math.max(free, 0))} for this site, and the model needs ${gb(needed)} more. Private windows and low disk space cause this. Free some space or use a normal window.`,
    )
}

async function downloadFile(
  dir: FileSystemDirectoryHandle,
  file: (typeof MODEL_FILES)[number],
  signal: AbortSignal,
  onBytes: (done: number) => void,
) {
  const handle = await dir.getFileHandle(file.name, { create: true })
  const access = await handle.createSyncAccessHandle().catch((error: unknown) => {
    throw new DownloadError(
      "error",
      `Another tab is using the model files (${String(error)}). Close it and retry.`,
    )
  })
  try {
    let position = resumeOffset(access.getSize(), file.bytes)
    access.truncate(position)
    const hash = new Sha256()
    // Re-hash what an earlier visit already wrote, at disk speed.
    const block = new Uint8Array(8 * 1024 * 1024)
    for (let at = 0; at < position;) {
      signal.throwIfAborted()
      const n = access.read(block.subarray(0, Math.min(block.length, position - at)), { at })
      hash.update(block.subarray(0, n))
      at += n
    }
    onBytes(position)
    const url = modelURL(file.name)
    while (position < file.bytes) {
      const end = Math.min(position + SEGMENT_BYTES, file.bytes) - 1
      const bytes = await fetchSegment(url, position, end, signal)
      try {
        access.write(bytes, { at: position })
        access.flush()
      } catch (error) {
        throw storageError(error)
      }
      hash.update(bytes)
      position += bytes.length
      onBytes(position)
    }
    const digest = hash.hex()
    if (digest !== file.sha256) {
      access.truncate(0)
      access.close()
      await discard(dir, file.name)
      throw new DownloadError(
        "error",
        `${file.name} did not match its published checksum, so it was deleted. Retry to download it again.`,
      )
    }
    const marker = await dir.getFileHandle(`${file.name}.ok`, { create: true })
    const writer = await marker.createSyncAccessHandle()
    writer.truncate(0)
    writer.write(new TextEncoder().encode(JSON.stringify({ bytes: file.bytes, sha256: digest })))
    writer.close()
  } finally {
    try {
      access.close()
    } catch {
      // Already closed after a failed checksum.
    }
  }
}

function storageError(error: unknown) {
  return error instanceof DOMException && error.name === "QuotaExceededError"
    ? new DownloadError("storage", "The browser ran out of storage space for this site.")
    : error
}

/** One ranged request, retried a few times; the whole segment is held (32 MiB) before it is written. */
async function fetchSegment(url: string, start: number, end: number, signal: AbortSignal) {
  let failure: unknown
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    signal.throwIfAborted()
    try {
      const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal })
      if (response.status !== 206)
        throw new DownloadError(
          "error",
          response.ok
            ? "The download host ignored the byte range request."
            : `Hugging Face answered ${response.status} ${response.statusText}.`,
        )
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.length !== end - start + 1)
        throw new Error(`Short read: got ${bytes.length} of ${end - start + 1} bytes.`)
      return bytes
    } catch (error) {
      if (isAbort(error) || signal.aborted) throw error
      failure = error
      if (error instanceof DownloadError && error.message.includes("ignored")) throw error
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
    }
  }
  if (failure instanceof DownloadError) throw failure
  throw new DownloadError(
    "offline",
    `The connection to Hugging Face dropped (${failure instanceof Error ? failure.message : String(failure)}). Retry resumes where it stopped.`,
  )
}

/** ruNNtime's RangeSource over a cached OPFS file. */
export function opfsRangeSource(name: string) {
  let file: Promise<File> | undefined
  return {
    async read(begin: number, end: number): Promise<Uint8Array> {
      file ??= directory().then(async (dir) => (await dir.getFileHandle(name)).getFile())
      const blob = (await file).slice(begin, end)
      return new Uint8Array(await blob.arrayBuffer())
    },
  }
}
