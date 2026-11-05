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
should use an instruction-context entry rather than another genuine worker input
while this worker's own lineage repair remains unimplemented. Instruction-context delivery/readback was observed at1793850156829. The
Architect delivered further additive-metadata and alias-handoff/parser corrections
without changing the original worker input. At1793850572 source inspection showed
required review identity validation tolerates extra metadata, the alias parser
includes source/runtimeSentMessage, and admitted alias matching no longer depends
on the current coordinator owner. Meaningful tests and live admission remain
unproven; source correction is not acceptance.
