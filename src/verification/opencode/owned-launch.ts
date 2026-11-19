import { createServer } from "node:net"
import { spawn, spawnSync } from "node:child_process"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { OpenCode } from "@opencode/client"
import { NATIVE_VERIFICATION_BASE_ENV, type NativeBinding } from "./native-interaction-contract.ts"

const DEFAULT_SERVICE_PORT = 49374
const MANIFEST_NAME = "owned-launch.json"
const OWNER_NAME = "owner.json"
const SERVICE_ARGS = ["serve", "--service", "--hostname", "127.0.0.1"] as const
const STARTUP_TIMEOUT_MS = 30_000
const SHUTDOWN_TIMEOUT_MS = 10_000

export type ProcessIdentity = {
  pid: number
  startedAt: string
  command: string
}

export class ServiceNotStartedError extends Error {}

export type SpawnedService = {
  pid: number
  command: string
  spawnedAt: number
}

export type ProcessObservation =
  | { kind: "authoritatively-absent" }
  | { kind: "live"; identity: ProcessIdentity }
  | {
      kind: "observation-unavailable"
      reason: "probe-error" | "unexpected-exit" | "malformed-output"
    }

export type ProcessObservationFailure = Extract<
  ProcessObservation,
  { kind: "observation-unavailable" }
>["reason"]

export type OwnedProcessObservation =
  | { kind: "authoritatively-absent" }
  | { kind: "matching-live"; identity: ProcessIdentity }
  | { kind: "identity-changed"; identity: ProcessIdentity }
  | { kind: "observation-unavailable"; reason: ProcessObservationFailure }

export type ProcessExitObservation =
  | { kind: "observed-exited" }
  | { kind: "main-still-live" }
  | { kind: "identity-changed" }
  | { kind: "observation-unavailable"; reason: ProcessObservationFailure }

export type ProcessInventoryObservation =
  | { kind: "observed"; processes: string[] }
  | {
      kind: "observation-unavailable"
      reason: "probe-error" | "unexpected-exit" | "malformed-output"
    }

export type OwnedCleanupOutcome =
  | "stopped"
  | "already-stopped"
  | "ambiguous"
  | "timeout"
  | "observation-unavailable"
  | "identity-changed"
  | "main-still-live"
  | "helpers-remain"
  | "helper-observation-unavailable"

export type ServiceRegistration = {
  id: string
  version: string
  url: string
  pid: number
  password: string
}

export type CandidateIdentity = {
  workspace: string
  revision: string
  dirtyPaths: string[]
  pluginEntry: string
  guiEntry: string
  guiEntryBytes: number
  guiEntryModifiedAt: string
  architectDescription: string
}

export type OwnedLaunchManifest = {
  schemaVersion: 1
  ownerID: string
  status:
    "preparing" | "service-ready" | "desktop-starting" | "ready" | "cleanup-blocked" | "cleaned"
  createdAt: string
  root: string
  baseDirectory?: string
  candidate: CandidateIdentity
  target: {
    desktopBundle: string
    bundleID: string
    version: string
    cliPath: string
    cliVersion: string
    workspace: string
    effectiveStateHome: string
    serviceRegistrationPath: string
  }
  protocolHandlerBaseline: string | null
  serviceStartupPending?: boolean
  pendingService?: SpawnedService
  service?: {
    process: ProcessIdentity
    id: string
    version: string
    url: string
  }
  desktop?: ProcessIdentity
  nativeInteraction?: {
    state: "idle" | "pending" | "ambiguous"
    requestID?: string
    kind?:
      | "snapshot"
      | "capture"
      | "focus"
      | "click"
      | "type"
      | "key"
      | "dictation-fixture"
      | "playback-plan"
    updatedAt?: string
    message?: string
  }
  observations: string[]
  cleanupIssue?: string
}

export type RuntimePaths = {
  root: string
  dataHome: string
  configHome: string
  cacheHome: string
  stateHome: string
  desktopHome: string
  sessionHome: string
  documentsHome: string
  tempHome: string
  shellHome: string
  serviceRegistration: string
  globalConfig: string
  candidatePlugin: string
  manifest: string
  owner: string
}

export function runtimePaths(root: string): RuntimePaths {
  const base = resolve(root)
  const xdg = (name: string) => join(base, name)
  const stateHome = xdg("state")
  const configHome = xdg("config")
  return {
    root: base,
    dataHome: xdg("data"),
    configHome,
    cacheHome: xdg("cache"),
    stateHome,
    desktopHome: xdg("desktop"),
    sessionHome: xdg("session"),
    documentsHome: xdg("documents"),
    tempHome: xdg("tmp"),
    shellHome: xdg("shell"),
    serviceRegistration: join(stateHome, "opencode", "service.json"),
    globalConfig: join(configHome, "opencode", "opencode.json"),
    candidatePlugin: join(base, "candidate-plugin"),
    manifest: join(base, MANIFEST_NAME),
    owner: join(base, OWNER_NAME),
  }
}

export function isolatedEnvironment(root: string): NodeJS.ProcessEnv {
  const paths = runtimePaths(root)
  const env: NodeJS.ProcessEnv = {
    HOME: paths.desktopHome,
    CFFIXED_USER_HOME: paths.desktopHome,
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    SHELL: "/bin/zsh",
    ZDOTDIR: paths.shellHome,
    TMPDIR: paths.tempHome,
    [NATIVE_VERIFICATION_BASE_ENV]: dirname(paths.root),
    XDG_DATA_HOME: paths.dataHome,
    XDG_CONFIG_HOME: paths.configHome,
    XDG_CACHE_HOME: paths.cacheHome,
    XDG_STATE_HOME: paths.stateHome,
    OPENCODE_DESKTOP_TEST_ROOT: paths.root,
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
  }
  for (const key of ["LANG", "LC_ALL", "LC_CTYPE", "USER", "LOGNAME"]) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

function parseShellEnvironment(data: Uint8Array): Map<string, string> {
  const entries = new Map<string, string>()
  for (const item of Buffer.from(data).toString("utf8").split("\0")) {
    const separator = item.indexOf("=")
    if (separator <= 0) continue
    entries.set(item.slice(0, separator), item.slice(separator + 1))
  }
  return entries
}

export function assertEffectiveIsolation(
  root: string,
  effectiveEnvironment: ReadonlyMap<string, string>,
): void {
  const paths = runtimePaths(root)
  const expected: Record<string, string> = {
    HOME: paths.desktopHome,
    CFFIXED_USER_HOME: paths.desktopHome,
    OPENCODE_DESKTOP_TEST_ROOT: paths.root,
    TMPDIR: paths.tempHome,
    [NATIVE_VERIFICATION_BASE_ENV]: dirname(paths.root),
    XDG_DATA_HOME: paths.dataHome,
    XDG_CONFIG_HOME: paths.configHome,
    XDG_CACHE_HOME: paths.cacheHome,
    XDG_STATE_HOME: paths.stateHome,
  }
  for (const [key, value] of Object.entries(expected)) {
    if (effectiveEnvironment.get(key) !== value) {
      throw new Error(`Desktop shell environment does not preserve isolated ${key}`)
    }
  }
}

export function parseServiceRegistration(input: unknown): ServiceRegistration {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Owned service registration is missing or malformed")
  }
  const value = input as Record<string, unknown>
  if (
    typeof value.url !== "string" ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.version !== "string" ||
    value.version.length === 0 ||
    typeof value.password !== "string" ||
    value.password.length === 0
  ) {
    throw new Error("Owned service registration is missing or malformed")
  }
  return {
    id: value.id as string,
    version: value.version as string,
    url: value.url,
    pid: value.pid,
    password: value.password as string,
  }
}

export function assertOwnedService(
  registration: ServiceRegistration,
  health: { pid: number; version: string },
  expected: {
    pid: number
    version: string
    registrationPath: string
    expectedPath: string
    port?: number
  },
): void {
  if (resolve(expected.registrationPath) !== resolve(expected.expectedPath)) {
    throw new Error("Desktop effective service-registration path is not the owned test root")
  }
  if (registration.pid !== expected.pid || registration.pid !== health.pid) {
    throw new Error("Service registration and authenticated endpoint identify different processes")
  }
  if (registration.version !== expected.version || health.version !== expected.version) {
    throw new Error(
      "Service registration and authenticated endpoint do not match the Desktop version",
    )
  }
  if (registration.id === undefined || registration.password === undefined) {
    throw new Error("Owned service registration lacks its private identity or authentication")
  }
  assertServiceEndpoint(registration.url, expected.port)
}

export function assertProtocolBaseline(bundleID: string, handlerID: string | null): string {
  if (bundleID.length === 0 || handlerID === null || handlerID.length === 0) {
    throw new Error(
      "Refusing Desktop launch because the opencode:// handler baseline cannot be restored",
    )
  }
  return handlerID
}

export function assertCandidateAgent(
  agents: ReadonlyArray<{ id: string; mode: string; description?: string }>,
  candidateDescription: string,
): void {
  const architect = agents.find((agent) => agent.id === "architect")
  if (
    architect === undefined ||
    architect.mode !== "primary" ||
    architect.description !== candidateDescription
  ) {
    throw new Error("Candidate LAZERS Architect is not behaviorally present on the owned service")
  }
}

export type LaunchDependencies = {
  prepare(input: {
    desktopBundle: string
    cliPath: string
    candidatePath: string
    targetPath: string
  }): Promise<{
    root: string
    ownerID: string
    bundleID: string
    desktopVersion: string
    cliVersion: string
    candidate: CandidateIdentity
    protocolHandler: string | null
    existingRegistration: boolean
    effectiveEnvironment: ReadonlyMap<string, string>
  }>
  startService(input: {
    root: string
    cliPath: string
    version: string
    onSpawn(process: SpawnedService): Promise<void>
  }): Promise<ProcessIdentity>
  waitForService(input: { root: string; process: ProcessIdentity; version: string }): Promise<{
    registration: ServiceRegistration
    health: { pid: number; version: string }
    registrationPath: string
    authenticated: boolean
  }>
  launchDesktop(input: {
    root: string
    desktopBundle: string
    candidatePath: string
  }): Promise<ProcessIdentity>
  waitForCandidate(input: {
    root: string
    desktop: ProcessIdentity
    candidate: CandidateIdentity
  }): Promise<{ agents: Array<{ id: string; mode: string; description?: string }> }>
  writeManifest(manifest: OwnedLaunchManifest): Promise<void>
  cleanup(manifest: OwnedLaunchManifest): Promise<{ clean: boolean; reason?: string }>
  abortPrepared?(root: string, ownerID: string): Promise<void>
  releaseReservation?(): Promise<void>
  retainBlockedReservation?(ownerID: string): Promise<void>
  protocolHandler(): Promise<string | null>
  restoreProtocolHandler?(handlerID: string): Promise<void>
  now(): string
}

