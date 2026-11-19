import { readdir, open } from "node:fs/promises"
import { extname, join } from "node:path"

/**
 * LAZERS ships no native binary: analysis runs in WebAssembly. These helpers find any file in a
 * directory tree that is a native executable or addon, by extension (`.node`, `.dylib`, `.so`,
 * `.dll`, `.exe`) or by magic number (Mach-O, ELF, PE). WebAssembly (`\0asm`) is allowed.
 */
const NATIVE_EXTENSIONS = new Set([".node", ".dylib", ".so", ".dll", ".exe"])

const MAGIC: [string, number[]][] = [
  ["ELF", [0x7f, 0x45, 0x4c, 0x46]],
  ["Mach-O", [0xfe, 0xed, 0xfa, 0xce]],
  ["Mach-O", [0xfe, 0xed, 0xfa, 0xcf]],
  ["Mach-O", [0xce, 0xfa, 0xed, 0xfe]],
  ["Mach-O", [0xcf, 0xfa, 0xed, 0xfe]],
  // Mach-O universal binary. Java class files share these bytes; none ship in this package.
  ["Mach-O", [0xca, 0xfe, 0xba, 0xbe]],
  ["PE", [0x4d, 0x5a]],
]

export type NativeFinding = { path: string; kind: string }

async function magicKind(path: string): Promise<string | undefined> {
  const handle = await open(path, "r")
  try {
    const head = Buffer.alloc(4)
    const { bytesRead } = await handle.read(head, 0, 4, 0)
    for (const [kind, bytes] of MAGIC)
      if (bytesRead >= bytes.length && bytes.every((byte, i) => head[i] === byte)) return kind
    return undefined
  } finally {
    await handle.close()
  }
}

/** Every native binary under `directory`, as paths relative to it. */
export async function findNativeBinaries(directory: string, prefix = ""): Promise<NativeFinding[]> {
  const found: NativeFinding[] = []
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) found.push(...(await findNativeBinaries(directory, relative)))
    else if (entry.isFile()) {
      const byExtension = NATIVE_EXTENSIONS.has(extname(entry.name).toLowerCase())
      const kind = byExtension ? "native extension" : await magicKind(join(directory, relative))
      if (kind) found.push({ path: relative, kind })
    }
  }
  return found
}

/** Throws when `directory` holds a native binary. */
export async function assertNoNativeBinaries(directory: string): Promise<void> {
  const found = await findNativeBinaries(directory)
  if (found.length > 0)
    throw Error(
      `Release package contains native binaries: ${found.map((f) => `${f.path} (${f.kind})`).join(", ")}`,
    )
}
