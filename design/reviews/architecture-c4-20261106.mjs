// Rebuild offline diagrams: bun design/reviews/architecture-c4-20261106.mjs
// Uses the repository's pinned elkjs 0.12.1; generated HTML needs no runtime dependency.
import ELK from "elkjs/lib/elk.bundled.js"
import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const directory = dirname(fileURLToPath(import.meta.url))
const elk = new ELK()
const node = (id, title, owner, detail, source = "") => ({ id, title, owner, detail, source })
const edge = (from, to, label, async = false) => ({
  from,
  to,
  label: `${async ? "ASYNC" : "SYNC"} · ${label}`,
  async,
})
const views = [
  {
    id: "context",
    title: "1 · System context",
    note: "LAZERS is one plugin package hosted inside OpenCode. This view shows responsibility, not separate deployable daemons.",
    nodes: [
      node("user", "Developer", "person", "Owns intent, authorization and human decisions"),
      node(
        "lazers",
        "LAZERS plugin",
        "lazers",
        "Compiles intent; durable execution policy; product panels",
        "src/index.ts; src/gui.tsx",
      ),
      node(
        "host",
        "OpenCode 2.2.5",
        "native",
        "Service, Desktop, native sessions, tools and provider access",
        ".agents/docs/opencode-api.md",
      ),
      node(
        "repo",
        "Repository + Git",
        "data",
        "Source, commits, checks and native managed worktrees",
      ),
      node(
        "execution",
        "Configured model providers",
        "external",
        "Remote inference via OpenCode; exact recorded route",
      ),
      node(
        "pricing",
        "OpenRouter catalogs",
        "external",
        "Published model, benchmark and endpoint price evidence",
      ),
      node(
        "models",
        "Hugging Face model files",
        "external",
        "Pinned local model assets, downloaded and verified",
      ),
    ],
    edges: [
      edge("user", "lazers", "intent / panels"),
      edge("lazers", "host", "public V2 SDK / RPC", true),
      edge("host", "lazers", "hooks / events", true),
      edge("lazers", "repo", "Git subprocess"),
      edge("lazers", "repo", "verification subprocess", true),
      edge("host", "execution", "native inference", true),
      edge("lazers", "pricing", "read catalogs only", true),
      edge("lazers", "models", "download local weights", true),
    ],
  },
  {
    id: "containers",
    title: "2 · Containers & data ownership",
    note: "Blue = OpenCode-owned; purple = LAZERS-owned. LAZERS components run in existing service, renderer and main processes; arrows identify transport and timing.",
    nodes: [
      node(
        "service",
        "LAZERS server plugin",
        "lazers",
        "Effect setup, TaskRuntime, native tools and read RPC",
        "src/index.ts",
      ),
      node(
        "native",
        "OpenCode service",
        "native",
        "Sessions, native agents, tools, permissions, events, worktrees",
      ),
      node(
        "renderer",
        "LAZERS Desktop window",
        "lazers",
        "Solid panels, settings, local inference and audio",
        "src/gui.tsx",
      ),
      node(
        "main",
        "LAZERS Electron main",
        "lazers",
        "Model file/cache lease, capture and ELK worker IPC",
        "src/webgpu/main.ts; src/radar/layout-main.ts",
      ),
      node(
        "sqlite",
        "Plugin tasks.sqlite",
        "data",
        "Canonical task/plan/attempt/effect/outcome/progress records",
      ),
      node(
        "hostdb",
        "OpenCode persistence",
        "native",
        "Native session/inbox/log/model/permission facts; public APIs only",
      ),
      node(
        "storage",
        "Native plugin / GUI storage",
        "data",
        "Feature settings, lease retirement, view preferences",
      ),
      node(
        "disk",
        "Plugin files + Git",
        "data",
        "Context snapshots, receipts, cached weights, artifacts, worktrees",
      ),
      node(
        "remote",
        "Catalog & model asset sources",
        "external",
        "OpenRouter market evidence; Hugging Face model weights",
      ),
    ],
    edges: [
      edge("renderer", "service", "typed plugin RPC", true),
      edge("service", "renderer", "RPC invalidations + broker jobs", true),
      edge("service", "native", "public host SDK", true),
      edge("native", "service", "native hooks / events", true),
      edge("service", "sqlite", "Bun SQLite transaction"),
      edge("native", "hostdb", "native persistence"),
      edge("renderer", "main", "typed ctx.main IPC", true),
      edge("main", "renderer", "lease / file chunks / layout", true),
      edge("service", "storage", "plugin storage settings", true),
      edge("main", "storage", "durable cache lease"),
      edge("renderer", "storage", "GUI preference stores"),
      edge("service", "disk", "context / receipts / Git"),
      edge("main", "disk", "disk model cache", true),
      edge("service", "remote", "GET price catalogs", true),
      edge("main", "remote", "GET pinned weight files", true),
    ],
  },
  {
    id: "service",
    title: "3 · Service components & native extensions",
    note: "TaskRuntime owns state; native sessions own execution facts. Separate histories and projections retain provenance. Recovery handoff library is currently unregistered, so it has no runtime arrow.",
    nodes: [
      node(
        "bootstrap",
        "Effect plugin bootstrap",
        "lazers",
        "Acquires repository / guards / registrations; releases in scope",
        "src/index.ts:32",
      ),
      node(
        "commands",
        "Task / plan command tools",
        "lazers",
        "Permission checks; proposal/admission/version/idempotency",
        "src/tools.ts; src/runner/tools.ts",
      ),
      node(
        "scheduler",
        "Shared scheduler",
        "lazers",
        "One process timer; one project drain; SQLite lease fencing",
        "src/runner/scheduler-coordinator.ts; src/runner/store.ts",
      ),
      node(
        "runtime",
        "TaskRuntime + pure XState",
        "lazers",
        "Admission, dispatch, verification, repair, ownership, cleanup",
        "src/runner/runtime.ts; src/runner/machine.ts",
      ),
      node(
        "adapter",
        "Native host adapter",
        "lazers",
        "Public session/inbox/log/worktree client; explicit unknowns",
        "src/runner/native.ts; src/runner/host.ts",
      ),
      node(
        "sessions",
        "Native sessions / agents / inbox",
        "native",
        "Architect + implementor definitions; real worker turns",
        "src/architect.ts; src/runner/roles.ts",
      ),
      node(
        "tools",
        "Native tools + Code Mode",
        "native",
        "Coding/read/edit/shell/LSP; permissions; no worker delegation",
        "src/runner/roles.ts; src/context/tools.ts",
      ),
      node(
        "eventbus",
        "Native hooks / event stream",
        "native",
        "Prompt/tool/retry/idle hooks and filtered session events",
        "src/progress/native.ts",
      ),
      node(
        "worktrees",
        "Native worktrees / locations",
        "native",
        "Create/list/remove(force:false); positively cleaned cache eviction",
        "src/runner/native.ts",
      ),
      node(
        "catalog",
        "Native model / integration access",
        "native",
        "Model catalog and configured OpenRouter credential resolution",
        "src/runner/catalog.ts; src/models/source-refresh.ts",
      ),
      node(
        "records",
        "TaskRepository / RunnerStore",
        "data",
        "Immutable TaskSpec; current nodes + append-only history; effect/outbox journals",
        "src/storage.ts; src/runner/store.ts",
      ),
      node(
        "checks",
        "Artifact / verification activities",
        "lazers",
        "Git artifact, subprocess checks, acceptance and retained operations",
        "src/runner/artifacts.ts; src/runner/retained-verification",
      ),
      node(
        "progress",
        "Durable progress recorder",
        "lazers",
        "Hook + event + recovery facts deduplicated by source identity",
        "src/progress/recorder.ts; src/progress/reconstruction.ts",
      ),
      node(
        "context",
        "Repomix context index",
        "lazers",
        "Explicit refresh; workspace snapshots; permission-filtered reads",
        "src/context/index.ts",
      ),
      node(
        "pricing",
        "Models / mappings / valuation",
        "lazers",
        "Task > project > shared route; ordered market evidence; pinned read views",
        "src/models/service.ts; src/models/decision-read.ts",
      ),
      node(
        "read",
        "Tasks / Observability read services",
        "lazers",
        "Scoped projections, current activity, trajectory, Radar",
        "src/tasks/rpc.ts; src/observability/read.ts",
      ),
      node(
        "publish",
        "Invalidation publication",
        "lazers",
        "Shared Tasks publisher; per-location Observability trackers",
        "src/database-events.ts; src/observability/rpc.ts",
      ),
      node(
        "broker",
        "Default-location inference broker",
        "lazers",
        "Location forwarding to one renderer mailbox/settings authority",
        "src/webgpu/server.ts; src/webgpu/broker.ts",
      ),
      node(
        "recovery",
        "Recovery progress journal",
        "data",
        "Trigger-fed change history; consumer API exists, no production consumer",
        "src/recovery/journal.ts",
      ),
      node(
        "handoff",
        "Structured handoff library",
        "inactive",
        "Request/draft/review/finalization stores; not registered by bootstrap",
        "src/recovery/handoff",
      ),
    ],
    edges: [
      edge("bootstrap", "commands", "register"),
      edge("bootstrap", "scheduler", "register project drain"),
      edge("commands", "runtime", "validated command", true),
      edge("scheduler", "runtime", "tick + lease heartbeat", true),
      edge("runtime", "records", "atomic state / effect intent"),
      edge("runtime", "adapter", "journaled native operation", true),
      edge("adapter", "sessions", "create/read/prompt/inbox/archive", true),
      edge("sessions", "tools", "native tool execution", true),
      edge("adapter", "worktrees", "native worktree lifecycle", true),
      edge("runtime", "checks", "run check / verify artifact", true),
      edge("checks", "records", "bound receipt / evidence"),
      edge("eventbus", "progress", "facts / reconstruction", true),
      edge("progress", "records", "deduplicated progress write"),
      edge("records", "recovery", "SQLite trigger change fact"),
      edge("context", "records", "snapshot/publication pointers"),
      edge("tools", "context", "authorized focused reads", true),
      edge("catalog", "pricing", "catalog / credential evidence", true),
      edge("pricing", "records", "route mappings + evidence snapshots"),
      edge("runtime", "pricing", "freeze exact dispatch route"),
      edge("read", "records", "read-only snapshot"),
      edge("read", "adapter", "native current-state reads", true),
      edge("records", "publish", "post-transaction invalidation", true),
      edge("eventbus", "publish", "scoped native change", true),
      edge("commands", "broker", "optional local task review", true),
    ],
  },
  {
    id: "desktop",
    title: "4 · Desktop components & verification boundary",
    note: "Main-process disk lease and renderer GPU lifetime protect different resources. Broker delivery, lease acquisition and disposal receipts are distinct protocols. No claim that observed UI freezes came from GPU.",
    nodes: [
      node(
        "nativeui",
        "Native Desktop registries",
        "native",
        "Panels, commands, settings, sessions, appearance, keybinds",
        "src/gui.tsx; panel registrations",
      ),
      node(
        "panels",
        "Tasks / Models / Trajectory / Radar",
        "lazers",
        "Solid view state; scoped read RPC; event-driven refresh",
        "src/tasks/panel.tsx; src/models/comparison-panel.tsx",
      ),
      node(
        "rpc",
        "Service read APIs + event stream",
        "native",
        "Typed Tasks / Models / ModelsDecision / Observability RPC",
      ),
      node(
        "settings",
        "Feature + view settings",
        "lazers",
        "Features stored by service; GUI keepAlive/voice/layout preferences",
        "src/gui.tsx; src/webgpu/features.ts",
      ),
      node(
        "broker",
        "Service inference mailbox",
        "lazers",
        "One renderer owner; heartbeat / deadline / no replay after delivery",
        "src/webgpu/broker.ts",
      ),
      node(
        "runtime",
        "Renderer inference runtime",
        "lazers",
        "Serial GPU allocation/disposal; generation handoff and recovery",
        "src/webgpu/runtime.ts; src/webgpu/lifecycle.ts",
      ),
      node(
        "gpu",
        "ONNX / local GPU models",
        "external",
        "Chat/voice and typed decision engine; physical backend unqualified",
        "src/webgpu/decision-runtime.ts",
      ),
      node(
        "audio",
        "Dictation / speech playback",
        "lazers",
        "Microphone, PCM, read-aloud queue; feature-gated lifecycle",
        "src/webgpu/dictation.tsx; src/webgpu/read-aloud.tsx",
      ),
      node(
        "lease",
        "Main lease + model disk cache",
        "lazers",
        "Window/provider/generation fencing; pinned model files",
        "src/webgpu/main.ts; src/webgpu/lease.ts; src/webgpu/cache.ts",
      ),
      node(
        "layout",
        "Main ELK worker",
        "lazers",
        "Radar layout in worker thread; cancelled by signal",
        "src/radar/layout-main.ts",
      ),
      node(
        "storage",
        "Native GUI / plugin storage",
        "data",
        "View state + retirement receipts; distinct from task authority",
      ),
      node(
        "verification",
        "Candidate-owned native verification",
        "lazers",
        "Isolated OpenCode launch/identity/readback/cleanup manifests",
        "src/verification/opencode/owned-launch.ts",
      ),
      node(
        "candidate",
        "Owned OpenCode test instance",
        "native",
        "Third-party tooling lifecycle; isolated process and XDG roots",
      ),
    ],
    edges: [
      edge("nativeui", "panels", "registered panel render"),
      edge("panels", "rpc", "query / snapshots", true),
      edge("rpc", "panels", "invalidations / reconnect", true),
      edge("nativeui", "settings", "settings page"),
      edge("settings", "rpc", "feature read/configure", true),
      edge("settings", "storage", "GUI preferences"),
      edge("runtime", "broker", "attach/poll/complete", true),
      edge("runtime", "lease", "typed main IPC / acquire / retire", true),
      edge("runtime", "gpu", "load / generate / dispose", true),
      edge("audio", "runtime", "speech / transcription requests", true),
      edge("lease", "storage", "durable lease persistence"),
      edge("panels", "layout", "Radar layout IPC", true),
      edge("verification", "candidate", "isolated launch/readback/cleanup", true),
    ],
  },
]
// Keep the service view readable: orchestration and read/data flows have
// different audiences, so shared authority nodes are repeated across C4 views.
const serviceView = views.find((view) => view.id === "service")
const coreIDs = new Set([
  "bootstrap",
  "commands",
  "scheduler",
  "runtime",
  "adapter",
  "sessions",
  "tools",
  "eventbus",
  "worktrees",
  "records",
  "checks",
  "broker",
])
const dataIDs = new Set([
  "records",
  "progress",
  "context",
  "pricing",
  "read",
  "publish",
  "recovery",
  "handoff",
  "catalog",
  "eventbus",
  "adapter",
  "tools",
])
const dataView = {
  id: "data",
  title: "4 · Data & observation components",
  note: "Repeated nodes identify the same authority as the orchestration view. Recovery facts are an append-only change projection; the handoff library has no registered production producer or consumer.",
  nodes: serviceView.nodes.filter((n) => dataIDs.has(n.id)),
  edges: serviceView.edges.filter((e) => dataIDs.has(e.from) && dataIDs.has(e.to)),
}
serviceView.nodes = serviceView.nodes.filter((n) => coreIDs.has(n.id))
serviceView.edges = serviceView.edges.filter((e) => coreIDs.has(e.from) && coreIDs.has(e.to))
serviceView.title = "3 · Orchestration & native extensions"
views.splice(3, 0, dataView)
views.find((view) => view.id === "desktop").title = "5 · Desktop & native verification"
const colors = {
  lazers: ["#eee8ff", "#7655b5"],
  native: ["#e7f2fc", "#3273ac"],
  data: ["#e5f4e9", "#48825b"],
  external: ["#f5eddf", "#9e7843"],
  person: ["#f6e8ec", "#ac5972"],
  inactive: ["#f0f0f0", "#838383"],
}
const escape = (text) =>
  String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
