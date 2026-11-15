# Frozen synthetic clean speech inputs

These local-only fixtures were frozen before native audio implementation and
Liquid inference. The WAV files are retained only in the approved local
verification cache at
`/private/var/folders/tr/3_qw264x55z9g8391dqb7tb40000gn/T/opencode/lazers-lfm3-audio-reference/`;
they are not included in this contribution or published.

| File                        | Exact spoken transcript                        | Format                                         |  Bytes | SHA-256                                                            |
| --------------------------- | ---------------------------------------------- | ---------------------------------------------- | -----: | ------------------------------------------------------------------ |
| `quick-brown-fox.wav`       | `The quick brown fox jumps over the lazy dog.` | PCM signed 16-bit, mono, 16,000 Hz; 2.670750 s | 89,560 | `0497e70d431e9d827c10bbaff120c9cbabf0834a747107f83cb161dc1f759880` |
| `turn-left-next-street.wav` | `Please turn left at the next street.`         | PCM signed 16-bit, mono, 16,000 Hz; 2.064625 s | 70,164 | `f9ce57f4e548e339e944ba87860cd35a545db46e5eafd69f3692ede19f6cb054` |

Generated on macOS 27.2 (build `26B123`) with the built-in `Samantha` English
(US, `en_US`) system voice at 175 words/minute. The system voice is the version
shipped with that OS build. Conversion used Apple `afconvert` 2.0.

```sh
say -v Samantha -r 175 -o quick-brown-fox.aiff 'The quick brown fox jumps over the lazy dog.'
say -v Samantha -r 175 -o turn-left-next-street.aiff 'Please turn left at the next street.'
afconvert -f WAVE -d LEI16@16000 -c 1 quick-brown-fox.aiff quick-brown-fox.wav
afconvert -f WAVE -d LEI16@16000 -c 1 turn-left-next-street.aiff turn-left-next-street.wav
```

The fixtures are synthetic clean speech, not a natural-speech generalization
corpus. Their bytes and transcripts are fixed; neither native nor Liquid
outputs may be used to alter them or their acceptance criteria.
