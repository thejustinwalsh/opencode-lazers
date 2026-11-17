# Stable change identity: stop using commit SHAs as identity and proof

## Problem

The runtime uses commit SHAs for three different jobs at once:

- **identity:** whose work this is
- **evidence:** what was verified
- **proof:** whether the work is integrated

A commit SHA hashes the tree, the parents, the author and committer, the
dates, the message and the signature. Every normal operation changes it:
rebasing a worker branch, squash-merging, amending, re-signing, rewriting
identity. Today each such rewrite would require remapping about 1,074 stored
SHA tokens across about 40 columns and 1,494 receipt files, plus recomputing
the fingerprints built over them. Evidence: `.cache/driver` SHA-persistence
audit, 2026-11-17.

## Principle

Commit SHAs become timestamped observations attached to stable identities.
They are never identities and never proof. Old SHAs stay readable as history
and are never re-validated.

| Question             | Stable key                                                                                          | Notes                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Whose work is this   | Task, attempt and plan UUIDs (existing)                                                             | Ownership and history already have stable ids                |
| Which change is this | `change_id` (UUID per attempt artifact) plus `git patch-id --stable`                                | The patch-id survives clean rebases, amends and re-signing   |
| What was verified    | Tree OID of the checked candidate, plus the environment identity                                    | A content snapshot; it changes only when the content changes |
| Is it integrated     | `main` contains the change: a change-id note, else a patch-id since the base, else tree containment | Replaces `merge-base --is-ancestor <sha> main`               |
| Where it started     | Base tree OID, with the base SHA kept as an observation                                             |                                                              |

## Change-id carrier

The carrier is a git note on `refs/notes/lazers`, with
`notes.rewriteRef=refs/notes/lazers` so rebase and amend copy it. The note
body is `change: <uuid>` plus the task and attempt ids. Notes are pushed and
fetched with the branch (`remote.<name>.push/fetch +refs/notes/*`). A commit
trailer is not used, so commit messages stay free of product metadata.

A note can be lost, for example through a squash merge in the GitHub UI or a
rebase run outside the product. In that case, match by the patch-id (or by a
combined patch-id for multi-commit artifacts) over `base..main`, and fall
back to tree containment. Matching is conservative: an ambiguous or missing
match keeps the plan "not integrated" with a visible reason and an Architect
action. It never fails silently.

## Project key

LAZERS keys project data by its own `project` row rather than by OpenCode's
project id:

- `key`: the normalized default remote, for example
  `github.com/thejustinwalsh/opencode-lazers`. Hosts are lowercased, `.git`
  and credentials are stripped, and SSH and HTTPS forms are unified.
- `aliases`: every OpenCode project id seen for this key, including the
  current root commit and the old id `4d81d0b5…`, plus earlier remote names.
- `canonical_paths`: every checkout on this machine.
- Fallback: with no remote, the key is `root:<root-commit>`.

OpenCode's project id is still used at the boundary to match sessions. It is
resolved through `aliases`.

## Code changes (owner: driver, per the critical-repair authorization)

1. **Identity model.** Add a `change_id` to attempt artifacts, and record
   `tree_oid` and `patch_id` alongside every stored artifact and base SHA.
2. **Evidence.** Receipts, retained verification and adoption are keyed and
   compared by the tree OID plus the environment. Combined-artifact checks
   compare the tree and the ordered parent changes, not the commit SHA. This
   matches the signing fix in progress.
3. **Integration proof.** Replace ancestry-of-SHA checks with change
   containment in `prerequisite-proof.ts`, `plan-control.ts`,
   `worktree-cleanup.ts` and the runtime integration paths.
4. **Fingerprints.** Input and authorization fingerprints hash stable ids and
   tree OIDs, not commit SHAs, so a rewrite does not invalidate them.
5. **Notes plumbing.** Write the note when an artifact is created. Configure
   `notes.rewriteRef` and the note refspecs on the workspace, and push notes
   with `main`.
6. **Project key.** Add the `project` table, resolve aliases, and add a
   compatibility read path for existing `project_id` partitions.

## Migration (one-time, offline, idempotent)

For every stored artifact, base or combined SHA that still resolves:

- record its `tree_oid` and `patch_id`;
- assign a `change_id` per attempt artifact;
- write the notes;
- create the `project` row with its aliases.

Leave the SHA columns untouched as history. After this migration, a history
rewrite needs no remap: trees are identical, notes can be carried forward,
and patch-ids are stable.

## Acceptance

- Every existing integrated plan still proves integrated through change
  containment on the current `main`.
- A rebase or re-sign of a worker branch keeps its evidence and its
  integration proof valid in tests.
- A squash merge without notes still matches by patch-id.
- An ambiguous match surfaces as a visible reason with an Architect action.
- The project key is the same across two clones of the same remote and
  across an identity rewrite of history.
- The deferred history rewrite then runs with only the note carry-forward and
  no SHA remap.
- `bun run verify` and the focused runner, tasks, recovery and adoption tests
  pass.

## Sequencing

1. Workspace git identity and signing fix (in progress).
2. This plan.
3. The deferred history rewrite (`.cache/driver/history-rewrite.ts`, tested
   on a mirror).
4. Main-thread blocking work and leader design, which touch the same runtime
   files; coordinate them.
