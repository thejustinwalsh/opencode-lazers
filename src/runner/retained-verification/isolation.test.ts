import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { git, runCheck } from "../artifacts.ts"
import {
  createRetainedCheckContext,
  observeRetainedCheckContext,
  observeRetainedCheckIsolationWitness,
  removeRetainedCheckContextFromWitness,
  retainedCheckIsolationWitness,
} from "./isolation.ts"
import { retainedProcedurePlan } from "./procedure.ts"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function writeFixtureProject(root: string) {
  for (const directory of [
    "src/runner",
    "src/verification/resources",
    "src/verification/probe",
    "test/retained-verification",
    "scripts",
    "vendor",
    "node_modules/.bin",
    "node_modules/fixture-package/bin",
    "node_modules/fixture-peer",
  ])
    mkdirSync(join(root, directory), { recursive: true })
  for (const directory of [
    "src/verification/resources",
    "src/verification/probe",
    "test/retained-verification",
  ])
    writeFileSync(join(root, directory, ".keep"), "fixture target\n")
  writeFixtureTarball(root, "fixture-peer", "1.0.0", {
    "package.json":
      '{"name":"fixture-peer","version":"1.0.0","type":"module","exports":"./index.js"}\n',
    "index.js": 'export const peerMarker = "peer-resolved-through-private-node-modules"\n',
  })
  writeFixtureTarball(root, "fixture-package", "1.0.0", {
    "package.json":
      '{"name":"fixture-package","version":"1.0.0","type":"module","exports":"./index.js","bin":"bin/cli.js"}\n',
    "index.js":
      'import { peerMarker } from "fixture-peer"\n' +
      "export const marker = `private dependency snapshot: ${peerMarker}`\n",
    "bin/cli.js": "export {}\n",
  })
  writeFileSync(
    join(root, "package.json"),
    '{"name":"retained-fixture","version":"1.0.0","packageManager":"bun@1.4.4-canary.1","scripts":{"build:fixture":"bun scripts/build-fixture.ts"},"dependencies":{"fixture-package":"file:vendor/fixture-package-1.0.0.tgz","fixture-peer":"file:vendor/fixture-peer-1.0.0.tgz"}}\n',
  )
  writeFileSync(join(root, ".gitignore"), "node_modules/\n.cache/\ndist/\n")
  writeFileSync(
    join(root, "scripts", "build-fixture.ts"),
    `import { Database } from "bun:sqlite"\n` +
      `import { mkdir, writeFile } from "node:fs/promises"\n` +
      `import { join } from "node:path"\n` +
      `const project = join(import.meta.dir, "..")\n` +
      `await mkdir(join(project, "dist"), { recursive: true })\n` +
      `await writeFile(join(project, "dist", "fixture-build.txt"), "built candidate\\n")\n` +
      `await mkdir(join(project, ".cache"), { recursive: true })\n` +
      `await writeFile(join(project, ".cache", "fixture-cache.txt"), "private cache\\n")\n` +
      `await mkdir(join(process.env.HOME!, "fixture-profile"), { recursive: true })\n` +
      `await writeFile(join(process.env.HOME!, "fixture-profile", "build.txt"), "private profile\\n")\n` +
      `const db = new Database(process.env.LAZERS_VERIFICATION_SQLITE!)\n` +
      `try { db.exec("CREATE TABLE IF NOT EXISTS build_writes(value TEXT); INSERT INTO build_writes VALUES ('private build')") } finally { db.close() }\n`,
  )
  writeFileSync(
    join(root, "node_modules", "fixture-package", "package.json"),
    '{"name":"fixture-package","version":"1.0.0","type":"module","exports":"./index.js"}\n',
  )
  writeFileSync(
    join(root, "node_modules", "fixture-package", "index.js"),
    'import { peerMarker } from "fixture-peer"\n' +
      "export const marker = `private dependency snapshot: ${peerMarker}`\n",
  )
  writeFileSync(
    join(root, "node_modules", "fixture-peer", "package.json"),
    '{"name":"fixture-peer","version":"1.0.0","type":"module","exports":"./index.js"}\n',
  )
  writeFileSync(
    join(root, "node_modules", "fixture-peer", "index.js"),
    'export const peerMarker = "peer-resolved-through-private-node-modules"\n',
  )
  writeFileSync(join(root, "node_modules", "fixture-package", "bin", "cli.js"), "export {}\n")
  symlinkSync("../fixture-package/bin/cli.js", join(root, "node_modules", ".bin", "fixture"))
  writeFileSync(
    join(root, "src", "runner", "retained-check.test.ts"),
    `import { Database } from "bun:sqlite"\n` +
      `import { appendFileSync, mkdirSync } from "node:fs"\n` +
      `import { dirname, join } from "node:path"\n` +
      `import { expect, test } from "bun:test"\n` +
      `import { marker } from "fixture-package"\n` +
      `test("writes only into the owned check context", () => {\n` +
      `  if (!process.env.LAZERS_VERIFICATION_SQLITE) throw new Error("No private verification database")\n` +
      `  expect(marker).toBe("private dependency snapshot: peer-resolved-through-private-node-modules")\n` +
      `  const sentinel = join(process.env.HOME!, "profile", "sentinel")\n` +
      `  mkdirSync(dirname(sentinel), { recursive: true })\n` +
      `  appendFileSync(sentinel, "verification only\\n")\n` +
      `  const db = new Database(process.env.LAZERS_VERIFICATION_SQLITE!)\n` +
      `  try {\n` +
      `    db.exec("CREATE TABLE IF NOT EXISTS writes(value TEXT); INSERT INTO writes VALUES ('private')")\n` +
      `    expect(db.query("SELECT value FROM writes").get()).toEqual({ value: "private" })\n` +
      `  } finally { db.close() }\n` +
      `})\n`,
  )
  writeFixtureBunLock(root)
}

