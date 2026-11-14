# Frozen audio route TLS verification

The frozen WAV fixtures and exact pinned model files were served through the
existing Portless HTTPS proxy on port 1355. The routes used the existing
Portless CA; they were not downgraded to HTTP, and no login-keychain or global
TLS settings were changed.

Verified immediately before the packed Chromium audio and Liquid-reference
runs on 2026-11-13 (including runs 12–14):

- CA-verified TLS with `curl --cacert "$HOME/.portless/ca.pem"` and an explicit
  loopback `--resolve` for `lazers-lfm3-reference.localhost:1355`.
- The served certificate has SAN `DNS:lazers-lfm3-reference.localhost` and
  SHA-256 fingerprint
  `FED85694A6D896865ABFFFEC00D63B7B9EF01458540CD3B01A57298C64BE99DF`.
- The verified certificate SPKI is
  `oIYn7RVilEbqziniP2R1NdRLRW2fwE+ylWNcWq9TnT4=`.
- HTTPS GET returned HTTP 200 for each fixture. Downloaded byte counts and
  SHA-256 values matched `audio-reference-inputs.md`:
  - `quick-brown-fox.wav`: 89,560 bytes,
    `0497e70d431e9d827c10bbaff120c9cbabf0834a747107f83cb161dc1f759880`.
  - `turn-left-next-street.wav`: 70,164 bytes,
    `f9ce57f4e548e339e944ba87860cd35a545db46e5eafd69f3692ede19f6cb054`.
- The model assets were served from
  `https://lazers-lfm3-assets.localhost:1355`. CA-verified TLS reported
  `DNS:lazers-lfm3-assets.localhost`, SHA-256 certificate fingerprint
  `6993D332E69DCCE8A364CD24802CD6831F368D2AFE1CEF3F9B9A531A63B13251`, and
  SPKI `MvqQIcLjQpdkbIB7QRc2v5PVxibKAD1rk1Pe+Gv8m0o=`. HTTP range requests for
  both pinned GGUFs returned 206 with TLS verification result 0; the first 64
  bytes of the served language GGUF matched the locally hash-verified source.

The packed test harness accepts an optional `LFM3_BROWSER_TRUSTED_SPKI` and
passes the comma-separated verified SPKIs only to its isolated Chromium process
as `--ignore-certificate-errors-spki-list=<verified SPKIs>`. These are
certificate-key-scoped allowances for the verified local Portless certificates;
they do not disable certificate validation generally.

Before corrected packed Chromium reference run 20 on 2026-11-14, the
qualification server was registered at
`https://lazers-lfm3-liquid-qualification.localhost:1355`. The existing CA
verified the chain and exact hostname; HTTPS returned HTTP 200. Its certificate
SAN was `DNS:lazers-lfm3-liquid-qualification.localhost`, SHA-256 fingerprint
`46FAAF8890AFA55F4E1C7A355A965140CF42B012E3AAD4B18650260D6A8FDAEB`, and SPKI
`E6gQI1I90sg5O2EwNyfRJquaPMWnfYJcDYbENIOOV9w=`. Chromium received only this
verified SPKI together with the freshly rechecked fixture and asset SPKIs.
The qualification route used the existing Portless proxy/CA; no trust-store,
login-keychain, or global TLS setting was changed.

Before the run 23 level diagnostic, the existing CA and exact hostnames were
reverified for the fixture and both ranged model assets. Their certificate
fingerprints and SPKIs remained identical to the values above. The isolated
Chromium process trusted only those three reverified SPKIs plus the already
verified qualification-route SPKI. The command results are retained in
`liquid-audio-reference-run-23-tls.log`.

## Reverification before corrected packed runs 26–31

On 2026-11-14, the existing shared Portless CA was reused. No HTTP downgrade,
login-keychain edit, trust-store mutation, or global TLS bypass was performed.

- `curl --cacert "$HOME/.portless/ca.pem"` with an explicit loopback
  `--resolve` verified byte-range requests to
  `https://lazers-lfm3-assets.localhost:1355`: HTTP 206 and TLS verification
  result 0. The asset certificate SPKI was
  `MvqQIcLjQpdkbIB7QRc2v5PVxibKAD1rk1Pe+Gv8m0o=`.
- The same CA-verified request to
  `https://lazers-lfm3-reference.localhost:1355/quick-brown-fox.wav` returned
  HTTP 206 with TLS verification result 0. The fixture certificate SPKI was
  `oIYn7RVilEbqziniP2R1NdRLRW2fwE+ylWNcWq9TnT4=`.
- Immediately before run 30, `openssl s_client` verified the exact packed-test
  hostname `lazers-lfm3-liquid-qualification.localhost` against the existing
  CA with `-verify_hostname` and `-verify_return_error`: verification code 0,
  SAN `DNS:lazers-lfm3-liquid-qualification.localhost`, SHA-256 fingerprint
  `46FAAF8890AFA55F4E1C7A355A965140CF42B012E3AAD4B18650260D6A8FDAEB`, SPKI
  `E6gQI1I90sg5O2EwNyfRJquaPMWnfYJcDYbENIOOV9w=`. Immediately before run 31,
  the same CA/hostname verification again returned code 0 and the same exact
  fingerprint and SPKI. The route served the packed Chromium public-chat run.

Runs 26, 27, 30, and 31 used HTTPS through Portless. Chromium received only
the asset, fixture (where used), and packed qualification SPKIs just listed via
`--ignore-certificate-errors-spki-list`; certificate validation was not
disabled globally. The model and fixture range requests returned 206. Exact
current curl/OpenSSL commands and observed responses are retained in
`portless-tls-run-26-31.log`.
