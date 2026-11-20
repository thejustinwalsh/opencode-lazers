/**
 * Print the complete prompt a planning agent would receive for a plan file, so each agent can be
 * run by hand as a fresh-context session before the runtime exists.
 *
 *   bun scripts/planning-agent-prompt.ts <agent-id> <plan-file> [repository-root]
 *
 * stdout: the agent prompt, the plan in a delimited untrusted block, the repository map.
 * stderr: token counts (o200k_base) per part; a warning, never a refusal, past half the window.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { buildRepoMap, deriveSourceDefinition } from "../src/context/repo-map.ts"
import { PLANNING_AGENT_IDS, PlanningAgentId } from "../src/planning/contract.ts"
import { planningAgent } from "../src/planning/index.ts"
import { planningReviewMessage } from "../src/planning/prompt.ts"

const WINDOW_TOKENS = 256_000

async function countTokens(text: string): Promise<number> {
  const { TokenCounter } = await import("repomix")
  const counter = new TokenCounter("o200k_base")
  try {
    await counter.init()
    return counter.countTokens(text)
  } finally {
    counter.free()
  }
}

const [id, planFile, rootArg] = process.argv.slice(2)
const parsed = PlanningAgentId.safeParse(id)
if (!parsed.success || !planFile) {
  console.error(
    `usage: bun scripts/planning-agent-prompt.ts <${PLANNING_AGENT_IDS.join("|")}> <plan-file> [repository-root]`,
  )
  process.exit(2)
}

const root = resolve(rootArg ?? resolve(import.meta.dir, ".."))
const plan = readFileSync(resolve(planFile), "utf8")
const map = await buildRepoMap(root, await deriveSourceDefinition(root))
const prompt = planningAgent(parsed.data).prompt

const message = planningReviewMessage({ planMarkdown: plan, source: planFile, mapText: map.text })

process.stdout.write([prompt.trimEnd(), message].join("\n\n") + "\n")

const mapAt = message.indexOf("## Repository map")
const [promptTokens, planTokens, mapTokens] = await Promise.all([
  countTokens(prompt),
  countTokens(message.slice(0, mapAt)),
  countTokens(message.slice(mapAt)),
])
const total = promptTokens + planTokens + mapTokens
console.error(
  `tokens (o200k_base): prompt ${promptTokens}, plan ${planTokens}, map ${mapTokens}, total ${total}`,
)
if (total > WINDOW_TOKENS / 2)
  console.error(
    `warning: total ${total} passes half of ${WINDOW_TOKENS}; the agent is told to review the plan in sections`,
  )
