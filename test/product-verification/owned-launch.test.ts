import { describe, expect, test } from "bun:test"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  assertCandidateAgent,
  assertEffectiveIsolation,
  assertOwnedService,
  assertProtocolBaseline,
  candidateMtimeFromNanoseconds,
  cleanupOwnedDesktop,
  classifyOwnedProcessObservation,
  candidateIdentityDifferences,
  defaultBaseDirectory,
  isolatedEnvironment,
  normalizeVersion,
  observeProcess,
  openDesktopProcessLog,
  parseServiceRegistration,
  processInventoryFromProbe,
  processObservationFromProbe,
  readManifest,
  reopenOwnedDesktop,
  resolveNativeInteraction,
  runtimePaths,
  sameCandidateIdentity,
  ServiceNotStartedError,
  startOwnedDesktop,
  stopOwnedDesktopProcess,
  waitUntilGone,
} from "../../src/verification/opencode/owned-launch.ts"
import type {
  CandidateIdentity,
  LaunchDependencies,
  OwnedLaunchManifest,
  ProcessIdentity,
  ServiceRegistration,
} from "../../src/verification/opencode/owned-launch.ts"

test("Desktop reopen retains old output and allocates independent launch logs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lazers-desktop-logs-"))
  try {
    await writeFile(join(directory, "desktop-process.log"), "original output")
    const first = await openDesktopProcessLog(directory)
    const second = await openDesktopProcessLog(directory)
    try {
      await first.writeFile("first reopen")
      await second.writeFile("second reopen")
    } finally {
      await first.close()
      await second.close()
    }
    const logs = await readdir(directory)
    expect(logs).toHaveLength(3)
    expect(await readFile(join(directory, "desktop-process.log"), "utf8")).toBe("original output")
    const contents = await Promise.all(logs.map((name) => readFile(join(directory, name), "utf8")))
    expect(contents.toSorted()).toEqual(["first reopen", "original output", "second reopen"])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

const input = {
  desktopBundle: "/Applications/OpenCode.app",
  cliPath: "/Applications/OpenCode.app/Contents/Resources/opencode-cli",
  candidatePath: "/workspace/candidate",
  targetPath: "/workspace/candidate",
}
const root = "/private/tmp/lazers-full-instance-test"
const candidate: CandidateIdentity = {
  workspace: input.candidatePath,
  revision: "a".repeat(40),
  dirtyPaths: ["src/verification/opencode/owned-launch.ts"],
  pluginEntry: `${input.candidatePath}/src/index.ts`,
  guiEntry: `${input.candidatePath}/dist/gui-experimental.cjs`,
  guiEntryBytes: 123456,
  guiEntryModifiedAt: "2026-11-01T11:59:00.000Z",
  architectDescription: "Defines scoped tasks and acceptance evidence from repository findings",
}
const serviceProcess: ProcessIdentity = {
  pid: 24001,
  startedAt: "Sun Nov  1 12:00:00 2026",
  command: `${input.cliPath} serve --service --hostname 127.0.0.1 --port 52123`,
}
const desktopProcess: ProcessIdentity = {
  pid: 24002,
  startedAt: "Sun Nov  1 12:01:00 2026",
  command: `${input.desktopBundle}/Contents/MacOS/OpenCode`,
}
const registration: ServiceRegistration = {
  id: "owned-instance",
  version: "2.2.5",
  url: "http://127.0.0.1:52123",
  pid: serviceProcess.pid,
  password: "test-secret-never-printed",
}

function environment(): Map<string, string> {
  const paths = runtimePaths(root)
  return new Map([
    ["HOME", paths.desktopHome],
    ["CFFIXED_USER_HOME", paths.desktopHome],
    ["OPENCODE_DESKTOP_TEST_ROOT", paths.root],
    ["TMPDIR", paths.tempHome],
    ["OPENCODE_LAZERS_VERIFICATION_BASE", dirname(paths.root)],
    ["XDG_DATA_HOME", paths.dataHome],
    ["XDG_CONFIG_HOME", paths.configHome],
    ["XDG_CACHE_HOME", paths.cacheHome],
    ["XDG_STATE_HOME", paths.stateHome],
  ])
}

function dependencies(
  options: {
    existingRegistration?: boolean
    authenticated?: boolean
    registration?: ServiceRegistration
    agentPresent?: boolean
    cleanupClean?: boolean
  } = {},
) {
  const calls: string[] = []
  const written: OwnedLaunchManifest[] = []
  const prepared = {
    root,
    ownerID: "owner-id",
    bundleID: "ai.opencode.desktop",
    desktopVersion: "2.2.5",
    cliVersion: "2.2.5",
    candidate,
    protocolHandler: "ai.opencode.desktop",
    existingRegistration: options.existingRegistration ?? false,
    effectiveEnvironment: environment(),
  }
  const deps: LaunchDependencies = {
    prepare: async () => {
      calls.push("prepare")
      return prepared
    },
    startService: async ({ onSpawn }) => {
      calls.push("service")
      expect(written.at(-1)?.serviceStartupPending).toBe(true)
      await onSpawn({
        pid: serviceProcess.pid,
        command: serviceProcess.command,
        spawnedAt: 1793538000000,
      })
      return serviceProcess
    },
    waitForService: async () => {
      calls.push("service-ready")
      return {
        registration: options.registration ?? registration,
        health: { pid: serviceProcess.pid, version: "2.2.5" },
        registrationPath: runtimePaths(root).serviceRegistration,
        authenticated: options.authenticated ?? true,
      }
    },
    launchDesktop: async () => {
      calls.push("desktop")
      return desktopProcess
    },
    waitForCandidate: async () => {
      calls.push("candidate-ready")
      return {
        agents:
          options.agentPresent === false
            ? []
            : [{ id: "architect", mode: "primary", description: candidate.architectDescription }],
      }
    },
    writeManifest: async (value) => {
      written.push(structuredClone(value))
      calls.push(`write:${value.status}`)
    },
    cleanup: async () => {
      calls.push("cleanup")
      return options.cleanupClean === false
        ? { clean: false, reason: "owned process did not stop" }
        : { clean: true }
    },
    abortPrepared: async () => {
      calls.push("abort-prepared")
    },
    releaseReservation: async () => {
      calls.push("release")
    },
    retainBlockedReservation: async () => {
      calls.push("retain")
    },
    protocolHandler: async () => prepared.protocolHandler,
    now: () => "2026-11-01T12:00:00.000Z",
  }
  return { deps, calls, written, prepared }
}

function manifest(overrides: Partial<OwnedLaunchManifest> = {}): OwnedLaunchManifest {
  return {
    schemaVersion: 1,
    ownerID: "owner-id",
    status: "ready",
    createdAt: "2026-11-01T12:00:00.000Z",
    root,
    baseDirectory: dirname(root),
    candidate,
    target: {
      desktopBundle: input.desktopBundle,
      bundleID: "ai.opencode.desktop",
      version: "2.2.5",
      cliPath: input.cliPath,
      cliVersion: "2.2.5",
      workspace: input.targetPath,
      effectiveStateHome: runtimePaths(root).stateHome,
      serviceRegistrationPath: runtimePaths(root).serviceRegistration,
    },
    protocolHandlerBaseline: "ai.opencode.desktop",
    service: {
      process: serviceProcess,
      id: registration.id!,
      version: registration.version!,
      url: registration.url,
    },
    desktop: desktopProcess,
    observations: [],
    ...overrides,
  }
}

describe("owned Desktop launch proof", () => {
  test("canonicalizes candidate mtimes to whole milliseconds across JS runtimes", () => {
    expect(candidateMtimeFromNanoseconds(1_793_586_216_175_513_541n)).toBe(
      "2026-11-02T02:23:36.175Z",
    )
    expect(candidateMtimeFromNanoseconds(1_793_586_216_175_999_999n)).toBe(
      "2026-11-02T02:23:36.175Z",
    )
    expect(candidateMtimeFromNanoseconds(1_793_586_216_176_000_000n)).toBe(
      "2026-11-02T02:23:36.176Z",
    )
  })

  test("uses an isolated effective state path and registration, and launches only after service identity is authenticated", async () => {
    const { deps, calls, written } = dependencies()
    const result = await startOwnedDesktop(input, deps)

    expect(written.some((value) => value.pendingService?.pid === serviceProcess.pid)).toBe(true)
    expect(result.pendingService).toBeUndefined()
    expect(result.serviceStartupPending).toBeUndefined()
    expect(result.service?.process).toEqual(serviceProcess)
    expect(result.status).toBe("ready")
    expect(result.target.serviceRegistrationPath).toBe(runtimePaths(root).serviceRegistration)
    expect(calls.indexOf("service-ready")).toBeLessThan(calls.indexOf("desktop"))
    expect(calls.indexOf("desktop")).toBeLessThan(calls.indexOf("candidate-ready"))
    expect(calls.at(-1)).toBe("release")
  })

  test("isolates HOME so Desktop default projects stay under the owned root", () => {
    const paths = runtimePaths(root)
    expect(isolatedEnvironment(root).HOME).toBe(paths.desktopHome)
    expect(isolatedEnvironment(root).CFFIXED_USER_HOME).toBe(paths.desktopHome)
    expect(() => assertEffectiveIsolation(root, environment())).not.toThrow()

    const leakedHome = environment()
    leakedHome.set("HOME", "/Users/test")
    expect(() => assertEffectiveIsolation(root, leakedHome)).toThrow("isolated HOME")

    const leakedFixedHome = environment()
    leakedFixedHome.set("CFFIXED_USER_HOME", "/Users/test")
    expect(() => assertEffectiveIsolation(root, leakedFixedHome)).toThrow(
      "isolated CFFIXED_USER_HOME",
    )
  })

  test("blocks a pre-existing isolated registration before starting a service or Desktop", async () => {
    const { deps, calls } = dependencies({ existingRegistration: true })
    await expect(startOwnedDesktop(input, deps)).rejects.toThrow(
      "already has a service registration",
    )
    expect(calls).not.toContain("service")
    expect(calls).not.toContain("desktop")
    expect(calls).toContain("abort-prepared")
    expect(calls).toContain("release")
  })

  test("blocks unsafe shell path changes before starting any service", async () => {
    const { deps, calls, prepared } = dependencies()
    const broken = new Map(environment())
    broken.set("XDG_STATE_HOME", "/Users/test/.local/state")
    deps.prepare = async () => ({ ...prepared, effectiveEnvironment: broken })
    await expect(startOwnedDesktop(input, deps)).rejects.toThrow("isolated XDG_STATE_HOME")
    expect(calls).not.toContain("service")
    expect(calls).not.toContain("desktop")
    expect(calls).toContain("abort-prepared")
  })

  test("blocks when candidate and target directories differ", async () => {
    const { deps, calls, prepared } = dependencies()
    deps.prepare = async () => ({
      ...prepared,
      candidate: { ...candidate, workspace: "/workspace/other" },
    })
    await expect(startOwnedDesktop(input, deps)).rejects.toThrow("Candidate and target identities")
    expect(calls).not.toContain("service")
    expect(calls).not.toContain("desktop")
  })

  test("cleans a prepared root only once when service startup fails", async () => {
    const { deps, calls, written } = dependencies()
    deps.startService = async () => {
      calls.push("service")
      throw new ServiceNotStartedError("service executable could not start")
    }
    await expect(startOwnedDesktop(input, deps)).rejects.toThrow(
      "service executable could not start",
    )
    expect(calls.filter((call) => call === "cleanup")).toHaveLength(1)
    expect(written.at(-1)?.serviceStartupPending).toBeUndefined()
    expect(calls).not.toContain("abort-prepared")
    expect(calls.at(-1)).toBe("release")
  })

  test("persists spawned-service ownership before fallible identity discovery", async () => {
    const { deps, calls, written } = dependencies()
    const spawned = {
      pid: serviceProcess.pid,
      command: serviceProcess.command,
      spawnedAt: 1793538000000,
    }
    deps.startService = async ({ onSpawn }) => {
      calls.push("service")
      await onSpawn(spawned)
      expect(written.at(-1)?.pendingService).toEqual(spawned)
      throw new Error("process identity unavailable")
    }
    deps.cleanup = async (value) => {
      calls.push("cleanup")
      const result = await cleanupOwnedDesktop(value, {
        writeManifest: deps.writeManifest,
        observeProcess: () => ({ kind: "observation-unavailable", reason: "probe-error" }),
        verifyAndStopDesktop: async () => "already-stopped",
        verifyAndStopService: async () => "already-stopped",
        protocolHandler: deps.protocolHandler,
        removeRoot: async () => {
          calls.push("remove")
        },
      })
      return { clean: result.status === "cleaned", reason: result.cleanupIssue }
    }
    await expect(startOwnedDesktop(input, deps)).rejects.toThrow("cleanup remains retryable")
    expect(written.at(-1)?.pendingService).toEqual(spawned)
    expect(calls).toContain("retain")
    expect(calls).not.toContain("remove")
    expect(calls).not.toContain("release")
    expect(calls).not.toContain("desktop")
  })

  test("keeps the startup reservation when spawned-service identity cannot be persisted", async () => {
    const { deps, calls, written } = dependencies()
    const persistManifest = deps.writeManifest
    deps.writeManifest = async (value) => {
      if (value.pendingService !== undefined) throw new Error("post-spawn manifest write failed")
      await persistManifest(value)
    }
    deps.startService = async ({ onSpawn }) => {
      expect(written.at(-1)?.serviceStartupPending).toBe(true)
      calls.push("service")
      await onSpawn({
        pid: serviceProcess.pid,
        command: serviceProcess.command,
        spawnedAt: 1793538000000,
      })
      return serviceProcess
    }
    deps.cleanup = async (value) => {
      calls.push("cleanup")
      const result = await cleanupOwnedDesktop(value, {
        writeManifest: deps.writeManifest,
        observeProcess: () => ({ kind: "observation-unavailable", reason: "probe-error" }),
        verifyAndStopDesktop: async () => "already-stopped",
        verifyAndStopService: async () => "already-stopped",
        protocolHandler: deps.protocolHandler,
        removeRoot: async () => {
          calls.push("remove")
        },
      })
      return { clean: result.status === "cleaned", reason: result.cleanupIssue }
    }

    await expect(startOwnedDesktop(input, deps)).rejects.toThrow("cleanup remains retryable")
    expect(written.at(-1)?.serviceStartupPending).toBe(true)
    expect(written.at(-1)?.pendingService).toBeUndefined()
    expect(calls).toContain("retain")
    expect(calls).not.toContain("remove")
    expect(calls).not.toContain("release")

    let observations = 0
    const reopened = structuredClone(written.at(-1)!)
    const blocked = await cleanupOwnedDesktop(reopened, {
      writeManifest: persistManifest,
      observeProcess: () => {
        observations++
        return { kind: "authoritatively-absent" }
      },
      verifyAndStopDesktop: async () => "already-stopped",
      verifyAndStopService: async () => "already-stopped",
      protocolHandler: deps.protocolHandler,
      removeRoot: async () => {
        calls.push("reopened-remove")
      },
    })
    expect(blocked.status).toBe("cleanup-blocked")
    expect(blocked.cleanupIssue).toContain("without durable process ownership")
    expect(observations).toBe(0)
    expect(calls).not.toContain("reopened-remove")
  })

  test("unconfirmed service ownership survives failed cleanup and permits cleanup after authoritative exit", async () => {
    const spawned = {
      pid: serviceProcess.pid,
      command: serviceProcess.command,
      spawnedAt: 1793538000000,
    }
    for (const observation of [
      { kind: "live", identity: serviceProcess },
      { kind: "observation-unavailable", reason: "probe-error" },
    ] as const) {
      const value = manifest({ service: undefined, desktop: undefined, pendingService: spawned })
      let removals = 0
      let signals = 0
      const written: OwnedLaunchManifest[] = []
      const cleanup = {
        writeManifest: async (next: OwnedLaunchManifest) => {
          written.push(structuredClone(next))
        },
        observeProcess: () => observation,
        verifyAndStopDesktop: async () => {
          signals += 1
          return "stopped" as const
        },
        verifyAndStopService: async () => {
          signals += 1
          return "stopped" as const
        },
        protocolHandler: async () => "ai.opencode.desktop",
        removeRoot: async () => {
          removals += 1
        },
      }
      const blocked = await cleanupOwnedDesktop(value, cleanup)
      expect(blocked.status).toBe("cleanup-blocked")
      expect(written.at(-1)?.pendingService).toEqual(spawned)
      expect(removals).toBe(0)
      expect(signals).toBe(0)
      const reopened = structuredClone(written.at(-1)!)
      const cleaned = await cleanupOwnedDesktop(reopened, {
        ...cleanup,
        observeProcess: () => ({ kind: "authoritatively-absent" }),
      })
      expect(cleaned.status).toBe("cleaned")
      expect(cleaned.pendingService).toBeUndefined()
      expect(removals).toBe(1)
      expect(signals).toBe(0)
    }
  })

  test("blocks cleanup before touching resources when startup intent has no durable PID", async () => {
    const value = manifest({
      service: undefined,
      desktop: undefined,
      serviceStartupPending: true,
    })
    let touched = false
    const result = await cleanupOwnedDesktop(value, {
      writeManifest: async () => undefined,
      observeProcess: () => {
        touched = true
        return { kind: "authoritatively-absent" }
      },
      verifyAndStopDesktop: async () => {
        touched = true
        return "stopped"
      },
      verifyAndStopService: async () => {
        touched = true
        return "stopped"
      },
      protocolHandler: async () => {
        touched = true
        return "ai.opencode.desktop"
      },
      removeRoot: async () => {
        touched = true
      },
    })
    expect(result.status).toBe("cleanup-blocked")
    expect(result.cleanupIssue).toContain("without durable process ownership")
    expect(touched).toBe(false)
  })

  test("blocks a registration whose authenticated endpoint reports another process", async () => {
    const { deps, calls } = dependencies()
    deps.waitForService = async () => ({
      registration,
      health: { pid: serviceProcess.pid + 1, version: "2.2.5" },
      registrationPath: runtimePaths(root).serviceRegistration,
      authenticated: true,
    })
    await expect(startOwnedDesktop(input, deps)).rejects.toThrow("different processes")
    expect(calls).not.toContain("desktop")
    expect(calls).toContain("cleanup")
  })

  test("an unauthenticated endpoint blocks Desktop startup and retains the reservation if teardown fails", async () => {
    const { deps, calls, written } = dependencies({ authenticated: false, cleanupClean: false })
    await expect(startOwnedDesktop(input, deps)).rejects.toThrow("cleanup remains retryable")
    expect(calls).not.toContain("desktop")
    expect(calls).toContain("cleanup")
    expect(calls).toContain("retain")
    expect(calls).not.toContain("release")
    expect(written.at(-1)?.status).toBe("cleanup-blocked")
  })

  test("a candidate identity mismatch tears down the owned launch rather than accepting another plugin", async () => {
    const { deps, calls } = dependencies({ agentPresent: false })
    await expect(startOwnedDesktop(input, deps)).rejects.toThrow("Candidate LAZERS Architect")
    expect(calls).toContain("cleanup")
    expect(calls.at(-1)).toBe("release")
  })
})

describe("owned Desktop boundaries", () => {
  test("distinguishes live, absent, malformed, and unavailable process observations", () => {
    const live = processObservationFromProbe(42, {
      status: 0,
      stdout: "Sun Nov  1 12:00:00 2026 /Applications/OpenCode.app/Contents/MacOS/OpenCode\n",
    })
    expect(live).toEqual({
      kind: "live",
      identity: {
        pid: 42,
        startedAt: "Sun Nov  1 12:00:00 2026",
        command: "/Applications/OpenCode.app/Contents/MacOS/OpenCode",
      },
    })
    expect(processObservationFromProbe(42, { status: 1, stdout: "" })).toEqual({
      kind: "authoritatively-absent",
    })
    expect(
      processObservationFromProbe(42, {
        status: null,
        stdout: "",
        error: new Error("spawn failed"),
      }),
    ).toEqual({ kind: "observation-unavailable", reason: "probe-error" })
    expect(processObservationFromProbe(42, { status: 2, stdout: "" })).toEqual({
      kind: "observation-unavailable",
      reason: "unexpected-exit",
    })
    expect(
      processObservationFromProbe(42, { status: 0, stdout: "not a process identity" }),
    ).toEqual({
      kind: "observation-unavailable",
      reason: "malformed-output",
    })

    expect(classifyOwnedProcessObservation(desktopProcess, live)).toEqual({
      kind: "identity-changed",
      identity: (live as { kind: "live"; identity: ProcessIdentity }).identity,
    })
    expect(
      classifyOwnedProcessObservation(desktopProcess, { kind: "authoritatively-absent" }),
    ).toEqual({
      kind: "authoritatively-absent",
    })
  })

  test("uses actual ps observations for this worker and a non-existent PID", () => {
    expect(observeProcess(process.pid).kind).toBe("live")
    expect(observeProcess(99_999_999).kind).toBe("authoritatively-absent")
  })

  test("classifies root helper inventories without turning failed ps into an empty list", () => {
    expect(
      processInventoryFromProbe(root, {
        status: 0,
        stdout: `worker ${join(root, "desktop", "helper")}\n`,
      }),
    ).toEqual({ kind: "observed", processes: [`worker ${join(root, "desktop", "helper")}`] })
    expect(
      processInventoryFromProbe(root, { status: null, stdout: "", error: new Error("ps failed") }),
    ).toEqual({ kind: "observation-unavailable", reason: "probe-error" })
    expect(processInventoryFromProbe(root, { status: 2, stdout: "" })).toEqual({
      kind: "observation-unavailable",
      reason: "unexpected-exit",
    })
  })

  test("waits distinguish observed exit, a live main process, identity change, and unavailable observation", async () => {
    const run = async (observation: ReturnType<typeof processObservationFromProbe>) => {
      let now = 0
      return waitUntilGone(desktopProcess, 100, {
        observeProcess: () => observation,
        now: () => now,
        delay: async (ms) => {
          now += ms
        },
      })
    }

    expect(await run({ kind: "authoritatively-absent" })).toEqual({ kind: "observed-exited" })
    expect(
      await run({ kind: "live", identity: { ...desktopProcess, startedAt: "changed" } }),
    ).toEqual({ kind: "identity-changed" })
    expect(await run({ kind: "observation-unavailable", reason: "probe-error" })).toEqual({
      kind: "observation-unavailable",
      reason: "probe-error",
    })
    expect(await run({ kind: "live", identity: desktopProcess })).toEqual({
      kind: "main-still-live",
    })
  })

  test("retains a launch when process observation is unavailable or the PID identity changed", async () => {
    let now = 0
    let signals = 0
    const unavailable = await stopOwnedDesktopProcess(desktopProcess, root, {
      observeProcess: () => ({ kind: "observation-unavailable", reason: "probe-error" }),
      observeProcessesUsing: () => ({ kind: "observed", processes: [] }),
      signal: () => {
        signals += 1
      },
      now: () => now,
      delay: async (ms) => {
        now += ms
      },
    })
    expect(unavailable).toBe("observation-unavailable")
    expect(signals).toBe(0)
    expect(now).toBe(10_000)

    const identityChanged = await stopOwnedDesktopProcess(desktopProcess, root, {
      observeProcess: () => ({
        kind: "live",
        identity: { ...desktopProcess, startedAt: "different process start" },
      }),
      observeProcessesUsing: () => ({ kind: "observed", processes: [] }),
      signal: () => {
        signals += 1
      },
      now: () => now,
      delay: async (ms) => {
        now += ms
      },
    })
    expect(identityChanged).toBe("identity-changed")
    expect(signals).toBe(0)
  })

  test("does not call an exited Desktop clean while owned helpers remain", async () => {
    let now = 0
    let processObservations = 0
    let signals = 0
    const outcome = await stopOwnedDesktopProcess(desktopProcess, root, {
      observeProcess: () => {
        processObservations += 1
        return processObservations === 1
          ? { kind: "live", identity: desktopProcess }
          : { kind: "authoritatively-absent" }
      },
      observeProcessesUsing: () => ({
        kind: "observed",
        processes: [`${root}/desktop/helper-process`],
      }),
      signal: () => {
        signals += 1
      },
      now: () => now,
      delay: async (ms) => {
        now += ms
      },
    })
    expect(outcome).toBe("helpers-remain")
    expect(processObservations).toBeGreaterThan(1)
    expect(signals).toBe(1)
    expect(now).toBe(10_000)
  })

  test("keeps roots reserved when helper inventory is unavailable or the main process remains live", async () => {
    let now = 0
    let signals = 0
    const unknownHelpers = await stopOwnedDesktopProcess(desktopProcess, root, {
      observeProcess: () => ({ kind: "authoritatively-absent" }),
      observeProcessesUsing: () => ({
        kind: "observation-unavailable",
        reason: "probe-error",
      }),
      signal: () => {
        signals += 1
      },
      now: () => now,
      delay: async (ms) => {
        now += ms
      },
    })
    expect(unknownHelpers).toBe("helper-observation-unavailable")
    expect(signals).toBe(0)
    expect(now).toBe(10_000)

    now = 0
    let observations = 0
    const stillLive = await stopOwnedDesktopProcess(desktopProcess, root, {
      observeProcess: () => {
        observations += 1
        return { kind: "live", identity: desktopProcess }
      },
      observeProcessesUsing: () => ({ kind: "observed", processes: [] }),
      signal: () => {
        signals += 1
      },
      now: () => now,
      delay: async (ms) => {
        now += ms
      },
    })
    expect(stillLive).toBe("main-still-live")
    expect(observations).toBeGreaterThan(1)
    expect(signals).toBe(1)
    expect(now).toBe(10_000)
  })

  test("normalizes the CLI's reported v-prefix to the packaged version form", () => {
    expect(normalizeVersion("opencode v2.2.5\n")).toBe("2.2.5")
    expect(normalizeVersion(" 2.2.5 \n")).toBe("2.2.5")
  })

  test("accepts only effective test-root paths", () => {
    expect(() => assertEffectiveIsolation(root, environment())).not.toThrow()
    expect(isolatedEnvironment(root)["OPENCODE_LAZERS_VERIFICATION_BASE"]).toBe(dirname(root))
    const altered = environment()
    altered.set("XDG_STATE_HOME", "/Users/test/.local/state")
    expect(() => assertEffectiveIsolation(root, altered)).toThrow("isolated XDG_STATE_HOME")
  })

  test("keeps the explicit private base identity stable when owned TMPDIR changes", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "lazers-owned-temp-regression-"))
    const base = join(sandbox, "opencode", "lazers-product-verification")
    const otherBase = join(sandbox, "other", "opencode", "lazers-product-verification")
    const previousTemp = process.env.TMPDIR
    const previousBase = process.env.OPENCODE_LAZERS_VERIFICATION_BASE
    try {
      await mkdir(base, { recursive: true, mode: 0o700 })
      await chmod(base, 0o700)
      await mkdir(otherBase, { recursive: true, mode: 0o700 })
      await chmod(otherBase, 0o700)
      const rootDirectory = await mkdtemp(join(base, "lazers-full-instance-"))
      await chmod(rootDirectory, 0o700)
      const canonicalRoot = await realpath(rootDirectory)
      const canonicalBase = await realpath(base)
      const paths = runtimePaths(canonicalRoot)
      await mkdir(paths.tempHome, { recursive: true, mode: 0o700 })
      const ownerID = "temp-root-regression-owner"
      const ownerPath = JSON.stringify({ ownerID, root: canonicalRoot })
      const manifestValue = {
        schemaVersion: 1,
        ownerID,
        status: "ready",
        createdAt: "2026-11-02T00:00:00.000Z",
        root: canonicalRoot,
        baseDirectory: canonicalBase,
        protocolHandlerBaseline: null,
        observations: [],
        nativeInteraction: {
          state: "idle",
          requestID: "resolved-request",
          message: "Resolved from the sidecar as not-delivered; no command was replayed",
        },
      }
      await writeFile(paths.owner, ownerPath, { mode: 0o600 })
      await writeFile(paths.manifest, JSON.stringify(manifestValue), { mode: 0o600 })

      process.env.OPENCODE_LAZERS_VERIFICATION_BASE = canonicalBase
      const stableBase = defaultBaseDirectory()
      process.env.TMPDIR = join(sandbox, "ambient")
      await mkdir(process.env.TMPDIR, { recursive: true, mode: 0o700 })
      await expect(readManifest(canonicalRoot)).resolves.toMatchObject({
        root: canonicalRoot,
        baseDirectory: canonicalBase,
      })
      await expect(
        resolveNativeInteraction(canonicalRoot, "resolved-request", "not-delivered"),
      ).resolves.toMatchObject({ nativeInteraction: manifestValue.nativeInteraction })
      await expect(
        resolveNativeInteraction(canonicalRoot, "different-request", "not-delivered"),
      ).rejects.toThrow("does not match")

      process.env.TMPDIR = paths.tempHome
      expect(defaultBaseDirectory()).toBe(stableBase)
      await expect(readManifest(canonicalRoot)).resolves.toMatchObject({
        root: canonicalRoot,
        baseDirectory: canonicalBase,
      })

      process.env.OPENCODE_LAZERS_VERIFICATION_BASE = await realpath(otherBase)
      await expect(readManifest(canonicalRoot)).rejects.toThrow(
        "Owned verification base does not match the launch manifest",
      )

      process.env.OPENCODE_LAZERS_VERIFICATION_BASE = canonicalBase
      await writeFile(
        paths.owner,
        JSON.stringify({ ownerID: "other-owner", root: canonicalRoot }),
        {
          mode: 0o600,
        },
      )
      await expect(readManifest(canonicalRoot)).rejects.toThrow(
        "Owned launch marker does not match its manifest",
      )

      await writeFile(paths.owner, ownerPath, { mode: 0o600 })
      const alias = join(base, "lazers-full-instance-symlink")
      await symlink(canonicalRoot, alias, "dir")
      await expect(readManifest(alias)).rejects.toThrow(
        "Owned launch root is not a private, user-owned directory",
      )
    } finally {
      if (previousTemp === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previousTemp
      if (previousBase === undefined) delete process.env.OPENCODE_LAZERS_VERIFICATION_BASE
      else process.env.OPENCODE_LAZERS_VERIFICATION_BASE = previousBase
      await rm(sandbox, { recursive: true, force: true })
    }
  })

  test("rejects missing, non-loopback, wrong-port, and mismatched service identities", () => {
    expect(() => parseServiceRegistration({ url: "http://127.0.0.1:1", pid: 1 })).toThrow()
    expect(() =>
      assertOwnedService(
        registration,
        { pid: 2, version: "2.2.5" },
        {
          pid: serviceProcess.pid,
          version: "2.2.5",
          registrationPath: runtimePaths(root).serviceRegistration,
          expectedPath: runtimePaths(root).serviceRegistration,
          port: 52123,
        },
      ),
    ).toThrow("different processes")
    expect(() =>
      assertOwnedService(
        { ...registration, url: "http://localhost:52123" },
        {
          pid: serviceProcess.pid,
          version: "2.2.5",
        },
        {
          pid: serviceProcess.pid,
          version: "2.2.5",
          registrationPath: runtimePaths(root).serviceRegistration,
          expectedPath: runtimePaths(root).serviceRegistration,
        },
      ),
    ).toThrow("loopback")
    expect(() =>
      assertOwnedService(
        registration,
        { pid: serviceProcess.pid, version: "2.2.5" },
        {
          pid: serviceProcess.pid,
          version: "2.2.5",
          registrationPath: runtimePaths(root).serviceRegistration,
          expectedPath: runtimePaths(root).serviceRegistration,
          port: 49374,
        },
      ),
    ).toThrow("reserved endpoint")
  })

  test("captures a restorable protocol baseline and rejects a non-candidate Architect", () => {
    expect(assertProtocolBaseline("ai.opencode.desktop", "another.handler")).toBe("another.handler")
    expect(() => assertProtocolBaseline("ai.opencode.desktop", null)).toThrow("cannot be restored")
    expect(() =>
      assertCandidateAgent(
        [{ id: "architect", mode: "primary", description: "other" }],
        candidate.architectDescription,
      ),
    ).toThrow("behaviorally present")
  })

  test("source edits and rebuilds preserve access to the owned verification instance", () => {
    const changed = {
      ...candidate,
      revision: "b".repeat(40),
      dirtyPaths: ["src/changed.ts", "notes.txt"],
      guiEntryBytes: candidate.guiEntryBytes + 1,
      guiEntryModifiedAt: "2026-11-02T02:00:00.000Z",
      architectDescription: "updated guidance",
    }
    expect(candidateIdentityDifferences(changed, candidate)).toEqual([])
    expect(sameCandidateIdentity(changed, candidate)).toBe(true)
    expect(sameCandidateIdentity({ ...changed, workspace: "/elsewhere" }, candidate)).toBe(false)
    expect(sameCandidateIdentity({ ...changed, guiEntry: "/elsewhere/gui.js" }, candidate)).toBe(
      false,
    )
  })

  test("blocks all cleanup side effects while native interaction delivery is pending or ambiguous", async () => {
    for (const state of ["pending", "ambiguous"] as const) {
      const value = manifest({
        nativeInteraction: {
          state,
          requestID: "8fc30312-7715-4a1a-a12f-2bb8e53f17c2",
          kind: "click",
        },
      })
      let touched = false
      const result = await cleanupOwnedDesktop(value, {
        writeManifest: async () => undefined,
        verifyAndStopDesktop: async () => {
          touched = true
          return "stopped"
        },
        verifyAndStopService: async () => {
          touched = true
          return "stopped"
        },
        protocolHandler: async () => {
          touched = true
          return "ai.opencode.desktop"
        },
        removeRoot: async () => {
          touched = true
        },
      })
      expect(result.status).toBe("cleanup-blocked")
      expect(result.cleanupIssue).toContain("pending or ambiguous")
      expect(touched).toBe(false)
    }
  })

  test("does not remove the root when owned process or helper observations are unresolved", async () => {
    for (const outcome of [
      "observation-unavailable",
      "identity-changed",
      "main-still-live",
      "helpers-remain",
      "helper-observation-unavailable",
    ] as const) {
      const value = manifest()
      let removed = false
      let serviceChecked = false
      const result = await cleanupOwnedDesktop(value, {
        writeManifest: async () => undefined,
        verifyAndStopDesktop: async () => outcome,
        verifyAndStopService: async () => {
          serviceChecked = true
          return "stopped"
        },
        protocolHandler: async () => "ai.opencode.desktop",
        removeRoot: async () => {
          removed = true
        },
      })
      expect(result.status).toBe("cleanup-blocked")
      expect(removed).toBe(false)
      expect(serviceChecked).toBe(false)
      expect(result.cleanupIssue).toMatch(/observation|identity|live|helper/i)
    }
  })

  test("retains dirty resources on ambiguous teardown, then restores the handler before removing the root", async () => {
    const value = manifest({
      protocolHandlerBaseline: "other.handler",
      status: "cleanup-blocked",
      cleanupIssue: "previous timeout",
    })
    let handler = "ai.opencode.desktop"
    let removeCount = 0
    const writes: string[] = []
    const common = {
      writeManifest: async (next: OwnedLaunchManifest) => {
        writes.push(next.status)
      },
      protocolHandler: async () => handler,
      restoreProtocolHandler: async (target: string) => {
        handler = target
      },
      removeRoot: async () => {
        removeCount += 1
      },
    }
    const blocked = await cleanupOwnedDesktop(value, {
      ...common,
      verifyAndStopDesktop: async () => "ambiguous",
      verifyAndStopService: async () => "stopped",
    })
    expect(blocked.status).toBe("cleanup-blocked")
    expect(removeCount).toBe(0)

    const cleaned = await cleanupOwnedDesktop(value, {
      ...common,
      verifyAndStopDesktop: async () => "stopped",
      verifyAndStopService: async () => "stopped",
    })
    expect(cleaned.status).toBe("cleaned")
    expect(handler).toBe("other.handler")
    expect(removeCount).toBe(1)
    expect(writes).toContain("cleanup-blocked")
  })
})

