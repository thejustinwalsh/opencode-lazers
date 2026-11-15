# Published Q4 public chat after Omni audio composition — run 31

On 2026-11-14, the latest sibling ruNNtime tip (`abee81448bae6b616664b53d01ab68993f713ad3`, tree `221c485c5dc1645a2080917ade3de6732ff09689`) was packed and tested through the installed `runntime/zoo` entry on real Chromium WebGPU. The exact pinned Q4_K_M language GGUF was fetched through the CA-verified Portless HTTPS asset route; the pinned tokenizer remained unchanged.

The public chat check passed 1/1 tests (67,904 ms test duration). It observed:

- Pinned deterministic Liquid answers `42`, `Paris`, and `Blue`.
- Partial weight-load abort and warm-up abort after full upload both rejected with `LOAD_ABORTED` and left zero new storage buffers.
- Streamed text matched each generation result. Cancellation followed by reset/recovery produced nonempty `Hello!`; the second public session generated nonempty text after the first disposed the shared executor.
- The first and second normal requests completed in 295.1 ms and 136.8 ms. Load plus warm-up was 18,828.1 ms. Across the abort, warm-up, and public sessions, the RangeSource read 8,603,380,320 bytes.
- The complete Q4 language model used 1,535,385,996 bytes of GPU buffers after load; sampled GPU peak was 1,547,757,452 bytes. After disposal there were no live storage buffers; TypeGPU retained 515,332 root-cache bytes.

All run output, result text, abort observations, measurements, and the passing Vitest report are retained in `composed-after-audio-run-31.json`. This verifies the public-chat interface against the code composed with audio; it does not close the separately pending independent full-vocabulary Liquid logits/probability comparison. `manifest.json` retains this new package/parity/resource evidence alongside the original LZ-19 commit series.
