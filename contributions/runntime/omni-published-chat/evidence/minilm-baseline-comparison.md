# MiniLM batch GPU failures: matched baseline

The MiniLM batch failures in `full-gpu.log` reproduce in the separately
retained pinned LZ-17 baseline run in `minilm-baseline.log`. Both runs fail the
same two `test/zoo/leaks.gpu.test.ts` batch cases: buffer cleanup after dispose
and allocation stability after warm-up. Both display the same baseline
expected/actual buffer-size sequence (`40 B`, `40 B`, `20 B`, `20 B`, `3072 B`)
for disposal; the steady-state failure likewise differs by the same two 20 B
buffers per batch call. Single-text MiniLM cases and the other listed model
cases pass in the current full run. This is reproduced baseline behavior, not a
new regression from the Omni audio composition. The failure is not masked or
claimed repaired here.
