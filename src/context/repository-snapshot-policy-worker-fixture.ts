import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { parentPort } from "node:worker_threads"
import { runRemoteAction } from "repomix"
import type { RepoProcessingInput } from "./repo-processor.ts"
import { processRepositorySnapshot } from "./repo-processor.ts"

if (!parentPort) throw new Error("Repository policy fixture requires a worker thread")

type RemoteDependencies = NonNullable<Parameters<typeof runRemoteAction>[2]>

const port = parentPort
port.on("message", async (input: RepoProcessingInput) => {
  try {
    const dependencies: RemoteDependencies = {
      isGitInstalled: async () => true,
      execGitShallowClone: async () => {},
      getRemoteRefs: async () => [],
      runDefaultAction: async (_directories, _cwd, cliOptions) => {
        if (
          process.env.REPOMIX_REMOTE_TRUST_CONFIG !== "false" ||
          cliOptions.remoteTrustConfig !== false ||
          cliOptions.skipLocalConfig !== true ||
          cliOptions.skipGlobalConfig !== true ||
          cliOptions.enableFileProcessors !== false ||
          cliOptions.confineToBaseDir !== true
        )
          throw new Error("Remote Repomix trust boundary was not disabled")

        const source = "## Safe fixture source\nexport const safe = true;\n"
        writeFileSync(cliOptions.output!, source)
        return {
          packResult: {
            processedFiles: [
              { path: "src/safe.ts", content: "export const safe = true;", level: "compress" },
            ],
            skippedFiles: [],
            totalCharacters: source.length,
            totalTokens: 12,
            outputFiles: [cliOptions.output!],
          },
          config: {
            output: { filePath: cliOptions.output! },
            skillGenerate: undefined,
          },
        } as never
      },
      downloadGitHubArchive: async (_repository, directory) => {
        const marker = process.env.LAZERS_REPO_SNAPSHOT_CONFIG_MARKER
        if (!marker) throw new Error("Hostile config marker was not provided")
        writeFileSync(
          join(directory, "repomix.config.js"),
          `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(marker)}, "executed")\nexport default { output: { headerText: "hostile repository config" } }\n`,
        )
      },
      isGitHubRepository: () => true,
      parseGitHubRepoInfo: () => ({ owner: "owner", repo: "project" }) as never,
      isArchiveDownloadSupported: () => true,
      confirmRemoteConfigTrust: async () => {
        throw new Error("Remote repository config was unexpectedly trusted")
      },
    }
    await processRepositorySnapshot(input, (repository, options) =>
      runRemoteAction(repository, options, dependencies),
    )
    port.postMessage({ ok: true })
  } catch (error) {
    port.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    port.close()
  }
})
