# How pine.pmnd.re builds its demos

## Verdict

The homepage demos are **real iframes**. Each one loads the desktop app's own build at `/app/#story=<name>&at=<checkpoint>`. A story is a recording of a session. The page replays it through a stand-in for the app's `window.pine` bridge, so the app draws itself from recorded answers. The iframes are created lazily by the homepage script. The static HTML holds only empty `<div class="win">` containers, which is why a load-time DOM check finds no iframe.

Separately, `reel/` makes the README film (`docs/images/reel.webp`). Those films are DOM-drawn mocks, not iframes, and they are not what the site shows.

```
pine.pmnd.re/                       (homepage: Vite-style bundle, not in this clone)
 └ section.hero / events / code
    └ .shot[data-reel=hero|events|log|code]
       └ .win ── (IntersectionObserver, rootMargin 100%) ──► <iframe class="app" src="/app/#story=hero&at=…">
                                                                 └ /app/index.html  = desktop/ Vite build (base "./")
                                                                      + ./reel.js  (stand-in window.pine, replays story JSON)
                                                                      + app/stories/<name>.json  (recorded session)
 messages: iframe → parent: {reel, type: ready|chapter|pointer|view|end}
```

## 1. What the demos are

- **Markup.** Static HTML holds `div.shot[data-reel]` with an empty `div.win` and a `i.pointer` overlay (live DOM: 4 `[data-reel]` nodes: `hero`, `events`, `log`, `code`; `.win` has 0 children at load). Source: the homepage bundle `https://pine.pmnd.re/assets/index-C9A8u_yl.js`, which contains the `[data-reel]` loop (search the minified file for `[data-reel]`).
- **Iframe creation.** `F(e)` in the bundle creates `iframe.app` with `title="The Pine app"`, `tabIndex=-1`, `inert`, `aria-hidden="true"`, and `src = /app/#story=${reel}${at}`. It is appended into `.win`. Same origin, and no `sandbox` attribute appears in the homepage code.
- **Lazy start.** `new IntersectionObserver(…, {rootMargin: "100% 0px"})` creates the iframe one viewport before it is visible. A second observer with `threshold: .3` toggles playback: play when visible, pause when not (`P()?.play()` / `P()?.pause()`).
- **Animation source.** The app itself animates. Recorded `tl` events are replayed with real timing. `/app/reel.js` (24,621 chars, served at `https://pine.pmnd.re/app/reel.js`) defines the clock. It overrides `window.Date` (`ReelDate`) and `localStorage`, answers `window.pine` calls from recorded `calls`, and fires the scripted user actions (`act`) on the page's real controls.
- **Pointer.** `reel.js` posts `pointer` messages (`x, y, down, off`). The homepage moves the `.pointer` overlay with a transform and adds the `click` class for the ripple (CSS `.pointer.click b` ripple, `.pointer.click svg` press).
- **Camera.** `reel.js` posts `view` messages with an x position. The homepage eases `--xc` with an exponential approach (`r(m,t,…,180)`) and translates the iframe by `--xv`.
- **Chapters and sequencing.** The step list `ol.show-list li[data-show]` (for example `make, tell, wake, due` in the hero) is driven by `chapter` messages: `{name, ms}`. The active step's progress bar animates with `tick var(--show-ms)`, which is set from `ms`. Clicking a step calls `seek(name)` on the iframe (`window.reel.seek`).
- **Looping.** On `end`, the homepage waits 350 ms and advances to the next chapter (`R()`) if the shot is marked `data-apart`, otherwise it reloads the iframe from the story start (`F()`).
- **Reduced motion.** The homepage script reads `matchMedia("(prefers-reduced-motion: reduce)")`. If it matches, the `moves` class is not added (no scroll-driven transforms). Autoplay is disabled (`N = () => !e.matches || M`), and `end` does not loop (`if(e.matches) return`). The iframe still loads, paused on the first chapter, and advances only when the user clicks a step. The site CSS contains no `prefers-reduced-motion` rule (checked in the CSS dump: 0 matches).
- **Scroll parallax.** A scroll listener sets `--v` on `[data-drift]`, `.crop`, `.shot`, `.hatch .fill` and `.stats li` with exponential smoothing (`n=110`). CSS turns these into transforms (`.moves .shot { transform: translateY(...) }`). Source: the homepage bundle.

## 2. Where the source lives and how it is produced

