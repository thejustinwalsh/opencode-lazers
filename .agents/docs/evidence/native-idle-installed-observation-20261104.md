# Installed durable idle observation — 2026-11-04

Read-only follow-through research by `ses_e5854982effeVEntjz0KiHFA1S` after exact
source review of LZ117 `f170a6bfc3fb7d0a7601f0c504eda576d2e75f55`, merged `fcb57cd`.
This is the existing combined `native-durable-revalidation:human` condition, not
a new global gate, implementation task or permission to manufacture evidence.

## Observed blocker

### Later actual126 execution: replacement gap, not stale input

Authenticated public reads1793816483905–1793816484007, PID95968/OpenCode2.2.5,
verified project/attempt/session/workspace ownership.126 remains blockedv9 with
clean candidate`bb26ab267863601338102747f99d3fc94539f29b`; no native verify effects.

- Actual task start1793814613159, event`evt_1a7aecca7001Ucy4Zmd5fhSM51`.
- Assigned/current input`msg_3fd61aaa88244bfbba9bca99daa30ca8`; no other user/synthetic
  input in current public context. Not the continuation-note input bug.
- Old listener`bdb2b3d1…` disposed1793814658788, about45.6s after start. Service log
  `opencode.log:162931` shows117merge, then plugin loading/LAZERS loaded around
  17:50:58Z at162942–162974. **Source merge itself coincided with automatic plugin
  replacement.** No additional explicit Root reload/restart is asserted.
- Genuine idle hook1793816374887, background0, listener
  `51451219-800f-4679-95ab-6dbbbb859180`; hook lineage read6374940 had correct input
  but `idle-lineage-unavailable` and no start/event sequence.
- Success1793816375011, sequence1144, event`evt_1a7c9aee3001bnCbKJ2iTUwggH`; matching
  public successful Idle`msg_1a7c9aee3001bnCbKJ2iTUwggH`. Final assistant stopped and
  Idle followed; success did not precede the hook.
- Durable invalidation6375013 revision1, lastEventSequence1144, with start/report/
  pendingTerminal/terminal null. This is not a zero-background certificate.
- Public experimental session log(follow:false) returned only log.synced; task-start
  durable sequence remains unavailable. Diagnostic start2/success5 belongs to an
  earlier pre-task execution and must not be substituted.

126 foreground inactive,110 foreground active; both had empty inbox/owned permissions/
forms/location shells. These are real observations, not background-certification
authority. Producer`progress/native.ts:453–466` rejects missing observed start;
`native-idle.ts:334–355` rejects success without a matching report. The new durable
path has executed, but complete installed artifact/rollout certification is not proved.

**Guardrail:** defer production-runtime source merges as well as explicit reloads
until a coordinated natural quiet boundary. The previous assumption that source
merge could safely precede explicit activation while126 ran was disproved here.
Keep both original attempts. Feed the gap into existing117 recovery; investigate
a provable compatibility recovery, never reconstruct a certificate from these facts
by direct writes, repeated reconciliation or a new turn solely for convergence.

### Distinct110 defect and retrospective recovery limit

SELECT1793816942212 distinguishes110 from126: resumed start48 at1793815404504,
event`evt_1a7badfd8002OTQDn634cqDcMb`, was persisted by listener51451219 as changed.
The **owning listener2fe57b90 actually received that same live start** as seen at 5404522. Input50 was assigned`msg_6126567d71034ccf9c5f00b93754d8c5`. Genuine0hook
6771599 had start48/event50; lineage rejected6771651, then success1009 at6771706,
event`evt_1a7cfbc7a001ytBWV27dP01Vnd`. Durable rowrev4 retains start48 but no report/
terminal. Authenticated reads1793817014396 show matching final successful Idle,
inactive foreground and empty controls, not a certificate.

`progress/native.ts:620–625` populates local starts only when persistence returns
changed; `native-idle.ts:320–321` returns seen for this exact duplicate. This is a
live-listener deduplication defect, unlike126's genuinely unobserved start. A fix
must accept actually received exact duplicate starts while rejecting inherited
state, stale sequences, assignment/disposal/stream gaps and failed persistence.

Research found **no equal-strength retrospective predicate for either record**.
Pinned Idle hook lacks execution identity; successful Idle lacks a hook/start
reference; actual historical logs currently yield only watermarks. Same-input latest
success can confuse A's zero with B's positive background; timestamps/watermarks do
not recover old identities; diagnostics lack the certificate's CAS binding.
Do not reconstruct either certificate from those records.

Accepted117 cannot resume/retry via current supported guards (`runtime.ts:835–842`);
automatic repair applies to failed verification, not accepted tasks. Adoption also
requires conclusive original idleness, not an escape from that guard.

