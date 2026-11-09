# Registered retained-inspection qualification

Observed by Architect at Unix1794235602988 after reviewed LZ-201 candidate
`e2833b0b0e15170f76d42b019d4233bce6279739` landed in main as `5f6b759`.
Quality and 23 focused inspection tests / 214 assertions passed on main.

The actual registered `lz-inspect-plan` full and `retained-verifications` tools
were called on existing LZ-156 plan `eade12ae-74f3-48af-874b-f5950f4a41c3`,
selecting task `efd19c25-909e-4b06-aa4b-b6411785b4f7`. With limit 1, the first
history page returned generation 2 and its next cursor returned generation 1;
traversal finished without restarting or suppressing normal tool telemetry.

Both pages retained latest generation 3, operation
`34d2518c-4a7a-41ad-bb69-59943b6fd87d`, truthfully **cancelled** with passed
quality and models checks (exit 0). Generations 1 and 2 were cancelled and
checkless. No new verification generation or model turn was initiated.
The authored LZ-164 qualification's historical “accepted generation 3” wording
must not be interpreted as permission to relabel this cancelled operation:
passed retained checks and operation cancellation are separate facts.

Before/after full projections matched for plan state/version/artifact, task
states/artifacts, attempts and retained operation/check/resource facts. LZ-156
remained blocked at version 29. This read initiated no cleanup, retry or control
action. Returned pages exposed scoped structured fields rather than private
commands, output, filesystem paths or environment values.

The projection still reports pending workspace cleanup for these cancelled
generations. Their check-process resource counts are settled, but a separate
user-authorized cleanup intervention removed the actual clean merged checkouts;
those native removal observations are recorded in
`worktree-cleanup-intervention-20261109.json`. The remaining durable workspace
metadata reconciliation belongs to LZ-185. No read silently repaired metadata or
claimed the original worker's background activity was idle.
