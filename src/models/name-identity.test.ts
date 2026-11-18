import { describe, expect, test } from "bun:test"
import { createModelIndex, deriveFamilyVendors, foldName, parseModelName } from "./name-identity.ts"
import { EPOCH_NAME_PAIRS, OPENROUTER_MODELS_DEV_PAIRS } from "./name-identity.fixture.ts"

const sameModel = (names: string[]) => {
  const keys = names.map((name) => parseModelName(name).key)
  expect([...new Set(keys)]).toHaveLength(1)
}

describe("parseModelName", () => {
  test("every spelling of Claude Sonnet 4.5 is one identity", () => {
    sameModel([
      "anthropic/claude-sonnet-4.5",
      "claude-sonnet-4-5-20250929",
      "Claude Sonnet 4.5",
      "claude-4.5-sonnet",
      "anthropic.claude-sonnet-4-5-v1:0",
      "Claude 4.5 Sonnet (Sep '25)",
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    ])
  })

  test("GPT-5 mini, Gemini 2.5 Pro, Qwen3 Coder and Kimi K2 spellings agree", () => {
    sameModel(["openai/gpt-5-mini", "gpt-5-mini-2025-08-07", "GPT-5 mini", "gpt-5-mini_medium"])
    sameModel([
      "google/gemini-2.5-pro-preview-06-05",
      "Gemini 2.5 Pro",
      "gemini-2.5-pro",
      "models/gemini-2.5-pro-preview-03-25",
    ])
    sameModel(["qwen/qwen3-coder", "qwen3-coder:free", "Qwen3 Coder"])
    sameModel(["moonshotai/kimi-k2", "Kimi K2 0905", "kimi-k2-0905", "Kimi K2"])
  })

  test("effort is carried beside the identity, not in it", () => {
    const high = parseModelName("gpt-5 (high)")
    expect(high.effort).toBe("high")
    expect(high.key).toBe(parseModelName("gpt-5").key)
    expect(parseModelName("gpt-5-2025-08-07_high").effort).toBe("high")
    expect(parseModelName("claude-opus-4-20250514_32K").effort).toBe("32k")
    expect(parseModelName("gpt-5-2025-08-07_unknown").effort).toBeNull()
  })

  test("what changes the model stays in the identity", () => {
    const keys = [
      "gpt-5",
      "gpt-5-mini",
      "gpt-5-nano",
      "gpt-5-chat",
      "gpt-5-codex",
      "gpt-4o",
      "gpt-4o-mini",
      "o3",
      "o3-mini",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-3-pro",
      "claude-opus-4",
      "claude-opus-4.1",
      "claude-sonnet-4",
      "claude-3-7-sonnet",
      "claude-3-5-sonnet",
      "deepseek-v3",
      "deepseek-v3.2",
      "deepseek-r1",
      "qwen3-32b",
      "qwen3-235b-a22b",
      "claude-sonnet-4-thinking",
      "kimi-k2",
      "kimi-k2.5",
    ].map((name) => parseModelName(name).key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  test("sizes, dates, noise and routing are separated", () => {
    expect(parseModelName("Qwen3 Coder 480B").size).toBe("480b")
    expect(parseModelName("qwen3-235b-a22b-instruct-2507").size).toBe("235b")
    expect(parseModelName("gpt-4.1-2025-04-14").date).toBe("2025-04-14")
    expect(parseModelName("openai/gpt-oss-120b:free").key).toBe(parseModelName("gpt-oss-120b").key)
    expect(parseModelName("accounts/fireworks/models/glm-4p5").key).toBe(
      parseModelName("glm-4.5").key,
    )
    expect(parseModelName("gemini-2.0-flash-exp").key).toBe(parseModelName("gemini-2.0-flash").key)
    expect(parseModelName("gemini-3.0-pro").key).toBe(parseModelName("gemini-3-pro").key)
  })

  test("the vendor comes from a prefix or the source's own field", () => {
    expect(parseModelName("x-ai/grok-4").vendor).toBe("xai")
    expect(parseModelName("anthropic.claude-opus-4-1").vendor).toBe("anthropic")
    expect(parseModelName("claude-opus-4-1", { vendor: "google-vertex-anthropic" }).vendor).toBe(
      "anthropic",
    )
    expect(parseModelName("claude-opus-4-1").vendor).toBeNull()
  })

  test("foldName only unifies separators and case", () => {
    expect(foldName("Anthropic/Claude_Sonnet-4.5")).toBe("anthropic claude sonnet 4 5")
  })
})

describe("createModelIndex", () => {
  const catalog = createModelIndex([
    { id: "anthropic/claude-sonnet-4-5-20250929", names: ["Claude Sonnet 4.5"], value: 1 },
    { id: "anthropic/claude-sonnet-4-5-20251201", value: 2 },
    { id: "openai/gpt-5", value: 3 },
    { id: "openai/gpt-5-mini", value: 4 },
    { id: "openai/gpt-5-chat", value: 5 },
    { id: "qwen/qwen3-coder-480b-a35b", value: 6 },
    { id: "qwen/qwen3-32b", value: 7 },
    { id: "qwen/qwen3-235b-a22b", value: 8 },
    { id: "moonshotai/kimi-k2", value: 9 },
    { id: "moonshotai/kimi-k2.5", value: 10 },
  ])
  const values = (result: ReturnType<typeof catalog.resolve>) =>
    result.status === "matched" ? result.items.map((item) => item.value).sort() : []

  test("records the tier that matched", () => {
    const exact = catalog.resolve("openai/gpt-5")
    expect(exact.status === "matched" && exact.tier).toBe("exact-id")
    const cross = catalog.resolve("Claude Sonnet 4.5")
    expect(cross.status === "matched" && cross.tier).toBe("cross-id")
    const identity = catalog.resolve("GPT-5 mini")
    expect(identity.status === "matched" && identity.tier).toBe("identity")
    expect(values(identity)).toEqual([4])
  })

  test("dated snapshots of one identity are one model", () => {
    const result = catalog.resolve("claude-4.5-sonnet")
    expect(result.status).toBe("matched")
    expect(values(result)).toEqual([1, 2])
  })

  test("never crosses a tier or a major version", () => {
    expect(values(catalog.resolve("gpt-5"))).toEqual([3])
    expect(values(catalog.resolve("gpt-5-nano")).length).toBe(0)
    expect(catalog.resolve("gpt-4-mini").status).toBe("unmatched")
    expect(catalog.resolve("claude-sonnet-5").status).toBe("unmatched")
    expect(values(catalog.resolve("kimi-k2"))).toEqual([9])
    expect(values(catalog.resolve("Kimi K2.5"))).toEqual([10])
  })

  test("a size the row omits does not block the match; two sizes are not guessed", () => {
    const loose = catalog.resolve("qwen3-coder")
    expect(loose.status === "matched" && loose.tier).toBe("identity-relaxed")
    expect(values(loose)).toEqual([6])
    const twoSizes = createModelIndex([
      { id: "qwen3-32b", value: 1 },
      { id: "qwen3-235b", value: 2 },
    ])
    const ambiguous = twoSizes.resolve("qwen3")
    expect(ambiguous.status).toBe("unmatched")
    expect(ambiguous.status === "unmatched" && ambiguous.reason).toBe("ambiguous")
    expect(twoSizes.resolve("Qwen3 32B").status).toBe("matched")
  })

  test("a reviewed alias reaches a genuine rename and says so", () => {
    const index = createModelIndex([{ id: "gpt-5.5", value: 1 }])
    const result = index.resolve("gpt-5.5-pre-release_xhigh")
    expect(result.status === "matched" && result.tier).toBe("alias")
  })

  test("unmatched rows say why", () => {
    const result = catalog.resolve("yi-lightning")
    expect(result.status).toBe("unmatched")
    expect(result.status === "unmatched" && result.reason).toBe("no-identity-match")
  })

  test("the vendor settles a copy under two providers", () => {
    const index = createModelIndex([
      { id: "foo/llama-3.1-8b-instruct", vendor: "other", value: 1 },
      { id: "meta-llama/llama-3.1-8b-instruct", value: 2 },
    ])
    const result = index.resolve("meta-llama/llama-3.1-8b-instruct-turbo")
    expect(result.status).toBe("unmatched")
    const exactish = index.resolve("Llama 3.1 8B Instruct", { vendor: "meta" })
    expect(exactish.status === "matched" && exactish.items.map((item) => item.value)).toContain(2)
  })

  test("a family's vendor is derived from the rows, not listed", () => {
    const vendors = deriveFamilyVendors([
      { name: "claude-opus-4", vendor: "anthropic" },
      { name: "claude-sonnet-4", vendor: "anthropic" },
      { name: "gpt-5", vendor: "openai" },
    ])
    expect(vendors.get("claude")).toBe("anthropic")
    expect(vendors.get("gpt")).toBe("openai")
  })
})

describe("real names from the sources", () => {
  test("Epoch hub names join the catalog entry that is the same model", () => {
    const expected = EPOCH_NAME_PAIRS.flatMap(([, id]) => (id ? [id] : []))
    const index = createModelIndex([...new Set(expected)].map((id) => ({ id, value: id })))
    const failures: string[] = []
    for (const [name, want] of EPOCH_NAME_PAIRS) {
      const result = index.resolve(name)
      if (want === null) {
        if (result.status === "matched") failures.push(`${name} should stay unmatched`)
      } else if (result.status !== "matched" || !result.items.some((item) => item.value === want))
        failures.push(`${name} -> ${want}`)
    }
    expect(failures).toEqual([])
    expect(EPOCH_NAME_PAIRS.length).toBeGreaterThan(100)
  })

  test("OpenRouter and models.dev entries for one model are joined by name alone", () => {
    const index = createModelIndex(
      OPENROUTER_MODELS_DEV_PAIRS.map(([, , id, name]) => ({
        id,
        names: [name],
        vendor: id.split("/")[0],
        value: id,
      })),
    )
    const failures: string[] = []
    for (const [devID, devName, orID] of OPENROUTER_MODELS_DEV_PAIRS) {
      const [provider, ...rest] = devID.split("/")
      const result = index.resolve(rest.join("/"), { vendor: provider })
      const byName = result.status === "matched" ? result : index.resolve(devName)
      if (byName.status !== "matched" || !byName.items.some((item) => item.value === orID))
        failures.push(`${devID} -> ${orID}`)
    }
    expect(failures).toEqual([])
  })
})