**LZ127**`a683d4bf-ef65-4225-9891-a39237d0ffb6`, plan
`f5deb6cf-1414-4060-a65f-0b29be137450`, is a distinct prospective correction of117's
existing live-listener boundary, not a replacement execution or retrospective
certificate writer. It must discriminate live duplicate receipt from inherited
start, stale/newer execution ordering and same-input A/IdleA→B/IdleB. Source-only
tests do not satisfy117's actual installed condition. Local authoring inference
was unavailable with no semantic pass; independent review remains required.

110 also has a real source P2 at candidate6a9d45c: after awaiting the run trace,
`decision-runtime.ts` dispatches without rechecking cancellation. Original worker
guidance was durably read back1793817436605 under
`lazers-review110-real-dispatch-cancellation-correction-20261104-v1`; supported
cancellation requestedv16 preserves its candidate/history, for same-worker actual
source repair after safe producer rollout—not a turn solely for convergence.

### Earlier baseline (historical, not current after the126 invalidation)

SELECT-only reads of the installed `tasks.sqlite` at **1793815032874–1793815117597**:

- `runner_native_idle` exists with **zero rows**; no `execution-success-confirmed`
  native-observation phase exists.
- LZ117 planv24 remains blocked on the installed-evidence condition;126 planv4
  original attempt remains running.
- Genuine older owning-location diagnostics show `idle-entered`1793813785819,
  `idle-report`1793813785887, input`msg_2e8517fdb43b4f2582b2eeef4ab1e0c4`, start4830,
  event4832, listener`79ed9d92…`. These **diagnostic-only** observations are not
  durable certificates. Later listener-disposed records do not convert them.

Main source, table existence and Root's earlier activation1793812977491 do not
establish installed117 operation. No inference about the cause of retirements.

## Minimal actual observation sequence

1. Coordinate a natural quiet boundary with owners. Read native active sessions,
   relevant inbox/latest tools, location permissions/forms/shells and existing
   plan/effect state. Empty foreground inventory alone is insufficient. Do not
   interrupt126 or change settings.
2. At a **future authorized** supported server-wide `location.reload`, retain the
   clean configured source revision containing117, actual producer/consumer location
   plugin source/active state, server PID and targeted progress diagnostic generations.
   Public plugin inventory has no code hash; generation alone is not artifact proof.
   Bind effective source through the controlled activation chain and exercised behavior.
3. An ordinary already-authorized execution must supply a genuinely observed start,
   idle hook and confirmed terminal. Retain exact DB/project/attempt/session/workspace,
   assignment/report input, event/start/time/background, terminal event/message/sequence,
   revision and invalidation. **If absent, retain the blocker.** No prompt, new test
   worker, synthetic idle, event replay or artificial resume solely to obtain evidence.
4. At a later coordinated quiet supported retirement/reopen, compare that exact durable
   fact using a separate SELECT-only connection. Establish the **producing listener's**
   retirement, not merely a changed RPC caller generation. No unrelated coverage gate.
5. Observe the installed fresh `RunnerHost.session(id,{messages:true})` consumer through
   ordinary authorized runtime cleanup. It brackets current native identity/controls,
   input, report revision and the latest exact successful Idle marker. Record actual
   native force:false removal/inventory/filesystem evidence **or its concrete blocker**.

Diagnostics expose reconstruction, not fresh background revalidation. Trajectory reads
use another host; plan inspection is persisted state. Neither substitutes for the
installed consumer. Current public path requires no new reader or local-module
activation: ordinary cleanup already calls the decisive adapter.

## Coordination with Models

Keep126 running. At its natural accepted boundary, source review/integration can
precede a coordinated117+126 rollout. Do not release producer122 by finalizing126
combined integration **before** required native-control activation and recording the
real links, if that would dispatch122 against old installed source. Task-only source
landing does not release that prerequisite. Then ordinary122 work can provide new
genuine observations; do not turn117's evidence need into a fresh model workload.
Later retirement/revalidation remains117's existing condition, not a prerequisite
that blocks unrelated Models implementation or a claim that legacy cleanup is solved.

## Source anchors

- `src/progress/native.ts:404–526,549–587`: genuine producer and terminal confirmation.
- `src/runner/native-idle.ts`: persisted exact identity/revision/invalidation.
- `src/index.ts:39–44`: listener/repository lifecycle.
- `src/runner/native.ts:326–525`: decisive fresh native consumer;317–323 force:false.
- `src/runner/runtime.ts:4428–4465,4490–4565`: ordinary cleanup path.
- `src/observability/rpc.ts:111–144`: diagnostic limits.
- `src/trajectory/tools.ts:48–59`, `src/trajectory/native.ts:47–115`: distinct host.
- `.agents/docs/opencode-api.md:150–152`: server-wide reload scope.

Research launched no processes, tests, live native calls, lifecycle actions, model
work or DB writes. Old verification/containment uncertainty remains independent.
