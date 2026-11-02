import { expect, test } from "bun:test"
import { Command, MenuItem, Panel, Style } from "@opencode/plugin/gui"
import type { PanelProps } from "@opencode/plugin/gui"
import type { Component } from "solid-js"
import { ObservationChangeTracker } from "../../src/observability/changes.ts"
import type { ObservationScope } from "../../src/observability/contract.ts"
import { makeFixture } from "../trajectory/fixture.ts"
import { RadarPanelState } from "../../src/radar/state.ts"
import { createRadarTransport } from "../../src/radar/transport.ts"
import type { RadarRPC } from "../../src/radar/transport.ts"
import { registerRadarPanel } from "../../src/radar/registration.ts"
import { radarProjectIdentity } from "../../src/radar/project.ts"
import { operationalReads } from "./operational.ts"

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error("Condition was not reached")
}

test("native registration exposes its closable tab and renders through real observation adapters", async () => {
  const fixture = makeFixture()
  let state: RadarPanelState | undefined
  try {
    const nativeProjectID = "b5da4cadd97e51f2f6c88ff71daa1006f6a5b7df"
    const canonicalDirectory = "/workspace/opencode-lazers"
    const identity = radarProjectIdentity({ id: nativeProjectID, canonical: canonicalDirectory })
    expect(identity).toEqual({ project: canonicalDirectory, projectID: nativeProjectID })
    const secret = new Uint8Array(32).fill(11)
    const reads = operationalReads(fixture, nativeProjectID, secret)
    const tracker = new ObservationChangeTracker(fixture.repository, secret, nativeProjectID)
    tracker.initialize()
    const rpc: RadarRPC = {
      snapshot: async ({ scope }) => reads.snapshot(scope, tracker),
      radar: async (input, _options) => reads.radar(input, tracker, _options.signal),
      events: {
        subscribe: (_name, { signal }) =>
          (async function* () {
            await new Promise<void>((resolve) => {
              if (signal.aborted) return resolve()
              signal.addEventListener("abort", () => resolve(), { once: true })
            })
            yield* []
          })(),
      },
    }
    const session = { id: "ses-radar", location: {} }
    const opened: unknown[] = []
    const registrations: Array<{ kind: unknown; value: unknown }> = []
    const context = {
      id: "lazers",
      add: (kind: unknown, value: unknown) => registrations.push({ kind, value }),
      sessions: { current: () => session },
      layout: { open: (...args: unknown[]) => opened.push(args) },
    }
    const render: Component<PanelProps> = () => {
      state = new RadarPanelState(() => {})
      const scope: ObservationScope = { kind: "session", sessionID: "ses-failed" }
      state.connect(
        "session-radar",
        identity.projectID,
        scope,
        createRadarTransport(
          () => rpc,
          identity.project,
          () => true,
        ),
      )
      return null
    }
    registerRadarPanel(context as never, render, () => null)

    expect(registrations.some((item) => item.kind === Style)).toBe(true)
    const panel = registrations.find((item) => item.kind === Panel)?.value as {
      id: string
      region: string
      list: (input: { open: string[] }) => Array<{ id: string; title: string; closable: string }>
      render: (props: PanelProps) => unknown
    }
    expect(panel).toMatchObject({ id: "radar", region: "side" })
    expect(panel.list({ open: [] })).toEqual([])
    expect(panel.list({ open: ["radar"] })).toMatchObject([
      { id: "radar", title: "Radar", closable: "hover" },
    ])

    const command = registrations.find((item) => item.kind === Command)?.value as {
      id: string
      run: () => void
    }
    const menu = registrations.find((item) => item.kind === MenuItem)?.value as {
      id: string
      run: () => void
    }
    command.run()
    menu.run()
    expect(opened).toHaveLength(2)
    panel.render({} as PanelProps)
    await until(() => Boolean(state?.data.snapshot) && Boolean(state?.data.radar))
    expect(state?.data.snapshot?.machine.version).toBe("lazers-task/1")
    expect(state?.data.snapshot?.projectID).toBe(nativeProjectID)
    expect(state?.data.snapshot?.transitions.map((item) => item.sequence)).toEqual([1, 2, 3])
    expect(state?.data.snapshot?.plans[0]?.nodes[0]?.state).toBe("accepted")
    expect(state?.data.radar?.sessions.map((item) => item.sessionID)).toContain("ses-failed")
  } finally {
    state?.close()
    fixture.close()
  }
})
