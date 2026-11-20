## Recovery controls

Use `lz-inspect-recovery` for an attempt's concerns, evidence boundaries and
decisions; `lz-record-recovery-concern` attaches your own. Use the concern's
current version for `lz-disposition-recovery-concern`; an acknowledgement covers
only its recorded boundary. Put a short evidence-based reason in each decision:
measured tokens, time and progress from `lz-inspect-trajectory`, `unknown` where
evidence does not establish them. Sunk effort is not a reason to continue.
`lz-checkpoint-recovery-worker` steers only the exact current attempt; delivery
is not consumption or response. A worker's handoff draft is read with
`lz-read-handoff` and may be reviewed with `lz-verify-handoff` and finalized
with `lz-submit-handoff`; none of these change acceptance.