function writeFixtureTarball(
  root: string,
  name: string,
  version: string,
  files: Record<string, string>,
): string {
  const packageRoot = join(root, "vendor", `${name}-${version}`)
  mkdirSync(packageRoot, { recursive: true })
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(packageRoot, path)), { recursive: true })
    writeFileSync(join(packageRoot, path), contents)
  }
  const archive = join(root, "vendor", `${name}-${version}.tgz`)
  execFileSync("tar", ["-czf", archive, "-C", packageRoot, "."])
  return archive
}

function writeFixtureBunLock(root: string): void {
  const cache = join(root, ".cache", "bun-install")
  const config = join(root, ".cache", "bun-config")
  mkdirSync(cache, { recursive: true })
  mkdirSync(config, { recursive: true })
  execFileSync(
    process.execPath,
    ["install", "--lockfile-only", "--save-text-lockfile", "--ignore-scripts", "--no-progress"],
    {
      cwd: root,
      env: {
        ...process.env,
        BUN_INSTALL_CACHE_DIR: cache,
        BUN_CONFIG_DIR: config,
      },
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  )
}

function commitFixture(root: string): string {
  git(root, ["init", "--initial-branch=main"])
  git(root, ["config", "user.name", "fixture"])
  git(root, ["config", "user.email", "fixture@example.invalid"])
  git(root, ["add", "-A"])
  git(root, ["commit", "-m", "baseline"])
  return git(root, ["rev-parse", "HEAD"])
}

test("an authored Bun test runs in an isolated checkout with private dependencies, SQLite and profile", async () => {
  const root = mkdtempSync(join(tmpdir(), "lazers-retained-isolation-repo-"))
  const state = mkdtempSync(join(tmpdir(), "lazers-retained-isolation-state-"))
  const oldProfile = join(state, "old-profile")
  const candidate = join(state, "candidate")
  const database = join(state, "tasks.sqlite")
  const receiptPath = join(state, "receipt.json")
  cleanups.push(() => {
    try {
      git(root, ["worktree", "remove", candidate])
    } catch {
      // A failing assertion still cleans only this test fixture.
    }
    rmSync(root, { recursive: true, force: true })
    rmSync(state, { recursive: true, force: true })
  })
  writeFileSync(join(root, "tracked.txt"), "baseline\n")
  writeFixtureProject(root)
  const artifact = commitFixture(root)
  git(root, ["worktree", "add", "--detach", candidate, artifact])
  const canonicalCandidate = realpathSync(candidate)
  writeFileSync(database, "")
  const old = new Database(database)
  old.close()
  mkdirSync(oldProfile)
  writeFileSync(join(oldProfile, "sentinel"), "old sentinel\n")
  const oldProfileContents = readFileSync(join(oldProfile, "sentinel"), "utf8")
  const check = {
    id: "isolated-runtime",
    command:
      "bun test src/runner src/verification/resources src/verification/probe test/retained-verification",
    timeoutMs: 10_000,
  } as const
  const procedure = retainedProcedurePlan(check.command)
  if (procedure.status !== "supported") throw new Error(procedure.reason)
  const context = createRetainedCheckContext({
    rootDirectory: state,
    operationID: crypto.randomUUID(),
    generation: 1,
    phase: "task",
    checkID: check.id,
    originalWorkspace: root,
    candidateWorkspace: candidate,
    taskDatabase: database,
    projectDirectory: root,
    candidateArtifact: artifact,
    priorResourcePaths: [oldProfile],
    procedurePlan: procedure.plan,
  })
  expect(context.candidateWorkspace).toBe(canonicalCandidate)
  expect(context.directory).not.toBe(canonicalCandidate)
  expect(context.dependencyLink).toMatchObject({
    path: join(canonicalCandidate, "node_modules"),
    target: join(context.directory, "dependencies"),
  })
  expect(context.environment.TMPDIR).toBe(
    context.procedureBinding.temporaryDirectoryLink?.path ??
      context.resources.find((resource) => resource.name === "tmp")?.realPath,
  )
  if (context.procedureBinding.temporaryDirectoryLink) {
    const temporaryPath = context.environment.TMPDIR!
    const temporaryResource = context.resources.find((resource) => resource.name === "tmp")!
    expect(temporaryPath).toHaveLength(tmpdir().length)
    expect(realpathSync(temporaryPath)).toBe(temporaryResource.realPath)
  }
  const sourceDependency = statSync(join(root, "node_modules", "fixture-package", "index.js"))
  const privateDependency = statSync(
    join(context.directory, "dependencies", "fixture-package", "index.js"),
  )
  expect(`${privateDependency.dev}:${privateDependency.ino}`).not.toBe(
    `${sourceDependency.dev}:${sourceDependency.ino}`,
  )
  expect(observeRetainedCheckContext(context)).toBe(true)

  const witness = retainedCheckIsolationWitness(context)
  const receipt = await runCheck(canonicalCandidate, artifact, check, receiptPath, {
    environment: context.environment,
    environmentIdentity: context.environmentIdentity,
    ownedUntrackedPaths: ["node_modules"],
    isolation: witness,
  })
  expect(receipt.exitCode, receipt.stderr).toBe(0)
  expect(receipt.unchanged).toBe(true)
  expect(receipt.cwd).toBe(canonicalCandidate)
  expect(readFileSync(join(oldProfile, "sentinel"), "utf8")).toBe(oldProfileContents)
  expect(readFileSync(join(context.environment.HOME!, "profile", "sentinel"), "utf8")).toBe(
    "verification only\n",
  )
  const privateDB = new Database(context.environment.LAZERS_VERIFICATION_SQLITE!)
  try {
    expect(privateDB.query<{ value: string }, []>("SELECT value FROM writes").get()?.value).toBe(
      "private",
    )
  } finally {
    privateDB.close()
  }
  expect(existsSync(receiptPath)).toBe(true)
  const expected = {
    operationID: context.operationID,
    generation: context.generation,
    phase: context.phase,
    checkID: context.checkID,
    originalWorkspace: root,
    candidateWorkspace: canonicalCandidate,
    taskDatabase: database,
    projectDirectory: root,
    candidateArtifact: artifact,
    projectIdentity: context.projectIdentity,
    procedurePlan: procedure.plan,
  }
  expect(observeRetainedCheckIsolationWitness(context.directory, receipt.isolation, expected)).toBe(
    true,
  )
  expect(
    new Set(context.resources.map((resource) => `${resource.device}:${resource.inode}`)).size,
  ).toBe(context.resources.length)
  removeRetainedCheckContextFromWitness(context.directory, receipt.isolation, expected)
  expect(existsSync(context.directory)).toBe(false)
  expect(existsSync(join(canonicalCandidate, "node_modules"))).toBe(false)
  if (context.procedureBinding.temporaryDirectoryLink)
    expect(existsSync(context.procedureBinding.temporaryDirectoryLink.path)).toBe(false)
})

test("another project executes a new scoped target against its committed dependency manifest", async () => {
  const root = mkdtempSync(join(tmpdir(), "lazers-retained-other-project-"))
  const state = mkdtempSync(join(tmpdir(), "lazers-retained-other-project-state-"))
  const candidate = join(state, "candidate")
  const oldProfile = join(state, "old-profile")
  const taskDatabase = join(state, "tasks.sqlite")
  const receiptPath = join(state, "receipt.json")
  cleanups.push(() => {
    try {
      git(root, ["worktree", "remove", candidate])
    } catch {
      // A failing assertion still cleans only this test fixture.
    }
    rmSync(root, { recursive: true, force: true })
    rmSync(state, { recursive: true, force: true })
  })

  writeFileSync(join(root, "tracked.txt"), "another project\n")
  writeFixtureProject(root)
  mkdirSync(join(root, "packages", "widget", "test"), { recursive: true })
  writeFileSync(
    join(root, "packages", "widget", "test", "candidate-check.test.ts"),
    `import { Database } from "bun:sqlite"\n` +
      `import { appendFileSync, mkdirSync } from "node:fs"\n` +
      `import { dirname, join } from "node:path"\n` +
      `import { expect, test } from "bun:test"\n` +
      `import { peerMarker } from "fixture-peer"\n` +
      `import { candidateMarker } from "candidate-only-dependency"\n` +
      `test("runs the project-authored target with its candidate dependency environment", () => {\n` +
      `  expect(peerMarker).toBe("peer-resolved-through-private-node-modules")\n` +
      `  expect(candidateMarker).toBe("only-in-committed-candidate-lockfile")\n` +
      `  const sentinel = join(process.env.HOME!, "profile", "candidate")\n` +
      `  mkdirSync(dirname(sentinel), { recursive: true })\n` +
      `  appendFileSync(sentinel, "candidate\\n")\n` +
      `  const db = new Database(process.env.LAZERS_VERIFICATION_SQLITE!)\n` +
      `  try {\n` +
      `    const owner = db.query<{ check_id: string }, []>("SELECT check_id FROM retained_verification_owner").get()\n` +
      `    expect(owner?.check_id).toBe("other-project-scoped-test")\n` +
      `    db.exec("CREATE TABLE IF NOT EXISTS writes(value TEXT); INSERT INTO writes VALUES ('candidate')")\n` +
      `  } finally { db.close() }\n` +
      `})\n`,
  )
  const baseline = commitFixture(root)
  const baselineLock = readFileSync(join(root, "bun.lock"))
  const baselineManifest = readFileSync(join(root, "package.json"))
  git(root, ["checkout", "-b", "candidate-dependency-change"])
  writeFixtureTarball(root, "candidate-only-dependency", "2.3.4", {
    "package.json":
      '{"name":"candidate-only-dependency","version":"2.3.4","type":"module","exports":"./index.js"}\n',
    "index.js": 'export const candidateMarker = "only-in-committed-candidate-lockfile"\n',
  })
  const candidateManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    dependencies: Record<string, string>
  }
  candidateManifest.dependencies["candidate-only-dependency"] =
    "file:vendor/candidate-only-dependency-2.3.4.tgz"
  writeFileSync(join(root, "package.json"), `${JSON.stringify(candidateManifest)}\n`)
  writeFixtureBunLock(root)
  expect(readFileSync(join(root, "bun.lock")).equals(baselineLock)).toBe(false)
  git(root, ["add", "package.json", "bun.lock", "vendor/candidate-only-dependency-2.3.4.tgz"])
  git(root, ["commit", "-m", "candidate dependency manifest"])
  const candidateArtifact = git(root, ["rev-parse", "HEAD"])
  git(root, ["checkout", "main"])
  git(root, ["worktree", "add", "--detach", candidate, candidateArtifact])
  expect(readFileSync(join(candidate, "bun.lock")).equals(baselineLock)).toBe(false)
  expect(readFileSync(join(root, "bun.lock")).equals(baselineLock)).toBe(true)
  expect(readFileSync(join(root, "package.json")).equals(baselineManifest)).toBe(true)
  expect(existsSync(join(root, "node_modules", "candidate-only-dependency"))).toBe(false)
  const rootPeerContents = readFileSync(join(root, "node_modules", "fixture-peer", "index.js"))

  writeFileSync(taskDatabase, "")
  new Database(taskDatabase).close()
  mkdirSync(oldProfile)
  writeFileSync(join(oldProfile, "candidate"), "old\n")
  const procedure = retainedProcedurePlan("bun test packages/widget/test")
  if (procedure.status !== "supported") throw new Error(procedure.reason)
  expect(procedure.plan.targets).toEqual(["packages/widget/test"])
  expect(git(root, ["rev-parse", "HEAD"])).toBe(baseline)

  const context = createRetainedCheckContext({
    rootDirectory: state,
    operationID: crypto.randomUUID(),
    generation: 1,
    phase: "task",
    checkID: "other-project-scoped-test",
    originalWorkspace: root,
    candidateWorkspace: candidate,
    taskDatabase,
    projectDirectory: root,
    candidateArtifact,
    priorResourcePaths: [oldProfile],
    procedurePlan: procedure.plan,
  })
  const privateOnlyPackage = JSON.parse(
    readFileSync(
      join(
        context.resources.find((resource) => resource.name === "dependencies")!.realPath,
        "candidate-only-dependency",
        "package.json",
      ),
      "utf8",
    ),
  ) as { name?: string; version?: string }
  expect(privateOnlyPackage).toMatchObject({ name: "candidate-only-dependency", version: "2.3.4" })
  const witness = retainedCheckIsolationWitness(context)
  const receipt = await runCheck(
    context.candidateWorkspace,
    candidateArtifact,
    {
      id: context.checkID,
      command: "bun test packages/widget/test",
      timeoutMs: 10_000,
    },
    receiptPath,
    {
      environment: context.environment,
      environmentIdentity: context.environmentIdentity,
      ownedUntrackedPaths: ["node_modules"],
      isolation: witness,
    },
  )
  expect(receipt.exitCode, receipt.stderr).toBe(0)
  expect(receipt.unchanged).toBe(true)
  expect(observeRetainedCheckContext(context)).toBe(true)
  expect(readFileSync(join(oldProfile, "candidate"), "utf8")).toBe("old\n")
  expect(readFileSync(join(root, "bun.lock")).equals(baselineLock)).toBe(true)
  expect(readFileSync(join(root, "package.json")).equals(baselineManifest)).toBe(true)
  expect(
    readFileSync(join(root, "node_modules", "fixture-peer", "index.js")).equals(rootPeerContents),
  ).toBe(true)
  expect(existsSync(join(root, "node_modules", "candidate-only-dependency"))).toBe(false)
  expect(readFileSync(join(context.environment.HOME!, "profile", "candidate"), "utf8")).toBe(
    "candidate\n",
  )
  expect(
    observeRetainedCheckIsolationWitness(context.directory, receipt.isolation, {
      operationID: context.operationID,
      generation: context.generation,
      phase: context.phase,
      checkID: context.checkID,
      originalWorkspace: root,
      candidateWorkspace: context.candidateWorkspace,
      taskDatabase,
      projectDirectory: root,
      candidateArtifact,
      projectIdentity: context.projectIdentity,
      procedurePlan: procedure.plan,
    }),
  ).toBe(true)
  const privateDB = new Database(context.environment.LAZERS_VERIFICATION_SQLITE!)
  try {
    expect(privateDB.query<{ value: string }, []>("SELECT value FROM writes").get()?.value).toBe(
      "candidate",
    )
  } finally {
    privateDB.close()
  }
  removeRetainedCheckContextFromWitness(context.directory, receipt.isolation, {
    operationID: context.operationID,
    generation: context.generation,
    phase: context.phase,
    checkID: context.checkID,
    originalWorkspace: root,
    candidateWorkspace: context.candidateWorkspace,
    taskDatabase,
    projectDirectory: root,
    candidateArtifact,
    projectIdentity: context.projectIdentity,
    procedurePlan: procedure.plan,
  })
  expect(existsSync(join(context.candidateWorkspace, "node_modules"))).toBe(false)
})

