import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { PLANNING_AGENT_IDS } from "./contract.ts"
import { planningAgents } from "./index.ts"

const here = import.meta.dir
/** Owner's cap per agent prompt, shared output section included (the prompt as the agent receives it). */
const PROMPT_TOKEN_CEILING = 1_500

async function tokens(text: string): Promise<number> {
  const { TokenCounter } = await import("repomix")
  const counter = new TokenCounter("o200k_base")
  try {
    await counter.init()
    return counter.countTokens(text)
  } finally {
    counter.free()
  }
}

test("every agent file is indexed, every contract id has a file, and the index matches", () => {
  const files = readdirSync(join(here, "agents"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -3))
    .sort()
  expect(files).toEqual([...PLANNING_AGENT_IDS].sort())
  expect(planningAgents.map((agent) => String(agent.id)).sort()).toEqual(files)
  const index = readFileSync(join(here, "index.ts"), "utf8")
  for (const file of files) expect(index).toContain(`"./agents/${file}.md"`)
})

test("use-when lines are unique, one sentence, and under 25 words", () => {
  const seen = new Set<string>()
  for (const agent of planningAgents) {
    const words = agent.useWhen.split(/\s+/).length
    expect(words, agent.id).toBeLessThan(26)
    expect(agent.useWhen.match(/[.!?](\s|$)/g)?.length, agent.id).toBe(1)
    expect(seen.has(agent.useWhen), agent.id).toBe(false)
    seen.add(agent.useWhen)
  }
})

test("prompts avoid forbidden names and carry the shared output section once", () => {
  for (const agent of planningAgents) {
    expect(agent.prompt, agent.id).not.toMatch(/elephant|goldfish|\begm\b/i)
    expect(agent.prompt.match(/## Output/g)?.length, agent.id).toBe(1)
    expect(agent.prompt, agent.id).toContain(`id: ${agent.id}`)
  }
  for (const name of readdirSync(here, { recursive: true }) as string[])
    if (/\.(md|ts)$/.test(name) && !name.endsWith("index.test.ts"))
      expect(readFileSync(join(here, name), "utf8"), name).not.toMatch(/elephant|goldfish|\begm\b/i)
})

test("prompt sizes stay under the ceiling (o200k_base)", async () => {
  for (const agent of planningAgents) {
    const size = await tokens(agent.prompt)
    console.log(`planning prompt ${agent.id}: ${size} tokens`)
    expect(size, agent.id).toBeLessThanOrEqual(PROMPT_TOKEN_CEILING)
  }
})
