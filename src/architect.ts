import { Agent } from "@opencode/plugin/effect"
import type { Plugin } from "@opencode/plugin/effect"
import { Schema } from "effect"
import source from "./architect.md" with { type: "text" }

const sections = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source)
if (!sections) throw new Error("Architect definition requires YAML frontmatter and a prompt")
const metadata: unknown = Bun.YAML.parse(sections[1]!)
if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
  throw new Error("Architect frontmatter must be an object")
}

export const architect = Schema.decodeUnknownSync(Agent.Info)({
  ...Agent.Info.default(Agent.ID.make("architect")),
  ...metadata,
  id: "architect",
  system: sections[2]!.trim(),
})

export function registerArchitect(ctx: { agent: Pick<Plugin.Context["agent"], "transform"> }) {
  return ctx.agent.transform((editor) => {
    // In OpenCode 2.2.5, update creates missing IDs. No repository file is needed.
    editor.update(architect.id, (agent) => {
      Object.assign(agent, structuredClone(architect))
    })
  })
}
