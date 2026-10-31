import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { nativeWorkerOptions } from "./catalog.ts"

test("worker route advice reads live native choices without gating catalog metadata", async () => {
  const listedAt: string[] = []
  const selected = { providerID: "private-provider", id: "not-in-the-catalog", variant: "careful" }
  const ctx = {
    location: { directory: "/project" },
    model: {
      list: (input: { location: { directory: string } }) => {
        listedAt.push(input.location.directory)
        return Effect.succeed({
          data: [
            {
              providerID: "opencode-go",
              id: "qwen3.8-flash",
              name: "Qwen3.8 Flash",
              enabled: true,
              type: "chat",
              capabilities: { tools: false, input: ["text"], output: ["text"] },
              limit: { context: 256_000 },
              cost: [
                {
                  tier: undefined,
                  input: 0.15,
                  output: 0.47,
                  cache: { read: 0.016, write: 0.15 },
                },
              ],
              variants: [{ id: "xhigh" }],
            },
            {
              providerID: "private-provider",
              id: "missing-metadata",
              name: "Configured model",
              enabled: false,
              limit: {},
              cost: [],
              variants: [],
            },
          ],
        })
      },
    },
    agent: {
      get: () => Effect.succeed({ data: { model: selected } }),
    },
  } as unknown as Plugin.Context

  const result = await nativeWorkerOptions(ctx)
  expect(listedAt).toEqual(["/project"])
  expect(result.advisoryOnly).toBe(true)
  expect(JSON.parse(JSON.stringify(result.configuredImplementor))).toEqual(selected)
  expect(result.options).toHaveLength(2)
  expect(result.options[0]).toMatchObject({
    providerID: "opencode-go",
    id: "qwen3.8-flash",
    enabled: true,
    capabilities: { tools: false },
    pricesUSDPerMillionTokens: [{ input: 0.15, output: 0.47, cacheRead: 0.016, cacheWrite: 0.15 }],
    variants: ["xhigh"],
  })
  expect(result.options[1]).toMatchObject({
    providerID: "private-provider",
    id: "missing-metadata",
    enabled: false,
    capabilities: { tools: null, input: null, output: null },
    pricesUSDPerMillionTokens: null,
    variants: [],
  })
  expect(result.note).toContain("not rejected or substituted")
})