export async function startOwnedDesktop(
  input: { desktopBundle: string; cliPath: string; candidatePath: string; targetPath: string },
  dependencies: LaunchDependencies,
): Promise<OwnedLaunchManifest> {
  const prepared = await dependencies.prepare(input)
  let manifest: OwnedLaunchManifest | undefined
  let releaseReservation = false
  let cleanupAttempted = false
  try {
    const protocolHandlerBaseline = assertProtocolBaseline(
      prepared.bundleID,
      prepared.protocolHandler,
    )
    if (prepared.existingRegistration) {
      throw new Error(
        "Owned test root already has a service registration; inspect or clean it before launch",
      )
    }
    assertEffectiveIsolation(prepared.root, prepared.effectiveEnvironment)
    const paths = runtimePaths(prepared.root)
    if (
      prepared.candidate.workspace !== resolve(input.candidatePath) ||
      prepared.candidate.workspace !== resolve(input.targetPath) ||
      prepared.candidate.pluginEntry !== join(resolve(input.candidatePath), "src", "index.ts") ||
      prepared.candidate.guiEntry !==
        join(resolve(input.candidatePath), "dist", "gui-experimental.cjs")
    ) {
      throw new Error(
        "Candidate and target identities do not resolve to the requested workspace source",
      )
    }

    manifest = {
      schemaVersion: 1,
      ownerID: prepared.ownerID,
      status: "preparing",
      createdAt: dependencies.now(),
      root: paths.root,
      baseDirectory: dirname(paths.root),
      candidate: prepared.candidate,
      target: {
        desktopBundle: resolve(input.desktopBundle),
        bundleID: prepared.bundleID,
        version: prepared.desktopVersion,
        cliPath: resolve(input.cliPath),
        cliVersion: prepared.cliVersion,
        workspace: resolve(input.targetPath),
        effectiveStateHome: paths.stateHome,
        serviceRegistrationPath: paths.serviceRegistration,
      },
      protocolHandlerBaseline,
      nativeInteraction: { state: "idle" },
      observations: [
        "Packaged Desktop protocol registration is allowed only because the captured handler already matches this exact app bundle ID.",
        "The isolated shell overlay was checked before either service or Desktop startup.",
      ],
    }
    await dependencies.writeManifest(manifest)
    manifest.serviceStartupPending = true
    await dependencies.writeManifest(manifest)

    try {
      const serviceProcess = await dependencies.startService({
        root: manifest.root,
        cliPath: manifest.target.cliPath,
        version: manifest.target.cliVersion,
        onSpawn: async (process) => {
          manifest!.pendingService = process
          await dependencies.writeManifest(manifest!)
        },
      })
      delete manifest.pendingService
      delete manifest.serviceStartupPending
      manifest.service = {
        process: serviceProcess,
        id: "",
        version: manifest.target.cliVersion,
        url: "",
      }
      await dependencies.writeManifest(manifest)

      const proof = await dependencies.waitForService({
        root: manifest.root,
        process: serviceProcess,
        version: manifest.target.cliVersion,
      })
      if (!proof.authenticated) throw new Error("Owned service endpoint did not authenticate")
      assertOwnedService(proof.registration, proof.health, {
        pid: serviceProcess.pid,
        version: manifest.target.cliVersion,
        registrationPath: proof.registrationPath,
        expectedPath: manifest.target.serviceRegistrationPath,
        port: servicePortFromCommand(serviceProcess.command),
      })
      manifest.service = {
        process: serviceProcess,
        id: proof.registration.id!,
        version: proof.registration.version!,
        url: proof.registration.url,
      }
      manifest.status = "service-ready"
      manifest.observations.push(
        "Owned service registration, effective registration path, authenticated /api/info identity, and process PID/version agree.",
      )
      await dependencies.writeManifest(manifest)

      const desktop = await dependencies.launchDesktop({
        root: manifest.root,
        desktopBundle: manifest.target.desktopBundle,
        candidatePath: manifest.candidate.workspace,
      })
      manifest.desktop = desktop
      manifest.status = "desktop-starting"
      await dependencies.writeManifest(manifest)

      const candidateProof = await dependencies.waitForCandidate({
        root: manifest.root,
        desktop,
        candidate: manifest.candidate,
      })
      assertCandidateAgent(candidateProof.agents, manifest.candidate.architectDescription)
      const currentHandler = await dependencies.protocolHandler()
      if (
        currentHandler !== protocolHandlerBaseline &&
        currentHandler !== manifest.target.bundleID
      ) {
        throw new Error(
          "Protocol-handler state changed to an unexpected handler during Desktop startup",
        )
      }
      manifest.status = "ready"
      manifest.observations.push(
        "Candidate Architect identity was read from the owned service after the Desktop process was launched.",
      )
      manifest.observations.push(
        currentHandler === protocolHandlerBaseline
          ? "The opencode:// handler still matches its pre-launch baseline."
          : "Desktop registered itself as the opencode:// handler; cleanup will restore the captured baseline.",
      )
      await dependencies.writeManifest(manifest)
      releaseReservation = true
      return manifest
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      cleanupAttempted = true
      if (
        error instanceof ServiceNotStartedError &&
        manifest.pendingService === undefined &&
        manifest.service === undefined
      ) {
        delete manifest.serviceStartupPending
        try {
          await dependencies.writeManifest(manifest)
        } catch {
          // The pre-spawn classification is conclusive; cleanup still owns the root.
        }
      }
      const cleanup = await dependencies.cleanup(manifest).catch((cleanupError: unknown) => ({
        clean: false,
        reason: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      }))
      if (!cleanup.clean) {
        manifest.status = "cleanup-blocked"
        manifest.cleanupIssue = cleanup.reason ?? "Owned launch cleanup is incomplete"
        let persistenceIssue: string | undefined
        try {
          await dependencies.writeManifest(manifest)
        } catch (persistError) {
          persistenceIssue =
            persistError instanceof Error ? persistError.message : String(persistError)
        }
        await dependencies.retainBlockedReservation?.(manifest.ownerID)
        if (persistenceIssue !== undefined) {
          manifest.cleanupIssue = `${manifest.cleanupIssue}; cleanup state could not be persisted: ${persistenceIssue}`
        }
        throw new Error(
          `${message}; owned cleanup remains retryable at ${manifest.root}: ${manifest.cleanupIssue}`,
          { cause: error },
        )
      }
      releaseReservation = true
      throw error
    }
  } catch (error) {
    if (!cleanupAttempted && (manifest === undefined || manifest.service === undefined)) {
      try {
        await dependencies.abortPrepared?.(prepared.root, prepared.ownerID)
        releaseReservation = true
      } catch (cleanupError) {
        await dependencies.retainBlockedReservation?.(prepared.ownerID)
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; prepared-root cleanup is blocked: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          { cause: cleanupError },
        )
      }
    }
    throw error
  } finally {
    if (releaseReservation) await dependencies.releaseReservation?.()
  }
}

export type CleanupDependencies = Pick<LaunchDependencies, "writeManifest"> & {
  verifyAndStopDesktop(process: ProcessIdentity): Promise<OwnedCleanupOutcome>
  verifyAndStopService(manifest: OwnedLaunchManifest): Promise<OwnedCleanupOutcome>
  observeProcess?(pid: number): ProcessObservation
  protocolHandler(): Promise<string | null>
  restoreProtocolHandler?(handlerID: string): Promise<void>
  effectiveRegistrationPath?(root: string): Promise<string>
  removeRoot(root: string, ownerID: string): Promise<void>
}

