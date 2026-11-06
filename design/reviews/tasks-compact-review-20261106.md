# Compact Tasks source review

Candidate `ebdf41a044f761b78308f70eefedf24f2f113fc3` reviewed in OpenCode-native worktree `/private/tmp/lz147-compact-review`, combined with canonical crash repair `7f5133b` and current docs through `d6933f4`. The original worker is inactive/succeeded; Models 152/153 and genuine 138 dependency repair remain active.

The correction removes full hold paragraphs from list rows, keeps title-first rows with compact lifecycle/observed-worker/waiting metadata, retains full distinct reasons and latest worker identity in the inspector and accessible descriptions, and preserves grouping 149's separate scope. No overlapping keyed.ts edit.

Checks: 69 tests passed in the initial task suite; the menu module initially could not load its missing generated Radar artifact in the fresh checkout. After successful GUI build, all 6 menu tests passed (29 assertions). Mounted UI regression, keyed-row lifecycle regression, lint and types passed; all 791 files formatted; GUI bundle evaluates. No product fix was needed for the missing generated build prerequisite. Review checkout remains clean.

Source review passes. Native screenshot acceptance remains open; canonical activation is deferred while Models workers run. Keep this review checkout for the next combined integration, then remove it through the native worktree API after landing.