test("an unavailable candidate-committed dependency source blocks before resources or checks", () => {
  const root = mkdtempSync(join(tmpdir(), "lazers-retained-missing-dependency-source-"))
  const state = mkdtempSync(join(tmpdir(), "lazers-retained-missing-dependency-state-"))
  const candidate = join(state, "candidate")
  const taskDatabase = join(state, "tasks.sqlite")
  cleanups.push(() => {
    try {
      git(root, ["worktree", "remove", candidate])
    } catch {
      // A failing assertion still cleans only this test fixture.
    }
    rmSync(root, { recursive: true, force: true })
    rmSync(state, { recursive: true, force: true })
  })

  writeFileSync(join(root, "tracked.txt"), "missing locked source fixture\n")
  writeFixtureProject(root)
  const artifact = commitFixture(root)
  git(root, ["worktree", "add", "--detach", candidate, artifact])
  rmSync(join(candidate, "vendor", "fixture-peer-1.0.0.tgz"))
  writeFileSync(taskDatabase, "")
  new Database(taskDatabase).close()
  const procedure = retainedProcedurePlan("bun test src/runner")
  if (procedure.status !== "supported") throw new Error(procedure.reason)
  const operationID = crypto.randomUUID()

  expect(() =>
    createRetainedCheckContext({
      rootDirectory: state,
      operationID,
      generation: 1,
      phase: "task",
      checkID: "missing-dependency-source",
      originalWorkspace: root,
      candidateWorkspace: candidate,
      taskDatabase,
      projectDirectory: root,
      candidateArtifact: artifact,
      priorResourcePaths: [],
      procedurePlan: procedure.plan,
    }),
  ).toThrow(
    "Candidate dependency environment cannot be isolated: fixture-peer file source is unavailable",
  )
  expect(existsSync(join(state, `retained-${operationID}-1`))).toBe(false)
  expect(existsSync(join(candidate, "node_modules"))).toBe(false)
  expect(existsSync(join(root, "node_modules", "fixture-peer"))).toBe(true)
})

