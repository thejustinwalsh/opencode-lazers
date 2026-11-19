//! `Instant` for step timing that also works where the target has no clock.
//!
//! `std::time::Instant::now()` panics on `wasm32-unknown-unknown`. The timings
//! it feeds are trace output only, so those targets report zero elapsed time.

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
pub(crate) use std::time::Instant;

/// A clockless stand-in: every elapsed time is zero.
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
#[derive(Clone, Copy)]
pub(crate) struct Instant;

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
impl Instant {
    pub(crate) fn now() -> Self {
        Self
    }

    pub(crate) fn elapsed(&self) -> std::time::Duration {
        std::time::Duration::ZERO
    }
}
