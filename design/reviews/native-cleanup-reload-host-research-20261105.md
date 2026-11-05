# Native cleanup followed by global reload

Observed: LZ136 completed native non-forced cleanup. Its directory and native
registry entry were absent. A later global location reload failed while reopening
that removed directory. Canonical diagnostics nevertheless returned initialized
module b21f29cb-65cc-47a4-ad1a-69c531038304, same PID95968 and six unchanged inference
flags. No model or verification was active at the later reload boundary.

The pinned2.2.5 host source explains partial success:

- [LocationServiceMap.reload](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/location-service-map.ts)
  collects cached location keys, invalidates them, attempts all replacements with
  settled exits, then returns a failure if any build failed. A failed response does
  not establish that the canonical replacement failed.
- [Worktree.remove](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/worktree.ts)
  calls the registered backend, removes the native registry row and publishes the
  project update. That function has no explicit target-location cache eviction.
- The installed public client location API exposes get/reload only. No supported
  per-location unload was found. This is not a basis for importing private host
  services into the distributable plugin.

Minimal host reproduction: open/use a native managed worktree location, finish its
work, remove it with native force:false, confirm registry/filesystem absence, then
call native global location reload. Observe the removed-directory error alongside
canonical replacement availability. We observed this on the actual completed136
worktree; a fresh disposable reproduction and upstream repair remain unproven.

Keep valid cleanup and verification results. Check canonical service/module and
settings after a reload error before taking another action. Continue using native
worktree APIs. Proposed upstream remedy: reconcile missing cached locations during
native removal/reload; no upstream code change or issue publication was performed.

Pinned source copies are retained under /private/tmp/lazers-opencode-9bbb8ce-*.ts.
The failed web fetch was replaced by authenticated GitHub file reads; no credentials
or source-message bodies were included in the report.