test("candidate-declared build scripts execute with private build outputs and mutable resources", async () => {
  const root = mkdtempSync(join(tmpdir(), "lazers-retained-authored-build-"))
  const state = mkdtempSync(join(tmpdir(), "lazers-retained-authored-build-state-"))
  const candidate = join(state, "candidate")
  const oldProfile = join(state, "old-profile")
  const taskDatabase = join(state, "tasks.sqlite")
  const receiptPath = join(state, "receipt.json")
  cleanups.push(() => {
    try {
      git(root, ["worktree", "remove", candidate])
    } catch {
      // A failing assertion still cleans only this test fixture.
    }
    rmSync(root, { recursive: true, force: true })
    rmSync(state, { recursive: true, force: true })
  })

  writeFileSync(join(root, "tracked.txt"), "authored build fixture\n")
  writeFixtureProject(root)
  const artifact = commitFixture(root)
  git(root, ["worktree", "add", "--detach", candidate, artifact])
  writeFileSync(taskDatabase, "")
  new Database(taskDatabase).close()
  mkdirSync(oldProfile)
  writeFileSync(join(oldProfile, "build.txt"), "old profile\n")

  const command = "bun run build:fixture"
  const procedure = retainedProcedurePlan(command)
  if (procedure.status !== "supported") throw new Error(procedure.reason)
  expect(procedure.plan).toMatchObject({ kind: "bun-quality", projectScripts: ["build:fixture"] })
  const unownedScript = retainedProcedurePlan("bun run not-declared")
  if (unownedScript.status !== "supported") throw new Error(unownedScript.reason)
  const rejectedOperation = crypto.randomUUID()
  expect(() =>
    createRetainedCheckContext({
      rootDirectory: state,
      operationID: rejectedOperation,
      generation: 1,
      phase: "task",
      checkID: "missing-project-script",
      originalWorkspace: root,
      candidateWorkspace: candidate,
      taskDatabase,
      projectDirectory: root,
      candidateArtifact: artifact,
      priorResourcePaths: [oldProfile],
      procedurePlan: unownedScript.plan,
    }),
  ).toThrow("Candidate package.json does not declare project procedure script not-declared")
  expect(existsSync(join(state, `retained-${rejectedOperation}-1`))).toBe(false)
  const context = createRetainedCheckContext({
    rootDirectory: state,
    operationID: crypto.randomUUID(),
    generation: 1,
    phase: "task",
    checkID: "authored-build",
    originalWorkspace: root,
    candidateWorkspace: candidate,
    taskDatabase,
    projectDirectory: root,
    candidateArtifact: artifact,
    priorResourcePaths: [oldProfile],
    procedurePlan: procedure.plan,
  })
  const witness = retainedCheckIsolationWitness(context)
  const receipt = await runCheck(
    candidate,
    artifact,
    { id: "authored-build", command, timeoutMs: 10_000 },
    receiptPath,
    {
      environment: context.environment,
      environmentIdentity: context.environmentIdentity,
      ownedUntrackedPaths: ["node_modules"],
      isolation: witness,
    },
  )
  expect(receipt.exitCode, receipt.stderr).toBe(0)
  expect(receipt.unchanged).toBe(true)
  expect(observeRetainedCheckContext(context)).toBe(true)
  expect(readFileSync(join(oldProfile, "build.txt"), "utf8")).toBe("old profile\n")
  expect(readFileSync(join(candidate, "dist", "fixture-build.txt"), "utf8")).toBe(
    "built candidate\n",
  )
  expect(readFileSync(join(candidate, ".cache", "fixture-cache.txt"), "utf8")).toBe(
    "private cache\n",
  )
  expect(
    readFileSync(join(context.environment.HOME!, "fixture-profile", "build.txt"), "utf8"),
  ).toBe("private profile\n")
  const privateDB = new Database(context.environment.LAZERS_VERIFICATION_SQLITE!)
  try {
    expect(
      privateDB.query<{ value: string }, []>("SELECT value FROM build_writes").get()?.value,
    ).toBe("private build")
  } finally {
    privateDB.close()
  }
  expect(
    observeRetainedCheckIsolationWitness(context.directory, receipt.isolation, {
      operationID: context.operationID,
      generation: context.generation,
      phase: context.phase,
      checkID: context.checkID,
      originalWorkspace: root,
      candidateWorkspace: candidate,
      taskDatabase,
      projectDirectory: root,
      candidateArtifact: artifact,
      projectIdentity: context.projectIdentity,
      procedurePlan: procedure.plan,
    }),
  ).toBe(true)
  removeRetainedCheckContextFromWitness(context.directory, receipt.isolation, {
    operationID: context.operationID,
    generation: context.generation,
    phase: context.phase,
    checkID: context.checkID,
    originalWorkspace: root,
    candidateWorkspace: candidate,
    taskDatabase,
    projectDirectory: root,
    candidateArtifact: artifact,
    projectIdentity: context.projectIdentity,
    procedurePlan: procedure.plan,
  })
  expect(existsSync(join(candidate, "node_modules"))).toBe(false)
})

