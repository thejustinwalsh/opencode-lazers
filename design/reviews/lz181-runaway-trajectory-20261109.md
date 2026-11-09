# LZ-181: failed delivery trajectory and recovery correction

This is a one-time human-requested Architect takeover, not a rule to replace
value implementers after a fixed duration or token count. Preserve the useful
draft and failure history. The goal remains completed engineering work at low
total token, time and market-equivalent cost.

## Observed facts

Original task `75c838e3-d292-46aa-968f-8cc5417a1ee7`, attempt
`4d691f62-10c6-456f-b862-72cf665c4bb6`, ran on OpenAI Luna Max from
**1794174681139**. At the post-cancellation observation **1794197127711**, the DB
records cancellation and 6.24 hours elapsed. Native activity subsequently confirms
the worker is idle; Architect is investigating the retained checkout.

- Attempt accounting: **1,425 tool calls**, no completed artifact. Progress rows
  use different accounting: 547 successful reads, 267 searches, 265 patches,
  219 shell calls and 30 failed patches. These totals must not be conflated.
- Completed shell intervals occupy **43.4 minutes** in union. Most elapsed time
  surrounded commands with repeated model/tool investigation and editing.
- Captured test-output lower bounds include **13 failures of the same failed/READY
  adoption scenario**. Truncated outputs mean this is not a complete failure count.
- Final cumulative usage: **3,286,042 uncached input; 183,622 output; 541,734
  reasoning; 190,730,880 cache-read; zero cache-write tokens**. The aggregate
  194,742,278 is mostly reused cache, not that many newly generated tokens.
  Subscription-reported cost zero is not a market valuation. Use the existing
  ordered price index and per-category/per-call data for economic decisions.
- The retained draft has eight tracked modified files, two new modules and about
  3,510 added/417 removed tracked lines. No reset or discarded checkout occurred.
  Size signals investigation scope; it is not a line-count acceptance rule.
- There is useful work: focused lineage tests passed, missing completed-check
  restart/no-replay coverage was restored and passed, and quality checks passed
  at the final worker draft. These do not establish the complete behavior suite
  or delivered feature. Architect must assess the actual retained changes.

## Contributors, with source support

**Contradictory task authority.** The submitted specification still mandates
baseline comparisons, original environment/configuration matching and
`unchanged=true` binding that later advice explicitly rejects. Advice 2–3 told
the worker to remove machinery built from those requirements. The live instruction
renderer emits original Constraints and Done when first, then labels the current
correction **“Task-attached advice (advisory)”**. See
`src/tasks/instructions.ts:37–73` and task/advice records. This is a product/tasking
defect, not evidence that the worker independently invented every restriction.

**Repeated lifecycle/test adaptation without a delivery checkpoint.** Moving
checks out of the synchronous drain invalidated fixed-tick fixture assumptions.
Several test helpers waited for all activities while trying to observe an
intermediate restart/mutation boundary. Source reconciliation also copied tests
for reviewed main changes before their corresponding guard implementation was
composed. These explain real corrections; they do not justify indefinitely
repeating the same failure episode.

**Coordinator-added expansion.** Seven advice revisions supplied policy repairs,
source reconciliation, fixture diagnosis and a newly discovered retained-input
admission defect. The added defect blocked other features, but putting it into
the already struggling attempt increased its unfinished boundary. Review tasking
and steering as well as worker choices. Do not split every failed assertion into
a new task or equate every source read with scope creep.

**Missing active recovery loop.** The recovery journal exists; active-struggle
evaluation, durable reassessment and public handoff delivery are not yet wired
through the full runtime. Written reassessment conditions did not schedule a
working concern. A busy worker therefore continued without the automatic
follow-through the product requires. LZ-195/196/192 own the connected repair.

