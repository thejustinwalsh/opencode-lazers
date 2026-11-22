import { existsSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { skipString } from "./check-unbounded-reads.ts"

/**
 * Source check for design/data-streams.md's anti-goal: no second read path beside streams for
 * data a panel shows. GUI code (every module the GUI entry `src/gui.tsx` imports, transitively)
 * reads show-data through the `lazers.streams` contract (`createStream`, `readWindow`); the only
 * other plugin RPC methods it may call are the writes, commands and small settings or status
 * reads in `ALLOWED`, each with its reason. A new RPC call in GUI code fails `bun run verify`;
 * an allowlisted method that no GUI code calls any more fails too, so the list only shrinks.
 *
 * A call is found from `.rpc(Contract)`: either the method is chained on it
 * (`client.rpc(Models).priceSources(...)`), or the handle is bound to a name
 * (`const models = client.rpc(Models)` / `const rpc = () => client.rpc(Retention)`) and every
 * `name.method(` / `name().method(` in the file is a call. A handle used any other way is
 * reported as unresolved, so it cannot hide a read.
 */

/** The streams contract is the read path itself. */
const STREAMS_CONTRACT = "Streams"

/** `Contract.method` → why GUI code may call it outside the streams. */
export const ALLOWED: Record<string, string> = {
  "Budget.read":
    "budget widget status: today's spend and ceiling of one project, a few counter rows",
  "LocalInference.settings": "local-inference settings toggles: one small settings record",
  "LocalInference.configure": "write: local-inference settings",
  "LocalInference.ask": "command: one inference request, answered by its result",
  "LocalInference.decide": "command: one inference request, answered by its result",
  "LocalInference.systemOne": "command: one inference request, answered by its result",
  "LocalInference.speak": "command: one speech request, answered by its result",
  "LocalInference.transcribe": "command: one transcription request, answered by its result",
  "RendererInference.contract": "renderer inference transport: the result contract revision",
  "RendererInference.attach": "renderer inference transport: this renderer takes jobs",
  "RendererInference.detach": "renderer inference transport: this renderer stops taking jobs",
  "RendererInference.demand": "renderer inference transport: which models jobs need",
  "RendererInference.poll": "renderer inference transport: the next queued job for this renderer",
  "RendererInference.delta": "renderer inference transport: a streamed piece of a job's result",
  "RendererInference.complete": "renderer inference transport: a job's result",
  "NativeInteraction.attach": "verification adapter transport: bind this Desktop window",
  "NativeInteraction.detach": "verification adapter transport: unbind it",
  "NativeInteraction.poll": "verification adapter transport: the next queued interaction",
  "NativeInteraction.complete": "verification adapter transport: an interaction's result",
  "NativeInteraction.audioObserve": "verification adapter transport: report observed audio",
  "Models.configure": "write: a model route mapping",
  "Models.refreshSources":
    "command: refresh due price sources; answers their status rows (one per source)",
  "Models.priceSources": "price-source order and access stamp: one settings record",
  "PlanningRpc.resolve": "write: answer a planning form",
  "Projects.saveProfile": "write: prove and activate a project profile",
  "Projects.setCode": "write: a project's code",
  "Projects.setPause": "write: pause or resume dispatch",
  "Projects.setSetting": "write: a project setting",
  "Projects.setupStatus": "setup notice: one project's setup state",
  "Projects.startSetup": "command: start the setup Architect session",
  "Projects.dismissSetup": "write: dismiss the setup notice",
  "Tasks.start": "command: start a queued task",
  "Retention.status": "retention settings: the auto-retire setting and last run summary",
  "Retention.preview": "retention preview: counts per kind for a chosen age, behind its control",
  "Retention.retire": "write: retire one slice of old history",
  "Retention.setAuto": "write: the auto-retire setting",
}

export type Call = { file: string; line: number; contract: string; method: string }
export type Unresolved = { file: string; line: number; contract: string }

/** The text with comments blanked (newlines kept), so commented examples are not calls. */
export function stripComments(text: string): string {
  let out = ""
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c === '"' || c === "'" || c === "`") {
      const end = skipString(text, i)
      out += text.slice(i, end)
      i = end
    } else if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i)
      i = end < 0 ? text.length : end
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2)
      const stop = end < 0 ? text.length : end + 2
      out += text.slice(i, stop).replace(/[^\n]/g, " ")
      i = stop
    } else {
      out += c
      i++
    }
  }
  return out
}

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length

