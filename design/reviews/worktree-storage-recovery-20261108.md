# Durable worktree storage

User direction: keep project worktrees in a dedicated sibling folder. For this
project the folder is `/Users/tjw/Documents/ChatGPT/opencode-lazers.worktrees/`.
Use OpenCode's native worktree API for creation, registration and removal.

## Observed and recovered

The runner's existing worktrees survived restart under
`~/.local/share/opencode/plugins/lazers/runner/worktrees/`. The two Root review
checkouts under `/private/tmp` disappeared; their committed branches survived.
Their uncommitted check logs did not survive and cannot be recovered from Git.

On 2026-11-08, native `worktree.create` recovered both committed compositions:

| Sibling checkout         | Verified HEAD                              |
| ------------------------ | ------------------------------------------ |
| `lz182-review-recovered` | `fed8d3f0149a0acc55af0e234206d835ec4742f7` |
| `lz184-review-recovered` | `24969cee8382e7ec5c0293cacae417cb3e01c3da` |

This restores review source, not lost logs or task acceptance. Old missing temp
registrations remain to reconcile through the native lifecycle.

## Runtime change still required

The current runner still creates worktrees relative to its durable data directory.
Change new attempt, adoption and verification checkout placement consistently to
the canonical project's sibling folder. Keep existing recorded checkout paths
valid across restart, recovery and cleanup; do not move retained work blindly.
Creation and cleanup continue through OpenCode, with recorded actual paths.
Shared serial work remains in its existing workspace.

Verify new native creation and cleanup, existing-path restart recovery, project
isolation and retained verification continuation. This is a workspace lifecycle
change, not a replacement worktree implementation.

## Native Luna research outcome

Native researcher `ses_e4425b123ffez6bdEmFbaBUHDZ` completed read-only research.
It found no open placement lifecycle task; recommend one coherent feature,
preserving the active Tasks/Radar scopes and existing roadmap.

The four fresh path producers are in `src/runner/runtime.ts`: normal attempt
allocation, retained task/combined verification, adoption task/combined checks,
and combined graph verification. Startup recovery replays an already reserved
path rather than allocating a new one. Derive the sibling from the canonical
project root, not a participant checkout or DB directory. Preserve attempt-ID
leaf names used by legacy startup inference.

The pinned native API accepts the parent directory and leaf name. Its core may
suffix a collision and returns the actual path. Continue journaling that actual
path; existing stored verification paths and adoption receipts take precedence.
Keep shared serial execution in its existing workspace. Preserve all old data-dir
paths, reservations and retained rows. Native cleanup uses its recorded strategy
and `force:false`; no custom registry or broad path migration is needed.

Suggested verification covers canonical placement from alternate invocations,
separate projects, returned-path restart recovery, old paths, shared mode and
native cleanup. Research is not implementation or live acceptance. Architect's
interview answer is pending Desktop unlock; Root will select one lifecycle task.
