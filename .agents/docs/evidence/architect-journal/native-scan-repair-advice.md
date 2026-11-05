# Original LZ133: live scan cursor repair

The user requires this correction in existing133, preserving its original Luna Max
worker, attempt and tree. Do not replace the task or waive `native-journal:human`.
Root's canonical journal integration is `2b0cd50`; retained worker HEAD is `f5f7af4`.

Native reproduction: owned129 plan `243f8093-7c3c-44e3-bda5-e06870e4f680` returned
100 distinct records at journal revision4362, then rejected its exact continuation
cursor. One restart returned two records at6174, then rejected that continuation
too. Repeated first source/result revisions remained1/1 while scan sweep advanced
2172→2181 and refresh times changed. Details are in
`design/reviews/task133-journal-cursor-observation-20261104.md` on canonical main.

Focused Luna research identifies the likely mechanism in `store.ts`: generic
UPDATE trigger predicates around327–343 invalidate on any changed column, while
normal `recordArchitectSourcePage` calls refresh source scan cursor/sweep/time,
input last-seen/time and result refresh time. Other meaningful native changes were
not excluded by the probe; prove the mechanism with a discriminating regression.

Keep traversal usable during ordinary no-op scanning, while detecting meaningful
source revision/state, input disposition/delivery/type/reference, result
fingerprint/revision/state/summary/reference, insert/delete and renewal mapping
changes. Scan/timestamp fields may be live diagnostics; state their semantics
honestly rather than promising snapshot-pinned scanner metadata. Preserve bounded
reads, permissions/project/cursor fences and read-only delivery/checkpoint/notice
semantics. Do not change `runtime.ts` or expand scope silently.

Exercise real fenced `claim`/`recordArchitectSourcePage` scan APIs between registered
tool pages, not only unrelated progress or direct SQL revision edits. Complete a
retained-volume traversal with distinct IDs and no omissions/duplicates under
no-op scans; meaningful input and result changes must still invalidate. Cover two
connections/reopen and replacement of installed old trigger definitions without
resetting durable revision counters. Keep assertions discriminating. Run the
existing journal/quality checks, commit the scoped correction, and report exact
evidence; Root must repeat actual native paging before acceptance.

Existing LZ99 is genuinely implementing at higher priority2175 and overlaps the
declared `src/runner/tools.ts` scope. Preserve both workers and priorities; runtime
admission owns that wait. No bypass, direct native prompt, replacement attempt,
ownership transfer or unrelated source cleanup is authorized.
