import type { StructuralDiff, ValidStructuralCompareRequest } from "./contract.ts"
import { StructuralDiffSchema } from "./contract.ts"
import { parseDifftasticJson } from "./difftastic-json.ts"
import { toStructuralDiff } from "./difftastic-result.ts"
import { lineDiff } from "./line-diff.ts"

export function fallbackReason(
  language: string,
): "parse-error" | "byte-limit" | "graph-limit" | "unsupported-language" | undefined {
  if (language === "Text") return "unsupported-language"
  if (!language.startsWith("Text (")) return undefined
  if (language.includes("DFT_BYTE_LIMIT")) return "byte-limit"
  if (language.includes("DFT_GRAPH_LIMIT")) return "graph-limit"
  if (language.includes("DFT_PARSE_ERROR_LIMIT")) return "parse-error"
  return "unsupported-language"
}

export function structuralDiffFromJson(
  json: string,
  request: ValidStructuralCompareRequest,
): StructuralDiff {
  const file = parseDifftasticJson(json)
  const reason = fallbackReason(file.language)
  if (reason) return lineDiff(request, reason)
  return StructuralDiffSchema.parse(toStructuralDiff(file, request))
}
