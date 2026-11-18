import { expect, test } from "bun:test"
import {
  DEFAULT_ARCHITECT_CACHE_WINDOW_MS,
  DEFAULT_ARCHITECT_REUSE_MAX_CONTEXT_TOKENS,
  routeArchitect,
} from "./architect-routing.ts"
import type { HostSession } from "./host.ts"

const options = {
  architectCacheWindowMs: DEFAULT_ARCHITECT_CACHE_WINDOW_MS,
  architectReuseMaxContextTokens: DEFAULT_ARCHITECT_REUSE_MAX_CONTEXT_TOKENS,
}
const now = 10_000_000

function architect(overrides: Partial<HostSession> = {}): HostSession {
  return {
    id: "ses_owner",
    projectID: "project",
    directory: "/project",
    agent: "architect",
    archived: false,
    busy: false,
    idleAt: now - 60_000,
    tokens: 200_000,
    tools: 0,
    cost: null,
    messages: [],
    ...overrides,
  }
}

test("a warm owner is reused", () => {
  expect(routeArchitect(architect(), now, options)).toEqual({
    action: "reuse",
    sessionID: "ses_owner",
    reason: "warm",
  })
})

test("a cold owner with a large context gets a fresh Architect", () => {
  expect(routeArchitect(architect({ idleAt: now - 10 * 60_000 }), now, options)).toEqual({
    action: "fresh",
    sessionID: null,
    reason: "cold-large",
  })
})

test("unknown context size is treated as large", () => {
  expect(routeArchitect(architect({ idleAt: 1, tokens: null }), now, options).reason).toBe(
    "cold-large",
  )
})

test("a cold owner with a small context is reused", () => {
  expect(routeArchitect(architect({ idleAt: 1, tokens: 8_000 }), now, options)).toEqual({
    action: "reuse",
    sessionID: "ses_owner",
    reason: "small-context",
  })
})

test("context is measured from reported usage when present", () => {
  const usage = {
    input: 40_000,
    output: 1,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    provenance: "t",
  }
  expect(routeArchitect(architect({ idleAt: 1, tokens: 1, usage }), now, options).reason).toBe(
    "cold-large",
  )
})

test("an archived, foreign-role or missing owner gets a fresh Architect", () => {
  for (const owner of [
    undefined,
    null,
    architect({ archived: true }),
    architect({ agent: "build" }),
  ])
    expect(routeArchitect(owner, now, options)).toEqual({
      action: "fresh",
      sessionID: null,
      reason: "missing",
    })
})

test("a busy warm owner is queued", () => {
  expect(routeArchitect(architect({ busy: true }), now, options)).toEqual({
    action: "queue",
    sessionID: "ses_owner",
    reason: "warm",
  })
  expect(routeArchitect(architect({ busy: true, idleAt: undefined }), now, options).action).toBe(
    "queue",
  )
})

test("a busy cold owner with a large context gets a fresh Architect", () => {
  expect(
    routeArchitect(architect({ busy: true, activityAt: now - 20 * 60_000 }), now, options),
  ).toEqual({ action: "fresh", sessionID: null, reason: "cold-large" })
})

test("activityAt takes precedence over idleAt", () => {
  expect(
    routeArchitect(architect({ idleAt: 1, activityAt: now - 1_000 }), now, options).reason,
  ).toBe("warm")
})
