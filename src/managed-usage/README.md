# Managed session overhead

Managed usage reports are read-only views of previously stored privacy-safe
native session facts. The report uses cached market prices; it does not launch
work or make inference requests.

## Enrollment is unavailable

Enrollment and reassociation currently fail closed after caller authorization.
The pinned OpenCode API exposes sequenced event delivery, but it does not provide
a contract proving that a generation began after an enrollment request. Event
receipt order, timestamps, and session history cannot establish that boundary.
The tool therefore returns unavailable without writing an association. The
plugin also does not subscribe to live usage events, so a legacy enrollment
cannot activate new capture. Existing stored facts and attribution are not
rewritten.

The upstream API contract needed to resume enrollment is an atomic durable
generation-start boundary (or equivalent barrier) that distinguishes the
generation already in flight from generations begun after enrollment. Once
that contract is available, enrollment can freeze a task, plan, or unallocated
association without relabeling earlier work.

## Coverage and valuation

Current native capture coverage is reported as unavailable. Historical stored
facts, attribution boundaries, capture gaps, and cached-price valuations remain
available to authorized reads. Per-generation facts retain their original
observed, partial, missing, or unavailable status; absent token categories and
unavailable quotes are unknown rather than zero. Reports never trigger a price
lookup or inference request.
