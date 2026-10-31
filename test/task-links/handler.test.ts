import { expect, test } from "bun:test"
import type { SessionRef } from "@opencode/plugin/gui"
import { createTaskLinkHandler, parseTaskLink, taskMarkdownLink } from "../../src/tasks/links.ts"

const projectID = "project-a"
const projectDirectory = "/repo"
const taskID = "11111111-1111-4111-8111-111111111111"
const source = {
  id: "ses-origin",
  server: { id: "server-a" },
  location: { directory: "/origin-worktree" },
} as SessionRef
const task = {
  id: taskID,
  provenance: { projectID, projectDirectory },
}

function link(reference = "LZ-7", project = projectID, session: SessionRef | undefined = source) {
  return { href: taskMarkdownLink(reference, project).match(/\]\((.*)\)$/)![1]!, session }
}

test("copied Markdown uses the actual reference and a strict native in-app URL", () => {
  const markdown = taskMarkdownLink("LZ-7", projectID)
  expect(markdown).toBe("[LZ-7](lazers://task/LZ-7?project=project-a)")
  expect(parseTaskLink("lazers://task/LZ-7?project=project-a")).toEqual({
    reference: "LZ-7",
    projectID,
  })
  for (const malformed of [
    "lazers://task/LZ-0?project=project-a",
    "lazers://task/LZ-07?project=project-a",
    "lazers://task/LZ-no?project=project-a",
    "lazers://task/LZ-7?project=project-a&directory=/outside",
    "lazers://task/LZ-7?project=project-a&project=project-b",
    "lazers://user@task/LZ-7?project=project-a",
    "https://task/LZ-7?project=project-a",
    "lazers://other/LZ-7?project=project-a",
    "lazers://task/LZ-7?project=%0A",
    "not a url",
  ])
    expect(parseTaskLink(malformed)).toBeUndefined()
  expect(() => taskMarkdownLink("LZ-0", projectID)).toThrow()
})

test("native link exists/open resolve the reference in its live origin and open the UUID selection", async () => {
  const live = source
  const calls: string[] = []
  const opened: unknown[] = []
  const controller = new AbortController()
  const handler = createTaskLinkHandler({
    session(origin) {
      calls.push(`session:${origin.id}:${origin.server.id}`)
      return origin.id === live.id && origin.server.id === live.server.id ? live : undefined
    },
    async project(session) {
      calls.push(`project:${session.location?.directory}`)
      return { id: projectID, canonical: projectDirectory }
    },
    async get(session, reference) {
      calls.push(`get:${session.location?.directory}:${reference}`)
      return { status: "found", reference, task }
    },
    signal: () => controller.signal,
    open: (target) => opened.push(target),
  })
  const messageLink = { ...link(), base: "/untrusted/from-message" }
  expect(handler.match(messageLink)).toBe(true)
  expect(await handler.exists!(messageLink)).toBe(true)
  handler.open(messageLink)
  await Bun.sleep(0)
  expect(calls).toContain("project:/origin-worktree")
  expect(calls).toContain("get:/origin-worktree:LZ-7")
  expect(calls).not.toContain("project:/untrusted/from-message")
  expect(opened).toEqual([
    {
      session: live,
      sessionDirectory: "/origin-worktree",
      projectDirectory,
      taskID,
    },
  ])
})

test("malformed, missing, foreign and disposed links fail closed without unrelated reads or opens", async () => {
  let current: SessionRef | undefined = source
  let project = { id: projectID, canonical: projectDirectory }
  let result: { status: "found"; reference: string; task: typeof task } | { status: "not_found" } =
    { status: "found", reference: "LZ-7", task }
  let projectReads = 0
  let taskReads = 0
  const opened: unknown[] = []
  const controller = new AbortController()
  const handler = createTaskLinkHandler({
    session(origin) {
      return current?.id === origin.id && current.server.id === origin.server.id
        ? current
        : undefined
    },
    async project(session) {
      projectReads++
      expect(session.location?.directory).toBe("/origin-worktree")
      return project
    },
    async get(_session, reference) {
      taskReads++
      return result.status === "found" ? { ...result, reference } : result
    },
    signal: () => controller.signal,
    open: (target) => opened.push(target),
  })
  const malformed = { href: "lazers://task/LZ-0?project=project-a", session: source }
  expect(handler.match(malformed)).toBe(true)
  expect(await handler.exists!(malformed)).toBe(false)
  handler.open(malformed)
  await Bun.sleep(0)
  expect(projectReads).toBe(0)
  expect(taskReads).toBe(0)

  project = { id: "project-b", canonical: "/other" }
  expect(await handler.exists!(link())).toBe(false)
  expect(taskReads).toBe(0)
  project = { id: projectID, canonical: projectDirectory }
  result = { status: "not_found" }
  expect(await handler.exists!(link())).toBe(false)
  handler.open(link())
  await Bun.sleep(0)
  expect(opened).toEqual([])

  current = undefined
  expect(await handler.exists!(link())).toBe(false)
  expect(taskReads).toBe(2)
  expect(opened).toEqual([])
})

test("reconnect uses current session references and disposal/cancellation prevents stale opens", async () => {
  const originalSource = source
  const live = {
    ...source,
    server: { id: "server-a" },
    location: { directory: "/reconnected-worktree" },
  } as SessionRef
  let disposed = false
  const controller = new AbortController()
  const opened: unknown[] = []
  const handler = createTaskLinkHandler({
    session(origin) {
      return !disposed && origin.id === originalSource.id ? live : undefined
    },
    async project(session) {
      expect(session.location?.directory).toBe("/reconnected-worktree")
      return { id: projectID, canonical: projectDirectory }
    },
    async get(_session, reference) {
      return { status: "found", reference, task }
    },
    signal: () => controller.signal,
    open: (target) => opened.push(target),
  })
  expect(await handler.exists!(link())).toBe(true)
  expect(opened).toEqual([])
  disposed = true
  handler.open(link())
  await Bun.sleep(0)
  expect(opened).toEqual([])
  disposed = false
  controller.abort()
  expect(await handler.exists!(link())).toBe(false)
  handler.open(link())
  await Bun.sleep(0)
  expect(opened).toEqual([])
})