| Piece                                                                                                     | Where                                                                         | Produced by                                                                                    | Status in this clone                                                                              |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Homepage HTML/CSS/JS                                                                                      | `pine.pmnd.re/` (`/assets/index-C9A8u_yl.js`, `index-BQ0u4Y45.css`)           | unknown                                                                                        | **not in clone** (no `site/` directory; `git ls-files` has no site paths)                         |
| Desktop app (`/app/`)                                                                                     | `desktop/` (`index.html` → `src/main.tsx`; `vite.config.ts` has `base: "./"`) | `desktop/scripts/build.mjs` runs Vite into `dist/`                                             | in clone; the deployed `/app/` build adds `reel.js` and stories, which the clone's build does not |
| `reel.js` (stand-in `window.pine`, replay engine)                                                         | `/app/reel.js`                                                                | the comment names `scripts/capture.mjs` and `site/src/main.ts` as the producer and page        | **not in clone**                                                                                  |
| Story JSON `app/stories/<name>.json` (`epoch`, `state`, `tl`, `calls`, `pool`, `tabs`, `invoke`, `media`) | `https://pine.pmnd.re/app/stories/hero.json` (82,743 chars)                   | `scripts/capture.mjs`, per the `reel.js` header comment: captured from a recorded real session | **not in clone**                                                                                  |
| Story media (pictures the daemon served)                                                                  | beside the story JSON                                                         | the capture                                                                                    | not measured                                                                                      |

Reading of the capture: the header of `reel.js` says the app's daemon answers were recorded once (`scripts/capture.mjs`), and the page replays them. So the demo is a recording of real app behaviour, not a hand-written mock. This is inferred from the header comments; the capture script itself is absent.

Separate pipeline, the README film (`reel/`):

| Step              | Path:line                                                                                                                                                   | What it does                                                                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Script            | `reel/story-front.js:1-13`                                                                                                                                  | the 28-second README film; `story.js` (main film), `story-scans.js` (bills) are the others                                                                                   |
| Drawing           | `reel/reel.html:419-427`, `reel/engine.js:1-4`                                                                                                              | DOM and character-grid mocks; `renderAt(t)` is a pure function of time                                                                                                       |
| Real app pictures | `reel/app-shots.mjs:1-14`                                                                                                                                   | launches Electron from `desktop/` with `_electron` (playwright-core), a scripted model server (`baseline/tests/mock.mjs`), and writes `reel/assets/front/*.png` + `shots.js` |
| Frame render      | `reel/render.mjs:16` (playwright-core chromium), `:29` (`page.goto file://…`), `:62` / `:78` (one screenshot per frame), `:74` (`ffmpeg … libx264 -crf 17`) | frame-by-frame capture piped to ffmpeg                                                                                                                                       |
| Output            | `reel/README.md` (`--story front --webp`); `docs/images/reel.webp` (3.9 MB, committed by hand: "copied to")                                                 | animated WebP at the top of the README                                                                                                                                       |

## 3. Does the demo reuse the real app's CSS and components

Yes, for the site demo. The iframe runs the desktop app's own build (`desktop/` Vite output, `base "./"`), so its CSS and React components are the product's. Drift is limited to the recorded data and the stand-in bridge.

For the README film, no. `reel.html` draws its terminal and windows with its own CSS and `engine.js`. Only the desktop-app shots (`assets/front/`) are real: they come from `app-shots.mjs`, which starts the real app.

Relevant to the drift question: `desktop/src/*.stories.tsx` (Storybook, published to Chromatic per `.github/workflows/chromatic.yml`) is a separate component-level review, not the demo source.

## 4. Embedding, isolation, sizing, cost

- **Isolation:** a plain same-origin iframe, `src` on `pine.pmnd.re/app/`. Inert and `aria-hidden` so it takes no focus. The page uses `postMessage` with an origin check (`t.origin === location.origin` and `r.reel === name` and `t.source === iframe.contentWindow`). No shadow DOM and no `srcdoc`.
- **Sizing:** the `.shot` box has the intrinsic size in CSS vars (`--w`, `--h`, optional `--wp/--hp` for a narrow variant). `ResizeObserver` sets `--s = clientWidth / --wv`. The iframe is `width: calc(var(--win)*1px)` and `transform: scale(var(--s))`, so the real app renders at its design width and is scaled down. Aspect ratio comes from `aspect-ratio: var(--wv) / var(--ch,var(--hin))`.
- **Cost measured (characters, approx bytes):** homepage JS 5,988; homepage CSS 17,073; `reel.js` 24,621; `/app/` app JS 2,903,751 (the desktop bundle, one per visit, cached after the first iframe); hero story JSON 82,743. Story media and the Cloudflare beacon were not measured.
- **Cost note:** each demo iframe loads the full desktop app (about 2.9 MB of JS), not a small widget.

