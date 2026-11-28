import type {
  GitleaksChangedFile,
  GitleaksComparisonReader,
  GitleaksLineRange,
  GitleaksSide,
  GitleaksSourceRead,
} from "../../../src/code-review/providers/gitleaks/contract.ts"
import type { GitleaksWasmRequest } from "../../../src/code-review/providers/gitleaks/wasm-contract.ts"

export const FAKE_AWS_KEY = ["AKIA", "QYLPMN5H", "HHFPZAM2"].join("")
export const FAKE_AWS_OTHER = ["AKIA", "KJHGFDSA", "POIUYTR4"].join("")
export const FAKE_PRIVATE_KEY = [
  ["-----BEGIN RSA PRI", "VATE KEY-----"].join(""),
  "MIIEowIBAAKCAQEAxfakefakefakefakefakefakefakefakefakefakefakefakefakefakefake",
  "fakefakefakefakefakefakefakefakefakefakefakefakefakefakefakefakefakefakefakefa",
  "kefakefakefakefakefakefakefakefakefakefakefakefakefakefakefakefakefakefakefake",
  ["-----END RSA PRI", "VATE KEY-----"].join(""),
].join("\n")
export const FAKE_GITHUB_TOKEN = ["ghp", "_", "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5"].join("")
export const FAKE_AWS_SAME_ENDS = ["AKIA", "QYLKJHGF", "DSAPOAM2"].join("")
const COMPARISON_SALT = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

export interface SecretFixture {
  base: Record<string, string>
  head: Record<string, string>
  changedFiles: GitleaksChangedFile[]
  changes: Record<string, GitleaksLineRange[]>
  baseConfig?: string
  headConfig?: string
  baseIgnore?: string
  headIgnore?: string
  baseConfigFiles?: Record<string, string>
  headConfigFiles?: Record<string, string>
  changesStatus?: "complete" | "unavailable"
}

function readAllowlist(
  fixture: SecretFixture,
  side: GitleaksSide,
  path: string,
): GitleaksSourceRead | undefined {
  const configFiles = side === "base" ? fixture.baseConfigFiles : fixture.headConfigFiles
  const extended = configFiles?.[path]
  if (extended !== undefined) return { status: "present", content: extended }
  return readRootAllowlist(fixture, side, path)
}

function readRootAllowlist(
  fixture: SecretFixture,
  side: GitleaksSide,
  path: string,
): GitleaksSourceRead | undefined {
  const rootFiles: Record<string, string | undefined> = {
    ".gitleaks.toml": side === "base" ? fixture.baseConfig : fixture.headConfig,
    ".gitleaksignore": side === "base" ? fixture.baseIgnore : fixture.headIgnore,
  }
  if (!(path in rootFiles)) return undefined
  const content = rootFiles[path]
  return content === undefined ? { status: "absent" } : { status: "present", content }
}

export function readerFor(fixture: SecretFixture): GitleaksComparisonReader {
  const sideFiles = {
    base: fixture.base,
    head: fixture.head,
  } satisfies Record<GitleaksSide, Record<string, string>>
  return {
    comparisonID: "gitleaks-fixture-1",
    baseRevision: "base-commit",
    headRevision: "head-commit",
    changedFiles: fixture.changedFiles,
    changedLines: {
      status: fixture.changesStatus ?? "complete",
      ranges: Object.entries(fixture.changes).map(([path, ranges]) => ({ path, ranges })),
    },
    async read(side, path): Promise<GitleaksSourceRead> {
      const allowlist = readAllowlist(fixture, side, path)
      if (allowlist) return allowlist
      const content = sideFiles[side][path]
      return content === undefined ? { status: "absent" } : { status: "present", content }
    },
  }
}

