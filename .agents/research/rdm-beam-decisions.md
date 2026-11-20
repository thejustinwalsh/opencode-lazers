# Recursive Decision Models (RDM): sources, algorithm, and routing use

Researched 2026-11-20. Not committed. Quotes are under 15 words and taken verbatim from the pages named. "Inference" marks my reasoning, not a source's claim.

## 0. What RDM is, and who uses the term

| Item                    | Source fact                                                                                                                    | Date                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| Term coined and defined | Raymond Weitekamp (RAW.works, OpenProse) names "Recursive Decision Models", built on RLM ideas for decision models such as Jev | post 2026-10-01; tweet 2026-09-21 |
| Home and demos          | recursivedecisionmodels.com: "A DSPy module for models that decide and do not write."                                          | site, rendered 2026-11-20         |
| Talk                    | "Your Agent Doesn't Need an LLM for Every Decision", AI Engineer Code Summit, 52 min, video hFNbPmzzcEs                        | site                              |
| Vendor naming           | Diogo Almeida (TypeSafe) prefers "System One models"; Weitekamp says the term is still open                                    | post footnote                     |
| Different talk          | "Recursive Coding Agents", AI Engineer World's Fair 2026 (no decision-model content, per ai.engineer page)                     | ai.engineer                       |

The site's definition: "A decision that can decide to make another decision." A decision model "answers one request: typed questions about the state it is shown... and it writes nothing."

**ruNNtime check.** The software-mansion/runntime README (fetched) is a WebGPU model zoo (`runntime/zoo`, `runntime/core`). It names no decision model, System One, RDM, beam search, or slicing. Docs: docs.swmansion.com/runntime. No talk or post by its authors on these topics was found. The browser decision model on recursivedecisionmodels.com is not named in the visible page text (unverified which runtime it uses). Inference: the ruNNtime link to the user's local model is not established by any source.

## 1. The loop (from the DSPy fork, `dspy.experimental.RDM`)

Source: github.com/rawwerks/dspy branch feat/rdm-v0, `RDM.md` and `dspy/predict/rdm.py`. The class is marked experimental.

```
call(request):                       # request = state (inputs) + typed questions
    answers = ask_once(request)      # one decision-model request
    for each tool selected by an answer:
        obs = tool(args from answers, inputs)
            # inside a tool: call.rdm(...) = sub-call, depth + 1, same run
    if a pointer selected a tool:    # Tool-typed output
        ask the same question again, on the changed state
    return answers, observations
```

- A `Noul` (yes/no) output named after a tool calls it on yes.
- A `Choice` output calls the tool of the chosen option (`None` calls nothing).
- A `dspy.Tool`-typed output points at one tool or `finish`. Pointing repeats the question.
- Tool arguments are filled by name from the request's other answers, then its inputs. The model chooses arguments; it never writes them.
- Code says: "The loop is the module's, not the model's." (RDM.md)

## 2. Stopping rules and limits (all defaults from RDM.md and rdm.py)

| Rule                                                      | Default                      | Termination reason    |
| --------------------------------------------------------- | ---------------------------- | --------------------- |
| No answer selects a tool                                  | none                         | natural end           |
| `finish` pointed at                                       | `finish=True`                | finish                |
| Same request key already on the path                      | none                         | `repeat`              |
| Turns in one pointer loop                                 | `max_iters=20`               | `max_iters`           |
| Depth at which tools stop running (first call is depth 0) | `max_depth=3`                | `max_depth`           |
| Requests per run, sub-calls included                      | `max_predictor_calls=256`    | `max_predictor_calls` |
| Tokens per run, including tool models                     | `max_tokens=None` (no limit) | `max_tokens`          |

When several limits fire, the code reports the highest-priority one: `max_tokens` > `max_predictor_calls` > `max_iters` > `max_depth` > `repeat`.

The site notes a runaway loop "dies" only at the request limit: the 80-request cycle in the smart-home demo.

## 3. State outside the requests

- `forward(state=...)` holds data no request shows. Tools read it as `call.state`.
- Requests never show `state`. Sub-calls with their own `state=` get a copy.
- Site: "The model never sees the state whole: a request shows what it was given and no more."

## 4. Helpers (what each does, from the code)

**RDM.Fit** (`fit=`, `rdm_fit.py`): cuts what one request cannot hold, deciding with the same model.

