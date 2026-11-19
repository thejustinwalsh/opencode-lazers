//! Entropy backend for `getrandom` on `wasm32-unknown-unknown`.
//!
//! Dependencies (`ahash` through `lightningcss`) ask for random bytes to seed
//! hash maps. A fixed stream keeps the module free of host imports and makes
//! every run deterministic. Nothing here is a security boundary.

use getrandom_03 as _;

#[unsafe(no_mangle)]
unsafe extern "Rust" fn __getrandom_v03_custom(dest: *mut u8, len: usize) -> Result<(), getrandom_03::Error> {
    // SplitMix64 over a constant seed.
    let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
    for index in 0..len {
        state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        unsafe { dest.add(index).write(z as u8) };
    }
    Ok(())
}