## 5. How the site is built and deployed

- Homepage: the bundle is Vite-style output (`index-<hash>.js` under `/assets/`, a `modulepreload` polyfill block, `<script type="module" crossorigin>`). The site's own source is not in this clone, so this is inferred, not confirmed. Framework: likely Vite. Bundler: Vite (inferred).
- Hosting: `static.cloudflareinsights.com` beacon on the page; a Cloudflare host is likely. No deploy workflow for the site exists in `.github/workflows/` (`release.yml` has 0 matches for cloudflare/pages/wrangler/site; `web-preview.yml` deploys only the web client's relay Worker, with `workers_dev: false`, `web/relay/wrangler.jsonc:4-10`).
- The web client (`web/`) is a different deployment: `web/relay` Worker serving `web/dist` (`web/relay/src/site.ts:1-6`, `web/scripts/build.ts:1-3`). Its `/app` route is not used by the site. Its iframes are the bridge's `/page/` frame, unrelated to the demos.

## 6. Recipe: reproduce this for your own app panels

1. Build the real UI as its own static entry (`/app/`), with relative asset paths (Vite `base: "./"`), so it can run framed or standalone.
2. Record one real session: capture the app's external answers (API/daemon responses) and user actions with timestamps into a JSON story file.
3. Ship a tiny stand-in (`reel.js`, about 25 KB) in the demo page that replaces the app's I/O bridge. It answers calls from the recording, replays user actions on the real controls, and drives a fake clock (`Date`, `setTimeout`).
4. The stand-in posts `{ name, type: ready|chapter|pointer|view|end }` to `parent` with a `location.origin` check.
5. On the host page, render `<div class="win"><!-- iframe injected later --></div>` per panel, with intrinsic size CSS vars.
6. Inject the iframe with an `IntersectionObserver` (`rootMargin: "100%"`) so it loads one viewport early.
7. Pause and resume with a second observer (`threshold: .3`), and pause the story when hidden.
8. Scale the iframe with `ResizeObserver`: `transform: scale(container / designWidth)`.
9. Honour `prefers-reduced-motion`: load the first frame, do not autoplay, and advance only on click.
10. Drive the step list from `chapter` messages, and let a click call `seek(name)` on the iframe.

## Could not determine

- Whether the live demos actually inject their iframes on scroll. The browser pane has `innerWidth = 0` (hidden pane), so `IntersectionObserver` never fired. The "no iframe" result is consistent with the lazy design, not proof of its absence. A visible viewport check was not possible.
- The source of the homepage (`pine.pmnd.re/`), its framework, and its hosting platform. Not in the clone, no deploy workflow.
- The source of `/app/reel.js` and the story JSON: `scripts/capture.mjs`, `site/src/main.ts` and `app/stories/` are named in the bundled code but absent from the clone (single commit, no history for those paths).
- Whether the production `/app/` build is the clone's `desktop/` build with extra files, or a separate build. Inferred from matching `base "./"` and the `./assets/` paths, not confirmed.
- Story media and the Cloudflare beacon cost, and the exact `reel.js` story schema beyond the header comment.
- Whether `docs/images/reel.webp` matches the latest `story-front.js` render (it is committed by hand).
- Exact `prefers-reduced-motion` behaviour inside the replayed app (only the outer `reel.js` logic was read).
- Exact line numbers in the minified homepage bundle (cited by search token, not line).

## Method

- Clone (read only, nothing run or built): `find`/`grep`/`sed` inventory of `reel/`, `web/`, `desktop/`, `docs/images/`, `scripts/`, `.github/workflows/`.
- Live site: read in the Browser pane via in-page `fetch` of `/assets/index-C9A8u_yl.js`, `/assets/index-BQ0u4Y45.css`, `/app/`, `/app/reel.js`, `/app/stories/hero.json` at `https://pine.pmnd.re`. These are the same bytes WebFetch would return; WebFetch itself was not used. DOM inspected in place of view-source.
