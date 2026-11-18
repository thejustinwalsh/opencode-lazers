import type { LiveRadarResponse } from "../observability/contract.ts"
import {
  scopedWorkload,
  callSummary,
  formatAge,
  sessionCallLines,
  sessionGroups,
  sessionRole,
  sessionState,
} from "./monitor-model.ts"
import type { ActivityLine, LiveSession } from "./monitor-model.ts"

/**
 * The Flow overview: which session is doing what, and where its work went. Everything derives
 * from calls and model requests the live read observed; a destination nobody used in the window
 * is not listed and a figure the read does not carry is omitted.
 */
export const FLOW_WINDOW_MS = 120_000
export const FEED_CAP = 150

type Live = LiveRadarResponse

export type DestKind = "model" | "local" | "service" | "you"
export const DEST_GROUPS = [
  { kind: "model", label: "MODELS" },
  { kind: "local", label: "LOCAL MACHINE" },
  { kind: "service", label: "TOOLS & SERVICES" },
  { kind: "you", label: "TOOLS & SERVICES" },
] as const

export type FlowSession = {
  sessionID: string
  depth: number
  /** The session this one nests under, for the guide link. */
  parent: string | null
  role: string
  /** `LZ-99`, absent for the Architect. */
  ref: string
  /** The task title for a worker, or the session title: shown after the role when there is room. */
  title: string
  tone: "run" | "idle"
  /** What it is doing now: `▸ bash: src/x.ts`, `idle 29m`; null when nothing is known. */
  doing: string | null
  doingFailed: boolean
  waiting: boolean
}

export type FlowDestination = { id: string; name: string; kind: DestKind; count: number }

export type FlowEdge = {
  sessionID: string
  destID: string
  count: number
  running: boolean
  heat: number
  width: number
  opacity: number
}

export type FeedRow = {
  id: string
  at: number
  live: boolean
  sessionID: string
  ref: string
  role: string
  destID: string
  destName: string
  kind: DestKind
  detail: string
  failed: boolean
}

export type ModelCard = {
  id: string
  name: string
  effort: string | null
  calls: number
  active: boolean
  lastAt: number | null
  /** Tokens measured on finished steps in the window; null when no step carried them. */
  inputTokens: number | null
  outputTokens: number | null
  /** Tokens per minute over the window, when tokens were measured. */
  rate: number | null
  /** Calls per session in the window: the stacked bar. */
  shares: Array<{ sessionID: string; ref: string; calls: number }>
}

export type FlowModel = {
  sessions: FlowSession[]
  destinations: FlowDestination[]
  edges: FlowEdge[]
  feed: FeedRow[]
  models: ModelCard[]
  running: number
  flows: number
  quiet: boolean
}

export type FlowSelection = { kind: "session" | "destination"; id: string } | null

type Raw = {
  id: string
  at: number
  live: boolean
  sessionID: string
  dest: { id: string; name: string; kind: DestKind }
  detail: string
  failed: boolean
}

const FILES = /^(read|view|cat|edit|write|patch|apply[-_ ]?patch|multiedit)$/i
const SHELL = /^(bash|shell|exec|run|command|sh|zsh)$/i
const SEARCH = /^(grep|glob|search|find|list|ls|websearch|webfetch|web|fetch|browse)/i
const GIT = /git|worktree/i
const ASK = /^(question|ask|permission|ask[-_ ]?user)/i

/** The destination a tool call went to, or the generic tools destination. */
export function toolDestination(tool: string, verifying: boolean, hasFileTargets: boolean) {
  // Code mode: the Architect's `execute` runs LAZERS project tools, named `lz-*`.
  if (/^execute$/i.test(tool) || /^lz-/i.test(tool))
    return { id: "lazers", name: "LAZERS tools", kind: "service" as const }
  if (ASK.test(tool)) return { id: "you", name: "You", kind: "you" as const }
  if (/^(check|verify)/i.test(tool) || (verifying && SHELL.test(tool)))
    return { id: "checks", name: "Checks", kind: "service" as const }
  if (GIT.test(tool)) return { id: "git", name: "Git · worktrees", kind: "local" as const }
  if (FILES.test(tool) || hasFileTargets)
    return { id: "files", name: "Files", kind: "local" as const }
  if (SHELL.test(tool)) return { id: "shell", name: "Shell", kind: "local" as const }
  if (SEARCH.test(tool)) return { id: "search", name: "Search", kind: "service" as const }
  return { id: "tools", name: "Other tools", kind: "service" as const }
}

