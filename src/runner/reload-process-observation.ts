import { spawnSync } from "node:child_process"
import { realpathSync } from "node:fs"
import type { Database } from "bun:sqlite"
import { resolve } from "node:path"
import type { ReloadProcessObservation } from "./reload-safety.ts"
import {
  verificationProcessCandidates,
  type VerificationProcessCandidate,
} from "./reload-verification-candidates.ts"

const PROCESS_START_TOLERANCE_MS = 2_000
const PROCESS_LAUNCH_WINDOW_MS = 10_000

type ProcessSnapshot = {
  pid: number
  processGroupID: number
  startedAt: number
  command: string
}

type ProbeResult = {
  status: number | null
  stdout: string
  error?: Error
}

export type ProcessProbeDependencies = {
  list(): ProbeResult
  cwd(pid: number): ProbeResult
}

function errorReason(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 300)
}

function canonicalPath(path: string) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function defaultProcessProbe(): ProcessProbeDependencies {
  const run = (command: string, args: string[]): ProbeResult => {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 5_000 })
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      ...(result.error ? { error: result.error } : {}),
    }
  }
  return {
    list: () => run("/bin/ps", ["-axo", "pid=,ppid=,pgid=,etime=,command="]),
    cwd: (pid) => run("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]),
  }
}

function elapsedMilliseconds(value: string): number | undefined {
  const [dayText, timeText] = value.includes("-") ? value.split("-", 2) : ["0", value]
  const pieces = timeText!.split(":").map(Number)
  if (
    !/^\d+$/.test(dayText!) ||
    pieces.some((piece) => !Number.isSafeInteger(piece) || piece < 0) ||
    (pieces.length !== 2 && pieces.length !== 3)
  )
    return undefined
  const [first, second, third = 0] = pieces
  const hours = pieces.length === 3 ? first! : 0
  const minutes = pieces.length === 3 ? second! : first!
  const seconds = pieces.length === 3 ? third : second!
  if (minutes >= 60 || seconds >= 60 || hours >= 24) return undefined
  return (Number(dayText) * 24 * 60 * 60 + hours * 60 * 60 + minutes * 60 + seconds) * 1_000
}

function parseProcessList(result: ProbeResult, observedAt: number): ProcessSnapshot[] {
  if (result.error) throw new Error(`Process listing failed: ${errorReason(result.error)}`)
  if (result.status !== 0)
    throw new Error(`Process listing exited with ${result.status ?? "unknown"}`)
  const processes: ProcessSnapshot[] = []
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    const match = /^\s*(\d+)\s+\d+\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!match) throw new Error("Process listing returned an unrecognized row")
    const pid = Number(match[1])
    const processGroupID = Number(match[2])
    const elapsed = elapsedMilliseconds(match[3]!)
    if (
      !Number.isSafeInteger(pid) ||
      pid < 1 ||
      !Number.isSafeInteger(processGroupID) ||
      processGroupID < 1 ||
      elapsed === undefined ||
      !match[4]!.trim()
    )
      throw new Error("Process listing returned an invalid process identity")
    processes.push({
      pid,
      processGroupID,
      startedAt: observedAt - elapsed,
      command: match[4]!.trim(),
    })
  }
  return processes
}

function processCwd(result: ProbeResult, pid: number) {
  if (result.error)
    throw new Error(`Could not inspect process ${pid} cwd: ${errorReason(result.error)}`)
  if (result.status !== 0)
    throw new Error(`Could not inspect process ${pid} cwd (exit ${result.status})`)
  const lines = result.stdout.split(/\r?\n/)
  if (!lines.includes(`p${pid}`))
    throw new Error(`Process ${pid} identity changed during cwd inspection`)
  const path = lines.find((line) => line.startsWith("n"))?.slice(1)
  if (!path) throw new Error(`Process ${pid} cwd is unavailable`)
  return canonicalPath(path)
}

function processMatches(
  candidate: VerificationProcessCandidate,
  process: ProcessSnapshot,
): boolean {
  return (
    (!candidate.pid || process.pid === candidate.pid) &&
    process.processGroupID === process.pid &&
    process.startedAt >= candidate.startedAt - PROCESS_START_TOLERANCE_MS &&
    process.startedAt <= candidate.startedAt + PROCESS_LAUNCH_WINDOW_MS &&
    process.command.includes(candidate.command)
  )
}

export async function observeVerificationProcesses(
  db: Database,
  dependencies: ProcessProbeDependencies = defaultProcessProbe(),
): Promise<ReloadProcessObservation> {
  try {
    const candidates = verificationProcessCandidates(db)
    const processes = parseProcessList(dependencies.list(), Date.now())
    const processIDs = new Set<number>()
    for (const process of processes) {
      const matches = candidates.filter((check) => processMatches(check, process))
      if (matches.length === 0) continue
      const cwd = processCwd(dependencies.cwd(process.pid), process.pid)
      if (matches.some((check) => check.workspace === cwd)) processIDs.add(process.pid)
    }
    return { kind: "observed", processIDs: [...processIDs] }
  } catch (error) {
    return { kind: "unavailable", reason: errorReason(error) }
  }
}
