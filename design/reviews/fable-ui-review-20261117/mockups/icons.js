// Mockup icon set on the host's 20-unit grid, 1.5 stroke. <i data-i="name" class="..."></i> → inline SVG.
const S =
  'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"'
const R = `<circle cx="10" cy="10" r="7.25" ${S}/>`
const ICONS = {
  "chev-r": `<path d="M8 6l4 4-4 4" ${S}/>`,
  "chev-d": `<path d="M6 8l4 4 4-4" ${S}/>`,
  link: `<path d="M8.5 11.5l3-3M7.2 9.2L5.6 10.8a2.5 2.5 0 003.6 3.6l1.6-1.6M12.8 10.8l1.6-1.6a2.5 2.5 0 00-3.6-3.6L9.2 7.2" ${S}/>`,
  search: `<circle cx="9" cy="9" r="4.75" ${S}/><path d="M12.6 12.6L16 16" ${S}/>`,
  more: `<circle cx="5" cy="10" r="1.1" fill="currentColor"/><circle cx="10" cy="10" r="1.1" fill="currentColor"/><circle cx="15" cy="10" r="1.1" fill="currentColor"/>`,
  x: `<path d="M6 6l8 8M14 6l-8 8" ${S}/>`,
  plus: `<path d="M10 5v10M5 10h10" ${S}/>`,
  check: `<path d="M5.5 10.5l3 3 6-6.5" ${S}/>`,
  ring: R,
  "ring-dot": `${R}<circle cx="10" cy="10" r="2.4" fill="currentColor"/>`,
  "ring-dashed": `<circle cx="10" cy="10" r="7.25" ${S} stroke-dasharray="2.6 2.3"/>`,
  "ring-progress": `${R}<path d="M10 5.5a4.5 4.5 0 010 9z" fill="currentColor"/>`,
  "ring-pause": `${R}<path d="M8.25 7.2v5.6M11.75 7.2v5.6" ${S}/>`,
  "ring-clock": `${R}<path d="M10 6.2V10l2.6 1.7" ${S}/>`,
  "ring-minus": `${R}<path d="M6.9 10h6.2" ${S}/>`,
  ban: `${R}<path d="M5 15L15 5" ${S}/>`,
  "ring-alert": `${R}<path d="M10 6.3v4.4M10 13.4h.01" ${S}/>`,
  "ring-x": `${R}<path d="M7.5 7.5l5 5M12.5 7.5l-5 5" ${S}/>`,
  "ring-check": `${R}<path d="M6.9 10.2l2.2 2.2 4-4.6" ${S}/>`,
  "disc-check": `<circle cx="10" cy="10" r="8" fill="currentColor"/><path d="M6.6 10.2l2.4 2.4 4.4-5" fill="none" stroke="#070a0f" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
  refresh: `<path d="M15.5 10a5.5 5.5 0 11-1.7-4M15.5 4v3.2h-3.2" ${S}/>`,
  tasks: `<rect x="3.5" y="4.5" width="5.5" height="11" rx="1.2" ${S}/><rect x="11" y="4.5" width="5.5" height="11" rx="1.2" ${S}/>`,
  eye: `<path d="M2.5 10s2.7-5 7.5-5 7.5 5 7.5 5-2.7 5-7.5 5-7.5-5-7.5-5z" ${S}/><circle cx="10" cy="10" r="2.2" ${S}/>`,
  hex: `<path d="M10 2.8l6.2 3.6v7.2L10 17.2l-6.2-3.6V6.4z" ${S}/><circle cx="10" cy="10" r="2.2" ${S}/>`,
  branch: `<circle cx="6" cy="5" r="1.6" ${S}/><circle cx="6" cy="15" r="1.6" ${S}/><circle cx="14" cy="7" r="1.6" ${S}/><path d="M6 6.6v6.8M14 8.6c0 3-8 2-8 4.8" ${S}/>`,
  terminal: `<rect x="3" y="4" width="14" height="12" rx="2" ${S}/><path d="M6.5 8.5l2 1.8-2 1.8M10.5 12.2h3" ${S}/>`,
  file: `<path d="M6 3.5h5l3.5 3.5v9a.5.5 0 01-.5.5H6a.5.5 0 01-.5-.5V4a.5.5 0 01.5-.5zM11 3.5V7h3.5" ${S}/>`,
  edit: `<path d="M4.5 15.5l.6-3 8.2-8.2a1.5 1.5 0 012.1 2.1l-8.2 8.2z" ${S}/>`,
  read: `<path d="M3.5 5.5c2.2-.8 4.4-.6 6.5.7v9c-2.1-1.3-4.3-1.5-6.5-.7zM16.5 5.5c-2.2-.8-4.4-.6-6.5.7v9c2.1-1.3 4.3-1.5 6.5-.7z" ${S}/>`,
  agent: `<rect x="4.5" y="7" width="11" height="8" rx="2" ${S}/><path d="M10 4v3M8 11v1M12 11v1" ${S}/>`,
  architect: `<path d="M4 15.5h12M5.5 15.5L10 4.5l4.5 11M7.4 11h5.2" ${S}/>`,
  copy: `<rect x="7" y="7" width="9" height="9" rx="1.6" ${S}/><path d="M13 7V5.5A1.5 1.5 0 0011.5 4h-6A1.5 1.5 0 004 5.5v6A1.5 1.5 0 005.5 13H7" ${S}/>`,
  "zoom-in": `<circle cx="9" cy="9" r="4.75" ${S}/><path d="M12.6 12.6L16 16M7 9h4M9 7v4" ${S}/>`,
  "zoom-out": `<circle cx="9" cy="9" r="4.75" ${S}/><path d="M12.6 12.6L16 16M7 9h4" ${S}/>`,
  fit: `<path d="M4 8V4.5h3.5M16 8V4.5h-3.5M4 12v3.5h3.5M16 12v3.5h-3.5" ${S}/>`,
  play: `<path d="M7 5l8 5-8 5z" ${S}/>`,
  speaker: `<path d="M4 8v4h2.5L10 15V5L6.5 8zM12.5 7.5a3.5 3.5 0 010 5M14.5 5.5a6.5 6.5 0 010 9" ${S}/>`,
  mic: `<rect x="7.75" y="3.5" width="4.5" height="8" rx="2.25" ${S}/><path d="M5 10a5 5 0 0010 0M10 15v2" ${S}/>`,
  trash: `<path d="M4.5 6h11M8 6V4.5h4V6M6 6l.6 9.5h6.8L14 6" ${S}/>`,
  gear: `<circle cx="10" cy="10" r="2.5" ${S}/><path d="M10 3v2M10 15v2M3 10h2M15 10h2M5 5l1.5 1.5M13.5 13.5L15 15M15 5l-1.5 1.5M6.5 13.5L5 15" ${S}/>`,
  arrow: `<path d="M5 10h10M11 6l4 4-4 4" ${S}/>`,
  back: `<path d="M15 10H5M9 6l-4 4 4 4" ${S}/>`,
  wifi: `<path d="M3.5 8.5a9.5 9.5 0 0113 0M6 11.2a6 6 0 018 0M8.4 13.8a2.5 2.5 0 013.2 0" ${S}/>`,
  sidebar: `<rect x="3.5" y="4.5" width="13" height="11" rx="2" ${S}/><path d="M12 4.5v11" ${S}/>`,
  map: `<circle cx="5" cy="10" r="1.8" ${S}/><circle cx="15" cy="5.5" r="1.8" ${S}/><circle cx="15" cy="14.5" r="1.8" ${S}/><path d="M6.7 9.2l6.6-3M6.7 10.8l6.6 3" ${S}/>`,
  diamond: `${R}<path d="M10 6l3.4 4-3.4 4-3.4-4z" ${S}/>`,
}
function paint(root = document) {
  root.querySelectorAll("i[data-i]").forEach((el) => {
    const name = el.dataset.i
    const cls = `i ${el.className || ""}`.trim()
    const style = el.getAttribute("style")
    el.outerHTML = `<svg class="${cls}" viewBox="0 0 20 20"${style ? ` style="${style}"` : ""}>${ICONS[name] || ""}</svg>`
  })
}
function hostTabs(active) {
  const t = [
    ["Tasks", "tasks"],
    ["Radar", "eye"],
    ["Models", "hex"],
    ["Trajectory", "branch"],
  ]
  return `<div class="tabs">${t.map(([n, i]) => `<span class="tab"${n === active ? " data-on" : ""}><i data-i="${i}" class="s"></i>${n}${n === active ? '<i data-i="x" class="s" style="margin-left:4px;opacity:.6"></i>' : ""}</span>`).join("")}<span class="sp"></span><span class="iconbtn"><i data-i="plus"></i></span></div>`
}
document.addEventListener("DOMContentLoaded", () => {
  document
    .querySelectorAll("[data-tabs]")
    .forEach((el) => (el.outerHTML = hostTabs(el.dataset.tabs)))
  window.build && window.build()
  paint()
})
