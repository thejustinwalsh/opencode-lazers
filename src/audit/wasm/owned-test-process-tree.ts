import type { OwnedTestProcessChild } from "./owned-test-process.ts"

const PROCESS_TERM_GRACE_MS = 1_000
const PROCESS_KILL_WAIT_MS = 5_000

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined
    if (code === "ESRCH") return false
    if (code === "EPERM") return true
    throw error
  }
}

async function hasWindowsDescendants(pid: number): Promise<boolean> {
  const script = [
    "$rootProcessID = [uint32]" + pid,
    "$processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)",
    "$known = New-Object 'System.Collections.Generic.HashSet[uint32]'",
    "[void]$known.Add($rootProcessID)",
    "do {",
    "  $priorCount = $known.Count",
    "  foreach ($process in $processes) {",
    "    if ($known.Contains([uint32]$process.ParentProcessId)) { [void]$known.Add([uint32]$process.ProcessId) }",
    "  }",
    "} while ($known.Count -gt $priorCount)",
    "ConvertTo-Json -InputObject ($known.Count -gt 1)",
  ].join("\n")
  const observer = Bun.spawn(
    ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 5_000 },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(observer.stdout).text(),
    new Response(observer.stderr).text(),
    observer.exited,
  ])
  if (exitCode !== 0)
    throw new Error(`Windows process-tree observation failed: ${(stderr || stdout).trim()}`)
  const observation = stdout.trim().toLowerCase()
  if (observation === "true") return true
  if (observation === "false") return false
  throw new Error(`Windows process-tree observation returned invalid JSON: ${observation}`)
}

async function processTreeExists(pid: number): Promise<boolean> {
  return process.platform === "win32" ? hasWindowsDescendants(pid) : processGroupExists(pid)
}

export async function waitForProcessTreeExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (await processTreeExists(pid)) {
    if (Date.now() >= deadline) return false
    await Bun.sleep(20)
  }
  return true
}

function signalProcessGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined
    if (code !== "ESRCH") throw error
  }
}

async function terminateWindowsProcessTree(child: OwnedTestProcessChild): Promise<void> {
  const taskkill = Bun.spawn(["taskkill.exe", "/PID", String(child.pid), "/T", "/F"], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    timeout: 10_000,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(taskkill.stdout).text(),
    new Response(taskkill.stderr).text(),
    taskkill.exited,
  ])
  if (exitCode === 0) return
  try {
    child.kill("SIGKILL")
  } catch {
    // The process-tree observation below is authoritative.
  }
  if (await processTreeExists(child.pid))
    throw new Error(
      `taskkill could not confirm process-tree termination (exit ${exitCode}): ${(stderr || stdout).trim()}`,
    )
}

async function terminatePosixProcessGroup(pid: number): Promise<void> {
  signalProcessGroup(pid, "SIGTERM")
  if (!(await waitForProcessTreeExit(pid, PROCESS_TERM_GRACE_MS)))
    signalProcessGroup(pid, "SIGKILL")
}

export async function terminateProcessTree(child: OwnedTestProcessChild): Promise<void> {
  if (process.platform === "win32") await terminateWindowsProcessTree(child)
  else await terminatePosixProcessGroup(child.pid)

  if (!(await waitForProcessTreeExit(child.pid, PROCESS_KILL_WAIT_MS)))
    throw new Error("Owned test subprocess descendants remained after termination")
}
