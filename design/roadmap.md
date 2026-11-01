# LAZERS roadmap

LAZERS builds itself through OpenCode Desktop. The goal is accepted software
changes with clear intent, efficient execution and little manual intervention.

## 1. Tasks, Radar and Trajectory

Tasks needs explicit state filtering alongside Session/Project scope, including
completed, failed and cancelled work. Old tasks should open their own trajectories
with their recorded attempts. Keep the focused Linear-inspired list, grouping,
dependencies and compact task references.

Radar is the live operational view: scheduler components, active native sessions
and agents, the models/effort they use, their states, and message/data flow.
Tasks/plans provide work context. Use C4-style SVG and elkjs layout, informed by
gh-wat-dis. Show LAZERS-managed sessions by default, with optional other sessions
inside the selected scope. Actual activity should animate without constantly
moving the layout. Keep details below the visualization in the narrow panel,
using OpenCode fonts and theme.

Trajectory history should remain usable while live events arrive. Existing
lifecycle, trajectory privacy and renderer responsiveness defects remain open;
local inference stays enabled. Current findings are in the delivery audit.

## 2. Personas, models and measurement

Each task carries a persona/agent. Start with UI, Systems and Small task/refactoring
implementors. The persona stays with the task; model/effort is resolved at dispatch
from a live hierarchy of shared defaults and project/task overrides. Running
attempts retain their chosen route and history. Future selection rules can use
observed performance, prices, promotions and other user criteria.

A Models panel edits these mappings and shows a model database combining native
OpenCode/Go metadata, OpenRouter prices/benchmarks and our observed results. Show
tables and Pareto comparisons by task class/persona, including tokens, cost,
acceptance, rework, elapsed time and sample size. Distinguish external evidence,
observations and projections, and link results to contributing trajectories.

Scheduler and Trajectory own measurement through integration, including failed
attempts, repairs and attributable Architect/review effort. OpenRouter average
market pricing is always the fallback index for subscription model/effort usage.
Keep dated price/averaging basis and actual charges/allowances separate.

## 3. Plan evolution and research

Users revise task goals and acceptance through Architect conversation. Preserve
previous specifications and attempts; reconcile affected dependencies and active
work while independent work continues. Tasks shows the current specification and
history; a direct specification editor is later work.

Architect should be able to delegate focused code investigation and current-web
research using native agents and reusable repository context. Guided model
configuration uses the same mappings as Models. Useful source findings and
pitfalls should carry into relevant later work without growing agent prompts.

## 4. Complete usable release

A complete usable release belongs in the public repository. Continue dogfooding
on other machines and real tasks; no announcement is planned.

The installed package must work without this development checkout, preserve work
and settings across supported restarts/upgrades, and have a supported backup and
restore path. Finish versioning, license/notices, host compatibility and setup/
upgrade documentation. Keep the one-plugin distribution without a separate LAZERS
daemon or inference server.

## References

- Research and decisions: `.agents/docs/phase-review-plan.md`
- Current delivery/defects: `.agents/docs/production-audit-and-next-phases.md`
  and `.agents/docs/evidence/architect-context-lifecycle/review.md`
- Radar prior art: https://github.com/thejustinwalsh/gh-wat-dis
- Model/persona research: `.agents/docs/implementor-profiles.md`
  and `.agents/docs/research/phase-planning/models.md`
