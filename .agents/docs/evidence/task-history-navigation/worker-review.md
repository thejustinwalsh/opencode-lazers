# Task history and navigation worker review

The implementation adds independent persisted Tasks scope and state filters,
keeps the legacy history preference and `includeCompleted` query contract, and
filters in both project and session-association queries before counts and keyset
pagination. Execution-state matching treats blocked and cancelled plan states as
effective task states. The selected task's UUID, LZ reference, and project identity
are staged before opening Trajectory; mounted history requests replace older
requests and do not fall back to another task.

## Automated verification

- Focused task/history checks: 72 passed, 0 failed, 531 assertions.
- Full test suite: 382 passed, 0 failed, 3,545 assertions.
- `bun run verify`: formatting, lint, and strict TypeScript passed.
- `bun run build:gui`: passed; Vite emitted existing import-meta/deprecation
  warnings for the pinned GUI bundle.

## Native Desktop observation remains outstanding

No mounted Desktop interaction or screenshot was captured. The browser tool
reported that no Desktop browser is connected to this session. Therefore the
completed/failed/cancelled filter interactions, return-state restoration, direct
historical navigation, and narrow-width overflow/accessibility remain unobserved;
this note is not a substitute for the required native evidence.
