import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { TaskRepository } from "../storage.ts"

/** Hand-written two-commit repositories for the audit tests. Not shipped. */

export const FIXTURE_CONFIG = { entry: ["src/index.ts"], rules: { "unused-class-members": "off" } }

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
  const out = await new Response(proc.stdout).text()
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed`)
  return out.trim()
}

export type Files = Record<string, string>

export function write(dir: string, files: Files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
}

async function commit(dir: string, message: string) {
  await git(dir, "add", "-A")
  await git(
    dir,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    message,
  )
  return git(dir, "rev-parse", "HEAD")
}

/** `depth` nested ifs: cognitive complexity depth * (depth + 1) / 2. */
export function nested(name: string, depth: number, extra = 0): string {
  let body = "return 1\n"
  for (let i = depth; i >= 1; i--) body = `if (a > ${i}) {\n${body}}\n`
  const flat = Array.from({ length: extra }, (_, i) => `if (a > ${100 + i}) { a++ }\n`).join("")
  return `export function ${name}(a: number): number {\n${body}${flat}return 0\n}\n`
}

export type Fixture = {
  dir: string
  base: string
  head: string
  repository: TaskRepository
  cleanup: () => void
}

/**
 * A repository with a base commit and a head commit. `config` is committed in the base commit
 * (the repository's own Fallow config); pass `null` for a project with none.
 */
export async function fixture(input: {
  base: Files
  head: Files
  config?: object | null
  /** Leave the head edits uncommitted in the working tree. */
  uncommitted?: boolean
}): Promise<Fixture> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lz-audit-fixture-")))
  await git(dir, "init", "-q", "-b", "main")
  const config = input.config === undefined ? FIXTURE_CONFIG : input.config
  write(dir, {
    ".gitignore": "data/\n",
    "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }),
    ...(config ? { ".fallowrc.json": JSON.stringify(config) } : {}),
    ...input.base,
  })
  const base = await commit(dir, "base")
  write(dir, input.head)
  const head = input.uncommitted ? base : await commit(dir, "head")
  mkdirSync(join(dir, "data"), { recursive: true })
  const repository = new TaskRepository(join(dir, "data", "tasks.sqlite"), dir)
  return {
    dir,
    base,
    head,
    repository,
    cleanup: () => {
      repository.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
