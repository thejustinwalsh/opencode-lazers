export interface WindowsProcessIdentity {
  pid: number
  startedAt: number
}

export interface WindowsProcessRecord extends WindowsProcessIdentity {
  parentPid: number
}

export interface WindowsProcessOwnership {
  pid: number
  identity: Promise<WindowsProcessIdentity | undefined>
  exitedAt?: number
}

export type WindowsProcessTermination =
  "terminated" | "already-exited" | "identity-mismatch" | "uncertain"

export interface WindowsProcessTreeOperations {
  listProcesses(): Promise<WindowsProcessRecord[]>
  terminateProcess(identity: WindowsProcessIdentity): Promise<WindowsProcessTermination>
}

const POWERSHELL = ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]
const PROCESS_QUERY_TIMEOUT_MS = 5_000
const PROCESS_TERMINATION_TIMEOUT_MS = 7_000
const PROCESS_TREE_TERMINATION_ROUNDS = 3

const listScript = [
  "$processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | ForEach-Object {",
  "  [pscustomobject]@{",
  "    pid = [uint32]$_.ProcessId",
  "    parentPid = [uint32]$_.ParentProcessId",
  "    startedAt = [long]([DateTimeOffset]$_.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()",
  "  }",
  "})",
  "ConvertTo-Json -InputObject $processes -Compress",
].join("\n")

async function powershell(script: string, timeout: number): Promise<string> {
  const child = Bun.spawn([...POWERSHELL, script], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    timeout,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0)
    throw new Error(`Windows process operation failed: ${(stderr || stdout).trim()}`)
  return stdout.trim()
}

async function listWindowsProcesses(): Promise<WindowsProcessRecord[]> {
  const output = await powershell(listScript, PROCESS_QUERY_TIMEOUT_MS)
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch (error) {
    throw new Error(`Windows process observation returned invalid JSON: ${output}`, {
      cause: error,
    })
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed]
  return entries.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null)
      throw new Error("Windows process observation returned an invalid entry")
    const { pid, parentPid, startedAt } = entry as Record<string, unknown>
    if (
      typeof pid !== "number" ||
      typeof parentPid !== "number" ||
      typeof startedAt !== "number" ||
      !Number.isSafeInteger(pid) ||
      !Number.isSafeInteger(parentPid) ||
      !Number.isSafeInteger(startedAt)
    )
      throw new Error("Windows process observation returned an invalid identity")
    return { pid, parentPid, startedAt }
  })
}

async function terminateWindowsProcess(
  identity: WindowsProcessIdentity,
): Promise<WindowsProcessTermination> {
  const script = [
    `$targetID = [int]${identity.pid}`,
    `$expectedStart = [long]${identity.startedAt}`,
    "$target = $null",
    "try { $target = [System.Diagnostics.Process]::GetProcessById($targetID) }",
    "catch [System.ArgumentException] { ConvertTo-Json -Compress @{ result = 'already-exited' }; exit 0 }",
    "try {",
    "  $actualStart = ([DateTimeOffset]$target.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()",
    "  if ($actualStart -ne $expectedStart) { ConvertTo-Json -Compress @{ result = 'identity-mismatch' }; exit 0 }",
    "  $target.Kill()",
    "  if (-not $target.WaitForExit(5000)) { ConvertTo-Json -Compress @{ result = 'uncertain' }; exit 0 }",
    "  ConvertTo-Json -Compress @{ result = 'terminated' }",
    "} catch {",
    "  ConvertTo-Json -Compress @{ result = 'uncertain'; message = $_.Exception.Message }",
    "  exit 0",
    "} finally {",
    "  if ($target) { $target.Dispose() }",
    "}",
  ].join("\n")
  const output = await powershell(script, PROCESS_TERMINATION_TIMEOUT_MS)
  let result: unknown
  try {
    result = JSON.parse(output)
  } catch (error) {
    throw new Error(`Windows process termination returned invalid JSON: ${output}`, {
      cause: error,
    })
  }
  if (
    typeof result !== "object" ||
    result === null ||
    !("result" in result) ||
    !["terminated", "already-exited", "identity-mismatch", "uncertain"].includes(
      String(result.result),
    )
  )
    throw new Error(`Windows process termination returned an invalid result: ${output}`)
  return result.result as WindowsProcessTermination
}

const nativeWindowsProcessTreeOperations: WindowsProcessTreeOperations = {
  listProcesses: listWindowsProcesses,
  terminateProcess: terminateWindowsProcess,
}

interface ProcessTreeKnowledge {
  known: Map<number, WindowsProcessIdentity>
  exitedAt: Map<number, number>
}

const processTreeKnowledge = new WeakMap<WindowsProcessOwnership, ProcessTreeKnowledge>()

