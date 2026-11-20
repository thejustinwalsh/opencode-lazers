import type { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { deriveSourceDefinition } from "../context/repo-map.ts"
import { Delivery, runbook } from "../guidance/index.ts"
import type { TaskRepository } from "../storage.ts"
import { getLatestFallowConfig } from "../audit/config.ts"
import { parseProfile, profileDiff } from "./profile.ts"
import { proveProfile } from "./profile-proof.ts"
import type { ProofWorkspace } from "./profile-proof.ts"
import { activeProfileForKey, proposeRevision } from "./profile-store.ts"
import { profileViewOf } from "./rpc.ts"
import { projectForDirectory } from "./registry.ts"
import { projectKeyOfDirectory } from "./settings.ts"
import { toolchainFacts } from "./toolchains.ts"

const REPO_FALLOW_CONFIGS = [".fallowrc.json", ".fallowrc.jsonc", "fallow.toml", ".fallow.toml"]
const KNOWN_TOOLCHAINS = ["bun", "npm", "pnpm", "yarn", "cargo"]

/**
 * `lz-project-profile`: the Architect reads what a project's profile needs, then proposes the
 * profile as the one JSON document `parseProfile` validates. The runtime proves each command in a
 * native worktree and stores a pending revision. No mode confirms: only the owner does, in Settings.
 */
export function registerProfileTools(
  ctx: Pick<Plugin.Context, "tool" | "permission" | "location">,
  repository: TaskRepository,
  deps: { workspace: ProofWorkspace; dataDirectory: string },
) {
  return ctx.tool.transform((editor) => {
    editor.add({
      name: "lz-project-profile",
      description:
        "Show what this project's verification profile needs, or propose one. Mode show returns the current and pending profile, source filters and hardened installs; mode propose validates the profile JSON, runs each command once in a separate worktree and stores a pending revision the owner confirms in Settings; mode guide returns the setup runbook. The first propose of a session carries the runbook.",
      input: z.strictObject({
        mode: z.enum(["show", "guide", "propose"]).default("show"),
        profile: z.unknown().optional().describe("the profile JSON, for propose"),
        reason: z.string().min(1).max(2000).optional().describe("why, for propose"),
        proofTargets: z
          .record(z.string(), z.array(z.string()))
          .optional()
          .describe("files appended to a verify command for its proof, by verify id"),
      }),
      output: z.record(z.string(), z.unknown()),
      options: { codemode: true, permission: "lz-project-profile" },
      execute: (input, call) =>
        ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lz-project-profile",
            resources: [ctx.location.directory],
          })
          .pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: async (): Promise<{ content: string; output: Record<string, unknown> }> => {
                  const reply = (output: Record<string, unknown>) => ({
                    content: JSON.stringify(output),
                    output,
                  })
                  if (input.mode === "guide") return reply({ guidance: runbook("project-setup") })
                  const directory = repository.projectDirectory
                  const key = projectKeyOfDirectory(repository, directory)
                  if (!key) return reply({ refused: "PROJECT_NOT_REGISTERED" })
                  if (input.mode === "show") {
                    const view = profileViewOf(repository, key)
                    return reply({
                      projectKey: key,
                      code: projectForDirectory(repository, directory)?.code ?? "",
                      ...(view.active ? { active: view.active } : {}),
                      ...(view.pending ? { pending: view.pending } : {}),
                      ...(view.legacySource ? { legacySource: view.legacySource } : {}),
                      derivedSource: await deriveSourceDefinition(directory),
                      hardenedInstalls: Object.fromEntries(
                        KNOWN_TOOLCHAINS.flatMap((name) => {
                          const argv = toolchainFacts(name).hardenedInstall(directory)
                          return argv ? [[name, argv.join(" ")]] : []
                        }),
                      ),
                      fallowConfig: {
                        repositoryFile: REPO_FALLOW_CONFIGS.some((name) =>
                          existsSync(join(directory, name)),
                        ),
                        stored: getLatestFallowConfig(repository) !== undefined,
                      },
                    })
                  }
                  const parsed = parseProfile(input.profile)
                  if (!parsed.ok)
                    return reply({ refused: "PROFILE_INVALID", issues: parsed.issues })
                  const proof = await proveProfile({
                    projectDirectory: directory,
                    dataDirectory: deps.dataDirectory,
                    profile: parsed.profile,
                    ...(input.proofTargets ? { proofTargets: input.proofTargets } : {}),
                    workspace: deps.workspace,
                    repository,
                  })
                  const row = proposeRevision(repository, {
                    projectKey: key,
                    profile: parsed.profile,
                    author: { kind: "architect", sessionID: call.sessionID, agent: call.agent },
                    reason: input.reason ?? "Proposed by the Architect",
                    proofs: proof.proofs,
                    mapPreview: proof.mapPreview,
                  })
                  const delivery = new Delivery(call.sessionID)
                  const output = {
                    revision: row.revision,
                    state: "proposed",
                    proofs: row.proofs,
                    mapPreview: proof.mapPreview,
                    changes: profileDiff(
                      activeProfileForKey(repository, key)?.profile,
                      parsed.profile,
                    ),
                    next: "The owner confirms in Settings, LAZERS, Projects, this project, Verification. Nothing runs from this profile until then.",
                    guidance: delivery.once("project-setup"),
                  }
                  delivery.commit()
                  return reply(output)
                },
                catch: (error) => new Tool.Error({ message: String(error) }),
              }),
            ),
          ),
    })
  })
}
