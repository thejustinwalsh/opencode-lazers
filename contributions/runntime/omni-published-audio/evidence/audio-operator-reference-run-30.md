# Pinned Liquid audio operator comparison — run 30

On 2026-11-14, the packed installed-package harness passed one real Chromium
WebGPU comparison using the exact source pair in `partial-manifest.json` and
Liquid engine revision `9c2fb176f4c222da394e8037d3c0d0837f70b978` (SHA-256
`77821949412f5dd6d60e37f22415f0e71454e65f6a73928529c6fbec0f2cf2cb`). The
packed harness verified the engine digest before adding an accessor-only
reference hook. Its instrumentation digest was
`8dbbedffbe2558579ec2577b47b57acfe9af1b01983dcbe5d548544c6086dcfe`.

The test compared the learned audio-encoder output for unchanged
`quick-brown-fox.wav` (SHA-256
`0497e70d431e9d827c10bbaff120c9cbabf0834a747107f83cb161dc1f759880`), Liquid
depth-code IDs at a fixed same-file text hidden state using seed `1234` and
matched `[4, 4, 4]` reveals, and one full codec frame decoded from identical
valid code IDs. Liquid's TTS input used the documented system prompt plus the
raw requested user phrase; native and reference depth decoders used the same
frame order and greedy code selection.

| Operator        | Compared values |      RMS error | Max absolute error | Cosine similarity / exact match |
| --------------- | --------------: | -------------: | -----------------: | ------------------------------: |
| Audio encoder   |          69,632 | `0.0000550797` |      `0.000789881` |                  `0.9999996283` |
| Depth decoder   |     12 code IDs |              — |                  — |                     exact match |
| LiquidCodec PCM |           1,920 | `0.0000231942` |     `0.0000944678` |                  `0.9999889873` |

The matched depth order was `[2,3,5,7,6,4,1,11,0,10,9,8]`; the shared code IDs
were `[927,603,1912,689,1200,399,91,1621,736,1100,1467,1745]`. Vitest reported
1 test passed, 0 failed (13,891 ms test duration). The exact report is
`audio-operator-reference-run-30.json`; the captured metrics and packed build
output are retained in the corresponding run-30 shell log outside this
contribution. The build also printed existing TypeGPU ambient-declaration
parse warnings; the package build and test completed successfully.

This is numerical/operator evidence for the observed vectors and one codec
frame, not broad decoder-logit or perceptual-quality equivalence. Public
streaming/recovery and same-file word recovery are recorded separately in
`speech-quality-deviation.md`.

The reproducible packed test selection was:

```sh
LFM3_BASE_QUALIFICATION_MODE=liquid-reference \
LFM3_PACKED_TEST_FILE=test/zoo/lfm3/audio-reference.gpu.test.ts \
LFM3_LIQUID_ENGINE_PATH=<pinned-engine-bundle> \
LFM3_LIQUID_MODEL_URL=https://lazers-lfm3-assets.localhost:1355/LFM3-Omni-2B-Q4_K_M.gguf \
LFM3_LIQUID_PROJECTOR_URL=https://lazers-lfm3-assets.localhost:1355/mmproj-LFM3-Omni-2B-Q8_0.gguf \
LFM3_LIQUID_AUDIO_INPUT_BASE_URL=https://lazers-lfm3-reference.localhost:1355 \
npx --yes portless run --name lazers-lfm3-liquid-qualification --prefix '' -- \
pnpm exec node test/zoo/lfm3/packed-consumer.mjs
```

`LFM3_BROWSER_TRUSTED_SPKI` contained only the three freshly verified,
certificate-key-scoped Portless SPKIs documented in
`browser-tls-verification.md`; it did not disable TLS validation globally.