function wrap(text, chars = 45) {
  const lines = []
  let line = ""
  for (const word of text.split(/\s+/)) {
    if (line && (line + " " + word).length > chars) {
      lines.push(line)
      line = word
    } else line += (line ? " " : "") + word
  }
  if (line) lines.push(line)
  return lines
}
function svgText(lines, x, y, size = 13, fill = "#34303e", weight = 400) {
  return `<text x="${x}" y="${y}" font-family="Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}">${lines.map((line, i) => `<tspan x="${x}" dy="${i ? 17 : 0}">${escape(line)}</tspan>`).join("")}</text>`
}
const rendered = []
for (const view of views) {
  const graph = await elk.layout({
    id: view.id,
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": "40",
      "elk.layered.spacing.nodeNodeBetweenLayers": "95",
      "elk.spacing.edgeNode": "20",
      "elk.padding": "[top=45,left=30,bottom=30,right=30]",
    },
    children: view.nodes.map((item) => ({ id: item.id, width: 350, height: 142 })),
    edges: view.edges.map((item, index) => ({
      id: `e${index}`,
      sources: [item.from],
      targets: [item.to],
      labels: [{ text: item.label, width: Math.min(item.label.length * 6.5, 310), height: 18 }],
    })),
  })
  const arrows = (graph.edges ?? [])
    .map((item, index) => {
      const data = view.edges[index]
      const paths = (item.sections ?? [])
        .map((section) => {
          const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]
          return `<path d="${points.map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" ")}" fill="none" stroke="#81798d" stroke-width="1.5" ${data.async ? 'stroke-dasharray="7 4"' : ""} marker-end="url(#arrow)"/>`
        })
        .join("")
      return (
        paths +
        (item.labels ?? [])
          .map(
            (label) =>
              `<rect x="${label.x - 3}" y="${label.y - 1}" width="${label.width + 6}" height="19" rx="3" fill="white" fill-opacity=".96"/>${svgText([label.text], label.x, label.y + 13, 11, "#51495f")}`,
          )
          .join("")
      )
    })
    .join("")
  const boxes = (graph.children ?? [])
    .map((item) => {
      const data = view.nodes.find((n) => n.id === item.id)
      const [background, border] = colors[data.owner]
      return `<g><title>${escape(`${data.title}\nOwner: ${data.owner}\n${data.detail}\n${data.source}`)}</title><rect x="${item.x}" y="${item.y}" width="350" height="142" rx="9" fill="${background}" stroke="${border}" stroke-width="1.5"/>${svgText([data.owner.toUpperCase()], item.x + 15, item.y + 22, 10, border, 700)}${svgText(wrap(data.title, 38), item.x + 15, item.y + 45, 16, "#24202e", 700)}${svgText(wrap(data.detail, 46).slice(0, 3), item.x + 15, item.y + 72, 12)}${svgText(wrap(data.source, 55).slice(0, 2), item.x + 15, item.y + 122, 10, "#686172")}</g>`
    })
    .join("")
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escape(view.title)}" viewBox="0 0 ${graph.width} ${graph.height}" width="${graph.width}" height="${graph.height}"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="#81798d"/></marker></defs><rect width="100%" height="100%" fill="#fff"/>${arrows}${boxes}</svg>`
  writeFileSync(join(directory, `architecture-c4-${view.id}-20261106.svg`), svg)
  rendered.push({ ...view, svg, width: graph.width, height: graph.height })
}
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LAZERS architecture · 2026-11-06</title><style>*{box-sizing:border-box}body{margin:0;color:#272331;background:#faf9fc;font:14px/1.5 system-ui,sans-serif}header{padding:18px 24px 12px;border-bottom:1px solid #ded9e8;background:white}h1{font-size:21px;margin:0 0 6px}p{margin:6px 0}nav{display:flex;flex-wrap:wrap;gap:7px;margin:12px 0}button{font:inherit;border:1px solid #cbc2d9;border-radius:5px;padding:6px 10px;background:white;color:#382c4c;cursor:pointer}button[aria-pressed=true]{background:#6843a0;color:white;border-color:#6843a0}.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12px}.legend span:before{content:"";display:inline-block;width:12px;height:12px;background:var(--color);border:1px solid #aaa;vertical-align:-2px;margin-right:5px}.toolbar{padding:9px 24px;display:flex;gap:8px;align-items:center;border-bottom:1px solid #ded9e8}.toolbar #status{margin-left:auto;font-size:12px}section{display:none}section.active{display:block}.note{padding:8px 24px;max-width:1200px;margin:0}.viewport{height:calc(100vh - 277px);min-height:420px;overflow:auto;background:#eeebf2;border-top:1px solid #ded9e8;cursor:grab}.viewport.dragging{cursor:grabbing}.viewport svg{display:block;max-width:none;margin:16px;background:white;box-shadow:0 1px 10px #30204018}.help{font-size:12px;color:#655b70}footer{padding:9px 24px;font-size:12px}a{color:#644097}</style><header><h1>LAZERS · OpenCode extension architecture</h1><p>Source audit · 6 November 2026 · ELK layered layout · five C4 views · offline artifact</p><nav>${rendered.map((v, i) => `<button data-view="${v.id}" aria-pressed="${i === 0}">${escape(v.title)}</button>`).join("")}</nav><div class="legend"><span style="--color:#eee8ff">LAZERS</span><span style="--color:#e7f2fc">OpenCode</span><span style="--color:#e5f4e9">Persistent data</span><span style="--color:#f5eddf">External</span><span style="--color:#f0f0f0">Unregistered library</span><b>→ SYNC call / local transaction</b><b>⇢ ASYNC awaited request / event / subprocess</b></div></header><div class="toolbar"><button id="fit">Fit</button><button id="minus">−</button><button id="plus">+</button><button id="actual">100%</button><span class="help">Drag to pan · zoom for edge labels · hover a node for sources</span><output id="status"></output></div>${rendered.map((v, i) => `<section id="view-${v.id}" class="${i === 0 ? "active" : ""}"><p class="note">${escape(v.note)}</p><div class="viewport" data-width="${v.width}">${v.svg}</div></section>`).join("")}<footer>Static source relationships, not invented live activity. See <a href="architecture-review-20261106.md">review</a>, <a href="architecture-system-ranking-20261106.md">system ranking</a> and <a href="architecture-inventory-20261106.json">timestamped read-only inventory</a>. Rebuild with the adjacent .mjs generator; HTML and SVGs have no network dependencies.</footer><script>let current='context',scale=1;const active=()=>document.querySelector('#view-'+current+' .viewport');function zoom(value){scale=Math.max(.12,Math.min(2,value));const svg=active().querySelector('svg');svg.style.width=(Number(svg.getAttribute('width'))*scale)+'px';svg.style.height=(Number(svg.getAttribute('height'))*scale)+'px';document.querySelector('#status').textContent=Math.round(scale*100)+'%'}function fit(){const box=active();const svg=box.querySelector('svg');zoom(Math.min((box.clientWidth-36)/Number(svg.getAttribute('width')),(box.clientHeight-36)/Number(svg.getAttribute('height'))));box.scrollTo(0,0)}document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{current=b.dataset.view;document.querySelectorAll('section').forEach(s=>s.classList.toggle('active',s.id==='view-'+current));document.querySelectorAll('[data-view]').forEach(t=>t.setAttribute('aria-pressed',String(t===b)));fit()});document.querySelector('#fit').onclick=fit;document.querySelector('#plus').onclick=()=>zoom(scale*1.25);document.querySelector('#minus').onclick=()=>zoom(scale/1.25);document.querySelector('#actual').onclick=()=>zoom(1);document.querySelectorAll('.viewport').forEach(box=>{let drag;box.onpointerdown=e=>{drag={x:e.clientX,y:e.clientY,left:box.scrollLeft,top:box.scrollTop};box.classList.add('dragging');box.setPointerCapture(e.pointerId)};box.onpointermove=e=>{if(drag){box.scrollLeft=drag.left-(e.clientX-drag.x);box.scrollTop=drag.top-(e.clientY-drag.y)}};box.onpointerup=()=>{drag=null;box.classList.remove('dragging')};box.onpointercancel=box.onpointerup});fit();</script></html>`
writeFileSync(join(directory, "architecture-c4-20261106.html"), html)
console.log(
  JSON.stringify(
    rendered.map(({ id, nodes, edges, width, height }) => ({
      id,
      nodes: nodes.length,
      edges: edges.length,
      width,
      height,
    })),
    null,
    2,
  ),
)

// The bundled in-process ELK worker has no terminate() in Bun. All output is
// synchronous and complete here; finish this one-shot build explicitly.
process.exit(0)