test("a verification resource aliasing a retained workspace is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "lazers-retained-isolation-alias-"))
  const repo = join(root, "repo")
  const candidate = join(root, "candidate")
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(repo)
  writeFileSync(join(repo, "tracked.txt"), "candidate\n")
  writeFixtureProject(repo)
  const artifact = commitFixture(repo)
  git(repo, ["worktree", "add", "--detach", candidate, artifact])
  const taskDatabase = join(root, "tasks.sqlite")
  writeFileSync(taskDatabase, "")
  const db = new Database(taskDatabase)
  db.close()
  const procedure = retainedProcedurePlan(
    "bun fmt --check && bun lint && bun check && git diff --check",
  )
  if (procedure.status !== "supported") throw new Error(procedure.reason)
  expect(() =>
    createRetainedCheckContext({
      rootDirectory: candidate,
      operationID: crypto.randomUUID(),
      generation: 1,
      phase: "task",
      checkID: "alias-check",
      originalWorkspace: repo,
      candidateWorkspace: candidate,
      taskDatabase,
      projectDirectory: repo,
      candidateArtifact: artifact,
      priorResourcePaths: [],
      procedurePlan: procedure.plan,
    }),
  ).toThrow("Verification resource home aliases a retained or shared resource")
  expect(git(repo, ["rev-parse", "HEAD"])).toBe(artifact)
})

