# Repomix worker observer crash

At 2026-11-05T22:26:27.823Z, OpenCode logged an uncaught
`TypeError: worker.on is not a function` with the registration/incarnation
callback text. Its CLI reported the service unresponsive, sent SIGTERM and
started a replacement service. PID95968 became71027. Root did not initiate a
restart. Two native tool calls were interrupted and the side panels temporarily
disappeared; they returned on reconnection.

The exact callback is in installed `oh-my-openagent`5.1.60:
`/Users/tjw/.cache/opencode/npm/oh-my-openagent@latest/1793817387078/node_modules/oh-my-openagent/dist/index.js`,
lines12635–12662. `installLockWorkerObserver` subscribes to the process `worker`
event, and `attachWorker` unconditionally uses Node EventEmitter `.on`/`.once`.
LAZERS' Repomix indexer used the global Web Worker API. Under the installed Bun,
that process event carries a worker without those methods. This is a plugin
compatibility failure, not proof of an ONNX or GPU failure.

Root reproduced the exact exception in an isolated Bun process. A real
ProjectIndex refresh regression also failed before the fix: an observer calling
the same methods received `thread.on is not a function`. The regression catches
the observer error so a test does not crash the entire test process.

Commit1bd08da switches the indexer to `node:worker_threads.Worker` and its
processor to `parentPort` messaging. Repomix still executes in a separate native
thread. No third-party files, global APIs, model settings or inference switches
were patched. The first candidate changed only the parent and timed out because
the processor still listened through the Web Worker API; both ends now use the
same supported interface.

Verification:17 context/index/tool tests passed with131 assertions in12.95s,
including the process-observer regression and existing indexing, permissions,
cache reuse/publication and worker-packet behavior. Final formatting, lint,
full TypeScript check and diff checks passed. Logs:

- `/private/tmp/lz-worker-observer-regression-before.log`
- `/private/tmp/lz-worker-observer-regression-after.log`
- `/private/tmp/lz-context-native-worker-qualified-tests.log`

Native production refresh after loading the correction remains unproven. Root
queued that actual work-driven reprobe through Desktop to Architect, requesting
successful output and service PID before/after. Do not infer live success from
these tests. Existing workers and their histories remain intact.
