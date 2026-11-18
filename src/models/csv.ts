/** RFC 4180 CSV: quoted fields may hold commas, doubled quotes and line breaks. */
export function parseCSV(text: string): Array<Record<string, string>> {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
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
      rows.push(row)
      row = []
    } else field += char
  }
  if (field !== "" || row.length) {
    row.push(field)
    rows.push(row)
  }
  const [header, ...data] = rows
  if (!header) return []
  return data
    .filter((cells) => cells.some((cell) => cell !== ""))
    .map((cells) => Object.fromEntries(header.map((name, at) => [name, cells[at] ?? ""])))
}
