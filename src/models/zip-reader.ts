import { inflateRawSync } from "node:zlib"

/** Total bytes a single archive may expand to; a guard against decompression bombs. */
const MAX_UNZIPPED_BYTES = 64 * 1024 * 1024

export class ZipError extends Error {}

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

type ZipEntry = { method: number; compressed: number; size: number; start: number }

/**
 * The central directory of a ZIP archive (stored or deflated; no encryption, no ZIP64), with the
 * wanted entries inflated one at a time on request. Declared sizes are checked before anything is
 * inflated, so a bomb is refused up front; only the entry being read is ever expanded in memory.
 */
export function openZip(bytes: Uint8Array, wanted: ReadonlySet<string>) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--)
    if (view.getUint32(at, true) === EOCD) {
      eocd = at
      break
    }
  if (eocd < 0) throw new ZipError("no end-of-central-directory record")
  const count = view.getUint16(eocd + 10, true)
  let at = view.getUint32(eocd + 16, true)
  const entries = new Map<string, ZipEntry>()
  let total = 0
  for (let index = 0; index < count; index++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== CENTRAL)
      throw new ZipError("malformed central directory")
    const method = view.getUint16(at + 10, true)
    const compressed = view.getUint32(at + 20, true)
    const size = view.getUint32(at + 24, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const local = view.getUint32(at + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength))
    at += 46 + nameLength + extraLength + commentLength
    if (!wanted.has(name)) continue
    total += size
    if (total > MAX_UNZIPPED_BYTES) throw new ZipError("archive expands too far")
    if (local + 30 > bytes.length || view.getUint32(local, true) !== LOCAL)
      throw new ZipError("malformed local header")
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    if (start + compressed > bytes.length) throw new ZipError("truncated entry")
    if (method !== 0 && method !== 8) throw new ZipError(`unsupported compression method ${method}`)
    entries.set(name, { method, compressed, size, start })
  }
  return {
    /** The entry's bytes, inflated now; the caller drops them when done with the entry. */
    read(name: string): Uint8Array | undefined {
      const entry = entries.get(name)
      if (!entry) return undefined
      const data = bytes.subarray(entry.start, entry.start + entry.compressed)
      return entry.method === 0
        ? data
        : inflateRawSync(data, { maxOutputLength: Math.max(entry.size, 1) })
    },
  }
}

/** Every wanted entry at once; prefer `openZip` when entries can be consumed one by one. */
export function readZipEntries(bytes: Uint8Array, wanted: ReadonlySet<string>) {
  const zip = openZip(bytes, wanted)
  const entries = new Map<string, Uint8Array>()
  for (const name of wanted) {
    const data = zip.read(name)
    if (data) entries.set(name, data)
  }
  return entries
}
