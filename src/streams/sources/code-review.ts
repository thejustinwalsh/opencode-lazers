import { defineSource } from "../source.ts"
import {
  CODE_REVIEW_SOURCES,
  codeReviewFileColumns,
  type CodeReviewFilesFilter,
} from "./code-review-ref.ts"

export const codeReviewFilesSource = defineSource({
  name: CODE_REVIEW_SOURCES.files,
  table: "code_review_files",
  key: ["comparison_id", "side", "path"],
  orders: {
    path: [
      { column: "path", direction: "asc" },
      { column: "comparison_id", direction: "asc" },
      { column: "side", direction: "asc" },
    ],
  },
  async authorize(input: CodeReviewFilesFilter, context) {
    await context.assertRead(input.scope.sessionID)
    const found = context.read?.((db) =>
      db
        .query<{ present: number }, [string, string]>(
          `SELECT 1 AS present FROM code_review_comparisons
           WHERE project_directory=? AND comparison_id=?`,
        )
        .get(context.projectDirectory, input.comparisonID),
    )
    if (!found) throw new Error("Code review comparison is unavailable")
    return {
      comparisonID: input.comparisonID,
      side: input.side,
      scope: input.scope,
      projectDirectory: context.projectDirectory,
      changedOnly: input.changedOnly === true,
    }
  },
  filter(input: CodeReviewFilesFilter) {
    return {
      where: `project_directory=? AND comparison_id=? AND side=?${input.changedOnly ? " AND changed=1" : ""}`,
      params: [input.projectDirectory, input.comparisonID, input.side],
    }
  },
  columns: codeReviewFileColumns,
})
