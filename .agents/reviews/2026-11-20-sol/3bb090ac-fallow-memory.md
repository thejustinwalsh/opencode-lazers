# 3bb090ac — fallow-memory

## Findings

### 3bb090ac-1 — blocker / confirmed

- **Where:** `src/audit/fallow-cache.ts:45-49`.
- **What:** Cache copying verifies the destination directory but blindly writes its `.gitignore`, following a child symlink outside the cache. Analysis can overwrite unrelated user data with `*` plus a newline.
- **Failure scenario:** A real `.fallow` directory contains `.gitignore` symlinked to an external configuration file. Another checkout publishes a nonempty cache there (or seeds it when none exists). `writeFile` follows the link and truncates the external file.
- **Evidence:** `lstat(to)` protects only the directory; `writeFile(join(to, ".gitignore"), "*\n")` has no child lstat/no-follow protection. WASI's `confined` checks do not cover this host-side copy path.
- **Executed reproduction:** `bun test ./.agents/reviews/2026-11-20-sol/cache-symlink-reproduction.test.ts`: 1 pass, 0 fail, 3 assertions, 159 ms. This test asserts the defect: publication changed `owner-config.txt` from the sentinel text to `*\n`. Artifacts are retained in `cache-reproduction-kuFNFY/`, entirely under this review directory.
- **Suggested fix / test:** Use symlink-resistant creation/update and preserve existing user-managed files. Test both seed/publish with a symlinked `.gitignore`; the external sentinel must remain unchanged.

## Checked and sound

- Cache-disabled/large-file-count paths still run analysis rather than refusing the project.
- Cache file transfer uses temporary-file rename; only named regular cache files are copied.
- Allocation-failure stderr is distinguished from a generic analyzer panic.
- Worker collection is requested after each completed response.

## Not reviewed

- No large-memory benchmark or WASM execution; only the isolated cache-copy reproduction was executed.
- Vendored compact extraction's semantic equivalence and cross-thread peak memory were not fully re-proven.
