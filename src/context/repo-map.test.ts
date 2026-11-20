import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { git } from "../runner/artifacts.ts"
import { TaskRepository } from "../storage.ts"
import {
  buildRepoMap,
  deriveSourceDefinition,
  mapLine,
  scanExports,
  sourceFiles,
} from "./repo-map.ts"
import { currentRepoMap, setRepoMapSource } from "./repo-map-store.ts"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const clean of cleanup.splice(0)) clean()
})

function tree(files: Record<string, string>, options: { git?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "lazers-repo-map-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  if (options.git !== false) {
    git(root, ["init", "--initial-branch=main"])
    git(root, ["add", "-A"])
  }
  return root
}

const line = (source: string) => mapLine("f.ts", scanExports(source))

test("declarations group by kind, in source order, with overloads and modifiers", () => {
  expect(
    line(`
export function b() {}
export async function a() {}
export function* gen() {}
export function b(x: number): void
export abstract class C {}
export class D {}
export declare const ambient: number
export interface I {}
export type T = 1
export enum E { A }
export const enum CE { A }
export namespace N { export const hidden = 1 }
export const x = 1, y = 2
export let z = 3
`),
  ).toBe("f.ts: fn b a gen; class C D; type I T E CE N; const ambient x y z")
})

test("re-exports, export star, default, and type-only forms", () => {
  expect(
    line(`
export * from "./a"
export * as ns from "./b"
export type * from "./types"
export { r, s as t } from "./m"
export type { U, V as W } from "./m"
export default function main() {}
`),
  ).toBe("f.ts: type U W; re *./a ns *./types r t; default")
})

test("local export lists take the kind of the local declaration", () => {
  expect(
    line(`
import { imported } from "./x"
function fn() {}
class Cls {}
interface Iface {}
const value = 1
const arrow = (a: number) => a
export { fn, Cls, Iface, value, arrow as renamed, imported, type Iface as Alias }
`),
  ).toBe("f.ts: fn fn renamed; class Cls; type Iface Alias; const value; re imported")
})

test("function-valued constants count as functions; destructuring binds every name", () => {
  expect(
    line(`
export const a = async (x) => x
export const b = function () {}
export const c: Fn = (x) => x
export const d = useThing(() => 1)
export const e = x => x
export const { p, q: renamed, r = foo, ...rest } = source
export const [h, i] = pair
export const call = make<A, B>(1), after = 2
`),
  ).toBe("f.ts: fn a b c e; const d p renamed r rest h i call after")
})

test("strings, comments, templates and regular expressions never produce exports", () => {
  expect(
    line(`
// export const comment = 1
/* export const block = 1 */
const s = "export const string = 1"
const t = \`export const \${a} = \${ \`nested {\` }\`
const re = /export const regex = 1/g
class K { export = 1; method() { return { export: 2 } } }
export const real = 1
`),
  ).toBe("f.ts: const real")
})

test("TSX with apostrophes and braces in markup still finds later exports", () => {
  expect(
    line(`
export function Panel() {
  return <div title="it's">don't {"x"} {{ a: 1 }.a}</div>
}
export const Other = () => <b>{"}"}</b>
export type Props = { a: string }
`),
  ).toBe("f.ts: fn Panel Other; type Props")
})

test("a file with no exports is its bare path", () => {
  expect(line("const x = 1\nconsole.log(x)\n")).toBe("f.ts")
})

const fixture = {
  "src/index.ts":
    'export * from "./a"\nexport { b, c as d } from "./b"\nexport default function main() {}\n',
  "src/a.ts":
    "export function run() {}\nexport class Box {}\nexport type Opts = {}\nexport const LIMIT = 1\n",
  "src/b.ts": "export const b = 1\nexport const c = 2\n",
  "src/ui/panel.tsx": "export function Panel() {\n  return <div>it's</div>\n}\n",
  "src/empty.ts": "const x = 1\nconsole.log(x)\n",
  "src/a.test.ts": "export const testOnly = 1\n",
  "src/ui/panel.test.tsx": "export const testOnly = 1\n",
  "src/fixtures/data.ts": "export const fixtureOnly = 1\n",
  "src/seed.fixture.ts": "export const fixtureOnly = 1\n",
  "src/types.d.ts": "export type Declared = 1\n",
  "src/generated/g.ts": "export const generated = 1\n",
  "vendor/lib/x.ts": "export const vendored = 1\n",
  "docs/guide.md": "# Guide\nexport const notCode = 1\n",
  ".fallowrc.json": JSON.stringify({ ignorePatterns: ["src/generated/**"] }),
}

test("the derived default keeps the project's own source, minus tests, fixtures, declarations, vendor and ignored folders", async () => {
  const root = tree(fixture)
  const definition = await deriveSourceDefinition(root)
  expect(definition.include).toEqual(["src/**/*.ts", "src/**/*.tsx"])
  expect(await sourceFiles(root, definition)).toEqual([
    "src/a.ts",
    "src/b.ts",
    "src/empty.ts",
    "src/index.ts",
    "src/ui/panel.tsx",
  ])
})

