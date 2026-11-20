import { runbooks } from "../guidance/index.ts"
import { parseNoticeMarker, type NoticeMarker } from "./notice-marker.ts"

/**
 * Superseded notices and tool results become one-line stubs in the messages a model request
 * carries. Nothing here touches storage: the caller hands in the request's messages and gets a new
 * array back, and OpenCode rebuilds the stored history for the next request.
 *
 * What is stubbed, and what replaces what (`window` = the messages up to the horizon):
 *
 * | what                                         | superseded by (later, inside the window)                       |
 * | -------------------------------------------- | -------------------------------------------------------------- |
 * | notice `blocked`, `cancelled`, `cleanup-blocked`, `dispatch-resumed`, `dependency-resolved`, any other status | any later notice of the same plan whose status is not `architect-handoff`, `queue-review`, `retained-verification-failed` or `recovery-bundle` |
 * | notice `accepted`, `integrated`              | the same                                                       |
 * | notice `task-accepted` (plan, task)          | a later `task-accepted` for the same plan and task, or a later `accepted`/`integrated` for the plan |
 * | notice `recovery-bundle`                     | a later recovery bundle (a bundle lists the whole backlog)     |
 * | notice `architect-handoff`, `queue-review`, `retained-verification-failed` | never: decisions a later outcome does not answer |
 * | read result (`lz-inspect-plan`, `lz-get-task`, ...) | a later result of the same call (same tool, same input)  |
 * | input of a successful `lz-submit-plan` / `lz-submit-task` | nothing: the runtime stored it; the result names the reference |
 *
 * These mirror the pending-notice rules in `outcome-delivery.ts` (`currentRows`). The newest of each
 * key is always whole. A stub is never longer than what it replaces, and the first copy of a runbook
 * stays whole while no other whole copy is in the window.
 *
 * Determinism: the output is a function of the messages and `facts.horizon` alone, and looks only at
 * the window. Messages after the horizon are returned untouched, and what they hold never changes
 * what is stubbed before them, so the prompt-cache prefix is stable between horizon advances.
 */

/** The parts of a model message this module reads; the real `Message` union satisfies it. */
export type ContextMessage = {
  readonly id?: string | undefined
  readonly role: string
  readonly content: unknown
}

export type StubFacts = {
  /** The id of the last message that may be stubbed; undefined or unknown stubs nothing. */
  horizon: string | undefined
  /**
   * Also replace the input of a successful submission (a prior assistant tool call's `input`, or a
   * Code Mode program's `code`). Off by default: the result-side stubs only touch text the model
   * is sent as user or tool-result content, while this rewrites an assistant turn.
   */
  inputs?: boolean
  /** Runbook texts to protect; defaults to every guidance runbook. */
  runbooks?: Readonly<Record<string, string>>
}

export type StubResult<M extends ContextMessage> = {
  messages: M[]
  /** Units replaced by a stub. */
  stubbed: number
  /** Characters removed from the request. */
  saved: number
}

type Part = { type?: unknown } & Record<string, unknown>

/** Tools whose result is a read of current state; a repeat call makes the older result obsolete. */
export const READ_TOOLS: ReadonlySet<string> = new Set([
  "lz-inspect-plan",
  "lz-get-task",
  "lz-query-tasks",
  "lz-list-tasks",
  "lz-inspect-trajectory",
  "lz-inspect-task-corrections",
  "lz-inspect-recovery",
  "lz-query-audits",
  "lz-get-audit",
])

/** Tools whose input the runtime stores on success. Value: the key that names the call, and the read-back call. */
const SUBMIT_TOOLS = {
  "lz-submit-plan": { idKey: "requestID" },
  "lz-submit-task": { idKey: "idempotencyKey" },
} as const
type SubmitTool = keyof typeof SUBMIT_TOOLS

/** OpenCode's Code Mode tool: its input is a program, and tool names appear only inside it. */
const CODE_MODE_TOOL = "execute"

const HELD_KINDS = new Set(["architect-handoff", "queue-review", "retained-verification-failed"])

/**
 * What a failed call looks like once it is plain text. Direct tool errors arrive as `error`
 * results and are skipped already; a Code Mode program that fails still arrives as a completed
 * text result whose text is the error message (`formatResult` in OpenCode's `codemode/tool.ts`),
 * with no marker. These are the shapes visible from here: a JavaScript error name, a parse
 * failure, LAZERS' usage-text error (`explainInvalidInput`), and the `UPPER_SNAKE:` hold codes
 * LAZERS tools refuse with. Such a result never stands in as the newer read.
 */
