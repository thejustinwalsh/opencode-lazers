import { describe, expect, test } from "bun:test"
import {
  assertCandidateAgent,
  assertEffectiveIsolation,
  assertOwnedService,
  assertProtocolBaseline,
  cleanupOwnedDesktop,
  normalizeVersion,
  parseServiceRegistration,
  runtimePaths,
  sameCandidateIdentity,
  startOwnedDesktop,
} from "../../src/verification/opencode/owned-launch.ts"
import type {
  CandidateIdentity,
  LaunchDependencies,
  OwnedLaunchManifest,
  ProcessIdentity,
  ServiceRegistration,
} from "../../src/verification/opencode/owned-launch.ts"

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
    ["OPENCODE_DESKTOP_TEST_ROOT", paths.root],
    ["TMPDIR", paths.tempHome],
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
    startService: async () => {
      calls.push("service")
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
  test("uses an isolated effective state path and registration, and launches only after service identity is authenticated", async () => {
    const { deps, calls } = dependencies()
    const result = await startOwnedDesktop(input, deps)

    expect(result.status).toBe("ready")
    expect(result.target.serviceRegistrationPath).toBe(runtimePaths(root).serviceRegistration)
    expect(calls.indexOf("service-ready")).toBeLessThan(calls.indexOf("desktop"))
    expect(calls.indexOf("desktop")).toBeLessThan(calls.indexOf("candidate-ready"))
    expect(calls.at(-1)).toBe("release")
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
    const { deps, calls } = dependencies()
    deps.startService = async () => {
      calls.push("service")
      throw new Error("service executable could not start")
    }
    await expect(startOwnedDesktop(input, deps)).rejects.toThrow(
      "service executable could not start",
    )
    expect(calls.filter((call) => call === "cleanup")).toHaveLength(1)
    expect(calls).not.toContain("abort-prepared")
    expect(calls.at(-1)).toBe("release")
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
  test("normalizes the CLI's reported v-prefix to the packaged version form", () => {
    expect(normalizeVersion("opencode v2.2.5\n")).toBe("2.2.5")
    expect(normalizeVersion(" 2.2.5 \n")).toBe("2.2.5")
  })

  test("accepts only effective test-root paths", () => {
    expect(() => assertEffectiveIsolation(root, environment())).not.toThrow()
    const altered = environment()
    altered.set("XDG_STATE_HOME", "/Users/test/.local/state")
    expect(() => assertEffectiveIsolation(root, altered)).toThrow("isolated XDG_STATE_HOME")
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

  test("allows retained qualification PNGs without relaxing candidate source identity", () => {
    expect(
      sameCandidateIdentity(
        {
          ...candidate,
          dirtyPaths: [
            ...candidate.dirtyPaths,
            ".agents/docs/evidence/full-instance-qualification/trial.png",
          ],
        },
        candidate,
      ),
    ).toBe(true)
    expect(
      sameCandidateIdentity(
        { ...candidate, dirtyPaths: [...candidate.dirtyPaths, "src/changed.ts"] },
        candidate,
      ),
    ).toBe(false)
    expect(
      sameCandidateIdentity(
        { ...candidate, guiEntryBytes: candidate.guiEntryBytes + 1 },
        candidate,
      ),
    ).toBe(false)
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
