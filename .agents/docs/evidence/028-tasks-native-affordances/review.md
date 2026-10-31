# Go Tasks affordances — independent driver review

## Native recovery boundary (2026-10-31)

At 1793480068891, public native `session.get` and `session.inbox.list` showed
projection `ses_24973c3a02bf468787ea501e79e71813` and speech
`ses_51ea19be1f964b8baf0c6225fe833c35` busy in their original owned isolated
worktrees, both still `openai/gpt-6-luna#max`. The Go worker
`ses_de0ba270cb044fac97f46f3b275e45df` was idle after completing its prompt,
still `opencode-go/qwen3.8-flash#medium`. All three inboxes were empty.
`permission.list` at 1793480118778 and location-scoped `form.list` at
1793480220839 found no outstanding worker permissions or forms. These are
point-in-time observations, not a guarantee against subsequent requests.

The five existing admitted plans retain priorities **30, 20, 10, 5, 5** and
their existing prerequisites: references/grouping and progress wait for b50;
lifecycle waits for progress. Cross-location context remains admitted at
priority 0 with its task queued. No duplicate Run, schedule change or worker
interruption was issued. Inference diagnostics commit `731bc8a` is preserved;
this driver made no inference implementation/settings changes.

## Returned code review

Task `7548e7f8-d33b-4768-b8a1-9c81222da176` returned
`5a7bb9984bb2a2b50d23b2f39a31b51856055a65`. Runtime began verification and its
focused receipt passed with `unchanged:true` (23 tests / 161 expectations).
This is distinct from the native menu/tab observation required by acceptance.

The diff changes only tab/menu registration in `src/tasks/panel.tsx`, one new
registration/render test and spike 028. The current panel body, Start and
continuation behavior are unchanged. Review against OpenCode 2.2.5 pinned source
confirmed ascending menu sorting and native orders Review 10, Browser 15,
Terminal 20 and Files 30; Tasks order 40 follows them. The icon label follows
the native review tab's JSX pattern and preserves the title and hover-close
contract. No DOM insertion or unsupported host slot is used.

A native review worktree at
`/Users/tjw/.local/share/opencode/worktree/b5da4c/driver-go-ui-review` merges the
returned commit onto `731bc8a`. Frozen dependency installation, focused tests
(23 / 161), formatting/lint/type checks and GUI build all passed there. The
build retained the existing Vite deprecation/ONNX CJS import-meta warnings.
Independent full-suite verification passed **234 tests / 2,326 expectations**
across 49 files. At the review boundary, plan `8d505ab3` was runtime accepted
at version 8 with all attempt and combined focused/full/quality receipts passing
and `unchanged:true`. That runtime result does not supply the missing native
capture/reviewer evidence; at that point main integration remained unrecorded.

## Native acceptance remains open

The worker correctly records post-change Desktop menu/tab captures and Terra
review as outstanding in spike 028. Source tests and an isolated bundle do not
close those conditions. The currently exposed browser tools operate embedded
browser tabs, not the Desktop shell's menu/tab strip. This review does not use
alternate OS/DOM/protocol automation or claim an embedded page is the native
product. Native capture/review is still required to close observed acceptance.

## User-authorized canonical source integration

The user approved normal canonical integration of this small reversible change
before supplying native captures. Merge `ce37756126a08085af34dc0c033e3b16843917f2`
on main includes the original `5a7bb99` artifact without squashing or replacing
later diagnostics work. In the canonical workspace, focused checks passed
**23 tests / 161 expectations** and `bun run build:gui` succeeded, producing
`dist/gui-experimental.cjs` for activation. Existing Vite/ONNX warnings remain.

The build used the live canonical workspace, which also contained Root's
concurrent edits to `src/webgpu/main.ts` and untracked `renderer-debug.ts` and
`renderer-debug.test.ts`. Those files were not edited, staged or committed by
this driver; the built bundle is not asserted to be a clean-commit-only build.
No activation, native capture or Terra pass is inferred from compilation. The
native observation remains explicitly pending for the user to capture.
