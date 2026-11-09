import { build } from "vite"
import solid from "vite-plugin-solid"
import { fileURLToPath } from "node:url"

// Isolated visual fixture; never connects to providers or changes the installed plugin's stores.
const outDir = fileURLToPath(new URL("../../node_modules/.cache/budget-visual", import.meta.url))
await build({
  configFile: false,
  resolve: { conditions: ["browser", "development", "module"] },
  plugins: [solid()],
  build: {
    outDir,
    emptyOutDir: true,
    lib: {
      entry: fileURLToPath(new URL("./dom-entry.tsx", import.meta.url)),
      formats: ["es"],
      fileName: "fixture",
    },
    rolldownOptions: { output: { codeSplitting: false } },
  },
})
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Budget widget · isolated review</title><style>
*{box-sizing:border-box}body{margin:0;background:#e7e7e7;font:13px system-ui;color:#333;padding:24px}h1{font-size:18px;font-weight:500}p{max-width:780px;line-height:1.5}.grid{display:grid;grid-template-columns:repeat(2,360px);gap:20px}.case{width:360px;border-radius:10px;padding:12px;background:var(--background-base);color:var(--text-base)}.case h2{font-size:13px;font-weight:500;margin:4px 0 12px}.light{--background-base:#fff;--surface-base:#f6f6f6;--surface-base-hover:#eee;--text-base:#303030;--text-weak:#666;--icon-base:#666;--icon-warning-base:#98722f;--icon-critical-base:#b25c5c;--border-weak-base:#ddd;--border-selected:#555}.dark{--background-base:#171717;--surface-base:#222;--surface-base-hover:#303030;--text-base:#ddd;--text-weak:#aaa;--icon-base:#aaa;--icon-warning-base:#b69b62;--icon-critical-base:#c17b7b;--border-weak-base:#444;--border-selected:#aaa}.fixture-header{display:flex;align-items:center;gap:4px;min-width:0;border-bottom:1px solid var(--border-weak-base)}.fixture-header>span:first-child{flex:1;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.fixture-tooltip{position:relative}.fixture-tooltip:focus-within:after,.fixture-tooltip:hover:after{content:attr(data-tooltip);position:absolute;z-index:5;right:0;top:40px;width:300px;white-space:normal;padding:10px;background:var(--surface-base);border:1px solid var(--border-weak-base);border-radius:6px;line-height:1.5;color:var(--text-base)}.case .lazers-budget-settings{padding:12px 0}.case:not(.settings) .lazers-budget-settings{display:none}@media(max-width:780px){.grid{grid-template-columns:360px}body{padding:12px}}
</style></head><body><h1>Provider budget · rendered fixture</h1><p>Real widget and settings; isolated mock host tooltip/switch and representative theme tokens. No installed settings or provider access. Asterisk means configured-key spend since an observed baseline, not full-week/account spend.</p><div class="grid" id="grid"></div><script type="module">
import { harness } from '/fixture.js';
const apis=[]; window.budgetFixtures=apis;
for(const [name,theme,settings,state] of [
 ['Go · monthly 60%','light',{provider:'go'},null],
 ['Go · rolling over 100% · compact','dark',{provider:'go',mode:'rolling'},'compact'],
 ['OpenRouter · nonzero tracked credit + BYOK','light',{provider:'openrouter'},'tracked'],
 ['OpenRouter · nonzero tracked credit + BYOK','dark',{provider:'openrouter'},'tracked'],
 ['OpenRouter · first observation','light',{provider:'openrouter'},'unknown'],
 ['Settings · keyboard and 360px width','dark',{provider:'go'},'settings']
]) { const card=document.createElement('section');card.className='case '+theme+(state==='settings'?' settings':'');card.innerHTML='<h2>'+name+'</h2>';document.querySelector('#grid').append(card);const root=document.createElement('div');card.append(root);const api=harness(root);apis.push(api);if(state==='tracked')api.setUsage({...api.unavailable(),status:'available',creditUSD:120.4,byokUSD:60.2,coverageStart:Date.now()-3600000,observedAt:Date.now(),reason:'Configured key only; earlier weekly usage unknown.'});if(state==='unknown')api.setUsage(api.unavailable('Tracking from this observation. Earlier weekly usage unknown.'));api.setSettings({...settings,enabled:true});if(state==='compact')api.setCompact(true);}
</script></body></html>`
const server = Bun.serve({
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3000),
  fetch(request) {
    return new URL(request.url).pathname === "/fixture.js"
      ? new Response(Bun.file(`${outDir}/fixture.js`), {
          headers: { "Content-Type": "text/javascript" },
        })
      : new Response(html, { headers: { "Content-Type": "text/html" } })
  },
})
console.log(`Budget fixture ready: ${process.env.PORTLESS_URL ?? server.url}`)
