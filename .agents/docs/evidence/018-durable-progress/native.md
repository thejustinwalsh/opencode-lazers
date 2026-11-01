# Native progress tool and automatic-fact observation

After repaired progress merge `a6e05e3` / `9d341de`, a single supported native
`location.reload()` activated the server plugin before progress integration.
PID stayed 16786. Normal progress integration reached v16 and dispatched the
already-dependent lifecycle task on reviewed `d9ef198`; no replacement progress
attempt or test-only worker was created.

The user explicitly authorized this existing lifecycle worker for the remaining
native report-tool dogfood. Public native session/context readback and the
read-only durable-log reader established:

- Session `ses_930ecf3fd619489993f8b98167853ac1`, original lifecycle attempt
  `33e6b86d-edda-41dc-9ac4-93d195f537ea`, native Luna Max route.
- Actual tool `lazers_report_progress` completed, call
  `call_L4LiYVEUb5FKKa4ah4GLS1mF`, assistant message
  `msg_195329f12001JvmE11uRqgPPqz`. Its native visible result is
  **“Progress recorded at sequence 18555.”**
- Exactly one matching commentary fact at sequence **18555** is attached to that
  same project/plan/task/attempt/session and call/message identity. Its sources
  coalesce `native-event` and `tool-commentary`, retaining native event IDs
  `evt_19532c522001hxzPuh1fP5lpKj` and `evt_19532c582001GhrW1y2Yk4q3ih`.
- At that readback point, the same attempt also had **84 automatic facts**.
  The live trajectory coverage earlier showed 1 commentary and 71 automatic
  facts; these are observations at different times, not additive totals.

This is an actual native model/tool/event roundtrip, not a simulated host test,
commentary treated as verification, or proof that lifecycle work is accepted.
The initial live paginated trajectory cursor went stale while the worker kept
running; verification used native retained context plus the existing read-only
progress reader for exact stable identities, without SQL writes or model calls.
Full native failure/restart/reminder/input/archive coverage remains outside this
roundtrip. Lifecycle's artifact-bound Root dogfood gate remains required.