function callDetail(line: ActivityLine) {
  if (line.status === "failed" && line.error) return line.error
  const summary = callSummary(line)
  // A command reads as itself; a file or pattern reads with its tool.
  if (summary && (SHELL.test(line.tool) || /^(check|verify)/i.test(line.tool))) return summary
  return `${line.tool.toLowerCase()}${summary ? ` ${summary}` : ""}`
}

const compact = (value: number) =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
    : value >= 1000
      ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`
      : String(value)
export { compact as compactCount }

/** `heat` is 1 while a call runs, then decays linearly to 0 over the window since the last event. */
export function edgeHeat(running: boolean, lastAt: number, now: number) {
  if (running) return 1
  return Math.max(0, 1 - (now - lastAt) / FLOW_WINDOW_MS)
}
export const edgeWidth = (count: number) => 0.9 + Math.min(count, 9) * 0.28
export const edgeOpacity = (heat: number) => 0.18 + heat * 0.62

export function abbreviateRole(role: string) {
  return role.length > 5 && role !== "Architect" ? `${role.slice(0, 4)}.` : role
}

export function createFlowModel(
  live: Live,
  now: number,
  /** Sessions the shared idle filter lists; absent lists every available session. */
  visible?: ReadonlySet<string>,
): FlowModel {
  const groups = sessionGroups(live, visible)
  const byID = new Map(live.sessions.map((session) => [session.sessionID, session]))
  const routeByID = new Map(live.routes.map((route) => [route.id, route]))
  const order: Array<{ session: LiveSession; depth: number }> = []
  const visit = (id: string, depth: number) => {
    const session = byID.get(id)
    if (!session) return
    order.push({ session, depth })
    for (const child of groups.children.get(id) ?? []) visit(child, Math.min(depth + 1, 2))
  }
  for (const id of groups.leading) visit(id, 0)

  const raw: Raw[] = []
  const doing = new Map<string, { text: string; failed: boolean; waiting: boolean }>()
  const verifying = (session: LiveSession) => session.assignment?.state === "verifying"
  const inWindow = (at: number) => now - at <= FLOW_WINDOW_MS
  for (const { session } of order) {
    const calls = sessionCallLines(live, session.sessionID)
    for (const line of calls) {
      const at = line.current ? (line.startedAt ?? now) : (line.endedAt ?? line.startedAt)
      if (at === null || (!line.current && !inWindow(at))) continue
      const dest = toolDestination(line.tool, verifying(session), line.target !== null)
      raw.push({
        id: line.id,
        at,
        live: line.current,
        sessionID: session.sessionID,
        dest,
        detail: callDetail(line),
        failed: line.status === "failed",
      })
    }
    const running = calls
      .filter((line) => line.current)
      .toSorted((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0]
    const last = calls
      .filter((line) => !line.current && line.endedAt !== null)
      .toSorted((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0]
    if (running) {
      const dest = toolDestination(running.tool, verifying(session), running.target !== null)
      doing.set(
        session.sessionID,
        dest.kind === "you"
          ? { text: `waiting for you · ${callDetail(running)}`, failed: false, waiting: true }
          : {
              text: `▸ ${running.tool.toLowerCase()}${callSummary(running) ? `: ${callSummary(running)}` : ""}`,
              failed: false,
              waiting: false,
            },
      )
    } else if (
      last?.status === "failed" &&
      last.error &&
      last.endedAt !== null &&
      inWindow(last.endedAt)
    ) {
      doing.set(session.sessionID, { text: last.error, failed: true, waiting: false })
    }
  }

  // Model requests: one flow per request; the matching response supplies measured tokens.
  const responses = new Map<string, Live["flow"][number]>()
  for (const item of live.flow)
    if (item.kind === "model-response" && item.messageID)
      responses.set(`${item.sessionID}:${item.messageID}`, item)
  const modelEvents: Array<{
    raw: Raw
    routeID: string
    input: number | null
    output: number | null
  }> = []
  for (const item of live.flow) {
    if (item.kind !== "model-request" || !item.routeID) continue
    const route = routeByID.get(item.routeID)
    if (!route) continue
    const response = item.messageID
      ? responses.get(`${item.sessionID}:${item.messageID}`)
      : undefined
    const at = item.startedAt ?? item.observedAt
    const liveNow = !response
    if (!liveNow && !inWindow(response.observedAt)) continue
    if (liveNow && !inWindow(at)) continue
    const input = response?.usage?.input ?? null
    const output = response?.usage?.output ?? null
    const detail = [
      "request",
      input !== null ? `${compact(input)} in` : "",
      output !== null ? `${compact(output)} out` : "",
    ]
      .filter(Boolean)
      .join(" · ")
    const rawEvent: Raw = {
      id: item.id,
      at,
      live: liveNow,
      sessionID: item.sessionID,
      dest: { id: `model:${route.modelID}`, name: route.modelID, kind: "model" },
      detail,
      failed: response?.status === "failed",
    }
    raw.push(rawEvent)
    modelEvents.push({ raw: rawEvent, routeID: route.id, input, output })
  }

  const sessionRef = (session: LiveSession | undefined) => session?.assignment?.taskReference ?? ""
  const feed = raw
    .toSorted((a, b) => Number(b.live) - Number(a.live) || b.at - a.at)
    .slice(0, FEED_CAP)
    .map((event): FeedRow => {
      const session = byID.get(event.sessionID)
      return {
        id: event.id,
        at: event.at,
        live: event.live,
        sessionID: event.sessionID,
        ref: sessionRef(session),
        role: session ? sessionRole(session).label : "",
        destID: event.dest.id,
        destName: event.dest.name,
        kind: event.dest.kind,
        detail: event.detail,
        failed: event.failed,
      }
    })

  const edgeMap = new Map<
    string,
    { sessionID: string; destID: string; count: number; running: boolean; last: number }
  >()
  const destMap = new Map<string, FlowDestination>()
  for (const event of feed) {
    const key = `${event.sessionID}>${event.destID}`
    const edge = edgeMap.get(key) ?? {
      sessionID: event.sessionID,
      destID: event.destID,
      count: 0,
      running: false,
      last: 0,
    }
    edge.count++
    edge.running ||= event.live
    edge.last = Math.max(edge.last, event.at)
    edgeMap.set(key, edge)
    const dest = destMap.get(event.destID) ?? {
      id: event.destID,
      name: event.destName,
      kind: event.kind,
      count: 0,
    }
    dest.count++
    destMap.set(event.destID, dest)
  }
  const groupRank = (kind: DestKind) => (kind === "model" ? 0 : kind === "local" ? 1 : 2)
  const destinations = [...destMap.values()].toSorted(
    (a, b) =>
      groupRank(a.kind) - groupRank(b.kind) || b.count - a.count || a.name.localeCompare(b.name),
  )
  const edges = [...edgeMap.values()].map((edge): FlowEdge => {
    const heat = edgeHeat(edge.running, edge.last, now)
    return {
      sessionID: edge.sessionID,
      destID: edge.destID,
      count: edge.count,
      running: edge.running,
      heat,
      width: edgeWidth(edge.count),
      opacity: edgeOpacity(heat),
    }
  })

  const sessions = order.map(({ session, depth }): FlowSession => {
    const role = sessionRole(session).label
    const note = doing.get(session.sessionID)
    const busy = session.state === "busy" || session.assignment !== null
    const idleAt = session.updatedAt
    const idleText =
      sessionState(session) === "idle" && idleAt !== null
        ? `idle ${formatAge(now - idleAt).replace(" ago", "")}`
        : null
    return {
      sessionID: session.sessionID,
      depth,
      parent: groups.parents.get(session.sessionID) ?? null,
      role,
      ref: session.assignment?.taskReference ?? "",
      title: session.assignment?.taskTitle ?? session.title ?? "",
      tone: busy ? "run" : "idle",
      doing: note?.text ?? idleText ?? (busy ? "running" : null),
      doingFailed: note?.failed ?? false,
      waiting: note?.waiting ?? false,
    }
  })

  // Models: those called in the window, then those only seen earlier in the read.
  const cards = new Map<string, ModelCard>()
  const cardFor = (modelID: string, effort: string | null) =>
    cards.get(modelID) ??
    (cards
      .set(modelID, {
        id: modelID,
        name: modelID,
        effort,
        calls: 0,
        active: false,
        lastAt: null,
        inputTokens: null,
        outputTokens: null,
        rate: null,
        shares: [],
      })
      .get(modelID) as ModelCard)
  for (const route of live.routes) {
    const card = cardFor(route.modelID, route.variant)
    if (route.observedAt !== null) card.lastAt = Math.max(card.lastAt ?? 0, route.observedAt)
  }
  for (const { raw: event, routeID, input, output } of modelEvents) {
    const route = routeByID.get(routeID)!
    const card = cardFor(route.modelID, route.variant)
    card.calls++
    card.active ||= event.live || inWindow(event.at)
    card.lastAt = Math.max(card.lastAt ?? 0, event.at)
    if (input !== null) card.inputTokens = (card.inputTokens ?? 0) + input
    if (output !== null) card.outputTokens = (card.outputTokens ?? 0) + output
    const ref = sessionRef(byID.get(event.sessionID))
    const share = card.shares.find((item) => item.sessionID === event.sessionID)
    if (share) share.calls++
    else card.shares.push({ sessionID: event.sessionID, ref, calls: 1 })
  }
  for (const card of cards.values())
    if (card.inputTokens !== null || card.outputTokens !== null)
      card.rate = Math.round(
        ((card.inputTokens ?? 0) + (card.outputTokens ?? 0)) / (FLOW_WINDOW_MS / 60_000),
      )
  const models = [...cards.values()].toSorted(
    (a, b) => Number(b.active) - Number(a.active) || (b.lastAt ?? 0) - (a.lastAt ?? 0),
  )

  const running = order.filter(
    ({ session }) => session.state === "busy" || session.assignment !== null,
  ).length
  return {
    sessions,
    destinations,
    edges,
    feed,
    models,
    running,
    flows: feed.length,
    quiet: feed.length === 0,
  }
}

/** Selection: the sessions, destinations and edges connected to it; everything else dims. */
export function flowRelated(model: FlowModel, selection: FlowSelection) {
  if (!selection) return undefined
  const edges = model.edges.filter((edge) =>
    selection.kind === "session" ? edge.sessionID === selection.id : edge.destID === selection.id,
  )
  const sessions = new Set(
    selection.kind === "session" ? [selection.id] : edges.map((edge) => edge.sessionID),
  )
  const destinations = new Set(
    selection.kind === "destination" ? [selection.id] : edges.map((edge) => edge.destID),
  )
  return {
    sessions,
    destinations,
    edgeKeys: new Set(edges.map((edge) => `${edge.sessionID}>${edge.destID}`)),
  }
}

export function filterFeed(model: FlowModel, selection: FlowSelection) {
  if (!selection) return model.feed
  return model.feed.filter((row) =>
    selection.kind === "session" ? row.sessionID === selection.id : row.destID === selection.id,
  )
}

/** `live` while running, else `3s`, `24s`, `1m`. */
export function feedWhen(row: FeedRow, now: number) {
  if (row.live) return "live"
  const seconds = Math.max(0, Math.floor((now - row.at) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`
}

export function modelWhen(card: ModelCard, now: number) {
  if (card.lastAt === null) return ""
  const minutes = Math.max(1, Math.round((now - card.lastAt) / 60_000))
  return `${minutes} min ago`
}

/** Sentences for the quiet state; a clause without data is omitted. */
export function quietSentences(live: Live) {
  const architect = live.sessions.find(
    (session) => session.availability === "available" && session.isCurrentArchitect === true,
  )
  const queued = scopedWorkload(live)?.queued ?? 0
  const parts = [
    architect?.state === "idle" ? "Architect is idle" : "",
    queued > 0 ? `${queued} ${queued === 1 ? "task is" : "tasks are"} queued` : "",
  ].filter(Boolean)
  return {
    line: "No session has called a model or a tool in the last two minutes.",
    state: parts.length ? `${parts.join(" · ")}.` : "",
  }
}
