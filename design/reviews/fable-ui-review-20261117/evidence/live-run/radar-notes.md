# Radar source notes

- Flow uses a 120,000 ms window: completed tool calls and model responses must be recent; current tool calls survive the age filter, while in-flight model requests are also age-checked.
- Session calls come from `sessionCallLines`; tool destinations classify in order: asks → You, checks or verifying shells → Checks, git/worktrees → Git, file tools or file-targeted calls → Files, shells → Shell, search tools → Search, otherwise Other tools.
- Model requests become destinations only when their route resolves to a known live route; IDs are `model:<modelID>`, with responses matched by session and message.
- The feed orders live events first, then newer events, and caps the result at 150.
- Flow destinations and session-to-destination edges aggregate that capped feed, so unused destinations are absent.
- Destination order is models, local machine, then tools/services (including You), with count descending and name as tie-breaker.
- Map starts with a synthetic “You · session” root, which is always present.
- The first available current Architect, if present, links under You and becomes the parent for work groups.
- Only available sessions with assignments are considered working; the Architect is excluded, and verifying assignments split into Checks while other assignments form Runtime.
- Runtime and Checks groups exist only when they contain sessions; each session item shows its task reference or role, optional state, and live session link.
- Queue exists when queued, needs-you, or failed counts are positive; its items are only “Needs you” and “Failed,” while queued count appears as the group subtitle.
- Groups link under the Architect when present, otherwise You; each lists at most four items and adds a `+N more` node for overflow.
- Runtime and Checks start active; active descendants promote weak ancestors, and each edge inherits its child node’s final tone.
- Map nodes and labels derive from live sessions or workload, except the explicit You root; absent facts are omitted rather than labeled unknown.
