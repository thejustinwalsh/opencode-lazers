/**
 * The one machine-readable line LAZERS puts under the header of every outcome notice and recovery
 * bundle, so a later pass over the conversation can tell which notices a newer one replaced
 * without parsing prose. Human-readable: `[lz-notice kind=blocked plan=<id> v=12]`.
 *
 * Values never contain spaces or `]`. `kind` is the notice's status, `plan` its plan, `v` the
 * plan version it describes (`gen` for a recovery bundle's generation), `task` the task a
 * task-accepted notice is about.
 */
export type NoticeMarker = {
  kind: string
  plan: string
  v?: number
  gen?: number
  task?: string
}

const NAMES = ["kind", "plan", "v", "gen", "task"] as const

/** Values that would break the line (spaces, brackets, line ends) are not marked at all. */
const safe = (value: string) => value.length > 0 && !/[\s[\]]/.test(value)

export function noticeMarker(marker: NoticeMarker): string | undefined {
  if (!safe(marker.kind) || !safe(marker.plan) || (marker.task !== undefined && !safe(marker.task)))
    return undefined
  const fields = [
    `kind=${marker.kind}`,
    `plan=${marker.plan}`,
    ...(marker.v !== undefined && Number.isSafeInteger(marker.v) ? [`v=${marker.v}`] : []),
    ...(marker.gen !== undefined && Number.isSafeInteger(marker.gen) ? [`gen=${marker.gen}`] : []),
    ...(marker.task !== undefined ? [`task=${marker.task}`] : []),
  ]
  return `[lz-notice ${fields.join(" ")}]`
}

export function parseNoticeMarker(line: string): NoticeMarker | undefined {
  const match = /^\[lz-notice ([^\]\n]+)\]$/.exec(line)
  if (!match) return undefined
  const found: Record<string, string> = {}
  for (const field of match[1]!.split(" ")) {
    const at = field.indexOf("=")
    if (at < 1) return undefined
    const name = field.slice(0, at)
    if (!(NAMES as readonly string[]).includes(name)) continue
    found[name] = field.slice(at + 1)
  }
  if (!found.kind || !found.plan) return undefined
  const number = (value: string | undefined) =>
    value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined
  return {
    kind: found.kind,
    plan: found.plan,
    ...(number(found.v) !== undefined ? { v: number(found.v)! } : {}),
    ...(number(found.gen) !== undefined ? { gen: number(found.gen)! } : {}),
    ...(found.task !== undefined ? { task: found.task } : {}),
  }
}
