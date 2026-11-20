# Decision-model spike: how to present an ask to D1

Status: throwaway measurement, stopped early on the owner's direction ("build the flow with all five agents running, record scores, tune later"). Nothing here is product code. The spike no longer gates the build; the numbers below are a starting point for the threshold and a list of what to measure on production records.

## What ran

- **Model:** D1 Omni 600M, Q8, the build LAZERS ships (`runntime@0.2.0` `createD1Decider`, `models.d1.D1_OMNI_600M.Q8`), run in headless Chromium (Playwright 1.64, `--enable-unsafe-webgpu`) on one Apple-silicon Mac, WebGPU. Weights `d1-omni-600m-text-q8.safetensors` sha256 `a5f94915d38627f0755df90372f1cda3d30e4d489066aaff44d2eeb98d2793e5`; `tokenizer.json` sha256 `1efc3a6609abf6b63b1f47188d139f3b59973a6a434dffe970a7261a51ed2711`. Served from disk by a loopback server on an ephemeral port (stopped after each run); never copied.
- **Questions** are formed as the product forms them (`src/webgpu/decisions.ts`, `system-one.ts`, `runntime-decision-runtime.ts`): `noul` yes/no returns P(yes); `choice` returns a probability per option. No other model was substituted.
- **Wordings.** Size: choice over `one task` / `a few tasks` / `a large effort` (each with a short description). Agent W1: yes/no "Does `<scope>` call for a plan that `<use-when line, 'The plan' removed>`?" Agent W2: one choice among the five agents, each option carrying its use-when line ("Which reviewer would help most with the plan for this request?"). Score = P(yes) for W1, the agent's probability for W2.
- **Device limits.** First runs used `tgpu.init` with no limits (default 128 MiB storage binding). See "Device limits" below. All kept comparison data is from the fixed device, except the one row labelled "default limits".

## Test set and labels

`labels.json` was written by `build-set.ts` before any model ran. 44 asks: 16 `one task`, 14 `a few tasks`, 14 `a large effort`.

| Source                                                                                                                                        | n   | Size label                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------- | --- | ----------------------------------------------------------------------------------------------------------- |
| Hand-written, developer voice (typos, renames, bugs, one-area features, pasted code, stack trace and test log, large multi-part, large vague) | 25  | by me                                                                                                       |
| `runner_plans` in the live DB (task objectives)                                                                                               | 8   | nodes in the plan: 1 -> one task, 2-4 -> a few tasks, 5+ -> a large effort (7 plans of 1-3 nodes, one of 5) |
| `design/architect-planning.md`, `design/project-profile.md`                                                                                   | 2   | number of build-order steps (4 -> a few, 5 -> a large effort)                                               |
| `.agents/plans/*.md` (9 plans, 6 KB to 144 KB)                                                                                                | 9   | by reading headings (task or phase count)                                                                   |

Agent labels (helpful yes/no) are my judgement from the five use-when lines, with a one-line reason per ask in `labels.json` (`why`). The two design files use the real result files in `.agents/reviews/2026-11-20-planning/`: an agent counts as helpful when it reported a major or blocker finding (all five did, on both). Base rate: 131 of 210 ask-agent pairs (62%) are labelled helpful (comprehension 23, grounding 31, readiness 31, critic 27, zoom-out 29 of 44). The nine plan files are labelled all-yes, which is permissive and makes negatives rare outside short asks.

Limits of this experiment: 44 asks (42 in most tables; the two 120 KB+ plans were dropped), labels mostly one model's judgement, DB objectives are orchestrator prose rather than owner voice, one machine, one model build, one wording per question.

## Approaches: what finished