export async function cleanupOwnedDesktop(
  manifest: OwnedLaunchManifest,
  dependencies: CleanupDependencies,
): Promise<OwnedLaunchManifest> {
  const block = async (reason: string) => {
    manifest.status = "cleanup-blocked"
    manifest.cleanupIssue = reason
    await dependencies.writeManifest(manifest)
    return manifest
  }
  if (manifest.schemaVersion !== 1 || manifest.root !== resolve(manifest.root)) {
    return block("Manifest identity or root path is invalid; no process or file was touched")
  }
  if (
    manifest.nativeInteraction?.state === "pending" ||
    manifest.nativeInteraction?.state === "ambiguous"
  ) {
    return block(
      "Native interaction delivery is pending or ambiguous; resolve the same request without replay before cleanup",
    )
  }
  if (
    manifest.serviceStartupPending === true &&
    manifest.pendingService === undefined &&
    manifest.service === undefined
  ) {
    return block(
      "Service startup began without durable process ownership; preserve the root for reconciliation",
    )
  }
  if (manifest.pendingService !== undefined) {
    const spawned = manifest.pendingService
    if (!isSpawnedService(spawned)) {
      return block("Unconfirmed service ownership is malformed; preserve the owned root")
    }
    const observed = (dependencies.observeProcess ?? observeProcess)(spawned.pid)
    if (observed.kind !== "authoritatively-absent") {
      return block(
        observed.kind === "live"
          ? "Spawned service identity was not confirmed and its PID is still live; preserve the root"
          : "Spawned service exit cannot be observed; preserve the root and retry cleanup",
      )
    }
    delete manifest.pendingService
    delete manifest.serviceStartupPending
    await dependencies.writeManifest(manifest)
  }
  if (manifest.desktop !== undefined) {
    const desktopResult = await dependencies.verifyAndStopDesktop(manifest.desktop)
    const issue = cleanupIssueForOutcome("Desktop", desktopResult)
    if (issue !== undefined) return block(issue)
  }
  if (manifest.service !== undefined) {
    const serviceResult = await dependencies.verifyAndStopService(manifest)
    const issue = cleanupIssueForOutcome("service", serviceResult)
    if (issue !== undefined) return block(issue)
  }
  if (manifest.desktop !== undefined) {
    const currentHandler = await dependencies.protocolHandler()
    if (currentHandler !== manifest.protocolHandlerBaseline) {
      if (
        currentHandler !== manifest.target.bundleID ||
        manifest.protocolHandlerBaseline === null ||
        dependencies.restoreProtocolHandler === undefined
      ) {
        return block(
          "Protocol-handler state changed unexpectedly; preserve the root and resolve restoration explicitly",
        )
      }
      try {
        await dependencies.restoreProtocolHandler(manifest.protocolHandlerBaseline)
      } catch (error) {
        return block(
          `Protocol-handler restoration failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if ((await dependencies.protocolHandler()) !== manifest.protocolHandlerBaseline) {
        return block("Protocol-handler restoration could not be confirmed")
      }
    }
  }
  try {
    await dependencies.removeRoot(manifest.root, manifest.ownerID)
  } catch (error) {
    return block(error instanceof Error ? error.message : String(error))
  }
  manifest.status = "cleaned"
  delete manifest.cleanupIssue
  return manifest
}

function cleanupIssueForOutcome(
  resource: "Desktop" | "service",
  outcome: OwnedCleanupOutcome,
): string | undefined {
  switch (outcome) {
    case "stopped":
    case "already-stopped":
      return undefined
    case "ambiguous":
      return resource === "Desktop"
        ? "Desktop process identity is ambiguous; preserve the owned root"
        : "Service registration or authenticated process identity is ambiguous; preserve the owned root"
    case "timeout":
      return `Owned ${resource} shutdown timed out; preserve the root and retry cleanup`
    case "observation-unavailable":
      return `Owned ${resource} process identity observation is unavailable; preserve the root`
    case "identity-changed":
      return `Owned ${resource} process identity changed during cleanup; preserve the root`
    case "main-still-live":
      return `Owned ${resource} process remains live after the bounded shutdown wait; retry cleanup`
    case "helpers-remain":
      return "Owned Desktop helper processes still reference the test root; retry cleanup"
    case "helper-observation-unavailable":
      return "Owned Desktop helper-process inventory is unavailable; preserve the root"
  }
}

type DesktopBundle = {
  path: string
  executable: string
  bundleID: string
  version: string
  cliPath: string
  cliVersion: string
}

type Candidate = CandidateIdentity

/** Each launch retains its own output without overwriting an earlier process log. */
export function openDesktopProcessLog(root: string) {
  return open(join(root, `desktop-process-${crypto.randomUUID()}.log`), "ax", 0o600)
}

class SystemLaunchDependencies implements LaunchDependencies {
  private reservation?: Reservation

  constructor(private readonly baseDirectory: string) {}

  async prepare(input: {
    desktopBundle: string
    cliPath: string
    candidatePath: string
    targetPath: string
  }): Promise<{
    root: string
    ownerID: string
    bundleID: string
    desktopVersion: string
    cliVersion: string
    candidate: CandidateIdentity
    protocolHandler: string | null
    existingRegistration: boolean
    effectiveEnvironment: ReadonlyMap<string, string>
  }> {
    const desktop = await inspectDesktop(input.desktopBundle, input.cliPath)
    const candidate = await inspectCandidate(input.candidatePath)
    const targetPath = await realpath(input.targetPath)
    if (candidate.workspace !== targetPath) {
      throw new Error(
        "This qualification requires the candidate workspace to be the target workspace",
      )
    }
    const expectedBase = await canonicalVerificationBase(this.baseDirectory, true)
    await mkdir(this.baseDirectory, { recursive: true, mode: 0o700 })
    const base = await canonicalVerificationBase(this.baseDirectory)
    if (base !== expectedBase) {
      throw new Error("Owned verification base identity changed during setup")
    }
    this.reservation = await acquireReservation(base)
    let root: string | undefined
    let ownerID: string | undefined
    let manifest: OwnedLaunchManifest | undefined
    try {
      await assertNoPendingLaunch(base)
      root = await mkdtemp(join(base, "lazers-full-instance-"))
      await chmod(root, 0o700)
      const paths = runtimePaths(root)
      ownerID = this.reservation.ownerID
      await writeFile(paths.owner, JSON.stringify({ ownerID, root }), { mode: 0o600, flag: "wx" })
      manifest = {
        schemaVersion: 1,
        ownerID,
        status: "preparing",
        createdAt: this.now(),
        root,
        baseDirectory: dirname(root),
        candidate,
        target: {
          desktopBundle: desktop.path,
          bundleID: desktop.bundleID,
          version: desktop.version,
          cliPath: desktop.cliPath,
          cliVersion: desktop.cliVersion,
          workspace: targetPath,
          effectiveStateHome: paths.stateHome,
          serviceRegistrationPath: paths.serviceRegistration,
        },
        protocolHandlerBaseline: null,
        nativeInteraction: { state: "idle" },
        observations: ["Owned root created; no Desktop or service process has been started."],
      }
      await this.writeManifest(manifest)
      for (const directory of [
        paths.dataHome,
        paths.configHome,
        paths.cacheHome,
        paths.stateHome,
        paths.desktopHome,
        paths.sessionHome,
        paths.documentsHome,
        paths.tempHome,
        paths.shellHome,
        join(paths.stateHome, "opencode"),
        join(paths.configHome, "opencode"),
        paths.candidatePlugin,
      ]) {
        await mkdir(directory, { recursive: true, mode: 0o700 })
      }
      const handler = await readProtocolHandler()
      manifest.protocolHandlerBaseline = handler
      await this.writeManifest(manifest)
      assertProtocolBaseline(desktop.bundleID, handler)
      const shellEnv = isolatedEnvironment(root)
      const effectiveEnvironment = await probeLoginShell(shellEnv)
      assertEffectiveIsolation(root, effectiveEnvironment)
      const existingRegistration = await exists(paths.serviceRegistration)
      if (existingRegistration) {
        throw new Error("New isolated service-registration path is unexpectedly occupied")
      }
      await writeCandidateConfig(paths, candidate)
      await writeFile(
        paths.globalConfig,
        JSON.stringify(
          {
            $schema: "https://opencode.ai/config.json",
            default_agent: "architect",
            plugins: [{ package: paths.candidatePlugin }],
          },
          null,
          2,
        ) + "\n",
        { mode: 0o600, flag: "wx" },
      )
      return {
        root,
        ownerID,
        bundleID: desktop.bundleID,
        desktopVersion: desktop.version,
        cliVersion: desktop.cliVersion,
        candidate,
        protocolHandler: handler,
        existingRegistration,
        effectiveEnvironment,
      }
    } catch (error) {
      if (root !== undefined && ownerID !== undefined && manifest !== undefined) {
        try {
          await removeOwnedRoot(root, ownerID, base)
          await this.releaseReservation()
        } catch (cleanupError) {
          manifest.status = "cleanup-blocked"
          manifest.cleanupIssue =
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          await this.writeManifest(manifest)
          await this.retainBlockedReservation(ownerID)
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}; prepared root cleanup is blocked at ${root}: ${manifest.cleanupIssue}`,
            { cause: cleanupError },
          )
        }
      } else if (root !== undefined) {
        const canonicalRoot = await realpath(root).catch(() => undefined)
        if (
          canonicalRoot !== undefined &&
          dirname(canonicalRoot) === base &&
          basename(canonicalRoot).startsWith("lazers-full-instance-")
        ) {
          await rm(canonicalRoot, { recursive: true, force: false })
        }
        await this.releaseReservation()
      } else {
        await this.releaseReservation()
      }
      throw error
    }
  }

  async startService(input: {
    root: string
    cliPath: string
    version: string
    onSpawn(process: SpawnedService): Promise<void>
  }): Promise<ProcessIdentity> {
    const paths = runtimePaths(input.root)
    const port = await reserveLoopbackPort().catch((error: unknown) => {
      throw new ServiceNotStartedError("Owned service port preparation failed before spawn", {
        cause: error,
      })
    })
    const env = isolatedEnvironment(input.root)
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(input.cliPath, [...SERVICE_ARGS, "--port", String(port)], {
        cwd: paths.root,
        detached: true,
        env,
        stdio: "ignore",
      })
    } catch (error) {
      throw new ServiceNotStartedError("Owned service could not spawn", { cause: error })
    }
    child.once("error", () => {})
    child.unref()
    if (child.pid === undefined) {
      throw new ServiceNotStartedError("Owned service child did not receive a PID")
    }
    try {
      await input.onSpawn({
        pid: child.pid,
        command: [input.cliPath, ...SERVICE_ARGS, "--port", String(port)].join(" "),
        spawnedAt: Date.now(),
      })
      return await waitForProcessIdentity(child.pid, input.cliPath, [
        ...SERVICE_ARGS,
        "--port",
        String(port),
      ])
    } catch (error) {
      const observed = observeProcess(child.pid)
      const identity = observed.kind === "live" ? observed.identity : undefined
      if (
        identity !== undefined &&
        identity.command.includes(input.cliPath) &&
        SERVICE_ARGS.every((argument) => identity.command.includes(argument)) &&
        identity.command.includes(String(port))
      ) {
        process.kill(child.pid, "SIGTERM")
        const exit = await waitUntilGone(identity, SHUTDOWN_TIMEOUT_MS)
        if (exit.kind !== "observed-exited") {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}; spawned service cleanup: ${exit.kind}`,
            { cause: error },
          )
        }
      }
      throw error
    }
  }

  async waitForService(input: { root: string; process: ProcessIdentity; version: string }) {
    const paths = runtimePaths(input.root)
    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    let lastError = "registration is not written yet"
    while (Date.now() < deadline) {
      try {
        const registration = parseServiceRegistration(
          JSON.parse(await readFile(paths.serviceRegistration, "utf8")) as unknown,
        )
        if (registration.pid !== input.process.pid) {
          throw new Error("The isolated registration belongs to a different PID")
        }
        if (registration.version !== input.version) {
          throw new Error("The isolated registration has a different OpenCode version")
        }
        assertServiceEndpoint(registration.url, servicePortFromCommand(input.process.command))
        if (registration.password === undefined)
          throw new Error("The owned service has no auth token")
        const health = await authenticatedServiceInfo(registration, 1_000)
        const current = classifyOwnedProcessObservation(
          input.process,
          observeProcess(input.process.pid),
        )
        if (current.kind !== "matching-live") {
          throw new Error(ownedProcessObservationError("registered service", current.kind))
        }
        return {
          registration,
          health: { pid: health.pid, version: health.version },
          registrationPath: paths.serviceRegistration,
          authenticated: true,
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
      await delay(100)
    }
    throw new Error(`Owned service did not become ready: ${lastError}`)
  }

  async launchDesktop(input: {
    root: string
    desktopBundle: string
    candidatePath: string
  }): Promise<ProcessIdentity> {
    const bundle = await inspectDesktop(input.desktopBundle)
    const stored = await readManifestFile(runtimePaths(input.root).manifest)
    const currentCandidate = await inspectCandidate(input.candidatePath)
    if (!sameCandidateIdentity(currentCandidate, stored.candidate)) {
      throw new Error("Owned candidate workspace or entry path changed after setup")
    }
    const env = isolatedEnvironment(input.root)
    const output = await openDesktopProcessLog(input.root)
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bundle.executable, [], {
        cwd: input.candidatePath,
        detached: true,
        env,
        stdio: ["ignore", output.fd, output.fd],
      })
    } finally {
      await output.close()
    }
    child.unref()
    if (child.pid === undefined) throw new Error("Owned Desktop child did not receive a PID")
    return waitForProcessIdentity(child.pid, bundle.executable, [])
  }

  async waitForCandidate(input: {
    root: string
    desktop: ProcessIdentity
    candidate: CandidateIdentity
  }): Promise<{ agents: Array<{ id: string; mode: string; description?: string }> }> {
    const paths = runtimePaths(input.root)
    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    let lastError = "candidate agent list is not available yet"
    while (Date.now() < deadline) {
      try {
        const manifest = await readManifestFile(paths.manifest)
        if (manifest.service === undefined) throw new Error("Owned service identity is missing")
        const registration = parseServiceRegistration(
          JSON.parse(await readFile(paths.serviceRegistration, "utf8")) as unknown,
        )
        if (
          registration.pid !== manifest.service.process.pid ||
          registration.id !== manifest.service.id ||
          registration.version !== manifest.service.version ||
          registration.url !== manifest.service.url ||
          registration.password === undefined
        ) {
          throw new Error("Owned service registration changed while Desktop was starting")
        }
        assertServiceEndpoint(
          registration.url,
          servicePortFromCommand(manifest.service.process.command),
        )
        const status = await authenticatedServiceInfo(registration, 1_000)
        if (
          status.pid !== manifest.service.process.pid ||
          status.version !== manifest.service.version
        ) {
          throw new Error("Desktop service endpoint no longer authenticates as the owned process")
        }
        const client = OpenCode.make({
          baseUrl: registration.url,
          headers: {
            authorization: `Basic ${Buffer.from(`opencode:${registration.password}`).toString("base64")}`,
          },
        })
        const process = classifyOwnedProcessObservation(
          input.desktop,
          observeProcess(input.desktop.pid),
        )
        if (process.kind !== "matching-live") {
          throw new Error(ownedProcessObservationError("Desktop target", process.kind))
        }
        const inventory = observeProcessesUsing(input.root)
        if (inventory.kind === "observation-unavailable") {
          throw new Error("Owned Desktop process inventory is unavailable")
        }
        if (!inventory.processes.some((line) => line.includes(`${input.root}/desktop`))) {
          throw new Error("Desktop is not using its owned test-root user-data directory")
        }
        const result = await client.agent.list(
          {
            location: { directory: input.candidate.workspace },
          },
          { signal: AbortSignal.timeout(2_000) },
        )
        return {
          agents: result.data.map((agent) => ({
            id: agent.id,
            mode: agent.mode,
            ...(agent.description === undefined ? {} : { description: agent.description }),
          })),
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
      await delay(150)
    }
    throw new Error(`Candidate Desktop service did not become ready: ${lastError}`)
  }

  async writeManifest(manifest: OwnedLaunchManifest): Promise<void> {
    const paths = runtimePaths(manifest.root)
    await writeManifestFile(paths.manifest, manifest)
  }

  async cleanup(manifest: OwnedLaunchManifest): Promise<{ clean: boolean; reason?: string }> {
    const result = await cleanupOwnedDesktop(manifest, {
      writeManifest: (value) => this.writeManifest(value),
      verifyAndStopDesktop: (process) => stopOwnedDesktopProcess(process, manifest.root),
      verifyAndStopService: (value) => stopOwnedServiceProcess(value),
      protocolHandler: () => this.protocolHandler(),
      restoreProtocolHandler: (handlerID) => restoreProtocolHandler(handlerID),
      removeRoot: (root, ownerID) => removeOwnedRoot(root, ownerID, this.baseDirectory),
    })
    return result.status === "cleanup-blocked"
      ? { clean: false, reason: result.cleanupIssue }
      : { clean: true }
  }

  now(): string {
    return new Date().toISOString()
  }

  protocolHandler(): Promise<string | null> {
    return readProtocolHandler()
  }

  async abortPrepared(root: string, ownerID: string): Promise<void> {
    await removeOwnedRoot(root, ownerID, this.baseDirectory)
  }

  async releaseReservation(): Promise<void> {
    const reservation = this.reservation
    if (reservation === undefined) return
    this.reservation = undefined
    await releaseReservation(reservation)
  }

  async retainBlockedReservation(ownerID: string): Promise<void> {
    const reservation = this.reservation
    if (reservation === undefined) return
    if (reservation.ownerID !== ownerID)
      throw new Error("Reservation owner does not match the dirty test root")
    this.reservation = undefined
    await retainReservation(reservation)
  }
}

export function launchDependencies(
  baseDirectory = defaultBaseDirectory(),
): SystemLaunchDependencies {
  return new SystemLaunchDependencies(baseDirectory)
}

export function defaultBaseDirectory(): string {
  return join(stableSystemTemporaryDirectory(), "opencode", "lazers-product-verification")
}

function stableSystemTemporaryDirectory(): string {
  if (process.platform === "darwin") {
    const result = spawnSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    })
    const directory = result.stdout?.trim() ?? ""
    if (result.status !== 0 || result.error || !isAbsolute(directory)) {
      throw new Error("Could not establish the stable per-user temporary directory")
    }
    return resolve(directory)
  }
  if (process.platform === "linux") return "/tmp"
  throw new Error("Owned Desktop verification requires a stable system temporary directory")
}

async function prospectiveRealpath(path: string): Promise<string> {
  let current = resolve(path)
  const suffix: string[] = []
  while (true) {
    try {
      return resolve(await realpath(current), ...suffix)
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error
      const parent = dirname(current)
      if (parent === current) throw error
      suffix.unshift(basename(current))
      current = parent
    }
  }
}

async function canonicalVerificationBase(
  baseDirectory: string,
  allowMissing = false,
): Promise<string> {
  const requested = resolve(baseDirectory)
  const info = await lstat(requested).catch((error: unknown) => {
    if (allowMissing && isCode(error, "ENOENT")) return undefined
    throw error
  })
  if (
    info !== undefined &&
    (!info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && info.uid !== process.getuid()))
  ) {
    throw new Error("Owned verification base must be a private, user-owned directory")
  }
  const canonical = await prospectiveRealpath(requested)
  const systemTemp = await realpath(stableSystemTemporaryDirectory())
  const fromSystemTemp = relative(systemTemp, canonical)
  const segments = fromSystemTemp.split(sep)
  if (
    fromSystemTemp === "" ||
    fromSystemTemp === "." ||
    fromSystemTemp === ".." ||
    fromSystemTemp.startsWith(`..${sep}`) ||
    isAbsolute(fromSystemTemp) ||
    segments.length < 2 ||
    segments.at(-2) !== "opencode" ||
    segments.at(-1) !== "lazers-product-verification"
  ) {
    throw new Error("Owned verification base is outside its stable system-temp location")
  }
  if (info !== undefined && (await realpath(requested)) !== canonical) {
    throw new Error("Owned verification base identity changed during validation")
  }
  return canonical
}

export async function readManifest(root: string): Promise<OwnedLaunchManifest> {
  const requestedRoot = resolve(root)
  const rootInfo = await lstat(requestedRoot)
  if (
    rootInfo.isSymbolicLink() ||
    !rootInfo.isDirectory() ||
    (rootInfo.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && rootInfo.uid !== process.getuid())
  ) {
    throw new Error("Owned launch root is not a private, user-owned directory")
  }
  const canonicalRoot = await realpath(requestedRoot)
  const manifest = await readManifestFile(runtimePaths(canonicalRoot).manifest)
  const declaredBase =
    process.env[NATIVE_VERIFICATION_BASE_ENV] ?? manifest.baseDirectory ?? defaultBaseDirectory()
  const expectedBase = await canonicalVerificationBase(declaredBase)
  if (
    process.env[NATIVE_VERIFICATION_BASE_ENV] !== undefined &&
    manifest.baseDirectory !== undefined &&
    (await canonicalVerificationBase(manifest.baseDirectory)) !== expectedBase
  ) {
    throw new Error("Owned verification base does not match the launch manifest")
  }
  if (dirname(canonicalRoot) !== expectedBase) {
    throw new Error("Owned launch root is outside the product-verification temporary directory")
  }
  if (manifest.root !== canonicalRoot)
    throw new Error("Owned launch manifest root does not match its directory")
  if (
    manifest.baseDirectory !== undefined &&
    (await canonicalVerificationBase(manifest.baseDirectory)) !== expectedBase
  ) {
    throw new Error("Owned verification base does not match the launch manifest")
  }
  const markerPath = runtimePaths(canonicalRoot).owner
  const markerInfo = await lstat(markerPath)
  if (
    markerInfo.isSymbolicLink() ||
    !markerInfo.isFile() ||
    (markerInfo.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && markerInfo.uid !== process.getuid())
  ) {
    throw new Error("Owned launch marker is not a regular file")
  }
  const marker = JSON.parse(await readFile(markerPath, "utf8")) as {
    ownerID?: unknown
    root?: unknown
  }
  if (marker.ownerID !== manifest.ownerID || marker.root !== manifest.root) {
    throw new Error("Owned launch marker does not match its manifest")
  }
  return manifest
}

export async function cleanManifest(root: string): Promise<OwnedLaunchManifest> {
  const manifest = await readManifest(root)
  const canonicalRoot = await realpath(root)
  const expectedBase = await canonicalVerificationBase(
    manifest.baseDirectory ?? defaultBaseDirectory(),
  )
  if (canonicalRoot !== manifest.root || dirname(canonicalRoot) !== expectedBase) {
    throw new Error("Owned launch root is outside the product-verification temporary directory")
  }
  const paths = runtimePaths(root)
  const owner = JSON.parse(await readFile(paths.owner, "utf8")) as {
    ownerID?: unknown
    root?: unknown
  }
  if (owner.ownerID !== manifest.ownerID || owner.root !== manifest.root) {
    throw new Error("Owner marker does not match manifest; cleanup is refused")
  }
  const base = await realpath(dirname(resolve(root)))
  const deps = launchDependencies(base)
  let reservation: Reservation
  try {
    reservation = await acquireReservation(base, false, manifest.ownerID)
  } catch {
    reservation = await acquireRecoveryReservation(base, manifest)
  }
  try {
    const result = await cleanupOwnedDesktop(manifest, {
      writeManifest: (value) => deps.writeManifest(value),
      verifyAndStopDesktop: (process) => stopOwnedDesktopProcess(process, manifest.root),
      verifyAndStopService: (value) => stopOwnedServiceProcess(value),
      protocolHandler: () => readProtocolHandler(),
      restoreProtocolHandler: (handlerID) => restoreProtocolHandler(handlerID),
      removeRoot: (path, ownerID) => removeOwnedRoot(path, ownerID, base),
    })
    if (result.status === "cleanup-blocked") {
      await retainReservation(reservation)
    } else {
      await releaseReservation(reservation)
    }
    return result
  } catch (error) {
    manifest.status = "cleanup-blocked"
    manifest.cleanupIssue = error instanceof Error ? error.message : String(error)
    await deps.writeManifest(manifest).catch(() => undefined)
    if (reservation.handle.fd !== -1) await retainReservation(reservation)
    throw error
  } finally {
    if (reservation.handle.fd !== -1) await retainReservation(reservation)
  }
}

export async function verifyOwnedSidecar(
  root: string,
  options: { allowInteractionRecovery?: boolean } = {},
): Promise<{
  manifest: OwnedLaunchManifest
  registration: ServiceRegistration
  health: { pid: number; version: string }
}> {
  const manifest = await readManifest(root)
  const recoverableInteraction =
    options.allowInteractionRecovery === true &&
    manifest.status === "cleanup-blocked" &&
    (manifest.nativeInteraction?.state === "pending" ||
      manifest.nativeInteraction?.state === "ambiguous")
  if (manifest.status !== "ready" && !recoverableInteraction) {
    throw new Error("Owned sidecar is not in a ready verification state")
  }
  if (manifest.service === undefined) throw new Error("Owned service identity is missing")
  const paths = runtimePaths(manifest.root)
  if (
    resolve(manifest.target.effectiveStateHome) !== paths.stateHome ||
    resolve(manifest.target.serviceRegistrationPath) !== paths.serviceRegistration
  ) {
    throw new Error("Owned service registration path is not the isolated test-root path")
  }
  const registrationInfo = await lstat(paths.serviceRegistration)
  if (!registrationInfo.isFile() || registrationInfo.isSymbolicLink()) {
    throw new Error("Owned service registration is not a regular file")
  }
  const registration = parseServiceRegistration(
    JSON.parse(await readFile(paths.serviceRegistration, "utf8")) as unknown,
  )
  const process = classifyOwnedProcessObservation(
    manifest.service.process,
    observeProcess(manifest.service.process.pid),
  )
  if (process.kind !== "matching-live") {
    throw new Error(ownedProcessObservationError("owned service", process.kind))
  }
  const health = await authenticatedServiceInfo(registration, 1_000)
  assertOwnedService(registration, health, {
    pid: manifest.service.process.pid,
    version: manifest.target.cliVersion,
    registrationPath: paths.serviceRegistration,
    expectedPath: manifest.target.serviceRegistrationPath,
    port: servicePortFromCommand(manifest.service.process.command),
  })
  if (
    registration.id !== manifest.service.id ||
    registration.url !== manifest.service.url ||
    registration.version !== manifest.service.version
  ) {
    throw new Error("Owned service registration no longer matches its launch manifest")
  }
  const candidate = await inspectCandidate(manifest.candidate.workspace)
  const changedCandidateFields = candidateIdentityDifferences(candidate, manifest.candidate)
  if (changedCandidateFields.length > 0) {
    throw new Error(
      `Owned candidate workspace or entry path changed after setup (fields: ${changedCandidateFields.join(",")})`,
    )
  }
  return { manifest, registration, health }
}

export type ReopenDependencies = {
  verify: (root: string) => Promise<{ manifest: OwnedLaunchManifest }>
  observe: typeof observeProcess
  launch: Pick<LaunchDependencies, "launchDesktop" | "waitForCandidate" | "writeManifest">
  reserve: (manifest: OwnedLaunchManifest) => Promise<() => Promise<void>>
}

/** Reuse the owned service, provider accounts and fixtures after its window closes. */
export async function reopenOwnedDesktop(
  root: string,
  dependencies: ReopenDependencies = {
    verify: verifyOwnedSidecar,
    observe: observeProcess,
    launch: launchDependencies(),
    reserve: async (manifest) => {
      const base = dirname(manifest.root)
      const reservation = await acquireReservation(base, false, manifest.ownerID).catch(() =>
        acquireRecoveryReservation(base, manifest),
      )
      return () => releaseReservation(reservation)
    },
  },
): Promise<OwnedLaunchManifest> {
  const initial = await dependencies.verify(root)
  const release = await dependencies.reserve(initial.manifest)
  try {
    const { manifest } = await dependencies.verify(root)
    if (
      manifest.nativeInteraction?.state === "pending" ||
      manifest.nativeInteraction?.state === "ambiguous"
    )
      throw new Error("Resolve the pending native interaction before reopening Desktop")
    const desktop =
      manifest.desktop &&
      classifyOwnedProcessObservation(manifest.desktop, dependencies.observe(manifest.desktop.pid))
    if (desktop?.kind === "observation-unavailable")
      throw new Error("The owned Desktop process identity could not be observed")
    if (desktop?.kind !== "matching-live") {
      manifest.desktop = await dependencies.launch.launchDesktop({
        root: manifest.root,
        desktopBundle: manifest.target.desktopBundle,
        candidatePath: manifest.candidate.workspace,
      })
      // Retain the new identity even if readiness takes longer or fails.
      await dependencies.launch.writeManifest(manifest)
    }
    await dependencies.launch.waitForCandidate({
      root: manifest.root,
      desktop: manifest.desktop!,
      candidate: manifest.candidate,
    })
    return manifest
  } finally {
    await release()
  }
}

export async function verifyOwnedLaunch(
  root: string,
  options: { allowPendingInteraction?: boolean } = {},
): Promise<{
  manifest: OwnedLaunchManifest
  registration: ServiceRegistration
  health: { pid: number; version: string }
}> {
  const proof = await verifyOwnedSidecar(root)
  const { manifest } = proof
  if (
    manifest.nativeInteraction?.state === "ambiguous" ||
    (manifest.nativeInteraction?.state === "pending" && options.allowPendingInteraction !== true)
  ) {
    throw new Error("A native interaction is pending or ambiguous; do not replay it")
  }
  if (manifest.desktop === undefined) throw new Error("Owned Desktop process identity is missing")
  const desktop = classifyOwnedProcessObservation(
    manifest.desktop,
    observeProcess(manifest.desktop.pid),
  )
  if (desktop.kind !== "matching-live") {
    throw new Error(ownedProcessObservationError("owned Desktop", desktop.kind))
  }
  const inventory = observeProcessesUsing(manifest.root)
  if (inventory.kind === "observation-unavailable") {
    throw new Error("Owned Desktop process inventory is unavailable")
  }
  if (!inventory.processes.some((line) => line.includes(`${manifest.root}/desktop`))) {
    throw new Error("Owned Desktop is not using its isolated test-root profile")
  }
  return proof
}

export function nativeBindingFromManifest(manifest: OwnedLaunchManifest): NativeBinding {
  if (manifest.service === undefined || manifest.desktop === undefined) {
    throw new Error("Owned service or Desktop identity is missing")
  }
  return {
    ownerID: manifest.ownerID,
    createdAt: manifest.createdAt,
    root: manifest.root,
    verificationBase: manifest.baseDirectory ?? dirname(manifest.root),
    candidate: manifest.candidate,
    target: manifest.target,
    service: manifest.service,
    desktop: manifest.desktop,
  }
}

export type NativeInteractionLease = {
  manifest: OwnedLaunchManifest
  finish(input: { state: "idle" | "ambiguous"; message?: string }): Promise<void>
}

export async function beginNativeInteraction(
  root: string,
  requestID: string,
  kind: NonNullable<OwnedLaunchManifest["nativeInteraction"]>["kind"],
): Promise<NativeInteractionLease> {
  const initial = await readManifest(root)
  if (initial.status !== "ready")
    throw new Error("Owned Desktop is not ready for native interaction")
  if (
    initial.nativeInteraction?.state === "pending" ||
    initial.nativeInteraction?.state === "ambiguous"
  ) {
    throw new Error(
      "A previous native interaction is unresolved; inspect its request without replay",
    )
  }
  const base = await realpath(dirname(resolve(root)))
  const reservation = await acquireReservation(base, false, initial.ownerID)
  let finalized = false
  try {
    const manifest = await readManifest(root)
    if (
      manifest.ownerID !== initial.ownerID ||
      manifest.createdAt !== initial.createdAt ||
      manifest.status !== "ready" ||
      manifest.nativeInteraction?.state === "pending" ||
      manifest.nativeInteraction?.state === "ambiguous"
    ) {
      throw new Error("Owned launch changed before native interaction was reserved")
    }
    manifest.nativeInteraction = {
      state: "pending",
      requestID,
      kind,
      updatedAt: new Date().toISOString(),
    }
    await writeManifestFile(runtimePaths(manifest.root).manifest, manifest)
    return {
      manifest,
      finish: async ({ state, message }) => {
        if (finalized) throw new Error("Native interaction lease was already finalized")
        try {
          const current = await readManifest(root)
          if (
            current.ownerID !== manifest.ownerID ||
            current.createdAt !== manifest.createdAt ||
            current.nativeInteraction?.requestID !== requestID ||
            current.nativeInteraction.state !== "pending"
          ) {
            throw new Error("Native interaction manifest changed while a request was pending")
          }
          current.nativeInteraction = {
            state,
            requestID,
            kind,
            updatedAt: new Date().toISOString(),
            ...(message === undefined ? {} : { message: message.slice(0, 256) }),
          }
          if (state === "ambiguous") {
            current.status = "cleanup-blocked"
            current.cleanupIssue =
              "Native interaction delivery is ambiguous; resolve this same request without replay"
          }
          await writeManifestFile(runtimePaths(current.root).manifest, current)
          finalized = true
          if (state === "ambiguous") await retainReservation(reservation)
          else await releaseReservation(reservation)
        } catch (error) {
          await retainReservation(reservation)
          finalized = true
          throw error
        }
      },
    }
  } catch (error) {
    await releaseReservation(reservation)
    throw error
  }
}

export async function resolveNativeInteraction(
  root: string,
  requestID: string,
  outcome: "delivered" | "not-delivered",
): Promise<OwnedLaunchManifest> {
  const initial = await readManifest(root)
  if (
    initial.nativeInteraction?.state === "idle" &&
    initial.nativeInteraction.requestID === requestID
  )
    return initial
  if (
    initial.nativeInteraction?.requestID !== requestID ||
    (initial.nativeInteraction.state !== "pending" &&
      initial.nativeInteraction.state !== "ambiguous")
  ) {
    throw new Error("Native interaction resolution does not match the pending request")
  }
  const base = await realpath(dirname(resolve(root)))
  const reservation = await acquireRecoveryReservation(base, initial)
  try {
    const manifest = await readManifest(root)
    if (
      manifest.ownerID !== initial.ownerID ||
      manifest.nativeInteraction?.requestID !== requestID ||
      (manifest.nativeInteraction.state !== "pending" &&
        manifest.nativeInteraction.state !== "ambiguous")
    ) {
      throw new Error("Native interaction changed during recovery")
    }
    manifest.nativeInteraction = {
      state: "idle",
      requestID,
      updatedAt: new Date().toISOString(),
      message: `Resolved from the sidecar as ${outcome}; no command was replayed`,
    }
    if (
      manifest.status === "cleanup-blocked" &&
      manifest.cleanupIssue?.startsWith("Native interaction delivery is ambiguous")
    ) {
      manifest.status = "ready"
      delete manifest.cleanupIssue
    }
    await writeManifestFile(runtimePaths(manifest.root).manifest, manifest)
    await releaseReservation(reservation)
    return manifest
  } catch (error) {
    await retainReservation(reservation)
    throw error
  }
}

function candidateConfig(workspace: string): string {
  const source = join(resolve(workspace), "src", "index.ts")
  return `export { default } from ${JSON.stringify(source)}\n`
}

async function writeCandidateConfig(paths: RuntimePaths, candidate: Candidate): Promise<void> {
  const packageJSON = {
    name: "opencode-lazers-owned-candidate",
    type: "module",
    exports: {
      ".": "./index.ts",
      "./gui-experimental": "./gui-experimental.cjs",
    },
  }
  await writeFile(
    join(paths.candidatePlugin, "package.json"),
    JSON.stringify(packageJSON, null, 2) + "\n",
    {
      mode: 0o600,
      flag: "wx",
    },
  )
  await writeFile(join(paths.candidatePlugin, "index.ts"), candidateConfig(candidate.workspace), {
    mode: 0o600,
    flag: "wx",
  })
  await symlink(candidate.guiEntry, join(paths.candidatePlugin, "gui-experimental.cjs"), "file")
}

async function inspectDesktop(bundlePath: string, cliPath?: string): Promise<DesktopBundle> {
  if (process.platform !== "darwin")
    throw new Error("Owned OpenCode Desktop launch currently supports macOS only")
  const path = await realpath(bundlePath)
  if (!path.endsWith(".app")) throw new Error("Desktop target must be an explicit .app bundle")
  const info = join(path, "Contents", "Info.plist")
  const bundleID = plutil(info, "CFBundleIdentifier")
  const version = plutil(info, "CFBundleShortVersionString")
  const resources = join(path, "Contents", "Resources")
  const packagedCLIVersion = normalizeVersion(
    await readFile(join(resources, "opencode-cli.version"), "utf8"),
  )
  const executable = join(path, "Contents", "MacOS", "OpenCode")
  const resolvedCLI = cliPath === undefined ? "" : await realpath(cliPath)
  let cliVersion = packagedCLIVersion
  if (resolvedCLI !== "") {
    const cliOutput = command(resolvedCLI, ["--version"])
    cliVersion = normalizeVersion(cliOutput)
    if (cliVersion !== packagedCLIVersion) {
      throw new Error(
        `Desktop CLI version ${cliVersion} does not match packaged ${packagedCLIVersion}`,
      )
    }
  }
  return { path, executable, bundleID, version, cliPath: resolvedCLI, cliVersion }
}

export function normalizeVersion(value: string): string {
  const token = value.trim().split(/\s+/).at(-1) ?? ""
  return token.replace(/^v(?=\d)/i, "")
}

async function inspectCandidate(candidatePath: string): Promise<Candidate> {
  const workspace = await realpath(candidatePath)
  const revision = command("git", ["-C", workspace, "rev-parse", "HEAD"]).trim()
  if (!/^[0-9a-f]{40,64}$/.test(revision))
    throw new Error("Candidate workspace has no stable Git revision")
  const dirtyPaths = command("git", [
    "-C",
    workspace,
    "status",
    "--porcelain",
    "--untracked-files=all",
  ])
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3))
  const pluginEntry = join(workspace, "src", "index.ts")
  const pluginStat = await lstat(pluginEntry)
  if (!pluginStat.isFile() || pluginStat.isSymbolicLink()) {
    throw new Error("Candidate plugin entry must be a regular workspace file")
  }
  const architectPath = join(workspace, "src", "architect.md")
  const architectStat = await lstat(architectPath)
  if (!architectStat.isFile() || architectStat.isSymbolicLink()) {
    throw new Error("Candidate Architect definition must be a regular workspace file")
  }
  const agent = await readFile(architectPath, "utf8")
  const guiEntry = join(workspace, "dist", "gui-experimental.cjs")
  const guiStat = await lstat(guiEntry, { bigint: true }).catch(() => undefined)
  if (guiStat === undefined || !guiStat.isFile() || guiStat.isSymbolicLink()) {
    throw new Error(
      "Candidate Desktop GUI bundle is missing; run the project GUI build before launch",
    )
  }
  const guiEntryBytes = Number(guiStat.size)
  if (!Number.isSafeInteger(guiEntryBytes) || guiEntryBytes > 2_147_483_647) {
    throw new Error("Candidate Desktop GUI bundle exceeds the supported identity size")
  }
  const match = /^description:\s*(.+)$/m.exec(agent)
  if (!match) throw new Error("Candidate Architect definition does not declare a description")
  return {
    workspace,
    revision,
    dirtyPaths,
    pluginEntry,
    guiEntry,
    guiEntryBytes,
    guiEntryModifiedAt: candidateMtimeFromNanoseconds(guiStat.mtimeNs),
    architectDescription: match[1]!.trim(),
  }
}

export function candidateMtimeFromNanoseconds(mtimeNs: bigint): string {
  const milliseconds = Number(mtimeNs / 1_000_000n)
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error("Candidate modification time is outside the supported range")
  }
  const date = new Date(milliseconds)
  if (Number.isNaN(date.getTime())) {
    throw new Error("Candidate modification time is invalid")
  }
  return date.toISOString()
}

export function candidateIdentityDifferences(
  actual: CandidateIdentity,
  expected: CandidateIdentity,
): Array<keyof CandidateIdentity> {
  // These paths bind interaction to the owned checkout. Source/build metadata is
  // observation context for Architect review, not permission to use that instance.
  const fields: Array<keyof CandidateIdentity> = ["workspace", "pluginEntry", "guiEntry"]
  return fields.filter((field) => actual[field] !== expected[field])
}

export function sameCandidateIdentity(
  actual: CandidateIdentity,
  expected: CandidateIdentity,
): boolean {
  return candidateIdentityDifferences(actual, expected).length === 0
}

async function probeLoginShell(env: NodeJS.ProcessEnv): Promise<Map<string, string>> {
  const shell = spawnSync("/bin/zsh", ["-il", "-c", "env -0"], {
    env,
    encoding: "buffer",
    timeout: 5_000,
    stdio: ["ignore", "pipe", "ignore"],
  })
  if (shell.status !== 0 || shell.error)
    throw new Error("Could not establish the isolated Desktop login-shell environment")
  return parseShellEnvironment(shell.stdout)
}

async function reserveLoopbackPort(): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const server = createServer()
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => resolvePromise())
    })
    const address = server.address()
    if (address === null || typeof address === "string") {
      server.close()
      throw new Error("Could not reserve an owned loopback endpoint")
    }
    const port = address.port
    await new Promise<void>((resolvePromise, reject) => {
      server.close((error) => (error ? reject(error) : resolvePromise()))
    })
    if (port !== DEFAULT_SERVICE_PORT) return port
  }
  throw new Error("Could not reserve an endpoint distinct from OpenCode's default service port")
}

function servicePortFromCommand(value: string): number {
  const match = /(?:^|\s)--port(?:=|\s+)(\d+)(?:\s|$)/.exec(value)
  const port = match === null ? Number.NaN : Number(match[1])
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("Owned service process identity does not include its reserved port")
  }
  return port
}

async function authenticatedServiceInfo(
  registration: ServiceRegistration,
  timeoutMs: number,
): Promise<{ pid: number; version: string }> {
  if (registration.password === undefined)
    throw new Error("Owned service registration has no authentication token")
  assertServiceEndpoint(registration.url)
  const response = await fetch(new URL("/api/info", registration.url), {
    headers: {
      authorization: `Basic ${Buffer.from(`opencode:${registration.password}`).toString("base64")}`,
    },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  })
  if (!response.ok)
    throw new Error(`Authenticated owned-service probe returned HTTP ${response.status}`)
  const body: unknown = await response.json()
  if (
    typeof body !== "object" ||
    body === null ||
    !("pid" in body) ||
    typeof body.pid !== "number" ||
    !Number.isSafeInteger(body.pid) ||
    !("version" in body) ||
    typeof body.version !== "string"
  ) {
    throw new Error("Authenticated owned-service probe returned malformed process identity")
  }
  return { pid: body.pid, version: body.version }
}

function assertServiceEndpoint(value: string, expectedPort?: number): void {
  const endpoint = new URL(value)
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.port.length === 0 ||
    Number(endpoint.port) < 1 ||
    Number(endpoint.port) > 65535 ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.pathname !== "/" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new Error("Owned service endpoint is not an authenticated loopback listener")
  }
  if (expectedPort !== undefined && Number(endpoint.port) !== expectedPort) {
    throw new Error("Owned service registration does not use the reserved endpoint")
  }
}

async function waitForProcessIdentity(
  pid: number,
  executable: string,
  args: ReadonlyArray<string>,
): Promise<ProcessIdentity> {
  const expected = [executable, ...args].join(" ")
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const observed = observeProcess(pid)
    if (
      observed.kind === "live" &&
      observed.identity.command.includes(executable) &&
      args.every((argument) => observed.identity.command.includes(argument))
    ) {
      return { ...observed.identity, command: expected }
    }
    await delay(50)
  }
  throw new Error(`Could not identify owned process ${pid} as ${executable}`)
}

export type ProcessProbeResult = {
  status: number | null
  stdout: string
  error?: Error
}

export function processObservationFromProbe(
  pid: number,
  result: ProcessProbeResult,
): ProcessObservation {
  if (result.error !== undefined) return { kind: "observation-unavailable", reason: "probe-error" }
  const output = result.stdout.trim()
  if (result.status === 1 && output.length === 0) return { kind: "authoritatively-absent" }
  if (result.status !== 0) return { kind: "observation-unavailable", reason: "unexpected-exit" }
  const match = /^(.{24})\s+(.+)$/.exec(output)
  if (match === null) return { kind: "observation-unavailable", reason: "malformed-output" }
  return {
    kind: "live",
    identity: { pid, startedAt: match[1]!.trim(), command: match[2]! },
  }
}

export function classifyOwnedProcessObservation(
  expected: ProcessIdentity,
  observed: ProcessObservation,
): OwnedProcessObservation {
  if (observed.kind === "authoritatively-absent") return observed
  if (observed.kind === "observation-unavailable") return observed
  if (
    observed.identity.startedAt === expected.startedAt &&
    observed.identity.command.includes(expected.command)
  ) {
    return { kind: "matching-live", identity: observed.identity }
  }
  return { kind: "identity-changed", identity: observed.identity }
}

function ownedProcessObservationError(
  resource: string,
  kind: OwnedProcessObservation["kind"],
): string {
  switch (kind) {
    case "authoritatively-absent":
      return `The ${resource} process is absent`
    case "identity-changed":
      return `The ${resource} process identity changed`
    case "observation-unavailable":
      return `The ${resource} process identity could not be observed`
    case "matching-live":
      return `The ${resource} process is live`
  }
}

export function observeProcess(pid: number, timeoutMs = 2_000): ProcessObservation {
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], {
    encoding: "utf8",
    timeout: Math.max(1, timeoutMs),
  })
  return processObservationFromProbe(pid, result)
}

export function processInventoryFromProbe(
  root: string,
  result: ProcessProbeResult,
): ProcessInventoryObservation {
  if (result.error !== undefined) {
    return { kind: "observation-unavailable", reason: "probe-error" }
  }
  if (result.status !== 0) return { kind: "observation-unavailable", reason: "unexpected-exit" }
  if (result.stdout.trim().length === 0) {
    return { kind: "observation-unavailable", reason: "malformed-output" }
  }
  const marker = join(resolve(root), "desktop")
  return {
    kind: "observed",
    processes: result.stdout.split("\n").filter((line) => line.includes(marker)),
  }
}

export function observeProcessesUsing(
  root: string,
  timeoutMs = 2_000,
): ProcessInventoryObservation {
  const result = spawnSync("/bin/ps", ["-axo", "command="], {
    encoding: "utf8",
    timeout: Math.max(1, timeoutMs),
  })
  return processInventoryFromProbe(root, result)
}

export type DesktopProcessStopDependencies = {
  observeProcess(pid: number, timeoutMs: number): ProcessObservation
  observeProcessesUsing(root: string, timeoutMs: number): ProcessInventoryObservation
  signal(pid: number, signal: NodeJS.Signals): void
  now(): number
  delay(ms: number): Promise<void>
}

const desktopProcessStopDependencies: DesktopProcessStopDependencies = {
  observeProcess,
  observeProcessesUsing,
  signal: (pid, signal) => process.kill(pid, signal),
  now: Date.now,
  delay,
}

async function observeExpectedProcessUntilKnown(
  expected: ProcessIdentity,
  deadline: number,
  dependencies: DesktopProcessStopDependencies,
): Promise<OwnedProcessObservation> {
  let lastReason: ProcessObservationFailure = "unexpected-exit"
  while (dependencies.now() < deadline) {
    const remaining = deadline - dependencies.now()
    const current = classifyOwnedProcessObservation(
      expected,
      dependencies.observeProcess(expected.pid, Math.min(2_000, remaining)),
    )
    if (current.kind !== "observation-unavailable") return current
    lastReason = current.reason
    await dependencies.delay(Math.min(100, Math.max(1, deadline - dependencies.now())))
  }
  return { kind: "observation-unavailable", reason: lastReason }
}

export async function waitUntilGone(
  expected: ProcessIdentity,
  timeoutMs: number,
  dependencies: Pick<
    DesktopProcessStopDependencies,
    "observeProcess" | "now" | "delay"
  > = desktopProcessStopDependencies,
): Promise<ProcessExitObservation> {
  const deadline = dependencies.now() + timeoutMs
  let lastObservation: OwnedProcessObservation | undefined
  while (dependencies.now() < deadline) {
    const remaining = deadline - dependencies.now()
    lastObservation = classifyOwnedProcessObservation(
      expected,
      dependencies.observeProcess(expected.pid, Math.min(2_000, remaining)),
    )
    if (lastObservation.kind === "authoritatively-absent") return { kind: "observed-exited" }
    if (lastObservation.kind === "identity-changed") return { kind: "identity-changed" }
    if (lastObservation.kind === "observation-unavailable") {
      await dependencies.delay(Math.min(100, Math.max(1, deadline - dependencies.now())))
      continue
    }
    await dependencies.delay(Math.min(100, Math.max(1, deadline - dependencies.now())))
  }
  if (lastObservation?.kind === "observation-unavailable") {
    return { kind: "observation-unavailable", reason: lastObservation.reason }
  }
  return { kind: "main-still-live" }
}

function cleanupOutcomeFromExitObservation(
  observation: ProcessExitObservation,
): OwnedCleanupOutcome {
  switch (observation.kind) {
    case "observed-exited":
      return "stopped"
    case "main-still-live":
      return "main-still-live"
    case "identity-changed":
      return "identity-changed"
    case "observation-unavailable":
      return "observation-unavailable"
  }
}

export async function stopOwnedDesktopProcess(
  desktop: ProcessIdentity,
  root: string,
  overrides: Partial<DesktopProcessStopDependencies> = {},
): Promise<OwnedCleanupOutcome> {
  const dependencies = { ...desktopProcessStopDependencies, ...overrides }
  const deadline = dependencies.now() + SHUTDOWN_TIMEOUT_MS
  const initial = await observeExpectedProcessUntilKnown(desktop, deadline, dependencies)
  if (initial.kind === "observation-unavailable") return "observation-unavailable"
  if (initial.kind === "identity-changed") return "identity-changed"

  const wasAbsent = initial.kind === "authoritatively-absent"
  if (initial.kind === "matching-live") {
    dependencies.signal(desktop.pid, "SIGTERM")
    const remaining = Math.max(0, deadline - dependencies.now())
    const exit = await waitUntilGone(desktop, remaining, dependencies)
    if (exit.kind !== "observed-exited") return cleanupOutcomeFromExitObservation(exit)
  }

  let lastInventory: ProcessInventoryObservation | undefined
  while (dependencies.now() < deadline) {
    const remaining = deadline - dependencies.now()
    lastInventory = dependencies.observeProcessesUsing(root, Math.min(2_000, remaining))
    if (lastInventory.kind === "observed" && lastInventory.processes.length === 0) {
      return wasAbsent ? "already-stopped" : "stopped"
    }
    await dependencies.delay(Math.min(100, Math.max(1, deadline - dependencies.now())))
  }
  if (lastInventory?.kind === "observation-unavailable") return "helper-observation-unavailable"
  if (lastInventory?.processes.length) return "helpers-remain"
  return "helper-observation-unavailable"
}

async function stopOwnedServiceProcess(
  manifest: OwnedLaunchManifest,
): Promise<OwnedCleanupOutcome> {
  const service = manifest.service
  if (service === undefined) return "already-stopped"
  const paths = runtimePaths(manifest.root)
  const pendingIdentity = service.id.length === 0 || service.url.length === 0
  const observed = observeProcess(service.process.pid)
  if (observed.kind === "observation-unavailable") return "observation-unavailable"
  if (observed.kind === "authoritatively-absent") {
    const registration = await readRegistrationMaybe(paths.serviceRegistration)
    if (registration === undefined) {
      if (await exists(paths.serviceRegistration)) return "ambiguous"
      return "already-stopped"
    }
    if (registration.pid !== service.process.pid || registration.version !== service.version)
      return "ambiguous"
    if (!pendingIdentity && (registration.id !== service.id || registration.url !== service.url))
      return "ambiguous"
    if (
      pendingIdentity &&
      Number(new URL(registration.url).port) !== servicePortFromCommand(service.process.command)
    ) {
      return "ambiguous"
    }
    await rm(paths.serviceRegistration)
    return "already-stopped"
  }
  const identity = observed.identity
  if (
    identity.startedAt !== service.process.startedAt ||
    !identity.command.includes(service.process.command)
  )
    return "identity-changed"
  const registration = await readRegistrationMaybe(paths.serviceRegistration)
  if (pendingIdentity) {
    if (
      ((await exists(paths.serviceRegistration)) && registration === undefined) ||
      (registration !== undefined &&
        (registration.pid !== service.process.pid ||
          registration.version !== service.version ||
          Number(new URL(registration.url).port) !==
            servicePortFromCommand(service.process.command)))
    )
      return "ambiguous"
    process.kill(service.process.pid, "SIGTERM")
    const exit = await waitUntilGone(service.process, SHUTDOWN_TIMEOUT_MS)
    if (exit.kind !== "observed-exited") return cleanupOutcomeFromExitObservation(exit)
    const remaining = await readRegistrationMaybe(paths.serviceRegistration)
    if (remaining !== undefined) {
      if (
        remaining.pid !== service.process.pid ||
        remaining.version !== service.version ||
        Number(new URL(remaining.url).port) !== servicePortFromCommand(service.process.command)
      )
        return "ambiguous"
      await rm(paths.serviceRegistration)
    } else if (await exists(paths.serviceRegistration)) {
      return "ambiguous"
    }
    return "stopped"
  }
  if (
    registration === undefined ||
    registration.id !== service.id ||
    registration.pid !== service.process.pid ||
    registration.url !== service.url ||
    registration.version !== service.version ||
    registration.password === undefined
  )
    return "ambiguous"
  assertServiceEndpoint(registration.url, servicePortFromCommand(service.process.command))
  try {
    const health = await authenticatedServiceInfo(registration, 1_000)
    if (health.pid !== service.process.pid || health.version !== service.version) return "ambiguous"
  } catch {
    return "ambiguous"
  }
  process.kill(service.process.pid, "SIGTERM")
  const exit = await waitUntilGone(service.process, SHUTDOWN_TIMEOUT_MS)
  if (exit.kind !== "observed-exited") return cleanupOutcomeFromExitObservation(exit)
  const remaining = await readRegistrationMaybe(paths.serviceRegistration)
  if (remaining !== undefined) {
    if (
      remaining.id !== service.id ||
      remaining.pid !== service.process.pid ||
      remaining.url !== service.url ||
      remaining.version !== service.version
    )
      return "ambiguous"
    await rm(paths.serviceRegistration)
  }
  return "stopped"
}

async function readRegistrationMaybe(path: string): Promise<ServiceRegistration | undefined> {
  try {
    return parseServiceRegistration(JSON.parse(await readFile(path, "utf8")) as unknown)
  } catch {
    return undefined
  }
}

async function removeOwnedRoot(
  root: string,
  ownerID: string,
  baseDirectory: string,
): Promise<void> {
  const paths = runtimePaths(root)
  const rootInfo = await lstat(root)
  const canonicalRoot = await realpath(root)
  const canonicalBase = await realpath(baseDirectory)
  if (
    !rootInfo.isDirectory() ||
    rootInfo.isSymbolicLink() ||
    canonicalRoot !== paths.root ||
    dirname(canonicalRoot) !== canonicalBase ||
    !basename(canonicalRoot).startsWith("lazers-full-instance-")
  ) {
    throw new Error("Owned test root identity is ambiguous; it was not removed")
  }
  const info = await lstat(paths.owner)
  if (info.isSymbolicLink() || !info.isFile())
    throw new Error("Owned root marker is not a regular file")
  const owner = JSON.parse(await readFile(paths.owner, "utf8")) as {
    ownerID?: unknown
    root?: unknown
  }
  if (owner.ownerID !== ownerID || owner.root !== canonicalRoot) {
    throw new Error("Owned root marker changed; it was not removed")
  }
  const inventory = observeProcessesUsing(canonicalRoot)
  if (inventory.kind === "observation-unavailable") {
    throw new Error("Owned Desktop helper-process inventory is unavailable; root was not removed")
  }
  if (inventory.processes.length > 0) {
    throw new Error("Owned Desktop helpers still reference the test root; it was not removed")
  }
  await rm(canonicalRoot, { recursive: true, force: false })
}

function plutil(path: string, key: string): string {
  return command("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", path]).trim()
}

function command(executable: string, args: string[]): string {
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 5_000 })
  if (result.status !== 0 || result.error) {
    const detail = result.stderr?.trim() || result.error?.message || `exit ${result.status}`
    throw new Error(`${executable} ${args.join(" ")} failed: ${detail}`)
  }
  return result.stdout
}

async function readProtocolHandler(): Promise<string | null> {
  const script = [
    "import CoreServices",
    "import Foundation",
    'let value = LSCopyDefaultHandlerForURLScheme("opencode" as CFString)?.takeRetainedValue() as String?',
    'print(value ?? "")',
  ].join("\n")
  const result = spawnSync("/usr/bin/swift", ["-e", script], {
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "ignore"],
  })
  if (result.status !== 0 || result.error) {
    throw new Error("Could not read the opencode:// protocol-handler baseline")
  }
  return result.stdout.trim() || null
}

async function restoreProtocolHandler(handlerID: string): Promise<void> {
  const script = [
    "import CoreServices",
    "import Foundation",
    'let status = LSSetDefaultHandlerForURLScheme("opencode" as CFString, CommandLine.arguments[1] as CFString)',
    "if status != noErr { exit(1) }",
  ].join("\n")
  const result = spawnSync("/usr/bin/swift", ["-e", script, handlerID], {
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "ignore"],
  })
  if (result.status !== 0 || result.error) {
    throw new Error("Launch Services did not restore the captured opencode:// handler")
  }
}

async function writeManifestFile(path: string, manifest: OwnedLaunchManifest): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600, flag: "wx" })
  await rename(temporary, path)
}

function isSpawnedService(value: unknown): value is SpawnedService {
  if (typeof value !== "object" || value === null) return false
  const spawned = value as Record<string, unknown>
  return (
    typeof spawned.pid === "number" &&
    Number.isSafeInteger(spawned.pid) &&
    spawned.pid > 0 &&
    typeof spawned.command === "string" &&
    spawned.command.length > 0 &&
    typeof spawned.spawnedAt === "number" &&
    Number.isSafeInteger(spawned.spawnedAt) &&
    spawned.spawnedAt > 0
  )
}

async function readManifestFile(path: string): Promise<OwnedLaunchManifest> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as OwnedLaunchManifest
  if (
    parsed.schemaVersion !== 1 ||
    typeof parsed.ownerID !== "string" ||
    typeof parsed.root !== "string" ||
    parsed.root !== resolve(parsed.root) ||
    (parsed.baseDirectory !== undefined &&
      (typeof parsed.baseDirectory !== "string" ||
        parsed.baseDirectory !== resolve(parsed.baseDirectory))) ||
    !(typeof parsed.protocolHandlerBaseline === "string" || parsed.protocolHandlerBaseline === null)
  ) {
    throw new Error("Owned launch manifest is malformed")
  }
  if (
    parsed.serviceStartupPending !== undefined &&
    typeof parsed.serviceStartupPending !== "boolean"
  ) {
    throw new Error("Owned launch service startup intent is malformed")
  }
  if (parsed.pendingService !== undefined && !isSpawnedService(parsed.pendingService)) {
    throw new Error("Owned launch unconfirmed service ownership is malformed")
  }
  if (parsed.nativeInteraction !== undefined) {
    const interaction = parsed.nativeInteraction as Record<string, unknown>
    if (
      typeof interaction !== "object" ||
      interaction === null ||
      !["idle", "pending", "ambiguous"].includes(String(interaction.state)) ||
      (interaction.requestID !== undefined && typeof interaction.requestID !== "string") ||
      (interaction.kind !== undefined &&
        ![
          "snapshot",
          "capture",
          "focus",
          "click",
          "type",
          "key",
          "dictation-fixture",
          "playback-plan",
        ].includes(String(interaction.kind))) ||
      (interaction.updatedAt !== undefined && typeof interaction.updatedAt !== "string") ||
      (interaction.message !== undefined && typeof interaction.message !== "string")
    ) {
      throw new Error("Owned launch native-interaction state is malformed")
    }
  }
  return parsed
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isCode(error, "ENOENT")) return false
    throw error
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

type Reservation = {
  path: string
  ownerID: string
  pid: number
  handle: Awaited<ReturnType<typeof open>>
}

type ReservationRecord = {
  ownerID: string
  pid: number
  state: "active" | "blocked"
}

async function acquireReservation(
  base: string,
  recoveryOwner = false,
  ownerID: string = crypto.randomUUID(),
): Promise<Reservation> {
  const recoveryPath = join(base, ".reservation-recovery")
  if (!recoveryOwner && (await exists(recoveryPath))) {
    throw new Error("Owned-launch cleanup is in progress")
  }
  const path = join(base, ".reservation")
  const pid = process.pid
  let handle: Reservation["handle"]
  try {
    handle = await open(path, "wx", 0o600)
  } catch (error) {
    if (isCode(error, "EEXIST")) {
      const owner = await readReservation(path)
      const active = owner === undefined || (owner.state === "active" && processExists(owner.pid))
      throw new Error(
        active
          ? "An owned Desktop launch or cleanup is active; refusing a duplicate operation"
          : "A previous launch reservation needs owned cleanup before another launch",
        { cause: error },
      )
    }
    throw error
  }
  const reservation = { path, ownerID, pid, handle }
  await handle.writeFile(
    JSON.stringify({ ownerID, pid, state: "active" } satisfies ReservationRecord),
  )
  await handle.sync()
  if (!recoveryOwner && (await exists(recoveryPath))) {
    await releaseReservation(reservation)
    throw new Error("Owned-launch cleanup began concurrently; launch was not started")
  }
  return reservation
}

async function acquireRecoveryReservation(
  base: string,
  manifest: OwnedLaunchManifest,
): Promise<Reservation> {
  const recoveryPath = join(base, ".reservation-recovery")
  try {
    await mkdir(recoveryPath, { mode: 0o700 })
  } catch {
    throw new Error("An owned-launch operation or cleanup recovery is active")
  }
  try {
    const path = join(base, ".reservation")
    if (await exists(path)) {
      const before = await readFile(path, "utf8")
      const owner = parseReservation(before)
      if (
        owner === undefined ||
        owner.ownerID !== manifest.ownerID ||
        (owner.state === "active" && processExists(owner.pid))
      ) {
        throw new Error("Launch reservation is active or does not belong to this test root")
      }
      const marker = JSON.parse(await readFile(runtimePaths(manifest.root).owner, "utf8")) as {
        ownerID?: unknown
        root?: unknown
      }
      if (marker.ownerID !== manifest.ownerID || marker.root !== manifest.root) {
        throw new Error("Stale reservation does not match the owned test-root marker")
      }
      if ((await readFile(path, "utf8")) !== before)
        throw new Error("Reservation changed during recovery")
      await rm(path)
    }
    const reservation = await acquireReservation(base, true, manifest.ownerID)
    await rm(recoveryPath, { recursive: true })
    return reservation
  } catch (error) {
    await rm(recoveryPath, { recursive: true, force: true })
    throw error
  }
}

async function releaseReservation(reservation: Reservation): Promise<void> {
  if (reservation.handle.fd !== -1) await reservation.handle.close()
  try {
    const current = parseReservation(await readFile(reservation.path, "utf8"))
    if (current?.ownerID === reservation.ownerID && current.pid === reservation.pid) {
      await rm(reservation.path)
    }
  } catch {
    // Keep a replaced or malformed marker as a fail-closed startup blocker.
  }
}

async function retainReservation(reservation: Reservation): Promise<void> {
  if (reservation.handle.fd === -1) return
  const record: ReservationRecord = {
    ownerID: reservation.ownerID,
    pid: reservation.pid,
    state: "blocked",
  }
  const value = JSON.stringify(record)
  await reservation.handle.truncate(0)
  await reservation.handle.write(value, 0, "utf8")
  await reservation.handle.truncate(Buffer.byteLength(value))
  await reservation.handle.sync()
  await reservation.handle.close()
}

async function readReservation(path: string): Promise<ReservationRecord | undefined> {
  try {
    return parseReservation(await readFile(path, "utf8"))
  } catch {
    return undefined
  }
}

function parseReservation(value: string): ReservationRecord | undefined {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    if (
      typeof parsed.ownerID !== "string" ||
      typeof parsed.pid !== "number" ||
      !Number.isSafeInteger(parsed.pid) ||
      parsed.pid < 1 ||
      (parsed.state !== "active" && parsed.state !== "blocked")
    )
      return undefined
    return { ownerID: parsed.ownerID, pid: parsed.pid, state: parsed.state }
  } catch {
    return undefined
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isCode(error, "EPERM")
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code
}

async function assertNoPendingLaunch(base: string): Promise<void> {
  const entries = await readdir(base, { withFileTypes: true })
  const pending = entries.find((entry) => entry.name.startsWith("lazers-full-instance-"))
  if (pending !== undefined) {
    throw new Error(
      `Existing owned test root ${pending.name} requires inspection or cleanup before another launch`,
    )
  }
}
