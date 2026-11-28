# Changelog

## 0.2.1 - 2026-11-28

### Fixed

- Release idle worker capacity and reacquire it before the same worker resumes.
- Share delegated-agent capacity across canonical project and worktree identities.
- Revisit blocked plans and accepted work when an earlier Architect notification remains unresolved.
- Avoid write transactions during read-only idle queue checks.
- Release memory retained by completed Fallow WebAssembly analyses.
- Reconnect local inference after idle provider release without replacing an active model owner.
- Read historical task panels after their worker worktrees are removed.
- Clean up settled superseded verification work while preserving dirty and unmerged changes.

Review is in development for 0.3.0 and is not included in this patch.
