# LZ129 retained review: not source-clear

Read-only independent review of original attempt
`58d8d699-6a12-44c3-a5af-954b2b5564bc`, at retained HEAD
`f06a65ebc0aba37e0c9204a86677973651f8efdd`. Four tracked modified modules and
two untracked modules remained preserved. No implementation or lifecycle changes.

Findings below are source-review blockers for the original worker, not replacement
tasks or native acceptance. Reproduce with focused registered-RPC regression tests.
The existing RPC suite separately passed 6 tests/110 assertions in 3.88 seconds;
that does not cover these findings or clear the candidate for integration.

All source references below are relative to the retained worker tree.

1. **Output length:** `src/observability/live-read.ts:438–439,490–491,810,862`
   passes `safeText` limits of 240/600, but its truncation suffix extends beyond the
   limit required by `contract.ts:475–476`. Add cap−1/cap/cap+1 tool result/error
   strings through both registered RPC outputs.
2. **Unavailable route promoted to exact:** `live-read.ts:216–220,299–322,453–459`
   falls back to observation route when route evidence says identity-unavailable;
   safeRoute ignores identity:null. A newer unavailable start can retain an older
   known route as available. Cover explicit redaction/conflict and known-A →
   unknown-B, including concurrent messages.
3. **Default managed view starvation:** `live-read.ts:537–548,597,623–624` caps
   inventory before assignment discovery/unmanaged filtering. Newer unmanaged
   sessions can crowd all managed sessions out. Cover unmanaged entries preceding
   the active managed worker beyond the cap.
4. **Unmanaged live invalidation:** the new reader does not register selected IDs
   with the tracker as `read.ts:772` does. `changes.ts:150–154` then discards genuinely
   unmanaged model/busy/tool events. Cover a selected unmanaged native event causing
   a registered changed notification.
5. **Metadata accounting:** `live-read.ts:104–117,558,608–609` measures sanitized
   output, excludes directories, and checks only after native metadata is received
   and sanitized. Do not label that bounded native bytes read. Cover oversized raw
   model/agent/directory metadata and state the actual observation boundary.

Additional missing coverage: outstanding calls buried beyond the 257-fact window;
journal hydration beyond sixteen distinct changed rows across sessions; a held
inventory read racing native changes/disconnect/scope/cancellation; history cursor
scope/limit mismatch, updates and full traversal without gaps or duplicates.
Relevant paths: `live-store.ts:418–463,534–646`, `rpc.ts:162–199` and
`rpc.test.ts:484–1171`.

Current coordination priority is Astra's focused remaining-performance proposals.
This completed review is retained for the existing LZ129 flow; it does not request
another broad investigation, immediate activation or interruption of active work.
