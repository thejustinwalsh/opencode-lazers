# LZ-36 retained repair — expired history recovery

**Observed:** on mounted `214adcb`, loaded LZ-9 history survives refresh. After
capture expiry, Load more shows stale / [object Object] / Retry; healthy live
status hides the error, and Retry only refreshes status. This is not a data reset.
Root recorded the actual native failure at `5dd5d17` in `native-observations.md`.

**Desired:** show a safe, meaningful history-recovery message that survives healthy
live polls. Offer explicit recapture, distinct from live-status retry. Preserve
loaded rows, valid selection, disclosures and anchor; failed recapture keeps old
content, successful recapture replaces it honestly. Preserve authorization,
cursor binding, privacy, null-as-unknown decoding and current live selection.

**Useful findings:**

- `observability/rpc.ts:108–121` turns expected history failures into Effect
  defects; `contract.ts` declares no method errors. Use the pinned method-errors
  channel and the supplied handler `context.error` factory, not a new transport.
- The native Promise client throws a plain `{type,message,data?}` object, so
  String(error) is insufficient even after RPC error declaration is corrected.
- `panel-state.ts` shares one error between history and status; healthy status
  clears it. The existing `recaptureActivity()` is the recovery reuse point.

Keep the existing task acceptance. Choose focused regressions for the concrete
error shape, persistence and recovery risks; Root's actual native RPC and mounted
checks cover the host/UI boundary. No elaborate embedded-host or rendering test
framework is prescribed. Continue in the same retained attempt; the next GUI
activation requires a coordinated Ready/quiet boundary.

[Optional deeper source/API research and test ideas](expiry-research.md).
