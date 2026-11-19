import type { LabelTone } from "../details/tone.ts"
import { callsText, durationText } from "../details/format.ts"
import type { LiveAttemptResponse } from "../observability/contract.ts"
import type { ExecutionListRow } from "../tasks/execution-list.ts"
import { taskStateView } from "../tasks/task-state.ts"
import type { TaskStateView } from "../tasks/task-state.ts"
import { attemptLane } from "../tasks/stats.ts"
import {
  callSummary,
  clockMinutes,
  formatAge,
  sessionModel,
  sessionRole,
  sessionState,
  sessionTone,
} from "./monitor-model.ts"
import type { ActivityLine, LiveSession } from "./monitor-model.ts"

type Live = Parameters<typeof sessionModel>[0]
export type WorkerAttempt = NonNullable<LiveAttemptResponse["attempt"]>

const terminalNodes = new Set(["accepted", "incorporated", "failed", "exhausted", "cancelled"])

/** The tool name as a person reads it: `read` is Read, `grep` and `glob` are Search. */
export function toolName(tool: string) {
  const name = tool
    .trim()
    .toLowerCase()
    .replace(/^lazers[-_]/, "")
  if (/^(read|view|cat)$/.test(name)) return "Read"
  if (/^(grep|glob|search|find|list|ls)$/.test(name)) return "Search"
  if (/^(edit|multiedit|patch|apply_patch|write)$/.test(name)) return "Edit"
  if (/^(shell|bash|execute|exec|run|command)$/.test(name)) return "Shell"
  if (/^(webfetch|fetch|browse)$/.test(name)) return "Fetch"
  if (/^(task|subagent|agent)$/.test(name)) return "Agent"
  const words = name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .join(" ")
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : "Tool"
}

/**
 * The target cell of a call row, never blank: what the call ran or touched, else where a search
 * or command ran.
 */
export function callTarget(line: ActivityLine) {
  const summary = callSummary(line)
  if (summary) return summary
  const name = toolName(line.tool)
  if (name === "Search") return "repository"
  if (name === "Shell") return "workspace"
  return "—"
}

/** The task row `taskStateView` reads, rebuilt from the attempt read's node and plan state. */
export function attemptTaskRow(
  attempt: WorkerAttempt,
  taskID: string,
): ExecutionListRow | undefined {
  const task = attempt.task
  if (!task) return undefined
  const held =
    task.state === "blocked" || (task.planState === "blocked" && !terminalNodes.has(task.state))
  return {
    taskID,
    title: "",
    status: task.state,
    reason: task.reason,
    waiting: held,
    holdReason: held ? (task.reason ?? task.planReason) : null,
    ordinal: 0,
    contextOnly: false,
    prerequisites: [],
    successors: [],
  }
}

export type WorkerState = {
  word: string
  tone: LabelTone
  /** Set when the session works a task: the shared view the Tasks pane also reads. */
  task?: TaskStateView
}

const sessionTones: Record<ReturnType<typeof sessionTone>, LabelTone> = {
  running: "interactive",
  checking: "interactive",
  idle: "neutral",
  away: "neutral",
}

const capitalize = (text: string) => (text ? `${text[0]!.toUpperCase()}${text.slice(1)}` : text)

/**
 * One state word per session. A worker whose task is read takes the task's word from
 * `taskStateView`, so Radar and Tasks agree (a held task is Waiting, not running); any other
 * session keeps its own recorded state.
 */
export function workerState(session: LiveSession, attempt?: WorkerAttempt | null): WorkerState {
  const assignment = session.assignment
  const row = attempt && assignment ? attemptTaskRow(attempt, assignment.taskID) : undefined
  if (row) {
    const task = taskStateView(row)
    return { word: task.label, tone: task.labelTone, task }
  }
  return {
    word: capitalize(sessionState(session) ?? ""),
    tone: sessionTones[sessionTone(session)],
  }
}

/** `Nov 17 12:58 PM`, or `12:58 PM` for today. */
export function startedText(at: number | null | undefined, now: number) {
  if (at === null || at === undefined || !Number.isFinite(at)) return undefined
  const time = clockMinutes(at)
  if (!time) return undefined
  const start = new Date(at)
  const today = new Date(now)
  if (start.toDateString() === today.toDateString()) return time
  return `${start.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`
}

/** The newest call by start time; a running call outranks a finished one. */
export function lastCall(lines: readonly ActivityLine[]) {
  return lines.toSorted(
    (left, right) =>
      Number(right.current) - Number(left.current) ||
      (right.startedAt ?? 0) - (left.startedAt ?? 0),
  )[0]
}

/** The first rows of Recent calls, newest first. */
export const RECENT_CALLS = 4
export function recentCalls(lines: readonly ActivityLine[]) {
  const ordered = lines.toSorted((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0))
  return { recent: ordered.slice(0, RECENT_CALLS), earlier: ordered.slice(RECENT_CALLS) }
}

/** `idle 1d 19h` once a session with no running call has been quiet for a minute. */
export function idleText(
  lastActivityAt: number | null,
  now: number,
  running: boolean,
  quietMs = 60_000,
) {
  if (running || lastActivityAt === null || now - lastActivityAt < quietMs) return undefined
  return `idle ${formatAge(now - lastActivityAt).replace(" ago", "")}`
}

/**
 * The worker's first-screen stats. Each is real or absent: Started needs the assignment, Runtime
 * an end (now while live, else the last recorded activity), Calls the attempt read, Model a route.
 */
export function workerStats(input: {
  live: Live
  session: LiveSession
  attempt?: WorkerAttempt | null
  now: number
  lastActivityAt: number | null
}): Array<{ label: string; value?: string }> {
  const { session, attempt, now } = input
  const assignment = session.assignment
  const model = sessionModel(input.live, session)
  const modelValue = model?.label ?? undefined
  if (!assignment)
    return [
      {
        label: "Last active",
        ...(input.lastActivityAt !== null ? { value: formatAge(now - input.lastActivityAt) } : {}),
      },
      { label: "Model", ...(modelValue ? { value: modelValue } : {}) },
    ]
  const live = ["preparing", "running", "verifying"].includes(attempt?.state ?? assignment.state)
  // Only a worker whose task is actually working counts up to now; a held or interrupted one
  // stopped at its last activity.
  const working = live && (workerState(session, attempt).task?.tone ?? "running") === "running"
  const end = working ? now : (attempt?.summary.lastActivityAt ?? undefined)
  const started = assignment.startedAt
  return [
    {
      label: "Started",
      ...(startedText(started, now) ? { value: startedText(started, now)! } : {}),
    },
    {
      label: "Runtime",
      ...(end !== undefined && end >= started ? { value: durationText(end - started) } : {}),
    },
    {
      label: "Calls",
      ...(attempt ? { value: callsText(attempt.toolCount, attempt.summary.files) } : {}),
    },
    {
      label: "Model",
      ...(modelValue
        ? { value: modelValue }
        : attempt?.model
          ? {
              value: attempt.model.variant
                ? `${attempt.model.id} · ${attempt.model.variant}`
                : attempt.model.id,
            }
          : {}),
    },
  ]
}

/** The lane input for the attempt, the same projection the Tasks pane draws. */
export function workerLane(attempt: WorkerAttempt | null | undefined, now: number) {
  return attempt ? attemptLane(attempt, now) : undefined
}

export const workerLabel = (session: LiveSession) => sessionRole(session).label
