# LZ127 source landing

Root merged independently reviewed original candidate
`af6dd111b8e33940cf03f51205cdc1bfb59fe533` with ancestry as
`7bcb46b89e593f3ea7759e8b3494b50d6f5a0071`. No implementation worker was active
at the pre-merge native inventory check (`1793867091413`). Architect and its
read-only research delegates remained available.

Postmerge verification: **95 tests, 527 assertions, zero failures** across
`src/progress/native.test.ts`, `src/runner/native.test.ts`,
`src/runner/native-idle.test.ts` and `src/runner/native-registry.test.ts`
(11.89 seconds). Native Bun lint and typecheck passed.

The change wires the existing connected native client's session-log API into
progress observation. A replacement listener can use a complete ordered log at
a genuine new idle hook. Regression coverage includes inbox delivery between
start and idle, positive background work, input/execution races, missing or empty
logs and incomplete replay. It does not synthesize a historical idle report.

**This is a source landing, not real-host recovery qualification.** The actual
2.2.5 host returned only a sync watermark, without replayed events. Pinned-source
research found event payload retention defaults off in the stock service launch
path; this process's construction option was not directly observed. The fallback
cannot restore missing start events from that response. Existing native gates,
uncertain effects and retained resources remain unresolved.

Original task `a683d4bf-ef65-4225-9891-a39237d0ffb6`, plan
`f5deb6cf-1414-4060-a65f-0b29be137450`, attempt
`38e12d10-7fbf-4c3a-a442-cf5aae0121fd` and worker
`ses_42ac41f32a83465c8a71161d511ba045` are preserved. The fresh Architect was
given the landing receipt through Desktop, to coordinate task-only integration
with the existing owner. No ownership transfer or cleanup was performed by Root.

The native Architect also launched two independent read-only delegates:
retained-candidate verification planning (`ses_e553066a5ffehiQLB1sGe8b7RD`) and
visible-roadmap eligibility (`ses_e553008e2ffec4Tc5pMKn8Ur8b`). Both actual routes
were checked: OpenAI `gpt-6-luna`, effort `max`. They are research, not implementation
attempts or evidence that a queued task has started.