function observeWindowsProcessIdentity(pid: number): Promise<WindowsProcessIdentity | undefined> {
  return listWindowsProcesses().then((processes) => {
    const process = processes.find((entry) => entry.pid === pid)
    return process ? { pid, startedAt: process.startedAt } : undefined
  })
}

export function createWindowsProcessOwnership(
  pid: number,
  identity: Promise<WindowsProcessIdentity | undefined> = observeWindowsProcessIdentity(pid),
): WindowsProcessOwnership {
  void identity.catch(() => undefined)
  return { pid, identity }
}

function knowledgeFor(
  ownership: WindowsProcessOwnership,
  root: WindowsProcessIdentity,
): ProcessTreeKnowledge {
  let knowledge = processTreeKnowledge.get(ownership)
  if (!knowledge) {
    knowledge = {
      known: new Map([[root.pid, root]]),
      exitedAt: new Map(),
    }
    processTreeKnowledge.set(ownership, knowledge)
  }
  return knowledge
}

function validateRootObservation(
  root: WindowsProcessIdentity,
  processes: readonly WindowsProcessRecord[],
  rootExitedAt: number | undefined,
): WindowsProcessRecord | undefined {
  const currentRoot = processes.find((entry) => entry.pid === root.pid)
  if (currentRoot && currentRoot.startedAt !== root.startedAt)
    throw new Error(`Windows root PID ${root.pid} no longer has its observed identity`)
  if (!currentRoot && rootExitedAt === undefined)
    throw new Error(`Windows root PID ${root.pid} exited without an observed exit time`)
  return currentRoot
}

function isOwnedChild(
  process: WindowsProcessRecord,
  parent: WindowsProcessIdentity,
  byPID: ReadonlyMap<number, WindowsProcessRecord>,
  root: WindowsProcessIdentity,
  rootExitedAt: number | undefined,
  descendantExitTimes: ReadonlyMap<number, number>,
): boolean {
  if (process.startedAt < parent.startedAt) return false
  const currentParent = byPID.get(parent.pid)
  if (currentParent) return currentParent.startedAt === parent.startedAt
  const parentExitedAt =
    parent.pid === root.pid ? rootExitedAt : descendantExitTimes.get(parent.pid)
  return parentExitedAt !== undefined && process.startedAt <= parentExitedAt
}

function knownOwnedIdentity(
  process: WindowsProcessRecord,
  root: WindowsProcessIdentity,
  rootExitedAt: number | undefined,
  byPID: ReadonlyMap<number, WindowsProcessRecord>,
  known: Map<number, WindowsProcessIdentity>,
  descendantExitTimes: ReadonlyMap<number, number>,
): WindowsProcessIdentity | undefined {
  const parent = known.get(process.parentPid)
  if (!parent || !isOwnedChild(process, parent, byPID, root, rootExitedAt, descendantExitTimes))
    return undefined
  const existing = known.get(process.pid)
  if (existing && existing.startedAt !== process.startedAt) return undefined
  const identity = existing ?? { pid: process.pid, startedAt: process.startedAt }
  if (!existing) known.set(process.pid, identity)
  return identity
}

function discoverSnapshotDescendants(
  processes: readonly WindowsProcessRecord[],
  root: WindowsProcessIdentity,
  rootExitedAt: number | undefined,
  known: Map<number, WindowsProcessIdentity>,
  descendantExitTimes: ReadonlyMap<number, number>,
  descendants: Map<number, WindowsProcessIdentity>,
): boolean {
  const byPID = new Map(processes.map((entry) => [entry.pid, entry]))
  let added = false
  for (const process of processes) {
    if (process.pid === root.pid) continue
    const alreadyKnown = known.has(process.pid)
    const identity = knownOwnedIdentity(
      process,
      root,
      rootExitedAt,
      byPID,
      known,
      descendantExitTimes,
    )
    if (!identity) continue
    descendants.set(process.pid, identity)
    if (!alreadyKnown) added = true
  }
  return added
}

function recordExitedDescendants(
  root: WindowsProcessIdentity,
  processes: readonly WindowsProcessRecord[],
  known: ReadonlyMap<number, WindowsProcessIdentity>,
  descendantExitTimes: Map<number, number>,
): void {
  const byPID = new Map(processes.map((entry) => [entry.pid, entry]))
  for (const identity of known.values()) {
    if (identity.pid === root.pid) continue
    const current = byPID.get(identity.pid)
    if (current && current.startedAt !== identity.startedAt)
      throw new Error(`Windows descendant PID ${identity.pid} no longer has its observed identity`)
    if (!current && !descendantExitTimes.has(identity.pid))
      descendantExitTimes.set(identity.pid, Date.now())
  }
}

