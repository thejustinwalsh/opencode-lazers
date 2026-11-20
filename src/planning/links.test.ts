import { expect, test } from "bun:test"
import {
  createPlanLinkHandler,
  parsePlanLink,
  planMarkdownLink,
  type PlanLinkServices,
} from "./links.ts"

const id = "0b4e2c1a-0000-4000-8000-000000000001"
const href = (projectID: string) => /\((.*)\)/.exec(planMarkdownLink(id, projectID))![1]!
const session = { id: "ses", server: { id: "srv" }, location: { directory: "/p" } } as never

function handler(over: Partial<PlanLinkServices> = {}, planProject = "proj") {
  const opened: unknown[] = []
  const services: PlanLinkServices = {
    session: () => session,
    project: async () => ({ id: "proj", canonical: "/p" }),
    get: async () =>
      planProject === "none"
        ? { status: "not_found" }
        : { status: "found", planningID: id, projectKey: planProject, projectDirectory: "/p" },
    signal: () => new AbortController().signal,
    open: (target) => opened.push(target),
    ...over,
  }
  return { handler: createPlanLinkHandler(services), opened }
}

test("a plan link round-trips and malformed ones are owned but do not resolve", async () => {
  expect(parsePlanLink(href("proj"))).toEqual({ planningID: id, projectID: "proj" })
  const { handler: h } = handler()
  const link = (path: string) => ({ href: path, session }) as never
  expect(h.match(link(".lazers/plans/zz/x"))).toBe(true)
  expect(await h.exists!(link(".lazers/plans/zz/x"))).toBe(false)
  expect(await h.exists!(link(href("proj")))).toBe(true)
  expect(h.match(link("src/index.ts"))).toBe(false)
})

test("a plan of another project resolves to nothing", async () => {
  const { handler: other, opened } = handler({}, "other-project")
  const link = { href: href("proj"), session } as never
  expect(await other.exists!(link)).toBe(false)
  other.open(link)
  await new Promise((r) => setTimeout(r, 5))
  expect(opened).toEqual([])
  const { handler: wrongLink } = handler()
  expect(await wrongLink.exists!({ href: href("another"), session } as never)).toBe(false)
})

test("opening a plan of the session's own project opens the view", async () => {
  const { handler: h, opened } = handler()
  h.open({ href: href("proj"), session } as never)
  await new Promise((r) => setTimeout(r, 5))
  expect(opened).toHaveLength(1)
  expect(opened[0]).toMatchObject({ planningID: id, projectDirectory: "/p" })
})