| Approach                                                                                                       | State                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A whole text, flat (7 questions batched)                                                                       | finished on fixed device, 42/44 (P08, P09 dropped); also on the default-limit device, 42/44                                                                    |
| C sliced flat, ~4 sentences with one-sentence overlap, one question per request                                | finished, 42/44 (P08, P09 dropped as 7+ minutes each)                                                                                                          |
| C1 sliced flat, one sentence per piece                                                                         | 41/44 (P07, P08, P09 not run)                                                                                                                                  |
| B whole tree, D sliced tree, E uncertainty, F outline walk, G halving, H filter/beam, C2 (two-sentence slices) | **implemented in `lib.ts`, not run to completion** (stopped by the owner before any produced results). No numbers are claimed for them.                        |
| Option-order and mirrored-wording tests                                                                        | measured inside A, C and C1 (below)                                                                                                                            |
| Stability (run twice)                                                                                          | 32 asks under 700 chars, 224 question pairs, run twice: maximum probability difference 0.000. D1 is deterministic on this machine, so repeat runs add nothing. |

The sliced runs obey the owner's budget of 400 input tokens per request: one question per request (batching gave no saving: 7 questions on a 52-token state took 282 ms, 1 question 42 ms), state at most 650 characters (longer pieces are split). The 4-sentence run had a median of 106 tokens per request, maximum 345; 0 of 6,361 requests over 400. C1: median 73, max 257, 0 of 10,254 over 400.

## Results

Size is judged on the given option order. "Simple vs complex" is `one task` against the other two.

| Approach                                    | Size exact | Simple vs complex | Agent AUC W1 / W2 | Requests per ask (median / max) | Model seconds per ask (median / p90 / worst) |
| ------------------------------------------- | ---------- | ----------------- | ----------------- | ------------------------------- | -------------------------------------------- |
| A whole, fixed device                       | 20/42      | 29/42             | 0.66 / 0.63       | 2 batched / 2                   | 1.4 / 37 / 223                               |
| A whole, default limits (7,000-char chunks) | 20/42      | 29/42             | 0.69 / 0.66       | 2 / 8                           | 1.4 / 37 / 90                                |
| C sliced, 4 sentences                       | 18/42      | 27/42             | 0.71 / 0.70       | 18 / 1,841                      | 1.4 / 29 / 142                               |
| C1 sliced, 1 sentence                       | 13/41      | 25/41             | 0.71 / 0.71       | 36 / 1,561                      | 2.5 / 56 / 93                                |

AUC is the chance a helpful ask-agent pair outscores an unhelpful one (0.5 is chance). Combining: maximum over pieces per agent, largest size over pieces. Whole text (A) worst case is dominated by the 45 KB plan (223 s); sliced worst case by plans too (C 142 s, C1 93 s, seconds roughly 3 per KB). For asks of 2,000 characters or less (33 asks) the median is 1.3 s for A and C, 2.4 s for C1; the worst small ask is 4.9 s (A), 8.9 s (C) and 16.7 s (C1). **C and C1 exceed 5 seconds on 10 and 13 of the 42 asks**; all those are the long plans, plus a few pasted-log asks.

Size confusion (rows truth one / few / large, columns pick one / few / large):

|         | one    | few   | large |
| ------- | ------ | ----- | ----- |
| A fixed | 10 6 0 | 6 4 4 | 1 5 6 |
| C       | 8 8 0  | 6 2 6 | 1 3 8 |
| C1      | 3 12 1 | 3 4 7 | 0 5 6 |

Size is poor everywhere. The model rarely says `one task` for a one-line ask (A: 6 of 16 simple asks called `a few tasks`; C1: 12 of 16), and `a few tasks` is close to a coin flip. Slicing hurt size: one sentence cannot show the size of the whole ask. The size worst cases in all three: H17 (a large effort, picked one task), and the typo, rename and dependency-bump asks (H01, H02, H05) picked `a few tasks`.

## Agent selection

Helpful pairs 131, unhelpful 79. At each threshold, hits (helpful kept), false (unhelpful kept), misses (helpful cut) and the number of asks where every agent is below the threshold (the derived "none").

W1 (yes/no per agent):

