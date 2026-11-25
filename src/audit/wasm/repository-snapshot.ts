import { execFileSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { trackedSources } from "./test-support.ts"

function commitSnapshot(root: string, message: string): void {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" })
  git("init", "-q", "-b", "main")
  git("add", ".")
  git("commit", "-q", "-m", message)
}

export function createSnapshotFixture(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fallow-snapshot-source-")))
  try {
    for (const [path, text] of Object.entries(files)) {
      const target = join(root, path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, text)
    }
    commitSnapshot(root, "source")
    return root
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

export async function withRepositorySnapshot<T>(
  sourceRoot: string,
  run: (snapshotRoot: string) => Promise<T>,
): Promise<T> {
  const snapshotRoot = realpathSync(mkdtempSync(join(tmpdir(), "fallow-repo-snapshot-")))
  try {
    for (const path of trackedSources(sourceRoot)) {
      const source = join(sourceRoot, path)
      if (!existsSync(source)) continue
      const target = join(snapshotRoot, path)
      mkdirSync(dirname(target), { recursive: true })
      cpSync(source, target, { verbatimSymlinks: true })
    }
    commitSnapshot(snapshotRoot, "snapshot")
    return await run(snapshotRoot)
  } finally {
    rmSync(snapshotRoot, { recursive: true, force: true })
  }
}