export function wasmRequest(fixture: SecretFixture): GitleaksWasmRequest {
  const side = (
    files: Record<string, string>,
    config?: string,
    ignore?: string,
    configFiles?: Record<string, string>,
  ) => ({
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
    config: config ?? "",
    configPresent: config !== undefined,
    ignore: ignore ?? "",
    configFiles: configFiles ?? {},
  })
  return {
    comparisonID: "gitleaks-fixture-1",
    baseRevision: "base-commit",
    headRevision: "head-commit",
    salt: COMPARISON_SALT,
    base: side(fixture.base, fixture.baseConfig, fixture.baseIgnore, fixture.baseConfigFiles),
    head: side(fixture.head, fixture.headConfig, fixture.headIgnore, fixture.headConfigFiles),
    changedFiles: fixture.changedFiles.map((file) => ({
      path: file.path,
      previousPath: file.previousPath ?? "",
      status: file.status,
    })),
    headChanges: Object.fromEntries(
      Object.entries(fixture.changes).map(([path, ranges]) => [
        path,
        ranges.map(({ startLine, endLine }) => [startLine, endLine]),
      ]),
    ),
    baseComplete: true,
    headComplete: true,
    changesComplete: true,
  }
}

const code = [
  "export function connect(host: string): string {",
  "  return `https://${host}`;",
  "}",
  "",
].join("\n")

