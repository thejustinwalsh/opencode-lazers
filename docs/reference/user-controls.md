# User controls

Use these controls in the published v0.1.0 release.

## Architect

Select **Architect** from OpenCode Desktop's agent list. Describe the feature or change you want. Architect plans the work and requests runtime dispatch when the plan has enough detail.

OpenCode permissions still control native tools and file access. Answer any permission prompt that OpenCode shows.

## Tasks

Open **Tasks** from the session panel menu, or run `/lz-tasks`. Choose **This session** or **Project tasks**. Search tasks and filter by task state: **Open**, **Queued**, **Running**, **Blocked / waiting**, **Paused**, **Completed**, **Failed / exhausted**, **Cancelled**, or **All**. The header counts the tasks in the current filter.

The list is flat and ordered by priority; a task's priority number is in its details. Use the chevron to expand a task's dependencies in place. The glyph at the end of a row is its state: an outlined check is accepted, and the filled green check is integrated. **All** lists open work first, then accepted, integrated, failed and cancelled tasks.

Select a task to review its objective, done-when checklist, dependencies, worker activity, checks, and result below the divider. Changing the filter keeps the selection. The panel offers **Start** only when a plan can start under the runtime's rules.

## Radar and Trajectory

Open **Radar** from the session panel menu, or run `/lz-radar`, to watch live session activity. **Monitor** lists each session's role, task, model and effort, state and current tool calls, with workers indented under their Architect. **Map** draws the same sessions as a tree from you to the Architect to its workers. **Flow** shows where the work is going right now: sessions on the left, the models, files and tools they are calling on the right, with a live feed and per-model usage below; select a session or a destination to dim everything else and filter the feed. The task lifecycle diagram is in the ⋯ menu. Choose **This session**, **Project**, or **Project · all sessions**. Select a session, call or event to open its details below the divider, then open its worker, task or trajectory. The connection reads **Live**, **Reconnecting** or **Offline**. Idle sessions are hidden by default; the summary line says how many (`N idle hidden`) and shows them on request, and ⋯ has **Show idle sessions**.

Open **Trajectory** from the session panel menu, or run `/lz-trajectory`, to inspect a task's attempts, tool calls, file activity and checks on one timeline. Long idle stretches are compressed into labelled breaks; hatched marks are recording gaps. Select a mark to see its command, timing and result. **Open task** shows the task in Tasks. Task links in other LAZERS panels can open the matching trajectory.

## Models

Open **Models** from the session panel menu, or run `/lz-models`.

**Compare** plots models by cost and tokens per accepted task from your runs, or by public benchmark and list price under **Benchmark**. Prices come from OpenRouter, OpenCode and models.dev in that order; models.dev needs no key. Public coding scores come from Epoch AI (no key) and, when connected, OpenRouter; the score in use is named on the chart. Epoch AI data is credited as "Epoch AI · CC BY 4.0" with its snapshot date wherever it is shown. Beside each score, "Public benchmark" in the selected model's details lists the benchmark rows and how many benchmark rows matched a catalog model; the names that did not match are one level down. Filter by persona or task kind. Select a model to see its price, results and an **Assign to** button; the estimate basis, runs and the chart's data table are in the disclosures below. A model catalog or price lookup does not start inference.

**Assignments** lists each persona's model and effort. Select a persona to change its model, effort and whether the choice applies to all projects, this project or one task. LAZERS supports the **UI**, **Systems**, and **Small task / refactoring** personas. New workers use the saved route; running workers keep theirs.

## Details pane

Tasks, Trajectory, Models and Radar show the selected item in a pane at the bottom of the panel: it starts collapsed to one header line with the item and its actions. Choosing an item, the chevron, a double-click on that line, or dragging its top edge opens it at the height you last expanded it to; the header stays pinned while only the body scrolls.

## Loading and connection

Every panel shows a placeholder of its layout while it first loads, and offers **Retry** if that takes longer than ten seconds. If the service reconnects, the panel keeps what it last showed, dimmed, under a banner with the time of the last update and **Retry**.

## Settings

Open **Settings → LAZERS** in OpenCode Desktop. Architect, tasks and the panels work without local inference; everything on the page is optional.

### Local inference

Local inference starts off. Turn on **Run local models on this device** to use local features, then select the ones you need:

- **Local questions** for local text answers.
- **System One decisions** for typed local decisions.
- **Task review** for an advisory check before submission. This option needs System One decisions.
- **Dictation** for microphone input.
- **Read aloud** for local speech output.

The section header shows the model's current state. The Omni download uses about 1.6 GB. The D1 download uses about 625 MB. Each model downloads on first use and has a separate cache.

**Keep model loaded** sets how long an idle model stays in GPU memory: **Always**, **1 minute**, **5 minutes**, or **15 minutes**. Turn off local inference to stop local work and release GPU memory. Downloaded models stay on disk until you remove them.

**Voice** chooses the Read aloud voice. **Preview** speaks one sentence in the selected voice.

**Remove** beside **Downloaded models** clears the local model cache. The next local request downloads the files again.

### Provider usage in the session header

**Show usage ring** shows or hides the session-header ring. Choose **OpenRouter** or **OpenCode Go** as the provider. The page shows only that provider's setting: the **Weekly budget** for OpenRouter, or the **Monthly** or **Rolling 5-hour** allowance for Go.

The ring reads provider usage. It does not enforce a budget or change model routing. It is neutral under budget, amber from 80 %, and red at or over budget. The OpenRouter weekly budget sets the display scale only. OpenRouter counts the configured key's credit and BYOK spend from when LAZERS first saw it that week, not account-wide spending. Until there is a reading the ring is dashed and shows no amount.
