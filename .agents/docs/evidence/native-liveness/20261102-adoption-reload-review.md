# Adoption correction: module reload review

2026-11-02. Original LZ-63 worker remains active. This reviews its current
uncommitted correction; it is not a final return or native qualification.

`src/runner/artifacts.ts` currently creates `verificationRuntimeGeneration` with
`crypto.randomUUID()` at module scope. `verificationEnvironmentIdentity()` includes
it in an environment digest. Adoption compares that identity before/after checks,
at later phases and before completion. Two loads of identical code can therefore
invalidate legitimate passed checks without a candidate, procedure, configuration
or target change. This preserves the original all-environment hash gate's false
invalidation problem under a different input.

Read-only reproducer: `/private/tmp/lazers-review-adoption-generation.ts` copies
that exact module into two disposable temporary files, rewriting only relative
import bases. Same process, code and environment, no repository edits, check
execution or inference. Result:

```
{"sameDefaultIdentity":false,"sameExplicitGeneration":true}
```

Bun caches query-only URL variants here, so the first attempted query-suffix
reproducer was not two module instances and was discarded. The two actual module
copies demonstrate the issue. Pinned OpenCode local-module replacement/duplicate
instances were already observed in the native continuity work.

Keep this return held until corrected. Do not edit the active worker's files.
Use the existing stable, meaningful check-runtime metadata/declared durable
configuration or target identities; an import instance is not a relevant evidence
generation. Preserve passing test/probe receipts and the explicit candidate and
procedure bindings. Do not add file hashes, a new ambient digest or arbitrary
restart-invalidates-everything policy. Existing normal runCheck receipts already
record Bun revision/platform metadata without an environment digest. Add a real
same-environment/module-reload regression before integration.

## Broader integration validation

Main full suite after Models/H3 integration: 645 passed, 2 failed / 647 tests,
6113 assertions. Both failures were owned-Desktop boundary cases under the
restricted shell: actual process observation and the disposable private-base
fixture. The whole affected file passed with normal host access: 29 tests / 165
assertions, no source change or actual service launch. Main log:
`/private/tmp/lazers-main-postmerge-all.log`; qualified boundary log:
`/private/tmp/lazers-owned-launch-unsandboxed.log`. Do not report the initial
full-suite run itself as green or label these as product failures.
The focused private-base case also fails inside the restricted shell, with
`Owned verification base is outside its stable system-temp location`, and passes
with normal host access. No ownership/path guard was relaxed to make it pass.

Computer Use remained locked after resetting its connection. Independent read-only
macOS console inspection returned onConsole true, screenLocked true. No lock,
security, GPU or service settings were changed. The pending unlock clarification
and native Architect question still require Desktop access.