| Approach | Threshold | Hits | False | Missed | Precision | Asks all-below |
| -------- | --------- | ---- | ----- | ------ | --------- | -------------- |
| A        | 0.05      | 113  | 57    | 18     | 0.66      | 1/42           |
| A        | 0.10      | 100  | 34    | 31     | 0.75      | 3/42           |
| A        | 0.20      | 65   | 23    | 66     | 0.74      | 8/42           |
| A        | 0.50      | 30   | 8     | 101    | 0.79      | 19/42          |
| C        | 0.05      | 119  | 60    | 12     | 0.66      | 1/42           |
| C        | 0.10      | 104  | 37    | 27     | 0.74      | 3/42           |
| C        | 0.20      | 81   | 28    | 50     | 0.74      | 6/42           |
| C        | 0.50      | 54   | 9     | 77     | 0.86      | 17/42          |
| C1       | 0.05      | 122  | 64    | 4      | 0.66      | 1/41           |
| C1       | 0.10      | 114  | 46    | 12     | 0.71      | 2/41           |
| C1       | 0.20      | 94   | 36    | 32     | 0.72      | 3/41           |
| C1       | 0.50      | 50   | 12    | 76     | 0.81      | 14/41          |

W2 (five-way choice, per-agent probability): C1 at 0.10 gives 108 hits, 57 false, 18 missed (precision 0.65, all-below 0/41); at 0.20, 90 / 30 / 36 (precision 0.75); at 0.5 only 42 hits. A at 0.10: 94 / 45 / 37.

Reading:

- **Yes/no scores sit far below 0.5 even for agents that are needed.** At 0.5 the best approach (C) keeps 54 of 131 helpful pairs and 17 of 42 asks fall to "none". The threshold must be low.
- **A threshold of 0.05 to 0.10 is where recall holds** (C1: 0.97 at 0.05, 0.90 at 0.10; C 0.91 / 0.79). Precision there is 0.66 to 0.71 against a base rate of 0.62, so the model barely separates helpful from unhelpful pairs: AUC 0.71. This matches the owner's permissive stance (run all five, cut only what is clearly useless): at 0.10 on C1 the cut removes 33 of 79 unhelpful pairs and 12 of 126 helpful ones; at 0.065 (the highest value keeping 95% of helpful pairs) it removes 23 of 79.
- **W1 versus W2.** The two are close at the same thresholds (C1 at 0.2: yes/no 94 hits, 36 false, precision 0.72; choice 90 hits, 30 false, precision 0.75). The choice question never produces a "none" below 0.3 because its probabilities sum to 1, so it cannot express "nothing helps"; it needs a threshold near 1/5 to mean anything. Per agent, the choice question ranks comprehension (AUC 0.86) and zoom-out (0.84) better, and grounding (0.62) worse, than yes/no on C1; yes/no ranks readiness and critic about equally. Neither wording is clearly better; wording changes matter about as much as slicing (compare A 0.66 and C 0.71 for the same yes/no wording).
- **Which agents are hard.** Per-agent AUC (C, W1): comprehension 0.76, grounding 0.74, readiness 0.58, critic 0.78, zoom-out 0.70. Readiness is near chance at every slicing. Zoom-out is the most under-scored when needed (worst errors: H07, H20, H09, H17 scored 0.00 to 0.02 although labelled helpful). Examples of worst misses on C1: "Nobody can follow it anymore." (comprehension, 0.01), "The retry button on a failed task does nothing when ..." (zoom-out, 0.02), "Update the tests in src/cli/status.test.ts." (grounding, 0.05).
- **Degenerate choice.** Per-option pick frequency was not computed. What was measured: with the five-way choice, no ask has every agent below 0.2 (all-below 0/41 at 0.05 to 0.3 on C1), so it always names something; probabilities sum to 1 and it cannot say "none" until the threshold is near 0.5.
- **Whole versus sliced.** On this evidence slicing helps agent ranking (AUC 0.66 to 0.71 and recall at fixed precision improves, for example at 0.2: 81 hits for C versus 65 for A) and hurts size. One-sentence slices recall best at low thresholds but cost about twice as many requests and give the worst size.

## Option-order and mirrored-wording sensitivity

