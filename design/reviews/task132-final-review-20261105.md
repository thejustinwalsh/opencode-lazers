# LZ132 delivered artifact review

Reviewed base: `e67fee195776f6da333e44a9068444817b08c117`, original accepted
attempt `547ae78b-1300-47fe-9aa4-d43461a54379`. Independent native Luna Max review:
`ses_e55747e10ffekOYxBCj4IPRu46`. No source activation or file changes by reviewer.

## Required correction

P1: `src/tasks/rpc.ts:48` registers `lz-attach-task-advice` with
`codemode:false`; `src/tasks/rpc.test.ts:291–295` asserts false. Direct fixture
execution of the registered callback does not establish Code Mode discovery or
invocation. Change both to true before native qualification. User identified the
same defect. Isolated LZ137 correction plan
`181baf24-b3dc-49c5-adad-338d0ec9fe34` preserves the original accepted LZ132
records and native gate; the delivered descendant review follows below.

Delta review completed on LZ137 descendant
`7262d827d166808a43b77f8f5e3f34920a6b2e11`: the prior P1 is cleared in source.
Exactly two lines changed in the two authorized files; native registration and
its assertion now use true, with no other source change and a clean tree.
Independent Luna Max follow-up ran `bun test src/tasks/rpc.test.ts
src/tasks/advice.test.ts`:8 tests/99 assertions passed; diff check passed. Runtime
task and combined registration/quality checks also passed; LZ137 planversion9
is accepted. This is reviewed source clearance, not native Code Mode qualification
or permission to activate while other workers remain active.

## Cleared retained findings and other boundaries

- No lifetime20-advice write ceiling remains. The20 limit applies to the history
  projection; regression appends beyond it and preserves original records.
- Tasks without advice render no empty advice section.
- No other source blocker found in transactional expected-revision checks,
  concurrency/reopen, exact request replay/conflict handling, native authority,
  host-derived provenance, immutable task bytes, append-only history, or current
  and replacement worker advice reads.
- Reviewer ran focused tests:19 tests/333 assertions passed; diff check clean.
  Runtime original-artifact checks separately recorded18 tests/239 assertions,
  compatibility91 tests/788 assertions and quality passing. These are different
  check invocations, not native qualification evidence.

## Nonblocking scaling concern

`src/tasks/advice.ts:118–129` counts all lifetime revisions on each advice read.
Response history size is bounded, but this query's work grows with accumulated
history. Do not claim constant-work reads from the response bound, and do not
restore an arbitrary lifetime write ceiling to avoid this concern.

## Native gate remains open

After review of the corrected artifact and Root-coordinated quiet activation,
perform the actual native attachment and fresh structured/readable getter calls
through Code Mode. Procedure:
`.agents/docs/evidence/task132-native-readback-procedure-20261105.md`.
No watched source integration/reload while129 or the listener repair is active;
no fixture results, repo notes or session advice substitute for this gate. Read
availability is not model consumption. Record exact integrated/artifact identity
before supported combined human evidence and final integration/cleanup actions.
