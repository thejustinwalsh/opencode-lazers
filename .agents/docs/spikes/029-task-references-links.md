# Spike 029 — durable task references and native links

## Question

Can tasks gain a compact, durable project-local reference and a native Desktop
message link without changing their UUID/proposal identity or crossing project
boundaries during lookup?

## Increment and boundary

Add persisted `LZ-<sequence>` references in a project-scoped SQLite relation;
preserve UUID reads and task bodies; include the actual reference in shared task
reads and a compact submission receipt; copy `[LZ-n](lazers://task/LZ-n?project=<project-id>)`
from the Tasks inspector; and route that in-app link through OpenCode's native
`LinkHandler` to the source session's scoped Tasks tab. No OS protocol is
registered or claimed. Worker execution, GitHub integration, and task/runner
redesign are excluded.

## Native URL and scope decision

The pinned 2.2.5 `LinkHandler` accepts local links, provides `match`, `open`,
and optional `exists`, and says `exists` must not read file contents
(`node_modules/@opencode/plugin/dist/gui/registries.d.ts`, `LinkHandler`). The
native `Ui.Markdown` renders message Markdown and routes local links through
`Links.open` (`node_modules/@opencode/plugin/dist/gui/host-apis.d.ts`,
`Ui.Markdown` and `Links`). The URL carries the project ID and LZ reference,
not a filesystem path or OS protocol claim. Resolution uses only the live
originating session and its current server/location; it checks project ID and
canonical directory before reading the reference. Invalid, missing, foreign,
disconnected, and disposed cases fail closed.

## Evidence

- SQLite v1→v5 migration assigns references without rewriting task bodies;
  reopen and lost-response retry preserve mappings.
- Separate child processes race distinct submissions and receive unique
  references; duplicate idempotent submissions still replay one reference.
- Shared task reads resolve both references and UUIDs, query by reference, and
  keep equal references isolated by canonical project.
- Focused behavior, link-handler, full-suite, and quality commands are recorded
  in the implementation commit.

## Native observation and outcome

Implementation and automated coverage are retained. **Desktop driver
observation is still required:** copy a task link from the Tasks inspector,
paste it into a native session message, click the rendered link, and verify the
correct project Tasks tab and task selection. The test harness here does not
provide a verified Desktop copy/paste/click observation, so this document does
not claim that acceptance evidence.
