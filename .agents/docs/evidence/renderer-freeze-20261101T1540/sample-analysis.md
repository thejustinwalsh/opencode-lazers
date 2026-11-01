# Matched sample — attribution boundary

Native read-only analysis `ses_e6832f0b4ffehWZ5fxpIt8FVqd` examined the committed
sample/capture and narrowly selected local export fields. It ran no inference,
live attachment, profiling, sampling, reload or settings/session changes.

## What the saved sample establishes

`renderer.sample.txt:1–19` identifies PID 77897, ARM64, Desktop 2.2.5 and sample
start 2026-11-01 10:41:20.579 EST. Its 9.2G physical footprint / 11.0G peak are
**process** measurements, not JS heap measurements. The nominal five-second,
1 ms sampling request produced 3,139 observations per thread across 24 threads;
counts are neither CPU milliseconds nor continuous timing of the earlier freeze.

Main-thread stacks (`:24–154`) traverse native/Electron labels, reported
MicrotasksScope frames and unknown executable addresses. Unknown
`0x12809254cb0` has 2,929/3,139 inclusive observations (about 93.3%); its sampled
children include `0x15223eff8` (1,125) and `0x15223efa4` (996). Child/ancestor counts
must not be added as independent time. Large-offset V8-labelled descendants do
not reliably partition execution into compilation, allocation or GC categories.

The compositor and several service threads predominantly wait (`:329–409`);
three DedicatedWorker threads end in mach_msg2_trap (`:851–889`). Names alone do
not identify their application owner. The aggregate leaf wait totals (`:923–945`)
combine threads and do not mean the main renderer was idle. Literal `_OrtRun`,
`wasm` and JavaScript source coordinates are absent; absence is not proof those
subsystems were uninvolved.

## Matched earlier heap and execution fields

Allowlisted fields from the local export's
`desktop/20261031T205316/main.log:16187–16204` show the matched request's polled
event at 10:32:23.859 EST: inputChars 7,959, usedJSHeapSize 2,095,554,636 bytes,
heap limit 4,395,630,592 bytes. Source is `src/webgpu/runtime.ts:68–74`.
This earlier roughly 1.95 GiB heap reading is **not** a sample-time reading or
retained-object/leak diagnosis.

The same archive confirms inputs-ready at 10:32:23.865 with 2,087 tokens/eight
questions, run at 10:32:23.868, and matched unresponsiveness/capture failure at
10:40:49.814/10:40:51.817 (`main.log:16234–16288`). Last stage is the last emitted
marker, not identification of the CPU-consuming application function eight
minutes later. Configured EP is WebGPU; observed EP is unknown.

## Offline mapping possibilities and limits

The sample names Electron Framework 44.9.1, load address `0x10ed54000`, UUID
`4C4C44B3-5555-3144-A1D1-D61C2A2E3B66` (`renderer.sample.txt:992–998`). The installed
binary matches that UUID but has no DWARF/STABS/LC_FUNCTION_STARTS or bundled
matching debug symbols. Matching external symbols could improve native-frame
names offline; they cannot reconstruct missing JIT address mappings.

The dominant unknown addresses lie outside recorded binary-image ranges. No V8
code-event/address map or generated-script coordinates were preserved. Ordinary
JavaScript source maps therefore cannot map those raw PCs back to application
source, even if the exact evaluated bundle were available.

The installed app archive contains main-DH32_HOX.js and its map with 741 embedded
sources. Its embedded plugin evaluator uses new Function (host.ts:248–251).
The current local plugin bundle is 40,482,871 bytes / 2,672 lines, SHA-256
`947d2dacf248a159a064d90681f226bb217d7aa636f2162ba74b247258fd42b4`, with no sourceURL,
sourceMappingURL or adjacent map. Current file presence/mtime is not proof that
PID 77897 evaluated those exact bytes. The GUI preset inlines dynamic imports
into one CJS file; current configuration does not enable maps.

## Decision boundary

No application-level freeze repair follows from this sample alone. The separate
runtime/recovery investigation must distinguish deterministic source defects from
hypotheses. If application attribution remains missing, a bounded pre-armed
profile during authorized ordinary work could retain script coordinates,
PID/request and evaluated-artifact identity; post-unresponsive profiler enable
already timed out here. That is a proposed measurement, **not performed or
authorized by this read-only analysis**. An inert evaluator stack fixture could
test wrapper-coordinate mapping without inference, but not prove freeze cause.

Preserve all enabled features and working engine/provider stack. Do not credit
LZ-37's clock correction or revive the cancelled LZ-14 implementation.