/** Every plugin RPC method the file calls, and every handle it uses in a way not followed. */
export function scanFile(file: string, source: string) {
  const text = stripComments(source)
  const calls: Call[] = []
  const unresolved: Unresolved[] = []
  for (const m of text.matchAll(/\.rpc\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    const contract = m[1]!
    if (contract === STREAMS_CONTRACT) continue
    const at = m.index!
    const after = text.slice(at + m[0].length)
    const chained = /^\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(after)
    if (chained) {
      calls.push({ file, line: lineOf(text, at), contract, method: chained[1]! })
      continue
    }
    const before = text.slice(Math.max(0, at - 200), at)
    const bound = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(\(\s*\)\s*=>\s*)?[\w$.?]*$/.exec(
      before,
    )
    const getter = /\b([A-Za-z_$][\w$]*)\s*\(\s*\)\s*(?::[^{]*)?\{\s*return\s+[\w$.?]*$/.exec(
      before,
    )
    if (!bound && !getter) {
      unresolved.push({ file, line: lineOf(text, at), contract })
      continue
    }
    const name = (bound?.[1] ?? getter![1]!).replace(/\$/g, "\\$")
    // `name.m(`, `name().m(` for a bound handle; `this.name().m(` for a method that returns one.
    const use = new RegExp(
      bound
        ? `(?<![\\w$.])${name}\\s*${bound[2] ? "\\(\\s*\\)" : ""}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`
        : `\\bthis\\.${name}\\(\\s*\\)\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`,
      "g",
    )
    let found = false
    for (const u of text.matchAll(use)) {
      found = true
      calls.push({ file, line: lineOf(text, u.index!), contract, method: u[1]! })
    }
    if (!found) unresolved.push({ file, line: lineOf(text, at), contract })
  }
  return { calls, unresolved }
}

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']+)\1/g

/** Every source module the entry reaches through relative imports. */
export function guiModules(entry: string): string[] {
  const seen = new Set<string>()
  const pending = [entry]
  while (pending.length) {
    const file = pending.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const text = stripComments(readFileSync(file, "utf8"))
    for (const m of text.matchAll(IMPORT)) {
      const target = resolve(dirname(file), m[2]!)
      for (const candidate of [target, `${target}.ts`, `${target}.tsx`])
        if (/\.tsx?$/.test(candidate) && existsSync(candidate)) {
          pending.push(candidate)
          break
        }
    }
  }
  return [...seen].toSorted()
}

export function check(root: string, allowed: Record<string, string> = ALLOWED) {
  const files = guiModules(join(root, "src/gui.tsx"))
  const calls: Call[] = []
  const unresolved: Unresolved[] = []
  for (const path of files) {
    const scanned = scanFile(relative(root, path), readFileSync(path, "utf8"))
    calls.push(...scanned.calls)
    unresolved.push(...scanned.unresolved)
  }
  const used = new Set(calls.map((call) => `${call.contract}.${call.method}`))
  return {
    files: files.length,
    calls,
    disallowed: calls.filter((call) => !(`${call.contract}.${call.method}` in allowed)),
    unresolved,
    stale: Object.keys(allowed).filter((key) => !used.has(key)),
  }
}

if (import.meta.main) {
  const root = fileURLToPath(new URL("..", import.meta.url))
  const result = check(root)
  const problems = [
    ...result.disallowed.map(
      (call) =>
        `${call.file}:${call.line} calls ${call.contract}.${call.method}: read panel data through a stream (createStream/readWindow), or add a write or small status read to ALLOWED in scripts/check-show-reads.ts with its reason`,
    ),
    ...result.unresolved.map(
      (handle) =>
        `${handle.file}:${handle.line} uses an rpc(${handle.contract}) handle the check cannot follow: call the method on it directly or bind it to a const`,
    ),
    ...result.stale.map(
      (key) => `ALLOWED lists ${key} but no GUI code calls it any more: delete the entry`,
    ),
  ]
  for (const problem of problems) console.error(problem)
  if (problems.length) {
    console.error(`\n${problems.length} problem(s).`)
    process.exit(1)
  }
  console.log(
    `show reads: ${result.calls.length} RPC calls in ${result.files} GUI modules, all allowed`,
  )
}