const FAILED_TEXT =
  /^\s*(?:(?:Uncaught\s+)?(?:[A-Z][A-Za-z]*)?Error\b|ParseError\b|[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+:)|do not match its input:|^\s*Tool (?:execution )?(?:failed|error)\b/
const failedText = (text: string) => FAILED_TEXT.test(text)

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

type Unit = {
  /** Position in the request; the earliest copy of a runbook is the one kept. */
  order: number
  /** What the unit replaces, searched for runbook text. */
  text: string
  keep: boolean
  commit: () => void
}

/** Index one past the horizon message and the id-less tool messages that answer it; 0 when none. */
function windowEnd(messages: readonly ContextMessage[], horizon: string | undefined): number {
  if (horizon === undefined) return 0
  const at = messages.findIndex((message) => message.id === horizon)
  if (at < 0) return 0
  let end = at + 1
  while (end < messages.length && messages[end]!.role === "tool" && messages[end]!.id === undefined)
    end++
  return end
}

const position = (message: number, part: number, chunk = 0) =>
  (message * 4096 + part) * 4096 + chunk

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (typeof value === "object" && value !== null)
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "null"
}

const isPart = (value: unknown): value is Part => typeof value === "object" && value !== null

/** Tool paths a Code Mode program calls (`tools.ns["name"]`), or "*" for any use of `tools` it cannot read. */
function codeTools(code: string): { names: Set<string>; fetches: boolean } {
  const names = new Set<string>()
  const segment = /\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*(["'`])([^"'`\\]*)\2\s*\])/y
  for (const use of code.matchAll(/\btools\b/g)) {
    let at = use.index + "tools".length
    let last: string | undefined
    for (;;) {
      segment.lastIndex = at
      const found = segment.exec(code)
      if (!found) break
      last = found[1] ?? found[3]
      at = segment.lastIndex
    }
    names.add(last ?? "*")
  }
  return { names, fetches: /\bfetch\s*\(/.test(code) }
}

type Call =
  | { kind: "read"; tool: string; key: string; code: boolean; input: unknown }
  | { kind: "submit"; tool: SubmitTool; code: boolean }

/** What a tool-call part is, when it is one of the tools whose input or result this module handles. */
function classify(name: string, input: unknown): Call | undefined {
  if (name === CODE_MODE_TOOL) {
    const code = isPart(input) && typeof input.code === "string" ? input.code : undefined
    if (code === undefined) return undefined
    const { names, fetches } = codeTools(code)
    if (fetches || names.size !== 1) return undefined
    const tool = [...names][0]!
    if (tool in SUBMIT_TOOLS) return { kind: "submit", tool: tool as SubmitTool, code: true }
    if (!READ_TOOLS.has(tool)) return undefined
    const ids = [...new Set((code.match(UUID) ?? []).map((id) => id.toLowerCase()))].toSorted()
    const shape = code.replace(UUID, "<id>").replace(/\s+/g, " ").trim()
    return {
      kind: "read",
      tool,
      key: `code:${tool}:${ids.join(",")}:${shape}`,
      code: true,
      input,
    }
  }
  if (name in SUBMIT_TOOLS) return { kind: "submit", tool: name as SubmitTool, code: false }
  if (READ_TOOLS.has(name))
    return { kind: "read", tool: name, key: `${name}:${canonical(input)}`, code: false, input }
  return undefined
}

/** A successful tool result's text; undefined for errors, files and anything that is not one string. */
function resultText(part: Part): string | undefined {
  if (part.providerExecuted === true) return undefined
  const result = part.result
  if (!isPart(result) || result.type !== "text" || typeof result.value !== "string")
    return undefined
  return result.value
}

/** The receipt a submit tool returned on success, from the result text or a Code Mode program's output. */
function submitReceipt(
  tool: SubmitTool,
  text: string,
): { reference: string; readBack: string } | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (Array.isArray(value) && value.length === 1) value = value[0]
  if (!isPart(value) || (value.status !== "submitted" && value.status !== "replayed"))
    return undefined
  if (tool === "lz-submit-plan" && typeof value.planID === "string") {
    const version = typeof value.version === "number" ? ` v${value.version}` : ""
    return {
      reference: `plan ${value.planID}${version}`,
      readBack: `lz-inspect-plan ${JSON.stringify({ planID: value.planID })}`,
    }
  }
  if (tool === "lz-submit-task" && typeof value.taskID === "string") {
    const reference = typeof value.reference === "string" ? `${value.reference} ` : ""
    return {
      reference: `task ${reference}(${value.taskID})`,
      readBack: `lz-get-task ${JSON.stringify({ taskID: value.taskID })}`,
    }
  }
  return undefined
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()

function noticeStub(marker: NoticeMarker): string {
  const inspect = `lz-inspect-plan ${JSON.stringify({ planID: marker.plan })}`
  if (marker.kind === "recovery-bundle")
    return `[lz-stub notice recovery-bundle${marker.gen !== undefined ? ` gen=${marker.gen}` : ""}, superseded by a newer bundle that lists the backlog: ${inspect}]`
  const version = marker.v !== undefined ? ` v${marker.v}` : ""
  const task = marker.task ? `, ${`lz-get-task ${JSON.stringify({ taskID: marker.task })}`}` : ""
  return `[lz-stub notice ${marker.kind}${version}, superseded by a newer one: ${inspect}${task}]`
}

type Chunk = { text: string; replacement?: string }
type Notice = { marker: NoticeMarker; chunk: Chunk; order: number; part: TextPart }
type TextPart = { message: number; part: number; chunks: Chunk[] }

/**
 * Replace superseded notices and tool results of one request with stubs. Pure; see the module
 * comment for the rules. Returns the same array when nothing was stubbed.
 */
export function stubSuperseded<M extends ContextMessage>(
  messages: readonly M[],
  facts: StubFacts,
): StubResult<M> {
  const end = windowEnd(messages, facts.horizon)
  const unchanged: StubResult<M> = { messages: messages as M[], stubbed: 0, saved: 0 }
  if (end === 0) return unchanged

  const units: Unit[] = []
  /** Text of the window outside any unit, and each unit's text, for runbook presence. */
  const held: Array<{ text: string; unit?: Unit }> = []
  const contentEdits = new Map<number, Map<number, unknown>>()
  const edit = (message: number, part: number, value: unknown) => {
    let parts = contentEdits.get(message)
    if (!parts) contentEdits.set(message, (parts = new Map()))
    parts.set(part, value)
  }

  // Notices -----------------------------------------------------------------------------------
  const notices: Notice[] = []
  const textParts: TextPart[] = []
  for (let i = 0; i < end; i++) {
    const message = messages[i]!
    const parts: Array<{ index: number; text: string }> =
      typeof message.content === "string"
        ? [{ index: 0, text: message.content }]
        : Array.isArray(message.content)
          ? message.content.flatMap((part: unknown, index: number) =>
              isPart(part) && part.type === "text" && typeof part.text === "string"
                ? [{ index, text: part.text }]
                : [],
            )
          : []
    for (const { index, text } of parts) {
      if (message.role !== "user" || !text.includes("[lz-notice ")) {
        held.push({ text })
        continue
      }
      const part: TextPart = { message: i, part: index, chunks: [] }
      text.split(/\n\n(?=--- plan )/).forEach((chunkText, k) => {
        const chunk: Chunk = { text: chunkText }
        part.chunks.push(chunk)
        const lines = chunkText.split("\n").filter((line) => line.startsWith("[lz-notice "))
        const marker = lines.length === 1 ? parseNoticeMarker(lines[0]!) : undefined
        if (marker) notices.push({ marker, chunk, order: position(i, index, k), part })
        else held.push({ text: chunkText })
      })
      textParts.push(part)
    }
  }

  // Newest to oldest: what a later notice already covers.
  const laterState = new Set<string>()
  const laterTask = new Set<string>()
  const laterClosing = new Set<string>()
  let laterBundle = false
  for (const notice of notices.toSorted((a, b) => b.order - a.order)) {
    const { kind, plan, task } = notice.marker
    const family = HELD_KINDS.has(kind)
      ? "held"
      : kind === "recovery-bundle"
        ? "bundle"
        : kind === "task-accepted"
          ? "task"
          : "state"
    const superseded =
      family === "state"
        ? laterState.has(plan)
        : family === "task"
          ? laterTask.has(`${plan}\u0000${task ?? ""}`) || laterClosing.has(plan)
          : family === "bundle"
            ? laterBundle
            : false
    const stub = noticeStub(notice.marker)
    if (superseded && stub.length < notice.chunk.text.length) {
      const unit: Unit = {
        order: notice.order,
        text: notice.chunk.text,
        keep: false,
        commit: () => {
          notice.chunk.replacement = stub
        },
      }
      units.push(unit)
      held.push({ text: notice.chunk.text, unit })
    } else held.push({ text: notice.chunk.text })
    if (family === "state" || family === "task") laterState.add(plan)
    if (family === "task") laterTask.add(`${plan}\u0000${task ?? ""}`)
    if (kind === "accepted" || kind === "integrated") laterClosing.add(plan)
    if (family === "bundle") laterBundle = true
  }

  // Tool calls and results ---------------------------------------------------------------------
  const calls = new Map<string, { message: number; part: number; sent: Part; call: Call }>()
  const results: Array<{ message: number; part: number; part_: Part }> = []
  for (let i = 0; i < end; i++) {
    const message = messages[i]!
    if (!Array.isArray(message.content)) continue
    message.content.forEach((part: unknown, index: number) => {
      if (!isPart(part)) return
      if (
        part.type === "tool-call" &&
        typeof part.id === "string" &&
        typeof part.name === "string"
      ) {
        const call = part.providerExecuted === true ? undefined : classify(part.name, part.input)
        if (call) calls.set(part.id, { message: i, part: index, sent: part, call })
      } else if (part.type === "tool-result") {
        results.push({ message: i, part: index, part_: part })
      }
    })
  }

  const seenReads = new Set<string>()
  for (const found of results.toReversed()) {
    const { message: mi, part: pi, part_: result } = found
    const text = resultText(result)
    const entry = typeof result.id === "string" ? calls.get(result.id) : undefined
    if (text === undefined || !entry) {
      if (text !== undefined) held.push({ text })
      continue
    }
    const { call } = entry
    if (call.kind === "read") {
      if (failedText(text)) {
        held.push({ text })
        continue
      }
      const superseded = seenReads.has(call.key)
      seenReads.add(call.key)
      const input = canonical(call.input)
      const stub = call.code
        ? `[lz-stub earlier result of the ${call.tool} call above, superseded by a newer read: run it again]`
        : `[lz-stub earlier ${call.tool} result, superseded by a newer read: ${call.tool} ${input}]`
      if (superseded && stub.length < text.length) {
        const unit: Unit = {
          order: position(mi, pi),
          text,
          keep: false,
          commit: () =>
            edit(mi, pi, { ...result, result: { ...(result.result as Part), value: stub } }),
        }
        units.push(unit)
        held.push({ text, unit })
      } else held.push({ text })
      continue
    }
    // A successful submission: the input is stored, and the result names the reference.
    held.push({ text })
    if (!facts.inputs) continue
    const receipt = submitReceipt(call.tool, text)
    if (!receipt) continue
    const sent = entry.sent
    const stubNote = oneLine(
      `${call.tool} input elided: stored as ${receipt.reference}; read it back with ${receipt.readBack}`,
    )
    const original = canonical(sent.input)
    let stubInput: unknown
    if (call.code) stubInput = { ...(sent.input as Part), code: `// [lz-stub] ${stubNote}` }
    else {
      const id = (sent.input as Part | undefined)?.[SUBMIT_TOOLS[call.tool].idKey]
      stubInput = {
        ...(typeof id === "string" ? { [SUBMIT_TOOLS[call.tool].idKey]: id } : {}),
        "lz-stub": stubNote,
      }
    }
    if (canonical(stubInput).length < original.length) {
      const unit: Unit = {
        order: position(entry.message, entry.part),
        text: original,
        keep: false,
        commit: () => edit(entry.message, entry.part, { ...sent, input: stubInput }),
      }
      units.push(unit)
    }
  }

  // Runbooks: the first copy stays whole while it is the only whole copy in the window ----------
  const topics =
    facts.runbooks ?? Object.fromEntries(Object.entries(runbooks).map(([k, v]) => [k, v.trim()]))
  for (const topicText of Object.values(topics)) {
    if (!topicText) continue
    const carrying = units.filter((unit) => !unit.keep && unit.text.includes(topicText))
    if (!carrying.length) continue
    const whole = held.some(
      (entry) => (!entry.unit || entry.unit.keep) && entry.text.includes(topicText),
    )
    if (whole) continue
    carrying.reduce((first, unit) => (unit.order < first.order ? unit : first)).keep = true
  }

  // Apply -----------------------------------------------------------------------------------
  let stubbed = 0
  let saved = 0
  for (const unit of units) {
    if (unit.keep) continue
    unit.commit()
    stubbed++
  }
  if (!stubbed) return unchanged
  for (const part of textParts) {
    if (!part.chunks.some((chunk) => chunk.replacement !== undefined)) continue
    const text = part.chunks.map((chunk) => chunk.replacement ?? chunk.text).join("\n\n")
    const original = messages[part.message]!.content
    edit(
      part.message,
      part.part,
      typeof original === "string" ? text : { ...(original as Part[])[part.part]!, text },
    )
  }
  const out = messages.map((message, i) => {
    const parts = contentEdits.get(i)
    if (!parts) return message
    const content =
      typeof message.content === "string"
        ? (parts.get(0) as string)
        : (message.content as unknown[]).map((part, index) =>
            parts.has(index) ? parts.get(index) : part,
          )
    // Keep the class of a schema-built message; `Object.assign` copies its own fields.
    const clone = Object.assign(Object.create(Object.getPrototypeOf(message)), message, {
      content,
    }) as M
    saved += size(message.content) - size(content)
    return clone
  })
  return { messages: out, stubbed, saved }
}

const size = (content: unknown): number =>
  typeof content === "string" ? content.length : JSON.stringify(content).length