export const GITLEAKS_PARITY_FIXTURES: readonly {
  name: string
  fixture: SecretFixture
}[] = [
  {
    name: "secret-added",
    fixture: {
      base: {
        "src/config.ts": "export const region = 'eu';\n",
        "src/client.ts": code,
      },
      head: {
        "src/config.ts": `export const region = 'eu';\nexport const key = "${FAKE_AWS_KEY}";\n`,
        "src/client.ts": `${code}export const token = "${FAKE_GITHUB_TOKEN}";\n`,
      },
      changedFiles: [
        { path: "src/config.ts", status: "modified" },
        { path: "src/client.ts", status: "modified" },
      ],
      changes: {
        "src/config.ts": [{ startLine: 2, endLine: 2 }],
        "src/client.ts": [{ startLine: 4, endLine: 4 }],
      },
    },
  },
  {
    name: "secret-same-ends",
    fixture: {
      base: { "src/config.ts": "export {};\n" },
      head: {
        "src/config.ts": `export {};\nconst a = "${FAKE_AWS_KEY}";\nconst b = "${FAKE_AWS_SAME_ENDS}";\n`,
      },
      changedFiles: [{ path: "src/config.ts", status: "modified" }],
      changes: { "src/config.ts": [{ startLine: 2, endLine: 3 }] },
    },
  },
  {
    name: "secret-in-new-file",
    fixture: {
      base: { "README.md": "# demo\n" },
      head: { "README.md": "# demo\n", "deploy/key.pem": `${FAKE_PRIVATE_KEY}\n` },
      changedFiles: [{ path: "deploy/key.pem", status: "added" }],
      changes: { "deploy/key.pem": [{ startLine: 1, endLine: 5 }] },
    },
  },
  {
    name: "secret-rotated",
    fixture: {
      base: {
        "src/config.ts": `export const region = 'eu';\nconst key = "${FAKE_AWS_KEY}";\n`,
      },
      head: {
        "src/config.ts": `export const region = 'eu';\nconst key = "${FAKE_AWS_OTHER}";\n`,
      },
      changedFiles: [{ path: "src/config.ts", status: "modified" }],
      changes: { "src/config.ts": [{ startLine: 2, endLine: 2 }] },
    },
  },
  {
    name: "secret-moved-in-file",
    fixture: {
      base: {
        "src/config.ts": `const a = 1;\nconst key = "${FAKE_AWS_KEY}";\n`,
      },
      head: {
        "src/config.ts": `const a = 1;\nconst b = 2;\nconst c = 3;\nfunction f() {\n    const key = "${FAKE_AWS_KEY}";\n}\n`,
      },
      changedFiles: [{ path: "src/config.ts", status: "modified" }],
      changes: { "src/config.ts": [{ startLine: 2, endLine: 6 }] },
    },
  },
  {
    name: "secret-moved-wide-characters",
    fixture: {
      base: {
        "src/config.ts": `// first\nconst ünï = "é"; const key = "${FAKE_AWS_KEY}";\n`,
      },
      head: {
        "src/config.ts": `const key = "${FAKE_AWS_KEY}";\n// first\n`,
      },
      changedFiles: [{ path: "src/config.ts", status: "modified" }],
      changes: { "src/config.ts": [{ startLine: 1, endLine: 2 }] },
    },
  },
  {
    name: "gitleaksignore",
    fixture: {
      base: { "src/config.ts": "export {};\n" },
      head: { "src/config.ts": `const key = "${FAKE_AWS_KEY}";\n` },
      headIgnore: "src/config.ts:aws-access-token:1\n",
      changedFiles: [
        { path: "src/config.ts", status: "modified" },
        { path: ".gitleaksignore", status: "added" },
      ],
      changes: {
        "src/config.ts": [{ startLine: 1, endLine: 1 }],
        ".gitleaksignore": [{ startLine: 1, endLine: 1 }],
      },
    },
  },
  {
    name: "gitleaks-config-allowlist",
    fixture: {
      base: { "src/config.ts": "export {};\n" },
      head: { "src/config.ts": `const key = "${FAKE_AWS_KEY}";\n` },
      headConfig: [
        "[extend]",
        "useDefault = true",
        "",
        "[[allowlists]]",
        "paths = ['''^src/config\\.ts$''']",
        "",
      ].join("\n"),
      changedFiles: [
        { path: "src/config.ts", status: "modified" },
        { path: ".gitleaks.toml", status: "added" },
      ],
      changes: {
        "src/config.ts": [{ startLine: 1, endLine: 1 }],
        ".gitleaks.toml": [{ startLine: 1, endLine: 5 }],
      },
    },
  },
  {
    name: "captured-config-include",
    fixture: {
      base: { "src/config.ts": "export {};\n" },
      head: { "src/config.ts": `const key = "${FAKE_AWS_KEY}";\n` },
      headConfig: "[extend]\npath = '''cfg/base.toml'''\n",
      headConfigFiles: {
        "cfg/base.toml": '[extend]\npath = "cfg/nested.toml"\n',
        "cfg/nested.toml": [
          "[extend]",
          "useDefault = true",
          "",
          "[[allowlists]]",
          "paths = ['''^src/config\\.ts$''']",
          "",
        ].join("\n"),
      },
      changedFiles: [
        { path: "src/config.ts", status: "modified" },
        { path: ".gitleaks.toml", status: "added" },
      ],
      changes: {
        "src/config.ts": [{ startLine: 1, endLine: 1 }],
        ".gitleaks.toml": [{ startLine: 1, endLine: 2 }],
      },
    },
  },
  {
    name: "inline-allow",
    fixture: {
      base: { "src/config.ts": "export {};\n" },
      head: {
        "src/config.ts": `const key = "${FAKE_AWS_KEY}"; // gitleaks:allow\n`,
      },
      changedFiles: [{ path: "src/config.ts", status: "modified" }],
      changes: { "src/config.ts": [{ startLine: 1, endLine: 1 }] },
    },
  },
  {
    name: "clean-negative",
    fixture: {
      base: { "src/id.ts": "export const id = 'a';\n" },
      head: {
        "src/id.ts": [
          "export const id = 'b';",
          "export const sha = '3b5d5c3712955042212316173ccf37be800b8ab0';",
          "export const uuid = '6f1c2d34-8a4b-4c1e-9b7a-0d3f5e6a7b8c';",
          "// the key AKIAEXAMPLE is in the docs of the cloud provider",
          "",
        ].join("\n"),
      },
      changedFiles: [{ path: "src/id.ts", status: "modified" }],
      changes: { "src/id.ts": [{ startLine: 1, endLine: 4 }] },
    },
  },
]

export const GITLEAKS_PARITY_EXPECTATIONS: Record<
  string,
  { introduced: number; inline?: number; allowlistLeftOut?: number }
> = {
  "secret-added": { introduced: 2 },
  "secret-same-ends": { introduced: 2 },
  "secret-in-new-file": { introduced: 1 },
  "secret-rotated": { introduced: 1 },
  "secret-moved-in-file": { introduced: 0 },
  "secret-moved-wide-characters": { introduced: 0 },
  gitleaksignore: { introduced: 0, allowlistLeftOut: 1 },
  "gitleaks-config-allowlist": { introduced: 0, allowlistLeftOut: 1 },
  "captured-config-include": { introduced: 0, allowlistLeftOut: 1 },
  "inline-allow": { introduced: 0, inline: 1 },
  "clean-negative": { introduced: 0, inline: 0 },
}