function descendantsOf(
  root: WindowsProcessIdentity,
  processes: readonly WindowsProcessRecord[],
  rootExitedAt: number | undefined,
  known: Map<number, WindowsProcessIdentity>,
  descendantExitTimes: Map<number, number>,
): WindowsProcessIdentity[] {
  validateRootObservation(root, processes, rootExitedAt)
  recordExitedDescendants(root, processes, known, descendantExitTimes)
  const descendants = new Map<number, WindowsProcessIdentity>()
  let added: boolean
  do {
    added = discoverSnapshotDescendants(
      processes,
      root,
      rootExitedAt,
      known,
      descendantExitTimes,
      descendants,
    )
  } while (added)
  return [...descendants.values()]
}

async function ownedRootIdentity(
  ownership: WindowsProcessOwnership,
): Promise<WindowsProcessIdentity> {
  const root = await ownership.identity
  if (!root || root.pid !== ownership.pid)
    throw new Error(`Windows root PID ${ownership.pid} identity could not be observed`)
  return root
}

export async function hasWindowsProcessDescendants(
  ownership: WindowsProcessOwnership,
  operations: WindowsProcessTreeOperations = nativeWindowsProcessTreeOperations,
): Promise<boolean> {
  const root = await ownedRootIdentity(ownership)
  const processes = await operations.listProcesses()
  const knowledge = knowledgeFor(ownership, root)
  return (
    descendantsOf(root, processes, ownership.exitedAt, knowledge.known, knowledge.exitedAt).length >
    0
  )
}

async function terminateOwnedProcess(
  identity: WindowsProcessIdentity,
  subject: "root" | "descendant",
  operations: WindowsProcessTreeOperations,
): Promise<void> {
  const result = await operations.terminateProcess(identity)
  if (result === "identity-mismatch")
    throw new Error(`Windows ${subject} PID ${identity.pid} identity changed before termination`)
  if (result === "uncertain")
    throw new Error(`Windows ${subject} PID ${identity.pid} termination could not be confirmed`)
}

async function terminateRoot(
  ownership: WindowsProcessOwnership,
  root: WindowsProcessIdentity,
  observedRoot: WindowsProcessRecord | undefined,
  operations: WindowsProcessTreeOperations,
): Promise<number> {
  if (observedRoot) {
    await terminateOwnedProcess(root, "root", operations)
    ownership.exitedAt ??= Date.now()
    return ownership.exitedAt
  }
  if (ownership.exitedAt === undefined)
    throw new Error(`Windows root PID ${root.pid} exited without an observed exit time`)
  return ownership.exitedAt
}

function orderedTargets(
  pending: readonly WindowsProcessIdentity[],
  discovered: readonly WindowsProcessIdentity[],
): WindowsProcessIdentity[] {
  const targets = new Map([...pending, ...discovered].map((entry) => [entry.pid, entry]))
  return [...targets.values()].sort((left, right) => right.startedAt - left.startedAt)
}

async function terminateDescendantRound(
  root: WindowsProcessIdentity,
  exitedAt: number,
  known: Map<number, WindowsProcessIdentity>,
  descendantExitTimes: Map<number, number>,
  pending: WindowsProcessIdentity[],
  operations: WindowsProcessTreeOperations,
): Promise<{ rootAlive: boolean; pending: WindowsProcessIdentity[] }> {
  const currentProcesses = await operations.listProcesses()
  const discovered = descendantsOf(root, currentProcesses, exitedAt, known, descendantExitTimes)
  for (const target of orderedTargets(pending, discovered))
    await terminateOwnedProcess(target, "descendant", operations)

  const remainingProcesses = await operations.listProcesses()
  const remainingRoot = validateRootObservation(root, remainingProcesses, exitedAt)
  const remaining = descendantsOf(root, remainingProcesses, exitedAt, known, descendantExitTimes)
  return { rootAlive: remainingRoot !== undefined, pending: remaining }
}

export async function terminateWindowsProcessTree(
  ownership: WindowsProcessOwnership,
  operations: WindowsProcessTreeOperations = nativeWindowsProcessTreeOperations,
): Promise<void> {
  const root = await ownedRootIdentity(ownership)
  const knowledge = knowledgeFor(ownership, root)
  const initialProcesses = await operations.listProcesses()
  const initialRoot = validateRootObservation(root, initialProcesses, ownership.exitedAt)
  let pending = descendantsOf(
    root,
    initialProcesses,
    ownership.exitedAt,
    knowledge.known,
    knowledge.exitedAt,
  )
  const exitedAt = await terminateRoot(ownership, root, initialRoot, operations)

  for (let round = 0; round < PROCESS_TREE_TERMINATION_ROUNDS; round++) {
    const result = await terminateDescendantRound(
      root,
      exitedAt,
      knowledge.known,
      knowledge.exitedAt,
      pending,
      operations,
    )
    pending = result.pending
    if (!result.rootAlive && pending.length === 0) return
  }

  throw new Error("Windows process-tree termination could not be confirmed")
}