Measured on asks of 2,000 characters or less (asks over 2,000 skipped the extra orders for cost): size and five-way choice each asked in the given order, reversed and two shuffles; yes/no asked again in a mirrored wording ("Would a review aimed at plans that ... be irrelevant to this request?", answer flipped).

|                                                         | A              | C              | C1             |
| ------------------------------------------------------- | -------------- | -------------- | -------------- |
| Size answer changes with option order                   | 15/38 asks     | 12/33          | 10/33          |
| Mean spread of a size class probability across 4 orders | 0.19           | 0.18           | 0.19           |
| Size accuracy: given order -> averaged over 4 orders    | 20 -> 16 of 42 | 18 -> 17 of 42 | 13 -> 13 of 41 |
| Top reviewer changes with option order                  | 14/38          | 13/33          | 15/33          |
| Choice AUC: given -> averaged over 4 orders             | 0.62 -> 0.60   | 0.60 -> 0.60   | 0.63 -> 0.62   |
| Yes/no mirror flips across 0.5                          | 158/190 pairs  | 139/165        | 132/165        |
| Yes/no AUC: original -> averaged with mirror            | 0.64 -> 0.58   | 0.59 -> 0.52   | 0.61 -> 0.57   |

Option order moves the size answer in roughly a third of asks and moves a class probability by about 0.19 on average. Averaging over four orders did not improve accuracy on any measure (equal or slightly worse), so it is **not worth its four-fold calls**. The mirrored wording is not an answer-preserving rephrase for this model: it flips the decision in about 80% of pairs (the model says "no" to the mirror almost always, so 1 - p lands high). Mirror averaging lowered AUC. Use one fixed wording and one fixed option order, and put the option order in the recorded decision so it can be compared.

## Device limits (the default-limit failures and the fix)

- `tgpu.init` with no `requiredLimits` gave the default 128 MiB storage binding. The adapter reports `maxStorageBufferBindingSize` and `maxBufferSize` of 4,294,967,292 each. The fix requests the computed need, 16,384 tokens x 9,216 x 4 bytes = 603,979,776 bytes, clamped to the adapter.
- **Default limits:** a 4,442-token prompt failed at load with `UNSUPPORTED_DEVICE: allocating a f32 [4442,9216]: 163.7 MB exceeds ...`; and **`Device was lost` at about 2,020 tokens** (1,978 tokens worked, 2,022 failed, reproducible three times and after restart; once a 3,354-token prompt worked earlier in the session, so the default-limit boundary is not stable). These made the first whole-text runs unusable above roughly 7,000 characters.
- **Fixed limits:** no allocation refusals; latency per single-question request in the table below. **`Device was lost` still occurs between 9,942 and 13,846 prompt tokens** (a 13,846-token prompt ran 44 s and lost the device; the exact boundary was not narrowed). The nominal limit of 16,384 tokens per prompt is real (`INVALID_ARGUMENT D1 prompt exceeds its 16384-token context (20001 state tokens ...)`); 8,192 does not appear in the D1 path. `decide` caps context at 6,000 characters; `systemOne` caps the serialized envelope at 64,000 characters and 16 questions.
- Batched questions each pay the full state: `inputTokens` is the sum over questions and time scales with it.

Latency by prompt size, single question, fixed device unless noted (state plus question tokens):

| Tokens  | 52   | 216  | 285  | 972  | 1,142 | 1,978 | 2,792 | 3,342 | 4,442 | 6,642 | 9,942 | 13,846              |
| ------- | ---- | ---- | ---- | ---- | ----- | ----- | ----- | ----- | ----- | ----- | ----- | ------------------- |
| Seconds | 0.04 | 0.13 | 0.15 | 0.76 | 1.0   | 2.3   | 3.9   | 5.6   | 8.9   | 18.4  | 39.0  | device lost at 44 s |

The first four points are from the default-limit device (identical at these sizes); the rest from the fixed device. Cost grows faster than linearly: about 0.2 ms per token at 200 tokens, 1.1 ms at 2,000, 3.9 ms at 10,000. Question overhead is 58 to 66 tokens for yes/no and size, 167 for the five-way choice.

