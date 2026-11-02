# Local loader isolation and native idle observations

Observed with installed `@opencode/plugin` 2.2.5 and Bun 1.4.4 on 2026-11-02.
The pinned local loader clears the local import graph before loading each
location. Two separate `createPluginSources` instances loading the identical
canonical entry produced different module objects and Maps: the second could not
read the first's marker, while the first retained its original cached module.
The owned temporary loader fixture was removed. No model, app or service launched.

The actual runner reproduced the same fault in
`src/runner/native-registry.test.ts`: loader B could not observe A's current idle
owner/fence, despite identical source paths. It failed before the repair.

The existing idle observations, owners and ordered-event state now use an explicit
process-global registry. Local module reevaluation can share that registry;
process restart still yields unknown observations. Existing ownership, async
fences, stale-event rejection and listener disposal remain in effect. The focused
regression uses the pinned host loader in test code only and checks both sharing
and cross-loader stale-event/disposal behavior. Production uses no private loader
API, additional service or model/provider restriction.

This corrects a source-level assumption; it does not establish real worker
completion. Native Code Mode/progress/liveness observations on the next real task
remain open. Canonical package selection still matters for consistent code and
tool registration, but a common local path is not evidence of common module state.
