import { expect, test } from "bun:test"
import { assertNativeConfigAccepted, nativeConfig } from "./jscpd-release-oracle.ts"

test("native config preserves format mappings and retains an explicit size limit", () => {
  const projected = nativeConfig({
    formatsExts: { typescript: ["jscpd-ts"], javascript: ["mjs", "es"] },
    formatsNames: { typescript: ["custom-source"] },
    maxSize: "2kb",
  })

  expect(projected.formatsExts).toEqual({
    typescript: ["jscpd-ts"],
    javascript: ["mjs", "es"],
  })
  expect(projected.formatsNames).toEqual({ typescript: ["custom-source"] })
  expect(projected.maxSize).toBe("2kb")
  expect(nativeConfig({}).maxSize).toBeUndefined()
})

test("oracle config diagnostics fail closed without exposing their text", () => {
  const configPath = "/private/parity/captured-jscpd.json"
  expect(() =>
    assertNativeConfigAccepted(
      {
        code: 0,
        stdout: "jscpd summary: 2 files",
        stderr: `Using config from ${configPath}\nWarning: no files were scanned.\n`,
      },
      configPath,
      "detector mild",
    ),
  ).not.toThrow()

  let message: string | undefined
  try {
    assertNativeConfigAccepted(
      {
        code: 0,
        stdout: "",
        stderr: `Using config from ${configPath}\nInvalid config: source-bearing canary`,
      },
      configPath,
      "detector mild",
    )
  } catch (error) {
    message = (error as Error).message
  }
  expect(message).toBe(
    "Pinned jscpd release oracle did not accept captured config during detector mild.",
  )
  expect(message).not.toContain("source-bearing canary")
  expect(() =>
    assertNativeConfigAccepted(
      {
        code: 0,
        stdout: "invalid config: source-bearing canary",
        stderr: `Using config from ${configPath}\n`,
      },
      configPath,
      "detector mild",
    ),
  ).toThrow("Pinned jscpd release oracle did not accept captured config during detector mild.")
})
