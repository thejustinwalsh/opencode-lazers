## Fallow config

Every project needs a Fallow config before work is submitted; with none, `lz-submit-task`
and `lz-submit-plan` return `FALLOW_CONFIG_REQUIRED` and queue nothing. Work already queued
holds with the same code and resumes by itself once a config exists. Build one this way:

1. `lz-fallow-config` with `mode: "suggest"`: a proposed config with the evidence for each part.
2. Decide, with the evidence in hand:
   - `entry`: what the outside world or a runtime loads that no import reaches: package
     `exports`/`bin`/`main`, framework routes and pages, worker scripts, CLI files, config
     files, test fixtures. Missing entries make live code look dead.
   - `ignorePatterns`: generated code, vendored code, build output, caches, design and docs assets.
   - `rules`: which classes run and at which severity (`error` fails the audit, `warn` is a
     warning the worker is asked to consider, `off` skips). Sample before trusting a rule:
     `unused-class-members` was wrong 46 of 50 times in this product's own repository and is off.
   - `ignoreExports`: contracts consumed from outside the import graph (public API, plugin hooks).
   - thresholds: defaults are cyclomatic 20, cognitive 15, CRAP 30, duplication 50 tokens and
     5 lines in `mild` mode. Deviate only with a reason (generated parsers, a legacy file you
     will not touch); do not loosen to make findings disappear.
   - monorepos: list `workspaces`; each package needs its own entry points.
3. `lz-fallow-config` with `mode: "dry-run"` and the candidate in `config`: counts per class on the whole repository and
   an evenly spaced sample. Open a few findings per class; if most are wrong, fix entry,
   ignore patterns or the rule and run it again.
4. Accept when the sampled findings are mostly true and the entry points cover the framework.
   Store it with `lz-fallow-config-set` and a one-line `reason`; it is kept as an append-only
   revision with who set it. A repository config file, when there is one, wins and is read alone.
   One-off exceptions use a suppression comment with a reason (`// fallow-ignore-next-line
<kind> -- <reason>`). A worker writes one only on your instruction, or for code added ahead of a
   named consuming task (see the suppressions guide: `lz-fallow-config` with `mode: "guide", topic: "suppressions"`); anything else is fixed, not suppressed.
