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

Open **Radar** from the session panel menu, or run `/lz-radar`, to inspect task and session activity. Choose **This session** or **Project**. Switch among **Map**, **Flow**, and **Timeline**.

Open **Trajectory** from the session panel menu, or run `/lz-trajectory`, to inspect task attempts, checks, and recorded usage. Choose a task and scope. Select an attempt or check to inspect its details. Task links in other LAZERS panels can open the matching trajectory.

## Models

Open **Models** from the session panel menu, or run `/lz-models`. Use **Assignments** to set the provider, model, and optional variant or effort for a **Shared default**, **Project override**, or **Task override**. LAZERS supports the **UI**, **Systems**, and **Small task / refactoring** personas.

Use **Compare** to inspect task histories, usage, and configured price evidence. Filter by persona or task kind. Estimates can be partial or unknown when usage or prices are missing. A model catalog or price lookup does not start inference.

## Local inference

Open **Settings → LAZERS** in OpenCode Desktop. Local inference is optional and starts off by default. The task workflow works when local inference is off.

Turn on **Enable local WebGPU inference** to use local features. Select the features you need:

- **Local questions** for local text answers.
- **System One decisions** for typed local decisions.
- **Task review** for an advisory check before submission. This option needs System One decisions.
- **Dictation and transcription** for microphone input.
- **Read aloud and speech** for local speech output.

The Omni download uses about 1.6 GB. The D1 download uses about 625 MB. Each model downloads on first use and has a separate cache.

Choose when LAZERS unloads an idle model: **Never**, **After 1 minute**, **After 5 minutes**, or **After 15 minutes**. Turn off local inference to stop local work and release GPU memory. Downloaded models stay on disk until you remove them.

Use **Remove downloaded models** to clear the local model cache. The next local request downloads the files again.

## Provider budget

Open **Provider budget** in OpenCode settings to show or hide the session-header indicator. Choose **OpenCode Go** or **OpenRouter** as the source. For Go, choose **Monthly** or **Rolling 5-hour** allowance. For OpenRouter, set the weekly display target.

The indicator reads provider usage. It does not enforce a budget or change model routing. The OpenRouter weekly target sets the display scale; it does not enforce a limit. OpenRouter shows configured-key credit and BYOK counters. It does not show account-wide spending. Missing earlier usage stays unknown.
