/**
 * The host-backed sources (`../host-source.ts`). They are opened only on the main thread, where
 * the Streams RPC lives, and they read the host and the effort worker, so the reader worker never
 * imports this: `index.ts` (SQL sources) stays the worker's set.
 */
import "./trajectory-host.ts"
