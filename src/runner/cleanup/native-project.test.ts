import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { nativeHost } from "../native.ts"
import type { NativeInboxClient, NativeInboxDependencies } from "../native.ts"
import type { Plugin } from "@opencode/plugin/effect"
import type { TaskRepository } from "../../storage.ts"

test("native cleanup resolves a changed session project ID through the exact project registry record", async () => {
  const projectDirectory = mkdtempSync(join(tmpdir(), "lazers-native-cleanup-project-"))
  const foreignDirectory = mkdtempSync(join(tmpdir(), "lazers-native-cleanup-foreign-"))
  const projects = [
    { id: "current-project", canonical: projectDirectory },
    { id: "drifted-project", canonical: projectDirectory },
    { id: "foreign-project", canonical: foreignDirectory },
    { id: "duplicate-project", canonical: projectDirectory },
    { id: "duplicate-project", canonical: foreignDirectory },
  ]
  const projectListInputs: Array<{ archived?: boolean } | undefined> = []
  const client = {
    server: { info: async () => ({ pid: 42, version: "2.3.0" }) },
    project: {
      list: async (input?: { archived?: boolean }) => {
        projectListInputs.push(input)
        return projects
      },
    },
  } as unknown as NativeInboxClient
  const dependencies: NativeInboxDependencies = {
    discover: async () => ({ url: "https://opencode.localhost", auth: undefined }),
    make: () => client,
    processID: () => 42,
  }
  const host = nativeHost(
    {
      app: { version: "2.3.0" },
      location: {
        directory: projectDirectory,
        project: { id: "current-project", canonical: projectDirectory },
      },
    } as unknown as Plugin.Context,
    { projectDirectory } as TaskRepository,
    dependencies,
  )

  try {
    expect(await host.nativeProjectCanonicalDirectory("drifted-project")).toBe(projectDirectory)
    expect(await host.nativeProjectCanonicalDirectory("foreign-project")).toBe(foreignDirectory)
    expect(await host.nativeProjectCanonicalDirectory("missing-project")).toBeUndefined()
    expect(await host.nativeProjectCanonicalDirectory("duplicate-project")).toBeUndefined()
    expect(projectListInputs.every((input) => input?.archived === true)).toBe(true)
  } finally {
    rmSync(projectDirectory, { recursive: true, force: true })
    rmSync(foreignDirectory, { recursive: true, force: true })
  }
})

test("native integrated-worker retirement accepts project-ID drift only for the canonical repository", async () => {
  const projectDirectory = mkdtempSync(join(tmpdir(), "lazers-native-retire-project-"))
  const foreignDirectory = mkdtempSync(join(tmpdir(), "lazers-native-retire-foreign-"))
  const workspace = join(projectDirectory, ".worktrees", "worker")
  let archived = false
  let busy = false
  let activateDuringProjectLookup = false
  const session = () => ({
    id: "ses_worker",
    projectID: "drifted-project",
    agent: "lazers-implementor",
    location: { directory: workspace },
    metadata: { lazersAttemptID: "attempt-1" },
    outcome: "succeeded",
    time: { idle: 2, ...(busy ? { busy: 3 } : {}), ...(archived ? { archived: 3 } : {}) },
  })
  let projectCanonical = projectDirectory
  const client = {
    server: { info: async () => ({ pid: 42, version: "2.3.0" }) },
    project: {
      list: async () => {
        if (activateDuringProjectLookup) busy = true
        return [{ id: "drifted-project", canonical: projectCanonical }]
      },
    },
    session: {
      get: async () => session(),
      active: async () => ({}),
      update: async ({ archived: value }: { archived: boolean }) => {
        archived = value
      },
      inbox: { list: async () => [] },
    },
    debug: { location: { list: async () => [{ directory: workspace }] } },
    permission: {
      request: { list: async () => ({ location: { directory: workspace }, data: [] }) },
    },
    form: { list: async () => ({ location: { directory: workspace }, data: [] }) },
    shell: { list: async () => ({ location: { directory: workspace }, data: [] }) },
  } as unknown as NativeInboxClient
  const dependencies: NativeInboxDependencies = {
    discover: async () => ({ url: "https://opencode.localhost", auth: undefined }),
    make: () => client,
    processID: () => 42,
  }
  const host = nativeHost(
    {
      app: { version: "2.3.0" },
      location: {
        directory: projectDirectory,
        project: { id: "current-project", canonical: projectDirectory },
      },
    } as unknown as Plugin.Context,
    { projectDirectory } as TaskRepository,
    dependencies,
  )

  try {
    await host.retireIntegratedWorker!({
      projectID: "current-project",
      attemptID: "attempt-1",
      sessionID: "ses_worker",
      workspace,
    })
    expect(archived).toBe(true)

    archived = false
    activateDuringProjectLookup = true
    await expect(
      host.retireIntegratedWorker!({
        projectID: "current-project",
        attemptID: "attempt-1",
        sessionID: "ses_worker",
        workspace,
      }),
    ).rejects.toThrow("unsettled native activity")
    expect(archived).toBe(false)

    busy = false
    activateDuringProjectLookup = false
    projectCanonical = foreignDirectory
    await expect(
      host.retireIntegratedWorker!({
        projectID: "current-project",
        attemptID: "attempt-1",
        sessionID: "ses_worker",
        workspace,
      }),
    ).rejects.toThrow("unsettled native activity")
    expect(archived).toBe(false)
  } finally {
    rmSync(projectDirectory, { recursive: true, force: true })
    rmSync(foreignDirectory, { recursive: true, force: true })
  }
})
