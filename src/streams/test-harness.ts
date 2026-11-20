import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { readFrame, type Columns, type FrameHeader } from "./frame.ts"
import { readerPool, type OpenRequest, type PoolStream, type ReaderPool } from "./pool.ts"
import {
  SHARED_ACTIVE,
  SHARED_CONTROL_BYTES,
  SHARED_FRAME_BYTES,
  type Anchor,
  type FromReader,
  type Tier,
} from "./protocol.ts"
import { streamColumns, type Source } from "./source.ts"

export const testSourceModule = pathToFileURL(join(import.meta.dir, "test-source.ts")).href

export type SeededDatabase = { path: string; directory: string; db: Database; close(): void }

/** A temp WAL database with `items`: id 1..rows, rank id*37%100, bucket null for every 5th row. */
export function seedItems(rows = 10_000): SeededDatabase {
  const directory = mkdtempSync(join(tmpdir(), "lz-streams-"))
  const path = join(directory, "items.sqlite")
  const db = new Database(path, { strict: true })
  db.run("PRAGMA journal_mode=WAL")
  db.run(
    "CREATE TABLE items(id INTEGER PRIMARY KEY, grp TEXT NOT NULL, rank INTEGER NOT NULL, bucket INTEGER, title TEXT NOT NULL, meta TEXT NOT NULL, done INTEGER NOT NULL, body TEXT NOT NULL)",
  )
  db.run("CREATE INDEX items_grp ON items(grp, id)")
  db.run("CREATE INDEX items_rank ON items(rank DESC, id)")
  db.run("CREATE INDEX items_bucket ON items(bucket, id DESC)")
  const insert = db.query("INSERT INTO items VALUES(?,?,?,?,?,?,?,?)")
  db.transaction(() => {
    for (let id = 1; id <= rows; id++)
      insert.run(
        id,
        `g${id % 3}`,
        (id * 37) % 100,
        id % 5 === 0 ? null : (id * 11) % 50,
        `item ${id} é`,
        JSON.stringify({ n: id }),
        id % 2,
        `body of ${id} ${"x".repeat(40)}`,
      )
  })()
  return {
    path,
    directory,
    db,
    close() {
      db.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

export const testPool = (path: string, workers = 1): ReaderPool =>
  readerPool(path, { workers, sourceModules: [testSourceModule] })

export type Delivered = {
  header: FrameHeader
  ids: number[]
  /** The frame's used bytes, copied out of whatever buffer carried it. */
  bytes: Uint8Array
  message: Extract<FromReader, { type: "frame" }>
}

/** Drives one stream the way the client will: collects frames, reads them, returns buffers. */
export function openHarness<F, C extends Columns>(
  pool: ReaderPool,
  source: Source<F, C>,
  request: Omit<OpenRequest, "source" | "tier"> & { tier?: Tier },
) {
  const tier = request.tier ?? "copy"
  const frames: Delivered[] = []
  const messages: FromReader[] = []
  const waiters: (() => void)[] = []
  let shared: SharedArrayBuffer | undefined
  const columns = streamColumns(source as never, request.window)
  const decode = (message: Extract<FromReader, { type: "frame" }>): Delivered => {
    let buffer: ArrayBufferLike
    let offset = 0
    if (message.buffer) buffer = message.buffer
    else if (message.bytes) {
      buffer = message.bytes.buffer
      offset = message.bytes.byteOffset
    } else {
      buffer = shared!
      const control = new Int32Array(shared!, 0, 4)
      offset =
        SHARED_CONTROL_BYTES + Atomics.load(control, SHARED_ACTIVE) * control[SHARED_FRAME_BYTES]!
    }
    const frame = readFrame(buffer, offset, columns)
    const ids = Array.from({ length: frame.header.count }, (_, i) => frame.row(i).id as number)
    return {
      header: frame.header,
      ids,
      bytes: new Uint8Array(buffer, offset, frame.usedBytes).slice(),
      message,
    }
  }
  const stream: PoolStream = pool.attach({ ...request, source: source.name, tier }, (message) => {
    messages.push(message)
    if (message.type === "opened" && message.shared) shared = message.shared
    if (message.type === "regrow") shared = message.shared
    if (message.type === "frame") {
      const delivered = decode(message)
      frames.push(delivered)
      if (message.buffer) stream.release(message.buffer)
    }
    for (const wake of waiters.splice(0)) wake()
  })
  const next = async (timeoutMs = 10_000): Promise<Delivered> => {
    const seen = frames.length
    const deadline = Date.now() + timeoutMs
    while (frames.length === seen) {
      const failed = messages.find((m) => m.type === "failed")
      if (failed && failed.type === "failed") throw new Error(failed.message)
      if (Date.now() > deadline) throw new Error("Timed out waiting for a frame")
      await new Promise<void>((resolve) => {
        waiters.push(resolve)
        setTimeout(resolve, 25)
      })
    }
    return frames[frames.length - 1]!
  }
  return {
    stream,
    frames,
    messages,
    /** Waits for the next frame to arrive after this call. */
    next,
    async slide(delta: number) {
      const wait = next()
      stream.post({ type: "slide", delta })
      return wait
    },
    async seek(anchor: Anchor) {
      const wait = next()
      stream.post({ type: "seek", anchor })
      return wait
    },
  }
}
