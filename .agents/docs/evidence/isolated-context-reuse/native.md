# Isolated context reuse — native host observation

## Status: native observation completed by Architect

The implementation attempt originally left this observation pending. The driver
subsequently observed the repaired registered tools on the pinned native host,
as recorded below; fixture tests are not the basis for this native closure.

## Driver observation — 2026-10-31

Root independently reviewed artifact `7913a14170e7b2b3318c3b25b2bfc19505a4b38f`
and normally merged it into canonical main as `837af3f`. Driver source review
confirmed parent/project/canonical binding, source-root worker permission checks,
read-only cache selection and optional-context fallback. Canonical focused tests
passed **19 tests / 129 assertions**, and `bun run verify` passed formatting,
lint and strict typechecking. Root separately reports the merged full suite
**270 pass / 0 fail / 2,535 assertions**.

The actual registered `lazers_project_refresh` in Architect session
`ses_e6e0e6239ffdtzIePMeJ1sHA4l` published:

- Source workspace: `/Users/tjw/Documents/ChatGPT/opencode-lazers`.
- Project: `b5da4cadd97e51f2f6c88ff71daa1006f6a5b7df`.
- Snapshot: `b6548d85-666b-4bcf-a1f5-5a328cdfabe1`.
- `refreshedAt`: **1793484230419**, freshness **as-of-refresh**.
- Repomix **1.18.1**, encoding **o200k_base**, 289 files, 37,261 packed tokens.

Native `session.get` confirmed existing worker
`ses_a1ec54d789114148b3c69280cf5f414a` has that Architect as its direct parent,
the same project ID, agent `lazers-implementor`, and unchanged exact
`openai/gpt-6-luna#max` route. Its isolated location was
`/Users/tjw/.local/share/opencode/plugins/lazers/runner/worktrees/c10f8cdc-33e2-4c89-af36-69750437f192`.
The session was idle with no pending inbox input before activation.

At **1793484269314**, supported `debug.location.evict({location:{directory}})`
then `location.get({location:{directory}})` reactivated **only that stopped
context location**. Service PID stayed **16786**; all other loaded locations
remained present. Radar, Trajectory, wake repair and references sessions remained
running. No global reload, service restart or interruption was requested.

The driver then admitted one read-only native observation prompt to the existing
worker (not a retry or new implementation). Native tool-success events at
**1793484318054** and **1793484371876** carry completed registered
`lazers_project_index` and `lazers_project_read` calls, each selecting
`src/index.ts` through Code Mode. Both pairs returned the exact snapshot ID,
refresh time, canonical workspace and `as-of-refresh` above. Both returned
**5,467 bytes** matching the immutable publication byte-for-byte. The actual
worker file was **4,949 bytes** and lacks canonical observability wiring, which
is present in the published bytes. This discriminates cross-location reuse from
an ordinary local read. The full source response correctly keeps `revision:null`;
no live-file freshness or source-commit identity is inferred.

All three cache filenames, sizes and mtimes were identical before and after the
worker observation, including the 3,143,022-byte selected snapshot file. The
trace contains only the registered index/read calls, no refresh, collection or
file edit. Source review establishes their read-only path; fixture checks also
forbid collection/repacking and verify unchanged publication pointers. Native
execution succeeded at **1793484378681**. The worker issued the pair twice;
both observations agree, rather than being represented as a single invocation.

The retained [native trace](native-trace.json) includes session/provenance,
native event IDs, actual tool inputs/results, cache metadata and checked byte
comparisons. This closes the scoped native assertion for exact artifact
`7913a14170e7b2b3318c3b25b2bfc19505a4b38f`, not arbitrary future permissions,
providers or workspace changes. It is driver evidence, not a user approval.

## Original implementation context (retained history)

- Task: `430e08d8-ce98-45db-811f-4362a45174b6`, revision 1.
- Starting revision: `6e0fc1097b7667628949cc55daa75cf9ccf75182`.
- Repaired source/test artifact (final code state): commit
  `92c30d05690b661df16f723e13dc9cad662b53ef`.
- Architect/source project ID from task provenance:
  `b5da4cadd97e51f2f6c88ff71daa1006f6a5b7df`.
- Architect/source project directory and workspace:
  `/Users/tjw/Documents/ChatGPT/opencode-lazers`.
- Architect source session from task provenance:
  `ses_e6e0e6239ffdtzIePMeJ1sHA4l`.
- Isolated implementor session from the native task trajectory:
  `ses_a1ec54d789114148b3c69280cf5f414a`.
- Assigned implementor worktree:
  `/Users/tjw/.local/share/opencode/plugins/lazers/runner/worktrees/c10f8cdc-33e2-4c89-af36-69750437f192`.
- The implementor's direct native parent relationship and the current native
  `ctx.location.project.canonical`/directory values were not independently
  queried in this attempt; the source session above is the task provenance, not
  a substitute for verifying the live parent relation.

## Tool observations

- Before implementing the repair, an actual `lazers_project_index` call in the
  isolated implementor returned:
  `Workspace index is unavailable; Architect must refresh it before it can be read`.
- No refresh output was recorded after the repair. Refresh is Architect-only and
  this implementor did not attempt to bypass that permission.
- No post-repair worker index/read output, matching snapshot ID/time, or native
  source-workspace permission result is available yet.

## Required follow-up

After the repaired artifact is available to the pinned OpenCode 2.2.5 host,
Architect must record the exact code artifact/commit, the live parent and worker
session identities, project IDs, canonical directories, one refresh output, and
the worker's actual index/read outputs here. Confirm the source bytes match the
refresh and that the read did not rebuild or mutate publication/cache state.
Do not restart the service or interrupt the existing worker merely to obtain this
observation.
