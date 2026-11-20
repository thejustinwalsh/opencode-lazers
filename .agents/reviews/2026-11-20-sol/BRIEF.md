# Adversarial review of recent work on `main`

You are reviewing, not building. Change no source file, make no commits, switch no branches, run no formatter or fixer, and do not use any `lz-*` tool (no tasks, plans or delegation). The only files you may write are under `.agents/reviews/2026-11-20-sol/`.

Repository: this checkout (`/Users/tjw/Documents/ChatGPT/opencode-lazers`), branch `main`. Read `AGENTS.md` and `docs/reference/contributor-contracts.md` first; `design/runtime-state-machines.md` and `design/multi-project.md` as needed.

## What to review

There are no pull requests. The units of review are the first-parent commits of `main` listed in `.agents/reviews/2026-11-20-sol/UNITS.txt`, oldest first. Each line gives a commit and the exact diff range for that unit (`git diff <parent>..<commit>`; most are merge commits of a feature branch, so the range is the whole branch). Review every unit. Newest units have had the least scrutiny and no full test run: prioritise from the bottom of the file upward if you run short.

## How to review

Be adversarial. Assume each change is wrong until the code proves otherwise. For each unit read the diff and enough surrounding code to judge it, then look for:

1. Correctness: wrong logic, races, lost updates, re-entrancy, error paths that swallow or mislabel failures, off-by-one in paging and cursors, transactions that can partially apply, retries of non-idempotent work, time and ordering assumptions.
2. Lifecycle rules of this project: workflow states and transitions live only in XState `lifecycleMachines`; no SQL-only transitions; every non-terminal state has an exit; queued work ends integrated, merge-ready or escalated, never silently stuck; no unbounded identical retries.
3. Owner rules: no limit that refuses work or silently drops or truncates data (page or evict instead); no new gates, trust prompts or permission prompts on the owner's own panels; no native binaries; runtime code must not rely on recomputing an identical commit SHA; cost UI rules in `AGENTS.md`.
4. Contracts: RPC and tool input/output schemas versus their callers and tests; anything offered to agent tools that should be GUI-only or the reverse; backward compatibility of stored data and migrations (project codes, references, settings, retention).
5. Data safety: retention and purge deleting something a reader still needs; worktree removal; anything that writes during a read path.
6. Tests: tests that cannot fail, assert the implementation rather than the behaviour, were weakened to pass, or leave the changed behaviour uncovered. Name the missing test precisely.
7. GUI: state lost on remount, listeners not removed, focus and keyboard traps (the trajectory dialog), reduced-motion handling, work done on every scroll or frame (website and demos).
8. Dead code, duplicated logic, and anything a later unit made obsolete.

Verify before you assert. Reproduce in your head with concrete inputs, or with a single focused test file when cheap. This machine also runs a live product: do not run the full test suite or any command expected to exceed two minutes; single test files only (`bun test <file>`). Do not open or write the live database under `~/.local/share/opencode`. Do not start servers.

## Output

Write one file per unit: `.agents/reviews/2026-11-20-sol/<short-sha>-<branch-or-topic>.md`, and keep `.agents/reviews/2026-11-20-sol/INDEX.md` up to date as you go (one row per unit: sha, topic, status `reviewed` or `pending`, counts by severity), so the reader can pick up finished units while you continue.

Each finding:

- **ID** (unit sha + number), **severity** (`blocker` wrong results, data loss or stuck work; `major` real defect with limited reach; `minor`; `nit`), **confidence** (`confirmed` you traced or ran it; `likely`; `suspicion`).
- **Where**: `path:line` on `main` as it is now (say if a later unit already changed or fixed it).
- **What is wrong**, in one or two sentences.
- **Failure scenario**: concrete inputs or sequence, then the wrong outcome.
- **Evidence**: the code path you traced or the command you ran and its output.
- **Suggested fix**, briefly, and the test that would catch it.

Also list, per unit, what you checked and found sound (one line each), and what you could not review and why. No praise, no summaries of what the change does beyond one line. If a unit is clean, say so in one line.

When every unit is done, add a final section to `INDEX.md`: the ten findings you would fix first, in order, and any cross-cutting problem that spans units.
