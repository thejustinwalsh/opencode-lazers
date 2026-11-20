// This bounds abandoned transport ownership, not the caller's operation deadline.
// Healthy owners renew through content-free RPCs during the two-second resync.
// Expiry fails the original call; it never makes delivered work replayable.
export const CLAIM_LEASE_MS = 10_000
