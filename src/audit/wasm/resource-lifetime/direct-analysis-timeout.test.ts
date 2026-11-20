import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { repoRoot } from "../test-support.ts"

for (const scenario of ["queued", "active"] as const) {
  test(`Bun records an actual ${scenario} analysis timeout without late callback errors`, async () => {
    const temp = mkdtempSync(join(tmpdir(), "fallow-timeout-test-"))
    const entry = join(temp, "direct-analysis-timeout-child.test.ts")
    writeFileSync(
      entry,
      `import ${JSON.stringify(new URL("./direct-analysis-timeout-scenario.ts", import.meta.url).href)}\n`,
    )

    const child = Bun.spawn([process.execPath, "test", entry], {
      cwd: repoRoot,
      env: { ...process.env, DIRECT_ANALYSIS_TIMEOUT_SCENARIO: scenario },
      stdout: "pipe",
      stderr: "pipe",
    })
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      const output = `${stdout}\n${stderr}`
      expect(code, output).not.toBe(0)
      expect(output).toMatch(new RegExp(`${scenario} direct analysis body times out`))
      expect(output).toMatch(/timed out after 300ms/i)
      expect(output).not.toMatch(
        /late assertion after Bun timeout|Unhandled error|unhandled rejection|DirectAnalysisScopeClosedError|DirectAnalysisTestExpiredError/i,
      )
      expect(output).toMatch(/^\s*1 fail\s*$/m)
    } finally {
      if (child.exitCode === null) child.kill()
      rmSync(temp, { recursive: true, force: true })
    }
  })
}