| Parameter          | Default | Role                                          |
| ------------------ | ------- | --------------------------------------------- |
| `max_chars`        | 40,000  | characters of input one request shows         |
| `max_options`      | 240     | options per Choice (docstring: Jev takes 255) |
| `max_questions`    | 16      | option groups per request                     |
| `parts`            | 8       | parts a long input splits into                |
| `keep`             | 2       | survivors per group, minimum                  |
| `needed` threshold | unset   | set after construction, or fitted by ReAnchor |

- Long text: split by lines (dicts by entry, lists by item), each part asked "needed?" as a sub-call. Parts ranked by `likely(needed)`, kept greedily in original order, joined with `"\n[...]\n"`.
- Long Choice: options packed into groups. Within each group, options ranked by probability; top `keep` survive. Repeat until the options fit.
- All Fit sub-calls are answers-only (`max_depth=0`) and count against the run's limits.

**RDM.Filter** (`top=None`): sorts rated options by probability, likeliest first, returns the first `top`. No threshold inside the filter. Dropped: yes/no answers whose value is falsy. Ties keep input order (stable sort). Site: "a beam with no score."

**RDM.Near** (`signature`, `top=8`, `measure="dot"`, `use=False`): each map name answers the same few questions once (yes/no, Score, or Choice per dimension); answers cached per text. A request is asked the same questions. Pointer options are cut to `top` by similarity; names sharing nothing with the request (dot ≤ 0) drop out. Measures: dot (default), cosine, euclidean, manhattan, jaccard, or a callable. Thresholds exist per yes/no dimension, not on Near itself. Note from the code reader: euclidean, manhattan and jaccard sum only over the request's keys, which differs from the docstring.

**RDM.Repl**: a sandboxed Python REPL. Functions written into it appear on the map from the next request. One REPL runs one call at a time. (Design notes.)

## 5. The two worked search shapes

**Halving search** (post, 2026-10-01). Handbook of 71 lines, `max_depth=10`. Each request sends a half of the text. Answer: "15 requests, each a yes or a no". The whole handbook goes in the first request.

**Outline walk.** Code parses the handbook into `{heading: [headings and passages directly under it]}`. A request shows one entry and the headings below it. A yes calls the same question on each child.

| Version                | Requests | Largest request         | Source                      |
| ---------------------- | -------- | ----------------------- | --------------------------- |
| Post, 2026-10-01       | 15       | 272 of 2,555 characters | RAW.works post              |
| Site home page (later) | 9        | 347 of 2,555 characters | recursivedecisionmodels.com |

These differ. Inference: the site version is newer and uses a different tree walk. Treat the counts as demo figures, not measurements.

Layout by code before the run (site): halving 117 pieces laid out; outline 37 headings and passages laid out. "Code lays the whole tree out before the run."

## 6. The triage example (partial)

The notebook at recursivedecisionmodels.com/notebook?example=triage shows the first cell only. Visible code:

- Imports `Literal`, `dspy`, `RDM`, `Noul`.
- Input `message`: "I was charged twice for the same order and nobody answers my emails. I want my money back now."
- Tool `refund(team, message)` returns `"refund opened with {team}"`. Docstring: "`team` is an answer of the request, and `message` one of its inputs."

The signature defining `team` (its `Literal` options) and the rest of the cell are not visible in the rendered editor. I could not recover the full triage example. Inference: `team` is a typed Choice (`Literal`) answered by the model; the tool's argument is an answer of the same request, which matches the site's rule "an argument the model should choose is one more question."

## 7. Typed questions and probabilities

| Type                | Model returns                                     | Use                                       |
| ------------------- | ------------------------------------------------- | ----------------------------------------- |
| `Noul`              | probability of yes                                | tool call on yes; threshold per predictor |
| `Choice[...]`       | selected option, `probabilities` over all options | pointer or forced choice                  |
| `Score`             | number on a legend, with probabilities            | graded judgment                           |
| `dspy.Tool` pointer | one tool name or `finish`                         | map navigation                            |

- Choice probabilities sum to 1. Confidence reflects concentration, not correctness (TypeSafe Jev docs, via the runware mirror).
- TypeSafe's stated position: calibrated, "higher confidence means higher accuracy." No calibration metric is given (vendor page).
- Thresholds: tuned per decision on held-out data; retest when the model version changes (TypeSafe guidance).
- Hierarchy rule (site): children kept if "at least half as likely as the likeliest." Path search with no beam width or path score (post).

