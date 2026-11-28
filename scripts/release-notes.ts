import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

export function releaseSection(changelog: string, version: string): string | null {
  const lines = changelog.split("\n")
  const start = lines.findIndex((line) => {
    const heading = /^##\s+\[?v?(\d+\.\d+\.\d+)\]?(?:\s|$)/.exec(line)
    return heading?.[1] === version
  })
  if (start < 0) return null
  const next = lines.findIndex((line, index) => index > start && /^##\s/.test(line))
  return (
    lines
      .slice(start + 1, next < 0 ? undefined : next)
      .join("\n")
      .trim() || null
  )
}

export function commitNotes(log: string, repository: string): string {
  const groups = new Map<string, string[]>()
  for (const line of log.trim().split("\n")) {
    const [sha, subject] = line.split("\t")
    if (!sha || !subject) continue
    const match = /^(\w+)(?:\(([^)]+)\))?(!)?:\s+(.+)$/.exec(subject)
    const type = match?.[1]
    const group = type === "feat" ? "Added" : type === "fix" ? "Fixed" : "Changed"
    const summary = match ? `${match[2] ? `${match[2]}: ` : ""}${match[4]}` : subject
    const entries = groups.get(group) ?? []
    entries.push(
      `- ${summary}${match?.[3] ? " (breaking change)" : ""} ([${sha.slice(0, 8)}](${repository}/commit/${sha}))`,
    )
    groups.set(group, entries)
  }
  return [...groups].map(([group, entries]) => `### ${group}\n\n${entries.join("\n")}`).join("\n\n")
}

if (import.meta.main) {
  const [tag, destination, requestedRef] = process.argv.slice(2)
  if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag) || !destination)
    throw Error("Usage: bun scripts/release-notes.ts vMAJOR.MINOR.PATCH OUTPUT_FILE [SOURCE_REF]")
  const sourceRef = requestedRef ?? tag
  const git = (args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { stderr: "pipe" })
    if (result.exitCode) throw Error(result.stderr.toString().trim())
    return result.stdout.toString().trim()
  }
  const manifest = JSON.parse(await readFile("package.json", "utf8"))
  const repository = manifest.repository.url.replace(/^git\+/, "").replace(/\.git$/, "")
  const version = tag.slice(1)
  const changelog = await readFile("CHANGELOG.md", "utf8").catch(() => "")
  let body = releaseSection(changelog, version)
  if (!body) {
    let previous: string | undefined
    try {
      previous = git(["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", `${sourceRef}^`])
    } catch {}
    body = commitNotes(
      git([
        "log",
        "--first-parent",
        "--format=%H%x09%s",
        previous ? `${previous}..${sourceRef}` : sourceRef,
      ]),
      repository,
    )
    if (previous) body += `\n\n[Full changelog](${repository}/compare/${previous}...${tag})`
  }
  if (!body) throw Error(`No release notes found for ${tag}`)
  const output = resolve(destination)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `# LAZERS ${tag}\n\n${body}\n`)
}
