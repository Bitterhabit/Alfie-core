/**
 * Alfie's Optional Virtual Room (Phase 5)
 *
 * Strictly opt-in ambient SVG study diorama driven purely by deterministic
 * Core state from /api/core/ambient/state. Zero external libraries, zero raw
 * innerHTML, accessible interactive regions linking back to Core views.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs = {}, text = null) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  }
  if (text !== null) el.textContent = String(text);
  return el;
}

const SKY_PALETTES = {
  dawn: { top: "#3b2e5a", bottom: "#d97757", accent: "#fde68a" },
  day: { top: "#2b5876", bottom: "#74b9ff", accent: "#fef3c7" },
  dusk: { top: "#2c1e4a", bottom: "#b4536a", accent: "#fda4af" },
  night: { top: "#0f1024", bottom: "#26234d", accent: "#c4b5fd" }
};

const MOOD_COLORS = {
  calm: "#9061f9",
  steady: "#38bdf8",
  focused: "#22c55e",
  attentive: "#f59e0b",
  awaiting: "#ec4899",
  alert: "#ef4444"
};

export function renderVirtualRoomSvg(container, presence, { onNavigate } = {}) {
  if (!container) return;
  while (container.firstChild) container.removeChild(container.firstChild);

  const phase = presence?.environment?.timeOfDay || "night";
  const sky = SKY_PALETTES[phase] || SKY_PALETTES.night;
  const mood = presence?.soul?.mood || "calm";
  const soulColor = MOOD_COLORS[mood] || MOOD_COLORS.calm;
  const focalProject = presence?.desk?.focalProject;
  const shelves = presence?.shelves || { memoriesCount: 0, ideasCount: 0, learningTopicsCount: 0 };
  const homelab = presence?.homelab || { enabledWatchers: 0, unreadAlerts: 0, highestTier: "quiet", vramPercent: null, runningJobs: 0 };

  const svg = svgEl("svg", {
    viewBox: "0 0 760 280",
    class: "virtual-room-svg",
    role: "img",
    "aria-label": `Alfie's Study — ${presence?.soul?.statusLine || "Calm presence"}`
  });

  // Defs for window sky gradient & subtle soul aura
  const defs = svgEl("defs");
  const grad = svgEl("linearGradient", { id: "vroom-sky", x1: "0%", y1: "0%", x2: "0%", y2: "100%" });
  grad.appendChild(svgEl("stop", { offset: "0%", "stop-color": sky.top }));
  grad.appendChild(svgEl("stop", { offset: "100%", "stop-color": sky.bottom }));
  defs.appendChild(grad);

  const orbGrad = svgEl("radialGradient", { id: "vroom-soul-aura", cx: "50%", cy: "50%", r: "50%" });
  orbGrad.appendChild(svgEl("stop", { offset: "0%", "stop-color": soulColor, "stop-opacity": "0.85" }));
  orbGrad.appendChild(svgEl("stop", { offset: "60%", "stop-color": soulColor, "stop-opacity": "0.24" }));
  orbGrad.appendChild(svgEl("stop", { offset: "100%", "stop-color": soulColor, "stop-opacity": "0" }));
  defs.appendChild(orbGrad);
  svg.appendChild(defs);

  // Room backdrop & floor
  svg.appendChild(svgEl("rect", { x: 0, y: 0, width: 760, height: 210, fill: "var(--panel-raised, #181427)" }));
  svg.appendChild(svgEl("rect", { x: 0, y: 210, width: 760, height: 70, fill: "var(--panel, #120f1e)" }));
  svg.appendChild(svgEl("line", { x1: 0, y1: 210, x2: 760, y2: 210, stroke: "var(--line-strong, #342c52)", "stroke-width": 2 }));

  // 1. Study Window (Time of Day)
  const winGroup = svgEl("g", { class: "vroom-zone" });
  winGroup.appendChild(svgEl("rect", { x: 34, y: 26, width: 154, height: 112, fill: "url(#vroom-sky)", stroke: "var(--line-strong, #342c52)", "stroke-width": 2 }));
  winGroup.appendChild(svgEl("circle", { cx: phase === "night" ? 148 : 82, cy: 62, r: phase === "night" ? 11 : 14, fill: sky.accent }));
  if (phase === "night") {
    winGroup.appendChild(svgEl("circle", { cx: 66, cy: 48, r: 1.6, fill: "#ffffff", opacity: 0.8 }));
    winGroup.appendChild(svgEl("circle", { cx: 108, cy: 42, r: 1.4, fill: "#ffffff", opacity: 0.7 }));
    winGroup.appendChild(svgEl("circle", { cx: 126, cy: 86, r: 1.3, fill: "#ffffff", opacity: 0.65 }));
  }
  // Window mullions
  winGroup.appendChild(svgEl("line", { x1: 111, y1: 26, x2: 111, y2: 138, stroke: "var(--panel-raised, #181427)", "stroke-width": 4 }));
  winGroup.appendChild(svgEl("line", { x1: 34, y1: 84, x2: 188, y2: 84, stroke: "var(--panel-raised, #181427)", "stroke-width": 4 }));
  winGroup.appendChild(svgEl("text", { x: 34, y: 156, class: "vroom-caption" }, `WINDOW · ${String(presence?.environment?.timeLabel || "Study").toUpperCase()}`));
  svg.appendChild(winGroup);

  // 2. Knowledge Bookshelf (clickable -> Garden)
  const shelfGroup = svgEl("g", { class: "vroom-interactive", role: "button", tabindex: "0", "aria-label": `Knowledge shelves: ${shelves.memoriesCount} memories, ${shelves.ideasCount} ideas` });
  shelfGroup.appendChild(svgEl("rect", { x: 214, y: 26, width: 156, height: 152, fill: "var(--panel, #120f1e)", stroke: "var(--line-strong, #342c52)", "stroke-width": 2 }));
  // Shelf dividers + pixel books proportional to counts
  [76, 126].forEach((y) => {
    shelfGroup.appendChild(svgEl("line", { x1: 216, y1: y, x2: 368, y2: y, stroke: "var(--line-strong, #342c52)", "stroke-width": 2 }));
  });
  const bookColors = ["#9061f9", "#38bdf8", "#22c55e", "#f59e0b", "#ec4899", "#a78bfa"];
  const memBooks = Math.max(2, Math.min(10, shelves.memoriesCount || 2));
  for (let i = 0; i < memBooks; i += 1) {
    shelfGroup.appendChild(svgEl("rect", { x: 224 + i * 13, y: 40 + (i % 2) * 5, width: 10, height: 34 - (i % 2) * 5, fill: bookColors[i % bookColors.length], opacity: 0.88 }));
  }
  const ideaBooks = Math.max(1, Math.min(10, shelves.ideasCount || 1));
  for (let i = 0; i < ideaBooks; i += 1) {
    shelfGroup.appendChild(svgEl("rect", { x: 224 + i * 13, y: 92 + (i % 3) * 3, width: 10, height: 32 - (i % 3) * 3, fill: bookColors[(i + 2) % bookColors.length], opacity: 0.88 }));
  }
  shelfGroup.appendChild(svgEl("text", { x: 224, y: 154, class: "vroom-shelf-stat" }, `${shelves.memoriesCount} memories · ${shelves.ideasCount} ideas`));
  shelfGroup.appendChild(svgEl("text", { x: 224, y: 170, class: "vroom-shelf-sub" }, `${shelves.learningTopicsCount} learning topics`));
  if (typeof onNavigate === "function") {
    const goGarden = () => onNavigate("garden");
    shelfGroup.addEventListener("click", goGarden);
    shelfGroup.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); goGarden(); } });
  }
  svg.appendChild(shelfGroup);

  // 3. Alfie Soul & Project Desk (Center-Right, clickable -> Chat)
  const deskGroup = svgEl("g", { class: "vroom-interactive", role: "button", tabindex: "0", "aria-label": `Project desk: ${focalProject ? focalProject.name : "Open workspace"}` });
  deskGroup.appendChild(svgEl("circle", { cx: 472, cy: 96, r: 54, fill: "url(#vroom-soul-aura)" }));
  deskGroup.appendChild(svgEl("rect", { x: 454, y: 78, width: 36, height: 36, fill: soulColor, stroke: "#ffffff", "stroke-width": 2, "stroke-opacity": "0.55" }));
  deskGroup.appendChild(svgEl("rect", { x: 464, y: 88, width: 16, height: 16, fill: "#ffffff", opacity: "0.7" }));
  // Desk surface
  deskGroup.appendChild(svgEl("rect", { x: 396, y: 162, width: 184, height: 14, fill: "var(--line-strong, #342c52)" }));
  deskGroup.appendChild(svgEl("rect", { x: 408, y: 176, width: 10, height: 50, fill: "var(--line-strong, #342c52)" }));
  deskGroup.appendChild(svgEl("rect", { x: 558, y: 176, width: 10, height: 50, fill: "var(--line-strong, #342c52)" }));
  deskGroup.appendChild(svgEl("text", { x: 488, y: 148, "text-anchor": "middle", class: "vroom-soul-label" }, `${mood.toUpperCase()} · ${String(presence?.soul?.workingMode || "companion").toUpperCase()}`));
  deskGroup.appendChild(svgEl("text", { x: 488, y: 204, "text-anchor": "middle", class: "vroom-desk-project" }, focalProject ? focalProject.name.slice(0, 26) : "No focal project"));
  if (typeof onNavigate === "function") {
    const goChat = () => onNavigate("chat");
    deskGroup.addEventListener("click", goChat);
    deskGroup.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); goChat(); } });
  }
  svg.appendChild(deskGroup);

  // 4. Homelab Rack & Watchers (Far Right, clickable -> Tools & access)
  const rackGroup = svgEl("g", { class: "vroom-interactive", role: "button", tabindex: "0", "aria-label": `Homelab rack: ${homelab.enabledWatchers} watchers, ${homelab.unreadAlerts} unread alerts` });
  rackGroup.appendChild(svgEl("rect", { x: 604, y: 42, width: 122, height: 178, fill: "var(--panel, #120f1e)", stroke: "var(--line-strong, #342c52)", "stroke-width": 2 }));
  const tierColor = homelab.highestTier === "urgent" ? "#ef4444" : (homelab.highestTier === "notify" ? "#f59e0b" : "#22c55e");
  [60, 96, 132, 168].forEach((y, idx) => {
    rackGroup.appendChild(svgEl("rect", { x: 616, y, width: 98, height: 24, fill: "var(--panel-raised, #181427)", stroke: "var(--line, #342c52)", "stroke-width": 1 }));
    const ledColor = idx === 0 ? tierColor : (idx === 1 && homelab.vramWarning ? "#ef4444" : "#38bdf8");
    rackGroup.appendChild(svgEl("rect", { x: 624, y: y + 8, width: 8, height: 8, fill: ledColor }));
    const label = idx === 0
      ? `WATCH ${homelab.enabledWatchers}`
      : (idx === 1 ? `VRAM ${homelab.vramPercent !== null ? `${homelab.vramPercent}%` : "OK"}` : (idx === 2 ? `JOBS ${homelab.runningJobs}` : `ALERTS ${homelab.unreadAlerts}`));
    rackGroup.appendChild(svgEl("text", { x: 640, y: y + 16, class: "vroom-rack-text" }, label));
  });
  rackGroup.appendChild(svgEl("text", { x: 665, y: 236, "text-anchor": "middle", class: "vroom-caption" }, "HOMELAB RACK"));
  if (typeof onNavigate === "function") {
    const goTools = () => onNavigate("tools");
    rackGroup.addEventListener("click", goTools);
    rackGroup.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); goTools(); } });
  }
  svg.appendChild(rackGroup);

  // Ambient footer bar inside room
  svg.appendChild(svgEl("text", { x: 34, y: 256, class: "vroom-status-line" }, presence?.soul?.statusLine || "Quietly ready in the study"));

  container.appendChild(svg);
}

if (typeof window !== "undefined") {
  window.AlfieVirtualRoom = Object.freeze({
    renderVirtualRoomSvg
  });
}
