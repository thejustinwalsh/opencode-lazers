# a93c3e40 — json-byte-visitor

No actionable regression established.

## Checked and sound

- Reviewed exact range `32a982bc..a93c3e40`; helper extraction retains the visitor's early budget exit.
- Quote, backslash and short/control escapes retain their JSON byte costs.
- Iteration remains by Unicode code point, with paired astral characters counted as four UTF-8 bytes and lone surrogates as six-byte escapes.
- Array holes/unsupported entries remain JSON null; unsupported object values remain omitted; numeric/non-finite handling is unchanged.

## Not reviewed

- No exhaustive fuzz comparison against JSON serialization; exotic non-JSON objects were not independently tested.
- Existing live-read integration fixtures were not executed.