test("project procedure bindings cover authored and newly scoped Bun targets", () => {
  const supportedCommands = [
    "bun test src/models",
    "bun test src/runner",
    "bun test src/runner src/verification/resources src/verification/probe test/retained-verification",
    "bun test src/observability test/observability src/progress",
    "bun fmt --check && bun lint && bun check && git diff --check",
    "bun fmt --check && bun lint && bun check && git diff --check && bun run build:gui",
    "bun run build:widget",
    "bun run check:project && bun run build:widget",
  ]
  for (const command of supportedCommands)
    expect(retainedProcedurePlan(command)).toMatchObject({
      status: "supported",
      plan: {
        kind: command.startsWith("bun test") ? "bun-test" : "bun-quality",
        commandFingerprint: expect.any(String),
        projectScripts: command.includes("bun run") ? expect.any(Array) : [],
        resources: expect.arrayContaining(["dependencies", "bun-cache", "home", "tmp"]),
      },
    })
  expect(retainedProcedurePlan("bun ./scripts/check-profile.ts")).toMatchObject({
    status: "unsupported",
    reason: expect.stringContaining("no project-authored procedure/resource binding"),
  })
  expect(retainedProcedurePlan("bun test ../../shared-tests")).toMatchObject({
    status: "unsupported",
    reason: expect.stringContaining("safe project-relative procedure contract"),
  })
  expect(retainedProcedurePlan("bun test packages/new-feature/test")).toMatchObject({
    status: "supported",
    plan: { kind: "bun-test", targets: ["packages/new-feature/test"] },
  })
  expect(retainedProcedurePlan("bun test apps/other-project/specs")).toMatchObject({
    status: "supported",
    plan: { kind: "bun-test", targets: ["apps/other-project/specs"] },
  })
  expect(retainedProcedurePlan("bun test src/runner && bun lint")).toMatchObject({
    status: "unsupported",
    reason: expect.stringContaining("safe project-relative procedure contract"),
  })
  expect(retainedProcedurePlan("bun run build:fixture && echo unbound")).toMatchObject({
    status: "unsupported",
    reason: expect.stringContaining("no project-authored procedure/resource binding"),
  })
})
