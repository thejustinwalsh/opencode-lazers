# Desktop driver correction

Root discovered on 2026-11-04 that its follow-up entry sequence could interrupt
the Architect: type text → **Escape** → Command+Return. Escape was intended to
dismiss autocomplete, but with no popup consuming it the native composer stops
active execution. This is driver interference, not evidence of a plugin or model
failure. The interrupted task-authoring call observed at Unix1793822080445–
1793822099205 is consistent with this control sequence; the exact number of
historical affected calls has not been established. Do not relabel every earlier
timeout, GPU error or interrupted tool as having this cause.

Pinned native source establishes the behavior:

- [editor interaction](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/app/src/composer/editor/interaction.ts),
  lines451–460: working/held plus Escape invokes `onStop`.
- [submission](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/app/src/composer/submit.ts),
  lines260–263: stopping active session invokes its interrupt API.

The corrected driver reads current native state, preserves drafts/questions,
types the note and uses **Command+Return directly** for queued follow-ups.
It no longer inserts Escape. Dismiss a genuinely open native menu through its
exposed Cancel action; do not use a global stop key speculatively. Keep notes
sparse, replace stale queued steering through its actual controls, and verify
queue admission without treating admission as consumption or task success.

The corrected sequence was used to notify Architect through Desktop. Root's
`queueArchitectNote` helper in the CUA session now follows it. Native model prompts
continue through Desktop, never CLI/SDK prompt calls. Preserve failed/interrupted
history, inspect uncertain effects before retrying, and record driver assistance
separately in trajectory/recovery measurements.
