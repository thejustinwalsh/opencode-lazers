//! Allocation counters for measuring memory (feature `memstats`, never in the shipped modules).
//! `lz_alloc_live` and `lz_alloc_peak` are exported so the host can sample them between calls.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};

static LIVE: AtomicU64 = AtomicU64::new(0);
static PEAK: AtomicU64 = AtomicU64::new(0);
static ALLOCS: AtomicU64 = AtomicU64::new(0);

pub struct Counting;

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let live = LIVE.fetch_add(layout.size() as u64, Relaxed) + layout.size() as u64;
        PEAK.fetch_max(live, Relaxed);
        ALLOCS.fetch_add(1, Relaxed);
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size() as u64, Relaxed);
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let old = layout.size() as u64;
        let new = new_size as u64;
        if new >= old {
            let live = LIVE.fetch_add(new - old, Relaxed) + (new - old);
            PEAK.fetch_max(live, Relaxed);
        } else {
            LIVE.fetch_sub(old - new, Relaxed);
        }
        ALLOCS.fetch_add(1, Relaxed);
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn lz_alloc_live() -> u64 {
    LIVE.load(Relaxed)
}
#[unsafe(no_mangle)]
pub extern "C" fn lz_alloc_peak() -> u64 {
    PEAK.load(Relaxed)
}
#[unsafe(no_mangle)]
pub extern "C" fn lz_alloc_count() -> u64 {
    ALLOCS.load(Relaxed)
}

pub fn live() -> u64 {
    LIVE.load(Relaxed)
}
pub fn peak() -> u64 {
    PEAK.load(Relaxed)
}
pub fn reset_peak() {
    PEAK.store(LIVE.load(Relaxed), Relaxed);
}
