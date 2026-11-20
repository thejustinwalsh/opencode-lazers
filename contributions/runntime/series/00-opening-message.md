# Draft: opening message to the maintainers (edit freely; nothing has been posted)

Suggested place: a GitHub discussion or the feature-request issue form (Area: Zoo), before any pull
request. Plain words, first person; change anything that is not how you would say it.

---

Hi,

I have been running ruNNtime for a while through a fork and I would like to contribute what I built
on it. You told me contributed work should go in the zoo, so this is how I would like to do it. I
want to check the shape with you before I open anything.

**What it is.** Support for two Liquid AI model families.

- LFM3-Omni 2B: streaming text chat, transcription and streamed speech, loading either the original
  safetensors or Liquid's published Q4_K_M and Q8_0 GGUF files. For that I added a GGUF reader to
  core (checked against a pinned SHA-256), per-group offsets for the quantized matmul (Q4_K needs
  them), a depthwise 1-D convolution, and a few lifetime and evaluation fixes found on the way.
- D1 Omni 600M: a text decision model that scores yes/no, choice and rubric questions. This builds on
  the port `chmjkb` already has on `@chmjkb/d1-omni`.

**How I would send it.** As small pull requests, in this order, each branch cut from the one before and
each green on its own (typecheck, lint, format, unit tests, build; I ran the GPU tests locally and will
say which in each description):

1. `depthwiseConv1d` op and kernel
2. Quantized per-group offsets (2a), then the GGUF reader (2b)
3. Core: quantized CPU `Embedding`, evaluation and upload-lifetime fixes, grouped column broadcast
   (three commits, can be three pull requests)
4. LFM3 streaming chat
5. LFM3-Omni audio: frontend, projector, codec and sampler (5a), the audio model (5b), the public
   runner (5c)
6. One shared backbone for chat and audio, and tied embedding rows streamed from the GGUF
7. Selectable speech voice
8. D1, built on the collaborator's commits (see below)
9. Docs pages for LFM3 chat and audio

The branches are already on my fork under `upstream/01-conv1d` to `upstream/09-docs`, so you can read
them before deciding.

**D1 and credit.** The D1 branch starts with `chmjkb`'s three commits cherry-picked, with their
authorship kept, and my changes come after them (lifetime fixes, the public runner, tests, the Q8
loader). If you would rather their port lands first, I can rebase on it instead. I kept their
playground demos in those commits; say if you would rather not have them.

**Questions.**

1. Are Liquid AI models welcome in the zoo? Their weights are under the LFM Open License v1.0, not MIT.
   The zoo entries only point at Liquid's own Hugging Face repositories and I host nothing, but you
   may have a view.
2. Is a GGUF reader in core the right direction, or would you rather have a converter in `tools/python`
   that writes the safetensors layout?
3. Open pull requests #124, #127, #130 and #131 touch the quantized load and matmul paths that part 2
   changes. Do you want those to land first, or should I go first and rebase?
4. Two reference-data files come from running Liquid's and Hugging Face's reference code
   (`liquid-reference.json`, about 6,300 lines, and `reference-vectors.json`). Are you fine with fixtures
   that size, or should I shrink them?
5. The GPU tests are not in CI and some of mine need weights. I put the weight-dependent ones behind an
   environment variable so they skip by default. Is that how you want it?
6. Merge style for a series: merge commits (as in your AGENTS.md for `docs`) or squash?
7. [Your decision: whether and how to say that part of the code was written with AI tooling. I found no
   written policy upstream.]

I will start with part 1 whenever you are ready, and I am happy to split or reorder anything.

Thanks,
Justin
