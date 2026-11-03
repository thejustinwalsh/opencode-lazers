# Uncertain verification: offline maintenance preflight

`bun src/verification/maintenance/cli.ts prepare --request <file> --inspection <file>`
produces one JSON preflight result on stdout. Both inputs are operator-supplied
JSON; the inspection file is a snapshot, not a live read of LAZERS storage. The
request binds the canonical project and directory, plan owner and version, task
revision and node version, latest attempt identity, uncertain `verify:runner`
effect, artifact, workspace, check and receipt path. The evaluator cross-checks
those fields against the supplied snapshot, including the latest attempt number
and latest matching effect ordinal. It does not open the task database to prove
that the snapshot is current.

The CLI re-reads only local candidate and evidence state. Git establishes the
workspace root, `HEAD`, tracked/untracked working-tree cleanliness, unmerged
index state and the artifact's tree manifest. The runner receipt is read at its
bound path and validated against the existing `CheckReceipt` contract. If an
original child process identity was captured, the preflight uses the existing
owned-process identity comparison against a read-only process observation. A
missing or inaccessible reader, a changed candidate or receipt, any binding
mismatch, and a reused PID with a different start time fail closed with stable
reason codes. There is no age-based snapshot TTL; mismatched source versions or
changed evidence are blockers, while age alone is not proof either way.

The result labels source data: project/plan/task/attempt/effect facts remain
`suppliedSnapshot`; candidate files and receipt are `revalidated`. Claims such
as `ready`, `containmentProven`, or `executionPermitted` in the supplied file are
ignored as untrusted claims; the result says whether such fields were supplied,
not their values. `coordinationRequired` is true and
`executionPermitted` is always false. The preflight does not open SQLite, contact
the network, prompt, execute checks, signal processes, change lifecycle state,
or perform cleanup. It writes no receipt or history and does not acquire a
runtime reservation.

Even a matching clean artifact and a passing receipt cannot establish that an
old uncertain check and its descendants are contained. A matching PID, an
absent PID, elapsed time, an idle worker, or a stopped service is not a
containment proof. Missing original child identity is reported explicitly; it
must not be reconstructed or fabricated. No Desktop launch manifest is
invented for this runner check.

The JSON handoff always identifies the next distinct operations:

1. Obtain a separately authorized, runtime-owned exclusive maintenance window
   that prevents new dispatch and verification for the resource.
2. Establish positive runtime-owned containment of the old check and its
   descendants while that window is held.
3. Re-read the project, owner, plan/task versions, latest attempt, effect,
   artifact, workspace and receipt under that same window; stop if any binding
   changed.
4. Separately authorize a fresh check through the runtime's ordinary
   verification and acceptance gates, retaining its new receipt.

This handoff is not recovery, permission to rerun a check, an override of the
old uncertainty, or a waiver of normal gates. The subsequent operation must be
implemented and authorized by the runtime; until then, preserve history and
the existing workspace.
