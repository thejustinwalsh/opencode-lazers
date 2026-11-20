# ruNNtime LFM3 audio executor trim contribution

`createLfm3Audio` trimmed its executor pool only after warm-up. Clip and prompt
lengths vary, so every new length left a set of pooled GPU buffers behind. Over six
speak and transcribe cycles GPU bytes grew from 1.97 to 2.17 GB. The runner now
calls `executor.trim()` after each queued operation, however it ends (completed,
failed or aborted while running), in a `finally` around the scheduled operation. An
operation aborted before it starts runs no work and trims nothing.

This is commit `bff786d` of the fork branch `upstream/10-audio-qualification`
(0.3.0-based; see `../omni-audio-qualification/`) re-applied to the 0.2.0-based
`lazers-shared-omni`: the `lfm3.ts` hunk cherry-picked cleanly; that commit's test
changes touched files that do not exist on this base and were replaced by the two
tests below.

## Identity

- Fork: `https://github.com/thejustinwalsh/runntime`, branch `lazers-omni-trim`,
  cut from `lazers-shared-omni` (no rewritten history).
- Base: `a3718c80f959b8e86d1b2abf056fb578f532aeb9` (release `lazers-omni-a3718c8`).
- Tip: `70ab1be9c16571b777b0321073e230e1873b1a4b`, `test(zoo): check memory stays flat across repeated LFM3 audio runs of varying length`.
- Release: `lazers-omni-70ab1be`, asset
  `https://github.com/thejustinwalsh/runntime/releases/download/lazers-omni-70ab1be/runntime-0.2.0-70ab1be.tgz`
  (SHA-256 `3de2fd28c1d6f4484f8888308977141222e2efe36b82aeaf0d973d5c9fcb57f0`).

## Evidence

- Unit (60 files, 1195 tests; two added in `test/zoo/tasks/audio/speak.test.ts`
  with the executor faked: trim runs after a completed speech, a transcription and a
  failed speech, and once per queued operation; both fail without the fix), typecheck,
  lint, format check, build and package listing.
- GPU, real WebGPU on Apple M2 Pro against local Q4_K_M weights, one file at a time:
  - `audio-trim.gpu.test.ts` (new): six sentences, speak then transcribe, two passes. With the
    fix GPU bytes stay at 1.84 to 1.89 GB (1.83 GB after load) and the second pass lands within
    4.3 KB of the first; without it the same test fails with 1.97 to 2.17 GB
    (`evidence/gpu-audio-trim-memory.txt`, `evidence/gpu-audio-trim-without-fix.log`).
    No storage buffer outlives dispose. About 659 small uniform buffers and one 512 KB readback
    buffer do remain in the root cache after dispose; they are not storage buffers, they are
    independent of the trim, and the test does not assert on them.
  - `public-audio.gpu.test.ts` (mode `audio`), `public.gpu.test.ts` (mode `q4`) and
    `recovery.gpu.test.ts` (mode `q4-recovery`) pass.
- The fork's `lazers-shared-omni` branch was not advanced; the release is cut from
  `lazers-omni-trim`.

Verify with `bun scripts/verify-runntime-contribution.ts --stage omni-audio-trim`
(optionally `--repository <runntime checkout>`).
