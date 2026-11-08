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
