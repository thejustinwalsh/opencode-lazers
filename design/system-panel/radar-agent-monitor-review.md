# Radar agent monitor concept

[Version 2](radar-agent-monitor-v2.png) is an illustrative narrow/wide mockup, not
an actual execution screenshot. Generated with the built-in image tool using
the [saved prompt](radar-agent-monitor-v2.prompt.txt).

Tasks owns priorities, dependencies, attention and upcoming work. Radar monitors
sessions, actual model/effort, tools, file targets, durations, health and message
flow. Both retain the native theme/fonts and horizontal lower inspector.

Tera 6.1 High reviewed both versions. Version 2 is coherent for user review:
compact session activity, neutral status, explicit operation phases, permission
wait, file-coverage disclosure and a proposed-edit preview.

Carry these refinements into the next design pass:

- Label narrow activity ages; distinguish recent completed calls from current calls.
- Make selected call/event and parent session hierarchy unambiguous.
- Show connection freshness and history coverage; retain concurrent calls,
  concrete failures and unavailable telemetry as distinct cases.

Tool lifecycle and timing already exist. File attribution needs a safe explicit
projection; a global file-change event alone cannot identify its worker. See the
[Astra review](../reviews/astra-radar-perf-20261104.md) for available data, gaps and
the measured large-response performance problem.
