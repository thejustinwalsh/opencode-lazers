# Managed session overhead

Managed usage reports are read-only views of privacy-safe native session events
captured after a session has an immutable enrollment boundary. The report reads
the existing event facts and uses cached market prices; it does not launch work
or make inference requests.

## Enrollment is unavailable

Enrollment and reassociation currently fail closed after caller authorization.
The pinned OpenCode API exposes sequenced event delivery, but it does not provide
a contract proving that a generation began after an enrollment request. Event
receipt order, timestamps, and session history cannot establish that boundary.
The tool therefore returns unavailable without writing an association. Existing
stored attribution is not rewritten.

The upstream API contract needed to resume enrollment is an atomic durable
generation-start boundary (or equivalent barrier) that distinguishes the
generation already in flight from generations begun after enrollment. Once
that contract is available, enrollment can freeze a task, plan, or unallocated
association without relabeling earlier work.

## Coverage and valuation

Observer coverage is tracked by native directory and workspace ID. A listener
failure in one native location does not imply a gap in another. Listener shutdown
aborts and joins outstanding session reads before the repository is released.
Incomplete capture remains explicit; absent token categories and unavailable
quotes are unknown rather than zero. Reports use cached prices only and never
trigger a price lookup or inference request.