test("the map lists folders by name and source files with exports; documentation appears only as a folder", async () => {
  const root = tree(fixture)
  const map = await buildRepoMap(root, await deriveSourceDefinition(root))
  expect(map.text)
    .toBe(`Repository map. Source files by path, each with its exported names in source order.
Kinds: fn function, class, type type/interface/enum, const, re re-export (*module is export *), default.

Folders (parentheses: source files directly inside):
./
  docs/
  src/ (4)
    ui/ (1)
  vendor/

Source files:
src/a.ts: fn run; class Box; type Opts; const LIMIT
src/b.ts: const b c
src/empty.ts
src/index.ts: re *./a b d; default
src/ui/panel.tsx: fn Panel
`)
  expect(map.files).toBe(5)
  expect(map.names).toBe(11)
  expect(map.tokens).toBeGreaterThan(50)
  expect(map.text).not.toContain("notCode")
  expect(map.text).not.toContain("vendored")
  expect(map.text).not.toContain("generated")
})

test("the same tree yields identical bytes on every run and in another checkout", async () => {
  const one = tree(fixture)
  const two = tree(fixture)
  const first = await buildRepoMap(one, await deriveSourceDefinition(one))
  const again = await buildRepoMap(one, await deriveSourceDefinition(one))
  const other = await buildRepoMap(two, await deriveSourceDefinition(two))
  expect(again.text).toBe(first.text)
  expect(again.hash).toBe(first.hash)
  expect(other.hash).toBe(first.hash)
  expect(first.hash).toMatch(/^[0-9a-f]{64}$/)
  // Plain path order: no ranking, no usage-based ordering.
  const paths = first.text
    .split("\n")
    .filter((l) => l.startsWith("src/"))
    .map((l) => l.split(":")[0]!)
  expect(paths).toEqual([...paths].sort())
})

test("a large map is delivered whole", async () => {
  const files: Record<string, string> = {}
  for (let n = 0; n < 700; n++)
    files[`src/m${String(n).padStart(3, "0")}.ts`] = `export const v${n} = ${n}\n`
  const root = tree(files)
  const map = await buildRepoMap(root, await deriveSourceDefinition(root))
  expect(map.files).toBe(700)
  expect(map.text).toContain("src/m699.ts: const v699")
})

test("untracked source in the checkout appears; a checkout that is not a git repository still maps", async () => {
  const root = tree(fixture)
  writeFileSync(join(root, "src", "fresh.ts"), "export const fresh = 1\n")
  expect((await buildRepoMap(root, await deriveSourceDefinition(root))).text).toContain(
    "src/fresh.ts: const fresh",
  )
  const plain = tree(
    { "src/a.ts": "export const a = 1\n", "node_modules/x/y.ts": "export const dep = 1\n" },
    { git: false },
  )
  const map = await buildRepoMap(plain, await deriveSourceDefinition(plain))
  expect(map.files).toBe(1)
  expect(map.text).toContain("src/a.ts: const a")
})

test("without a top-level src the nested src folders, else the non-tooling folders, are the source", async () => {
  const monorepo = tree({
    "packages/a/src/x.ts": "export const x = 1\n",
    "packages/b/src/y.ts": "export const y = 1\n",
    "scripts/build.ts": "export const build = 1\n",
  })
  expect((await deriveSourceDefinition(monorepo)).include).toEqual([
    "packages/a/src/**/*.ts",
    "packages/a/src/**/*.tsx",
    "packages/b/src/**/*.ts",
    "packages/b/src/**/*.tsx",
  ])
  const flat = tree({
    "lib/x.ts": "export const x = 1\n",
    "scripts/build.ts": "export const build = 1\n",
  })
  expect((await deriveSourceDefinition(flat)).include).toEqual(["lib/**/*.ts", "lib/**/*.tsx"])
})

test("a stored per-project source definition replaces the derived default", async () => {
  const root = tree(fixture)
  const repository = new TaskRepository(join(root, "tasks.sqlite"), root)
  cleanup.push(() => repository.close())
  const derived = await currentRepoMap(repository, root)
  expect(derived.text).toContain("src/index.ts")
  setRepoMapSource(repository, root, { include: ["src/ui/**/*.tsx"], exclude: ["**/*.test.tsx"] })
  const stored = await currentRepoMap(repository, root)
  expect(stored.files).toBe(1)
  expect(stored.text).toContain("src/ui/panel.tsx: fn Panel")
  expect(stored.text).not.toContain("src/index.ts")
  setRepoMapSource(repository, root, undefined)
  expect((await currentRepoMap(repository, root)).hash).toBe(derived.hash)
})
