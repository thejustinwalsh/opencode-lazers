# LZ136 draft/native message mismatch

Root inspected the uncommitted draft and read both actual review messages through
the pinned authenticated native SDK. No message bodies were printed.

At1793849927640/643, `client.session.message.get` returned synthetic messages with
fields`id,metadata,time,text,description,type`. Metadata contained only
`lazersReview`, with the recorded taskID, attemptID and requestID. Neither
`metadata.delivery` nor `metadata.resume` existed; neither was a top-level retained
message field. These are synthetic-request/inbox transport properties.

The draft `review-input.ts` function `reviewMetadata` required
`metadata.delivery === "steer"` and `metadata.resume === false`, so it would reject
both genuine133/135 review messages it is supposed to reconcile. Source tests
which invent those retained metadata fields would not prove the real workflow.

Probe:`/private/tmp/lazers-review-message-metadata-probe-20261104.ts`.
Root sent the actual-shape finding through Desktop to Architect, requesting
correction in the same worker, with fixtures grounded in native data. Delivery
used an instruction-context entry rather than another genuine worker input
while this worker's own lineage repair remains unimplemented. Instruction-context delivery/readback was observed at1793850156829. The
Architect delivered further additive-metadata and alias-handoff/parser corrections
without changing the original worker input. At1793850572 source inspection showed
required review identity validation tolerates extra metadata, the alias parser
includes source/runtimeSentMessage, and admitted alias matching no longer depends
on the current coordinator owner. Meaningful tests and live admission remain
unproven; source correction is not acceptance.

At1793850733353, the original worker reported192 passing/3 failing tests across
the runtime/schema run. The positive reconciliation and later-handoff cases had
not acquired the previous fixture runtime’s live lease after reopening. The worker
expired that prior lease in the restart fixtures while retaining acceptance and
identity assertions; the focused three cases then passed61 assertions at 1793850858509. The broader run started1793850945111 and remains active at this
checkpoint. No production lease was edited, candidate activated or task accepted.

Architect launched a separate read-only draft review on OpenAI Luna Max, verified
at1793850832645. It also reused existing LZ99 as the starting point for investigating
quota-failed same-worker continuation, with a second OpenAI Luna Max research
delegate verified1793851018524. The original LZ136 worker remains unchanged.

The broad runtime/schema run completed at1793851022328:195 tests pass,
3401 assertions, zero failures; formatter and typechecker pass. Independent native
Luna review subsequently found an admission race and sequence-validation mismatch.
Architect delivered those findings through instruction context at1793851211935,
without changing the original input. These findings remain unresolved at this
checkpoint; passing tests do not establish final correctness or activation.