## 8. Hierarchical question asking and beams

- TypeSafe's cookbook (cited by the post, not read directly): one Choice per taxonomy node, three best paths kept by a beam scored with probabilities along each path.
- RDM version (post): no beam. Recursion asks the question at each node, follows all children at least half as likely as the likeliest, then asks again among leaves returned. Shopify taxonomy (12,000+ categories): 8 requests to the cookbook's leaf.
- Post: the code is "about twenty lines, where the cookbook's search code runs to about 150 LOC." Vendor claim.
- Site hierarchy demo: "Twelve thousand categories, and no request shows more than one level of them."
- Site caveat: the demo is a replay, "the laptop backpack, board game and hiking backpack are recorded answers." (Verified from page text on the hierarchy page.)

## 9. Input handling and slicing

- Pre-slicing is done by code. Long inputs go to Fit (`max_chars` 40,000, `parts` 8) or to an outline by heading.
- Per-slice answers are aggregated by the code's own rule: `Filter` keeps top items; Fit keeps parts by `likely(needed)`; hierarchy keeps children above half the top probability. No vote or mean across slices is stated.
- Context limits: Laya's default context is 512 tokens (1,024 multilingual), per the TypeSafe article; Jev 1.14 has a 262,144-token window, but TypeSafe still advises limiting it. Choice options: Jev 255, Laya about 20 at default settings (TypeSafe article).

## 10. Calibration, thresholds, known problems

| Problem                       | Evidence                                                                                                                        | Source                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Order sensitivity             | Laya changes 30% of answers when option order is reversed                                                                       | Li, arXiv 2610.02267 (2026-10-01)                                    |
| Order sensitivity in LLM MCQ  | 13–75% gap from reordering options                                                                                              | Pezeshkpour & Hruschka, arXiv 2308.11483 (2023; NAACL Findings 2024) |
| Similar candidates            | Laya drops to 31% with 50 nearest-neighbour tools; Jev 98% with a unique correct tool (different conditions, not like-for-like) | arXiv 2610.02267                                                     |
| Thresholds from in-sample fit | in-sample 5% target, held-out miss up to 17%                                                                                    | arXiv 2610.02267                                                     |
| Threshold tuning helps        | UNFAIR-ToS micro-F1 0.50 to 0.75 after tuning                                                                                   | Deußer et al., arXiv 2609.37647                                      |
| Typed output is not accuracy  | type safety constrains which option gets probability, not whether it is right                                                   | arXiv 2609.26758 (per search summary)                                |

Mitigations from the literature: option shuffling and averaging over permutations (Pezeshkpour), contextual calibration (Zhao et al., arXiv 2102.09690, "Calibrate Before Use", up to 30 points gain for GPT-3 few-shot).

Site: the model "kept everything and never chose to forget" in map edits (post). The decision model's own odds are the only pruning rule.

## 11. Reported results (strength of evidence)

| Claim                                                      | Number                                                                                      | Strength                                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Jev vs Qwen/Gemma, 37 datasets, 346,009 requests           | Jev beats Qwen on 27 of 37; Gemma on 37 of 37; 95–99% on IMDB, SST-2, HellaSwag, ARC        | single-author-team, zero-shot, one prompt per dataset (arXiv 2609.37647) |
| Jev vs fast LLMs, System1-Arena (92k questions, 105 tasks) | matches or beats fast closed LLMs; about one-quarter latency                                | arXiv 2610.21244 (2026-10-15)                                            |
| Laya vs Jev, 11 decision points                            | Jev better on 9 of 11, by 10.8–46.0 points                                                  | arXiv 2610.02267                                                         |
| Page latency and cost                                      | 70–500 ms; $0.042/MTok input; "0% type errors" (self-described non-empirical)               | TypeSafe article (vendor)                                                |
| RDM map experiment                                         | 87% vs 66% (map that keeps vs keeps nothing), toy house, simulated days                     | post (no n given)                                                        |
| RDM benchmarks                                             | none; "the benchmarks will come only after a v1 of the module"                              | site                                                                     |
| Hierarchy demo                                             | one replayed query; 8 requests                                                              | site and post                                                            |
| RLM (background)                                           | up to two orders of magnitude beyond context window; RLM-Qwen3-8B 14% vs 0% on OOLONG-Pairs | arXiv 2512.24601 (Zhang, Kraska, Khattab; v1 2025-12-31, v2 2026-01-28)  |

