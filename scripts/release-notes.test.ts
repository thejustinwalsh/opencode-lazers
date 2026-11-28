import { expect, test } from "bun:test"
import { commitNotes, releaseSection } from "./release-notes.ts"

test("release sections select an exact version and exclude adjacent releases", () => {
  const text =
    "# Changelog\n\n## Unreleased\n\nIn progress.\n\n## [0.2.1] - 2026-11-28\n\n### Fixed\n\n- Idle capacity.\n\n## 0.2.0\n\nPrevious release.\n"
  expect(releaseSection(text, "0.2.1")).toBe("### Fixed\n\n- Idle capacity.")
  expect(releaseSection(text, "0.2.10")).toBeNull()
  expect(releaseSection("## v0.3.0\n\nReview.\n", "0.3.0")).toBe("Review.")
  expect(releaseSection("## 0.2.1\n\n## 0.2.0\n", "0.2.1")).toBeNull()
})

test("automatic notes retain direct commits, integration merges and breaking changes", () => {
  const notes = commitNotes(
    "1234567890abcdef\tfix(runner): release idle capacity\nabcdef1234567890\tfeat(review)!: add pinned review\n9876543210abcdef\tMerge branch 'release'\n",
    "https://github.com/thejustinwalsh/opencode-lazers",
  )
  expect(notes).toContain("### Fixed\n\n- runner: release idle capacity")
  expect(notes).toContain("### Added\n\n- review: add pinned review (breaking change)")
  expect(notes).toContain("### Changed\n\n- Merge branch 'release'")
  expect(notes).toContain(
    "[12345678](https://github.com/thejustinwalsh/opencode-lazers/commit/1234567890abcdef)",
  )
  expect(commitNotes("", "https://github.com/example/repo")).toBe("")
})
