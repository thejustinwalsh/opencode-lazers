/**
 * The production sources: each file here calls `defineSource`, and this index imports it so
 * the reader worker and the RPC server register the same set. A source is added by creating its
 * file and importing it below.
 */
import "./tasks.ts"
import "./live-history.ts"
import "./radar.ts"
import "./host-sessions.ts"
import "./projects.ts"
