# a963208e — all-projects-reads

## Findings

### a963208e-1 — major / confirmed

- **Where:** `src/projects/needs-you.ts:150-162`.
- **What:** Needs you silently omits native questions from every other project, even when loaded. Local questions are discovered only through open-plan owners, not all Architect sessions.
- **Failure scenario:** A and B are loaded; B's Architect asks the owner a question. Read all Needs you pages through A: B's holds appear, but its question does not.
- **Evidence:** `owners` is `[]` when the directory differs from `ownDirectory` (155-157). Registration supplies only the current location's `sessionOf`. `planOwners` at 104-105 excludes sessions without an open plan. No questions-coverage warning is returned.
- **Suggested fix / test:** Route reads through already-loaded providers without booting locations; discover Architect questions independently of plans. Test B's question queried through A, and a local Architect question without a plan.

## Checked and sound

- All-projects Tasks wraps the inner task cursor instead of discarding it.
- Foreign-checkout observation reads use read-only repositories and release trackers/connections in `finally`.
- Agent task tools reject GUI-only all-projects flags.
- All-projects GUI authorization validates caller session without owner permission prompts.

## Not reviewed

- No multi-location walkthrough or large-database measurement.
- Other-project native observation hosts are explicitly unavailable, not actual cross-location inventories.