**Driver and coordination overhead.** I repeatedly reported liveness and focused
passes while coherent delivery remained absent. An unattributed synthetic also
claimed Root reserved a repair; the worker acknowledged leaving that code alone.
No corresponding repair was underway from this driver. Preserve this provenance
gap rather than crediting it as autonomous recovery. The short progress tool also
required six length-reduction calls before accepting the requested handoff note;
dedicated handoff controls should carry that work.

## Required correction

1. **Give workers one current contract.** Use the existing task revision/correction
   mechanisms to distinguish authoritative changes from optional implementation
   advice. Retain superseded text in history, not as simultaneously binding
   instructions in every current task retrieval. Resolve this specific stale
   task wording; merely appending another override repeats the problem.
2. **Reassess outcomes, not motion.** Use recorded equivalent failures, attempted
   corrections and their actual results to create or update a concern. Treat tool
   transport success separately from failed subprocess checks. Preserve a concrete
   next observation/follow-up through restart; notify Architect when it occurs.
3. **Make the choice economically informed.** At reassessment, supply measured
   usage and market valuation since the previous intervention, failure history,
   demonstrated progress, objective/scope changes, useful retained work and a
   concise remaining-work assessment. Architect compares the next useful worker
   step with takeover's context/review/integration overhead. Spent tokens are a
   warning signal and historical cost, not a reason to continue merely to justify
   them or to replace a healthy cheap worker automatically.
4. **Choose and record an action.** Continue when a concrete approach is working;
   steer for a specific correctable misunderstanding; reconcile/decompose when
   the remaining outcome has changed; take over when repeated unsuccessful
   approaches or a small hard remainder make that the better route. Record why
   and what result will cause reassessment. Do not impose universal time, token,
   call, advice-count or diff-size quotas, nor force a human question for routine
   technical recovery.
5. **Prove the connected behavior.** Exercise an improving worker that continues,
   a persistent failure that reaches an actual Architect disposition, and
   scope/remaining-work changes. Observe the original worker stop safely before
   takeover, preserved edits reused, work finished and integrated, and actual
   intervention/model/check overhead recorded. A delivered message or green
   isolated module test does not prove that loop.

Apply this through the existing recovery tasks and concise current agent/tasking
guidance. The existing [task-decomposition research](llm-work-decomposition-research-20261107.md)
supports adaptive boundaries and accounting for coordination cost; it does not
establish an optimal Luna task size or a universal escalation threshold. No new
model gate, shadow scheduler or blanket frontier takeover policy is proposed.

The explicit takeover and one-time criteria reached native Architect messages
`msg_1be78efe1001NNWn8IEiCeawSp` and `msg_1be79a2ce001GUId503c1oC6Xw`.
Completion and successful subsequent autonomous recovery remain unproven.

## Native follow-through

Without a further driver prompt, Architect recorded advice revision1 on existing
LZ-195 at **1794197695054** in native message
`msg_1be837a15001u9YkOwKWBjFUCd`. The tool receipt confirms measured usage,
failed approaches, demonstrated progress, scope growth, remaining work and
coordination cost are now attached to that recovery task. Architect acknowledges
its own continuation/scope decisions contributed to this incident. It directs
reuse of existing trajectory/pricing and disposition mechanisms, with no new
valuation engine or timer/tool-count takeover rule. This proves tasking changed;
it does not prove the guidance was consumed, implemented or exercised live.

The independent LZ-195 worker has passed quality checks and31 recovery tests at
this observation. Native shortcut worker LZ-197 has also returned a committed
candidate. Neither result establishes integration or the connected recovery
outcome. The additional current-contract contradiction identified in this report
has not yet been relayed through Desktop, which explicitly reports macOS locked.

At **1794197906283**, Architect's next operation was verification of a replacement
task describing completion of the preserved draft, rather than source repair.
That review returned `pending` with `All fibers interrupted without error` and a
retry/record-limitation instruction. No takeover implementation or integration is
proven by this operation. Its review input also includes preservation archive
SHA256 values; these identify backup files, not working-feature verification,
and must not become acceptance evidence. Observe whether the existing bounded
review/recorded-concern continuation actually prevents another review-only loop.
