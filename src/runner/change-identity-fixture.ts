import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { git } from "./artifacts.ts"

const roots: string[] = []

/** Remove every repository created by `fixtureRepo`; call from `afterEach`. */
export function cleanupFixtureRepos() {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}

/** Unsigned temp repository on `main` with a fixed local identity. */
export function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "lazers-change-identity-"))
  roots.push(root)
  git(root, ["init", "--initial-branch=main"])
  git(root, ["config", "user.name", "fixture"])
  git(root, ["config", "user.email", "fixture@example.invalid"])
  git(root, ["config", "commit.gpgsign", "false"])
  return root
}

export function commitFile(root: string, name: string, content: string, message = name): string {
  writeFileSync(join(root, name), content)
  git(root, ["add", "--all"])
  git(root, ["commit", "-m", message])
  return git(root, ["rev-parse", "HEAD"])
}
