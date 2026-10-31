# Incoming Radar review — native project identity

Read-only review of active Radar task `c1cc0d39-42d7-4845-bcce-8d91aee4935b`,
attempt `3ed2dee4-f956-4a4a-90d6-d102707f8464`; no returned artifact is claimed.

The incoming source now includes an SVG statechart with directed event-labelled
edges/recorded distinction and graphical shared-axis interval lanes, rather
than the earlier text-only presentation. Its actual mounted composition still
needs assembly screenshots and Terra review; source presence is not visual
acceptance.

## Confirmed P1 — canonical path passed as native project ID

At review, `panel.tsx`'s location loader returned only
`project: result.project.canonical`. The entry then passed `value.project` as
the project-ID argument to `RadarPanelState.connect`. State synchronization
compares that value with `snapshot.projectID`, which is OpenCode's native ID,
not a directory. Every valid production response was therefore rejected.

Driver reproduced this with actual native `location.get` and registered
`Observability.snapshot` output, feeding the same entry-derived value to the
returned state implementation:

```text
canonical: /Users/tjw/Documents/ChatGPT/opencode-lazers
nativeProjectID: b5da4cadd97e51f2f6c88ff71daa1006f6a5b7df
snapshotProjectID: b5da4cadd97e51f2f6c88ff71daa1006f6a5b7df
error: The observation belongs to another project.
loadedSnapshot: false
```

The active worker received native instruction entry
`lazers-radar-native-project-identity-review` on session
`ses_5537982266ec4507aead0335f17455b8`, without interruption or checkout edits.
The current renderer task should carry native `location.project.id` separately
and pass it to state synchronization, keeping canonical directory identity for
preference keys. Require an entry-to-state regression where path and native ID
are deliberately distinct, while retaining genuine foreign-project rejection.
Do not infer the repair landed from delivery of this instruction.
