import { expect, test } from "bun:test"
import {
  capturedConfigurationChanged,
  effectiveJscpdConfig,
  unsupportedJscpdConfigKeys,
} from "./configuration.ts"
import type { JscpdConfig } from "./contract.ts"

test("effective config copies supported settings and applies fixed CLI ignores", () => {
  const config: JscpdConfig = {
    mode: "weak",
    formats: ["typescript"],
    formatsExts: { typescript: ["ts", "tsx"] },
    formatsNames: { typescript: ["custom-source"] },
    ignore: ["generated/**"],
    ignorePattern: ["secret"],
    crossFormats: [["javascript", "typescript"]],
    maxLines: 200,
    maxSize: "2mb",
    maxGapLines: 5,
    similarity: 0.9,
    noGitignore: true,
    skipLocal: true,
    skipIsolated: [["src/isolated.ts"]],
    pattern: "src/**/*.ts",
  }
  const normalized = effectiveJscpdConfig(config)

  expect(normalized).toMatchObject({
    mode: "weak",
    formats: ["typescript"],
    formatsExts: { typescript: ["ts", "tsx"] },
    formatsNames: { typescript: ["custom-source"] },
    ignore: ["**/node_modules/**", "**/.git/**"],
    codeIgnorePatterns: ["secret"],
    crossFormats: [["javascript", "typescript"]],
    maxLines: 200,
    maxSize: "2mb",
    maxGapLines: 5,
    similarity: 0.9,
    noGitignore: true,
    skipLocal: true,
    skipIsolated: [["src/isolated.ts"]],
    pattern: "src/**/*.ts",
  })
  expect(normalized.formats).not.toBe(config.formats)
  expect(normalized.skipIsolated?.[0]).not.toBe(config.skipIsolated?.[0])
  expect(config.ignore).toEqual(["generated/**"])
})

test("configuration identity ignores overridden globs but tracks effective settings and ignore files", () => {
  const base = {
    config: { ignore: ["generated/**"] },
    ignoreFiles: [{ path: ".gitignore", contents: "generated/\n" }],
    ignoreFilesComplete: true,
  }
  const sameEffectiveConfig = {
    config: { ignore: ["vendor/**"] },
    ignoreFiles: [{ path: ".gitignore", contents: "generated/\n" }],
    ignoreFilesComplete: true,
  }
  expect(capturedConfigurationChanged(base, sameEffectiveConfig)).toBe(false)
  expect(
    capturedConfigurationChanged(base, {
      ...sameEffectiveConfig,
      config: { ...sameEffectiveConfig.config, ignoreCase: true },
    }),
  ).toBe(true)
  expect(
    capturedConfigurationChanged(base, {
      ...sameEffectiveConfig,
      ignoreFiles: [{ path: ".gitignore", contents: "vendor/\n" }],
    }),
  ).toBe(true)
})

test("unknown config keys are exposed only by safe name", () => {
  expect(
    unsupportedJscpdConfigKeys({
      ...({ baseline: "source-bearing-value", "sensitive/value": true } as unknown as JscpdConfig),
    }),
  ).toEqual(["baseline", "unknown"])
})
