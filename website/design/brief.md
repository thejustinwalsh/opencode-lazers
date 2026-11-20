# LAZERS website

Build and verify a static Preact and Vite site inside website/. Use StyleX for styling and confirm the production build extracts the CSS. Use @chenglou/pretext for text wrapping and native scrolling with CSS scroll-driven animations for scroll motion (no smooth-scroll library). Read the four supplied PNGs with Claude's image reader. magazine-modern.png is the target for palette, scale and layout. magazine-original.png shows the editorial density and attitude Justin picked. Use cat.png and marks.png as separate layers. Optimize and slice production raster assets as needed without losing pixel edges or alpha.

Make the opening view feel like a 1990s console magazine cover laid out for the modern web. Use a large angled LAZERS display wordmark, strict editorial alignment, cool ivory, deep ink indigo, periwinkle, selective halftone, and cyan and magenta accents. Frame the giant cat low on the left. Use a compact navigation with working Docs, GitHub and Install links. Use real HTML for typography and controls. Write product copy from ../README.md and ../docs. The mockup's editorial filler is visual reference only. Lead with the product purpose, show how Architect, Scheduler, Radar and Trajectory fit together, and end with a practical installation link. Use Roadmap or Models only if they provide concrete value and the current docs support the claim. Every section should add new information. Keep the product name and public links accurate.

When the hero enters, fire several short paired eye beams. Draw them procedurally with CSS transforms or canvas. Measure pupil anchors in the cat asset and use normalized coordinates so origins track the sprite at different sizes. Position beams behind readable copy, then trigger one brief volley as each section enters view. Avoid repeated firing around a threshold. Keep scrolling native (no script-driven smooth scroll), with restrained CSS scroll-driven parallax; keep native anchors and keyboard navigation functional. Run expensive work only while its section is visible. Use subtle localized motion and no sustained flashing. Honor reduced motion with a readable static composition.

Use Pretext's prepareWithSegments and layoutNextLine for the feature intro. Compute a safe width for each line from the displayed cat contour and reuse prepared text across layout updates. The original text must remain available to assistive technology and when enhanced layout cannot run. On a narrow screen keep the cat and beams in the design but protect wordmark, navigation and CTA. Verify readability, wrapping, beam origins, scroll triggers and keyboard navigation at approximately 390 and 1440 px and with reduced motion. Use Portless for any local preview per repo instructions. Keep the build portable and output website/dist. Keep changes inside website/, report build results and screenshot paths, and leave publication to the parent session.

Primary references

- https://github.com/chenglou/pretext/blob/main/pages/demos/dynamic-layout.ts
- https://stylexjs.com/

## Masthead and scale

Justin approved the modernized magazine direction. Treat the mockup zoom and crop as composition placeholders. Size the artwork for the browser viewport and preserve the visual hierarchy at each width.

The LAZERS masthead is a required design element. Match the reference's forward slant, broad heavy letterforms, indigo outer keyline, ivory inner keyline, and magenta halftone rising from the baseline. Start with live text in a heavy display face such as Archivo Black and use CSS for the skew, outlines, offset print shadow, and clipped halftone. If live text cannot reproduce the reference cleanly, use a separate transparent wordmark asset and retain an accessible LAZERS heading. Keep the title independent from the cat, beams, and backdrop. Inspect it at desktop and mobile widths and make sure the edges stay crisp and every letter fits.

## One scrolling page

Build a single scrolling page with creative, scroll-driven transitions between sections.
