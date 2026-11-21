import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { ALLOWED, check, scanFile } from "./check-show-reads.ts"

const methods = (source: string) =>
  scanFile("panel.tsx", source).calls.map((call) => `${call.contract}.${call.method}`)

describe("scan", () => {
  test("finds a chained call, a bound handle, an arrow handle and a method that returns one", () => {
    expect(
      methods(`
        await client.rpc(Models).priceSources({ sessionID }, options)
        const models = value.client.rpc(Models)
        models.refreshSources({ sessionID }, options)
        const rpc = () => ctx.client.rpc(Retention)
        await rpc().status({}, options)
        class Adapter {
          private rpc() {
            return this.ctx.client.rpc(NativeInteraction)
          }
          stop() {
            return this.rpc().detach({ binding })
          }
        }
      `),
    ).toEqual([
      "Models.priceSources",
      "Models.refreshSources",
      "Retention.status",
      "NativeInteraction.detach",
    ])
  })

  test("the streams contract and commented examples are not calls", () => {
    expect(
      methods(`
        const transport = rpcStreamsTransport(() => client.rpc(Streams) as unknown as StreamsRpc)
        // client.rpc(Models).sourceEvidence({ sessionID })
        /** Call: \`client.rpc(Retention).preview({ days: 30 })\` */
      `),
    ).toEqual([])
  })

  test("a handle passed somewhere the check cannot follow is reported", () => {
    expect(scanFile("panel.tsx", "use(client.rpc(Models))").unresolved).toEqual([
      { file: "panel.tsx", line: 1, contract: "Models" },
    ])
  })
})

describe("check", () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })
  const project = (panel: string) => {
    const root = mkdtempSync(join(tmpdir(), "show-reads-"))
    roots.push(root)
    mkdirSync(join(root, "src/models"), { recursive: true })
    writeFileSync(join(root, "src/gui.tsx"), 'import { Panel } from "./models/panel"\n')
    writeFileSync(join(root, "src/models/panel.tsx"), panel)
    return root
  }

  test("a new RPC read in a panel fails; the allowed write passes", () => {
    const result = check(
      project(`
        export async function Panel(client) {
          const rows = await client.rpc(Models).modelGroups({ sessionID: "ses" })
          await client.rpc(Models).configure({ sessionID: "ses" })
          return rows
        }
      `),
      { "Models.configure": "write" },
    )
    expect(result.disallowed.map((call) => [call.file, call.line, call.method])).toEqual([
      ["src/models/panel.tsx", 3, "modelGroups"],
    ])
    expect(result.stale).toEqual([])
  })

  test("an allowed method no GUI code calls any more is stale", () => {
    const result = check(project("export const Panel = () => null\n"), {
      "Models.configure": "write",
    })
    expect(result.stale).toEqual(["Models.configure"])
  })

  test("the repository's GUI calls only allowed methods, and every allowed method is called", () => {
    const result = check(fileURLToPath(new URL("..", import.meta.url)))
    expect(result.disallowed).toEqual([])
    expect(result.unresolved).toEqual([])
    expect(result.stale).toEqual([])
    for (const reason of Object.values(ALLOWED)) expect(reason.length).toBeGreaterThan(0)
  })
})