test("reopening preserves the service and owner and does not duplicate a live Desktop", async () => {
  const m = manifest()
  const originalService = structuredClone(m.service)
  let current: ProcessIdentity | undefined
  let launches = 0
  let releases = 0
  const f = dependencies()
  const deps = {
    verify: async () => ({ manifest: m }),
    observe: () =>
      current
        ? { kind: "live" as const, identity: current }
        : { kind: "authoritatively-absent" as const },
    reserve: async () => async () => {
      releases++
    },
    launch: {
      ...f.deps,
      launchDesktop: async () => {
        launches++
        current = { ...desktopProcess, pid: 25002 }
        return current
      },
    },
  }
  await reopenOwnedDesktop(root, deps)
  expect(m.desktop?.pid).toBe(25002)
  expect(f.written.at(-1)?.desktop?.pid).toBe(25002)
  expect(m.service).toEqual(originalService)
  expect(m.ownerID).toBe("owner-id")
  await reopenOwnedDesktop(root, deps)
  expect(launches).toBe(1)
  expect(releases).toBe(2)
  expect(f.calls).not.toContain("service")
  expect(f.calls).not.toContain("cleanup")
})

test("reopen retains a launched Desktop identity when candidate readiness fails", async () => {
  const m = manifest()
  const f = dependencies()
  await expect(
    reopenOwnedDesktop(root, {
      verify: async () => ({ manifest: m }),
      observe: () => ({ kind: "authoritatively-absent" }),
      reserve: async () => async () => {},
      launch: {
        ...f.deps,
        waitForCandidate: async () => {
          throw new Error("not ready yet")
        },
      },
    }),
  ).rejects.toThrow("not ready yet")
  expect(f.written.at(-1)?.desktop).toEqual(desktopProcess)
  expect(f.calls).not.toContain("cleanup")
})

test("unobservable Desktop identity does not start a duplicate", async () => {
  const f = dependencies()
  await expect(
    reopenOwnedDesktop(root, {
      verify: async () => ({ manifest: manifest() }),
      observe: () => ({ kind: "observation-unavailable", reason: "probe-error" }),
      reserve: async () => async () => {},
      launch: f.deps,
    }),
  ).rejects.toThrow("could not be observed")
  expect(f.calls).not.toContain("desktop")
})
