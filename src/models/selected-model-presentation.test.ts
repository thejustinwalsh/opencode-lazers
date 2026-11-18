import { expect, test } from "bun:test"
import {
  contributorMembership,
  efficiencySummary,
  estimateHistoryScope,
  estimateValues,
  referenceCostSummary,
} from "./selected-model-presentation.ts"

const unknownWords = /unknown|unavailable|not reported|not recorded/i

test("a partial efficiency keeps what is measured and drops what is not", () => {
  const summary = efficiencySummary({
    status: "partial",
    tokensPerAcceptedTask: 88_888,
    currentMarketUSDPerAcceptedTask: null,
  } as never)
  expect(summary).toBe("Partial · 88,888 tokens")
  expect(summary).not.toMatch(unknownWords)
  expect(
    efficiencySummary({
      status: "partial",
      tokensPerAcceptedTask: null,
      currentMarketUSDPerAcceptedTask: null,
    } as never),
  ).toBe("Partial")
  expect(efficiencySummary({ status: "zero-accepted" } as never)).toBe("No accepted tasks")
})

test("estimate values omit the range that does not exist", () => {
  expect(
    estimateValues({
      status: "partial",
      observationCount: 9,
      range: { tokens: { minimum: 9_375, maximum: 18_375 }, currentMarketUSD: null },
      missing: ["current-price"],
    } as never),
  ).toBe("9,375–18,375 tokens · missing current-price")
  expect(estimateValues({ status: "unknown" } as never)).toBeUndefined()
})

test("history scope and membership are absent when the producer did not say", () => {
  expect(estimateHistoryScope({} as never)).toBeUndefined()
  expect(contributorMembership(undefined)).toBeUndefined()
  expect(contributorMembership("both")).toBe("both")
})

test("a reference with no amount has no cost line", () => {
  expect(referenceCostSummary({ status: "unavailable" } as never)).toBeUndefined()
  expect(
    referenceCostSummary({ status: "exact", valueUSDPerAcceptedTask: null } as never),
  ).toBeUndefined()
})
