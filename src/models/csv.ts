/**
 * RFC 4180 CSV: quoted fields may hold commas, doubled quotes and line breaks. Rows are produced
 * one at a time; nothing holds the whole file as rows.
 */
export function* iterateCSV(text: string): Generator<Record<string, string>> {
  let header: string[] | undefined
  let row: string[] = []
  let field = ""
  let quoted = false
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const finish = (cells: string[]): Record<string, string> | undefined => {
    if (!header) {
      header = cells
      return undefined
    }
    if (!cells.some((cell) => cell !== "")) return undefined
    return Object.fromEntries(header.map((name, at) => [name, cells[at] ?? ""]))
  }
  for (let index = 0; index < body.length; index++) {
    const char = body[index]!
    if (quoted) {
      if (char === '"') {
        if (body[index + 1] === '"') {
          field += '"'
          index++
        } else quoted = false
      } else field += char
    } else if (char === '"') quoted = true
    else if (char === ",") {
      row.push(field)
      field = ""
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && body[index + 1] === "\n") index++
      row.push(field)
      field = ""
      const record = finish(row)
      row = []
      if (record) yield record
    } else field += char
  }
  if (field !== "" || row.length) {
    row.push(field)
    const record = finish(row)
    if (record) yield record
  }
}

export function parseCSV(text: string): Array<Record<string, string>> {
  return [...iterateCSV(text)]
}
