# User controls

Use these controls in the published v0.1.0 release.

## Architect

Select **Architect** from OpenCode Desktop's agent list. Describe the feature or change you want. Architect plans the work and requests runtime dispatch when the plan has enough detail.

OpenCode permissions still control native tools and file access. Answer any permission prompt that OpenCode shows.

## Tasks

Open **Tasks** from the session panel menu, or run `/lz-tasks`. Choose **This session** or **Project tasks**. Search tasks and filter by task state.

Use the task details to review its objective, dependencies, worker activity, checks, and result. Filter by **Open**, **Queued**, **Running**, **Blocked**, **Paused**, **Completed**, **Failed**, **Cancelled**, or **All**.

The panel offers **Start** only when a plan can start under the runtime's rules.

## Radar and Trajectory

Open **Radar** from the session panel menu, or run `/lz-radar`, to watch live session activity: each session's role, task, model and effort, current tool calls with their targets and durations, and recent model and tool events. Choose **This session**, **Project**, or **Project · all sessions**. Select a session, call or event to inspect it below the divider, then open its worker, task or trajectory. **Diagnostics** in the actions menu shows the **Map** and **Flow** state chart. Attempt and check history lives in **Trajectory**.

Open **Trajectory** from the session panel menu, or run `/lz-trajectory`, to inspect task attempts, checks, and recorded usage. Choose a task and scope. Select an attempt or check to inspect its details. Task links in other LAZERS panels can open the matching trajectory.

## Models

Open **Models** from the session panel menu, or run `/lz-models`. Use **Assignments** to set the provider, model, and optional variant or effort for a **Shared default**, **Project override**, or **Task override**. LAZERS supports the **UI**, **Systems**, and **Small task / refactoring** personas.

Use **Compare** to inspect task histories, usage, and configured price evidence. Filter by persona or task kind. Estimates can be partial or unknown when usage or prices are missing. A model catalog or price lookup does not start inference.

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
