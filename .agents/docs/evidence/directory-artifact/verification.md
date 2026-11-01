# Directory artifact evidence verification

The artifact gate accepts a workspace-relative file as before, or a directory
when a readable regular file exists within it at any depth. Empty trees,
symlink-only trees, out-of-workspace paths and special-node-only trees do not
establish evidence. Descendant symlinks are skipped rather than followed.
Task references remain unchanged, including trailing slashes; directory checks
establish presence only, not file contents or Git tracking.

Verification on the implementation revision:

- `bun test src/runner/artifacts.test.ts src/runner/artifact-evidence.test.ts src/task.test.ts` — 15 passed.
- `bun test` — 394 passed across 77 files.
- `bun run verify` — formatting, lint and strict typecheck passed.
- `bun run build:gui` — passed. The existing Vite/Rolldown output includes
  `inlineDynamicImports` deprecation and `EMPTY_IMPORT_META` warnings from the
  GUI dependency bundle.

The runtime fixture confirms unchanged LZ37-shaped directory evidence is
accepted only with matching successful check receipts and recorded human
evidence. Missing/empty directory evidence, failed checks and missing human
evidence continue to block acceptance; adding human evidence reuses the original
check receipt without another worker dispatch or changes to the candidate.
