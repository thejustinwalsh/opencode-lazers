import { expect, test } from "bun:test"
import { verifyGitleaksExpectations } from "../../../../scripts/verify-gitleaks-parity.ts"

test("native/WASM parity fixture checks enforce positive and negative classifications", () => {
  const matching = JSON.stringify({
    ok: true,
    result: { introduced: [{}, {}], inline: [], allowlist: null },
  })
  expect(() => verifyGitleaksExpectations("secret-added", matching)).not.toThrow()
  expect(() =>
    verifyGitleaksExpectations(
      "secret-added",
      JSON.stringify({ ok: true, result: { introduced: [] } }),
    ),
  ).toThrow("classification mismatch")
  expect(() => verifyGitleaksExpectations("secret-added", JSON.stringify({ ok: false }))).toThrow(
    "invalid Gitleaks parity output",
  )
})
