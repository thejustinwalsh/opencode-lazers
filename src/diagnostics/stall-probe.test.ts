import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { activeProfiler } from "./stall-profile.ts"
import { StallProbe, type StallRecord } from "./stall-probe.ts"

const probes: StallProbe[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const probe of probes.splice(0)) probe.stop()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const busy = (ms: number) => {
  const end = performance.now() + ms
  while (performance.now() < end);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "lazers-stall-"))
  dirs.push(dir)
  const probe = new StallProbe()
  probes.push(probe)
  probe.configure({ dataDirectory: dir, cores: () => 2 })
  const file = join(dir, "diagnostics", "stalls.jsonl")
  const read = async () => {
    await probe.flush()
    const text = await readFile(file, "utf8")
    return text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as StallRecord)
  }
  return { dir, file, probe, read }
}

test("a busy section produces a stall record naming it", async () => {
  const { probe, read } = await fixture()
  probe.locations = 3
  probe.section("busy:outer", () => busy(320))
  await sleep(120)
  const [record] = await read()
  expect(record?.event).toBe("lazers.stall")
  expect(record!.lagMs).toBeGreaterThan(200)
  expect(record!.culprits[0]?.name).toBe("busy:outer")
  expect(record!.culprits[0]!.ms).toBeGreaterThanOrEqual(300)
  expect(record!.recent.map((item) => item.name)).toContain("busy:outer")
  expect(record!.locations).toBe(3)
  expect(record!.cores).toBe(2)
})

test("nested sections track the stack and report the innermost span", async () => {
  const { probe, read } = await fixture()
  probe.section("outer", () => {
    expect(probe.stack).toEqual(["outer"])
    probe.section("inner", () => {
      expect(probe.stack).toEqual(["outer", "inner"])
      busy(300)
    })
  })
  expect(probe.stack).toEqual([])
  await sleep(120)
  const [record] = await read()
  const inner = record!.culprits.find((item) => item.name === "inner")!
  const outer = record!.culprits.find((item) => item.name === "outer")!
  expect(inner).toBeDefined()
  expect(outer).toBeDefined()
  expect(inner.start).toBeGreaterThanOrEqual(outer.start)
  expect(inner.at).toBeLessThanOrEqual(outer.at)
})

test("async sections measure the synchronous prefix and total separately", async () => {
  const { probe } = await fixture()
  await probe.sectionAsync("async:work", async () => {
    busy(80)
    await sleep(60)
  })
  const totals = new Map(probe.snapshot().map((entry) => [entry.name, entry]))
  expect(totals.get("async:work")!.maxMs).toBeGreaterThanOrEqual(75)
  expect(totals.get("async:work")!.maxMs).toBeLessThan(130)
  expect(totals.get("async:work:total")!.maxMs).toBeGreaterThanOrEqual(130)
  expect(probe.stack).toEqual([])
})

test("sections rethrow and still unwind", async () => {
  const { probe } = await fixture()
  expect(() =>
    probe.section("boom", () => {
      throw new Error("x")
    }),
  ).toThrow("x")
  expect(probe.stack).toEqual([])
  await expect(
    probe.sectionAsync("boom:async", async () => {
      throw new Error("y")
    }),
  ).rejects.toThrow("y")
  expect(probe.stack).toEqual([])
})

test("logging is batched and asynchronous", async () => {
  const { probe, file } = await fixture()
  for (let i = 0; i < 5; i++) probe.report(300 + i, performance.now() - 1000)
  await expect(readFile(file, "utf8")).rejects.toThrow()
  await probe.flush()
  const lines = (await readFile(file, "utf8")).trim().split("\n")
  expect(lines).toHaveLength(5)
})

test("the log rotates past the size cap", async () => {
  const { probe, file } = await fixture()
  const big = "x".repeat(20 * 1024)
  for (let i = 0; i < 30; i++) {
    probe.record(`${big}${i}`, 0, 100, "sync")
    probe.report(300, 0)
    await probe.flush()
  }
  expect(await Bun.file(`${file}.1`).exists()).toBe(true)
  expect(Bun.file(file).size).toBeLessThan(5 * 1024 * 1024)
})

test("the probe is one singleton across module copies", async () => {
  const load = (name: string) =>
    import(`./stall-probe.ts?copy=${name}`) as Promise<typeof import("./stall-probe.ts")>
  const [a, b] = await Promise.all([load(crypto.randomUUID()), load(crypto.randomUUID())])
  expect(a.StallProbe).not.toBe(b.StallProbe)
  expect(a.stallProbe()).toBe(b.stallProbe())
  a.stallProbe().stop()
})

function spinInProfileTarget(ms: number) {
  const end = performance.now() + ms
  let n = 0
  while (performance.now() < end) n++
  return n
}

async function readRecords(dir: string, probe: StallProbe) {
  await probe.flush()
  return (await readFile(join(dir, "diagnostics", "stalls.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as StallRecord)
}

test("profiling is off by default: no flag file, no profiler, no profile field", async () => {
  const hostKey = Symbol("lazers.test.profiler.off")
  const dir = await mkdtemp(join(tmpdir(), "lazers-stall-"))
  dirs.push(dir)
  const probe = new StallProbe()
  probes.push(probe)
  probe.configure({ dataDirectory: dir, profile: { hostKey, minStallMs: 100 } })
  expect(activeProfiler(hostKey)).toBeUndefined()
  probe.section("busy", () => busy(320))
  await sleep(120)
  const [record] = await readRecords(dir, probe)
  expect(record!.lagMs).toBeGreaterThan(200)
  expect(record!.profile).toBeUndefined()
})

test("with profile.on, a long stall carries a sampled profile naming the busy function", async () => {
  const hostKey = Symbol("lazers.test.profiler.on")
  const dir = await mkdtemp(join(tmpdir(), "lazers-stall-"))
  dirs.push(dir)
  await mkdir(join(dir, "diagnostics"), { recursive: true })
  await writeFile(join(dir, "diagnostics", "profile.on"), "")
  const probe = new StallProbe()
  probes.push(probe)
  probe.configure({ dataDirectory: dir, profile: { hostKey, minStallMs: 300, drainMs: 50 } })
  const profiler = activeProfiler(hostKey)
  expect(profiler).toBeDefined()
  // A second probe reuses the one process profiler.
  const second = new StallProbe()
  probes.push(second)
  second.configure({ dataDirectory: dir, profile: { hostKey } })
  expect(activeProfiler(hostKey)).toBe(profiler!)

  spinInProfileTarget(450)
  await sleep(120)
  const [record] = await readRecords(dir, probe)
  profiler!.stop()
  const profile = record!.profile!
  expect(profile.samples).toBeGreaterThan(50)
  expect(profile.self[0]!.frame).toContain("spinInProfileTarget @")
  expect(profile.self[0]!.frame).toContain("stall-probe.test.ts")
  expect(profile.inclusive.map((entry) => entry.frame).join("\n")).toContain("spinInProfileTarget")
  expect(profile.stacks[0]!.frames[0]).toContain("spinInProfileTarget")
  expect(profile.self.length).toBeLessThanOrEqual(25)
})
