# LZ-172 connected Desktop preview

2026-11-07. Candidate `ce72ed5576397ba02bb88a868f6d46f13215d9bb`.

Only ignored GUI bundles were staged in canonical `dist/`; source remains unmerged. Rollback bundle: `/private/tmp/lz172-ce72-gui-preview-jqi01e_4`. Native View → Reload refreshed the renderer; the first menu action timed out, then reconnecting and selecting Reload succeeded. Native workers were preserved.

## Observed

- Connected Models loaded actual project comparison data. The prior `undefined.sourceLink` exception did not recur during this walkthrough.
- Model selector changed Kimi to Luna and displayed the OpenRouter catalog reference range, approximately $0.377–$0.719 per accepted task. The displayed qualifier is currently “priced portion”; this is a consumer-copy concern, not permission to misrepresent missing usage as fully priced.
- Clicking Qwen's chart mark selected Qwen and updated its summary to approximately $0.181 per accepted task, using the OpenCode catalog fallback.
- Resizing the native side panel to approximately 340 CSS pixels kept comparison above details. No persistent right-side comparison table appeared.
- Actual screenshots: [wide](artifacts/lz172-ce72-desktop/wide.png), [narrow](artifacts/lz172-ce72-desktop/narrow.png), [selected Luna](artifacts/lz172-ce72-desktop/luna-narrow.png).

## Still fails visual acceptance

- The chart's bottom axis/legend is clipped by the default horizontal splitter at narrow width. Scrolling or resizing may expose it, but the initial composition is not adequate.
- Selected marks can lose their identifying label; other model labels truncate aggressively even with only three model routes.
- “Partial”, “Priced portion only”, repeated “current”, and technical disclosure titles compete with the useful comparison.
- Filter buttons consume two rows at narrow width; spacing and hierarchy remain much heavier than the approved mockup.

Root sent the actual screenshots and these concerns to the native Sol High Architect and requested native Terra High visual review against the approved mockup and latest user steering. Keep material corrections together in the existing LZ-172 worker. Tests and source review alone do not establish visual acceptance. Source integration, native Terra review, final walkthrough and cleanup remain pending.
