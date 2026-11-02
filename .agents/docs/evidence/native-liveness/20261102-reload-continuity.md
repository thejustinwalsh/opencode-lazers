# Same-process observer replacement

Repair `9d294be`, 2026-11-02.

Native observations: LZ-64 returned clean `ee6960f` at Unix ms 1793635894860, followed by its succeeded idle marker at 1793635894880. Runtime instead held it for “Native execution success did not match the current experimental.idle execution.” LZ-56 independently returned `4535c6c` and met the same producer limitation. Their source and completion qualification remain separate.

The native investigator confirmed the source mechanism: OpenCode's busy period continues through local plugin reload without another execution.started, but the replacement progress listener had discarded its local start cursor. The exact failed callback branch in those two historical runs remains unknown; no retained hook receipt reconstructs its background payload.

The repair retains observed, project/session-scoped busy-period identity in the existing process-shared registry. A replacement listener may inherit that start/order only when it receives a fresh idle hook. Disposal still invalidates its old idle observation. Actual event-stream gaps, missing sequences and terminal events clear inherited continuity; a new host process starts without it. Existing current-input, ordered-success, foreground/input, resource and cancellation checks remain.

Two registered-hook regressions cover initial and resumed input identities. Both fail against the previous production files in an isolated source copy and pass after the repair. They replace/dispose the listener between start and fresh idle/success without replaying the start or creating model input. Existing stream-loss/stale-event/observer-fence cases continue passing.

Validation: full runner/progress/recovery suite 217 tests, 2,883 assertions; formatter, lint, typecheck and diff checks pass. Temporary local logs: /private/tmp/lazers-reload-red.log and /private/tmp/lazers-reload-continuity-all.log.

This fixes forward continuity; it does not manufacture already lost idle observations, prove a native post-repair completion, accept an artifact, or complete the broader roadmap. LZ-63's explicit retained-candidate verification work remains the recovery route for stranded reviewed work. LZ-56's source review separately found three blockers (disconnect capacity, short deadlines and event-consumption blocking); it must be corrected before integration. LZ-64's mapping source review and independent 4-test/52-assertion run are clear within its core-only scope.
