# Native observation panel review

2026-10-31 · OpenCode Desktop 2.2.5, canonical LAZERS checkout. Model work ran
through Desktop; read-only SDK inspection and supported location reloads were
used for diagnosis. No fabricated production data.

## Landed and observed

Trajectory artifact `4a518cb` was merged as `9b0dcdc`, Radar `498b0dd` as
`710814a`. Production GUI registration landed in `bc2f7e9` and `9e6ae92`.
Both optional panels appeared in the native extra-panel list and mounted against
the registered observation RPC. These source landings do not finalize the entire
product plan or its cleanup.

- [Radar Timeline](radar-timeline.png) shows real plan `b50a1a71`, including
  recorded projection/speech and Radar/Trajectory execution intervals. Four bars
  are visible together on a shared axis above a horizontal inspector. Terra
  6.1 High reviewed this final stable native capture and passed the shown dark,
  approximately 450 CSS px comparison/layout goal.
- [Radar Flow](radar-flow.png) renders the projected `lazers-task/1` machine,
  not a task DAG. Selecting the visible `running` node changed the single lower
  inspector to that state; possible and recorded transitions remain distinct.
  Terra passed the shown readability/selection cleanup. The full tall graph was
  not visible in this capture.
- [Trajectory](trajectory.png) shows recorded attempt/check data and the selected
  plan check below the horizontal divider. Native keyboard resizing changed the
  split 56 → 61 → 56. Closing and reopening retained the selected `all` plan
  check and split 56. The enlarged marker accepted a semantic native click;
  selection changed the row and inspector. Plan checks show no unrelated worker
  attempt prefix or session link. Terra passed the focused header, selection and
  inspector cleanup in the shown dark panel.

## Repairs from actual observation

`ad97182` prevents plan checks and events without attempt association inheriting
the latest worker. Its fixture-backed regression covers null association,
explicit attempt selection, no-selection fallback and unavailable IDs.

The first native Radar open was blank with renderer `TypeError: Illegal
invocation`. The default scroll-restoration scheduler called a browser method as
an instance method. `dec6088` binds the call correctly; subsequent native opens
mounted the real chart. This was a panel startup error, not an explanation for
the earlier renderer freeze.

Terra's screenshot review drove `dec6088`, `c22af24` and `ee586a6`: full-width
Trajectory objective, compact identity, clear check selection/hit targets,
nonduplicated check inspector, subdued unobserved Flow edges and compact Timeline
execution/check/event tracks. The projection's actual timestamps remain intact.

Ordinary change notifications also created large refresh banners, moving the
lanes during real work. `631b45e` keeps normal refreshes quiet while retaining the
stale state/time tooltip and frozen open-span behavior. Real gaps, disconnection
and failed refreshes still report; the state regression distinguishes contiguous
updates from gaps. The final capture has a green observation indicator and no
refresh banners.

## Verification and remaining coverage

Combined renderer/observation checks passed 35 tests / 219 assertions after the
Radar merge. Subsequent focused panel checks passed 26 / 143; the refresh-state
regression passed 3 / 14. Formatting, lint, strict types and combined production
GUI builds passed at their recorded checkpoints. Later backend changes have
separate validation; these counts are not a claim about all subsequent source.

Unobserved here: alternate themes/fonts, 330 px/short panes, full graph scrolling,
complete reconnect/error interaction, all source/session navigation, and the
entire product plan's merged integration/cleanup. Coincident Timeline points
remain keyboard accessible but may overlap for pointer selection. Unknown cost
and missing timing stay unknown; screenshots do not establish audio quality,
performance guarantees or model rankings.