No source reports accuracy, latency, or cost for RDM against a flat classifier or a large model. The post and site say so.

## 12. Closely related published methods

| Method                                               | One line                                                                     | Link                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Recursive Language Models                            | external context; the model calls itself on snippets                         | arxiv.org/abs/2512.24601                                   |
| Hierarchical text classification with black-box LLMs | top-down, level by level prompting; 2025                                     | arxiv.org/abs/2508.04219                                   |
| Zero-shot hierarchical classification (HiEPS)        | verbalize the taxonomy, ensemble prompts; EMNLP 2025                         | github.com/MingxuanXia/HiEPS                               |
| TELEClass                                            | LLM with top-down tree search over candidate classes                         | arxiv.org/abs/2403.00165                                   |
| FrugalGPT                                            | cascade: escalate to the next LLM when a scorer rejects the answer           | arxiv.org/abs/2305.05176                                   |
| Calibrate Before Use                                 | contextual calibration of label-token probabilities                          | arxiv.org/abs/2102.09690                                   |
| LLM option-order sensitivity                         | reordering options moves MCQ accuracy by 13–75 points                        | arxiv.org/abs/2308.11483                                   |
| Typed decision model audit                           | 28 papers; no independent accuracy advantage over label-probability readouts | arxiv.org/abs/2609.32160                                   |
| Beam over clustered corpus (vendor)                  | top 2–3 branches, geometric-mean path score; one 2-level test                | mixpeek.com/guides/agentic-search-over-cluster-hierarchies |

## 13. Synthesis for routing a request to reviewers

**Supported by sources:**

- A small decision model is reliable for narrow, forced choices over a few options (Jev: 95–99% on simple tasks).
- Long input must be cut by code before the model sees it. Fit and outline-by-heading do this.
- Option order and wording move answers. Shuffle options and check held-out data before setting a threshold.

**Shape for the case** (ask held in code; five reviewers; forced choices; "unsure" from probabilities):

```
state  = { ask, outline: codeSplitByHeading(ask), reviewers: [5 names + descriptions] }
questions:
  size      : Choice[ small | section | plan ]        forced, no none
  reviewer  : Choice[ r1..r5 ]                        forced, probabilities kept
tools:
  rate(piece)     -> reviewer Choice on piece; keep p >= max/2, at most KEEP
  split(piece)    -> code cuts by outline, decide what to keep (Fit)
  recurse(part)   -> ask(part, depth + 1)             one level down
stop:  size is small, or depth >= MAX_DEPTH (3), or requests >= budget,
       or the same piece repeats, or no tool selected
unsure: top probability < UNSURE_THRESHOLD (set on held-out cases)
```

**Test first:**

1. Build 30–50 asks labelled by hand with the right reviewers. Run each under all option orders.
2. Measure accuracy and flip rate by order. Set the unsure threshold on held-out cases, not in-sample.
3. Compare a flat five-way Choice over the whole ask against the recursive version, on the same labels, with request counts and latency.

## Sources

- recursivedecisionmodels.com (home, hierarchy, notebook examples outline, triage, fit, filter; slides at /aie-code-sf-2026/) — rendered in browser 2026-11-20
- raw.works/recursive-decision-models/ — post, 2026-10-01 (read in browser, verbatim)
- github.com/rawwerks/dspy/blob/feat/rdm-v0/docs/docs/api/experimental/RDM.md — reference
- github.com/rawwerks/dspy/blob/feat/rdm-v0/docs/docs/diving-deeper/rdm.md — design notes
- github.com/rawwerks/dspy/blob/feat/rdm-v0/dspy/predict/rdm.py, rdm_fit.py, rdm_filter.py, rdm_near.py — source
- typesafe.ai/blog/introducing-system-one-models-and-jev — TypeSafe article (updated 2026-11-03)
- arxiv.org/abs/2512.24601 — Recursive Language Models
- arxiv.org/abs/2610.21244, 2610.18773, 2610.02267, 2609.37647, 2609.32160, 2308.11483, 2102.09690, 2305.05176, 2508.04219
- sean-weldon.com/blog/2026-11-13-... — secondary summary of the talk (not used as primary)
- startuphub.ai (2026-11-11) — secondary summary of the talk
- github.com/software-mansion/runntime — no decision-model content
