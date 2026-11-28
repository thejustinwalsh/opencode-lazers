const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8")

export function byteOffsetToUtf16Column(line: string, bytes: Uint8Array, offset: number): number {
  if (offset <= 0) return 0
  if (offset >= bytes.length) return line.length
  return decoder.decode(bytes.subarray(0, offset)).length
}

export function utf8Bytes(line: string): Uint8Array {
  return encoder.encode(line)
}

/** Drop only the synthetic empty segment after LF, preserving CR and real empty lines. */
export function splitSourceLines(source: string): string[] {
  if (source.length === 0) return []
  const lines = source.split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines
}