## Ranked conclusion (on this evidence only)

1. **Default: slice small, one question per request, take the maximum per agent, with all five agents running and scores recorded.** Sliced flat (C or C1) is best on agent ranking (AUC 0.71 against 0.66 to 0.69 whole), stays under the 400-token budget, and costs about 1.3 s for a typical ask. Prefer the 4-sentence window (C) when size matters (18/42 versus 13/41) and one sentence (C1) when recall matters. Long plans cost seconds roughly per kilobyte (142 s for 45 KB), so cap the pieces examined or run the decision after the Architect, not on every pasted plan.
2. **A threshold near 0.05 to 0.10 on the yes/no score** is the nearest to "just above unsure": it keeps 79% to 97% of helpful pairs and cuts 25% to 40% of unhelpful ones, and it matches the "run all five" decision. A threshold at or above 0.3 would cut most needed agents. Do not ship 0.5.
3. **Size from this model is not trustworthy** (20 of 42 exact, 29 of 42 simple-versus-complex, no better than guessing the largest class) and gets worse with small slices. Take size from the whole ask or leave it to the Architect; an ask with size `one task` must not skip the flow on this model's word.
4. **Wording matters about as much as slicing; option order matters; mirrored wording is unusable.** Yes/no and five-way choice are close; choose yes/no (it can say "none"), fix the order, do not average orders.
5. **Not worth its cost, from what was measured:** averaging over option orders and mirrored wording; the whole-text batched approach on long inputs (223 s worst case, device-loss risk above about 10,000 tokens).
6. **Not decided here:** whether a real decision tree (B, D), uncertainty-driven splitting (E), the outline walk (F), halving (G) or the beam (H) beat flat slicing. The question "tree against one batch of questions" and "outline walk (each request sees only its piece) against whole-text tree" is open: the code exists in the scratch folder and was not run. The reference notes (recursivedecisionmodels.com home, hierarchy and the notebook pages) returned no text to my fetch (script-rendered); only the reference documentation (`RDM.md`) was readable, so F to H follow its description rather than the notebooks.

## Not run

B, D, E, F, G, H and C2; the hierarchy pruning rule (children at least half as likely as the likeliest) against keep-top-2; counts of how often depth 3, 256 calls and 20 iterations ended a run; localisation judged on ten asks; the paragraph slice size; P08 and P09 under any approach; repeat runs of the finished approaches (checked for determinism instead).

## Measurements worth repeating on production records

1. **Threshold backtest.** For each recorded Architect ask, score all five agents on C-style slices and set the threshold by recall of agents whose review produced a major or blocker finding; report the all-below rate and the share of asks where a cut agent would have found something (compare 0.05 and 0.10, where this spike's precision is 0.66 to 0.71 against 0.62 base rate).
2. **Size ground truth.** Compare the model's size (whole ask versus sliced) with the number of tasks the ask became on the 27 sessions with a submitted task, and with the Architect's own call; this spike's 20/42 needs a second label source.
3. **Latency and failures in the product's own renderer.** Record input tokens, seconds and failures per request in the Desktop (not headless), including how often `Device was lost` or a timeout occurs above 2,000 and above 10,000 tokens, because this spike's limits come from one headless Chromium.

## Files (scratch, not committed)

Folder `/private/tmp/claude-501/-Users-tjw-Documents-ChatGPT-opencode-lazers/b47493ed-6bdc-45ea-82fa-61d28bfbfe2d/scratchpad/spike-decision/`: `labels.json` (labelled set), `build-set.ts`, `tree.json` (decision tree as data), `lib.ts` (approaches A to H, slicers, outline), `harness.ts` and `page/` (loopback server, Playwright, D1 page), `runall.ts`, `analyze.ts`, `stab.ts`, limit and latency probes (`lat*.ts`, `lim*.ts`, `ovh.ts`), `raw/` (per-approach results `A.rep0.json`, `C.rep0.json`, `C1.rep0.json`, `default-limits/` and `old-batch/` results, the request cache `cache-fixed.jsonl`, probe logs).
