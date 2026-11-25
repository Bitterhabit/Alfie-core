const $ = (selector) => document.querySelector(selector);
const state = {
  user: null,
  csrfToken: "",
  linked: false,
  activeConversationId: null,
  activeConversation: null,
  messages: [],
  conversations: [],
  projects: [],
  selectedProjectId: "all",
  workingMode: (() => { try { return localStorage.getItem("alfie:workingMode") || "companion"; } catch { return "companion"; } })(),
  ideas: [],
  ideaTags: [],
  ideaStatusFilter: "all",
  ideaProjectFilter: "all",
  ideaTagFilter: "",
  editingIdeaId: null,
  memoryKindFilter: "all",
  memoryIncludeArchived: false,
  watchers: [],
  watcherEvents: [],
  watcherEventTierFilter: "all",
  workflowProfile: null,
  capsules: [],
  activeCapsuleId: null,
  receipts: [],
  vram: null,
  vramDismissedKey: null,
  vramLastAlerted: false,
  vramPollTimer: null,
  cloudAgents: [],
  cloudPrivacyCategories: [],
  selectedAgentProvider: "local",
  view: "chat",
  sending: false,
  conversationLoadToken: 0,
  conversationLoading: false,
  pendingApprovalConversations: new Map()
};

let pendingApiCalls = 0;

async function api(route, options = {}) {
  const isSilent = typeof route === "string" && (route.includes("/whoami") || route.includes("/auth/me") || route.includes("/system/vram"));
  const trackSoul = !isSilent && !state.sending && Boolean(window.alfieSoul);
  if (trackSoul) {
    if (pendingApiCalls === 0 && (window.alfieSoul.getAnimationState() === "idle" || window.alfieSoul.getAnimationState() === "listening")) {
      window.alfieSoul.setState("thinking", "amber");
    }
    pendingApiCalls++;
  }
  const method = String(options.method || "GET").toUpperCase();
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (!["GET", "HEAD"].includes(method) && state.csrfToken) headers["x-csrf-token"] = state.csrfToken;
  try {
    const response = await fetch(route, {
      credentials: "same-origin",
      cache: "no-store",
      ...options,
      method,
      headers
    });
    const raw = await response.text();
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; }
    catch { throw new Error("Alfie returned an unreadable response."); }
    if (!response.ok) {
      const error = new Error(payload.error || "The request could not be completed.");
      error.status = response.status;
      error.code = payload.code;
      error.actionConsumed = payload.actionConsumed === true;
      error.actionCompleted = payload.actionCompleted === true;
      error.actionOutcomeUnknown = payload.actionOutcomeUnknown === true;
      error.actionId = payload.actionId || null;
      error.toolId = payload.toolId || null;
      throw error;
    }
    return payload;
  } catch (error) {
    const isAuthForm = route === "/api/auth/login" || route === "/api/auth/setup";
    if (trackSoul && !isAuthForm) {
      window.alfieSoul?.pulse("error", 2400, "idle", "purple");
    }
    throw error;
  } finally {
    if (trackSoul) {
      pendingApiCalls = Math.max(0, pendingApiCalls - 1);
      if (pendingApiCalls === 0 && window.alfieSoul.getAnimationState() === "thinking") {
        window.alfieSoul.setState("idle", "purple");
      }
    }
  }
}

function toast(message, { variant = "default", durationMs = 3200 } = {}) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("toast-warning", variant === "warning");
  el.setAttribute("role", variant === "warning" ? "alert" : "status");
  el.classList.add("visible");
  clearTimeout(toast.timeout);
  toast.timeout = setTimeout(() => {
    el.classList.remove("visible", "toast-warning");
  }, durationMs);
}

function setConnection(online, label, { offline = !online } = {}) {
  $("#connection-dot").classList.toggle("online", Boolean(online));
  $("#connection-label").textContent = label;
  if (!online && offline) {
    window.alfieSoul?.setOffline("red");
  } else if (online && window.alfieSoul?.getAnimationState() === "offline") {
    window.alfieSoul?.setState("idle", "purple");
  }
}

/* Service Worker Registration */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  });
}

/* Alfie Soul Controller (Master Vision Part 10 §13-15)
 * Manages `.alfie-soul` components, updating `data-mood`, `data-animation-state`,
 * and `data-soul-theme` palette profiles mapped to existing CSS variables.
 */
const SOUL_MOODS = ["purple", "blue", "red", "amber", "cyan", "green", "pink"];
const SOUL_STATES = ["idle", "listening", "thinking", "working", "waiting", "completed", "error", "offline"];
const SOUL_THEME_STORAGE_KEY = "alfie_soul_theme";

const SOUL_THEME_PROFILES = {
  amethyst: {
    id: "amethyst",
    name: "Amethyst Violet",
    desc: "Petrio Classic · Deep violet nebula & lavender glow",
    variables: {
      "--soul-glow": "rgba(167,139,250,.55)",
      "--soul-glow-wide": "rgba(128,105,231,.25)",
      "--soul-core-1": "#9061f9",
      "--soul-core-2": "#4c1d95",
      "--soul-matrix": "rgba(192,132,252,.35)",
      "--soul-ring": "#c084fc",
      "--soul-ring-outer": "rgba(167,139,250,.3)",
      "--soul-accent": "#e9d5ff",
      "--soul-spark": "#ffffff"
    }
  },
  "cyber-cyan": {
    id: "cyber-cyan",
    name: "Cyber Cyan",
    desc: "Quantum Neon · Electric teal, turquoise & ocean navy",
    variables: {
      "--soul-glow": "rgba(6,182,212,.65)",
      "--soul-glow-wide": "rgba(8,145,178,.30)",
      "--soul-core-1": "#06b6d4",
      "--soul-core-2": "#164e63",
      "--soul-matrix": "rgba(103,232,249,.40)",
      "--soul-ring": "#22d3ee",
      "--soul-ring-outer": "rgba(6,182,212,.35)",
      "--soul-accent": "#cffafe",
      "--soul-spark": "#ecfeff"
    }
  },
  "solar-gold": {
    id: "solar-gold",
    name: "Solar Gold",
    desc: "Chrono Sun · Molten gold radiance, amber & bronze",
    variables: {
      "--soul-glow": "rgba(245,158,11,.65)",
      "--soul-glow-wide": "rgba(217,119,6,.30)",
      "--soul-core-1": "#f59e0b",
      "--soul-core-2": "#78350f",
      "--soul-matrix": "rgba(251,191,36,.40)",
      "--soul-ring": "#fbbf24",
      "--soul-ring-outer": "rgba(245,158,11,.35)",
      "--soul-accent": "#fef3c7",
      "--soul-spark": "#fffbeb"
    }
  },
  "emerald-matrix": {
    id: "emerald-matrix",
    name: "Emerald Matrix",
    desc: "Biosphere · Terminal jade grid, mint pulse & forest",
    variables: {
      "--soul-glow": "rgba(34,197,94,.65)",
      "--soul-glow-wide": "rgba(21,128,61,.30)",
      "--soul-core-1": "#22c55e",
      "--soul-core-2": "#14532d",
      "--soul-matrix": "rgba(74,222,128,.40)",
      "--soul-ring": "#4ade80",
      "--soul-ring-outer": "rgba(34,197,94,.35)",
      "--soul-accent": "#bbf7d0",
      "--soul-spark": "#f0fdf4"
    }
  },
  "rose-quartz": {
    id: "rose-quartz",
    name: "Rose Quartz",
    desc: "Velvet Nebula · Coral rose, starlight blush & ruby core",
    variables: {
      "--soul-glow": "rgba(244,63,94,.65)",
      "--soul-glow-wide": "rgba(225,29,72,.30)",
      "--soul-core-1": "#f43f5e",
      "--soul-core-2": "#881337",
      "--soul-matrix": "rgba(251,113,133,.40)",
      "--soul-ring": "#fb7185",
      "--soul-ring-outer": "rgba(244,63,94,.35)",
      "--soul-accent": "#fecdd3",
      "--soul-spark": "#fff1f2"
    }
  },
  "obsidian-silver": {
    id: "obsidian-silver",
    name: "Obsidian Silver",
    desc: "Celestial Zero · Platinum core, silver halo & starlight",
    variables: {
      "--soul-glow": "rgba(226,232,240,.55)",
      "--soul-glow-wide": "rgba(148,163,184,.28)",
      "--soul-core-1": "#cbd5e1",
      "--soul-core-2": "#334155",
      "--soul-matrix": "rgba(203,213,225,.35)",
      "--soul-ring": "#e2e8f0",
      "--soul-ring-outer": "rgba(226,232,240,.30)",
      "--soul-accent": "#f8fafc",
      "--soul-spark": "#ffffff"
    }
  },
  "prism-sunset": {
    id: "prism-sunset",
    name: "Prism Sunset",
    desc: "Twilight Horizon · Tangerine flare, dusk coral & warm ember",
    variables: {
      "--soul-glow": "rgba(249,115,22,.62)",
      "--soul-glow-wide": "rgba(194,65,12,.28)",
      "--soul-core-1": "#fb923c",
      "--soul-core-2": "#7c2d12",
      "--soul-matrix": "rgba(253,186,116,.40)",
      "--soul-ring": "#fdba74",
      "--soul-ring-outer": "rgba(249,115,22,.35)",
      "--soul-accent": "#ffedd5",
      "--soul-spark": "#fff7ed"
    }
  }
};

const POE_SPRITE_LARGE_SVG = `<svg class="poe-sprite poe-sprite-large" viewBox="0 0 24 24" shape-rendering="crispEdges" aria-hidden="true">
  <g class="poe-motes">
    <rect x="13" y="0" width="1" height="1" class="poe-px-spark"/>
    <rect x="9" y="1" width="1" height="1" class="poe-px-accent"/>
    <rect x="4" y="6" width="1" height="1" class="poe-px-accent"/>
    <rect x="18" y="6" width="1" height="1" class="poe-px-ring"/>
    <rect x="3" y="14" width="1" height="1" class="poe-px-ring"/>
    <rect x="21" y="14" width="1" height="1" class="poe-px-spark"/>
    <rect x="19" y="19" width="1" height="1" class="poe-px-core1"/>
  </g>
  <g class="poe-flame-tip">
    <rect x="12" y="2" width="1" height="1" class="poe-px-spark"/><rect x="13" y="2" width="1" height="1" class="poe-px-accent"/>
    <rect x="11" y="3" width="1" height="1" class="poe-px-accent"/><rect x="12" y="3" width="1" height="1" class="poe-px-ring"/><rect x="13" y="3" width="1" height="1" class="poe-px-accent"/>
    <rect x="10" y="4" width="1" height="1" class="poe-px-ring"/><rect x="11" y="4" width="2" height="1" class="poe-px-accent"/><rect x="13" y="4" width="1" height="1" class="poe-px-core1"/>
    <rect x="9" y="5" width="1" height="1" class="poe-px-core2"/><rect x="10" y="5" width="1" height="1" class="poe-px-core1"/><rect x="11" y="5" width="1" height="1" class="poe-px-ring"/><rect x="12" y="5" width="1" height="1" class="poe-px-accent"/><rect x="13" y="5" width="1" height="1" class="poe-px-core1"/><rect x="14" y="5" width="1" height="1" class="poe-px-core2"/>
  </g>
  <g class="poe-body">
    <rect x="8" y="6" width="1" height="1" class="poe-px-core2"/><rect x="9" y="6" width="1" height="1" class="poe-px-core1"/><rect x="10" y="6" width="4" height="1" class="poe-px-ring"/><rect x="14" y="6" width="1" height="1" class="poe-px-core1"/><rect x="15" y="6" width="1" height="1" class="poe-px-core2"/>
    <rect x="7" y="7" width="1" height="1" class="poe-px-core2"/><rect x="8" y="7" width="1" height="1" class="poe-px-core1"/><rect x="9" y="7" width="1" height="1" class="poe-px-ring"/><rect x="10" y="7" width="4" height="1" class="poe-px-accent"/><rect x="14" y="7" width="1" height="1" class="poe-px-ring"/><rect x="15" y="7" width="1" height="1" class="poe-px-core1"/><rect x="16" y="7" width="1" height="1" class="poe-px-core2"/>
    <rect x="6" y="8" width="1" height="1" class="poe-px-core1"/><rect x="7" y="8" width="1" height="1" class="poe-px-core2"/><rect x="8" y="8" width="1" height="1" class="poe-px-core1"/><rect x="9" y="8" width="2" height="1" class="poe-px-ring"/><rect x="11" y="8" width="2" height="1" class="poe-px-accent"/><rect x="13" y="8" width="2" height="1" class="poe-px-ring"/><rect x="15" y="8" width="1" height="1" class="poe-px-core1"/><rect x="16" y="8" width="1" height="1" class="poe-px-core2"/><rect x="17" y="8" width="1" height="1" class="poe-px-core1"/>
    <rect x="6" y="9" width="1" height="1" class="poe-px-core2"/><rect x="7" y="9" width="1" height="1" class="poe-px-core1"/><rect x="8" y="9" width="1" height="1" class="poe-px-ring"/><rect x="9" y="9" width="6" height="1" class="poe-px-void"/><rect x="15" y="9" width="1" height="1" class="poe-px-ring"/><rect x="16" y="9" width="1" height="1" class="poe-px-core1"/><rect x="17" y="9" width="1" height="1" class="poe-px-core2"/>
    <rect x="5" y="10" width="1" height="2" class="poe-px-core2"/><rect x="6" y="10" width="1" height="2" class="poe-px-core1"/><rect x="7" y="10" width="1" height="2" class="poe-px-ring"/><rect x="8" y="10" width="8" height="2" class="poe-px-void"/><rect x="16" y="10" width="1" height="2" class="poe-px-ring"/><rect x="17" y="10" width="1" height="2" class="poe-px-core1"/><rect x="18" y="10" width="1" height="2" class="poe-px-core2"/>
    <rect x="4" y="12" width="1" height="1" class="poe-px-core1"/><rect x="5" y="12" width="1" height="1" class="poe-px-core2"/><rect x="6" y="12" width="1" height="1" class="poe-px-core1"/><rect x="7" y="12" width="1" height="1" class="poe-px-ring"/><rect x="8" y="12" width="8" height="1" class="poe-px-void"/><rect x="16" y="12" width="1" height="1" class="poe-px-ring"/><rect x="17" y="12" width="1" height="1" class="poe-px-core1"/><rect x="18" y="12" width="1" height="1" class="poe-px-core2"/><rect x="19" y="12" width="1" height="1" class="poe-px-core1"/>
    <rect x="6" y="13" width="1" height="1" class="poe-px-core2"/><rect x="7" y="13" width="1" height="1" class="poe-px-core1"/><rect x="8" y="13" width="1" height="1" class="poe-px-core2"/><rect x="9" y="13" width="6" height="1" class="poe-px-void"/><rect x="15" y="13" width="1" height="1" class="poe-px-core2"/><rect x="16" y="13" width="1" height="1" class="poe-px-core1"/><rect x="17" y="13" width="1" height="1" class="poe-px-core2"/>
    <rect x="6" y="14" width="1" height="1" class="poe-px-core2"/><rect x="7" y="14" width="2" height="1" class="poe-px-core1"/><rect x="9" y="14" width="1" height="1" class="poe-px-ring"/><rect x="10" y="14" width="4" height="1" class="poe-px-accent"/><rect x="14" y="14" width="1" height="1" class="poe-px-ring"/><rect x="15" y="14" width="2" height="1" class="poe-px-core1"/><rect x="17" y="14" width="1" height="1" class="poe-px-core2"/>
    <rect x="7" y="15" width="1" height="1" class="poe-px-core2"/><rect x="8" y="15" width="2" height="1" class="poe-px-core1"/><rect x="10" y="15" width="4" height="1" class="poe-px-ring"/><rect x="14" y="15" width="2" height="1" class="poe-px-core1"/><rect x="16" y="15" width="1" height="1" class="poe-px-core2"/>
    <rect x="7" y="16" width="1" height="1" class="poe-px-core2"/><rect x="8" y="16" width="1" height="1" class="poe-px-core1"/><rect x="9" y="16" width="1" height="1" class="poe-px-core2"/><rect x="10" y="16" width="1" height="1" class="poe-px-core1"/><rect x="11" y="16" width="2" height="1" class="poe-px-ring"/><rect x="13" y="16" width="1" height="1" class="poe-px-core1"/><rect x="14" y="16" width="1" height="1" class="poe-px-core2"/><rect x="15" y="16" width="1" height="1" class="poe-px-core1"/><rect x="16" y="16" width="1" height="1" class="poe-px-core2"/>
  </g>
  <g class="poe-eyes">
    <rect x="9" y="10" width="1" height="1" class="poe-px-accent"/><rect x="10" y="10" width="1" height="1" class="poe-px-spark"/><rect x="13" y="10" width="1" height="1" class="poe-px-spark"/><rect x="14" y="10" width="1" height="1" class="poe-px-accent"/>
    <rect x="9" y="11" width="2" height="1" class="poe-px-spark"/><rect x="13" y="11" width="2" height="1" class="poe-px-spark"/>
    <rect x="9" y="12" width="2" height="1" class="poe-px-accent"/><rect x="13" y="12" width="2" height="1" class="poe-px-accent"/>
  </g>
  <g class="poe-tail">
    <rect x="7" y="17" width="1" height="1" class="poe-px-core2"/><rect x="8" y="17" width="1" height="1" class="poe-px-core1"/>
    <rect x="10" y="17" width="1" height="1" class="poe-px-core2"/><rect x="11" y="17" width="2" height="1" class="poe-px-core1"/><rect x="13" y="17" width="1" height="1" class="poe-px-core2"/>
    <rect x="15" y="17" width="1" height="1" class="poe-px-core1"/><rect x="16" y="17" width="1" height="1" class="poe-px-core2"/>
    <rect x="8" y="18" width="1" height="1" class="poe-px-core2"/><rect x="11" y="18" width="1" height="1" class="poe-px-core2"/><rect x="12" y="18" width="1" height="1" class="poe-px-core1"/><rect x="15" y="18" width="1" height="1" class="poe-px-core2"/>
    <rect x="11" y="19" width="1" height="1" class="poe-px-core1"/><rect x="12" y="19" width="1" height="1" class="poe-px-core2"/>
    <rect x="11" y="20" width="1" height="1" class="poe-px-core2"/><rect x="12" y="21" width="1" height="1" class="poe-px-core1"/>
  </g>
</svg>`;

const POE_SPRITE_MINI_SVG = `<svg class="poe-sprite poe-sprite-mini" viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true">
  <g class="poe-motes"><rect x="8" y="0" width="1" height="1" class="poe-px-spark"/></g>
  <g class="poe-flame-tip">
    <rect x="7" y="1" width="1" height="1" class="poe-px-spark"/><rect x="8" y="1" width="1" height="1" class="poe-px-accent"/>
    <rect x="6" y="2" width="1" height="1" class="poe-px-ring"/><rect x="7" y="2" width="2" height="1" class="poe-px-accent"/>
    <rect x="5" y="3" width="1" height="1" class="poe-px-core2"/><rect x="6" y="3" width="1" height="1" class="poe-px-core1"/><rect x="7" y="3" width="1" height="1" class="poe-px-ring"/><rect x="8" y="3" width="1" height="1" class="poe-px-accent"/><rect x="9" y="3" width="1" height="1" class="poe-px-core1"/><rect x="10" y="3" width="1" height="1" class="poe-px-core2"/>
  </g>
  <g class="poe-body">
    <rect x="4" y="4" width="1" height="1" class="poe-px-core2"/><rect x="5" y="4" width="1" height="1" class="poe-px-core1"/><rect x="6" y="4" width="4" height="1" class="poe-px-ring"/><rect x="10" y="4" width="1" height="1" class="poe-px-core1"/><rect x="11" y="4" width="1" height="1" class="poe-px-core2"/>
    <rect x="3" y="5" width="1" height="3" class="poe-px-core2"/><rect x="4" y="5" width="1" height="3" class="poe-px-core1"/><rect x="5" y="5" width="6" height="3" class="poe-px-void"/><rect x="11" y="5" width="1" height="3" class="poe-px-core1"/><rect x="12" y="5" width="1" height="3" class="poe-px-core2"/>
    <rect x="4" y="8" width="1" height="2" class="poe-px-core2"/><rect x="5" y="8" width="1" height="1" class="poe-px-core1"/><rect x="6" y="8" width="4" height="1" class="poe-px-void"/><rect x="10" y="8" width="1" height="1" class="poe-px-core1"/><rect x="11" y="8" width="1" height="2" class="poe-px-core2"/>
    <rect x="5" y="9" width="1" height="1" class="poe-px-core1"/><rect x="6" y="9" width="4" height="1" class="poe-px-ring"/><rect x="10" y="9" width="1" height="1" class="poe-px-core1"/>
    <rect x="4" y="10" width="1" height="1" class="poe-px-core2"/><rect x="5" y="10" width="1" height="1" class="poe-px-core1"/><rect x="6" y="10" width="1" height="1" class="poe-px-core2"/><rect x="7" y="10" width="2" height="1" class="poe-px-core1"/><rect x="9" y="10" width="1" height="1" class="poe-px-core2"/><rect x="10" y="10" width="1" height="1" class="poe-px-core1"/><rect x="11" y="10" width="1" height="1" class="poe-px-core2"/>
  </g>
  <g class="poe-eyes">
    <rect x="6" y="6" width="1" height="1" class="poe-px-spark"/><rect x="9" y="6" width="1" height="1" class="poe-px-spark"/>
    <rect x="6" y="7" width="1" height="1" class="poe-px-accent"/><rect x="9" y="7" width="1" height="1" class="poe-px-accent"/>
  </g>
  <g class="poe-tail">
    <rect x="5" y="11" width="1" height="1" class="poe-px-core2"/><rect x="7" y="11" width="1" height="1" class="poe-px-core1"/><rect x="8" y="11" width="1" height="1" class="poe-px-core2"/><rect x="10" y="11" width="1" height="1" class="poe-px-core2"/>
    <rect x="7" y="12" width="1" height="1" class="poe-px-core2"/><rect x="8" y="12" width="1" height="1" class="poe-px-core1"/>
    <rect x="8" y="13" width="1" height="1" class="poe-px-core2"/><rect x="7" y="14" width="1" height="1" class="poe-px-core1"/>
  </g>
</svg>`;

function createPoeSpriteHtml(variant = "large") {
  return variant === "mini" ? POE_SPRITE_MINI_SVG : POE_SPRITE_LARGE_SVG;
}

class AlfieSoulController {
  constructor({ defaultMood = "purple", defaultState = "idle", defaultThemeProfile = "amethyst" } = {}) {
    this._mood = String(defaultMood || "purple").toLowerCase();
    this._animationState = String(defaultState || "idle").toLowerCase();
    this._themeProfile = String(defaultThemeProfile || "amethyst").toLowerCase();
    this._listeners = new Set();
    this._pulseTimeout = null;
    this._moodTransitionTimeout = null;
    this._elementTransitionTimers = typeof WeakMap !== "undefined" ? new WeakMap() : null;
    this._moodObservers = typeof WeakMap !== "undefined" ? new WeakMap() : null;
    this._isApplyingMood = false;
  }

  getMood() {
    return this._mood;
  }

  getAnimationState() {
    return this._animationState;
  }

  getThemeProfile() {
    return this._themeProfile;
  }

  getAvailableThemeProfiles() {
    return Object.values(SOUL_THEME_PROFILES);
  }

  setThemeProfile(themeId, persist = true) {
    const norm = String(themeId || "").toLowerCase().trim();
    const profileKey = SOUL_THEME_PROFILES[norm] ? norm : "amethyst";
    const prev = this._themeProfile;
    this._themeProfile = profileKey;

    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-soul-theme", profileKey);

      const profile = SOUL_THEME_PROFILES[profileKey];
      if (profile && profile.variables) {
        for (const [key, val] of Object.entries(profile.variables)) {
          document.documentElement.style.setProperty(key, val);
        }
      }

      document.querySelectorAll(".alfie-soul").forEach((el) => {
        el.setAttribute("data-soul-theme", profileKey);
        el.dataset.soulTheme = profileKey;
      });

      this._updateThemeUI(profileKey);

      if (prev && prev !== profileKey) {
        this._transitionMood(prev, profileKey);
      }
    }

    if (persist) {
      try {
        localStorage.setItem(SOUL_THEME_STORAGE_KEY, profileKey);
      } catch {}
    }

    for (const listener of this._listeners) {
      try {
        listener({
          mood: this._mood,
          animationState: this._animationState,
          themeProfile: this._themeProfile
        });
      } catch (err) {
        console.error(err);
      }
    }

    return profileKey;
  }

  cycleThemeProfile() {
    const keys = Object.keys(SOUL_THEME_PROFILES);
    const idx = keys.indexOf(this._themeProfile);
    const next = keys[(idx + 1) % keys.length] || "amethyst";
    return this.setThemeProfile(next);
  }

  isMoodTransitioning() {
    return Boolean(this._moodTransitionTimeout);
  }

  getState() {
    return {
      mood: this._mood,
      animationState: this._animationState,
      themeProfile: this._themeProfile,
      isTransitioning: this.isMoodTransitioning()
    };
  }

  _prefersReducedMotion() {
    return typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  _triggerMoodTransitionOnElement(el, prevMood, newMood, durationMs = 560) {
    if (!el || !prevMood || !newMood || prevMood === newMood) return;
    if (this._prefersReducedMotion()) {
      el.classList.remove("mood-transitioning");
      delete el.dataset.prevMood;
      el.removeAttribute("data-prev-mood");
      return;
    }

    // Restart keyframe animation cleanly when moods cycle rapidly
    if (el.classList.contains("mood-transitioning")) {
      el.classList.remove("mood-transitioning");
      void el.offsetWidth;
    }
    el.dataset.prevMood = prevMood;
    el.setAttribute("data-prev-mood", prevMood);
    el.classList.add("mood-transitioning");

    if (this._elementTransitionTimers) {
      const existing = this._elementTransitionTimers.get(el);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        el.classList.remove("mood-transitioning");
        delete el.dataset.prevMood;
        el.removeAttribute("data-prev-mood");
        this._elementTransitionTimers.delete(el);
      }, durationMs);
      this._elementTransitionTimers.set(el, timer);
    }
  }

  _syncRootMood(mood) {
    if (typeof document === "undefined") return;
    const norm = String(mood || this._mood || "purple").toLowerCase().trim();
    if (!SOUL_MOODS.includes(norm)) return;
    document.documentElement.setAttribute("data-soul-mood", norm);
    const readout = document.getElementById("bg-theme-mood-readout");
    if (readout) {
      const label = norm.charAt(0).toUpperCase() + norm.slice(1);
      readout.textContent = `Mood tint: ${label}`;
    }
  }

  _observeMoodAttribute(element) {
    if (!element || typeof MutationObserver === "undefined" || !this._moodObservers) return;
    if (this._moodObservers.has(element)) return;
    const observer = new MutationObserver((mutations) => {
      if (this._isApplyingMood) return;
      for (const mutation of mutations) {
        if (mutation.type !== "attributes" || mutation.attributeName !== "data-mood") continue;
        const oldMood = String(mutation.oldValue || "").toLowerCase().trim();
        const nextMood = String(element.getAttribute("data-mood") || "").toLowerCase().trim();
        // Controller-originated mutations already use this._mood and have
        // their transition scheduled by _transitionMood(). Ignore their
        // observer echo so the same change is not animated twice.
        const isExternalMoodChange = nextMood !== this._mood;
        if (isExternalMoodChange && nextMood && SOUL_MOODS.includes(nextMood)) {
          this._mood = nextMood;
          this._syncRootMood(nextMood);
        }
        if (isExternalMoodChange && oldMood && nextMood && oldMood !== nextMood) {
          this._triggerMoodTransitionOnElement(element, oldMood, nextMood);
        }
      }
    });
    observer.observe(element, {
      attributes: true,
      attributeFilter: ["data-mood"],
      attributeOldValue: true
    });
    this._moodObservers.set(element, observer);
  }

  _transitionMood(prevMood, newMood) {
    if (prevMood === newMood) return;
    const durationMs = 560;
    if (typeof document !== "undefined") {
      document.querySelectorAll(".alfie-soul").forEach((el) => {
        this._triggerMoodTransitionOnElement(el, prevMood, newMood, durationMs);
      });
    }
    if (this._moodTransitionTimeout) {
      clearTimeout(this._moodTransitionTimeout);
    }
    if (this._prefersReducedMotion()) {
      this._moodTransitionTimeout = null;
      return;
    }
    this._moodTransitionTimeout = setTimeout(() => {
      if (typeof document !== "undefined") {
        document.querySelectorAll(".alfie-soul").forEach((el) => {
          el.classList.remove("mood-transitioning");
          delete el.dataset.prevMood;
          el.removeAttribute("data-prev-mood");
        });
      }
      this._moodTransitionTimeout = null;
    }, durationMs);
  }

  setMood(mood) {
    const norm = String(mood || "").toLowerCase().trim();
    if (!norm || !SOUL_MOODS.includes(norm)) return this._mood;
    if (this._mood === norm) return this._mood;
    const prevMood = this._mood;
    this._mood = norm;
    this._transitionMood(prevMood, norm);
    this._apply();
    return this._mood;
  }

  setAnimationState(state) {
    const norm = String(state || "").toLowerCase().trim();
    if (!norm || !SOUL_STATES.includes(norm)) return this._animationState;
    this._animationState = norm;
    this._apply();
    return this._animationState;
  }

  setState(animationState, mood = null) {
    if (this._pulseTimeout) {
      clearTimeout(this._pulseTimeout);
      this._pulseTimeout = null;
    }
    const normState = String(animationState || "").toLowerCase().trim();
    if (normState && SOUL_STATES.includes(normState)) {
      this._animationState = normState;
    }
    if (mood) {
      const normMood = String(mood).toLowerCase().trim();
      if (SOUL_MOODS.includes(normMood) && normMood !== this._mood) {
        const prevMood = this._mood;
        this._mood = normMood;
        this._transitionMood(prevMood, normMood);
      }
    }
    this._apply();
    return this.getState();
  }

  startThinking(mood = "amber") {
    return this.setState("thinking", mood);
  }

  startWorking(mood = "cyan") {
    return this.setState("working", mood);
  }

  startListening(mood = "purple") {
    return this.setState("listening", mood);
  }

  complete(durationMs = 2000, returnState = "idle", returnMood = "purple") {
    return this.pulse("completed", durationMs, returnState, returnMood);
  }

  setError(mood = "red") {
    return this.setState("error", mood);
  }

  setOffline(mood = "red") {
    return this.setState("offline", mood);
  }

  pulse(state, durationMs = 2000, returnState = "idle", returnMood = null) {
    if (this._pulseTimeout) {
      clearTimeout(this._pulseTimeout);
      this._pulseTimeout = null;
    }
    const prevMood = this._mood;
    this.setState(state);
    this._pulseTimeout = setTimeout(() => {
      this.setState(returnState, returnMood || prevMood);
      this._pulseTimeout = null;
    }, durationMs);
  }

  cycleMood() {
    const primaryMoods = ["purple", "blue", "red", "amber"];
    const idx = primaryMoods.indexOf(this._mood);
    const next = primaryMoods[(idx + 1) % primaryMoods.length] || "purple";
    this.setMood(next);
    return next;
  }

  attach(element) {
    if (!element) return;
    const core = element.querySelector(".soul-core");
    if (core && !core.querySelector(".poe-sprite")) {
      core.innerHTML = createPoeSpriteHtml(element.classList.contains("mini") ? "mini" : "large");
    }
    element.dataset.mood = this._mood;
    element.dataset.animationState = this._animationState;
    element.dataset.soulTheme = this._themeProfile;
    element.setAttribute("data-mood", this._mood);
    element.setAttribute("data-animation-state", this._animationState);
    element.setAttribute("data-soul-theme", this._themeProfile);
    element.setAttribute("aria-label", `Alfie Soul: ${this._themeProfile} palette, ${this._mood} mood, ${this._animationState} state`);
    if (this.isMoodTransitioning()) {
      element.classList.add("mood-transitioning");
    }
    this._observeMoodAttribute(element);
  }

  _updateThemeUI(activeProfile) {
    if (typeof document === "undefined") return;
    const buttons = document.querySelectorAll("[data-soul-theme-set]");
    buttons.forEach((btn) => {
      const isActive = btn.dataset.soulThemeSet === activeProfile;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-checked", String(isActive));
      const pill = btn.querySelector(".theme-status-pill");
      if (pill) {
        pill.textContent = isActive ? "Active" : "Select";
      }
    });
  }

  _apply() {
    if (typeof document === "undefined") return;
    this._isApplyingMood = true;
    try {
      document.querySelectorAll(".alfie-soul").forEach((el) => {
        this._observeMoodAttribute(el);
        el.dataset.mood = this._mood;
        el.dataset.animationState = this._animationState;
        el.dataset.soulTheme = this._themeProfile;
        el.setAttribute("data-mood", this._mood);
        el.setAttribute("data-animation-state", this._animationState);
        el.setAttribute("data-soul-theme", this._themeProfile);
        el.setAttribute("aria-label", `Alfie Soul: ${this._themeProfile} palette, ${this._mood} mood, ${this._animationState} state`);
      });
    } finally {
      this._isApplyingMood = false;
    }

    document.querySelectorAll(".mood-chip").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.setMood === this._mood);
    });

    this._syncRootMood(this._mood);
    this._updateThemeUI(this._themeProfile);

    for (const listener of this._listeners) {
      try {
        listener({
          mood: this._mood,
          animationState: this._animationState,
          themeProfile: this._themeProfile
        });
      } catch (err) {
        console.error(err);
      }
    }
  }

  init() {
    let saved = "amethyst";
    try {
      saved = localStorage.getItem(SOUL_THEME_STORAGE_KEY) || "amethyst";
    } catch {}
    this.setThemeProfile(saved, false);
    this._syncRootMood(this._mood);
    if (typeof document !== "undefined") {
      document.querySelectorAll(".alfie-soul").forEach((el) => this._observeMoodAttribute(el));
    }
  }

  subscribe(listener) {
    if (typeof listener === "function") {
      this._listeners.add(listener);
      return () => this._listeners.delete(listener);
    }
    return () => {};
  }
}

window.AlfieSoulController = AlfieSoulController;
window.SOUL_THEME_PROFILES = SOUL_THEME_PROFILES;
window.alfieSoul = new AlfieSoulController();
window.alfieSoul.init();

/* Theme Management & CSS Variables */
const THEME_STORAGE_KEY = "alfie_theme";
const BG_THEME_STORAGE_KEY = "alfie_bg_theme";

const BACKGROUND_THEMES = {
  nebula: {
    id: "nebula",
    name: "Soft Nebula"
  },
  "pixel-city": {
    id: "pixel-city",
    name: "Pixel City"
  },
  river: {
    id: "river",
    name: "Moonlit River"
  },
  zen: {
    id: "zen",
    name: "Zen Sanctuary"
  }
};

const THEME_DEFINITIONS = {
  dark: {
    "color-scheme": "dark",
    "--bg": "#0e0b19",
    "--panel": "#161227",
    "--panel-raised": "#1d1833",
    "--panel-hover": "#251f40",
    "--panel-active": "#2c254d",
    "--line": "rgba(184,164,255,.18)",
    "--line-strong": "rgba(184,164,255,.34)",
    "--text": "#f3efff",
    "--text-bright": "#ffffff",
    "--muted": "#998fae",
    "--muted-dark": "#6f6583",
    "--purple": "#b6a2ff",
    "--purple-strong": "#8069e7",
    "--purple-bright": "#c9baff",
    "--lavender": "#e2d8ff",
    "--orange": "#f2af74",
    "--red": "#f88995",
    "--green": "#7ddbb1",
    "--input-bg": "#110e20",
    "--sidebar-bg": "linear-gradient(180deg,rgba(21,17,37,.92),rgba(17,14,31,.94))",
    "--surface-bg": "linear-gradient(145deg,rgba(31,25,49,.82),rgba(21,17,34,.84))",
    "--surface-card-bg": "rgba(14,11,24,.64)",
    "--composer-bg": "linear-gradient(145deg,rgba(34,28,54,.96),rgba(23,19,38,.96))",
    "--composer-border": "rgba(182,162,255,.28)",
    "--user-msg-bg": "rgba(33,27,51,.75)",
    "--code-bg": "#110e1f",
    "--pre-bg": "#0d0a17",
    "--code-text": "#e8ddff",
    "--pre-text": "#e8e3f2",
    "--brand-bg": "linear-gradient(145deg,#292044,#171326)",
    "--bg-gradient": "radial-gradient(ellipse at 70% -10%,rgba(105,76,174,.18),transparent 45%),radial-gradient(ellipse at 15% 105%,rgba(82,53,142,.12),transparent 40%),var(--bg)",
    "--ambient-opacity": "0.14"
  },
  light: {
    "color-scheme": "light",
    "--bg": "#f5f2fa",
    "--panel": "#ffffff",
    "--panel-raised": "#f8f5fd",
    "--panel-hover": "#eee7f9",
    "--panel-active": "#e3d8f5",
    "--line": "rgba(128,105,231,.18)",
    "--line-strong": "rgba(128,105,231,.38)",
    "--text": "#221c35",
    "--text-bright": "#110c22",
    "--muted": "#695f7f",
    "--muted-dark": "#8a7f9f",
    "--purple": "#7052d4",
    "--purple-strong": "#6848cf",
    "--purple-bright": "#5333be",
    "--lavender": "#593db8",
    "--orange": "#b85912",
    "--red": "#d4354c",
    "--green": "#1b8858",
    "--input-bg": "#ffffff",
    "--sidebar-bg": "linear-gradient(180deg,rgba(250,248,255,.92),rgba(241,236,250,.94))",
    "--surface-bg": "linear-gradient(145deg,rgba(255,255,255,.92),rgba(249,246,253,.9))",
    "--surface-card-bg": "rgba(244,239,251,.84)",
    "--composer-bg": "linear-gradient(145deg,#ffffff,#faf7fd)",
    "--composer-border": "rgba(128,105,231,.32)",
    "--user-msg-bg": "rgba(235,228,252,.92)",
    "--code-bg": "#ede6fa",
    "--pre-bg": "#f3eefb",
    "--code-text": "#392470",
    "--pre-text": "#221c35",
    "--brand-bg": "linear-gradient(145deg,#ede6fa,#ded4f5)",
    "--bg-gradient": "radial-gradient(ellipse at 70% -10%,rgba(128,105,231,.10),transparent 50%),radial-gradient(ellipse at 15% 105%,rgba(128,105,231,.06),transparent 45%),var(--bg)",
    "--ambient-opacity": "0.07"
  }
};

class AlfieThemeController {
  constructor() {
    this._theme = "dark";
    this._bgTheme = "nebula";
    this._listeners = new Set();
  }

  getTheme() {
    return this._theme;
  }

  setTheme(theme, persist = true) {
    const selected = theme === "light" ? "light" : "dark";
    this._theme = selected;
    document.documentElement.setAttribute("data-theme", selected);
    document.documentElement.style.colorScheme = selected;

    const vars = THEME_DEFINITIONS[selected] || THEME_DEFINITIONS.dark;
    for (const [key, value] of Object.entries(vars)) {
      if (key.startsWith("--")) {
        document.documentElement.style.setProperty(key, value);
      }
    }

    if (persist) {
      try {
        localStorage.setItem(THEME_STORAGE_KEY, selected);
      } catch {}
    }

    this._updateUI(selected);
    for (const listener of this._listeners) {
      try { listener(selected); } catch {}
    }
    return selected;
  }

  toggleTheme() {
    return this.setTheme(this._theme === "light" ? "dark" : "light");
  }

  getBackgroundTheme() {
    return this._bgTheme;
  }

  setBackgroundTheme(bgId, persist = true) {
    const norm = String(bgId || "").toLowerCase().trim();
    const selected = Object.prototype.hasOwnProperty.call(BACKGROUND_THEMES, norm) ? norm : "nebula";
    this._bgTheme = selected;
    document.documentElement.setAttribute("data-bg-theme", selected);

    if (persist) {
      try {
        localStorage.setItem(BG_THEME_STORAGE_KEY, selected);
      } catch {}
    }

    this._updateBgUI(selected);
    for (const listener of this._listeners) {
      try { listener({ theme: this._theme, backgroundTheme: selected }); } catch {}
    }
    return selected;
  }

  _updateUI(theme) {
    const buttons = document.querySelectorAll("[data-theme-set]");
    buttons.forEach((button) => {
      const isActive = button.dataset.themeSet === theme;
      button.classList.toggle("active", isActive);
      button.setAttribute("aria-checked", String(isActive));
      const pill = button.querySelector(".theme-status-pill");
      if (pill) {
        pill.textContent = isActive ? "Active" : "Select";
      }
    });
  }

  _updateBgUI(bgTheme) {
    const buttons = document.querySelectorAll("[data-bg-theme-set]");
    buttons.forEach((button) => {
      const isActive = button.dataset.bgThemeSet === bgTheme;
      button.classList.toggle("active", isActive);
      button.setAttribute("aria-checked", String(isActive));
      const pill = button.querySelector(".theme-status-pill");
      if (pill) {
        pill.textContent = isActive ? "Active" : "Select";
      }
    });
  }

  init() {
    let saved = "dark";
    let savedBg = "nebula";
    try {
      saved = localStorage.getItem(THEME_STORAGE_KEY) || "dark";
      savedBg = localStorage.getItem(BG_THEME_STORAGE_KEY) || "nebula";
    } catch {}
    this.setTheme(saved, false);
    this.setBackgroundTheme(savedBg, false);
  }

  getSoulTheme() {
    return window.alfieSoul ? window.alfieSoul.getThemeProfile() : "amethyst";
  }

  setSoulTheme(theme) {
    return window.alfieSoul ? window.alfieSoul.setThemeProfile(theme) : theme;
  }

  subscribe(listener) {
    if (typeof listener === "function") {
      this._listeners.add(listener);
      return () => this._listeners.delete(listener);
    }
    return () => {};
  }
}

window.BACKGROUND_THEMES = BACKGROUND_THEMES;
window.alfieTheme = new AlfieThemeController();
window.alfieTheme.init();

/* Delegated click handler for navigation menus, Soul orbs, mood chips, theme toggle, soul palette profile, and background scene buttons */
document.addEventListener("click", (event) => {
  const navItem = event.target.closest(".nav-item, [data-view]");
  if (navItem && navItem.dataset.view) {
    setView(navItem.dataset.view);
    return;
  }
  const themeBtn = event.target.closest("[data-theme-set]");
  if (themeBtn) {
    const targetTheme = themeBtn.dataset.themeSet;
    window.alfieTheme.setTheme(targetTheme);
    toast("Switched to " + (targetTheme === "light" ? "Light" : "Dark") + " theme");
    return;
  }
  const bgThemeBtn = event.target.closest("[data-bg-theme-set]");
  if (bgThemeBtn) {
    const targetBg = bgThemeBtn.dataset.bgThemeSet;
    window.alfieTheme.setBackgroundTheme(targetBg);
    const bgName = BACKGROUND_THEMES[targetBg]?.name || targetBg;
    toast("Background set to " + bgName);
    return;
  }
  const soulThemeBtn = event.target.closest("[data-soul-theme-set]");
  if (soulThemeBtn) {
    const targetProfile = soulThemeBtn.dataset.soulThemeSet;
    window.alfieSoul.setThemeProfile(targetProfile);
    const profileName = SOUL_THEME_PROFILES[targetProfile]?.name || targetProfile;
    toast("Switched to " + profileName + " soul palette");
    return;
  }
  const soul = event.target.closest("[data-soul]");
  if (soul) {
    window.alfieSoul.cycleMood();
    return;
  }
  const moodBtn = event.target.closest("[data-set-mood]");
  if (moodBtn) {
    window.alfieSoul.setMood(moodBtn.dataset.setMood);
    return;
  }
  const promptBtn = event.target.closest("[data-prompt]");
  if (promptBtn && promptBtn.dataset.prompt) {
    sendMessage(promptBtn.dataset.prompt);
    return;
  }
  const ideaCmdBtn = event.target.closest("#idea-cmd-btn");
  if (ideaCmdBtn) {
    const input = $("#chat-form")?.elements?.message;
    if (input) {
      input.value = "/idea ";
      input.focus();
      if (typeof input.setSelectionRange === "function") input.setSelectionRange(input.value.length, input.value.length);
      const suggestions = $("#composer-suggestions");
      if (suggestions) suggestions.hidden = true;
    }
    return;
  }
  const imgCmdBtn = event.target.closest("#image-cmd-btn");
  if (imgCmdBtn) {
    const input = $("#chat-form")?.elements?.message;
    if (input) {
      input.value = "/image ";
      input.focus();
      if (typeof input.setSelectionRange === "function") input.setSelectionRange(input.value.length, input.value.length);
      const suggestions = $("#composer-suggestions");
      if (suggestions) suggestions.hidden = true;
    }
    return;
  }
  const cmdBtn = event.target.closest("[data-cmd]");
  if (cmdBtn && cmdBtn.dataset.cmd) {
    const input = $("#chat-form")?.elements?.message;
    if (input) {
      input.value = cmdBtn.dataset.cmd;
      input.focus();
      if (typeof input.setSelectionRange === "function") input.setSelectionRange(input.value.length, input.value.length);
      const suggestions = $("#composer-suggestions");
      if (suggestions) suggestions.hidden = true;
    }
    return;
  }
  if (!event.target.closest("#chat-form")) {
    const suggestions = $("#composer-suggestions");
    if (suggestions) suggestions.hidden = true;
  }
});

document.addEventListener("keydown", (event) => {
  if ((event.key === "Enter" || event.key === " ") && event.target?.matches?.("[data-soul]")) {
    event.preventDefault();
    window.alfieSoul?.cycleMood();
  }
});

/* Online/offline window events */
window.addEventListener("offline", () => {
  setConnection(false, "Offline");
  window.alfieSoul?.setState("offline", "red");
  const banner = $("#garden-offline-banner");
  if (banner && state.view === "garden") banner.hidden = false;
  toast("Disconnected from server. Offline cache active.");
});

window.addEventListener("online", () => {
  setConnection(true, "Connected");
  window.alfieSoul?.pulse("completed", 2800, "idle", "purple");
  const banner = $("#garden-offline-banner");
  if (banner) banner.hidden = true;
  toast("Connection restored.");
});

function resetLoginPasswordVisibility() {
  const pwInput = $("#login-password");
  const toggleBtn = $("#toggle-password");
  if (!pwInput || !toggleBtn) return;
  pwInput.type = "password";
  toggleBtn.setAttribute("aria-pressed", "false");
  toggleBtn.setAttribute("aria-label", "Show password");
  toggleBtn.setAttribute("title", "Show password");
  const eye = toggleBtn.querySelector(".icon-eye");
  const eyeOff = toggleBtn.querySelector(".icon-eye-off");
  if (eye) eye.toggleAttribute("hidden", false);
  if (eyeOff) eyeOff.toggleAttribute("hidden", true);
}

function resetLoginCursorOffset() {
  const stage = $("#login-soul-stage");
  if (!stage) return;
  stage.style.setProperty("--soul-look-x", "0px");
  stage.style.setProperty("--soul-look-y", "0px");
}

function showLogin({ setupRequired = false } = {}) {
  const loginScreen = $("#login-screen");
  const appShell = $("#app-shell");
  const loginForm = $("#login-form");
  const setupForm = $("#setup-form");
  const setupMessage = $("#setup-message");
  const heading = $("#login-heading");
  const subtitle = $(".login-subtitle");
  if (loginScreen) {
    loginScreen.classList.remove("is-leaving", "is-form-focused");
    loginScreen.hidden = false;
  }
  if (appShell) {
    appShell.classList.remove("is-entering");
    appShell.hidden = true;
  }
  if (loginForm) loginForm.hidden = Boolean(setupRequired);
  if (setupForm) setupForm.hidden = !setupRequired;
  if (setupMessage) setupMessage.hidden = !setupRequired;
  if (heading) heading.textContent = setupRequired ? "Welcome to Alfie." : "Welcome back.";
  if (subtitle) subtitle.textContent = setupRequired ? "Create your private administrator account." : "Your space is ready.";
  resetLoginPasswordVisibility();
  resetLoginCursorOffset();
}

function showApp({ animate = false } = {}) {
  const loginScreen = $("#login-screen");
  const appShell = $("#app-shell");
  if (loginScreen) {
    loginScreen.classList.remove("is-leaving", "is-form-focused");
    loginScreen.hidden = true;
  }
  if (appShell) {
    appShell.hidden = false;
    if (animate) {
      appShell.classList.remove("is-entering");
      void appShell.offsetWidth;
      appShell.classList.add("is-entering");
      setTimeout(() => appShell.classList.remove("is-entering"), 420);
    }
  }
  resetLoginPasswordVisibility();
  resetLoginCursorOffset();
  $("#user-name").textContent = state.user?.displayName || state.user?.username || "Account";
}

function transitionToApp() {
  const loginScreen = $("#login-screen");
  const reducedMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.alfieSoul?.complete(2200, "idle", "purple");
  if (!loginScreen || loginScreen.hidden || reducedMotion) {
    showApp({ animate: !reducedMotion });
    return Promise.resolve();
  }
  loginScreen.classList.add("is-leaving");
  return new Promise((resolve) => {
    setTimeout(() => {
      showApp({ animate: true });
      resolve();
    }, 260);
  });
}

function initLoginCompanion() {
  document.querySelectorAll(".alfie-soul").forEach((el) => window.alfieSoul?.attach(el));
  const loginScreen = $("#login-screen");
  const loginForms = [$("#login-form"), $("#setup-form")].filter(Boolean);
  const soulStage = $("#login-soul-stage");
  const toggleBtn = $("#toggle-password");
  const pwInput = $("#login-password");

  if (toggleBtn && pwInput) {
    toggleBtn.addEventListener("click", () => {
      const revealing = pwInput.type === "password";
      pwInput.type = revealing ? "text" : "password";
      toggleBtn.setAttribute("aria-pressed", String(revealing));
      toggleBtn.setAttribute("aria-label", revealing ? "Hide password" : "Show password");
      toggleBtn.setAttribute("title", revealing ? "Hide password" : "Show password");
      const eye = toggleBtn.querySelector(".icon-eye");
      const eyeOff = toggleBtn.querySelector(".icon-eye-off");
      if (eye) eye.toggleAttribute("hidden", revealing);
      if (eyeOff) eyeOff.toggleAttribute("hidden", !revealing);
      pwInput.focus();
    });
  }

  if (loginScreen && loginForms.length) {
    for (const form of loginForms) {
      form.addEventListener("focusin", () => {
        loginScreen.classList.add("is-form-focused");
        if (window.alfieSoul?.getAnimationState() === "idle") {
          window.alfieSoul.setAnimationState("listening");
        }
      });
      form.addEventListener("focusout", (event) => {
        if (event.relatedTarget && form.contains(event.relatedTarget)) return;
        loginScreen.classList.remove("is-form-focused");
        if (window.alfieSoul?.getAnimationState() === "listening") {
          window.alfieSoul.setAnimationState("idle");
        }
      });
    }
  }

  if (loginScreen && soulStage) {
    let rafId = 0;
    let pendingEvent = null;
    loginScreen.addEventListener("pointermove", (event) => {
      if (loginScreen.hidden || event.pointerType === "touch") return;
      if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        return;
      }
      pendingEvent = { clientX: event.clientX, clientY: event.clientY };
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        if (!pendingEvent || loginScreen.hidden) return;
        const rect = soulStage.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const nx = Math.max(-1, Math.min(1, (pendingEvent.clientX - cx) / 280));
        const ny = Math.max(-1, Math.min(1, (pendingEvent.clientY - cy) / 260));
        soulStage.style.setProperty("--soul-look-x", (nx * 4.5).toFixed(2) + "px");
        soulStage.style.setProperty("--soul-look-y", (ny * 3.0).toFixed(2) + "px");
      });
    });
    loginScreen.addEventListener("pointerleave", () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      pendingEvent = null;
      resetLoginCursorOffset();
    });
  }
}

initLoginCompanion();

function setView(view) {
  state.view = view;
  const linkReq = $("#link-required");
  const isChatUnlinked = view === "chat" && !state.linked;
  if (linkReq) linkReq.hidden = !isChatUnlinked;

  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  document.querySelectorAll(".view").forEach((section) => {
    if (isChatUnlinked) {
      section.hidden = true;
    } else {
      section.hidden = section.id !== "view-" + view;
    }
  });
  const titles = { chat: isChatUnlinked ? "Connect account" : "Chat", ideas: "Ideas Vault", garden: "The Garden", tools: "Tools & access", settings: "Settings" };
  $("#view-title").textContent = titles[view] || "Alfie";
  const mobileHistory = $("#mobile-history-sheet");
  if (mobileHistory) mobileHistory.hidden = true;
  if (view === "ideas") loadIdeas();
  if (view === "garden") {
    loadMemories();
    loadKnowledgeGraph();
    loadReflections();
    loadTimeline();
    if ($("#virtual-room-details")?.open) loadVirtualRoom();
  }
  if (view === "tools") loadToolsAndApprovals();
  if (view === "settings") {
    loadSettings();
    window.alfieTheme?._updateUI(window.alfieTheme.getTheme());
    renderShortcutSettings?.();
  } else {
    cancelShortcutRecording?.();
  }
}

function showLinkRequired() {
  state.linked = false;
  if (!state.view || state.view === "chat") {
    const linkReq = $("#link-required");
    if (linkReq) linkReq.hidden = false;
    document.querySelectorAll(".view").forEach((section) => { section.hidden = true; });
    $("#view-title").textContent = "Connect account";
  } else {
    setView(state.view);
  }
  setConnection(false, "Account not linked", { offline: false });
}

function showWorkspace() {
  state.linked = true;
  const linkReq = $("#link-required");
  if (linkReq) linkReq.hidden = true;
  setView(state.view || "chat");
  setConnection(true, "Connected");
}

async function refreshIdentity() {
  const who = await api("/api/core/whoami");
  state.linked = Boolean(who.linked);
  if (state.linked) showWorkspace();
  else showLinkRequired();
  return who;
}

async function initialise() {
  try {
    const session = await api("/api/auth/me");
    if (session.setupRequired) {
      showLogin({ setupRequired: true });
      return;
    }
    if (!session.authenticated) {
      showLogin({ setupRequired: false });
      return;
    }
    state.user = session.user;
    state.csrfToken = session.csrfToken;
    showApp();
    try {
      await refreshIdentity();
      if (state.linked) {
        await loadWorkspaceData();
      }
    } catch (error) {
      setConnection(false, "Core unavailable");
      toast(error.message);
    }
  } catch (error) {
    showLogin({ setupRequired: false });
    $("#login-error").textContent = error.message;
  }
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formEl = event.currentTarget;
  const form = new FormData(formEl);
  const button = formEl.querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  $("#login-error").textContent = "";
  window.alfieSoul?.startThinking("amber");
  try {
    const result = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: form.get("username"), password: form.get("password") })
    });
    state.user = result.user;
    state.csrfToken = result.csrfToken;
    await transitionToApp();
    await refreshIdentity();
    if (state.linked) await loadWorkspaceData();
  } catch (error) {
    $("#login-error").textContent = error.message;
    window.alfieSoul?.pulse("error", 1600, "idle", "purple");
  } finally {
    if (button) button.disabled = false;
  }
});

$("#setup-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formEl = event.currentTarget;
  const form = new FormData(formEl);
  const username = String(form.get("username") || "").trim();
  const password = String(form.get("password") || "");
  const confirmPassword = String(form.get("confirmPassword") || "");
  const errorEl = $("#login-error");
  errorEl.textContent = "";
  if (password !== confirmPassword) {
    errorEl.textContent = "The passwords do not match.";
    window.alfieSoul?.pulse("error", 1600, "idle", "purple");
    return;
  }
  const button = formEl.querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  window.alfieSoul?.startThinking("amber");
  try {
    const result = await api("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
    formEl.reset();
    state.user = result.user;
    state.csrfToken = result.csrfToken;
    await transitionToApp();
    await refreshIdentity();
    if (state.linked) await loadWorkspaceData();
  } catch (error) {
    errorEl.textContent = error.message;
    window.alfieSoul?.pulse("error", 1600, "idle", "purple");
  } finally {
    if (button) button.disabled = false;
  }
});

async function logout() {
  stopVramPolling();
  try { await api("/api/auth/logout", { method: "POST", body: "{}" }); }
  catch (error) { toast(error.message); }
  state.user = null;
  state.csrfToken = "";
  state.linked = false;
  state.activeConversationId = null;
  state.activeConversation = null;
  state.conversations = [];
  state.projects = [];
  state.selectedProjectId = "all";
  state.pendingApprovalConversations.clear();
  state.vram = null;
  state.vramDismissedKey = null;
  state.vramLastAlerted = false;
  state.cloudAgents = [];
  state.selectedAgentProvider = "local";
  state.conversationLoadToken += 1;
  state.conversationLoading = false;
  state.messages = [];
  renderConversations([]);
  renderMessages();
  renderVramStatus();
  syncAgentSelector();
  showLogin();
}

$("#password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const currentPassword = form.elements.currentPassword.value;
  const newPassword = form.elements.newPassword.value;
  const confirmPassword = form.elements.confirmPassword.value;
  const error = $("#password-error");
  error.textContent = "";
  if (newPassword !== confirmPassword) {
    error.textContent = "The new passwords do not match.";
    return;
  }
  const button = form.querySelector("button[type='submit']");
  button.disabled = true;
  try {
    await api("/api/auth/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword })
    });
    stopVramPolling();
    form.reset();
    state.user = null;
    state.csrfToken = "";
    state.linked = false;
    state.activeConversationId = null;
    state.activeConversation = null;
    state.conversations = [];
    state.projects = [];
    state.selectedProjectId = "all";
    state.pendingApprovalConversations.clear();
    state.vram = null;
    state.vramDismissedKey = null;
    state.vramLastAlerted = false;
    state.cloudAgents = [];
    state.selectedAgentProvider = "local";
    state.conversationLoadToken += 1;
    state.conversationLoading = false;
    state.messages = [];
    renderConversations([]);
    renderMessages();
    renderVramStatus();
    syncAgentSelector();
    showLogin();
    $("#login-error").textContent = "Password updated. Sign in again with your new password.";
  } catch (failure) {
    error.textContent = failure.message;
  } finally {
    button.disabled = false;
  }
});

$("#logout-button").addEventListener("click", logout);
$("#mobile-logout").addEventListener("click", logout);
$("#mobile-new-chat").addEventListener("click", () => newConversation().catch((error) => toast(error.message)));
$("#mobile-history-button").addEventListener("click", (event) => {
  event.stopPropagation();
  const sheet = $("#mobile-history-sheet");
  sheet.hidden = !sheet.hidden;
  if (!sheet.hidden) $("#mobile-history-search")?.focus();
});
$("#mobile-history-close").addEventListener("click", () => { $("#mobile-history-sheet").hidden = true; });
document.addEventListener("click", (event) => {
  const sheet = $("#mobile-history-sheet");
  if (!sheet.hidden && !sheet.contains(event.target) && !$("#mobile-history-button").contains(event.target)) {
    sheet.hidden = true;
  }
});

$("#standalone-button").addEventListener("click", async () => {
  const button = $("#standalone-button");
  const error = $("#standalone-error");
  error.textContent = "";
  button.disabled = true;
  try {
    await api("/api/auth/standalone", { method: "POST", body: "{}" });
    state.linked = true;
    toast("Your independent Alfie workspace is ready.");
    await refreshIdentity();
    await loadWorkspaceData();
  } catch (failure) {
    error.textContent = failure.message;
  } finally {
    button.disabled = false;
  }
});

$("#link-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formEl = event.currentTarget;
  const form = new FormData(formEl);
  const button = formEl.querySelector("button");
  button.disabled = true;
  $("#link-error").textContent = "";
  try {
    await api("/api/auth/link", { method: "POST", body: JSON.stringify({ code: String(form.get("code") || "").trim().toUpperCase() }) });
    state.linked = true;
    formEl.reset();
    toast("Your standalone interface is now linked to Petrio.");
    await refreshIdentity();
    await loadWorkspaceData();
  } catch (error) {
    $("#link-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.view));
});

$("#model-mode")?.addEventListener("change", (e) => {
  try {
    localStorage.setItem("alfie_model_mode", e.target.value);
  } catch {}
  toast("Model routing mode: " + String(e.target.value).toUpperCase());
});
try {
  const savedMode = localStorage.getItem("alfie_model_mode");
  if (savedMode && $("#model-mode")) $("#model-mode").value = savedMode;
} catch {}

function findProjectById(projectId) {
  if (!projectId) return null;
  return state.projects.find((item) => item.id === projectId) || null;
}

function getConversationProjectId(conversation) {
  return conversation?.projectId || null;
}

function getProjectChatCount(projectId) {
  if (projectId === "all") return state.conversations.length;
  if (projectId === "unassigned") return state.conversations.filter((item) => !item.projectId).length;
  return state.conversations.filter((item) => item.projectId === projectId).length;
}

function syncChatContextBar() {
  const select = $("#chat-project-select");
  const dossierBtn = $("#chat-project-dossier-btn");
  const exportBtn = $("#export-chat-btn");
  const continueBtn = $("#continue-chat-btn");
  let resolvedProject = null;
  if (select) {
    const activeProjectId = getConversationProjectId(state.activeConversation)
      || (state.selectedProjectId !== "all" && state.selectedProjectId !== "unassigned" ? state.selectedProjectId : "");
    select.replaceChildren();
    const unassignedOption = document.createElement("option");
    unassignedOption.value = "";
    unassignedOption.textContent = "No project";
    select.appendChild(unassignedOption);
    for (const project of state.projects) {
      const opt = document.createElement("option");
      opt.value = project.id;
      opt.textContent = project.name;
      select.appendChild(opt);
    }
    resolvedProject = state.projects.find((p) => p.id === activeProjectId) || null;
    select.value = resolvedProject ? resolvedProject.id : "";
  }
  if (dossierBtn) {
    dossierBtn.hidden = !resolvedProject;
    if (resolvedProject) {
      dossierBtn.title = `Open Living Project Dossier for ${resolvedProject.name}`;
      dossierBtn.setAttribute("aria-label", `Open dossier for ${resolvedProject.name}`);
    }
  }
  const hasExportableContent = Boolean(state.messages.length > 0 || state.activeConversation?.handoffContext);
  if (exportBtn) {
    exportBtn.disabled = !hasExportableContent || state.conversationLoading;
  }
  if (continueBtn) {
    const canContinue = Boolean(state.activeConversationId && hasExportableContent);
    continueBtn.disabled = !canContinue || state.sending || state.conversationLoading;
  }
}

function syncNewChatButtonLabel() {
  const newChatBtn = $("#new-chat");
  const heading = $("#recent-chats-heading");
  const activeProject = state.selectedProjectId !== "all" && state.selectedProjectId !== "unassigned"
    ? findProjectById(state.selectedProjectId)
    : null;
  if (newChatBtn) {
    newChatBtn.replaceChildren();
    const plus = document.createElement("span");
    plus.textContent = "＋";
    const label = document.createElement("span");
    label.className = "new-chat-label";
    label.textContent = activeProject ? `New in ${activeProject.name}` : "New conversation";
    newChatBtn.title = activeProject ? `Start a new conversation in ${activeProject.name}` : "Start a new conversation";
    newChatBtn.append(plus, label);
  }
  if (heading) {
    if (activeProject) heading.textContent = activeProject.name.toUpperCase();
    else if (state.selectedProjectId === "unassigned") heading.textContent = "UNASSIGNED CHATS";
    else heading.textContent = "RECENT CHATS";
  }
}

function renderProjectList(host) {
  if (!host) return;
  host.replaceChildren();

  function buildFilterRow({ id, name, color = "neutral", count = 0, project = null }) {
    const row = document.createElement("div");
    row.className = "project-row";
    row.setAttribute("role", "listitem");

    const button = document.createElement("button");
    button.type = "button";
    button.className = "project-item" + (state.selectedProjectId === id ? " active" : "");
    button.dataset.projectFilter = id;

    const dot = document.createElement("span");
    dot.className = "project-accent-dot";
    dot.dataset.color = color;
    dot.setAttribute("aria-hidden", "true");

    const label = document.createElement("span");
    label.className = "project-item-name";
    label.textContent = name;

    const countSpan = document.createElement("span");
    countSpan.className = "project-item-count";
    countSpan.textContent = String(count);

    button.append(dot, label, countSpan);
    button.addEventListener("click", () => {
      state.selectedProjectId = id;
      renderProjects();
      renderConversations(state.conversations);
      syncNewChatButtonLabel();
      syncChatContextBar();
    });
    row.appendChild(button);

    if (project) {
      const actions = document.createElement("div");
      actions.className = "project-actions";

      const addChatBtn = document.createElement("button");
      addChatBtn.type = "button";
      addChatBtn.className = "project-action-btn";
      addChatBtn.textContent = "＋";
      addChatBtn.title = `New chat in ${project.name}`;
      addChatBtn.setAttribute("aria-label", `New chat in ${project.name}`);
      addChatBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        state.selectedProjectId = project.id;
        renderProjects();
        syncNewChatButtonLabel();
        newConversation({ projectId: project.id }).catch((error) => toast(error.message));
      });

      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "project-action-btn";
      editBtn.textContent = "✎";
      editBtn.title = `Edit ${project.name}`;
      editBtn.setAttribute("aria-label", `Edit project ${project.name}`);
      editBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        openProjectModal(project);
      });

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "project-action-btn delete";
      deleteBtn.textContent = "×";
      deleteBtn.title = `Delete ${project.name}`;
      deleteBtn.setAttribute("aria-label", `Delete project ${project.name}`);
      deleteBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteProject(project.id, project.name);
      });

      actions.append(addChatBtn, editBtn, deleteBtn);
      row.appendChild(actions);
    }

    return row;
  }

  host.appendChild(buildFilterRow({
    id: "all",
    name: "All chats",
    color: "neutral",
    count: getProjectChatCount("all")
  }));

  for (const project of state.projects) {
    host.appendChild(buildFilterRow({
      id: project.id,
      name: project.name,
      color: project.color || "purple",
      count: getProjectChatCount(project.id),
      project
    }));
  }

  if (state.projects.length > 0) {
    host.appendChild(buildFilterRow({
      id: "unassigned",
      name: "Unassigned",
      color: "neutral",
      count: getProjectChatCount("unassigned")
    }));
  }
}

function syncIdeaProjectOptions() {
  const select = $("#idea-project-select");
  if (select) {
    const current = select.value;
    select.replaceChildren();
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "Unlinked";
    select.appendChild(none);
    for (const project of state.projects) {
      const opt = document.createElement("option");
      opt.value = project.id;
      opt.textContent = project.name;
      select.appendChild(opt);
    }
    select.value = state.projects.some((p) => p.id === current) ? current : "";
  }

  const filterSelect = $("#idea-project-filter");
  if (filterSelect) {
    const currentFilter = state.ideaProjectFilter || "all";
    filterSelect.replaceChildren();
    const allOpt = document.createElement("option");
    allOpt.value = "all";
    allOpt.textContent = "All projects";
    const unlinkedOpt = document.createElement("option");
    unlinkedOpt.value = "unassigned";
    unlinkedOpt.textContent = "Unlinked";
    filterSelect.append(allOpt, unlinkedOpt);
    for (const project of state.projects) {
      const opt = document.createElement("option");
      opt.value = project.id;
      opt.textContent = project.name;
      filterSelect.appendChild(opt);
    }
    const valid = currentFilter === "all" || currentFilter === "unassigned" || state.projects.some((p) => p.id === currentFilter);
    state.ideaProjectFilter = valid ? currentFilter : "all";
    filterSelect.value = state.ideaProjectFilter;
  }

  const leaseProject = $("#permission-lease-project");
  if (leaseProject) {
    const currentLeaseProj = leaseProject.value || "";
    leaseProject.replaceChildren();
    const allOpt = document.createElement("option");
    allOpt.value = "";
    allOpt.textContent = "All projects";
    leaseProject.appendChild(allOpt);
    for (const project of state.projects) {
      const opt = document.createElement("option");
      opt.value = project.id;
      opt.textContent = project.name;
      leaseProject.appendChild(opt);
    }
    leaseProject.value = state.projects.some((p) => p.id === currentLeaseProj) ? currentLeaseProj : "";
  }

  const capsuleProject = $("#capsule-project-select");
  if (capsuleProject) {
    const currentCapsuleProj = capsuleProject.value || "";
    capsuleProject.replaceChildren();
    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "No project";
    capsuleProject.appendChild(noneOpt);
    for (const project of state.projects) {
      const opt = document.createElement("option");
      opt.value = project.id;
      opt.textContent = project.name;
      capsuleProject.appendChild(opt);
    }
    capsuleProject.value = state.projects.some((p) => p.id === currentCapsuleProj) ? currentCapsuleProj : "";
  }

  const kgProject = $("#kg-project-filter");
  if (kgProject) {
    const currentKgProj = state.kgProjectFilter || kgProject.value || "";
    kgProject.replaceChildren();
    const allOpt = document.createElement("option");
    allOpt.value = "";
    allOpt.textContent = "All projects";
    kgProject.appendChild(allOpt);
    for (const project of state.projects) {
      const opt = document.createElement("option");
      opt.value = project.id;
      opt.textContent = project.name;
      kgProject.appendChild(opt);
    }
    const valid = state.projects.some((p) => p.id === currentKgProj);
    state.kgProjectFilter = valid ? currentKgProj : "";
    kgProject.value = state.kgProjectFilter;
  }

  const workshopProject = $("#workshop-project-select");
  if (workshopProject) {
    const currentWorkshopProj = workshopProject.value || "";
    workshopProject.replaceChildren();
    const allOpt = document.createElement("option");
    allOpt.value = "";
    allOpt.textContent = "All projects";
    workshopProject.appendChild(allOpt);
    for (const project of state.projects) {
      const opt = document.createElement("option");
      opt.value = project.id;
      opt.textContent = project.name;
      workshopProject.appendChild(opt);
    }
    workshopProject.value = state.projects.some((p) => p.id === currentWorkshopProj) ? currentWorkshopProj : "";
  }

  if ($("#watcher-kind-select")?.value === "project_stall" && typeof renderWatcherConfigFields === "function") {
    renderWatcherConfigFields();
  }
}

function renderProjects() {
  renderProjectList($("#project-list"));
  renderProjectList($("#mobile-project-list"));
  syncNewChatButtonLabel();
  syncChatContextBar();
  syncIdeaProjectOptions();
}

async function loadProjects() {
  const payload = await api("/api/core/projects");
  state.projects = Array.isArray(payload.projects) ? payload.projects : [];
  if (state.selectedProjectId !== "all" && state.selectedProjectId !== "unassigned") {
    if (!state.projects.some((item) => item.id === state.selectedProjectId)) {
      state.selectedProjectId = "all";
    }
  }
  renderProjects();
}

let projectModalColor = "purple";

function setProjectModalColor(color) {
  projectModalColor = color || "purple";
  document.querySelectorAll("#project-color-choices .project-color-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.projectColor === projectModalColor);
  });
}

function formatDecisionsForInput(decisions) {
  if (!Array.isArray(decisions) || !decisions.length) return "";
  return decisions.map((d) => (d.rationale ? `${d.summary} — ${d.rationale}` : d.summary)).join("\n");
}

let lastFocusBeforeProjectModal = null;
let projectDossierAutoSaver = null;

function renderProjectAutoSaveStatus(snap) {
  const el = $("#project-autosave-status");
  if (!el) return;
  if (!snap || snap.state === "disabled") {
    el.hidden = true;
    el.textContent = "";
    el.dataset.state = "disabled";
    return;
  }
  el.hidden = false;
  el.dataset.state = snap.state;
  if (snap.state === "saving") {
    el.textContent = "Saving…";
  } else if (snap.state === "pending") {
    el.textContent = "Unsaved changes…";
  } else if (snap.state === "saved") {
    const stamp = snap.savedAt ? new Date(snap.savedAt) : new Date();
    const label = Number.isNaN(stamp.getTime())
      ? "Saved"
      : `Saved ${stamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    el.textContent = label;
  } else if (snap.state === "invalid") {
    el.textContent = snap.error || "Project name required";
  } else if (snap.state === "error") {
    el.textContent = snap.error || "Auto-save failed";
  } else {
    el.textContent = "Auto-save on";
  }
}

function collectProjectDossierPayload() {
  const form = $("#project-form");
  if (!form) return null;
  return {
    name: String(form.elements.name?.value || "").trim(),
    status: String(form.elements.status?.value || "active").trim(),
    vision: String(form.elements.vision?.value || "").trim(),
    description: String(form.elements.description?.value || "").trim(),
    architecture: String(form.elements.architecture?.value || "").trim(),
    nextActions: String(form.elements.nextActions?.value || ""),
    blockers: String(form.elements.blockers?.value || ""),
    decisions: String(form.elements.decisions?.value || ""),
    postponed: String(form.elements.postponed?.value || ""),
    color: projectModalColor
  };
}

function syncUpdatedProjectInState(updatedProject) {
  if (!updatedProject?.id) return;
  const idx = state.projects.findIndex((item) => item.id === updatedProject.id);
  if (idx >= 0) {
    state.projects[idx] = updatedProject;
  } else {
    state.projects.unshift(updatedProject);
  }
  state.projects.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  renderProjects();
  renderConversations(state.conversations);
}

function getProjectDossierAutoSaver() {
  if (projectDossierAutoSaver) return projectDossierAutoSaver;
  const factory = window.AlfieDossierAutoSave?.createDossierAutoSaver;
  if (typeof factory !== "function") return null;
  projectDossierAutoSaver = factory({
    debounceMs: 650,
    persist: async (projectId, payload) => {
      const errEl = $("#project-form-error");
      const res = await api("/api/core/projects/" + encodeURIComponent(projectId), {
        method: "PATCH",
        body: JSON.stringify(payload)
      });
      if (errEl) errEl.textContent = "";
      if (res?.project) syncUpdatedProjectInState(res.project);
      return res;
    },
    onStateChange: (snap) => {
      renderProjectAutoSaveStatus(snap);
    }
  });
  return projectDossierAutoSaver;
}

function scheduleProjectDossierAutoSave() {
  const form = $("#project-form");
  if (!form) return;
  const projectId = String(form.elements.projectId?.value || "").trim();
  if (!projectId) return;
  const payload = collectProjectDossierPayload();
  if (!payload) return;
  getProjectDossierAutoSaver()?.schedule(payload);
}

function openProjectModal(project = null) {
  const modal = $("#project-modal");
  const form = $("#project-form");
  const title = $("#project-modal-title");
  const submit = $("#project-submit-btn");
  const cancelBtn = $("#project-cancel-btn");
  const err = $("#project-form-error");
  if (!modal || !form) return;
  lastFocusBeforeProjectModal = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  form.reset();
  if (err) err.textContent = "";
  form.elements.projectId.value = project?.id || "";
  form.elements.name.value = project?.name || "";
  if (form.elements.status) form.elements.status.value = project?.status || "active";
  if (form.elements.vision) form.elements.vision.value = project?.vision || "";
  form.elements.description.value = project?.description || "";
  if (form.elements.architecture) form.elements.architecture.value = project?.architecture || "";
  if (form.elements.nextActions) form.elements.nextActions.value = Array.isArray(project?.nextActions) ? project.nextActions.join("\n") : "";
  if (form.elements.blockers) form.elements.blockers.value = Array.isArray(project?.blockers) ? project.blockers.join("\n") : "";
  if (form.elements.decisions) form.elements.decisions.value = formatDecisionsForInput(project?.decisions);
  if (form.elements.postponed) form.elements.postponed.value = Array.isArray(project?.postponed) ? project.postponed.join("\n") : "";
  setProjectModalColor(project?.color || "purple");
  if (title) title.textContent = project ? "Edit project dossier" : "New project";
  if (submit) submit.textContent = project ? "Save dossier" : "Create project";
  if (cancelBtn) cancelBtn.textContent = project ? "Close" : "Cancel";

  const saver = getProjectDossierAutoSaver();
  if (saver) {
    saver.reset(project?.id || "", project ? collectProjectDossierPayload() : null);
  } else {
    renderProjectAutoSaveStatus({ state: "disabled" });
  }

  modal.hidden = false;
  $("#mobile-history-sheet").hidden = true;
  $("#project-name-input")?.focus();
}

function closeProjectModal({ flush = true } = {}) {
  const modal = $("#project-modal");
  if (!modal || modal.hidden) return;
  const saver = getProjectDossierAutoSaver();
  if (saver) {
    if (flush) {
      void saver.flush();
    } else {
      saver.cancel();
    }
  }
  modal.hidden = true;
  if (lastFocusBeforeProjectModal && document.contains(lastFocusBeforeProjectModal)) {
    try { lastFocusBeforeProjectModal.focus(); } catch {}
  }
  lastFocusBeforeProjectModal = null;
}

async function deleteProject(projectId, projectName) {
  if (!confirm(`Delete project "${projectName}"? Conversations inside it will be kept under Unassigned.`)) return;
  try {
    await api("/api/core/projects/" + encodeURIComponent(projectId), { method: "DELETE", body: "{}" });
    if (state.selectedProjectId === projectId) state.selectedProjectId = "all";
    if (state.ideaProjectFilter === projectId) state.ideaProjectFilter = "all";
    if (state.activeConversation?.projectId === projectId) {
      state.activeConversation = { ...state.activeConversation, projectId: null };
    }
    await Promise.all([loadProjects(), loadConversations(), loadIdeas()]);
    toast(`Deleted project "${projectName}".`);
  } catch (error) {
    toast(error.message);
  }
}

$("#new-project-btn")?.addEventListener("click", () => openProjectModal(null));
$("#mobile-new-project-btn")?.addEventListener("click", () => openProjectModal(null));
$("#chat-project-dossier-btn")?.addEventListener("click", () => {
  const activeProjectId = $("#chat-project-select")?.value
    || getConversationProjectId(state.activeConversation)
    || (state.selectedProjectId !== "all" && state.selectedProjectId !== "unassigned" ? state.selectedProjectId : "");
  const project = findProjectById(activeProjectId);
  if (project) openProjectModal(project);
});
$("#project-modal-close")?.addEventListener("click", () => closeProjectModal({ flush: true }));
$("#project-cancel-btn")?.addEventListener("click", () => closeProjectModal({ flush: true }));
$("#project-modal")?.querySelector("[data-project-modal-close='backdrop']")?.addEventListener("click", () => closeProjectModal({ flush: true }));
document.querySelectorAll("#project-color-choices .project-color-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    setProjectModalColor(btn.dataset.projectColor);
    scheduleProjectDossierAutoSave();
  });
});

$("#project-form")?.addEventListener("input", scheduleProjectDossierAutoSave);
$("#project-form")?.addEventListener("change", scheduleProjectDossierAutoSave);

function collectProjectDossierFormState() {
  const form = $("#project-form");
  if (!form) return null;
  const projectId = String(form.elements.projectId?.value || "").trim();
  const existing = projectId ? findProjectById(projectId) : null;
  return {
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.createdAt ? { createdAt: existing.createdAt } : {}),
    ...(existing?.updatedAt ? { updatedAt: existing.updatedAt } : {}),
    name: String(form.elements.name?.value || "").trim(),
    status: String(form.elements.status?.value || "active").trim(),
    color: projectModalColor || existing?.color || "purple",
    vision: String(form.elements.vision?.value || ""),
    description: String(form.elements.description?.value || ""),
    architecture: String(form.elements.architecture?.value || ""),
    nextActions: String(form.elements.nextActions?.value || ""),
    blockers: String(form.elements.blockers?.value || ""),
    decisions: String(form.elements.decisions?.value || ""),
    postponed: String(form.elements.postponed?.value || "")
  };
}

function exportProjectDossier(format = "md") {
  const dossier = collectProjectDossierFormState();
  if (!dossier) return false;

  const hasAnyContent = Boolean(
    dossier.name ||
    dossier.vision.trim() ||
    dossier.description.trim() ||
    dossier.architecture.trim() ||
    dossier.nextActions.trim() ||
    dossier.blockers.trim() ||
    dossier.decisions.trim() ||
    dossier.postponed.trim()
  );
  if (!hasAnyContent) {
    toast("Add a project name or dossier notes before exporting.");
    return false;
  }

  const normalizedFormat = format === "json" ? "json" : "md";
  const exporter = window.AlfieMarkdownExport;
  const exportedAt = new Date();

  let content;
  let mimeType;
  if (normalizedFormat === "json") {
    content = exporter?.formatProjectDossierJson
      ? exporter.formatProjectDossierJson(dossier, { exportedAt })
      : JSON.stringify({ schema: "alfie.project-dossier.v1", exportedAt: exportedAt.toISOString(), project: dossier }, null, 2) + "\n";
    mimeType = "application/json;charset=utf-8";
  } else {
    content = exporter?.formatProjectDossierMarkdown
      ? exporter.formatProjectDossierMarkdown(dossier, { exportedAt })
      : `# ${dossier.name || "Untitled Project"} — Project Dossier\n\n${dossier.description || ""}\n`;
    mimeType = "text/markdown;charset=utf-8";
  }

  const filename = exporter?.sanitizeDossierExportFilename
    ? exporter.sanitizeDossierExportFilename(dossier.name, normalizedFormat, exportedAt)
    : `project-dossier.${normalizedFormat}`;

  const blob = new Blob([content], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);

  toast(`Exported dossier backup "${filename}".`, { durationMs: 2800 });
  return true;
}

$("#project-export-md-btn")?.addEventListener("click", () => {
  exportProjectDossier("md");
});
$("#project-export-json-btn")?.addEventListener("click", () => {
  exportProjectDossier("json");
});

$("#project-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const projectId = String(form.elements.projectId.value || "").trim();
  const payloadBody = collectProjectDossierPayload();
  const name = payloadBody?.name || "";
  const err = $("#project-form-error");
  const submit = $("#project-submit-btn");
  if (err) err.textContent = "";
  if (!name) {
    if (err) err.textContent = "Please enter a project name.";
    return;
  }
  getProjectDossierAutoSaver()?.cancel();
  if (submit) submit.disabled = true;
  try {
    if (projectId) {
      const updated = await api("/api/core/projects/" + encodeURIComponent(projectId), {
        method: "PATCH",
        body: JSON.stringify(payloadBody)
      });
      if (updated?.project) syncUpdatedProjectInState(updated.project);
      getProjectDossierAutoSaver()?.markSaved(payloadBody);
      toast(`Updated project dossier "${name}".`);
    } else {
      const created = await api("/api/core/projects", {
        method: "POST",
        body: JSON.stringify(payloadBody)
      });
      if (created?.project?.id) state.selectedProjectId = created.project.id;
      toast(`Created project "${name}".`);
    }
    closeProjectModal({ flush: false });
    await loadProjects();
    renderConversations(state.conversations);
  } catch (error) {
    if (err) err.textContent = error.message;
  } finally {
    if (submit) submit.disabled = false;
  }
});

$("#chat-project-select")?.addEventListener("change", async (event) => {
  const targetProjectId = event.currentTarget.value || null;
  if (!state.activeConversationId) {
    state.selectedProjectId = targetProjectId || "all";
    renderProjects();
    renderConversations(state.conversations);
    return;
  }
  try {
    const updated = await api("/api/core/conversations/" + encodeURIComponent(state.activeConversationId), {
      method: "PATCH",
      body: JSON.stringify({ projectId: targetProjectId })
    });
    const nextProjectId = updated?.conversation?.projectId ?? targetProjectId;
    if (state.activeConversation) {
      state.activeConversation = { ...state.activeConversation, projectId: nextProjectId };
    }
    await Promise.all([loadProjects(), loadConversations()]);
    const proj = findProjectById(nextProjectId);
    toast(proj ? `Moved chat to "${proj.name}".` : "Removed chat from project.");
  } catch (error) {
    toast(error.message);
    syncChatContextBar();
  }
});

function formatGbFromMb(mb) {
  if (!Number.isFinite(Number(mb)) || Number(mb) <= 0) return null;
  return (Number(mb) / 1024).toFixed(1) + " GB";
}

function getVramDismissKey(vram) {
  const bucket = vram?.percent != null ? Math.floor(Number(vram.percent) / 5) * 5 : 0;
  return `${state.activeConversationId || "none"}:${bucket}`;
}

function renderVramWarningBanner() {
  const banner = $("#vram-warning-banner");
  const titleEl = $("#vram-warning-title");
  const detailEl = $("#vram-warning-detail");
  const ctaBtn = $("#vram-continue-btn");
  if (!banner) return;

  const vram = state.vram;
  const isWarning = Boolean(state.linked && vram?.warning === true && vram.available);
  const dismissKey = getVramDismissKey(vram);
  const dismissed = Boolean(state.vramDismissedKey && state.vramDismissedKey === dismissKey);

  if (!isWarning || dismissed) {
    banner.hidden = true;
    return;
  }

  const pct = Math.round(Number(vram.percent || 0));
  const usedGb = formatGbFromMb(vram.usedMb);
  const totalGb = formatGbFromMb(vram.totalMb);
  const memRange = usedGb && totalGb ? ` (${usedGb} / ${totalGb})` : "";
  const activeProject = findProjectById(getConversationProjectId(state.activeConversation));

  if (titleEl) {
    titleEl.textContent = `⚠ VRAM usage at ${pct}%${memRange}`;
  }
  if (detailEl) {
    if (state.activeConversationId && state.messages.length > 0) {
      detailEl.textContent = activeProject
        ? `Start a fresh chat in "${activeProject.name}" carrying over context from this conversation so you can keep working smoothly.`
        : "Start a fresh chat carrying over context from this conversation so you can keep working without VRAM pressure.";
    } else {
      detailEl.textContent = "GPU memory is above the 80% threshold. Start a fresh chat to keep context lean.";
    }
  }
  if (ctaBtn) {
    ctaBtn.textContent = state.activeConversationId && state.messages.length > 0
      ? "Continue in new chat"
      : "Start fresh chat";
  }
  banner.hidden = false;
}

function renderVramStatus() {
  const vram = state.vram;
  const readoutBtn = $("#vram-status-btn");
  const readoutVal = $("#vram-readout-value");
  if (readoutVal) {
    readoutVal.textContent = vram?.available && vram.percent != null
      ? `${Math.round(Number(vram.percent))}%`
      : "—";
  }
  if (readoutBtn) {
    readoutBtn.classList.toggle("is-warning", Boolean(vram?.warning));
  }

  const deviceEl = $("#vram-settings-device");
  const percentEl = $("#vram-settings-percent");
  const fillEl = $("#vram-meter-fill");
  const trackEl = $("#vram-meter-track");
  const metaEl = $("#vram-settings-meta");
  const clearBtn = $("#vram-clear-report-btn");
  const connBadge = $("#vram-connection-badge");
  const conn = vram?.connection || {};

  if (connBadge) {
    const mode = conn.mode || (vram?.available ? "local-gpu" : "unconfigured");
    connBadge.className = "cloud-status-tag";
    if (mode === "external-push") {
      connBadge.classList.add("is-ready");
      connBadge.textContent = conn.hostName ? `PC Live · ${conn.hostName}` : "External PC Live";
    } else if (mode === "external-pull") {
      connBadge.classList.add("is-ready");
      connBadge.textContent = conn.hostName ? `PC Pull · ${conn.hostName}` : "External PC Pull";
    } else if (mode === "remote-ollama") {
      connBadge.classList.add("is-ready");
      connBadge.textContent = conn.hostName ? `Ollama · ${conn.hostName}` : "Remote Ollama";
    } else if (mode === "test-alert") {
      connBadge.classList.add("is-active");
      connBadge.textContent = "Test Reading";
    } else if (mode === "local-gpu") {
      connBadge.classList.add("is-ready");
      connBadge.textContent = "Local GPU";
    } else if (mode === "stale") {
      connBadge.classList.add("is-missing");
      connBadge.textContent = conn.hostName ? `PC Stale · ${conn.hostName}` : "PC Stale";
    } else if (mode === "ollama-needs-total") {
      connBadge.classList.add("is-missing");
      connBadge.textContent = "Set Total VRAM";
    } else {
      connBadge.classList.add("is-missing");
      connBadge.textContent = "Waiting for PC";
    }
  }

  if (deviceEl && percentEl && fillEl && trackEl && metaEl) {
    const threshold = vram?.thresholdPercent || 80;
    const hostLabel = vram?.hostName || conn.hostName || null;
    if (vram?.available && vram.percent != null) {
      const pct = Math.round(Number(vram.percent));
      const usedGb = formatGbFromMb(vram.usedMb);
      const totalGb = formatGbFromMb(vram.totalMb);
      const baseGpu = vram.gpuName || "GPU";
      deviceEl.textContent = hostLabel && !baseGpu.includes(hostLabel)
        ? `${baseGpu} · ${hostLabel}`
        : baseGpu;
      percentEl.textContent = `${pct}%`;
      percentEl.classList.toggle("is-warning", Boolean(vram.warning));
      fillEl.style.width = `${Math.max(0, Math.min(100, pct))}%`;
      fillEl.classList.toggle("is-warning", Boolean(vram.warning));
      trackEl.setAttribute("aria-valuenow", String(pct));
      const sourceLabel = vram.source === "external-pc"
        ? "External PC push"
        : (vram.source === "external-pc-pull" ? "External PC pull" : (vram.source || "probe"));
      const parts = [
        usedGb && totalGb ? `${usedGb} / ${totalGb}` : null,
        `Source: ${sourceLabel}`,
        `Warning threshold: ${threshold}%`,
        vram.warning ? "Alert active" : "Within budget"
      ].filter(Boolean);
      metaEl.textContent = parts.join(" · ");
    } else {
      const usedGb = formatGbFromMb(vram?.usedMb);
      if (conn.stale && hostLabel) {
        deviceEl.textContent = `${hostLabel} (offline / stale)`;
        metaEl.textContent = `No VRAM update received within ${conn.ttlSeconds || 120}s · Warning threshold: ${threshold}%. Make sure the PC reporter is running.`;
      } else if (conn.mode === "ollama-needs-total" && hostLabel) {
        deviceEl.textContent = `Ollama on ${hostLabel}${usedGb ? ` (${usedGb} loaded)` : ""}`;
        metaEl.textContent = `Warning threshold: ${threshold}% · Set ALFIE_VRAM_TOTAL_MB on Proxmox or connect the external PC reporter below for exact %.`;
      } else {
        deviceEl.textContent = "Waiting for external PC GPU telemetry";
        metaEl.textContent = `Warning threshold: ${threshold}% · Open "Connect external GPU PC" below to stream live VRAM from your PC to Proxmox.`;
      }
      percentEl.textContent = "—";
      percentEl.classList.remove("is-warning");
      fillEl.style.width = "0%";
      fillEl.classList.remove("is-warning");
      trackEl.setAttribute("aria-valuenow", "0");
    }
    if (clearBtn) {
      clearBtn.hidden = !(vram?.source === "test-alert" || vram?.source === "reported");
    }
  }

  renderVramPcSetup(conn);
  renderVramWarningBanner();
  syncVramNotificationButton();
}

let activeVramSnippetTab = "powershell";

function buildVramSnippet(kind) {
  const origin = typeof window !== "undefined" && window.location?.origin
    ? window.location.origin
    : "http://<PROXMOX_IP>:3000";
  const endpoint = `${origin}/api/telemetry/vram`;
  if (kind === "node") {
    return [
      `ALFIE_URL="${origin}" \\`,
      `ALFIE_VRAM_REPORT_TOKEN="<YOUR_ALFIE_VRAM_REPORT_TOKEN>" \\`,
      `node scripts/pc-vram-reporter.mjs`
    ].join("\n");
  }
  if (kind === "bash") {
    return [
      `# Run every 5s on your Linux GPU PC (requires nvidia-smi & curl)`,
      `while true; do`,
      `  IFS=',' read -r gpu used total <<< "$(nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv,noheader,nounits | head -n 1)"`,
      `  curl -fsS -X POST "${endpoint}" \\`,
      `    -H "Authorization: Bearer $ALFIE_VRAM_REPORT_TOKEN" \\`,
      `    -H "Content-Type: application/json" \\`,
      `    -d "{\\"gpuName\\":\\"$gpu\\",\\"usedMb\\":$used,\\"totalMb\\":$total,\\"hostName\\":\\"$(hostname)\\"}" >/dev/null`,
      `  sleep 5`,
      `done`
    ].join("\n");
  }
  return [
    `# Run on your Windows GPU PC (PowerShell, requires nvidia-smi)`,
    `$Token = "<YOUR_ALFIE_VRAM_REPORT_TOKEN>"`,
    `while ($true) {`,
    `  $csv = (nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv,noheader,nounits | Select-Object -First 1) -split ','`,
    `  $body = @{ gpuName = $csv[0].Trim(); usedMb = [int]$csv[1]; totalMb = [int]$csv[2]; hostName = $env:COMPUTERNAME } | ConvertTo-Json`,
    `  Invoke-RestMethod -Uri "${endpoint}" -Method Post -Headers @{ Authorization = "Bearer $Token" } -ContentType "application/json" -Body $body | Out-Null`,
    `  Start-Sleep -Seconds 5`,
    `}`
  ].join("\n");
}

function renderVramPcSetup(conn = {}) {
  const tokenEl = $("#vram-token-status");
  const remoteEl = $("#vram-remote-status");
  const endpointEl = $("#vram-endpoint-url");
  const cmdEl = $("#vram-setup-command");

  if (tokenEl) {
    tokenEl.className = "cloud-status-tag " + (conn.pushTokenConfigured ? "is-ready" : "is-missing");
    tokenEl.textContent = conn.pushTokenConfigured
      ? "ALFIE_VRAM_REPORT_TOKEN ready"
      : "Set ALFIE_VRAM_REPORT_TOKEN on Proxmox";
  }
  if (remoteEl) {
    remoteEl.className = "cloud-status-tag" + (conn.remoteUrlConfigured ? " is-ready" : "");
    remoteEl.textContent = conn.remoteUrlConfigured
      ? "ALFIE_VRAM_REMOTE_URL active"
      : "Pull URL optional";
  }
  if (endpointEl && typeof window !== "undefined" && window.location?.origin) {
    endpointEl.textContent = `${window.location.origin}/api/telemetry/vram`;
  }
  if (cmdEl) {
    cmdEl.textContent = buildVramSnippet(activeVramSnippetTab);
  }
  document.querySelectorAll("[data-vram-snippet]").forEach((btn) => {
    const active = btn.dataset.vramSnippet === activeVramSnippetTab;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", String(active));
  });
}

function isVramOverThreshold(vram) {
  if (!vram?.available) return false;
  const threshold = Number(vram.thresholdPercent || 80);
  return vram.warning === true || (vram.percent != null && Number(vram.percent) >= threshold);
}

function syncVramNotificationButton() {
  const btn = $("#vram-notify-permission-btn");
  if (!btn) return;
  if (typeof window === "undefined" || typeof window.Notification === "undefined") {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  const perm = window.Notification.permission;
  btn.classList.toggle("is-granted", perm === "granted");
  if (perm === "granted") {
    btn.textContent = "Desktop alerts: On";
    btn.disabled = true;
  } else if (perm === "denied") {
    btn.textContent = "Desktop alerts blocked";
    btn.disabled = true;
  } else {
    btn.textContent = "Enable desktop alerts";
    btn.disabled = false;
  }
}

function triggerVramThresholdAlert(vram) {
  const pct = Math.round(Number(vram?.percent || 0));
  const threshold = Math.round(Number(vram?.thresholdPercent || 80));
  const usedGb = formatGbFromMb(vram?.usedMb);
  const totalGb = formatGbFromMb(vram?.totalMb);
  const memRange = usedGb && totalGb ? ` (${usedGb} / ${totalGb})` : "";
  const toastMessage = `⚠ VRAM at ${pct}%${memRange} — crossed ${threshold}% threshold. Start a new chat with carried-over context.`;

  toast(toastMessage, { variant: "warning", durationMs: 6000 });

  if (typeof window !== "undefined" && typeof window.Notification !== "undefined" && window.Notification.permission === "granted") {
    try {
      const notification = new window.Notification(`Alfie — VRAM usage at ${pct}%`, {
        body: `GPU memory crossed the ${threshold}% threshold${memRange}. Start a new chat with carried-over context to keep working smoothly.`,
        tag: "alfie-vram-threshold",
        renotify: true
      });
      notification.onclick = () => {
        try { window.focus(); } catch {}
        setView("chat");
        try { notification.close(); } catch {}
      };
    } catch {
      // Browser or iframe blocked Notification construction; toast alert already shown above.
    }
  }
}

function applyVramSnapshot(vram) {
  state.vram = vram || null;
  const overThreshold = isVramOverThreshold(state.vram);
  let crossedThreshold = false;
  if (overThreshold && !state.vramLastAlerted) {
    state.vramLastAlerted = true;
    crossedThreshold = true;
    if (window.alfieSoul?.getAnimationState() === "idle") {
      window.alfieSoul?.setMood("amber");
    }
    triggerVramThresholdAlert(state.vram);
  } else if (!overThreshold) {
    state.vramLastAlerted = false;
  }
  renderVramStatus();
  return crossedThreshold;
}

async function refreshVramStatus() {
  if (!state.linked) return null;
  try {
    const payload = await api("/api/core/system/vram");
    applyVramSnapshot(payload?.vram || null);
    return state.vram;
  } catch {
    return null;
  }
}

function startVramPolling() {
  stopVramPolling();
  state.vramPollTimer = setInterval(() => {
    if (!document.hidden && state.linked && !state.sending) {
      refreshVramStatus();
    }
  }, 20000);
}

function stopVramPolling() {
  if (state.vramPollTimer) {
    clearInterval(state.vramPollTimer);
    state.vramPollTimer = null;
  }
}

async function continueInNewChat({ reason = "context_handoff" } = {}) {
  if (state.sending || state.conversationLoading) {
    toast("Wait for the current response to finish first.");
    return;
  }
  if (!state.activeConversationId) {
    await newConversation();
    return;
  }
  const token = ++state.conversationLoadToken;
  state.conversationLoading = true;
  syncChatContextBar();
  try {
    const payload = await api("/api/core/conversations/" + encodeURIComponent(state.activeConversationId) + "/handoff", {
      method: "POST",
      body: JSON.stringify({
        reason,
        projectId: getConversationProjectId(state.activeConversation)
      })
    });
    if (token !== state.conversationLoadToken) return;
    const nextConversation = payload.conversation;
    state.activeConversationId = nextConversation.id;
    state.activeConversation = nextConversation;
    state.messages = nextConversation.messages || [];
    state.vramDismissedKey = getVramDismissKey(state.vram);
    if (nextConversation.projectId && state.selectedProjectId !== "all" && state.selectedProjectId !== nextConversation.projectId) {
      state.selectedProjectId = nextConversation.projectId;
    }
    renderMessages();
    renderVramWarningBanner();
    await Promise.all([loadProjects(), loadConversations()]);
    setView("chat");
    window.alfieSoul?.pulse("completed", 1800, "idle", "purple");
    const project = findProjectById(nextConversation.projectId);
    toast(project
      ? `Started "${nextConversation.title}" in ${project.name} with carried-over context.`
      : `Started "${nextConversation.title}" with carried-over context.`);
    $("#chat-form")?.elements?.message?.focus();
  } catch (error) {
    toast(error.message);
  } finally {
    if (token === state.conversationLoadToken) state.conversationLoading = false;
    syncChatContextBar();
  }
}

function exportCurrentConversationMarkdown() {
  const hasContent = state.messages.length > 0 || Boolean(state.activeConversation?.handoffContext);
  if (!hasContent) {
    toast("No messages to export yet.");
    return false;
  }

  const exporter = window.AlfieMarkdownExport;
  const projectId = getConversationProjectId(state.activeConversation);
  const project = projectId ? findProjectById(projectId) : null;
  const exportedAt = new Date();

  const markdown = exporter?.formatConversationMarkdown
    ? exporter.formatConversationMarkdown({
        conversation: state.activeConversation,
        messages: state.messages,
        project,
        exportedAt
      })
    : `# ${state.activeConversation?.title || "Alfie Conversation"}\n\n` +
      state.messages.map((m) => `## ${m.role === "user" ? "You" : "Alfie"}\n\n${m.content || ""}`).join("\n\n---\n\n") +
      "\n";

  const filename = exporter?.sanitizeExportFilename
    ? exporter.sanitizeExportFilename(state.activeConversation?.title, exportedAt)
    : "alfie-conversation.md";

  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);

  toast(`Exported "${filename}".`, { durationMs: 2600 });
  return true;
}

$("#export-chat-btn")?.addEventListener("click", () => {
  exportCurrentConversationMarkdown();
});

$("#continue-chat-btn")?.addEventListener("click", () => {
  continueInNewChat({ reason: state.vram?.warning ? "vram_threshold" : "context_handoff" });
});
$("#vram-continue-btn")?.addEventListener("click", () => {
  if (state.activeConversationId && state.messages.length > 0) {
    continueInNewChat({ reason: "vram_threshold" });
  } else {
    state.vramDismissedKey = getVramDismissKey(state.vram);
    newConversation().catch((error) => toast(error.message));
  }
});
$("#vram-dismiss-btn")?.addEventListener("click", () => {
  state.vramDismissedKey = getVramDismissKey(state.vram);
  renderVramWarningBanner();
});
$("#vram-status-btn")?.addEventListener("click", () => {
  setView("settings");
  $("#settings-vram-surface")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
});
$("#vram-refresh-btn")?.addEventListener("click", async () => {
  const wasAlerted = state.vramLastAlerted;
  await refreshVramStatus();
  if (!(!wasAlerted && state.vramLastAlerted)) {
    toast("VRAM telemetry refreshed.");
  }
});
$("#vram-notify-permission-btn")?.addEventListener("click", async () => {
  if (typeof window === "undefined" || typeof window.Notification === "undefined") {
    toast("Browser notifications are not supported here — toast alerts remain active.");
    return;
  }
  try {
    const result = await window.Notification.requestPermission();
    syncVramNotificationButton();
    if (result === "granted") {
      toast("Desktop VRAM alerts enabled.");
    } else if (result === "denied") {
      toast("Desktop notifications blocked by browser — toast alerts remain active.");
    }
  } catch {
    toast("Could not request browser notification permission — toast alerts remain active.");
  }
});
$("#vram-simulate-high-btn")?.addEventListener("click", async () => {
  try {
    const payload = await api("/api/core/system/vram/report", {
      method: "POST",
      body: JSON.stringify({
        percent: 84,
        usedMb: 20644,
        totalMb: 24576,
        gpuName: "Local GPU (84% test)",
        source: "test-alert"
      })
    });
    state.vramDismissedKey = null;
    state.vramLastAlerted = false;
    applyVramSnapshot(payload.vram);
  } catch (error) {
    toast(error.message);
  }
});
$("#vram-clear-report-btn")?.addEventListener("click", async () => {
  try {
    const payload = await api("/api/core/system/vram/report", {
      method: "POST",
      body: JSON.stringify({ clear: true })
    });
    state.vramDismissedKey = null;
    applyVramSnapshot(payload.vram);
    toast("Reset test VRAM reading.");
  } catch (error) {
    toast(error.message);
  }
});
document.querySelectorAll("[data-vram-snippet]").forEach((btn) => {
  btn.addEventListener("click", () => {
    activeVramSnippetTab = btn.dataset.vramSnippet || "powershell";
    renderVramPcSetup(state.vram?.connection || {});
  });
});
$("#vram-copy-cmd-btn")?.addEventListener("click", async () => {
  const snippet = buildVramSnippet(activeVramSnippetTab);
  try {
    await navigator.clipboard.writeText(snippet);
    toast("External PC VRAM reporter command copied.");
  } catch {
    toast("Copy failed — select the command text manually.");
  }
});

function findCloudAgent(providerId) {
  return (state.cloudAgents || []).find((agent) => agent.provider === providerId) || null;
}

const PERSONAL_VISIBILITY_KEYS = [
  "allowMail",
  "allowCalendar",
  "allowJournal",
  "allowPersonalMemories",
  "allowDashboardState"
];

function getCloudPrivacyCategories() {
  return state.cloudPrivacyCategories && state.cloudPrivacyCategories.length
    ? state.cloudPrivacyCategories
    : [
        { key: "allowMail", label: "Emails & Inbox", group: "personal", description: "Mail summaries, inbox context, and email tools." },
        { key: "allowCalendar", label: "Calendar & Schedule", group: "personal", description: "Upcoming events, selected dates, and calendar tools." },
        { key: "allowJournal", label: "Personal Journal", group: "personal", description: "Private journal reflections, diary entries, and activity logs." },
        { key: "allowPersonalMemories", label: "Garden Memories", group: "personal", description: "Saved personal memories and memory search/write tools." },
        { key: "allowDashboardState", label: "Dashboard & Notifications", group: "personal", description: "System notifications, Petrio status, quest progress, and health." },
        { key: "allowProjectContext", label: "Project Notes & Handoff", group: "coding", description: "Active project notes and carried-over coding context." },
        { key: "allowCodeTools", label: "Code & Utility Tools", group: "coding", description: "Repository audit, project roadmap, and visual asset tools." },
        { key: "redactPersonalIdentifiers", label: "Scrub Email Addresses", group: "coding", description: "Automatically redact email addresses from outbound prompts." }
      ];
}

function summarizeLocalVisibility(visibility = {}) {
  const categories = getCloudPrivacyCategories();
  const blocked = [];
  const allowed = [];
  const personalExposed = [];
  for (const cat of categories) {
    if (cat.key === "redactPersonalIdentifiers") continue;
    if (visibility[cat.key]) {
      allowed.push(cat.label);
      if (cat.group === "personal") personalExposed.push(cat.label);
    } else {
      blocked.push(cat.label);
    }
  }
  return {
    blocked,
    allowed,
    personalExposed,
    personalTotal: PERSONAL_VISIBILITY_KEYS.length,
    personalDataIsolated: personalExposed.length === 0
  };
}

function renderCloudPrivacyDrawer(agent, summary) {
  const drawer = $("#cloud-privacy-drawer");
  const listHost = $("#cloud-privacy-drawer-list");
  const labelEl = $("#cloud-privacy-drawer-label");
  const lockAllBtn = $("#cloud-privacy-lock-all-btn");
  const toggleBtn = $("#cloud-privacy-toggle-btn");
  if (!drawer || !listHost) return;

  if (toggleBtn) {
    toggleBtn.textContent = `Private sections (${summary.personalExposed.length}/${summary.personalTotal})`;
  }
  if (labelEl) {
    labelEl.textContent = `Optional private sections for ${agent.name} — unchecked sections remain blocked on the server:`;
  }
  if (lockAllBtn) {
    lockAllBtn.hidden = summary.personalDataIsolated;
  }

  const personalCats = getCloudPrivacyCategories().filter((c) => c.group === "personal");
  listHost.replaceChildren();

  for (const cat of personalCats) {
    const allowed = Boolean(agent.visibility?.[cat.key]);
    const chip = document.createElement("label");
    chip.className = "cloud-drawer-chip" + (allowed ? " is-allowed" : "");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = allowed;
    cb.setAttribute("aria-label", `Allow ${agent.name} access to ${cat.label}`);

    const text = document.createElement("span");
    text.textContent = cat.label;

    const badge = document.createElement("span");
    badge.className = "cloud-drawer-chip-state";
    badge.textContent = allowed ? "On" : "Off";

    cb.addEventListener("change", async () => {
      cb.disabled = true;
      const nextVis = { ...(agent.visibility || {}), [cat.key]: cb.checked };
      const anyPersonal = PERSONAL_VISIBILITY_KEYS.some((k) => Boolean(nextVis[k]));
      try {
        await api("/api/core/cloud-agents/" + encodeURIComponent(agent.provider), {
          method: "PATCH",
          body: JSON.stringify({
            privateAccessOptIn: anyPersonal,
            visibility: nextVis
          })
        });
        await loadCloudAgents();
        toast(cb.checked
          ? `${agent.name} now has optional access to ${cat.label}.`
          : `Blocked ${cat.label} for ${agent.name}.`);
      } catch (error) {
        cb.checked = !cb.checked;
        toast(error.message || "Could not update private section access.", { variant: "warning" });
      } finally {
        cb.disabled = false;
      }
    });

    chip.append(cb, text, badge);
    listHost.appendChild(chip);
  }
}

function renderCloudPrivacyBanner() {
  const banner = $("#cloud-privacy-banner");
  const titleEl = $("#cloud-privacy-title");
  const detailEl = $("#cloud-privacy-detail");
  const drawer = $("#cloud-privacy-drawer");
  const toggleBtn = $("#cloud-privacy-toggle-btn");
  if (!banner) return;

  const activeProvider = state.selectedAgentProvider || "local";
  if (activeProvider === "local") {
    banner.hidden = true;
    banner.classList.remove("is-personal-exposed");
    if (drawer) drawer.hidden = true;
    if (toggleBtn) toggleBtn.setAttribute("aria-expanded", "false");
    return;
  }

  const agent = findCloudAgent(activeProvider);
  if (!agent || !agent.enabled || !agent.privacyWarningAccepted) {
    banner.hidden = true;
    if (drawer) drawer.hidden = true;
    if (toggleBtn) toggleBtn.setAttribute("aria-expanded", "false");
    return;
  }

  const summary = summarizeLocalVisibility(agent.visibility || {});
  const keyNote = agent.secretConfigured ? "" : ` · Server ${agent.envVar} not set yet`;
  if (titleEl) {
    titleEl.textContent = summary.personalDataIsolated
      ? `🛡 ${agent.name} (${agent.model}) · Coding-only privacy mode${keyNote}`
      : `⚠ ${agent.name} (${agent.model}) · Optional private access (${summary.personalExposed.join(", ")})${keyNote}`;
  }
  if (detailEl) {
    const blockedText = summary.blocked.length ? `Blocked: ${summary.blocked.join(", ")}.` : "No categories blocked.";
    const allowedText = summary.allowed.length ? `Allowed: ${summary.allowed.join(", ")}.` : "Chat prompt only.";
    detailEl.textContent = `Prompts leave your local machine. ${blockedText} ${allowedText}`;
  }
  renderCloudPrivacyDrawer(agent, summary);
  banner.classList.toggle("is-personal-exposed", !summary.personalDataIsolated);
  banner.hidden = false;
}

function syncAgentSelector() {
  const select = $("#agent-provider");
  if (!select) return;
  const gemini = findCloudAgent("gemini");
  const openai = findCloudAgent("openai");

  select.replaceChildren();
  const localOpt = document.createElement("option");
  localOpt.value = "local";
  localOpt.textContent = "Alfie Local";
  select.appendChild(localOpt);

  const cloudDefs = [
    { id: "gemini", fallbackName: "Gemini", agent: gemini },
    { id: "openai", fallbackName: "ChatGPT", agent: openai }
  ];
  for (const def of cloudDefs) {
    const opt = document.createElement("option");
    opt.value = def.id;
    const isEnabled = Boolean(def.agent?.enabled && def.agent?.privacyWarningAccepted);
    opt.disabled = !isEnabled;
    if (isEnabled) {
      const summary = summarizeLocalVisibility(def.agent.visibility || {});
      const privateNote = summary.personalExposed.length > 0
        ? `+${summary.personalExposed.length} private`
        : "Coding";
      opt.textContent = def.agent.secretConfigured
        ? `${def.fallbackName} (${privateNote})`
        : `${def.fallbackName} (Key needed)`;
    } else {
      opt.textContent = `${def.fallbackName} (enable in Settings)`;
    }
    select.appendChild(opt);
  }

  const current = state.selectedAgentProvider || "local";
  const currentAgent = current !== "local" ? findCloudAgent(current) : null;
  if (current !== "local" && !(currentAgent?.enabled && currentAgent?.privacyWarningAccepted)) {
    state.selectedAgentProvider = "local";
    try { localStorage.setItem("alfie_agent_provider", "local"); } catch {}
  }
  select.value = state.selectedAgentProvider || "local";
  renderCloudPrivacyBanner();
}

function renderCloudAgentsSettings() {
  const host = $("#cloud-agents-list");
  if (!host) return;
  host.replaceChildren();

  if (!state.cloudAgents.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Cloud coding agent controls are unavailable.";
    host.appendChild(empty);
    return;
  }

  const categories = getCloudPrivacyCategories();
  const personalCats = categories.filter((c) => c.group === "personal");
  const codingCats = categories.filter((c) => c.group === "coding");

  for (const agent of state.cloudAgents) {
    const card = document.createElement("form");
    card.className = "cloud-agent-card" + (agent.enabled ? " is-enabled" : "");
    card.dataset.cloudProvider = agent.provider;

    const head = document.createElement("div");
    head.className = "cloud-agent-card-head";

    const titleWrap = document.createElement("div");
    titleWrap.className = "cloud-agent-title";
    const nameEl = document.createElement("strong");
    nameEl.textContent = agent.name;
    const vendorEl = document.createElement("span");
    vendorEl.className = "cloud-agent-vendor";
    vendorEl.textContent = `${agent.vendor} · Coding & optional private access`;
    titleWrap.append(nameEl, vendorEl);

    const badges = document.createElement("div");
    badges.className = "cloud-agent-badges";
    const keyTag = document.createElement("span");
    keyTag.className = "cloud-status-tag " + (agent.secretConfigured ? "is-ready" : "is-missing");
    keyTag.textContent = agent.secretSource === "server_vault"
      ? "Encrypted on server"
      : (agent.secretConfigured ? `${agent.envVar} ready` : "API key needed");
    const enabledTag = document.createElement("span");
    enabledTag.className = "cloud-status-tag" + (agent.enabled ? " is-active" : "");
    enabledTag.textContent = agent.enabled ? "Enabled" : "Disabled";
    const manageKeyBtn = document.createElement("button");
    manageKeyBtn.type = "button";
    manageKeyBtn.className = "secondary-button cloud-manage-key-btn";
    manageKeyBtn.textContent = agent.secretConfigured ? "Update key" : "Add API key";
    manageKeyBtn.addEventListener("click", () => {
      openToolsApiKeySetup(agent.provider);
    });
    badges.append(keyTag, enabledTag, manageKeyBtn);
    head.append(titleWrap, badges);
    card.appendChild(head);

    // Model selector
    const modelRow = document.createElement("div");
    modelRow.className = "cloud-agent-row";
    const modelLabel = document.createElement("label");
    const modelId = `cloud-model-${agent.provider}`;
    modelLabel.htmlFor = modelId;
    modelLabel.textContent = "Model";
    const modelSelect = document.createElement("select");
    modelSelect.id = modelId;
    modelSelect.name = "model";
    for (const model of (agent.models || [])) {
      const opt = document.createElement("option");
      opt.value = model.id;
      opt.textContent = model.label;
      if (model.id === agent.model) opt.selected = true;
      modelSelect.appendChild(opt);
    }
    modelRow.append(modelLabel, modelSelect);
    card.appendChild(modelRow);

    // Privacy warning acknowledgement
    const ackLabel = document.createElement("label");
    ackLabel.className = "cloud-warning-ack";
    const ackCheckbox = document.createElement("input");
    ackCheckbox.type = "checkbox";
    ackCheckbox.name = "privacyWarningAccepted";
    ackCheckbox.checked = Boolean(agent.privacyWarningAccepted);
    ackCheckbox.id = `cloud-ack-${agent.provider}`;
    const ackText = document.createElement("span");
    ackText.textContent = agent.privacyWarning;
    ackLabel.append(ackCheckbox, ackText);
    card.appendChild(ackLabel);

    // Enable toggle
    const enableLabel = document.createElement("label");
    enableLabel.className = "cloud-enable-row";
    const enableText = document.createElement("span");
    enableText.textContent = `Enable ${agent.name} in chat selector`;
    const enableCheckbox = document.createElement("input");
    enableCheckbox.type = "checkbox";
    enableCheckbox.name = "enabled";
    enableCheckbox.checked = Boolean(agent.enabled);
    enableCheckbox.id = `cloud-enable-${agent.provider}`;
    enableLabel.append(enableText, enableCheckbox);
    card.appendChild(enableLabel);

    const draftVisibility = { ...(agent.visibility || {}) };
    let draftPrivateOptIn = Boolean(
      agent.privateAccessOptIn || PERSONAL_VISIBILITY_KEYS.some((key) => Boolean(draftVisibility[key]))
    );
    const visibilityCheckboxes = new Map();

    const summaryBox = document.createElement("div");
    summaryBox.className = "cloud-summary-box";

    function updateSummaryBox() {
      const summary = summarizeLocalVisibility(draftVisibility);
      summaryBox.classList.toggle("is-warning", !summary.personalDataIsolated);
      const blockedStr = summary.blocked.length ? summary.blocked.join(", ") : "None";
      const allowedStr = summary.allowed.length ? summary.allowed.join(", ") : "Chat prompt only";
      if (summary.personalDataIsolated) {
        summaryBox.textContent = `Coding-only isolation active · All ${summary.personalTotal} private sections blocked. Allowed: ${allowedStr}.`;
      } else {
        summaryBox.textContent = `⚠ Optional private access for ${agent.vendor}: ${summary.personalExposed.join(", ")} · Blocked: ${blockedStr}.`;
      }
    }

    function buildVisibilityRows(list) {
      const itemsHost = document.createElement("div");
      itemsHost.className = "cloud-visibility-list";

      for (const cat of list) {
        const row = document.createElement("label");
        row.className = "cloud-visibility-row";

        const main = document.createElement("div");
        main.className = "cloud-vis-main";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.name = `vis_${cat.key}`;
        cb.checked = Boolean(draftVisibility[cat.key]);
        visibilityCheckboxes.set(cat.key, cb);

        const copy = document.createElement("div");
        copy.className = "cloud-vis-copy";
        const title = document.createElement("strong");
        title.textContent = cat.label;
        const desc = document.createElement("small");
        desc.textContent = cat.description;
        copy.append(title, desc);
        main.append(cb, copy);

        const stateBadge = document.createElement("span");
        function syncBadge() {
          const on = cb.checked;
          if (cat.key === "redactPersonalIdentifiers") {
            stateBadge.textContent = on ? "Scrubbing on" : "Off";
            stateBadge.className = "cloud-vis-state " + (on ? "is-blocked" : "is-allowed-personal");
          } else if (cat.group === "personal") {
            stateBadge.textContent = on ? "Allowed" : "Blocked";
            stateBadge.className = "cloud-vis-state " + (on ? "is-allowed-personal" : "is-blocked");
          } else {
            stateBadge.textContent = on ? "Allowed" : "Blocked";
            stateBadge.className = "cloud-vis-state " + (on ? "is-allowed-coding" : "is-blocked");
          }
        }
        syncBadge();

        cb.addEventListener("change", () => {
          draftVisibility[cat.key] = cb.checked;
          syncBadge();
          updateSummaryBox();
        });

        row.append(main, stateBadge);
        itemsHost.appendChild(row);
      }
      return itemsHost;
    }

    // Optional private sections master opt-in box
    const privateBox = document.createElement("div");
    privateBox.className = "cloud-private-optin-box" + (draftPrivateOptIn ? " is-opted-in" : "");

    const optInRow = document.createElement("label");
    optInRow.className = "cloud-private-optin-row";
    const optInCopy = document.createElement("div");
    optInCopy.className = "cloud-private-optin-copy";
    const optInTitle = document.createElement("strong");
    optInTitle.textContent = "Optional access to private sections";
    const optInDesc = document.createElement("small");
    optInDesc.textContent = `Off by default. Turn on only if you want ${agent.name} to access specific private sections below.`;
    optInCopy.append(optInTitle, optInDesc);

    const optInCheckbox = document.createElement("input");
    optInCheckbox.type = "checkbox";
    optInCheckbox.name = "privateAccessOptIn";
    optInCheckbox.id = `cloud-private-optin-${agent.provider}`;
    optInCheckbox.checked = draftPrivateOptIn;
    optInRow.append(optInCopy, optInCheckbox);

    const lockedNote = document.createElement("p");
    lockedNote.className = "cloud-private-locked-note";
    lockedNote.textContent = "All 5 private sections (Emails, Calendar, Journal, Garden Memories, Dashboard) are blocked.";

    const optInPanel = document.createElement("div");
    optInPanel.className = "cloud-visibility-group";
    const optInWarn = document.createElement("p");
    optInWarn.className = "cloud-private-optin-warn";
    optInWarn.textContent = `Choose which private sections ${agent.vendor} may read. Unchecked sections stay blocked on the server.`;
    const personalRows = buildVisibilityRows(personalCats);
    optInPanel.append(optInWarn, personalRows);

    function syncPrivateOptInUi() {
      privateBox.classList.toggle("is-opted-in", draftPrivateOptIn);
      lockedNote.hidden = draftPrivateOptIn;
      optInPanel.hidden = !draftPrivateOptIn;
      for (const key of PERSONAL_VISIBILITY_KEYS) {
        const cb = visibilityCheckboxes.get(key);
        if (cb) {
          cb.disabled = !draftPrivateOptIn;
          if (!draftPrivateOptIn && cb.checked) {
            cb.checked = false;
            draftVisibility[key] = false;
            cb.dispatchEvent(new Event("change"));
          }
        }
      }
      updateSummaryBox();
    }

    optInCheckbox.addEventListener("change", () => {
      draftPrivateOptIn = optInCheckbox.checked;
      syncPrivateOptInUi();
    });

    privateBox.append(optInRow, lockedNote, optInPanel);
    card.appendChild(privateBox);
    syncPrivateOptInUi();

    // Coding & workspace context group
    const codingGroup = document.createElement("div");
    codingGroup.className = "cloud-visibility-group";
    const codingHeading = document.createElement("p");
    codingHeading.className = "cloud-visibility-heading";
    codingHeading.textContent = "Coding & workspace context";
    codingGroup.append(codingHeading, buildVisibilityRows(codingCats));
    card.appendChild(codingGroup);

    updateSummaryBox();
    card.appendChild(summaryBox);

    const errEl = document.createElement("p");
    errEl.className = "error-message cloud-agent-error";
    errEl.setAttribute("role", "alert");
    card.appendChild(errEl);

    enableCheckbox.addEventListener("change", () => {
      errEl.textContent = "";
      if (enableCheckbox.checked && !ackCheckbox.checked) {
        enableCheckbox.checked = false;
        errEl.textContent = `Check the privacy warning above before enabling ${agent.name}.`;
        ackCheckbox.focus();
      }
    });

    ackCheckbox.addEventListener("change", () => {
      errEl.textContent = "";
      if (!ackCheckbox.checked) {
        enableCheckbox.checked = false;
      }
    });

    const actions = document.createElement("div");
    actions.className = "cloud-agent-actions";

    const strictBtn = document.createElement("button");
    strictBtn.type = "button";
    strictBtn.className = "secondary-button";
    strictBtn.textContent = "Strict coding only";
    strictBtn.addEventListener("click", () => {
      draftPrivateOptIn = false;
      optInCheckbox.checked = false;
      const defaults = {
        allowMail: false,
        allowCalendar: false,
        allowJournal: false,
        allowPersonalMemories: false,
        allowDashboardState: false,
        allowProjectContext: true,
        allowCodeTools: true,
        redactPersonalIdentifiers: true
      };
      for (const [k, val] of Object.entries(defaults)) {
        draftVisibility[k] = val;
        const cb = visibilityCheckboxes.get(k);
        if (cb) {
          cb.checked = val;
          cb.dispatchEvent(new Event("change"));
        }
      }
      syncPrivateOptInUi();
      toast(`${agent.name} reset to strict coding-only privacy.`);
    });

    const saveBtn = document.createElement("button");
    saveBtn.type = "submit";
    saveBtn.className = "primary-button";
    saveBtn.textContent = `Save ${agent.name}`;

    actions.append(strictBtn, saveBtn);
    card.appendChild(actions);

    card.addEventListener("submit", async (event) => {
      event.preventDefault();
      errEl.textContent = "";
      if (enableCheckbox.checked && !ackCheckbox.checked) {
        errEl.textContent = `Review and accept the privacy warning before enabling ${agent.name}.`;
        return;
      }
      saveBtn.disabled = true;
      try {
        await api("/api/core/cloud-agents/" + encodeURIComponent(agent.provider), {
          method: "PATCH",
          body: JSON.stringify({
            enabled: enableCheckbox.checked,
            privacyWarningAccepted: ackCheckbox.checked,
            privateAccessOptIn: optInCheckbox.checked,
            model: modelSelect.value,
            visibility: draftVisibility
          })
        });
        await loadCloudAgents();
        toast(`${agent.name} privacy & access settings saved.`);
      } catch (error) {
        errEl.textContent = error.message;
      } finally {
        saveBtn.disabled = false;
      }
    });

    host.appendChild(card);
  }
}

async function loadCloudAgents() {
  if (!state.linked) return null;
  try {
    const payload = await api("/api/core/cloud-agents");
    state.cloudAgents = Array.isArray(payload?.agents) ? payload.agents : [];
    state.cloudPrivacyCategories = Array.isArray(payload?.categories) ? payload.categories : [];
    syncAgentSelector();
    renderCloudAgentsSettings();
    renderCloudKeyStatusCards();
    updateToolsSummaryStrip();
    return state.cloudAgents;
  } catch {
    return null;
  }
}

let pendingAgentSwitch = null;

function closeAgentSwitchWarning() {
  const dialog = $("#model-switch-warning");
  if (dialog?.open) dialog.close("cancel");
  pendingAgentSwitch = null;
}

function confirmAgentSwitch() {
  if (!pendingAgentSwitch) return;
  const next = pendingAgentSwitch;
  pendingAgentSwitch = null;
  state.selectedAgentProvider = next;
  try { localStorage.setItem("alfie_agent_provider", next); } catch {}
  const select = $("#agent-provider");
  if (select) select.value = next;
  renderCloudPrivacyBanner();
  const agent = findCloudAgent(next);
  const label = agent ? `${agent.name} (${agent.model})` : next;
  toast(`Switched to ${label}. Check the cloud privacy banner for current data boundaries.`);
}

function openAgentSwitchWarning(providerId) {
  const agent = findCloudAgent(providerId);
  if (!agent || !agent.enabled || !agent.privacyWarningAccepted) {
    pendingAgentSwitch = null;
    const select = $("#agent-provider");
    if (select) select.value = state.selectedAgentProvider || "local";
    toast("This cloud provider is not enabled. Review its setup and privacy settings first.", { variant: "warning" });
    return;
  }

  const summary = summarizeLocalVisibility(agent.visibility || {});
  const dialog = $("#model-switch-warning");
  const title = $("#model-switch-warning-title");
  const detail = $("#model-switch-warning-detail");
  const allowed = $("#model-switch-warning-allowed");
  const blocked = $("#model-switch-warning-blocked");
  if (!dialog || typeof dialog.showModal !== "function") {
    const categories = summary.allowed.length ? summary.allowed.join(", ") : "chat prompt only";
    if (window.confirm(`Switch to ${agent.name} (${agent.model})? Your conversation and permitted context will be sent to this online provider. Allowed: ${categories}. Personal categories not listed remain blocked.`)) {
      confirmAgentSwitch();
    } else {
      pendingAgentSwitch = null;
      const select = $("#agent-provider");
      if (select) select.value = state.selectedAgentProvider || "local";
    }
    return;
  }

  if (title) title.textContent = `Switch to ${agent.name}?`;
  if (detail) detail.textContent = `This is an online AI provider. Your current conversation messages and the context required for your request will leave your local Alfie installation and be processed by ${agent.name} (${agent.model}).`;
  if (allowed) allowed.textContent = summary.allowed.length ? summary.allowed.join(", ") : "No optional private sections; chat prompt only.";
  if (blocked) blocked.textContent = summary.blocked.length ? summary.blocked.join(", ") : "No categories are currently blocked.";
  dialog.showModal();
}

$("#agent-provider")?.addEventListener("change", (event) => {
  const next = event.currentTarget.value || "local";
  const current = state.selectedAgentProvider || "local";
  if (next === current) return;
  if (next === "local") {
    state.selectedAgentProvider = "local";
    try { localStorage.setItem("alfie_agent_provider", "local"); } catch {}
    renderCloudPrivacyBanner();
    toast("Switched to Alfie Local.");
    return;
  }

  pendingAgentSwitch = next;
  event.currentTarget.value = current;
  openAgentSwitchWarning(next);
});

$("#model-switch-warning-confirm")?.addEventListener("click", () => {
  const dialog = $("#model-switch-warning");
  if (dialog?.open) dialog.close("confirm");
  confirmAgentSwitch();
});

$("#model-switch-warning-cancel")?.addEventListener("click", closeAgentSwitchWarning);
$("#model-switch-warning")?.addEventListener("cancel", () => {
  pendingAgentSwitch = null;
  const select = $("#agent-provider");
  if (select) select.value = state.selectedAgentProvider || "local";
});

$("#cloud-privacy-toggle-btn")?.addEventListener("click", () => {
  const drawer = $("#cloud-privacy-drawer");
  const toggleBtn = $("#cloud-privacy-toggle-btn");
  if (!drawer || !toggleBtn) return;
  const willOpen = drawer.hidden;
  drawer.hidden = !willOpen;
  toggleBtn.setAttribute("aria-expanded", String(willOpen));
});

$("#cloud-privacy-lock-all-btn")?.addEventListener("click", async () => {
  const activeProvider = state.selectedAgentProvider;
  if (!activeProvider || activeProvider === "local") return;
  const agent = findCloudAgent(activeProvider);
  if (!agent) return;
  try {
    await api("/api/core/cloud-agents/" + encodeURIComponent(agent.provider), {
      method: "PATCH",
      body: JSON.stringify({ preset: "coding-only" })
    });
    await loadCloudAgents();
    toast(`Blocked all private sections for ${agent.name}.`);
  } catch (error) {
    toast(error.message || "Could not lock private sections.", { variant: "warning" });
  }
});

$("#cloud-privacy-configure-btn")?.addEventListener("click", () => {
  setView("settings");
  loadCloudAgents().then(() => {
    $("#settings-cloud-agents-surface")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
});

$("#cloud-agents-refresh-btn")?.addEventListener("click", async () => {
  await loadCloudAgents();
  toast("Cloud agent status refreshed.");
});

try {
  const savedAgent = localStorage.getItem("alfie_agent_provider");
  if (savedAgent && ["local", "gemini", "openai"].includes(savedAgent)) {
    state.selectedAgentProvider = savedAgent;
  }
} catch {}

window.alfieCloudAgents = {
  getState: () => ({
    agents: state.cloudAgents,
    selectedAgentProvider: state.selectedAgentProvider
  }),
  refresh: loadCloudAgents
};

async function loadWorkspaceData() {
  await Promise.all([
    loadProjects(),
    loadConversations(),
    loadCloudAgents(),
    loadWorkflowProfile().catch(() => {}),
    loadCapsules().catch(() => {})
  ]);
  await refreshVramStatus();
  startVramPolling();
}

function renderConversationList(host, conversations = []) {
  if (!host) return;
  host.replaceChildren();
  const searchId = host.id === "mobile-conversation-list" ? "#mobile-history-search" : "#history-search";
  const query = String($(searchId)?.value || "").trim().toLowerCase();
  const projectScoped = conversations.filter((item) => {
    if (state.selectedProjectId === "all") return true;
    if (state.selectedProjectId === "unassigned") return !item.projectId;
    return item.projectId === state.selectedProjectId;
  });
  const visibleConversations = projectScoped.filter((item) => !query || String(item.title || "New conversation").toLowerCase().includes(query));
  for (const item of visibleConversations) {
    const row = document.createElement("div");
    row.className = "conversation-row";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "conversation-item" + (item.id === state.activeConversationId ? " active" : "");

    const inner = document.createElement("span");
    inner.className = "conversation-item-inner";
    const titleSpan = document.createElement("span");
    titleSpan.className = "conversation-item-title";
    titleSpan.textContent = item.title || "New conversation";
    inner.appendChild(titleSpan);

    const metaParts = [];
    if (state.selectedProjectId === "all" && item.projectId) {
      const proj = findProjectById(item.projectId);
      if (proj) metaParts.push(proj.name);
    }
    if (item.hasHandoffContext) metaParts.push("Carried context");
    if (metaParts.length) {
      const metaSpan = document.createElement("span");
      metaSpan.className = "conversation-item-meta";
      metaSpan.textContent = metaParts.join(" · ");
      inner.appendChild(metaSpan);
    }

    button.appendChild(inner);
    button.addEventListener("click", () => {
      const mobileSheet = $("#mobile-history-sheet");
      if (mobileSheet) mobileSheet.hidden = true;
      setView("chat");
      loadConversation(item.id).catch((error) => toast(error.message));
    });
    const actions = document.createElement("div");
    actions.className = "conversation-actions";
    const rename = document.createElement("button");
    rename.type = "button";
    rename.className = "conversation-rename";
    rename.textContent = "✎";
    rename.setAttribute("aria-label", "Rename " + (item.title || "conversation"));
    rename.title = "Rename conversation";
    rename.addEventListener("click", () => renameConversation(item.id, item.title || "New conversation"));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "conversation-delete";
    remove.textContent = "×";
    remove.setAttribute("aria-label", "Delete " + (item.title || "conversation"));
    remove.addEventListener("click", () => deleteConversation(item.id));
    actions.append(rename, remove);
    row.append(button, actions);
    host.appendChild(row);
  }
  if (!visibleConversations.length) {
    const empty = document.createElement("p");
    empty.className = "sidebar-empty";
    if (query) empty.textContent = "No conversations match that search.";
    else if (state.selectedProjectId !== "all") empty.textContent = "No chats in this project yet.";
    else empty.textContent = "Your conversations will appear here.";
    host.appendChild(empty);
  }
}

function activeConversationStorageKey() {
  return `alfie:activeConversation:${state.user?.id || state.user?.username || "default"}`;
}

function rememberActiveConversation(id) {
  try {
    const key = activeConversationStorageKey();
    if (id) localStorage.setItem(key, String(id));
    else localStorage.removeItem(key);
  } catch {}
}

function getRememberedActiveConversationId() {
  try {
    return localStorage.getItem(activeConversationStorageKey()) || null;
  } catch {
    return null;
  }
}

function renderConversations(conversations = []) {
  renderConversationList($("#conversation-list"), conversations);
  renderConversationList($("#mobile-conversation-list"), conversations);
  renderProjects();
}

async function loadConversations() {
  const payload = await api("/api/core/conversations");
  const conversations = payload.conversations || [];
  state.conversations = conversations;
  if (
    state.selectedProjectId !== "all" &&
    state.selectedProjectId !== "unassigned" &&
    state.projects.length &&
    !state.projects.some((project) => project.id === state.selectedProjectId)
  ) {
    state.selectedProjectId = "all";
  }
  if (state.activeConversationId && !conversations.some((item) => item.id === state.activeConversationId)) {
    state.activeConversationId = null;
    state.activeConversation = null;
    state.messages = [];
    rememberActiveConversation(null);
  }
  renderConversations(conversations);
  if (!state.activeConversationId && conversations.length) {
    const rememberedId = getRememberedActiveConversationId();
    const targetId = rememberedId && conversations.some((item) => item.id === rememberedId)
      ? rememberedId
      : conversations[0].id;
    await loadConversation(targetId);
  } else {
    syncChatContextBar();
  }
}

async function loadConversation(id) {
  if (state.sending) {
    cancelActiveChatRequest({ silent: true });
  }
  const cleanId = String(id || "").replace(/^conversation:/i, "").trim();
  if (!cleanId) return;
  const token = ++state.conversationLoadToken;
  state.conversationLoading = true;
  try {
    const payload = await api("/api/core/conversations/" + encodeURIComponent(cleanId));
    if (token !== state.conversationLoadToken) return;
    state.activeConversationId = cleanId;
    state.activeConversation = payload.conversation || null;
    state.messages = payload.conversation?.messages || [];
    rememberActiveConversation(cleanId);
    renderMessages();
    await restoreBackgroundTaskNotice(cleanId);
    syncChatContextBar();
    renderVramWarningBanner();
    const list = await api("/api/core/conversations");
    if (token === state.conversationLoadToken) {
      state.conversations = list.conversations || [];
      renderConversations(state.conversations);
    }
  } finally {
    if (token === state.conversationLoadToken) state.conversationLoading = false;
    syncChatContextBar();
  }
}

async function newConversation({ fromSend = false, projectId = undefined } = {}) {
  if (state.sending && !fromSend) {
    cancelActiveChatRequest({ silent: true });
  }
  const token = ++state.conversationLoadToken;
  state.conversationLoading = true;
  $("#mobile-history-sheet").hidden = true;
  const resolvedProjectId = projectId !== undefined
    ? projectId
    : (state.selectedProjectId !== "all" && state.selectedProjectId !== "unassigned" ? state.selectedProjectId : null);
  try {
    const payload = await api("/api/core/conversations", {
      method: "POST",
      body: JSON.stringify({
        title: "New conversation",
        ...(resolvedProjectId ? { projectId: resolvedProjectId } : {})
      })
    });
    if (token !== state.conversationLoadToken) return;
    state.activeConversationId = payload.conversation.id;
    state.activeConversation = payload.conversation;
    state.messages = [];
    rememberActiveConversation(payload.conversation.id);
    renderMessages();
    syncChatContextBar();
    renderVramWarningBanner();
    await loadConversations();
    setView("chat");
  } finally {
    if (token === state.conversationLoadToken) state.conversationLoading = false;
    syncChatContextBar();
  }
}

$("#new-chat").addEventListener("click", () => newConversation().catch((error) => toast(error.message)));
$("#refresh-conversations").addEventListener("click", () => Promise.all([loadProjects(), loadConversations()]).catch((error) => toast(error.message)));
["#history-search", "#mobile-history-search"].forEach((selector) => {
  $(selector)?.addEventListener("input", () => renderConversations(state.conversations));
});

async function renameConversation(id, currentTitle) {
  if (state.sending || state.conversationLoading) { toast("Wait for the current conversation action to finish."); return; }
  const entered = window.prompt("Rename conversation", currentTitle);
  if (entered === null) return;
  const title = entered.replace(/\s+/g, " ").trim();
  if (!title || title.length > 120) { toast("Choose a title between 1 and 120 characters."); return; }
  try {
    await api("/api/core/conversations/" + encodeURIComponent(id), {
      method: "PATCH",
      body: JSON.stringify({ title })
    });
    if (state.activeConversation?.id === id) {
      state.activeConversation = { ...state.activeConversation, title };
    }
    await loadConversations();
    toast("Conversation renamed.");
  } catch (error) { toast(error.message); }
}

async function deleteConversation(id) {
  if (state.sending || state.conversationLoading) { toast("Wait for the current conversation action to finish."); return; }
  if (!confirm("Delete this conversation and its messages? This cannot be undone.")) return;
  try {
    await api("/api/core/conversations/" + encodeURIComponent(id), { method: "DELETE", body: "{}" });
    if (state.activeConversationId === id) {
      state.activeConversationId = null;
      state.activeConversation = null;
      state.messages = [];
      rememberActiveConversation(null);
      state.conversationLoadToken += 1;
      renderMessages();
      syncChatContextBar();
      renderVramWarningBanner();
    }
    await loadConversations();
    toast("Conversation deleted.");
  } catch (error) { toast(error.message); }
}

window.alfieProjects = {
  getState: () => ({
    projects: state.projects,
    selectedProjectId: state.selectedProjectId,
    activeConversationId: state.activeConversationId,
    activeConversation: state.activeConversation,
    vram: state.vram
  }),
  refreshVram: refreshVramStatus,
  continueInNewChat,
  openProjectModal
};

const LIGHTBOX_MIN_ZOOM = 0.5;
const LIGHTBOX_MAX_ZOOM = 4;
const LIGHTBOX_ZOOM_STEP = 0.25;

const lightboxState = {
  open: false,
  url: "",
  alt: "",
  zoom: 1,
  panX: 0,
  panY: 0,
  dragging: false,
  dragMoved: false,
  dragStartX: 0,
  dragStartY: 0,
  panStartX: 0,
  panStartY: 0,
  lastTrigger: null
};

function clampLightboxZoom(zoom) {
  const num = Number(zoom);
  if (!Number.isFinite(num)) return 1;
  return Math.min(LIGHTBOX_MAX_ZOOM, Math.max(LIGHTBOX_MIN_ZOOM, Math.round(num * 100) / 100));
}

function buildLightboxFilename(alt, url) {
  const safeName = String(alt || "alfie-art").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "alfie-art";
  const ext = String(url || "").toLowerCase().includes(".svg") ? ".svg" : ".png";
  return safeName + ext;
}

function renderLightboxTransform() {
  const img = $("#lightbox-image");
  const readout = $("#lightbox-zoom-level");
  const zoomOutBtn = $("#lightbox-zoom-out");
  const zoomInBtn = $("#lightbox-zoom-in");
  const zoomResetBtn = $("#lightbox-zoom-reset");
  if (img) {
    img.style.transform = `translate3d(${lightboxState.panX}px, ${lightboxState.panY}px, 0) scale(${lightboxState.zoom})`;
    img.classList.toggle("is-zoomed", lightboxState.zoom > 1);
    img.classList.toggle("is-dragging", lightboxState.dragging);
  }
  if (readout) {
    readout.textContent = `${Math.round(lightboxState.zoom * 100)}%`;
  }
  if (zoomOutBtn) zoomOutBtn.disabled = lightboxState.zoom <= LIGHTBOX_MIN_ZOOM;
  if (zoomInBtn) zoomInBtn.disabled = lightboxState.zoom >= LIGHTBOX_MAX_ZOOM;
  if (zoomResetBtn) zoomResetBtn.disabled = lightboxState.zoom === 1 && lightboxState.panX === 0 && lightboxState.panY === 0;
}

function setLightboxZoom(nextZoom) {
  const clamped = clampLightboxZoom(nextZoom);
  lightboxState.zoom = clamped;
  if (clamped <= 1) {
    lightboxState.panX = 0;
    lightboxState.panY = 0;
  }
  renderLightboxTransform();
  return clamped;
}

function resetLightboxView() {
  lightboxState.zoom = 1;
  lightboxState.panX = 0;
  lightboxState.panY = 0;
  lightboxState.dragging = false;
  renderLightboxTransform();
}

function openImageLightbox({ url, alt = "Generated visual asset", triggerEl = null } = {}) {
  const modal = $("#image-lightbox");
  const img = $("#lightbox-image");
  const titleEl = $("#lightbox-title");
  const downloadEl = $("#lightbox-download");
  const fallbackEl = $("#lightbox-fallback");
  if (!modal || !img || !url) return;

  lightboxState.open = true;
  lightboxState.url = url;
  lightboxState.alt = alt || "Generated visual asset";
  lightboxState.lastTrigger = triggerEl || document.activeElement;

  if (fallbackEl) fallbackEl.hidden = true;
  img.hidden = false;
  img.src = url;
  img.alt = lightboxState.alt;
  if (titleEl) titleEl.textContent = lightboxState.alt;
  if (downloadEl) {
    downloadEl.href = url;
    downloadEl.download = buildLightboxFilename(lightboxState.alt, url);
  }

  resetLightboxView();
  modal.hidden = false;
  $("#lightbox-close")?.focus({ preventScroll: true });
}

function closeImageLightbox() {
  const modal = $("#image-lightbox");
  if (!modal || !lightboxState.open) return;
  lightboxState.open = false;
  lightboxState.dragging = false;
  modal.hidden = true;
  const img = $("#lightbox-image");
  if (img) img.classList.remove("is-dragging", "is-zoomed");
  const trigger = lightboxState.lastTrigger;
  lightboxState.lastTrigger = null;
  if (trigger && typeof trigger.focus === "function" && document.contains(trigger)) {
    trigger.focus({ preventScroll: true });
  }
}

function initImageLightbox() {
  const modal = $("#image-lightbox");
  if (!modal || modal.dataset.bound === "true") return;
  modal.dataset.bound = "true";

  const img = $("#lightbox-image");
  const stage = $("#lightbox-stage");
  const fallbackEl = $("#lightbox-fallback");

  img?.addEventListener("error", () => {
    if (!lightboxState.open) return;
    img.hidden = true;
    if (fallbackEl) fallbackEl.hidden = false;
  });

  $("#lightbox-close")?.addEventListener("click", closeImageLightbox);
  modal.querySelector("[data-lightbox-close='backdrop']")?.addEventListener("click", closeImageLightbox);
  $("#lightbox-zoom-in")?.addEventListener("click", () => setLightboxZoom(lightboxState.zoom + LIGHTBOX_ZOOM_STEP));
  $("#lightbox-zoom-out")?.addEventListener("click", () => setLightboxZoom(lightboxState.zoom - LIGHTBOX_ZOOM_STEP));
  $("#lightbox-zoom-reset")?.addEventListener("click", resetLightboxView);

  stage?.addEventListener("click", (event) => {
    if (event.target === stage) {
      closeImageLightbox();
    }
  });

  img?.addEventListener("click", (event) => {
    event.stopPropagation();
    if (lightboxState.dragMoved) {
      lightboxState.dragMoved = false;
      return;
    }
    setLightboxZoom(lightboxState.zoom > 1 ? 1 : 2);
  });

  stage?.addEventListener("wheel", (event) => {
    if (!lightboxState.open) return;
    event.preventDefault();
    const delta = event.deltaY < 0 ? LIGHTBOX_ZOOM_STEP : -LIGHTBOX_ZOOM_STEP;
    setLightboxZoom(lightboxState.zoom + delta);
  }, { passive: false });

  img?.addEventListener("pointerdown", (event) => {
    if (lightboxState.zoom <= 1) return;
    event.preventDefault();
    lightboxState.dragging = true;
    lightboxState.dragMoved = false;
    lightboxState.dragStartX = event.clientX;
    lightboxState.dragStartY = event.clientY;
    lightboxState.panStartX = lightboxState.panX;
    lightboxState.panStartY = lightboxState.panY;
    img.setPointerCapture?.(event.pointerId);
    renderLightboxTransform();
  });

  window.addEventListener("pointermove", (event) => {
    if (!lightboxState.dragging) return;
    const dx = event.clientX - lightboxState.dragStartX;
    const dy = event.clientY - lightboxState.dragStartY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      lightboxState.dragMoved = true;
    }
    lightboxState.panX = lightboxState.panStartX + dx;
    lightboxState.panY = lightboxState.panStartY + dy;
    renderLightboxTransform();
  });

  const stopDrag = () => {
    if (!lightboxState.dragging) return;
    lightboxState.dragging = false;
    renderLightboxTransform();
  };
  window.addEventListener("pointerup", stopDrag);
  window.addEventListener("pointercancel", stopDrag);

  document.addEventListener("keydown", (event) => {
    if (!lightboxState.open) return;
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      setLightboxZoom(lightboxState.zoom + LIGHTBOX_ZOOM_STEP);
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      setLightboxZoom(lightboxState.zoom - LIGHTBOX_ZOOM_STEP);
    } else if (event.key === "0") {
      event.preventDefault();
      resetLightboxView();
    } else if (event.key === "Tab") {
      const focusable = Array.from(modal.querySelectorAll("button:not(:disabled), a[href]"));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
}

if (typeof window !== "undefined") {
  window.alfieLightbox = {
    open: openImageLightbox,
    close: closeImageLightbox,
    setZoom: setLightboxZoom,
    reset: resetLightboxView,
    getState: () => ({ ...lightboxState })
  };
  initImageLightbox();
}

function createImageCard(alt, url) {
  const card = document.createElement("figure");
  card.className = "chat-image-card";

  const wrapper = document.createElement("div");
  wrapper.className = "chat-image-wrapper";
  wrapper.title = "Click to view full screen";

  const img = document.createElement("img");
  img.src = url;
  img.alt = alt || "Alfie visual asset";
  img.className = "chat-image-img";
  img.loading = "lazy";
  img.referrerPolicy = "no-referrer";
  img.tabIndex = 0;
  img.setAttribute("role", "button");
  img.setAttribute("aria-label", `View full screen: ${alt || "Alfie visual asset"}`);

  const handleOpen = (event) => {
    event.preventDefault();
    event.stopPropagation();
    openImageLightbox({ url, alt: alt || "Generated visual asset", triggerEl: img });
  };
  wrapper.addEventListener("click", handleOpen);
  img.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      handleOpen(event);
    }
  });

  wrapper.appendChild(img);
  card.appendChild(wrapper);

  const meta = document.createElement("figcaption");
  meta.className = "chat-image-meta";

  const promptSpan = document.createElement("span");
  promptSpan.className = "chat-image-prompt";
  promptSpan.title = alt || "Visual asset";
  promptSpan.textContent = alt || "Generated visual asset";

  const actions = document.createElement("div");
  actions.className = "chat-image-actions";

  const downloadLink = document.createElement("a");
  downloadLink.href = url;
  downloadLink.download = buildLightboxFilename(alt, url);
  downloadLink.className = "chat-image-btn";
  downloadLink.title = "Download image asset";
  downloadLink.innerHTML = '<span aria-hidden="true">⬇</span> Download';

  const expandBtn = document.createElement("button");
  expandBtn.type = "button";
  expandBtn.className = "chat-image-btn";
  expandBtn.title = "View full screen with zoom";
  expandBtn.innerHTML = '<span aria-hidden="true">⤢</span> Expand';
  expandBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    openImageLightbox({ url, alt: alt || "Generated visual asset", triggerEl: expandBtn });
  });

  actions.append(downloadLink, expandBtn);
  meta.append(promptSpan, actions);
  card.appendChild(meta);

  return card;
}

function appendInlineMarkdown(parent, source) {
  const text = String(source || "");
  const pattern = /!\[([^\]]*)\]\(([^)\s]+)\)|\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const token = match[0];
    if (match.index > cursor) parent.appendChild(document.createTextNode(text.slice(cursor, match.index)));
    if (token.startsWith("![")) {
      const imgMatch = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(token);
      if (imgMatch) {
        parent.appendChild(createImageCard(imgMatch[1], imgMatch[2]));
      } else {
        parent.appendChild(document.createTextNode(token));
      }
    } else if (token.startsWith("**")) {
      const node = document.createElement("strong");
      node.textContent = token.slice(2, -2);
      parent.appendChild(node);
    } else if (token.startsWith("`")) {
      const node = document.createElement("code");
      node.textContent = token.slice(1, -1);
      parent.appendChild(node);
    } else if (token.startsWith("*")) {
      const node = document.createElement("em");
      node.textContent = token.slice(1, -1);
      parent.appendChild(node);
    } else {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      if (link) {
        const node = document.createElement("a");
        node.textContent = link[1];
        node.href = link[2];
        node.target = "_blank";
        node.rel = "noopener noreferrer nofollow";
        parent.appendChild(node);
      } else {
        parent.appendChild(document.createTextNode(token));
      }
    }
    cursor = match.index + token.length;
  }
  if (cursor < text.length) parent.appendChild(document.createTextNode(text.slice(cursor)));
}

/* Clipboard Copy Utility for AI Responses */
async function copyTextToClipboard(text) {
  const content = String(text || "").trim();
  if (!content) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(content);
      return true;
    }
  } catch {}
  try {
    const textarea = document.createElement("textarea");
    textarea.value = content;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "-9999px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const successful = document.execCommand("copy");
    textarea.remove();
    if (successful) return true;
  } catch {}
  return false;
}

function attachCopyButtonToBody(body, rawContent) {
  if (!body) return null;
  const content = String(rawContent || "").trim();
  body.dataset.rawContent = content;

  // Clean up any existing copy button to avoid duplicates
  body.querySelector(":scope > .copy-clipboard-btn")?.remove();

  if (!content) return null;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "copy-clipboard-btn";
  btn.setAttribute("aria-label", "Copy to clipboard");
  btn.title = "Copy to clipboard";
  btn.innerHTML = '<span class="copy-icon" aria-hidden="true">📋</span><span class="copy-label">Copy to clipboard</span>';

  let resetTimer = null;
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const textToCopy = body.dataset.rawContent || content;
    if (!textToCopy) return;
    const ok = await copyTextToClipboard(textToCopy);
    if (ok) {
      btn.classList.add("copied");
      btn.setAttribute("aria-label", "Copied to clipboard");
      btn.innerHTML = '<span class="copy-icon" aria-hidden="true">✓</span><span class="copy-label">Copied to clipboard</span>';
      toast("Copied to clipboard");
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        btn.classList.remove("copied");
        btn.setAttribute("aria-label", "Copy to clipboard");
        btn.innerHTML = '<span class="copy-icon" aria-hidden="true">📋</span><span class="copy-label">Copy to clipboard</span>';
      }, 2000);
    } else {
      toast("Unable to copy to clipboard.");
    }
  });

  body.appendChild(btn);
  return btn;
}

window.copyTextToClipboard = copyTextToClipboard;
window.attachCopyButtonToBody = attachCopyButtonToBody;

function renderMarkdown(container, source) {
  container.replaceChildren();
  const lines = String(source || "").replace(/\r\n/g, "\n").split("\n");
  let paragraph = []; let list = null; let listType = ""; let codeLines = null;
  const flushParagraph = () => { if (!paragraph.length) return; const node = document.createElement("p"); appendInlineMarkdown(node, paragraph.join("\n")); container.appendChild(node); paragraph = []; };
  const flushList = () => { if (list) container.appendChild(list); list = null; listType = ""; };
  const appendPreBlock = (linesArr) => {
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    const codeText = linesArr.join("\n");
    code.textContent = codeText;
    pre.appendChild(code);
    const copyCodeBtn = document.createElement("button");
    copyCodeBtn.type = "button";
    copyCodeBtn.className = "copy-code-btn";
    copyCodeBtn.setAttribute("aria-label", "Copy code snippet");
    copyCodeBtn.title = "Copy code";
    copyCodeBtn.textContent = "Copy";
    copyCodeBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const ok = await copyTextToClipboard(codeText);
      if (ok) {
        copyCodeBtn.classList.add("copied");
        copyCodeBtn.textContent = "Copied!";
        toast("Code copied to clipboard");
        setTimeout(() => {
          copyCodeBtn.classList.remove("copied");
          copyCodeBtn.textContent = "Copy";
        }, 2000);
      }
    });
    pre.appendChild(copyCodeBtn);
    container.appendChild(pre);
  };

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      flushParagraph(); flushList();
      if (codeLines) {
        appendPreBlock(codeLines);
        codeLines = null;
      } else {
        codeLines = [];
      }
      continue;
    }
    if (codeLines) { codeLines.push(line); continue; }
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    const imgMatch = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(line.trim());
    if (imgMatch) {
      flushParagraph(); flushList();
      container.appendChild(createImageCard(imgMatch[1], imgMatch[2]));
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) { flushParagraph(); flushList(); const node = document.createElement("h" + heading[1].length); appendInlineMarkdown(node, heading[2]); container.appendChild(node); continue; }
    const item = /^\s*(?:[-*]\s+|\d+\.\s+)(.+)$/.exec(line);
    if (item) { flushParagraph(); const type = /^\s*\d+\.\s+/.test(line) ? "ol" : "ul"; if (list && listType !== type) flushList(); if (!list) { list = document.createElement(type); listType = type; } const li = document.createElement("li"); appendInlineMarkdown(li, item[1]); list.appendChild(li); continue; }
    flushList(); paragraph.push(line);
  }
  flushParagraph(); flushList();
  if (codeLines) {
    appendPreBlock(codeLines);
  }
}
function formatToolDisplay(toolId, toolName) {
  const id = String(toolId || "").toLowerCase();
  const name = String(toolName || "").toLowerCase();
  if (id.includes("calendar") || name.includes("calendar")) return "Browsing calendar…";
  if (id.includes("mail") || name.includes("mail") || id.includes("inbox")) return "Searching mail…";
  if (id.includes("journal") || name.includes("journal")) return "Searching journal…";
  if (id.includes("project") || id.includes("tasks") || id.includes("roadmap") || name.includes("roadmap")) return "Checking project roadmap…";
  if (id.includes("quest") || id.includes("progress")) return "Reading quest progress…";
  if (id.includes("status") || name.includes("status")) return "Checking Petrio OS status…";
  if (id.includes("world")) return "Reading Petrio world model…";
  if (id.includes("audit")) return "Auditing repository code…";
  if (id.includes("memory") || id.includes("memories")) return "Consulting memory…";
  return toolName ? `Using ${toolName}…` : `Accessing ${toolId}…`;
}

function createThinkingIndicator() {
  const container = document.createElement("div");
  container.className = "thinking-indicator";
  container.setAttribute("role", "status");
  container.setAttribute("aria-live", "polite");
  container.setAttribute("aria-label", "Alfie is thinking");

  const beacon = document.createElement("div");
  beacon.className = "thinking-beacon";
  beacon.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 3; i++) {
    const dot = document.createElement("span");
    dot.className = "thinking-dot";
    beacon.appendChild(dot);
  }

  const status = document.createElement("div");
  status.className = "thinking-status";

  const label = document.createElement("span");
  label.className = "thinking-label";
  label.textContent = "Alfie";

  const stage = document.createElement("span");
  stage.className = "thinking-stage";
  stage.textContent = "thinking…";

  const timer = document.createElement("span");
  timer.className = "thinking-timer";
  timer.textContent = "0.0s";

  status.append(label, stage, timer);
  container.append(beacon, status);

  let activeToolAction = null;
  const start = Date.now();
  let interval = setInterval(() => {
    const sec = (Date.now() - start) / 1000;
    timer.textContent = sec.toFixed(1) + "s";
    if (activeToolAction) {
      stage.textContent = activeToolAction;
    } else if (sec >= 8) {
      stage.textContent = "synthesizing response…";
    } else if (sec >= 3.5) {
      stage.textContent = "consulting memory & tools…";
    }
  }, 100);

  function stop() {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
  }

  function setStage(text) {
    activeToolAction = text;
    stage.textContent = text;
  }

  function setTool(toolId, toolName, actionText, isExternal = true) {
    const text = actionText || formatToolDisplay(toolId, toolName);
    activeToolAction = text;
    stage.textContent = text;
    if (isExternal) stage.classList.add("stage-external");
    else stage.classList.remove("stage-external");
    container.setAttribute("aria-label", "Alfie is " + text.replace(/…$/, ""));
  }

  return { element: container, stop, setStage, setTool };
}

function formatLatency(ms) {
  if (typeof ms !== "number" || isNaN(ms) || ms < 0) return null;
  if (ms < 1000) return Math.round(ms) + "ms";
  return (ms / 1000).toFixed(1) + "s";
}

function formatTokens(count) {
  if (typeof count !== "number" || isNaN(count) || count < 0) return null;
  if (count >= 1000) return (count / 1000).toFixed(1) + "k";
  return String(Math.round(count));
}

function createMetricsBadge(message) {
  if (!message || message.role !== "assistant") return null;
  const metrics = message.metrics || {};
  const latencyMs = Number.isFinite(Number(metrics.latencyMs)) ? Number(metrics.latencyMs) : null;
  const completionTokens = Number.isFinite(Number(metrics.completionTokens))
    ? Number(metrics.completionTokens)
    : (Number.isFinite(Number(metrics.totalTokens))
      ? Number(metrics.totalTokens)
      : (message.content ? Math.max(1, Math.round(message.content.length / 4)) : null));
  const totalTokens = Number.isFinite(Number(metrics.totalTokens)) ? Number(metrics.totalTokens) : completionTokens;
  const model = typeof metrics.model === "string" ? metrics.model.trim() : null;

  if (latencyMs == null && completionTokens == null) return null;

  const badge = document.createElement("div");
  badge.className = "message-meta-badge";
  badge.tabIndex = 0;
  badge.setAttribute("role", "button");
  badge.setAttribute("aria-label", "Performance metrics");

  const labelParts = [];
  const latencyLabel = formatLatency(latencyMs);
  if (latencyLabel) labelParts.push(latencyLabel);
  const tokenLabel = formatTokens(completionTokens);
  if (tokenLabel) labelParts.push(tokenLabel + " tok");

  const textSpan = document.createElement("span");
  textSpan.className = "meta-badge-text";
  textSpan.textContent = labelParts.join(" · ") || "metrics";
  badge.appendChild(textSpan);

  const tooltip = document.createElement("div");
  tooltip.className = "message-tooltip";
  tooltip.setAttribute("role", "tooltip");

  const title = document.createElement("span");
  title.className = "tooltip-title";
  title.textContent = "Response Metrics";
  tooltip.appendChild(title);

  const dl = document.createElement("dl");
  dl.className = "tooltip-grid";

  function addRow(term, val) {
    if (!val) return;
    const row = document.createElement("div");
    row.className = "tooltip-row";
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = val;
    row.append(dt, dd);
    dl.appendChild(row);
  }

  if (latencyMs != null) {
    addRow("Latency", latencyMs >= 1000 ? (latencyMs / 1000).toFixed(2) + "s (" + Math.round(latencyMs) + " ms)" : Math.round(latencyMs) + " ms");
  }

  if (completionTokens != null) {
    if (totalTokens != null && totalTokens !== completionTokens) {
      addRow("Tokens", completionTokens + " out / " + totalTokens + " total");
    } else {
      addRow("Tokens", String(completionTokens) + " tokens");
    }
  }

  if (latencyMs != null && latencyMs > 0 && completionTokens != null && completionTokens > 0) {
    const tokPerSec = Math.round((completionTokens / (latencyMs / 1000)) * 10) / 10;
    if (tokPerSec > 0 && isFinite(tokPerSec)) {
      addRow("Speed", tokPerSec + " tok/s");
    }
  }

  if (model) {
    addRow("Model", model);
  }

  if (metrics.privacyLabel) {
    addRow("Privacy", metrics.privacyLabel);
  }

  tooltip.appendChild(dl);
  badge.appendChild(tooltip);
  return badge;
}

function createReactionControls(message) {
  const container = document.createElement("div");
  container.className = "message-actions";
  container.setAttribute("role", "group");
  container.setAttribute("aria-label", "Message actions and feedback");

  // Injected 'Copy to clipboard' button into .message-actions
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "reaction-btn copy copy-clipboard-btn";
  copyBtn.setAttribute("aria-label", "Copy to clipboard");
  copyBtn.title = "Copy to clipboard";
  copyBtn.innerHTML = '<span class="copy-icon" aria-hidden="true">📋</span><span class="reaction-label">Copy to clipboard</span>';

  let resetTimer = null;
  copyBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const article = container.closest(".message");
    const rawContent = article?.querySelector(".message-body")?.dataset.rawContent || message?.content || article?.querySelector(".message-body")?.textContent || "";
    const textToCopy = String(rawContent).trim();
    if (!textToCopy) return;
    const ok = await copyTextToClipboard(textToCopy);
    if (ok) {
      copyBtn.classList.add("copied");
      copyBtn.setAttribute("aria-label", "Copied to clipboard");
      copyBtn.innerHTML = '<span class="copy-icon" aria-hidden="true">✓</span><span class="reaction-label">Copied to clipboard</span>';
      toast("Copied to clipboard");
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        copyBtn.classList.remove("copied");
        copyBtn.setAttribute("aria-label", "Copy to clipboard");
        copyBtn.innerHTML = '<span class="copy-icon" aria-hidden="true">📋</span><span class="reaction-label">Copy to clipboard</span>';
      }, 2000);
    } else {
      toast("Unable to copy to clipboard.");
    }
  });

  const currentReaction = message?.reaction || null;

  const likeBtn = document.createElement("button");
  likeBtn.type = "button";
  likeBtn.className = "reaction-btn like" + (currentReaction === "like" ? " active" : "");
  likeBtn.setAttribute("aria-label", "Like response as helpful");
  likeBtn.title = "Helpful response (Like)";
  likeBtn.innerHTML = '<span aria-hidden="true">👍</span><span class="reaction-label">' + (currentReaction === "like" ? "Liked" : "Like") + '</span>';

  const flagBtn = document.createElement("button");
  flagBtn.type = "button";
  flagBtn.className = "reaction-btn flag" + (currentReaction === "flag" ? " active" : "");
  flagBtn.setAttribute("aria-label", "Flag response for future sessions");
  flagBtn.title = "Flag for review in future sessions";
  flagBtn.innerHTML = '<span aria-hidden="true">🚩</span><span class="reaction-label">' + (currentReaction === "flag" ? "Flagged" : "Flag") + '</span>';

  const tag = document.createElement("span");
  tag.className = "reaction-feedback-tag";
  if (currentReaction === "like") {
    tag.textContent = "Saved to session memory";
    tag.hidden = false;
  } else if (currentReaction === "flag") {
    tag.textContent = "Flagged for future sessions";
    tag.hidden = false;
  } else {
    tag.hidden = true;
  }

  async function setReaction(targetReaction) {
    if (!state.activeConversationId || !message?.id) {
      toast("Reaction feedback is saved once the message is recorded.");
      return;
    }
    const prevReaction = message.reaction || null;
    const nextReaction = prevReaction === targetReaction ? null : targetReaction;

    // Optimistic UI updates
    message.reaction = nextReaction || undefined;
    likeBtn.classList.toggle("active", nextReaction === "like");
    likeBtn.querySelector(".reaction-label").textContent = nextReaction === "like" ? "Liked" : "Like";
    flagBtn.classList.toggle("active", nextReaction === "flag");
    flagBtn.querySelector(".reaction-label").textContent = nextReaction === "flag" ? "Flagged" : "Flag";

    if (nextReaction === "like") {
      tag.textContent = "Saved to session memory";
      tag.hidden = false;
      toast("Marked as helpful. Feedback will guide future sessions.");
    } else if (nextReaction === "flag") {
      tag.textContent = "Flagged for future sessions";
      tag.hidden = false;
      toast("Flagged for review. Alfie will adjust in future sessions.");
    } else {
      tag.hidden = true;
      toast("Feedback reaction cleared.");
    }

    try {
      const res = await api("/api/core/conversations/" + encodeURIComponent(state.activeConversationId) + "/messages/" + encodeURIComponent(message.id) + "/reaction", {
        method: "POST",
        body: JSON.stringify({ reaction: nextReaction })
      });
      if (res?.learnedFeedback?.profile) {
        state.workflowProfile = res.learnedFeedback.profile;
        renderWorkflowProfile();
      }
      const learnedSignals = Array.isArray(res?.learnedFeedback?.signals) ? res.learnedFeedback.signals : [];
      if (nextReaction === "like") {
        tag.textContent = learnedSignals.length
          ? "Learned: " + learnedSignals.slice(0, 2).join(" · ")
          : "Saved to response taste";
        tag.hidden = false;
      } else if (nextReaction === "flag") {
        tag.textContent = learnedSignals.length
          ? "Noted: avoid " + learnedSignals.slice(0, 2).join(" · ").toLowerCase()
          : "Flagged for future sessions";
        tag.hidden = false;
      }
    } catch (error) {
      message.reaction = prevReaction || undefined;
      likeBtn.classList.toggle("active", prevReaction === "like");
      likeBtn.querySelector(".reaction-label").textContent = prevReaction === "like" ? "Liked" : "Like";
      flagBtn.classList.toggle("active", prevReaction === "flag");
      flagBtn.querySelector(".reaction-label").textContent = prevReaction === "flag" ? "Flagged" : "Flag";
      tag.hidden = !prevReaction;
      toast(error.message || "Failed to update reaction.");
    }
  }

  likeBtn.addEventListener("click", () => setReaction("like"));
  flagBtn.addEventListener("click", () => setReaction("flag"));

  container.append(copyBtn, likeBtn, flagBtn, tag);
  return container;
}

function createProvenanceDisclosure(provenance) {
  if (!provenance || typeof provenance !== "object") return null;
  const details = document.createElement("details");
  details.className = "turn-provenance";

  const summary = document.createElement("summary");
  summary.className = "turn-provenance-summary";
  const parts = ["Context & provenance"];
  if (provenance.workingMode?.label) parts.push(provenance.workingMode.label);
  if (provenance.project?.name) parts.push(`Project: ${provenance.project.name}`);
  const memCount = Array.isArray(provenance.memoriesInjected) ? provenance.memoriesInjected.length : 0;
  parts.push(`${memCount} ${memCount === 1 ? "memory" : "memories"}`);
  if (provenance.tainted) parts.push("Untrusted input isolated");
  summary.textContent = parts.join(" · ");

  const body = document.createElement("div");
  body.className = "turn-provenance-body";

  const rows = [
    ["Working mode", provenance.workingMode?.label || "Companion"],
    ...(provenance.learningMode?.label ? [["Learning posture", provenance.learningMode.label]] : []),
    ["Project dossier", provenance.project?.name ? `${provenance.project.name} (${provenance.project.status || "active"})` : "None attached"],
    ["Memories injected", memCount ? provenance.memoriesInjected.map((m) => {
      const kind = m.kind && m.kind !== "note" ? `${m.kind} · ` : "";
      const trust = m.trust === "external_untrusted" ? " · untrusted" : "";
      return `${m.title} (${kind}${m.importance}/10${trust})`;
    }).join(" · ") : "None matched"],
    ["Tools shortlisted", Array.isArray(provenance.toolsShortlisted) && provenance.toolsShortlisted.length ? provenance.toolsShortlisted.join(", ") : "None"],
    ["Tools invoked", Array.isArray(provenance.toolsUsed) && provenance.toolsUsed.length ? provenance.toolsUsed.join(", ") : "None"],
    ["Trust boundary", provenance.tainted ? "External/untrusted data present (write actions require approval)" : "Clean local turn"],
    ["Privacy filter", provenance.privacyFiltered
      ? (provenance.blockedCategories?.length ? `Cloud filter active · Blocked: ${provenance.blockedCategories.join(", ")}` : "Cloud filter active")
      : "Local Core only"]
  ];

  for (const [k, v] of rows) {
    const row = document.createElement("div");
    row.className = "turn-provenance-row";
    const keyEl = document.createElement("span");
    keyEl.className = "turn-provenance-key";
    keyEl.textContent = k;
    const valEl = document.createElement("span");
    valEl.className = "turn-provenance-val";
    valEl.textContent = v;
    row.append(keyEl, valEl);
    body.appendChild(row);
  }

  details.append(summary, body);
  return details;
}

function createAutoMemoryDisclosure(autoMemories) {
  if (!Array.isArray(autoMemories) || !autoMemories.length) return null;
  const details = document.createElement("details");
  details.className = "auto-memory-disclosure";

  const summary = document.createElement("summary");
  summary.className = "auto-memory-summary";
  const firstTitle = String(autoMemories[0]?.title || autoMemories[0]?.text || "Saved to Garden").slice(0, 72);
  summary.textContent = autoMemories.length === 1
    ? `✦ Memory updated · ${firstTitle}`
    : `✦ Memory updated · ${autoMemories.length} items saved`;

  const list = document.createElement("div");
  list.className = "auto-memory-list";

  for (const item of autoMemories) {
    const row = document.createElement("div");
    row.className = "auto-memory-item";

    const info = document.createElement("div");
    info.className = "auto-memory-copy";
    const kindTag = document.createElement("span");
    kindTag.className = "auto-memory-kind";
    kindTag.textContent = String(item.kind || "fact").toUpperCase();
    const textEl = document.createElement("span");
    textEl.className = "auto-memory-text";
    textEl.textContent = item.text || item.title || "Saved memory";
    info.append(kindTag, textEl);

    const actions = document.createElement("div");
    actions.className = "auto-memory-actions";

    const viewBtn = document.createElement("button");
    viewBtn.type = "button";
    viewBtn.className = "secondary-button auto-memory-btn";
    viewBtn.textContent = "Garden";
    viewBtn.addEventListener("click", () => {
      setView("garden");
      loadMemories().catch(() => {});
    });
    actions.appendChild(viewBtn);

    if (item.id) {
      const forgetBtn = document.createElement("button");
      forgetBtn.type = "button";
      forgetBtn.className = "secondary-button auto-memory-btn";
      forgetBtn.textContent = "Forget";
      forgetBtn.addEventListener("click", async () => {
        forgetBtn.disabled = true;
        try {
          await api("/api/core/memories/" + encodeURIComponent(item.id), { method: "DELETE", body: "{}" });
          row.remove();
          if (!list.children.length) details.remove();
          toast("Forgot auto-saved memory.");
        } catch (error) {
          forgetBtn.disabled = false;
          toast(error.message || "Could not remove memory.");
        }
      });
      actions.appendChild(forgetBtn);
    }

    row.append(info, actions);
    list.appendChild(row);
  }

  details.append(summary, list);
  return details;
}

function unwrapToolResultPayload(result) {
  if (typeof result !== "string") return result;
  let text = result.trim();
  const untrustedMatch = /^<untrusted_data(?:\s+[^>]*)?>([\s\S]*?)<\/untrusted_data>$/i.exec(text);
  if (untrustedMatch) {
    text = untrustedMatch[1].trim();
  }
  if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
    try {
      return JSON.parse(text);
    } catch {}
  }
  return text;
}

function formatApprovedToolResultForContinuation(toolId, result) {
  const unwrapped = unwrapToolResultPayload(result);
  if (typeof unwrapped === "string") return unwrapped.slice(0, 4500);
  if (unwrapped && typeof unwrapped === "object") {
    if (toolId === "web.weather" && unwrapped.summary) {
      const lines = [unwrapped.summary];
      if (unwrapped.source) lines.push(`Source: ${unwrapped.source}`);
      return lines.join("\n").slice(0, 4500);
    }
    if (Array.isArray(unwrapped.results) && unwrapped.results.length) {
      const lines = [];
      if (unwrapped.query) lines.push(`Query: ${unwrapped.query}`);
      if (unwrapped.provider) lines.push(`Source: ${unwrapped.provider}`);
      for (const [idx, item] of unwrapped.results.slice(0, 6).entries()) {
        const title = String(item?.title || item?.url || `Result ${idx + 1}`).slice(0, 140);
        const url = String(item?.url || "").slice(0, 320);
        const snippet = String(item?.excerpt || item?.description || "").slice(0, 320);
        lines.push(`${idx + 1}. ${title}${url ? ` (${url})` : ""}${snippet ? `\n   ${snippet}` : ""}`);
      }
      return lines.join("\n").slice(0, 4500);
    }
    if (Array.isArray(unwrapped.sources) && unwrapped.sources.length) {
      const lines = [];
      if (unwrapped.question) lines.push(`Question: ${unwrapped.question}`);
      if (unwrapped.provider) lines.push(`Source: ${unwrapped.provider}`);
      for (const [idx, item] of unwrapped.sources.slice(0, 5).entries()) {
        const title = String(item?.title || item?.url || `Source ${idx + 1}`).slice(0, 140);
        const url = String(item?.url || "").slice(0, 320);
        const snippet = String(item?.excerpt || item?.description || "").slice(0, 420);
        lines.push(`${idx + 1}. ${title}${url ? ` (${url})` : ""}${snippet ? `\n   ${snippet}` : ""}`);
      }
      return lines.join("\n").slice(0, 4500);
    }
    try {
      return JSON.stringify(unwrapped, null, 2).slice(0, 4500);
    } catch {
      return "Tool completed successfully.";
    }
  }
  return `Approved tool ${toolId || "action"} completed.`;
}

function markChatApprovalCardResolved(actionId, { state: nextState = "success", headingText = "", detailText = "", result = undefined } = {}) {
  if (!actionId) return;
  for (const msg of state.messages) {
    if (msg?.actionCard?.actionId === actionId) {
      msg.actionCard = {
        ...msg.actionCard,
        state: nextState,
        ...(detailText ? { detail: detailText } : {})
      };
    }
  }
  const cards = [...document.querySelectorAll(".chat-approval-card")].filter((card) => card.dataset.actionId === actionId);
  for (const card of cards) {
    card.classList.toggle("chat-approval-completed", nextState === "success");
    card.classList.toggle("chat-approval-rejected", nextState === "rejected");
    card.classList.toggle("chat-approval-failed", nextState === "failed");
    const heading = card.querySelector("strong");
    if (heading && headingText) heading.textContent = headingText;
    const detail = card.querySelector("p.chat-approval-detail") || card.querySelector("p");
    if (detail && detailText) detail.textContent = detailText;
    card.querySelector(".chat-approval-actions")?.remove();
    card.querySelectorAll(":scope > button").forEach((btn) => btn.remove());
    if (result !== undefined && !card.querySelector(".chat-approval-result-details")) {
      const details = document.createElement("details");
      details.className = "chat-approval-result-details";
      const summary = document.createElement("summary");
      summary.textContent = "Inspect tool output";
      const output = document.createElement("pre");
      output.className = "chat-approval-result";
      output.textContent = formatApprovedToolResultForContinuation("", result).slice(0, 6000);
      details.append(summary, output);
      card.appendChild(details);
    }
  }
}

function findConversationIdForAction(actionId) {
  if (!actionId) return null;
  if (state.pendingApprovalConversations.has(actionId)) {
    return state.pendingApprovalConversations.get(actionId);
  }
  if (state.messages.some((msg) => msg?.actionCard?.actionId === actionId) && state.activeConversationId) {
    return state.activeConversationId;
  }
  return null;
}

const chatLifecycle = (typeof globalThis.AlfieChatLifecycle?.createChatTurnLifecycle === "function")
  ? globalThis.AlfieChatLifecycle.createChatTurnLifecycle({
      onChange(snapshot) {
        state.sending = snapshot.busy;
        state.chatLifecyclePhase = snapshot.phase;
        syncChatCancelButton(snapshot.busy);
      }
    })
  : null;

let activeChatRequest = null;

function syncChatCancelButton(isSending) {
  const sendBtn = $(".send-button");
  const stopBtn = $("#stop-stream-btn");
  if (sendBtn) sendBtn.hidden = Boolean(isSending);
  if (stopBtn) stopBtn.hidden = !isSending;
}

function beginChatRequest(options = {}) {
  if (chatLifecycle) {
    const turn = chatLifecycle.beginTurn(options);
    activeChatRequest = turn;
    return turn;
  }
  if (activeChatRequest) {
    cancelActiveChatRequest({ silent: true });
  }
  const request = {
    controller: new AbortController(),
    abortedByUser: false,
    silent: false,
    transition() {},
    finish() { return true; }
  };
  activeChatRequest = request;
  state.sending = true;
  syncChatCancelButton(true);
  return request;
}

function cancelActiveChatRequest({ silent = false } = {}) {
  const input = $("#chat-form")?.elements?.message;
  if (chatLifecycle) {
    const cancelled = chatLifecycle.cancelActiveTurn({ silent });
    if (cancelled) {
      activeChatRequest = null;
      if (input) input.disabled = false;
    }
    return cancelled;
  }
  const request = activeChatRequest;
  if (!request) return false;
  request.abortedByUser = true;
  request.silent = Boolean(silent);
  activeChatRequest = null;
  state.sending = false;
  syncChatCancelButton(false);
  if (input) input.disabled = false;
  try {
    request.controller.abort(new Error("Request cancelled by user."));
  } catch {}
  return true;
}

function finishChatRequest(request, { outcome = "completed" } = {}) {
  if (chatLifecycle && typeof request?.finish === "function") {
    const isLatest = request.finish({ outcome });
    if (activeChatRequest === request) {
      activeChatRequest = null;
    }
    return isLatest;
  }
  if (activeChatRequest && activeChatRequest !== request) {
    return false;
  }
  if (activeChatRequest === request) {
    activeChatRequest = null;
  }
  state.sending = false;
  syncChatCancelButton(false);
  return true;
}

async function continueChatAfterApproval({ conversationId, actionId = "", toolId = "", approvalResult = null, summary = "" } = {}) {
  if (!conversationId || !state.linked) return;
  const runContinuation = async () => {
    if (chatLifecycle) {
      await chatLifecycle.waitForActiveTurn();
    }
    setView("chat");
    if (state.activeConversationId !== conversationId) {
      await loadConversation(conversationId);
    }
    if (actionId) {
      markChatApprovalCardResolved(actionId, {
        state: "success",
        headingText: approvalResult?.receipt?.verified ? "Approved and verified" : "Approved and executed",
        detailText: toolId
          ? `Approved ${toolId}. Alfie is continuing the conversation below.`
          : "Approved and executed. Alfie is continuing the conversation below.",
        result: approvalResult?.result
      });
    }

    const form = $("#chat-form");
    const input = form?.elements?.message;
    const chatRequest = beginChatRequest({ kind: "approval_continuation", conversationId, actionId });
    if (input) input.disabled = true;
    const sendStart = Date.now();
    let assistantBody = null;
    let thinking = null;
    let assistantText = "";
    let turnOutcome = "completed";

  try {
    assistantBody = appendMessageElement({ role: "assistant", content: "" });
    thinking = createThinkingIndicator();
    assistantBody.appendChild(thinking.element);
    thinking.setStage(`Continuing with ${toolId || "approved action"}…`);
    window.alfieSoul?.setState("working", "cyan");
    chatAutoScrollEnabled = true;
    scrollChatToBottom({ force: true });

    const outgoingMessages = [];
    if (state.activeConversation?.handoffContext) {
      outgoingMessages.push({
        role: "user",
        content: "[Carried-over context from previous conversation]\n" + state.activeConversation.handoffContext
      });
    }
    const recentSlice = state.messages
      .filter((msg) => !(actionId && msg?.actionCard?.actionId === actionId && msg?.role === "assistant"))
      .slice(outgoingMessages.length ? -13 : -14)
      .map(({ role, content: text, reaction }) => ({
        role,
        content: text,
        ...(reaction ? { reaction } : {})
      }));
    const formattedResult = formatApprovedToolResultForContinuation(toolId, approvalResult?.result);
    const continuationPrompt =
      `[Approved tool result: ${toolId || "action"}]\n` +
      `The user explicitly approved the requested action${summary ? ` (${summary})` : ""}. ` +
      `Continue the conversation and answer the user's preceding request directly using this result, citing sources and URLs where applicable. Do not repeat the same tool call.\n\n` +
      `<untrusted_data source="approved_tool:${toolId || "action"}">\n${formattedResult}\n</untrusted_data>`;
    outgoingMessages.push(...recentSlice, { role: "user", content: continuationPrompt });

    const activeProjectId = getConversationProjectId(state.activeConversation);
    const activeProject = findProjectById(activeProjectId);
    const dashboardState = activeProject?.description
      ? { attachedContext: `Project: ${activeProject.name}\n${activeProject.description}` }
      : {};
    const selectedAgentProvider = $("#agent-provider")?.value || state.selectedAgentProvider || "local";
    const workingMode = $("#working-mode-select")?.value || state.workingMode || "companion";

    const response = await fetch("/api/core/chat/stream", {
      method: "POST",
      credentials: "same-origin",
      signal: chatRequest.controller.signal,
      headers: { "content-type": "application/json", "x-csrf-token": state.csrfToken },
      body: JSON.stringify({
        messages: outgoingMessages,
        mode: $("#model-mode").value,
        workingMode,
        projectId: activeProject?.id || null,
        agentProvider: selectedAgentProvider,
        approvalContinuation: {
          actionId: actionId || "",
          toolId: toolId || "",
          summary: summary || ""
        },
        dashboardState
      })
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      throw new Error(failure.error || "Alfie could not continue the conversation.");
    }
    chatRequest.transition?.("streaming");

    let buffer = "";
    let finalEvent = null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === "tool_start" || event.type === "tool_call") {
          thinking?.setTool(event.toolId, event.toolName, event.action || event.actionText, event.isExternal !== false);
          window.alfieSoul?.setState("working", event.isExternal ? "cyan" : "amber");
        } else if (event.type === "approval_required") {
          thinking?.setTool(event.toolId, event.summary);
          window.alfieSoul?.setState("waiting", "amber");
        } else if (event.type === "heartbeat" && thinking) {
          const secs = Math.max(1, Math.round((Date.now() - sendStart) / 1000));
          thinking.setStage(`Still working (${secs}s)…`);
        } else if (event.type === "delta") {
          if (thinking) {
            thinking.stop();
            thinking.element.remove();
            thinking = null;
          }
          assistantText += event.content || "";
          renderMarkdown(assistantBody, assistantText);
          if (chatAutoScrollEnabled) {
            const host = $("#messages");
            if (host) host.scrollTop = host.scrollHeight;
          }
          updateScrollToBottomIndicator();
        } else if (event.type === "error") {
          throw new Error(event.error || "Alfie could not continue the conversation.");
        } else if (event.type === "done") {
          finalEvent = event;
        }
      }
      if (done) break;
    }
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer);
        if (event.type === "delta") assistantText += event.content || "";
        if (event.type === "done") finalEvent = event;
      } catch {}
    }
    if (thinking) {
      thinking.stop();
      thinking.element.remove();
      thinking = null;
    }
    assistantBody.querySelector(".streaming-cursor")?.remove();
    if (!assistantText && finalEvent?.message) assistantText = finalEvent.message;
    if (finalEvent?.status === "provider_unavailable" || !assistantText) {
      assistantText = `The approved action (${toolId || "tool"}) completed. Here is the result:\n\n${formattedResult}`;
    }
    const finalText = assistantText;
    renderMarkdown(assistantBody, finalText);
    assistantBody.dataset.rawContent = finalText.trim();

    let nextActionCard = null;
    if (finalEvent?.status === "awaiting_user_approval" && finalEvent.actionId) {
      nextActionCard = {
        state: "approval",
        label: "Your approval is needed",
        actionId: finalEvent.actionId,
        toolId: finalEvent.toolId || "",
        summary: finalEvent.summary || "",
        reason: finalEvent.reason || "",
        detail: [finalEvent.toolId, finalEvent.summary].filter(Boolean).join(" · ") || "Alfie has prepared an action for review."
      };
      state.pendingApprovalConversations.set(finalEvent.actionId, conversationId);
      assistantBody.closest(".message")?.appendChild(createChatApprovalCard(nextActionCard, { conversationId }));
    }

    const elapsedMs = Date.now() - sendStart;
    const metrics = {
      latencyMs: Number.isFinite(Number(finalEvent?.metrics?.latencyMs)) ? Number(finalEvent.metrics.latencyMs) : elapsedMs,
      completionTokens: Number.isFinite(Number(finalEvent?.metrics?.completionTokens)) ? Number(finalEvent.metrics.completionTokens) : Math.max(1, Math.round(finalText.length / 4)),
      totalTokens: Number.isFinite(Number(finalEvent?.metrics?.totalTokens)) ? Number(finalEvent.metrics.totalTokens) : Math.max(1, Math.round(finalText.length / 4)),
      model: finalEvent?.model || finalEvent?.metrics?.model || $("#model-mode").value || null
    };
    const provenance = finalEvent?.provenance || null;
    const savedMessage = await persistMessage("assistant", finalText, conversationId, metrics, provenance, null, nextActionCard);
    const messageArticle = assistantBody.closest(".message");
    if (messageArticle) {
      const header = messageArticle.querySelector(".message-header");
      if (header) {
        header.querySelector(".message-meta-badge")?.remove();
        const badge = createMetricsBadge({ role: "assistant", content: finalText, metrics });
        if (badge) header.appendChild(badge);
      }
      messageArticle.querySelector(".message-actions")?.remove();
      messageArticle.appendChild(createReactionControls(savedMessage || { role: "assistant", content: finalText, metrics, provenance }));
      if (provenance) {
        messageArticle.querySelector(".turn-provenance")?.remove();
        const provEl = createProvenanceDisclosure(provenance);
        if (provEl) messageArticle.appendChild(provEl);
      }
    }
    await loadConversations().catch(() => {});
    await refreshVramStatus().catch(() => {});
    window.alfieSoul?.pulse("completed", 2200, "idle", "purple");
    if (finalText) speakAssistantReply?.(finalText);
    if (chatAutoScrollEnabled) scrollChatToBottom();
    updateScrollToBottomIndicator();
  } catch (error) {
    if (thinking) {
      thinking.stop();
      thinking.element.remove();
      thinking = null;
    }
      if (chatRequest.abortedByUser) {
        turnOutcome = "cancelled";
        if (!chatRequest.silent && assistantBody) {
          assistantBody.querySelector(".streaming-cursor")?.remove();
          const stoppedText = assistantText.trim() || "*Stopped.*";
          renderMarkdown(assistantBody, stoppedText);
          assistantBody.dataset.rawContent = stoppedText;
          if (assistantText.trim()) {
            try { await persistMessage("assistant", assistantText.trim(), conversationId); } catch {}
          }
          window.alfieSoul?.setState("idle", "purple");
          toast("Generation stopped.");
        }
        return;
      }
      turnOutcome = "failed";
      const fallbackResult = formatApprovedToolResultForContinuation(toolId, approvalResult?.result);
      const fallbackText = `The approved action (${toolId || "tool"}) finished, though Alfie could not generate a follow-up summary (${error.message}).\n\n${fallbackResult}`;
      if (assistantBody) {
        renderMarkdown(assistantBody, fallbackText);
        assistantBody.dataset.rawContent = fallbackText.trim();
        try { await persistMessage("assistant", fallbackText, conversationId); } catch {}
      }
      window.alfieSoul?.pulse("completed", 1600, "idle", "purple");
      toast("Action ran; showed tool output directly.");
    } finally {
      if (thinking) {
        thinking.stop();
        thinking.element.remove();
        thinking = null;
      }
      if (finishChatRequest(chatRequest, { outcome: turnOutcome }) && input) {
        input.disabled = false;
        if (!chatRequest.silent) input.focus();
      }
    }
  };

  if (chatLifecycle) {
    return chatLifecycle.enqueueContinuation(runContinuation);
  }
  return runContinuation();
}

async function approvePendingActionAndContinue(actionId, { toolId = "", summary = "", conversationId = null, cardElement = null } = {}) {
  if (!actionId) return;
  const approvalHandle = chatLifecycle ? chatLifecycle.beginApproval(actionId) : { accepted: true, signal: undefined, finish() {} };
  if (!approvalHandle.accepted) return;

  const buttons = cardElement ? [...cardElement.querySelectorAll("button")] : [];
  buttons.forEach((btn) => { btn.disabled = true; });
  let approvedResult = null;
  let resolvedToolId = toolId;
  let targetConversationId = null;
  try {
    window.alfieSoul?.setState("working", "cyan");
    const res = await api("/api/core/tools/approve", {
      method: "POST",
      signal: approvalHandle.signal,
      body: JSON.stringify({ actionId })
    });
    approvedResult = res;
    resolvedToolId = res.toolId || toolId;
    targetConversationId =
      conversationId ||
      res.conversationId ||
      findConversationIdForAction(actionId) ||
      (state.view === "chat" ? state.activeConversationId : null);
    state.pendingApprovalConversations.delete(actionId);
    markChatApprovalCardResolved(actionId, {
      state: "success",
      headingText: res.receipt?.verified ? "Approved and verified" : "Approved and executed",
      detailText: resolvedToolId
        ? `Approved ${resolvedToolId}. Alfie is continuing the conversation below.`
        : "Approved and executed. Alfie is continuing the conversation below.",
      result: res.result
    });
    toast(targetConversationId ? "Action approved — Alfie is continuing your chat." : (res.receipt?.verified ? "Action approved & verified." : "Action approved and executed."));
    loadToolsAndApprovals().catch(() => {});
  } catch (error) {
    if (error.actionConsumed) {
      state.pendingApprovalConversations.delete(actionId);
      markChatApprovalCardResolved(actionId, {
        state: "failed",
        headingText: error.actionOutcomeUnknown ? "Action outcome uncertain — check destination" : "Approval could not be completed",
        detailText: error.actionOutcomeUnknown
          ? "The approval was consumed, but the external action may have partially completed. Check the destination before retrying; do not approve a duplicate yet."
          : "This approval has been consumed to prevent duplicate execution. Check the destination before asking Alfie to propose the action again."
      });
      buttons.forEach((btn) => { btn.disabled = true; });
      window.alfieSoul?.setState("error", "red");
      toast(error.actionOutcomeUnknown
        ? "Action outcome uncertain. Check the destination before retrying."
        : (error.message || "The approved action failed. Check its destination before retrying."));
    } else {
      buttons.forEach((btn) => { btn.disabled = false; });
      window.alfieSoul?.setState("error", "red");
      toast(error.message);
    }
    return;
  } finally {
    approvalHandle.finish();
  }

  if (targetConversationId) {
    await continueChatAfterApproval({
      conversationId: targetConversationId,
      actionId,
      toolId: resolvedToolId,
      approvalResult: approvedResult,
      summary
    });
  } else {
    window.alfieSoul?.pulse("completed", 2000, "idle", "purple");
  }
}

async function rejectPendingAction(actionId, { cardElement = null } = {}) {
  if (!actionId) return;
  const buttons = cardElement ? [...cardElement.querySelectorAll("button")] : [];
  buttons.forEach((btn) => { btn.disabled = true; });
  try {
    await api("/api/core/tools/reject", {
      method: "POST",
      body: JSON.stringify({ actionId })
    });
    state.pendingApprovalConversations.delete(actionId);
    markChatApprovalCardResolved(actionId, {
      state: "rejected",
      headingText: "Action rejected",
      detailText: "You rejected this action. No external change or lookup was executed."
    });
    toast("Action rejected.");
    await loadToolsAndApprovals().catch(() => {});
  } catch (error) {
    buttons.forEach((btn) => { btn.disabled = false; });
    toast(error.message);
  }
}

function createChatApprovalCard(card, { conversationId = state.activeConversationId } = {}) {
  const approval = document.createElement("section");
  approval.className = "chat-approval-card";
  if (card.actionId) approval.dataset.actionId = card.actionId;
  if (card.state === "success") approval.classList.add("chat-approval-completed");
  if (card.state === "rejected") approval.classList.add("chat-approval-rejected");

  const heading = document.createElement("strong");
  if (card.state === "success") heading.textContent = "Approved and executed";
  else if (card.state === "rejected") heading.textContent = "Action rejected";
  else heading.textContent = card.label || "Your approval is needed";

  const detail = document.createElement("p");
  detail.className = "chat-approval-detail";
  detail.textContent = card.detail || [card.toolId, card.summary].filter(Boolean).join(" · ") || "Alfie has prepared an action for review.";
  approval.append(heading, detail);

  if (card.reason && card.state === "approval") {
    const reason = document.createElement("p");
    reason.className = "chat-approval-reason";
    reason.textContent = card.reason;
    approval.appendChild(reason);
  }

  if (card.state === "approval" && card.actionId) {
    const actions = document.createElement("div");
    actions.className = "chat-approval-actions";

    const approveBtn = document.createElement("button");
    approveBtn.type = "button";
    approveBtn.className = "primary-button";
    approveBtn.textContent = "Approve & continue";
    approveBtn.addEventListener("click", () => {
      approvePendingActionAndContinue(card.actionId, {
        toolId: card.toolId || "",
        summary: card.summary || "",
        conversationId,
        cardElement: approval
      });
    });

    const rejectBtn = document.createElement("button");
    rejectBtn.type = "button";
    rejectBtn.className = "secondary-button";
    rejectBtn.textContent = "Reject";
    rejectBtn.addEventListener("click", () => {
      rejectPendingAction(card.actionId, { cardElement: approval });
    });

    const reviewBtn = document.createElement("button");
    reviewBtn.type = "button";
    reviewBtn.className = "secondary-button";
    reviewBtn.textContent = "Review in Tools & access";
    reviewBtn.addEventListener("click", () => {
      setView("tools");
      loadToolsAndApprovals(card.actionId).catch((error) => toast(error.message));
    });

    actions.append(approveBtn, rejectBtn, reviewBtn);
    approval.appendChild(actions);
  }
  return approval;
}

function appendMessageElement(message) {
  const article = document.createElement("article");
  article.className = "message " + (message.role === "user" ? "user" : "assistant");

  const header = document.createElement("div");
  header.className = "message-header";

  const label = document.createElement("span");
  label.className = "message-label";
  label.textContent = message.role === "user" ? "YOU" : "ALFIE";
  header.appendChild(label);

  if (message.role === "assistant" && (message.metrics || message.content)) {
    const badge = createMetricsBadge(message);
    if (badge) header.appendChild(badge);
  }

  const body = document.createElement("div");
  body.className = "message-body";
  renderMarkdown(body, message.content || "");
  if (message.role === "assistant" && message.content) {
    body.dataset.rawContent = String(message.content).trim();
  }
  article.append(header, body);

  if (message.role === "assistant") {
    const actions = createReactionControls(message);
    article.appendChild(actions);
    if (message.actionCard) {
      article.insertBefore(createChatApprovalCard(message.actionCard, { conversationId: state.activeConversationId }), actions);
    }
    if (message.provenance?.autoMemories?.length) {
      const autoMemEl = createAutoMemoryDisclosure(message.provenance.autoMemories);
      if (autoMemEl) article.appendChild(autoMemEl);
    }
    if (message.provenance) {
      const provEl = createProvenanceDisclosure(message.provenance);
      if (provEl) article.appendChild(provEl);
    }
  }

  $("#messages").appendChild(article);
  return body;
}

/* Chat Auto-Scroll Manager with MutationObserver & User Scroll-Lock Protection */
const SCROLL_BOTTOM_THRESHOLD = 96;
let chatAutoScrollEnabled = true;
let chatScrollRafId = null;
let chatProgrammaticScroll = false;
let chatProgrammaticScrollTimer = null;
let chatMessagesObserver = null;
let chatMessagesResizeObserver = null;

function clearProgrammaticScrollGuard() {
  chatProgrammaticScroll = false;
  if (chatProgrammaticScrollTimer !== null) {
    clearTimeout(chatProgrammaticScrollTimer);
    chatProgrammaticScrollTimer = null;
  }
}

function isMessagesNearBottom(element = $("#messages"), threshold = SCROLL_BOTTOM_THRESHOLD) {
  if (!element) return true;
  const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
  return distanceFromBottom <= threshold;
}

function updateScrollToBottomIndicator() {
  const scrollBtn = $("#scroll-to-bottom");
  const host = $("#messages");
  if (!scrollBtn || !host) return;
  const hasMessages = (state.messages && state.messages.length > 0) || Boolean(host.querySelector(".message"));
  const isUp = !isMessagesNearBottom(host);
  scrollBtn.hidden = !hasMessages || !isUp;
}

function scrollChatToBottom({ force = false, smooth = false } = {}) {
  const host = $("#messages");
  if (!host) return;
  if (force || chatAutoScrollEnabled) {
    clearProgrammaticScrollGuard();
    chatProgrammaticScroll = true;
    chatAutoScrollEnabled = true;
    if (smooth) {
      host.scrollTo({ top: host.scrollHeight, behavior: "smooth" });
      chatProgrammaticScrollTimer = setTimeout(() => {
        clearProgrammaticScrollGuard();
        updateScrollToBottomIndicator();
      }, 650);
    } else {
      host.scrollTop = host.scrollHeight;
      updateScrollToBottomIndicator();
      requestAnimationFrame(() => {
        clearProgrammaticScrollGuard();
      });
    }
  }
}

function scheduleObservedAutoScroll() {
  if (chatScrollRafId !== null) return;
  chatScrollRafId = requestAnimationFrame(() => {
    chatScrollRafId = null;
    if (chatAutoScrollEnabled) {
      scrollChatToBottom();
    } else {
      updateScrollToBottomIndicator();
    }
  });
}

function isIgnoredScrollMutationTarget(node) {
  const el = node?.nodeType === 1 ? node : node?.parentElement;
  if (!el || typeof el.closest !== "function") return false;
  return Boolean(
    el.closest(".message-actions, .turn-provenance, .auto-memory-disclosure, .copy-code-btn, .handoff-context-card")
  );
}

function isStreamedMessageMutation(mutation) {
  if (!mutation || isIgnoredScrollMutationTarget(mutation.target)) return false;
  if (mutation.type === "characterData") {
    const el = mutation.target?.parentElement;
    return Boolean(el?.closest?.(".message.assistant, .message-body, .thinking-indicator"));
  }
  if (mutation.type === "childList" && mutation.addedNodes && mutation.addedNodes.length > 0) {
    const targetEl = mutation.target?.nodeType === 1 ? mutation.target : null;
    if (targetEl?.id === "messages") {
      return [...mutation.addedNodes].some((n) => n.nodeType === 1 && n.classList?.contains("message"));
    }
    return Boolean(targetEl?.closest?.(".message.assistant, .message-body, .thinking-indicator"));
  }
  return false;
}

function attachChatMessagesObserver(host = $("#messages")) {
  if (!host) return null;
  if (chatMessagesObserver) {
    chatMessagesObserver.disconnect();
    chatMessagesObserver = null;
  }
  if (chatMessagesResizeObserver) {
    chatMessagesResizeObserver.disconnect();
    chatMessagesResizeObserver = null;
  }
  if (typeof MutationObserver === "function") {
    chatMessagesObserver = new MutationObserver((mutations) => {
      if (mutations.some(isStreamedMessageMutation)) {
        scheduleObservedAutoScroll();
      }
    });
    chatMessagesObserver.observe(host, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }
  if (typeof ResizeObserver === "function") {
    chatMessagesResizeObserver = new ResizeObserver(() => {
      if (chatAutoScrollEnabled) {
        scheduleObservedAutoScroll();
      } else {
        updateScrollToBottomIndicator();
      }
    });
    chatMessagesResizeObserver.observe(host);
  }
  return chatMessagesObserver;
}

window.chatScroller = {
  scrollToBottom: scrollChatToBottom,
  isNearBottom: isMessagesNearBottom,
  getAutoScroll: () => chatAutoScrollEnabled,
  setAutoScroll: (val) => {
    chatAutoScrollEnabled = Boolean(val);
    updateScrollToBottomIndicator();
  },
  isObserving: () => Boolean(chatMessagesObserver),
  reconnectObserver: () => attachChatMessagesObserver($("#messages")),
  disconnectObserver: () => {
    if (chatMessagesObserver) {
      chatMessagesObserver.disconnect();
      chatMessagesObserver = null;
    }
    if (chatMessagesResizeObserver) {
      chatMessagesResizeObserver.disconnect();
      chatMessagesResizeObserver = null;
    }
  }
};

const messagesHost = $("#messages");
if (messagesHost) {
  messagesHost.addEventListener("scroll", () => {
    if (chatProgrammaticScroll) {
      if (isMessagesNearBottom(messagesHost)) {
        clearProgrammaticScrollGuard();
        updateScrollToBottomIndicator();
      }
      return;
    }
    if (isMessagesNearBottom(messagesHost)) {
      chatAutoScrollEnabled = true;
    } else {
      chatAutoScrollEnabled = false;
    }
    updateScrollToBottomIndicator();
  }, { passive: true });
  messagesHost.addEventListener("scrollend", () => {
    clearProgrammaticScrollGuard();
    updateScrollToBottomIndicator();
  }, { passive: true });
  ["wheel", "touchstart"].forEach((evtName) => {
    messagesHost.addEventListener(evtName, () => {
      clearProgrammaticScrollGuard();
    }, { passive: true });
  });
  messagesHost.addEventListener("load", (event) => {
    if (event.target?.tagName === "IMG") {
      scheduleObservedAutoScroll();
    }
  }, true);
  attachChatMessagesObserver(messagesHost);
}

$("#scroll-to-bottom")?.addEventListener("click", () => {
  chatAutoScrollEnabled = true;
  scrollChatToBottom({ force: true, smooth: true });
});

function createHandoffContextCard(conversation) {
  if (!conversation?.handoffContext) return null;
  const details = document.createElement("details");
  details.className = "handoff-context-card";
  details.id = "handoff-context-card";
  if (!state.messages.length) details.open = true;

  const summary = document.createElement("summary");
  summary.className = "handoff-context-summary";
  const label = document.createElement("span");
  label.textContent = conversation.continuedFromTitle
    ? `Continued from "${conversation.continuedFromTitle}"`
    : "Continued with carried-over context";
  const meta = document.createElement("span");
  meta.className = "handoff-context-summary-meta";
  const proj = findProjectById(conversation.projectId);
  meta.textContent = proj ? `${proj.name} · Carried context` : "Carried context";
  summary.append(label, meta);

  const body = document.createElement("div");
  body.className = "handoff-context-body";
  renderMarkdown(body, conversation.handoffContext);

  if (conversation.parentConversationId && state.conversations.some((c) => c.id === conversation.parentConversationId)) {
    const footer = document.createElement("div");
    footer.className = "handoff-context-footer";
    const openParent = document.createElement("button");
    openParent.type = "button";
    openParent.className = "secondary-button";
    openParent.textContent = "Open previous chat";
    openParent.addEventListener("click", () => {
      loadConversation(conversation.parentConversationId).catch((error) => toast(error.message));
    });
    footer.appendChild(openParent);
    body.appendChild(footer);
  }

  details.append(summary, body);
  return details;
}

function renderMessages() {
  const host = $("#messages");
  host.replaceChildren();
  const handoffCard = createHandoffContextCard(state.activeConversation);
  if (handoffCard) {
    host.appendChild(handoffCard);
  }
  if (!state.messages.length) {
    if (handoffCard) {
      updateScrollToBottomIndicator();
      syncChatContextBar();
      return;
    }
    const welcome = document.createElement("div");
    welcome.className = "welcome-message";
    const currentMood = window.alfieSoul?.getMood() || "purple";
    const currentState = window.alfieSoul?.getAnimationState() || "idle";
    welcome.innerHTML = '<div class="welcome-soul-container">' +
      '<div class="alfie-soul large" data-soul data-mood="' + currentMood + '" data-animation-state="' + currentState + '" role="button" tabindex="0" title="Alfie\'s Soul — click to cycle mood">' +
        '<div class="soul-aura"></div>' +
        '<div class="soul-matrix"></div>' +
        '<div class="soul-rings"></div>' +
        '<div class="soul-core">' + createPoeSpriteHtml("large") + '</div>' +
        '<div class="soul-spark"></div>' +
      '</div>' +
      '<div class="soul-mood-tags" aria-label="Alfie Soul Mood">' +
        '<button type="button" class="mood-chip ' + (currentMood === 'purple' ? 'active' : '') + '" data-set-mood="purple" title="Purple: Work / Focus">◈ Work</button>' +
        '<button type="button" class="mood-chip ' + (currentMood === 'blue' ? 'active' : '') + '" data-set-mood="blue" title="Blue: Good / Online">◈ Good</button>' +
        '<button type="button" class="mood-chip ' + (currentMood === 'red' ? 'active' : '') + '" data-set-mood="red" title="Red: Bad / Alert">◈ Alert</button>' +
        '<button type="button" class="mood-chip ' + (currentMood === 'amber' ? 'active' : '') + '" data-set-mood="amber" title="Amber: Thinking">◈ Thinking</button>' +
      '</div>' +
    '</div>' +
    '<p class="eyebrow welcome-eyebrow">A LITTLE SPACE OF YOUR OWN</p>' +
    '<h2>What shall we work on?</h2>' +
    '<p>I’m here when you need me. No rush, no noise.</p>' +
    '<div class="suggestion-grid">' +
      '<button type="button" data-prompt="Give me a concise overview of my current priorities.">A quick overview <span>↗</span></button>' +
      '<button type="button" data-prompt="Help me think through an idea I’m developing.">Think through an idea <span>↗</span></button>' +
      '<button type="button" data-prompt="/image A pixel art purple garden with glowing amethyst crystals">Generate visual asset <span>🎨</span></button>' +
      '<button type="button" data-prompt="Summarise the recent activity and pending actions available to you.">Review recent activity <span>↗</span></button>' +
    '</div>';
    host.appendChild(welcome);
    welcome.querySelectorAll("[data-prompt]").forEach((button) => button.addEventListener("click", () => sendMessage(button.dataset.prompt)));
    updateScrollToBottomIndicator();
    syncChatContextBar();
    return;
  }
  for (const message of state.messages) appendMessageElement(message);
  syncChatContextBar();
  scrollChatToBottom({ force: true });
}

async function persistMessage(role, content, conversationId = state.activeConversationId, metrics = null, provenance = null, taskId = null, actionCard = null) {
  const payload = await api("/api/core/conversations/" + encodeURIComponent(conversationId) + "/messages", {
    method: "POST",
    body: JSON.stringify({
      role,
      content,
      ...(metrics ? { metrics } : {}),
      ...(provenance ? { provenance } : {}),
      ...(taskId ? { taskId } : {}),
      ...(actionCard ? { actionCard } : {})
    })
  });
  if (conversationId === state.activeConversationId) {
    state.messages.push(payload.message || {
      role,
      content,
      ...(metrics ? { metrics } : {}),
      ...(provenance ? { provenance } : {}),
      ...(taskId ? { taskId } : {}),
      ...(actionCard ? { actionCard } : {})
    });
    syncChatContextBar();
  }
  return payload.message;
}

async function restoreBackgroundTaskNotice(conversationId) {
  try {
    const response = await api("/api/core/jobs?limit=100");
    const jobs = (response.jobs || []).filter((job) => job.kind === "chat_turn" && job.conversationId === conversationId).slice(0, 3);
    for (const job of jobs) {
      if (job.status === "completed") continue;
      const hasAssistantResult = state.messages.some((message) => message.taskId === job.id && message.role === "assistant");
      if (hasAssistantResult && job.status !== "awaiting_approval") continue;
      let notice = "Alfie is still working on this background task.";
      if (job.status === "queued") notice = "Your background task is queued and will start shortly.";
      else if (job.status === "awaiting_approval") notice = "This background task is waiting for your approval.";
      else if (job.status === "interrupted") notice = "This task was interrupted when Alfie Core restarted. It was not automatically repeated; send the request again if you want to retry.";
      else if (job.status === "failed") notice = "This background task failed: " + (job.error || "No error details were recorded.");
      else if (job.status === "cancelled") notice = "This background task was cancelled.";
      const body = appendMessageElement({ role: "assistant", content: notice });
      if (job.status === "queued" || job.status === "running" || job.status === "awaiting_approval") {
        watchBackgroundChatTask(job.id, conversationId, body, null);
      }
    }
  } catch {}
}

const activeBackgroundTaskPolls = new Set();

async function watchBackgroundChatTask(jobId, conversationId, assistantBody, indicator) {
  if (activeBackgroundTaskPolls.has(jobId)) return;
  activeBackgroundTaskPolls.add(jobId);
  const finishIndicator = () => {
    if (indicator) { indicator.stop(); indicator.element.remove(); }
    activeBackgroundTaskPolls.delete(jobId);
  };
  const poll = async () => {
    try {
      const response = await api("/api/core/jobs/" + encodeURIComponent(jobId));
      const job = response.job;
      if (job.status === "queued" || job.status === "running") {
        const checkpoint = job.checkpoints?.[job.checkpoints.length - 1]?.summary;
        indicator?.setStage(checkpoint || (job.status === "queued" ? "Waiting for Alfie…" : "Still working in the background…"));
        setTimeout(poll, 2500);
        return;
      }
      if (job.status === "completed" && state.activeConversationId === conversationId && state.sending) {
        setTimeout(poll, 1000);
        return;
      }
      finishIndicator();
      if (job.status === "awaiting_approval") {
        if (assistantBody?.isConnected) {
          assistantBody.textContent = job.artifact?.summary || "This task is waiting for your approval. Open Tools & access to review the action.";
          const card = document.createElement("section");
          card.className = "chat-approval-card";
          const heading = document.createElement("strong");
          heading.textContent = "Your approval is needed";
          const review = document.createElement("button");
          review.type = "button";
          review.className = "secondary-button";
          review.textContent = "Review in Tools & access";
          review.addEventListener("click", () => { setView("tools"); loadToolsAndApprovals().catch((error) => toast(error.message)); });
          card.append(heading, review);
          assistantBody.closest(".message")?.appendChild(card);
        }
        toast("Background task is waiting for your approval.");
        await loadToolsAndApprovals();
        return;
      }
      if (job.status === "completed") {
        if (state.activeConversationId === conversationId && state.sending) {
          setTimeout(poll, 1000);
          return;
        }
        if (state.activeConversationId === conversationId) await loadConversation(conversationId);
        toast("Alfie finished the background task.");
        window.alfieSoul?.pulse("completed", 1800, "idle", "purple");
        return;
      }
      const failure = job.error || `Background task ${job.status}.`;
      if (assistantBody?.isConnected) {
        renderMarkdown(assistantBody, "I could not complete that background task. " + failure);
        assistantBody.dataset.rawContent = assistantBody.textContent || failure;
      }
      toast(failure);
    } catch (error) {
      indicator?.setStage("Reconnecting to background task…");
      setTimeout(poll, 5000);
    }
  };
  setTimeout(poll, 1200);
}

async function sendMessage(rawText) {
  const content = String(rawText || "").trim();
  if (!content || state.sending || !state.linked) return;
  if (state.conversationLoading) { toast("Wait for the selected conversation to finish loading."); return; }

  // Frictionless Ideas Vault capture directly from chat without derailing the active conversation
  if (/^\/idea(?:\s|$)/i.test(content)) {
    const ideaText = content.replace(/^\/idea\s*/i, "").trim();
    const form = $("#chat-form");
    const input = form?.elements?.message;
    if (!ideaText) {
      toast("Type /idea followed by your thought to park it in the Ideas Vault.");
      if (input) {
        input.value = "/idea ";
        input.focus();
      }
      return;
    }
    const activeProjectId = getConversationProjectId(state.activeConversation) || (state.selectedProjectId !== "all" && state.selectedProjectId !== "unassigned" ? state.selectedProjectId : null);
    const liveConv = (state.conversations || []).find((c) => c.id === state.activeConversation?.id) || state.activeConversation;
    const sourceContext = liveConv?.title && liveConv.title !== "New conversation"
      ? `Chat "${liveConv.title}"`
      : "Quick chat command";
    try {
      const splitMatch = /\s(?:—|--)\s/.exec(ideaText);
      const title = (splitMatch && splitMatch.index > 0 ? ideaText.slice(0, splitMatch.index) : ideaText).trim().slice(0, 160);
      const body = splitMatch && splitMatch.index > 0 ? ideaText.slice(splitMatch.index + splitMatch[0].length).trim() : "";
      const created = await api("/api/core/ideas", {
        method: "POST",
        body: JSON.stringify({ title, body, projectId: activeProjectId, sourceContext, status: "inbox", priority: "medium" })
      });
      if (input) {
        input.value = "";
        input.style.height = "";
      }
      const tags = Array.isArray(created?.idea?.tags) ? created.idea.tags : [];
      const tagSuffix = tags.length ? ` (${tags.slice(0, 3).map((t) => "#" + t).join(" ")})` : "";
      toast(`Squirrelled "${title.slice(0, 48)}${title.length > 48 ? "…" : ""}"${tagSuffix} into Ideas Vault.`);
      window.alfieSoul?.pulse("completed", 1500, "idle", "purple");
    } catch (error) {
      toast(error.message || "Could not save idea.");
    }
    return;
  }

  const chatRequest = beginChatRequest({
    kind: content.startsWith("/image") ? "image" : "chat",
    conversationId: state.activeConversationId
  });
  const form = $("#chat-form");
  const input = form.elements.message;
  input.disabled = true;
  let assistantBody = null;
  let thinking = null;
  let assistantText = "";
  let turnOutcome = "completed";
  let activeConversationIdForTurn = state.activeConversationId;
  const sendStart = Date.now();
  window.alfieSoul?.setState("thinking", "amber");
  try {
    if (content.startsWith("/image")) {
      const promptText = content.replace(/^\/image\s*/i, "").trim();
      if (!promptText) {
        toast("Please describe the visual asset to generate, e.g. /image A glowing amethyst crystal garden");
        finishChatRequest(chatRequest);
        input.disabled = false;
        input.value = "/image ";
        input.focus();
        return;
      }
      if (!state.activeConversationId) await newConversation({ fromSend: true });
      const conversationId = state.activeConversationId;
      await persistMessage("user", content, conversationId);
      renderMessages();
      assistantBody = appendMessageElement({ role: "assistant", content: "" });
      thinking = createThinkingIndicator();
      thinking.setTool("generate_image", "Generate visual asset", "Generating visual asset: " + promptText.slice(0, 36) + "…", false);
      assistantBody.appendChild(thinking.element);
      chatAutoScrollEnabled = true;
      scrollChatToBottom({ force: true });
      window.alfieSoul?.setState("working", "cyan");

      const imgPayload = await api("/api/core/images/generate", {
        method: "POST",
        body: JSON.stringify({ prompt: promptText, style: "pixel-art" })
      });

      thinking.stop();
      thinking.element.remove();
      thinking = null;

      const assistantText = `Here is the visual asset you requested for **"${promptText}"**:\n\n![${imgPayload.image.prompt}](${imgPayload.image.url})\n\n*Created with Alfie Pixel Studio (${imgPayload.image.provider}) · 512×512 pixel-art.*`;
      renderMarkdown(assistantBody, assistantText);
      assistantBody.dataset.rawContent = assistantText.trim();

      const elapsedMs = Date.now() - sendStart;
      const metrics = { latencyMs: elapsedMs, completionTokens: 60, totalTokens: 80, model: "alfie-pixel-studio" };
      const messageArticle = assistantBody.closest(".message");
      const header = messageArticle?.querySelector(".message-header");
      if (header) {
        header.querySelector(".message-meta-badge")?.remove();
        const badge = createMetricsBadge({ role: "assistant", content: assistantText, metrics });
        if (badge) header.appendChild(badge);
      }
      const savedMessage = await persistMessage("assistant", assistantText, conversationId, metrics);
      if (messageArticle) {
        messageArticle.querySelector(".message-actions")?.remove();
        messageArticle.appendChild(createReactionControls(savedMessage || { role: "assistant", content: assistantText, metrics }));
      }
      await loadConversations();
      window.alfieSoul?.pulse("completed", 2200, "idle", "purple");
      if (chatAutoScrollEnabled) scrollChatToBottom();
      updateScrollToBottomIndicator();
      return;
    }

    if (!state.activeConversationId) await newConversation({ fromSend: true });
    const conversationId = state.activeConversationId;
    activeConversationIdForTurn = conversationId;
    if ($("#background-task-toggle")?.checked) {
      const turnId = crypto.randomUUID();
      const outgoingMessages = [];
      if (state.activeConversation?.handoffContext) {
        outgoingMessages.push({ role: "user", content: "[Carried-over context from previous conversation]\n" + state.activeConversation.handoffContext });
      }
      const recentSlice = state.messages.slice(outgoingMessages.length ? -14 : -15).map(({ role, content: text, reaction }) => ({ role, content: text, ...(reaction ? { reaction } : {}) }));
      outgoingMessages.push(...recentSlice, { role: "user", content });
      const activeProjectId = getConversationProjectId(state.activeConversation);
      const activeProject = findProjectById(activeProjectId);
      const dashboardState = activeProject?.description ? { attachedContext: `Project: ${activeProject.name}\n${activeProject.description}` } : {};
      const selectedAgentProvider = $("#agent-provider")?.value || state.selectedAgentProvider || "local";
      const workingMode = $("#working-mode-select")?.value || state.workingMode || "companion";
      await persistMessage("user", content, conversationId, null, null, turnId);
      loadConversations().catch(() => {});
      renderMessages();
      assistantBody = appendMessageElement({ role: "assistant", content: "" });
      thinking = createThinkingIndicator();
      assistantBody.appendChild(thinking.element);
      thinking.setStage("Submitting background task…");
      chatAutoScrollEnabled = true;
      scrollChatToBottom({ force: true });
      const submitted = await api("/api/core/chat/tasks", {
        method: "POST",
        body: JSON.stringify({
          conversationId, turnId, messages: outgoingMessages,
          mode: $("#model-mode").value, workingMode,
          projectId: activeProject?.id || null,
          agentProvider: selectedAgentProvider, dashboardState
        })
      });
      const backgroundToggle = $("#background-task-toggle");
      if (backgroundToggle) backgroundToggle.checked = false;
      const backgroundIndicator = thinking;
      thinking = null;
      backgroundIndicator?.setStage("Alfie is working in the background…");
      window.alfieSoul?.setState("working", "amber");
      toast("Task started. Alfie will keep working if you leave this chat.");
      watchBackgroundChatTask(submitted.job.id, conversationId, assistantBody, backgroundIndicator);
      return;
    }
    await persistMessage("user", content, conversationId);
    loadConversations().catch(() => {});
    renderMessages();
    assistantBody = appendMessageElement({ role: "assistant", content: "" });
    thinking = createThinkingIndicator();
    assistantBody.appendChild(thinking.element);
    chatAutoScrollEnabled = true;
    scrollChatToBottom({ force: true });
    const outgoingMessages = [];
    if (state.activeConversation?.handoffContext) {
      outgoingMessages.push({
        role: "user",
        content: "[Carried-over context from previous conversation]\n" + state.activeConversation.handoffContext
      });
    }
    const recentSlice = state.messages.slice(outgoingMessages.length ? -15 : -16).map(({ role, content: text, reaction }) => ({
      role,
      content: text,
      ...(reaction ? { reaction } : {})
    }));
    outgoingMessages.push(...recentSlice);
    const activeProjectId = getConversationProjectId(state.activeConversation);
    const activeProject = findProjectById(activeProjectId);
    const dashboardState = activeProject?.description
      ? { attachedContext: `Project: ${activeProject.name}\n${activeProject.description}` }
      : {};
    const selectedAgentProvider = $("#agent-provider")?.value || state.selectedAgentProvider || "local";
    const workingMode = $("#working-mode-select")?.value || state.workingMode || "companion";
    const response = await fetch("/api/core/chat/stream", {
      method: "POST",
      credentials: "same-origin",
      signal: chatRequest.controller.signal,
      headers: { "content-type": "application/json", "x-csrf-token": state.csrfToken },
      body: JSON.stringify({
        messages: outgoingMessages,
        mode: $("#model-mode").value,
        workingMode,
        projectId: activeProject?.id || null,
        agentProvider: selectedAgentProvider,
        dashboardState
      })
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      throw new Error(failure.error || "Alfie could not complete the response.");
    }
    chatRequest.transition?.("streaming");
    let buffer = "";
    let finalEvent = null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === "tool_start" || event.type === "tool_call") {
          thinking?.setTool(event.toolId, event.toolName, event.action || event.actionText, event.isExternal !== false);
          window.alfieSoul?.setState("working", event.isExternal ? "cyan" : "amber");
          if (chatAutoScrollEnabled) {
            const host = $("#messages");
            if (host) host.scrollTop = host.scrollHeight;
          }
        }
        if (event.type === "approval_required") {
          thinking?.setTool(event.toolId, event.summary);
          window.alfieSoul?.setState("waiting", "amber");
          if (chatAutoScrollEnabled) {
            const host = $("#messages");
            if (host) host.scrollTop = host.scrollHeight;
          }
        }
        if (event.type === "heartbeat" && thinking) {
          const secs = Math.max(1, Math.round((Date.now() - sendStart) / 1000));
          thinking.setStage(`Still working (${secs}s)…`);
        }
        if (event.type === "meta" && event.steps > 1 && !event.toolId) {
          thinking?.setStage("processing step " + event.steps + "…");
          window.alfieSoul?.setState("working", "amber");
          if (chatAutoScrollEnabled) {
            const host = $("#messages");
            if (host) host.scrollTop = host.scrollHeight;
          }
        }
        if (event.type === "delta") {
          if (thinking) {
            thinking.stop();
            thinking.element.remove();
            thinking = null;
          }
          if (window.alfieSoul?.getAnimationState() !== "working") {
            window.alfieSoul?.setState("working", "purple");
          }
          assistantText += event.content || "";
          renderMarkdown(assistantBody, assistantText);
          const cursor = document.createElement("span");
          cursor.className = "streaming-cursor";
          cursor.setAttribute("aria-hidden", "true");
          assistantBody.appendChild(cursor);
          if (chatAutoScrollEnabled) {
            const host = $("#messages");
            if (host) host.scrollTop = host.scrollHeight;
          }
          updateScrollToBottomIndicator();
        }
        if (event.type === "error") throw new Error(event.error || "Alfie could not complete the response.");
        if (event.type === "done") finalEvent = event;
      }
      if (done) break;
    }
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer);
        if (event.type === "tool_start" || event.type === "tool_call") {
          thinking?.setTool(event.toolId, event.toolName, event.action || event.actionText, event.isExternal !== false);
          window.alfieSoul?.setState("working", event.isExternal ? "cyan" : "amber");
        }
        if (event.type === "approval_required") {
          thinking?.setTool(event.toolId, event.summary);
          window.alfieSoul?.setState("waiting", "amber");
        }
        if (event.type === "meta" && event.steps > 1 && !event.toolId) {
          thinking?.setStage("processing step " + event.steps + "…");
          window.alfieSoul?.setState("working", "amber");
        }
        if (event.type === "delta") {
          if (thinking) {
            thinking.stop();
            thinking.element.remove();
            thinking = null;
          }
          assistantText += event.content || "";
          renderMarkdown(assistantBody, assistantText);
          updateScrollToBottomIndicator();
        }
        if (event.type === "error") throw new Error(event.error || "Alfie could not complete the response.");
        if (event.type === "done") finalEvent = event;
      } catch (parseErr) {
        if (parseErr instanceof Error && !/JSON/i.test(parseErr.message)) throw parseErr;
      }
    }
    if (thinking) {
      thinking.stop();
      thinking.element.remove();
      thinking = null;
    }
    assistantBody.querySelector(".streaming-cursor")?.remove();
    if (!assistantText && finalEvent?.message) assistantText = finalEvent.message;
    if (finalEvent?.status === "awaiting_user_approval") {
      assistantText = assistantText || "This action is ready for your approval. Open Tools & access to review it.";
    }
    const finalText = assistantText || "I couldn't produce a response.";
    renderMarkdown(assistantBody, finalText);
    assistantBody.dataset.rawContent = finalText.trim();
    let approvalActionCard = null;
    if (finalEvent?.status === "awaiting_user_approval" && finalEvent.actionId) {
      approvalActionCard = {
        state: "approval",
        label: "Your approval is needed",
        actionId: finalEvent.actionId,
        toolId: finalEvent.toolId || "",
        summary: finalEvent.summary || "",
        reason: finalEvent.reason || "",
        detail: [finalEvent.toolId, finalEvent.summary].filter(Boolean).join(" · ") || "Alfie has prepared an action for review."
      };
      state.pendingApprovalConversations.set(finalEvent.actionId, conversationId);
      const approval = createChatApprovalCard(approvalActionCard, { conversationId });
      assistantBody.closest(".message")?.appendChild(approval);
    }
    const elapsedMs = Date.now() - sendStart;
    const latencyMs = Number.isFinite(Number(finalEvent?.metrics?.latencyMs))
      ? Number(finalEvent.metrics.latencyMs)
      : elapsedMs;
    const completionTokens = Number.isFinite(Number(finalEvent?.metrics?.completionTokens))
      ? Number(finalEvent.metrics.completionTokens)
      : Math.max(1, Math.round((assistantText || "").length / 4));
    const totalTokens = Number.isFinite(Number(finalEvent?.metrics?.totalTokens))
      ? Number(finalEvent.metrics.totalTokens)
      : completionTokens;
    const model = finalEvent?.model || finalEvent?.metrics?.model || $("#model-mode").value || null;
    const privacyReport = finalEvent?.privacyReport || null;
    const privacyLabel = privacyReport
      ? (privacyReport.personalDataIsolated
          ? `${privacyReport.providerLabel} · Personal data blocked`
          : `${privacyReport.providerLabel} · Custom visibility`)
      : null;
    const metrics = { latencyMs, completionTokens, totalTokens, model, ...(privacyLabel ? { privacyLabel } : {}) };

    const messageArticle = assistantBody.closest(".message");
    const header = messageArticle?.querySelector(".message-header");
    if (header) {
      header.querySelector(".message-meta-badge")?.remove();
      const badge = createMetricsBadge({ role: "assistant", content: assistantText, metrics });
      if (badge) header.appendChild(badge);
    }

    const provenance = finalEvent?.provenance || null;
    const savedMessage = await persistMessage("assistant", assistantText || assistantBody.textContent, conversationId, metrics, provenance, null, approvalActionCard);
    if (messageArticle) {
      messageArticle.querySelector(".message-actions")?.remove();
      messageArticle.appendChild(createReactionControls(savedMessage || { role: "assistant", content: assistantText, metrics, provenance }));
      messageArticle.querySelector(".auto-memory-disclosure")?.remove();
      if (provenance?.autoMemories?.length) {
        const autoMemEl = createAutoMemoryDisclosure(provenance.autoMemories);
        if (autoMemEl) messageArticle.appendChild(autoMemEl);
        toast(provenance.autoMemories.length === 1
          ? `✦ Memory updated: ${provenance.autoMemories[0].title}`
          : `✦ Memory updated (${provenance.autoMemories.length} items saved)`);
      }
      messageArticle.querySelector(".turn-provenance")?.remove();
      if (provenance) {
        const provEl = createProvenanceDisclosure(provenance);
        if (provEl) messageArticle.appendChild(provEl);
      }
    }
    loadConversations().catch(() => {});
    refreshVramStatus().catch(() => {});
    window.alfieSoul?.pulse("completed", 2200, "idle", "purple");
    if (finalText) {
      speakAssistantReply?.(finalText);
    }
    if (finalEvent?.status === "awaiting_user_approval") {
      turnOutcome = "awaiting_approval";
      toast("Alfie is waiting for your approval.");
      loadToolsAndApprovals().catch(() => {});
    }
    if (chatAutoScrollEnabled) {
      scrollChatToBottom();
    }
    updateScrollToBottomIndicator();
  } catch (error) {
    if (thinking) {
      thinking.stop();
      thinking.element.remove();
      thinking = null;
    }
    if (chatRequest.abortedByUser) {
      turnOutcome = "cancelled";
      if (!chatRequest.silent && assistantBody) {
        assistantBody.querySelector(".streaming-cursor")?.remove();
        const partial = assistantText.trim();
        const stoppedText = partial || "*Stopped.*";
        renderMarkdown(assistantBody, stoppedText);
        assistantBody.dataset.rawContent = stoppedText;
        const messageArticle = assistantBody.closest(".message");
        if (partial && activeConversationIdForTurn) {
          const savedPartial = await persistMessage("assistant", partial, activeConversationIdForTurn).catch(() => null);
          if (messageArticle) {
            messageArticle.querySelector(".message-actions")?.remove();
            messageArticle.appendChild(createReactionControls(savedPartial || { role: "assistant", content: partial }));
          }
        }
        window.alfieSoul?.setState("idle", "purple");
        toast("Generation stopped.");
        if (chatAutoScrollEnabled) scrollChatToBottom();
        updateScrollToBottomIndicator();
      }
      return;
    }
    turnOutcome = "failed";
    if (assistantBody) {
      assistantBody.querySelector(".streaming-cursor")?.remove();
      const rawMsg = String(error?.message || "Connection interrupted.");
      const isConnDrop = /network|fetch|abort|connection|stream|closed|chunk/i.test(rawMsg);
      const errText = isConnDrop
        ? `The connection was interrupted while building that response (${rawMsg}). Tip: for large website or multi-file builds, open **Options** (☰) and enable **Run in background** so Alfie finishes cleanly even if the browser sleeps.`
        : "I couldn't complete that response. " + rawMsg;
      renderMarkdown(assistantBody, errText);
      assistantBody.dataset.rawContent = errText.trim();
      const messageArticle = assistantBody.closest(".message");
      if (messageArticle) {
        messageArticle.querySelector(".message-actions")?.remove();
        messageArticle.appendChild(createReactionControls({ role: "assistant", content: errText }));
      }
    }
    loadConversations().catch(() => {});
    window.alfieSoul?.setState("error", "red");
    setTimeout(() => {
      if (window.alfieSoul?.getAnimationState() === "error") window.alfieSoul?.setState("idle", "purple");
    }, 4500);
    toast(error.message);
    if (chatAutoScrollEnabled) {
      scrollChatToBottom();
    }
    updateScrollToBottomIndicator();
  } finally {
    if (thinking) {
      thinking.stop();
      thinking.element.remove();
      thinking = null;
    }
    assistantBody?.querySelector(".streaming-cursor")?.remove();
    if (finishChatRequest(chatRequest, { outcome: turnOutcome })) {
      input.disabled = false;
      if (!chatRequest.abortedByUser) {
        input.value = "";
        input.style.height = "auto";
      }
      if (!chatRequest.silent) input.focus();
    }
  }
}

let activeSpeechRecognition = null;
let voiceListening = false;
let voiceBaseText = "";
let voiceFinalTranscript = "";
let voiceSessionToken = 0;
let voiceAnalyserToken = 0;
let voiceAudioContext = null;
let voiceAudioSource = null;
let voiceMediaStream = null;
let voiceAnalyser = null;
let voiceTimeData = null;
let voiceFreqData = null;
let voiceRafId = null;
let voiceSpeechEnergy = 0;
let voiceSpeechDetected = false;
let voiceBarHeights = [2.6, 3.2, 3.8, 3.2, 2.6];

function getVoiceWaveformApi() {
  return typeof window !== "undefined" ? window.AlfieVoiceWaveform || null : null;
}

function getSpeechRecognitionCtor() {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function getVoiceWaveformSvg() {
  const btn = $("#voice-input-btn");
  return btn ? btn.querySelector(".voice-waveform") : null;
}

function getVoiceWaveformBars() {
  const svg = getVoiceWaveformSvg();
  return svg ? Array.from(svg.querySelectorAll(".voice-bar")) : [];
}

function setVoiceWaveformMeta(level, source) {
  const svg = getVoiceWaveformSvg();
  if (!svg) return;
  svg.dataset.audioLevel = Number.isFinite(level) ? Math.max(0, Math.min(1, level)).toFixed(2) : "0.00";
  svg.dataset.audioSource = source || "idle";
}

function resetVoiceWaveformBars() {
  const api = getVoiceWaveformApi();
  const defaults = api ? [...api.WAVEFORM_RESTING_HEIGHTS] : [2.6, 3.2, 3.8, 3.2, 2.6];
  const bars = getVoiceWaveformBars();
  voiceBarHeights = defaults.slice(0, bars.length || 5);
  if (api) {
    api.applyBarHeightsToSvg(bars, voiceBarHeights);
  } else {
    bars.forEach((bar, index) => {
      const h = voiceBarHeights[index] || 2.6;
      bar.setAttribute("height", h.toFixed(2));
      bar.setAttribute("y", ((16 - h) / 2).toFixed(2));
    });
  }
  setVoiceWaveformMeta(0, "idle");
}

function teardownVoiceAudioAnalyser() {
  voiceAnalyserToken = 0;
  voiceAnalyser = null;
  voiceTimeData = null;
  voiceFreqData = null;
  if (voiceAudioSource) {
    try {
      voiceAudioSource.disconnect();
    } catch {}
    voiceAudioSource = null;
  }
  if (voiceMediaStream) {
    try {
      voiceMediaStream.getTracks().forEach((track) => track.stop());
    } catch {}
    voiceMediaStream = null;
  }
  if (voiceAudioContext) {
    try {
      voiceAudioContext.close().catch(() => {});
    } catch {}
    voiceAudioContext = null;
  }
}

function attachVoiceAudioAnalyser(sessionToken) {
  if (!sessionToken || voiceAnalyserToken === sessionToken) return;
  const AudioCtx = typeof window !== "undefined" ? (window.AudioContext || window.webkitAudioContext) : null;
  if (!AudioCtx || !navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
    return;
  }

  teardownVoiceAudioAnalyser();
  voiceAnalyserToken = sessionToken;

  let ctx = null;
  try {
    ctx = new AudioCtx();
    if (ctx.state === "suspended" && typeof ctx.resume === "function") {
      ctx.resume().catch(() => {});
    }
    voiceAudioContext = ctx;
  } catch {
    voiceAnalyserToken = 0;
    return;
  }

  navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  })
    .then((stream) => {
      if (sessionToken !== voiceSessionToken || !ctx || voiceAudioContext !== ctx) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      if (ctx.state === "suspended" && typeof ctx.resume === "function") {
        ctx.resume().catch(() => {});
      }
      voiceMediaStream = stream;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.55;
      analyser.minDecibels = -85;
      analyser.maxDecibels = -18;
      source.connect(analyser);
      voiceAudioSource = source;
      voiceAnalyser = analyser;
      voiceTimeData = new Uint8Array(analyser.fftSize);
      voiceFreqData = new Uint8Array(analyser.frequencyBinCount);
      if (voiceListening) {
        setVoiceWaveformMeta(0, "analyser");
      }
    })
    .catch(() => {
      if (sessionToken === voiceSessionToken) {
        teardownVoiceAudioAnalyser();
      }
    });
}

function stopVoiceWaveform() {
  voiceSessionToken += 1;
  if (voiceRafId !== null) {
    cancelAnimationFrame(voiceRafId);
    voiceRafId = null;
  }
  voiceSpeechEnergy = 0;
  voiceSpeechDetected = false;
  teardownVoiceAudioAnalyser();
  resetVoiceWaveformBars();
}

function startVoiceWaveform() {
  if (voiceRafId !== null) {
    cancelAnimationFrame(voiceRafId);
    voiceRafId = null;
  }
  const bars = getVoiceWaveformBars();
  if (!bars.length) return;
  const api = getVoiceWaveformApi();

  const prefersReduced = typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (prefersReduced) {
    const staticHeights = api ? api.WAVEFORM_REDUCED_MOTION_HEIGHTS : [5.4, 9.6, 13.0, 9.2, 5.4];
    if (api) {
      api.applyBarHeightsToSvg(bars, staticHeights);
    } else {
      bars.forEach((bar, i) => {
        const h = staticHeights[i] || 6;
        bar.setAttribute("height", h.toFixed(2));
        bar.setAttribute("y", ((16 - h) / 2).toFixed(2));
      });
    }
    setVoiceWaveformMeta(0.5, "reduced-motion");
    return;
  }

  if (voiceSessionToken === 0) {
    voiceSessionToken = 1;
  }
  attachVoiceAudioAnalyser(voiceSessionToken);
  const minHeight = api ? api.WAVEFORM_MIN_BAR_HEIGHT : 2.6;
  voiceBarHeights = new Array(bars.length).fill(minHeight);

  const renderFrame = (timestamp) => {
    if (!voiceListening) {
      voiceRafId = null;
      return;
    }

    const t = (timestamp || performance.now()) * 0.0085;
    voiceSpeechEnergy = Math.max(voiceSpeechDetected ? 0.42 : 0.08, voiceSpeechEnergy * 0.92);

    let hasAnalyserSignal = false;
    if (voiceAnalyser && voiceTimeData && voiceFreqData) {
      try {
        voiceAnalyser.getByteTimeDomainData(voiceTimeData);
        voiceAnalyser.getByteFrequencyData(voiceFreqData);
        hasAnalyserSignal = true;
      } catch {
        hasAnalyserSignal = false;
      }
    }

    let targetHeights;
    let currentVolume = 0;
    if (hasAnalyserSignal && api) {
      const metrics = api.computeBarHeightsFromAnalyser({
        timeDomainData: voiceTimeData,
        frequencyData: voiceFreqData,
        barCount: bars.length
      });
      targetHeights = metrics.bars.map((bar) => bar.height);
      currentVolume = metrics.volume;
      setVoiceWaveformMeta(currentVolume, "analyser");
    } else if (api) {
      const metrics = api.computeBarHeightsFromSpeechEnergy({
        energy: voiceSpeechEnergy,
        barCount: bars.length,
        phase: t
      });
      targetHeights = metrics.bars.map((bar) => bar.height);
      currentVolume = metrics.volume;
      setVoiceWaveformMeta(currentVolume, "speech-events");
    } else {
      targetHeights = bars.map(() => minHeight + voiceSpeechEnergy * 9);
      currentVolume = voiceSpeechEnergy;
      setVoiceWaveformMeta(currentVolume, "speech-events");
    }

    voiceBarHeights = api
      ? api.smoothBarHeights(voiceBarHeights, targetHeights)
      : targetHeights;

    if (api) {
      api.applyBarHeightsToSvg(bars, voiceBarHeights);
    } else {
      bars.forEach((bar, i) => {
        const h = voiceBarHeights[i] || minHeight;
        bar.setAttribute("height", h.toFixed(2));
        bar.setAttribute("y", ((16 - h) / 2).toFixed(2));
      });
    }

    voiceRafId = requestAnimationFrame(renderFrame);
  };

  voiceRafId = requestAnimationFrame(renderFrame);
}

function setVoiceButtonState(listening) {
  voiceListening = Boolean(listening);
  const btn = $("#voice-input-btn");
  if (!btn) return;
  btn.classList.toggle("is-listening", voiceListening);
  btn.setAttribute("aria-pressed", String(voiceListening));
  btn.setAttribute("aria-label", voiceListening ? "Stop voice input" : "Start voice input");
  btn.title = voiceListening ? "Listening… click to stop" : "Voice-to-text input";
  if (voiceListening) {
    startVoiceWaveform();
  } else {
    stopVoiceWaveform();
  }
}

function stopVoiceInput() {
  stopVoiceWaveform();
  if (activeSpeechRecognition) {
    try { activeSpeechRecognition.stop(); } catch {}
  }
}

function initVoiceInput() {
  const btn = $("#voice-input-btn");
  if (!btn) return;
  resetVoiceWaveformBars();
  const SpeechCtor = getSpeechRecognitionCtor();
  if (!SpeechCtor) {
    btn.classList.add("is-unsupported");
    btn.title = "Voice input is not supported in this browser";
  }

  btn.addEventListener("click", () => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      toast("Voice input requires a browser with Web Speech API support (Chrome, Edge, or Safari).");
      return;
    }

    if (voiceListening && activeSpeechRecognition) {
      stopVoiceInput();
      return;
    }

    try {
      voiceSessionToken += 1;
      const sessionToken = voiceSessionToken;
      // Start Web Audio AnalyserNode inside the click user-gesture so AudioContext starts active
      attachVoiceAudioAnalyser(sessionToken);

      const recognition = new Ctor();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = navigator.language || "en-US";

      voiceBaseText = composerInput.value.trimEnd();
      voiceFinalTranscript = "";
      activeSpeechRecognition = recognition;

      recognition.onstart = () => {
        if (sessionToken !== voiceSessionToken) return;
        voiceSpeechEnergy = 0.25;
        setVoiceButtonState(true);
        if (window.alfieSoul?.getAnimationState() === "idle") {
          window.alfieSoul?.startListening("purple");
        }
        composerInput.focus();
      };

      recognition.onsoundstart = () => {
        voiceSpeechDetected = true;
        voiceSpeechEnergy = Math.max(voiceSpeechEnergy, 0.58);
      };

      recognition.onspeechstart = () => {
        voiceSpeechDetected = true;
        voiceSpeechEnergy = Math.max(voiceSpeechEnergy, 0.85);
      };

      recognition.onspeechend = () => {
        voiceSpeechDetected = false;
      };

      recognition.onsoundend = () => {
        voiceSpeechDetected = false;
      };

      recognition.onresult = (event) => {
        voiceSpeechDetected = true;
        voiceSpeechEnergy = 0.94;
        let interim = "";
        let finalized = "";
        for (let i = 0; i < event.results.length; i++) {
          const result = event.results[i];
          const text = result?.[0]?.transcript || "";
          if (result.isFinal) finalized += text;
          else interim += text;
        }
        voiceFinalTranscript = finalized.trim();
        const spoken = [voiceFinalTranscript, interim.trim()].filter(Boolean).join(" ").trim();
        const combined = voiceBaseText
          ? (spoken ? `${voiceBaseText} ${spoken}` : voiceBaseText)
          : spoken;
        composerInput.value = combined;
        composerInput.dispatchEvent(new Event("input", { bubbles: true }));
      };

      recognition.onerror = (event) => {
        const err = event?.error || "unknown";
        if (err === "aborted") return;
        if (err === "not-allowed" || err === "service-not-allowed") {
          toast("Microphone permission was denied. Allow microphone access in your browser to use voice input.", { variant: "warning", durationMs: 4800 });
        } else if (err === "no-speech") {
          toast("No speech detected. Try speaking closer to your microphone.");
        } else if (err === "audio-capture") {
          toast("No microphone was detected on this device.", { variant: "warning" });
        } else if (err === "network") {
          toast("Speech recognition network error — check your connection and try again.");
        } else {
          toast("Voice input stopped due to a browser speech error.");
        }
      };

      recognition.onend = () => {
        if (activeSpeechRecognition === recognition) {
          activeSpeechRecognition = null;
        }
        setVoiceButtonState(false);
        if (!composerInput.value.trim() && window.alfieSoul?.getAnimationState() === "listening") {
          window.alfieSoul?.setAnimationState("idle");
        }
      };

      recognition.start();
    } catch {
      activeSpeechRecognition = null;
      setVoiceButtonState(false);
      toast("Could not start voice input. Check microphone permissions and try again.");
    }
  });
}

$("#chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  stopVoiceInput();
  sendMessage(event.currentTarget.elements.message.value);
});

const composerInput = $("#chat-form").elements.message;
initVoiceInput();
composerInput.addEventListener("focus", () => {
  if (window.alfieSoul?.getAnimationState() === "idle") {
    window.alfieSoul?.setAnimationState("listening");
  }
});
composerInput.addEventListener("blur", () => {
  if (!voiceListening && window.alfieSoul?.getAnimationState() === "listening") {
    window.alfieSoul?.setAnimationState("idle");
  }
});
function getVisibleSlashSuggestions() {
  const suggestions = $("#composer-suggestions");
  if (!suggestions || suggestions.hidden) return [];
  return [...suggestions.querySelectorAll(".composer-suggestion-item")].filter((btn) => !btn.hidden);
}

function updateSlashSuggestions(rawValue) {
  const suggestions = $("#composer-suggestions");
  if (!suggestions) return;
  const val = String(rawValue || "").trim();
  const items = [...suggestions.querySelectorAll(".composer-suggestion-item")];
  if (!val.startsWith("/") || val.includes(" ")) {
    suggestions.hidden = true;
    items.forEach((btn) => {
      btn.hidden = false;
      btn.classList.remove("is-active");
    });
    return;
  }
  const needle = val.toLowerCase();
  let visibleCount = 0;
  let firstVisible = null;
  for (const btn of items) {
    const cmd = String(btn.dataset.cmd || "").trim().toLowerCase();
    const matches = cmd.startsWith(needle);
    btn.hidden = !matches;
    btn.classList.remove("is-active");
    if (matches) {
      if (!firstVisible) firstVisible = btn;
      visibleCount += 1;
    }
  }
  if (visibleCount > 0 && firstVisible) {
    firstVisible.classList.add("is-active");
    suggestions.hidden = false;
  } else {
    suggestions.hidden = true;
  }
}

composerInput.addEventListener("input", () => {
  composerInput.style.height = "auto";
  composerInput.style.height = Math.min(composerInput.scrollHeight, 180) + "px";
  if (composerInput.value.trim().length > 0 && window.alfieSoul?.getAnimationState() === "idle") {
    window.alfieSoul?.setAnimationState("listening");
  } else if (!composerInput.value.trim().length && window.alfieSoul?.getAnimationState() === "listening") {
    window.alfieSoul?.setAnimationState("idle");
  }
  updateSlashSuggestions(composerInput.value);
});
composerInput.addEventListener("keydown", (event) => {
  const suggestions = $("#composer-suggestions");
  const visibleItems = getVisibleSlashSuggestions();
  if (visibleItems.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
    event.preventDefault();
    const currentIdx = visibleItems.findIndex((btn) => btn.classList.contains("is-active"));
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const nextIdx = (currentIdx + delta + visibleItems.length) % visibleItems.length;
    visibleItems.forEach((btn, idx) => btn.classList.toggle("is-active", idx === nextIdx));
    return;
  }
  if (event.key === "Tab" && visibleItems.length) {
    event.preventDefault();
    const active = visibleItems.find((btn) => btn.classList.contains("is-active")) || visibleItems[0];
    composerInput.value = active?.dataset?.cmd || "/idea ";
    if (suggestions) suggestions.hidden = true;
    composerInput.focus();
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (suggestions) suggestions.hidden = true;
    $("#chat-form").requestSubmit();
  }
});

let activeShortcutBindings = null;
let recordingShortcutAction = null;

function getShortcutsLib() {
  return typeof window !== "undefined" ? window.AlfieShortcuts : null;
}

function getDefaultShortcutBindingsMap() {
  const lib = getShortcutsLib();
  if (lib?.DEFAULT_SHORTCUT_BINDINGS) {
    return lib.normalizeShortcutBindings(lib.DEFAULT_SHORTCUT_BINDINGS);
  }
  return {
    focus_composer: { key: "k", ctrl: true, shift: false, alt: false },
    close_modals: { key: "Escape", ctrl: false, shift: false, alt: false },
    cycle_soul_mood: { key: "l", ctrl: true, shift: true, alt: false }
  };
}

function loadShortcutBindings() {
  const lib = getShortcutsLib();
  const storageKey = lib?.SHORTCUT_STORAGE_KEY || "alfie_keyboard_shortcuts_v1";
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      return lib?.normalizeShortcutBindings
        ? lib.normalizeShortcutBindings(parsed)
        : getDefaultShortcutBindingsMap();
    }
  } catch {}
  return getDefaultShortcutBindingsMap();
}

function saveShortcutBindings(bindings) {
  const lib = getShortcutsLib();
  const storageKey = lib?.SHORTCUT_STORAGE_KEY || "alfie_keyboard_shortcuts_v1";
  activeShortcutBindings = lib?.normalizeShortcutBindings
    ? lib.normalizeShortcutBindings(bindings)
    : bindings;
  try {
    localStorage.setItem(storageKey, JSON.stringify(activeShortcutBindings));
  } catch {}
  syncShortcutHints();
  renderShortcutSettings();
  renderShortcutsHelpModal();
}

function getActiveShortcutBindings() {
  if (!activeShortcutBindings) {
    activeShortcutBindings = loadShortcutBindings();
  }
  return activeShortcutBindings;
}

function formatBindingCombo(binding) {
  const lib = getShortcutsLib();
  if (lib?.formatShortcutBinding) return lib.formatShortcutBinding(binding);
  return binding?.key || "";
}

function formatBindingKeysList(binding) {
  const lib = getShortcutsLib();
  if (lib?.formatShortcutKeys) return lib.formatShortcutKeys(binding);
  return [binding?.key || ""];
}

function createShortcutKbdGroup(keys, { separator = "+" } = {}) {
  const group = document.createElement("span");
  group.className = "shortcut-keys-group";
  keys.forEach((token, idx) => {
    if (idx > 0 && separator) {
      const sep = document.createElement("span");
      sep.className = "shortcut-kbd-plus";
      sep.textContent = separator;
      sep.setAttribute("aria-hidden", "true");
      group.appendChild(sep);
    }
    const kbd = document.createElement("kbd");
    kbd.className = "shortcut-kbd";
    kbd.textContent = token;
    group.appendChild(kbd);
  });
  return group;
}

function syncShortcutHints() {
  const lib = getShortcutsLib();
  const bindings = getActiveShortcutBindings();
  const focusCombo = formatBindingCombo(bindings.focus_composer);
  const closeCombo = formatBindingCombo(bindings.close_modals);
  const moodCombo = formatBindingCombo(bindings.cycle_soul_mood);

  if (composerInput) {
    composerInput.placeholder = `Message Alfie, /idea <thought>, or /image <prompt>… (${focusCombo})`;
    const ariaFocus = lib?.formatAriaKeyshortcuts ? lib.formatAriaKeyshortcuts(bindings.focus_composer) : "Control+K Meta+K";
    if (ariaFocus) composerInput.setAttribute("aria-keyshortcuts", ariaFocus);
  }

  const ariaMood = lib?.formatAriaKeyshortcuts ? lib.formatAriaKeyshortcuts(bindings.cycle_soul_mood) : "Control+Shift+L Meta+Shift+L";
  document.querySelectorAll("[data-soul]").forEach((el) => {
    el.setAttribute("title", `Alfie's Soul — click or press ${moodCombo} to cycle mood`);
    if (ariaMood) el.setAttribute("aria-keyshortcuts", ariaMood);
  });

  const lightboxCloseBtn = $("#lightbox-close");
  if (lightboxCloseBtn) {
    lightboxCloseBtn.setAttribute("title", `Close (${closeCombo})`);
  }
  const lightboxFooterSpan = document.querySelector("#image-lightbox .lightbox-footer span");
  if (lightboxFooterSpan) {
    lightboxFooterSpan.textContent = `Click or scroll to zoom · Drag to pan when zoomed · ${closeCombo} to close`;
  }
}

function setShortcutSettingsStatus(message = "", tone = "neutral") {
  const statusEl = $("#settings-shortcuts-status");
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.classList.toggle("is-error", tone === "error");
  statusEl.classList.toggle("is-success", tone === "success");
}

function cancelShortcutRecording(statusMessage = "") {
  if (!recordingShortcutAction) return;
  recordingShortcutAction = null;
  renderShortcutSettings();
  if (statusMessage) {
    setShortcutSettingsStatus(statusMessage, "neutral");
  }
}

function startShortcutRecording(action) {
  if (recordingShortcutAction === action) {
    cancelShortcutRecording("Rebinding canceled.");
    return;
  }
  recordingShortcutAction = action;
  renderShortcutSettings();
  const lib = getShortcutsLib();
  const meta = (lib?.GLOBAL_SHORTCUTS || []).find((item) => item.action === action);
  const name = meta?.label || action;
  const cancelHint = action === "close_modals"
    ? "Press your desired key or combination (click Cancel to abort)."
    : "Press your desired key combination (press Esc or click Cancel to abort).";
  setShortcutSettingsStatus(`Listening for "${name}"… ${cancelHint}`, "neutral");
}

function resetSingleShortcut(action) {
  const lib = getShortcutsLib();
  const defaults = getDefaultShortcutBindingsMap();
  const current = { ...getActiveShortcutBindings() };
  const targetDefault = defaults[action];
  if (!targetDefault) return;

  const conflictAction = lib?.findShortcutConflict
    ? lib.findShortcutConflict(current, action, targetDefault)
    : null;
  if (conflictAction) {
    const conflictMeta = (lib?.GLOBAL_SHORTCUTS || []).find((item) => item.action === conflictAction);
    setShortcutSettingsStatus(
      `Cannot reset to ${formatBindingCombo(targetDefault)} because "${conflictMeta?.label || conflictAction}" is currently using it. Rebind or reset that action first.`,
      "error"
    );
    return;
  }

  recordingShortcutAction = null;
  current[action] = { ...targetDefault };
  saveShortcutBindings(current);
  const meta = (lib?.GLOBAL_SHORTCUTS || []).find((item) => item.action === action);
  setShortcutSettingsStatus(`Reset "${meta?.label || action}" to ${formatBindingCombo(targetDefault)}.`, "success");
  toast(`Reset ${meta?.label || action} to ${formatBindingCombo(targetDefault)}.`, { durationMs: 2200 });
}

function resetAllShortcuts() {
  recordingShortcutAction = null;
  saveShortcutBindings(getDefaultShortcutBindingsMap());
  setShortcutSettingsStatus("All keyboard shortcuts restored to defaults (Ctrl+K, Esc, Ctrl+Shift+L).", "success");
  toast("Keyboard shortcuts reset to defaults.", { durationMs: 2200 });
}

function renderShortcutSettings() {
  const host = $("#settings-shortcuts-list");
  if (!host) return;
  const lib = getShortcutsLib();
  const bindings = getActiveShortcutBindings();
  const defaults = getDefaultShortcutBindingsMap();
  const items = lib?.GLOBAL_SHORTCUTS || [
    { action: "focus_composer", label: "Focus chat composer", description: "Jump straight to the message input from anywhere in the workspace." },
    { action: "close_modals", label: "Close open modals", description: "Dismiss open dialogs, image lightbox, drawers, or slash suggestions." },
    { action: "cycle_soul_mood", label: "Cycle Alfie Soul moods", description: "Rotate Alfie's Soul between Work, Good, Alert, and Thinking." }
  ];

  host.replaceChildren();
  let anyCustomized = false;

  for (const item of items) {
    const currentBinding = bindings[item.action] || defaults[item.action];
    const defaultBinding = defaults[item.action];
    const isCustom = lib?.bindingsEqual
      ? !lib.bindingsEqual(currentBinding, defaultBinding)
      : false;
    if (isCustom) anyCustomized = true;
    const isRecording = recordingShortcutAction === item.action;

    const row = document.createElement("div");
    row.className = "shortcut-setting-row" + (isRecording ? " is-recording" : "");
    row.setAttribute("role", "listitem");
    row.dataset.shortcutAction = item.action;

    const info = document.createElement("div");
    info.className = "shortcut-row-info";
    const titleLine = document.createElement("div");
    titleLine.className = "shortcut-row-title-line";
    const title = document.createElement("span");
    title.className = "shortcut-row-title";
    title.textContent = item.label;
    titleLine.appendChild(title);
    if (isCustom) {
      const badge = document.createElement("span");
      badge.className = "shortcut-custom-tag";
      badge.textContent = "Custom";
      titleLine.appendChild(badge);
    }
    const desc = document.createElement("p");
    desc.className = "shortcut-row-desc";
    desc.textContent = item.description;
    info.append(titleLine, desc);

    const controls = document.createElement("div");
    controls.className = "shortcut-row-controls";

    if (isRecording) {
      const prompt = document.createElement("span");
      prompt.className = "shortcut-recording-prompt";
      prompt.setAttribute("aria-live", "polite");
      const dot = document.createElement("span");
      dot.className = "shortcut-recording-dot";
      dot.setAttribute("aria-hidden", "true");
      const text = document.createElement("span");
      text.textContent = "Listening… press keys";
      prompt.append(dot, text);
      controls.appendChild(prompt);
    } else {
      controls.appendChild(createShortcutKbdGroup(formatBindingKeysList(currentBinding)));
    }

    const btnGroup = document.createElement("div");
    btnGroup.className = "shortcut-row-actions";

    const rebindBtn = document.createElement("button");
    rebindBtn.type = "button";
    rebindBtn.className = "secondary-button shortcut-rebind-btn" + (isRecording ? " is-recording" : "");
    rebindBtn.dataset.rebindAction = item.action;
    rebindBtn.textContent = isRecording ? "Cancel" : "Rebind";
    rebindBtn.setAttribute("aria-label", isRecording ? `Cancel rebinding ${item.label}` : `Rebind ${item.label}`);
    rebindBtn.addEventListener("click", () => startShortcutRecording(item.action));

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "secondary-button shortcut-reset-btn";
    resetBtn.dataset.resetAction = item.action;
    resetBtn.textContent = "Reset";
    resetBtn.disabled = !isCustom;
    resetBtn.setAttribute("aria-label", `Reset ${item.label} to default`);
    resetBtn.addEventListener("click", () => resetSingleShortcut(item.action));

    btnGroup.append(rebindBtn, resetBtn);
    controls.appendChild(btnGroup);
    row.append(info, controls);
    host.appendChild(row);
  }

  const resetAllBtn = $("#shortcuts-reset-all-btn");
  if (resetAllBtn) {
    resetAllBtn.disabled = !anyCustomized;
  }
}

function renderShortcutsHelpModal() {
  const customHost = $("#shortcuts-help-custom-list");
  const builtinHost = $("#shortcuts-help-builtin-list");
  if (!customHost || !builtinHost) return;

  const lib = getShortcutsLib();
  const bindings = getActiveShortcutBindings();
  const defaults = getDefaultShortcutBindingsMap();
  const customItems = lib?.GLOBAL_SHORTCUTS || [];
  const builtinItems = lib?.BUILTIN_REFERENCE_SHORTCUTS || [];

  customHost.replaceChildren();
  for (const item of customItems) {
    const binding = bindings[item.action] || defaults[item.action];
    const isCustom = lib?.bindingsEqual ? !lib.bindingsEqual(binding, defaults[item.action]) : false;

    const row = document.createElement("div");
    row.className = "shortcuts-help-row";
    row.setAttribute("role", "listitem");
    row.dataset.helpShortcutAction = item.action;

    const copy = document.createElement("div");
    copy.className = "shortcuts-help-row-copy";
    const titleWrap = document.createElement("div");
    titleWrap.className = "shortcut-row-title-line";
    const strong = document.createElement("strong");
    strong.textContent = item.label;
    titleWrap.appendChild(strong);
    if (isCustom) {
      const tag = document.createElement("span");
      tag.className = "shortcut-custom-tag";
      tag.textContent = "Custom";
      titleWrap.appendChild(tag);
    }
    const span = document.createElement("span");
    span.textContent = item.description;
    copy.append(titleWrap, span);

    row.append(copy, createShortcutKbdGroup(formatBindingKeysList(binding)));
    customHost.appendChild(row);
  }

  builtinHost.replaceChildren();
  for (const item of builtinItems) {
    const row = document.createElement("div");
    row.className = "shortcuts-help-row";
    row.setAttribute("role", "listitem");

    const copy = document.createElement("div");
    copy.className = "shortcuts-help-row-copy";
    const strong = document.createElement("strong");
    strong.textContent = item.label;
    const span = document.createElement("span");
    span.textContent = item.description;
    copy.append(strong, span);

    const separator = item.id === "lightbox_zoom" ? "/" : "+";
    row.append(copy, createShortcutKbdGroup(item.keys, { separator }));
    builtinHost.appendChild(row);
  }
}

let lastFocusBeforeShortcutsModal = null;

function openShortcutsHelpModal() {
  const modal = $("#shortcuts-help-modal");
  if (!modal) return;
  cancelShortcutRecording();
  renderShortcutsHelpModal();
  lastFocusBeforeShortcutsModal = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  modal.hidden = false;
  $("#shortcuts-help-close")?.focus();
}

function closeShortcutsHelpModal() {
  const modal = $("#shortcuts-help-modal");
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  if (lastFocusBeforeShortcutsModal && document.contains(lastFocusBeforeShortcutsModal)) {
    try { lastFocusBeforeShortcutsModal.focus(); } catch {}
  }
  lastFocusBeforeShortcutsModal = null;
}

function isEditableKeyboardTarget(target) {
  if (!target || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function closeAnyOpenModal() {
  const shortcutsModal = $("#shortcuts-help-modal");
  if (shortcutsModal && !shortcutsModal.hidden) {
    closeShortcutsHelpModal();
    return true;
  }
  if (lightboxState.open) {
    closeImageLightbox();
    return true;
  }
  const projectModal = $("#project-modal");
  if (projectModal && !projectModal.hidden) {
    closeProjectModal();
    return true;
  }
  const mobileHistorySheet = $("#mobile-history-sheet");
  if (mobileHistorySheet && !mobileHistorySheet.hidden) {
    mobileHistorySheet.hidden = true;
    return true;
  }
  const cloudPrivacyDrawer = $("#cloud-privacy-drawer");
  if (cloudPrivacyDrawer && !cloudPrivacyDrawer.hidden) {
    cloudPrivacyDrawer.hidden = true;
    $("#cloud-privacy-toggle-btn")?.setAttribute("aria-expanded", "false");
    return true;
  }
  const suggestions = $("#composer-suggestions");
  if (suggestions && !suggestions.hidden) {
    suggestions.hidden = true;
    return true;
  }
  const openDialog = document.querySelector('[role="dialog"]:not([hidden])');
  if (openDialog) {
    openDialog.hidden = true;
    return true;
  }
  return false;
}

function focusComposerFromShortcut() {
  const appShell = $("#app-shell");
  if (!appShell || appShell.hidden || !state.linked) return false;
  closeShortcutsHelpModal();
  if (lightboxState.open) closeImageLightbox();
  const projectModal = $("#project-modal");
  if (projectModal && !projectModal.hidden) closeProjectModal();
  const mobileHistorySheet = $("#mobile-history-sheet");
  if (mobileHistorySheet && !mobileHistorySheet.hidden) mobileHistorySheet.hidden = true;
  if (state.view !== "chat") {
    setView("chat");
  }
  if (!composerInput || composerInput.disabled) return false;
  composerInput.focus();
  const endPos = composerInput.value.length;
  try {
    composerInput.setSelectionRange(endPos, endPos);
  } catch {}
  return true;
}

function cycleSoulMoodFromShortcut() {
  if (!window.alfieSoul?.cycleMood) return null;
  const nextMood = window.alfieSoul.cycleMood();
  const label = window.AlfieShortcuts?.formatMoodLabel
    ? window.AlfieShortcuts.formatMoodLabel(nextMood)
    : nextMood;
  const appShell = $("#app-shell");
  if (appShell && !appShell.hidden) {
    toast(`Alfie Soul mood: ${label}`, { durationMs: 2000 });
  }
  return nextMood;
}

function resolveShortcutActionFallback(event) {
  if (event.isComposing || event.defaultPrevented) return null;
  const key = typeof event.key === "string" ? event.key : "";
  const code = typeof event.code === "string" ? event.code : "";
  const lower = key.toLowerCase();
  const primary = Boolean(event.ctrlKey || event.metaKey);
  if ((key === "Escape" || key === "Esc" || code === "Escape") && !primary && !event.altKey) {
    return "close_modals";
  }
  if (!primary || event.altKey) return null;
  if (!event.shiftKey && (lower === "k" || code === "KeyK")) return "focus_composer";
  if (event.shiftKey && (lower === "l" || code === "KeyL")) return "cycle_soul_mood";
  return null;
}

function handleShortcutRecordingKeydown(event) {
  if (!recordingShortcutAction) return false;
  event.preventDefault();
  event.stopPropagation();

  const lib = getShortcutsLib();
  const targetAction = recordingShortcutAction;
  const candidate = lib?.bindingFromKeyboardEvent ? lib.bindingFromKeyboardEvent(event) : null;
  // Wait for non-modifier key press
  if (!candidate) return true;

  // Bare Escape cancels recording for non-close_modals actions
  if (targetAction !== "close_modals" && candidate.key === "Escape" && !candidate.ctrl && !candidate.alt && !candidate.shift) {
    cancelShortcutRecording("Rebinding canceled.");
    return true;
  }

  const validation = lib?.validateBindingForAction
    ? lib.validateBindingForAction(targetAction, candidate)
    : { valid: true, binding: candidate };

  if (!validation.valid) {
    setShortcutSettingsStatus(validation.error || "Invalid key combination.", "error");
    return true;
  }

  const current = getActiveShortcutBindings();
  const conflictAction = lib?.findShortcutConflict
    ? lib.findShortcutConflict(current, targetAction, validation.binding)
    : null;

  if (conflictAction) {
    const conflictMeta = (lib?.GLOBAL_SHORTCUTS || []).find((item) => item.action === conflictAction);
    setShortcutSettingsStatus(
      `${formatBindingCombo(validation.binding)} is already assigned to "${conflictMeta?.label || conflictAction}". Pick a different combination.`,
      "error"
    );
    return true;
  }

  const nextBindings = {
    ...current,
    [targetAction]: validation.binding
  };
  recordingShortcutAction = null;
  saveShortcutBindings(nextBindings);
  const meta = (lib?.GLOBAL_SHORTCUTS || []).find((item) => item.action === targetAction);
  const comboLabel = formatBindingCombo(validation.binding);
  setShortcutSettingsStatus(`Updated "${meta?.label || targetAction}" to ${comboLabel}.`, "success");
  toast(`Shortcut updated: ${meta?.label || targetAction} → ${comboLabel}`, { durationMs: 2400 });
  return true;
}

function initGlobalKeyboardShortcuts() {
  if (document.documentElement.dataset.alfieShortcutsBound === "1") return;
  document.documentElement.dataset.alfieShortcutsBound = "1";

  activeShortcutBindings = loadShortcutBindings();
  syncShortcutHints();
  renderShortcutSettings();
  renderShortcutsHelpModal();

  $("#shortcuts-help-btn")?.addEventListener("click", openShortcutsHelpModal);
  $("#shortcuts-open-help-btn")?.addEventListener("click", openShortcutsHelpModal);
  $("#shortcuts-reset-all-btn")?.addEventListener("click", resetAllShortcuts);
  $("#shortcuts-help-close")?.addEventListener("click", closeShortcutsHelpModal);
  $("#shortcuts-help-done-btn")?.addEventListener("click", closeShortcutsHelpModal);
  $("#shortcuts-help-modal")?.querySelector("[data-shortcuts-modal-close='backdrop']")?.addEventListener("click", closeShortcutsHelpModal);
  $("#shortcuts-help-customize-btn")?.addEventListener("click", () => {
    closeShortcutsHelpModal();
    const appShell = $("#app-shell");
    if (appShell && !appShell.hidden) {
      setView("settings");
      $("#settings-shortcuts-surface")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  });

  document.addEventListener("keydown", (event) => {
    if (handleShortcutRecordingKeydown(event)) {
      return;
    }

    const lib = getShortcutsLib();
    const bindings = getActiveShortcutBindings();
    const action = lib?.resolveGlobalShortcut
      ? lib.resolveGlobalShortcut(event, bindings)
      : resolveShortcutActionFallback(event);

    if (action === "focus_composer") {
      event.preventDefault();
      focusComposerFromShortcut();
      return;
    }

    if (action === "close_modals") {
      if (closeAnyOpenModal()) {
        event.preventDefault();
      }
      return;
    }

    if (action === "cycle_soul_mood") {
      event.preventDefault();
      cycleSoulMoodFromShortcut();
      return;
    }

    // Open keyboard shortcuts help on '?' outside text inputs when signed in
    const appShell = $("#app-shell");
    if (
      appShell &&
      !appShell.hidden &&
      lib?.isShortcutHelpTrigger &&
      lib.isShortcutHelpTrigger(event, isEditableKeyboardTarget(event.target))
    ) {
      const modal = $("#shortcuts-help-modal");
      event.preventDefault();
      if (modal && !modal.hidden) closeShortcutsHelpModal();
      else openShortcutsHelpModal();
    }
  }, true);

  if (typeof window !== "undefined") {
    window.alfieShortcuts = {
      focusComposer: focusComposerFromShortcut,
      closeModals: closeAnyOpenModal,
      cycleSoulMood: cycleSoulMoodFromShortcut,
      openHelp: openShortcutsHelpModal,
      closeHelp: closeShortcutsHelpModal,
      getBindings: () => ({ ...getActiveShortcutBindings() }),
      resetDefaults: resetAllShortcuts
    };
  }
}

initGlobalKeyboardShortcuts();

function createItem(title, detail, actions = []) {
  const row = document.createElement("article");
  row.className = "list-item";
  const info = document.createElement("div");
  const heading = document.createElement("strong");
  heading.textContent = title;
  const description = document.createElement("p");
  description.textContent = detail || "";
  info.append(heading, description);
  row.appendChild(info);
  if (actions.length) {
    const controls = document.createElement("div");
    controls.className = "item-actions";
    for (const action of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = action.label;
      button.className = action.kind || "secondary-button";
      button.addEventListener("click", action.onClick);
      controls.appendChild(button);
    }
    row.appendChild(controls);
  }
  return row;
}

/* Garden Memory Importance Distribution Bar Chart (Recharts) */
let gardenImportanceFilter = null;
let lastGardenMemories = [];

function calculateImportanceDistribution(memories = []) {
  const total = memories.length;
  return Array.from({ length: 10 }, (_, i) => {
    const score = i + 1;
    const matching = memories.filter((m) => (Number(m.importance) || 5) === score);
    const count = matching.length;
    const percentage = total > 0 ? Math.round((count / total) * 100) : 0;
    return {
      score,
      label: "Score " + score,
      count,
      percentage
    };
  });
}

function updateGardenStats(memories = []) {
  const total = memories.length;
  const totalEl = $("#stat-total-memories");
  const avgEl = $("#stat-avg-importance");
  const highEl = $("#stat-high-priority");

  if (totalEl) totalEl.textContent = String(total);

  if (avgEl) {
    if (!total) {
      avgEl.textContent = "0.0";
    } else {
      const sum = memories.reduce((acc, m) => acc + (Number(m.importance) || 5), 0);
      avgEl.textContent = (sum / total).toFixed(1);
    }
  }

  if (highEl) {
    const highCount = memories.filter((m) => (Number(m.importance) || 5) >= 8).length;
    highEl.textContent = String(highCount);
  }
}

function getBarColorForScore(score, isSelected = false) {
  if (isSelected) return "#ffffff";
  if (score >= 9) return "#c084fc"; // critical (bright purple)
  if (score >= 7) return "#8b5cf6"; // high priority (vibrant purple)
  if (score >= 5) return "#6366f1"; // medium (indigo)
  if (score >= 3) return "#475569"; // low-medium (slate)
  return "#334155"; // low (dark slate)
}

function renderGardenRechartsBarChart(container, distribution, onSelectScore, selectedScore) {
  if (!container) return;

  if (window.React && window.ReactDOM && window.Recharts) {
    const React = window.React;
    const { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell, CartesianGrid } = window.Recharts;

    const CustomTooltip = ({ active, payload }) => {
      if (!active || !payload || !payload.length) return null;
      const data = payload[0].payload;
      const level = data.score <= 3 ? "Low significance" : data.score <= 6 ? "Medium significance" : data.score <= 8 ? "High priority" : "Critical priority";
      return React.createElement("div", { className: "garden-chart-tooltip" },
        React.createElement("strong", null, `Score ${data.score} · ${level}`),
        React.createElement("p", null, `${data.count} ${data.count === 1 ? "memory" : "memories"} (${data.percentage}% of Garden)`),
        React.createElement("small", null, selectedScore === data.score ? "✓ Active filter. Click to clear." : "Click bar to filter memories")
      );
    };

    const chartNode = React.createElement(
      ResponsiveContainer,
      { width: "100%", height: 220 },
      React.createElement(
        BarChart,
        {
          data: distribution,
          margin: { top: 14, right: 10, left: -20, bottom: 2 },
          onClick: (state) => {
            if (state && state.activePayload && state.activePayload.length) {
              const clickedScore = state.activePayload[0].payload.score;
              onSelectScore(clickedScore);
            }
          }
        },
        React.createElement(CartesianGrid, { strokeDasharray: "2 2", stroke: "rgba(184,164,255,0.12)", vertical: false }),
        React.createElement(XAxis, {
          dataKey: "score",
          tick: { fill: "#998fae", fontSize: 11, fontFamily: "var(--font-mono, monospace)" },
          axisLine: { stroke: "rgba(184,164,255,0.2)" },
          tickLine: { stroke: "rgba(184,164,255,0.2)" }
        }),
        React.createElement(YAxis, {
          allowDecimals: false,
          tick: { fill: "#998fae", fontSize: 10, fontFamily: "var(--font-mono, monospace)" },
          axisLine: { stroke: "rgba(184,164,255,0.2)" },
          tickLine: { stroke: "rgba(184,164,255,0.2)" }
        }),
        React.createElement(Tooltip, { content: React.createElement(CustomTooltip), cursor: { fill: "rgba(184,164,255,0.06)" } }),
        React.createElement(
          Bar,
          {
            dataKey: "count",
            radius: [2, 2, 0, 0],
            animationDuration: 300,
            cursor: "pointer"
          },
          distribution.map((entry) =>
            React.createElement(Cell, {
              key: `score-bar-${entry.score}`,
              fill: getBarColorForScore(entry.score, selectedScore === entry.score),
              stroke: selectedScore === entry.score ? "#ffffff" : "transparent",
              strokeWidth: selectedScore === entry.score ? 2 : 0
            })
          )
        )
      )
    );

    if (!container._reactRoot) {
      container._reactRoot = window.ReactDOM.createRoot ? window.ReactDOM.createRoot(container) : null;
    }
    if (container._reactRoot) {
      container._reactRoot.render(chartNode);
    } else if (window.ReactDOM.render) {
      window.ReactDOM.render(chartNode, container);
    }
  } else {
    renderFallbackBarChart(container, distribution, onSelectScore, selectedScore);
  }
}

function renderFallbackBarChart(container, distribution, onSelectScore, selectedScore) {
  container.replaceChildren();
  const maxCount = Math.max(1, ...distribution.map((d) => d.count));

  const chart = document.createElement("div");
  chart.className = "fallback-bar-chart";

  const barsRow = document.createElement("div");
  barsRow.className = "fallback-bars-row";

  for (const item of distribution) {
    const col = document.createElement("div");
    col.className = "fallback-bar-col";
    col.title = `Score ${item.score}: ${item.count} memories (${item.percentage}%)`;
    col.addEventListener("click", () => onSelectScore(item.score));

    const val = document.createElement("span");
    val.className = "fallback-bar-val";
    val.textContent = item.count > 0 ? String(item.count) : "";

    const fill = document.createElement("div");
    fill.className = "fallback-bar-fill" + (selectedScore === item.score ? " active" : "");
    const heightPercent = item.count > 0 ? Math.max(8, Math.round((item.count / maxCount) * 100)) : 2;
    fill.style.height = heightPercent + "%";
    fill.style.background = getBarColorForScore(item.score, selectedScore === item.score);

    col.append(val, fill);
    barsRow.appendChild(col);
  }

  const axisRow = document.createElement("div");
  axisRow.className = "fallback-axis-row";
  for (const item of distribution) {
    const label = document.createElement("span");
    label.className = "fallback-axis-label";
    label.textContent = String(item.score);
    axisRow.appendChild(label);
  }

  chart.append(barsRow, axisRow);
  container.appendChild(chart);
}

window.gardenChart = {
  calculateImportanceDistribution,
  renderGardenRechartsBarChart,
  updateGardenStats,
  getFilter: () => gardenImportanceFilter,
  setFilter: (score) => {
    gardenImportanceFilter = score;
    loadMemories();
  }
};

const MEMORY_KIND_LABELS = {
  fact: "Fact",
  decision: "Decision",
  preference: "Preference",
  temporary: "Temporary",
  lesson: "Lesson",
  note: "Note"
};

const MEMORY_TRUST_LABELS = {
  user_authored: "User authored",
  system_verified: "System verified",
  external_untrusted: "External untrusted"
};

function formatShortExpiry(iso) {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const diff = ms - Date.now();
  if (diff <= 0) return "Expired";
  const hours = Math.round(diff / 3600000);
  if (hours < 1) {
    const mins = Math.max(1, Math.round(diff / 60000));
    return `Expires in ${mins}m`;
  }
  if (hours < 48) return `Expires in ${hours}h`;
  return "Expires " + new Date(ms).toLocaleDateString();
}

async function loadMemories() {
  const host = $("#memory-list");
  host.replaceChildren();
  const banner = $("#garden-offline-banner");
  const query = ($("#memory-search")?.value || "").trim().toLowerCase();
  const kindFilter = state.memoryKindFilter || "all";
  const includeArchived = Boolean(state.memoryIncludeArchived);

  function renderMemoryItems(memories, isCached = false) {
    host.replaceChildren();
    if (banner) banner.hidden = !isCached && navigator.onLine;
    let list = memories || [];

    if (kindFilter && kindFilter !== "all") {
      list = list.filter((m) => (m.kind || m.type || "note") === kindFilter);
    }

    // Filter by selected importance score from the Recharts bar chart
    if (gardenImportanceFilter !== null) {
      list = list.filter((m) => (Number(m.importance) || 5) === gardenImportanceFilter);
    }

    if (query) {
      list = list.filter((m) =>
        (m.text || "").toLowerCase().includes(query) ||
        (m.title || "").toLowerCase().includes(query) ||
        (m.kind || "").toLowerCase().includes(query) ||
        (m.tags || []).some((t) => String(t).toLowerCase().includes(query))
      );
    }

    // Update filter banner UI
    const filterBanner = $("#chart-filter-banner");
    const filterScoreBadge = $("#filter-score-badge");
    if (filterBanner && filterScoreBadge) {
      if (gardenImportanceFilter !== null) {
        filterBanner.hidden = false;
        filterScoreBadge.textContent = String(gardenImportanceFilter);
      } else {
        filterBanner.hidden = true;
      }
    }

    for (const memory of list) {
      const imp = Number(memory.importance || 5);
      const isHighPriority = imp >= 8;
      const kindLabel = MEMORY_KIND_LABELS[memory.kind] || MEMORY_KIND_LABELS[memory.type] || "Note";
      const trustLabel = MEMORY_TRUST_LABELS[memory.trust] || MEMORY_TRUST_LABELS[memory.provenance?.trust] || (memory.origin || "garden");
      const expiryLabel = memory.expired ? "Expired" : formatShortExpiry(memory.expiresAt);
      const meta = [
        kindLabel,
        trustLabel,
        "importance " + imp + (isHighPriority ? " ★" : ""),
        memory.archived ? "Archived" : "",
        expiryLabel,
        ...(memory.tags || [])
      ].filter(Boolean).join(" · ");
      const edit = {
        label: "Edit",
        onClick: async () => {
          if (!navigator.onLine) { toast("Cannot edit memories while offline."); return; }
          const text = prompt("Update this memory", memory.text || "");
          if (text === null || !text.trim()) return;
          const importanceInput = prompt("Importance from 1 (low) to 10 (high)", String(memory.importance || 5));
          if (importanceInput === null) return;
          const importance = Number(importanceInput);
          if (!Number.isInteger(importance) || importance < 1 || importance > 10) { toast("Importance must be a whole number from 1 to 10."); return; }
          try {
            await api("/api/core/memories/" + encodeURIComponent(memory.id), { method: "PATCH", body: JSON.stringify({ text, importance }) });
            await loadMemories();
          } catch (error) { toast(error.message); }
        }
      };
      const archiveToggle = {
        label: memory.archived ? "Restore" : "Archive",
        onClick: async () => {
          if (!navigator.onLine) { toast("Cannot update memories while offline."); return; }
          try {
            await api("/api/core/memories/" + encodeURIComponent(memory.id), {
              method: "PATCH",
              body: JSON.stringify({ archived: !memory.archived })
            });
            toast(memory.archived ? "Memory restored to active Garden." : "Memory archived.");
            await loadMemories();
          } catch (error) { toast(error.message); }
        }
      };
      const forget = {
        label: "Forget",
        onClick: async () => {
          if (!navigator.onLine) { toast("Cannot delete memories while offline."); return; }
          if (!confirm("Forget this Garden entry?")) return;
          try {
            await api("/api/core/memories/" + encodeURIComponent(memory.id), { method: "DELETE", body: "{}" });
            await loadMemories();
          } catch (error) { toast(error.message); }
        }
      };
      const itemEl = createItem(memory.title || memory.text, meta, [edit, archiveToggle, forget]);
      if (isHighPriority) itemEl.classList.add("high-priority-memory");
      if (memory.archived || memory.expired) itemEl.classList.add("archived-memory");
      host.appendChild(itemEl);
    }
    if (!list.length) {
      if (gardenImportanceFilter !== null) {
        host.textContent = `No memories with importance score ${gardenImportanceFilter} found.`;
      } else if (kindFilter !== "all") {
        host.textContent = `No ${MEMORY_KIND_LABELS[kindFilter] || kindFilter} memories found.`;
      } else {
        host.textContent = query ? "No matching memories found." : "No memories planted yet.";
      }
    }
  }

  function handleScoreSelect(score) {
    if (gardenImportanceFilter === score) {
      gardenImportanceFilter = null;
      toast("Cleared importance score filter.");
    } else {
      gardenImportanceFilter = score;
      toast(`Filtered memories with importance score ${score}.`);
    }
    const dist = calculateImportanceDistribution(lastGardenMemories);
    renderGardenRechartsBarChart($("#garden-recharts-root"), dist, handleScoreSelect, gardenImportanceFilter);
    renderMemoryItems(lastGardenMemories);
  }

  try {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (kindFilter && kindFilter !== "all") params.set("kind", kindFilter);
    if (includeArchived) {
      params.set("includeArchived", "true");
      params.set("includeExpired", "true");
    }
    const qs = params.toString();
    const payload = await api("/api/core/memories" + (qs ? "?" + qs : ""));
    const memories = payload.memories || [];
    lastGardenMemories = memories;
    try {
      localStorage.setItem("alfie_cached_memories", JSON.stringify(memories));
      localStorage.setItem("alfie_cached_memories_time", String(Date.now()));
    } catch {}
    updateGardenStats(memories);
    const distribution = calculateImportanceDistribution(memories);
    renderGardenRechartsBarChart($("#garden-recharts-root"), distribution, handleScoreSelect, gardenImportanceFilter);
    renderMemoryItems(memories, Boolean(payload.offline));
  } catch (error) {
    try {
      const cached = localStorage.getItem("alfie_cached_memories");
      if (cached) {
        const memories = JSON.parse(cached);
        lastGardenMemories = memories;
        updateGardenStats(memories);
        const distribution = calculateImportanceDistribution(memories);
        renderGardenRechartsBarChart($("#garden-recharts-root"), distribution, handleScoreSelect, gardenImportanceFilter);
        renderMemoryItems(memories, true);
        return;
      }
    } catch {}
    if (banner) banner.hidden = false;
    host.textContent = "Offline — no cached memories available yet.";
  }
}

$("#clear-score-filter")?.addEventListener("click", () => {
  gardenImportanceFilter = null;
  toast("Cleared importance score filter.");
  loadMemories();
});

$("#memory-kind-tabs")?.addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-memory-kind]");
  if (!btn) return;
  state.memoryKindFilter = btn.dataset.memoryKind || "all";
  $("#memory-kind-tabs").querySelectorAll("button[data-memory-kind]").forEach((tab) => {
    const active = tab === btn;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  loadMemories();
});

$("#memory-show-archived")?.addEventListener("change", (event) => {
  state.memoryIncludeArchived = Boolean(event.currentTarget.checked);
  loadMemories();
});

$("#memory-kind-select")?.addEventListener("change", (event) => {
  const ttlSelect = $("#memory-ttl-select");
  if (!ttlSelect) return;
  if (event.currentTarget.value === "temporary" && !ttlSelect.value) {
    ttlSelect.value = "24";
  }
});

$("#refresh-memories").addEventListener("click", loadMemories);
$("#memory-search").addEventListener("input", () => {
  clearTimeout(loadMemories.timer);
  loadMemories.timer = setTimeout(loadMemories, 250);
});
$("#memory-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formEl = event.currentTarget;
  const text = formEl.elements.text.value.trim();
  const importance = Number(formEl.elements.importance.value || 5);
  const kind = formEl.elements.kind?.value || "note";
  const ttlRaw = formEl.elements.ttlHours?.value || "";
  if (!text) return;
  try {
    const body = { text, importance, origin: "user-seeded", source: "user", type: kind, kind };
    if (ttlRaw) body.ttlHours = Number(ttlRaw);
    await api("/api/core/memories", { method: "POST", body: JSON.stringify(body) });
    formEl.reset();
    await Promise.all([loadMemories(), loadKnowledgeGraph()]);
    toast("Memory planted in the Garden.");
  } catch (error) { toast(error.message); }
});

const WATCHER_KIND_LABELS = {
  project_stall: "Project stall",
  vram_threshold: "GPU VRAM",
  push_metric: "Push metric",
  http_probe: "HTTP probe"
};

const ATTENTION_TIER_LABELS = {
  urgent: "Urgent",
  notify: "Notify",
  digest: "Digest",
  quiet_log: "Quiet log"
};

function renderWatcherConfigFields() {
  const host = $("#watcher-config-fields");
  const kind = $("#watcher-kind-select")?.value || "project_stall";
  if (!host) return;
  host.replaceChildren();

  function addField(labelText, inputEl) {
    const label = document.createElement("label");
    label.textContent = labelText;
    label.appendChild(inputEl);
    host.appendChild(label);
  }

  if (kind === "project_stall") {
    const days = document.createElement("input");
    days.type = "number";
    days.name = "staleDays";
    days.min = "1";
    days.max = "90";
    days.value = "7";
    addField("Stale threshold (days)", days);

    const projSelect = document.createElement("select");
    projSelect.name = "projectId";
    const allOpt = document.createElement("option");
    allOpt.value = "";
    allOpt.textContent = "All active projects";
    projSelect.appendChild(allOpt);
    for (const p of state.projects) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      projSelect.appendChild(opt);
    }
    addField("Target project", projSelect);
  } else if (kind === "vram_threshold") {
    const threshold = document.createElement("input");
    threshold.type = "number";
    threshold.name = "thresholdPercent";
    threshold.min = "50";
    threshold.max = "99";
    threshold.value = "80";
    addField("VRAM alert threshold (%)", threshold);
  } else if (kind === "push_metric") {
    const metric = document.createElement("input");
    metric.name = "metricName";
    metric.placeholder = "e.g. backup_age_hours";
    metric.required = true;
    addField("Metric name", metric);

    const op = document.createElement("select");
    op.name = "operator";
    for (const [val, text] of [["gte", "≥ (at or above)"], ["gt", "> (above)"], ["lte", "≤ (at or below)"], ["lt", "< (below)"], ["eq", "= (equals)"]]) {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = text;
      op.appendChild(opt);
    }
    addField("Condition", op);

    const threshold = document.createElement("input");
    threshold.type = "number";
    threshold.name = "threshold";
    threshold.step = "any";
    threshold.value = "24";
    threshold.required = true;
    addField("Threshold value", threshold);

    const unit = document.createElement("input");
    unit.name = "unit";
    unit.placeholder = "e.g. hrs, %, GB";
    unit.maxLength = 16;
    addField("Unit (optional)", unit);
  } else if (kind === "http_probe") {
    const urlInput = document.createElement("input");
    urlInput.type = "url";
    urlInput.name = "url";
    urlInput.placeholder = "https://status.example.com/health";
    urlInput.required = true;
    addField("Public HTTPS/HTTP URL", urlInput);

    const status = document.createElement("input");
    status.type = "number";
    status.name = "expectedStatus";
    status.min = "100";
    status.max = "599";
    status.value = "200";
    addField("Expected HTTP status", status);
  }
}

function renderWatchers() {
  const watcherHost = $("#watcher-list");
  const eventHost = $("#watcher-event-list");
  if (!watcherHost || !eventHost) return;
  watcherHost.replaceChildren();
  eventHost.replaceChildren();

  for (const watcher of (state.watchers || [])) {
    const kindLabel = WATCHER_KIND_LABELS[watcher.kind] || watcher.kind;
    const tierLabel = ATTENTION_TIER_LABELS[watcher.tier] || watcher.tier;
    const statusLabel = watcher.enabled
      ? (watcher.lastStatus === "alert" ? "Alert" : watcher.lastStatus === "ok" ? "Nominal" : "Ready")
      : "Paused";
    const trustLabel = watcher.lastTrust === "external_untrusted" ? "External untrusted" : "System verified";
    const quietLabel = watcher.quietHours?.enabled
      ? `Quiet ${watcher.quietHours.start || "22:00"}–${watcher.quietHours.end || "07:00"} (${watcher.quietHours.timezone || "UTC"})`
      : "";
    const checkedLabel = watcher.lastCheckedAt ? "Checked " + new Date(watcher.lastCheckedAt).toLocaleTimeString() : "Never checked";
    const summaryText = watcher.lastSummary ? ` — ${watcher.lastSummary}` : "";
    const meta = [kindLabel, tierLabel, statusLabel, trustLabel, quietLabel, checkedLabel].filter(Boolean).join(" · ") + summaryText;

    const actions = [];
    let pushRow = null;
    if (watcher.kind === "push_metric") {
      actions.push({
        label: "Push reading",
        kind: "primary-button",
        onClick: () => {
          if (!pushRow) return;
          pushRow.hidden = !pushRow.hidden;
          if (!pushRow.hidden) {
            pushRow.querySelector("input")?.focus();
          }
        }
      });
    } else {
      actions.push({
        label: "Run check",
        kind: "primary-button",
        onClick: async () => {
          try {
            const res = await api(`/api/core/watchers/${encodeURIComponent(watcher.id)}/check`, { method: "POST", body: "{}" });
            toast(`${watcher.name}: ${res.event?.severity === "alert" ? (ATTENTION_TIER_LABELS[res.event?.tier] || "Alert") : "Nominal"}`);
            await loadWatchers();
          } catch (error) { toast(error.message); }
        }
      });
    }
    actions.push({
      label: watcher.enabled ? "Pause" : "Resume",
      onClick: async () => {
        try {
          await api(`/api/core/watchers/${encodeURIComponent(watcher.id)}`, {
            method: "PATCH",
            body: JSON.stringify({ enabled: !watcher.enabled })
          });
          await loadWatchers();
        } catch (error) { toast(error.message); }
      }
    });
    actions.push({
      label: "Delete",
      onClick: async (event) => {
        const btn = event?.currentTarget;
        if (btn && btn.dataset.confirmDelete !== "true") {
          btn.dataset.confirmDelete = "true";
          btn.textContent = "Confirm delete";
          btn.classList.add("danger-button");
          setTimeout(() => {
            if (btn.isConnected && btn.dataset.confirmDelete === "true") {
              delete btn.dataset.confirmDelete;
              btn.textContent = "Delete";
              btn.classList.remove("danger-button");
            }
          }, 4000);
          return;
        }
        try {
          await api(`/api/core/watchers/${encodeURIComponent(watcher.id)}`, { method: "DELETE", body: "{}" });
          toast("Watcher deleted.");
          await loadWatchers();
        } catch (error) { toast(error.message); }
      }
    });
    const itemEl = createItem(watcher.name, meta, actions);
    if (watcher.kind === "push_metric") {
      pushRow = document.createElement("form");
      pushRow.className = "watcher-push-inline";
      pushRow.hidden = true;
      const numInput = document.createElement("input");
      numInput.type = "number";
      numInput.step = "any";
      numInput.required = true;
      numInput.value = String(watcher.config?.threshold ?? 80);
      numInput.setAttribute("aria-label", `Metric value for ${watcher.name}`);
      const sendBtn = document.createElement("button");
      sendBtn.type = "submit";
      sendBtn.className = "primary-button";
      sendBtn.textContent = "Send reading";
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "secondary-button";
      cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", () => { pushRow.hidden = true; });
      pushRow.append(numInput, sendBtn, cancelBtn);
      pushRow.addEventListener("submit", async (e) => {
        e.preventDefault();
        const value = Number(numInput.value);
        if (!Number.isFinite(value)) { toast("Enter a valid number."); return; }
        try {
          const res = await api(`/api/core/watchers/${encodeURIComponent(watcher.id)}/ingest`, {
            method: "POST",
            body: JSON.stringify({ value })
          });
          toast(`${watcher.name}: ${ATTENTION_TIER_LABELS[res.event?.tier] || "Logged"}`);
          await loadWatchers();
        } catch (error) { toast(error.message); }
      });
      itemEl.classList.add("has-inline-push");
      itemEl.appendChild(pushRow);
    }
    watcherHost.appendChild(itemEl);
  }
  if (!state.watchers?.length) {
    watcherHost.textContent = "No watchers configured yet. Add one above to monitor projects, VRAM, metrics, or public endpoints.";
  }

  const tierFilter = state.watcherEventTierFilter || "all";
  const filteredEvents = (state.watcherEvents || []).filter((ev) => tierFilter === "all" || ev.tier === tierFilter);
  for (const event of filteredEvents) {
    const tierLabel = ATTENTION_TIER_LABELS[event.tier] || event.tier;
    const trustLabel = event.trust === "external_untrusted" ? "External untrusted" : "System verified";
    const meta = [
      tierLabel,
      event.suppressed ? "Cooldown deduplicated" : (event.severity === "alert" ? "Alert" : "Nominal"),
      trustLabel,
      event.createdAt ? new Date(event.createdAt).toLocaleString() : ""
    ].filter(Boolean).join(" · ");
    const actions = [];
    if (!event.acknowledged) {
      actions.push({
        label: "Acknowledge",
        onClick: async () => {
          try {
            await api(`/api/core/watchers/events/${encodeURIComponent(event.id)}/ack`, { method: "POST", body: "{}" });
            await loadWatchers();
          } catch (error) { toast(error.message); }
        }
      });
    }
    const itemEl = createItem(`${event.watcherName}: ${event.summary}`, meta, actions);
    if (event.tier === "urgent") itemEl.classList.add("watcher-event-urgent");
    else if (event.tier === "notify") itemEl.classList.add("watcher-event-notify");
    else if (event.tier === "digest") itemEl.classList.add("watcher-event-digest");
    if (event.acknowledged) itemEl.classList.add("watcher-event-ack");
    eventHost.appendChild(itemEl);
  }
  if (!filteredEvents.length) {
    eventHost.textContent = tierFilter === "all"
      ? "No watcher events recorded yet. Run a check to populate the Attention Feed."
      : `No ${ATTENTION_TIER_LABELS[tierFilter] || tierFilter} events recorded.`;
  }
}

async function loadWatchers() {
  try {
    const [wRes, eRes] = await Promise.all([
      api("/api/core/watchers"),
      api("/api/core/watchers/events?limit=40")
    ]);
    state.watchers = wRes.watchers || [];
    state.watcherEvents = eRes.events || [];
    renderWatchers();
  } catch (error) {
    const host = $("#watcher-list");
    if (host) host.textContent = error.message || "Watchers unavailable.";
  }
}

function syncWatcherQuietControls() {
  const enabled = Boolean($("#watcher-quiet-enabled")?.checked);
  const startEl = $("#watcher-quiet-start");
  const endEl = $("#watcher-quiet-end");
  const tzEl = $("#watcher-quiet-timezone");
  const customWrap = $("#watcher-quiet-custom-tz-wrap");
  const customInput = $("#watcher-quiet-custom-tz");
  if (startEl) startEl.disabled = !enabled;
  if (endEl) endEl.disabled = !enabled;
  if (tzEl) tzEl.disabled = !enabled;
  const useCustom = enabled && tzEl?.value === "__custom__";
  if (customWrap) customWrap.hidden = !useCustom;
  if (customInput) {
    customInput.disabled = !useCustom;
    customInput.required = useCustom;
  }
}

function initWatchers() {
  renderWatcherConfigFields();
  syncWatcherQuietControls();
  $("#watcher-kind-select")?.addEventListener("change", renderWatcherConfigFields);
  $("#watcher-quiet-enabled")?.addEventListener("change", syncWatcherQuietControls);
  $("#watcher-quiet-timezone")?.addEventListener("change", syncWatcherQuietControls);
  $("#refresh-watchers")?.addEventListener("click", loadWatchers);

  $("#watcher-event-tabs")?.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-watcher-tier]");
    if (!btn) return;
    state.watcherEventTierFilter = btn.dataset.watcherTier || "all";
    $("#watcher-event-tabs").querySelectorAll("button[data-watcher-tier]").forEach((tab) => {
      const active = tab === btn;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    renderWatchers();
  });

  $("#watcher-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formEl = event.currentTarget;
    const name = (formEl.elements.name?.value || "").trim();
    const kind = formEl.elements.kind?.value || "project_stall";
    const tier = formEl.elements.tier?.value || "notify";
    const cooldownMinutes = Number(formEl.elements.cooldownMinutes?.value ?? 30);
    if (!name) return;

    const config = {};
    if (kind === "project_stall") {
      config.staleDays = Number(formEl.elements.staleDays?.value || 7);
      if (formEl.elements.projectId?.value) config.projectId = formEl.elements.projectId.value;
    } else if (kind === "vram_threshold") {
      config.thresholdPercent = Number(formEl.elements.thresholdPercent?.value || 80);
    } else if (kind === "push_metric") {
      config.metricName = (formEl.elements.metricName?.value || "").trim();
      config.operator = formEl.elements.operator?.value || "gte";
      config.threshold = Number(formEl.elements.threshold?.value ?? 80);
      config.unit = (formEl.elements.unit?.value || "").trim();
    } else if (kind === "http_probe") {
      config.url = (formEl.elements.url?.value || "").trim();
      config.expectedStatus = Number(formEl.elements.expectedStatus?.value || 200);
    }

    const quietEnabled = Boolean(formEl.elements.quietEnabled?.checked);
    const rawTz = formEl.elements.quietTimezone?.value || "UTC";
    const timezone = rawTz === "__custom__"
      ? (formEl.elements.quietCustomTimezone?.value || "").trim()
      : rawTz;
    const quietHours = quietEnabled
      ? {
          enabled: true,
          start: (formEl.elements.quietStart?.value || "22:00").trim(),
          end: (formEl.elements.quietEnd?.value || "07:00").trim(),
          timezone: timezone || "UTC"
        }
      : { enabled: false, timezone: "UTC" };

    try {
      await api("/api/core/watchers", {
        method: "POST",
        body: JSON.stringify({ name, kind, tier, cooldownMinutes, config, quietHours })
      });
      formEl.reset();
      renderWatcherConfigFields();
      syncWatcherQuietControls();
      toast(`Watcher "${name}" created.`);
      await loadWatchers();
    } catch (error) {
      toast(error.message || "Could not create watcher.");
    }
  });
}

async function loadToolsAndApprovals(focusActionId = null) {
  const toolsHost = $("#tool-list");
  const pendingHost = $("#pending-list");
  const receiptHost = $("#receipt-list");
  const auditHost = $("#audit-list");
  toolsHost.replaceChildren();
  pendingHost.replaceChildren();
  if (receiptHost) receiptHost.replaceChildren();
  auditHost.replaceChildren();
  try {
    const [tools, permissions, pending, receiptsRes, audit] = await Promise.all([
      api("/api/core/tools"),
      api("/api/core/permissions"),
      api("/api/core/tools/pending"),
      api("/api/core/tools/receipts?limit=12").catch(() => ({ receipts: [] })),
      api("/api/core/audit?limit=30")
    ]);
    const leasesByScope = new Map();
    for (const lease of (permissions.leases || [])) {
      if (!leasesByScope.has(lease.scope)) leasesByScope.set(lease.scope, []);
      leasesByScope.get(lease.scope).push(lease);
    }
    const projectNameById = new Map((state.projects || []).map((p) => [p.id, p.name]));
    const groups = new Map();
    for (const tool of (tools.tools || [])) {
      if (!groups.has(tool.scope)) groups.set(tool.scope, []);
      groups.get(tool.scope).push(tool);
    }
    for (const [scope, scopedTools] of groups) {
      const scopeLeases = leasesByScope.get(scope) || [];
      const hasGrants = scopeLeases.length > 0;
      const names = scopedTools.map((tool) => tool.name || tool.id).join(", ");
      const summaryParts = [
        hasGrants
          ? `${scopeLeases.length} active ${scopeLeases.length === 1 ? "lease" : "leases"}`
          : "Not granted",
        scopedTools.length + " tool(s): " + names
      ];
      const scopeActions = [
        {
          label: hasGrants ? "Add grant" : "Allow",
          kind: hasGrants ? "secondary-button" : "primary-button",
          onClick: async () => {
            try {
              const ttlRaw = $("#permission-lease-ttl")?.value || "";
              const projRaw = $("#permission-lease-project")?.value || "";
              const payload = { scope };
              if (ttlRaw) payload.ttlMinutes = Number(ttlRaw);
              if (projRaw) payload.projectId = projRaw;
              await api("/api/core/permissions", { method: "POST", body: JSON.stringify(payload) });
              toast(`Granted ${scope}${projRaw ? " for project" : " globally"}.`);
              await loadToolsAndApprovals();
            } catch (error) { toast(error.message); }
          }
        }
      ];
      if (scopeLeases.length > 1) {
        scopeActions.push({
          label: "Revoke all",
          kind: "secondary-button",
          onClick: async () => {
            try {
              await api("/api/core/permissions", { method: "DELETE", body: JSON.stringify({ scope }) });
              toast(`Revoked all grants for ${scope}.`);
              await loadToolsAndApprovals();
            } catch (error) { toast(error.message); }
          }
        });
      }

      const scopeItem = createItem(scope, summaryParts.join(" · "), scopeActions);
      scopeItem.classList.add("tools-scope-item", hasGrants ? "is-granted" : "is-revoked");
      scopeItem.dataset.scopeSearch = `${scope} ${names}`.toLowerCase();
      if (scopeLeases.length) {
        scopeItem.classList.add("has-lease-list");
        const leaseList = document.createElement("div");
        leaseList.className = "scope-lease-list";
        leaseList.setAttribute("role", "list");
        leaseList.setAttribute("aria-label", `Active capability leases for ${scope}`);
        for (const lease of scopeLeases) {
          const row = document.createElement("div");
          row.className = "scope-lease-row";
          row.setAttribute("role", "listitem");

          const scopeLabel = lease.projectId
            ? `Project: ${projectNameById.get(lease.projectId) || lease.projectId.slice(0, 8)}`
            : "Global (all projects)";
          const expiryLabel = lease.expiresAt ? formatShortExpiry(lease.expiresAt) : "Permanent";
          const detailText = [scopeLabel, expiryLabel, lease.note || ""].filter(Boolean).join(" · ");

          const info = document.createElement("span");
          info.className = "scope-lease-meta";
          info.textContent = detailText;

          const revokeBtn = document.createElement("button");
          revokeBtn.type = "button";
          revokeBtn.className = "secondary-button scope-lease-revoke-btn";
          revokeBtn.textContent = "Revoke";
          revokeBtn.setAttribute("aria-label", `Revoke ${scope} ${scopeLabel}`);
          revokeBtn.addEventListener("click", async () => {
            try {
              await api("/api/core/permissions", {
                method: "DELETE",
                body: JSON.stringify({ scope, projectId: lease.projectId ?? null })
              });
              toast(`Revoked ${scope} (${lease.projectId ? "project lease" : "global lease"}).`);
              await loadToolsAndApprovals();
            } catch (error) { toast(error.message); }
          });

          row.append(info, revokeBtn);
          leaseList.appendChild(row);
        }
        scopeItem.appendChild(leaseList);
      }
      toolsHost.appendChild(scopeItem);
    }
    if (!tools.tools?.length) toolsHost.textContent = "No registered tools.";
    for (const action of (pending.actions || [])) {
      let itemEl = null;
      const approve = {
        label: "Approve & continue",
        kind: "primary-button",
        onClick: async () => {
          await approvePendingActionAndContinue(action.id, {
            toolId: action.toolId,
            summary: action.preview || "",
            cardElement: itemEl
          });
        }
      };
      const reject = {
        label: "Reject",
        onClick: async () => {
          await rejectPendingAction(action.id, { cardElement: itemEl });
        }
      };
      itemEl = createItem(action.toolId, action.preview || "Waiting for your decision.", [reject, approve]);
      itemEl.dataset.actionId = action.id;
      if (action.reason) {
        const reason = document.createElement("p");
        reason.className = "pending-action-reason";
        reason.textContent = `Why approval is needed: ${action.reason}`;
        itemEl.appendChild(reason);
      }
      if (action.id === focusActionId) itemEl.classList.add("pending-action-focused");
      if (action.simulation) {
        const sim = action.simulation;
        const simBox = document.createElement("div");
        simBox.className = `simulation-preview risk-${sim.riskLevel || "medium"}`;
        const simLines = [
          ["Dry-run risk", `${String(sim.riskLevel || "medium").toUpperCase()}${sim.backupRequired ? " · Backup recommended" : ""}`],
          ["Affected", sim.affectedResource || action.toolId],
          ...(sim.dependencies?.length ? [["Dependencies", sim.dependencies.join("; ")]] : []),
          ["Rollback plan", sim.rollbackPlan || "Manual review"],
          ...(sim.validationSteps?.length ? [["Verification", sim.validationSteps.join(" → ")]] : [])
        ];
        for (const [label, val] of simLines) {
          const row = document.createElement("div");
          row.className = "simulation-row";
          const k = document.createElement("span");
          k.className = "simulation-key";
          k.textContent = label;
          const v = document.createElement("span");
          v.className = "simulation-val";
          v.textContent = val;
          row.append(k, v);
          simBox.appendChild(row);
        }
        itemEl.classList.add("has-simulation");
        itemEl.appendChild(simBox);
      }
      pendingHost.appendChild(itemEl);
    }
    if (!pending.actions?.length) pendingHost.textContent = "Nothing is waiting for approval.";
    if (focusActionId) {
      const target = [...pendingHost.querySelectorAll("[data-action-id]")].find((item) => item.dataset.actionId === focusActionId);
      if (target) {
        requestAnimationFrame(() => target.scrollIntoView({ behavior: "smooth", block: "center" }));
      } else {
        toast("That approval is no longer pending. Refreshing the current list.");
      }
    }

    state.receipts = receiptsRes.receipts || [];
    if (receiptHost) {
      for (const receipt of state.receipts.slice(0, 8)) {
        const vState = receipt.verificationState || (receipt.status === "failed" ? "execution_failed" : (receipt.verified ? "verified" : "unverified"));
        const statusLabel = vState === "execution_failed"
          ? "Execution failed"
          : (vState === "verification_failed"
            ? "Verification failed"
            : (vState === "verified" ? "Verified" : "Completed (unverified)"));
        const meta = [
          statusLabel,
          `${String(receipt.riskLevel || "medium").toUpperCase()} risk`,
          receipt.affectedResource || receipt.toolId,
          receipt.executedAt ? new Date(receipt.executedAt).toLocaleTimeString() : ""
        ].filter(Boolean).join(" · ") + (receipt.verificationDetail ? ` — ${receipt.verificationDetail}` : "");
        const receiptEl = createItem(receipt.toolName || receipt.toolId, meta);
        if (vState === "verified") receiptEl.classList.add("receipt-verified");
        else if (vState === "execution_failed" || vState === "verification_failed") receiptEl.classList.add("receipt-failed");
        receiptHost.appendChild(receiptEl);
      }
      if (!state.receipts.length) {
        receiptHost.textContent = "No executed action receipts yet. Approved changes record a verification receipt here.";
      }
    }

    for (const event of (audit.events || [])) {
      auditHost.appendChild(createItem(event.event, [event.toolId, event.status, event.at ? new Date(event.at).toLocaleString() : ""].filter(Boolean).join(" · ")));
    }
    if (!audit.events?.length) auditHost.textContent = "No recent actions.";

    state.toolsSummaryCounts = {
      totalScopes: groups.size,
      grantedScopes: [...groups.keys()].filter((scope) => (leasesByScope.get(scope) || []).length > 0).length,
      activeLeases: (permissions.leases || []).length,
      pendingApprovals: (pending.actions || []).length
    };
    if (focusActionId) setToolsTab("permissions");
    applyToolScopeFilter();
    updateToolsSummaryStrip();

    await Promise.all([
      loadCloudAgents(),
      loadProvidersPanel().catch(() => {}),
      loadWatchers(),
      loadCapsules(),
      loadWorkshop(),
      loadIntegrations(),
      loadPlaybooks(),
      loadPeerTokens()
    ]);
    updateToolsSummaryStrip();
  } catch (error) {
    toolsHost.textContent = error.message;
    pendingHost.textContent = "Approval history unavailable.";
    auditHost.textContent = "Activity history unavailable.";
  }
}

async function loadSettings() {
  const account = $("#account-status");
  const core = $("#core-status");
  if (account) account.textContent = "Checking…";
  if (core) core.replaceChildren();
  try {
    const [who, status] = await Promise.all([
      api("/api/core/whoami"), api("/api/core/status")
    ]);
    if (account) account.textContent = who.linked ? "Linked to your Petrio account · " + who.userId : "Not linked";
    if (core) core.textContent = (status.implemented || []).length + " capabilities active · " + (status.planned || []).length + " planned";
    await Promise.all([
      loadProvidersPanel(),
      refreshVramStatus(),
      loadCloudAgents(),
      loadWorkflowProfile(),
      loadStorageStatus(),
      loadVoiceAndAmbientStatus(),
      loadRecoveryStatus(),
      loadDiagnosticsAudit()
    ]);
  } catch (error) {
    if (account) account.textContent = error.message;
    if (core) core.textContent = "Core status unavailable.";
  }
}

// ── Adaptive Working Mode Selector ──
const WORKING_MODE_DESCRIPTIONS = {
  companion: "Balanced personal collaborator—clear, grounded, concise, and attentive to your active project and preferences.",
  engineer: "Concrete technical execution—architecture trade-offs, edge cases, invariants, verification steps, and minimal diffs.",
  investigator: "Root-cause debugging and systems forensics—hypotheses ranked by likelihood, evidence needed, and isolation steps.",
  researcher: "Structured synthesis—compare options, cite assumptions, highlight unknowns, and summarize trade-offs cleanly.",
  planner: "Phased roadmaps, milestones, dependencies, blockers, and realistic scope sequencing.",
  "thinking-partner": "Socratic sparring—challenge assumptions gently, expose blind spots, and explore second-order consequences.",
  creator: "Divergent ideation, visual/writing craft, naming, and expressive exploration without premature filtering.",
  tutor: "Learning-first scaffolding—explain concepts clearly, build intuition step by step, and invite active attempts."
};

function syncWorkingModeTooltip(select) {
  if (!select) return;
  const id = select.value || "companion";
  const label = select.options[select.selectedIndex]?.textContent || id;
  const desc = WORKING_MODE_DESCRIPTIONS[id] || "";
  select.title = desc ? `${label}: ${desc}` : `Working posture: ${label}`;
}

function initWorkingModeSelector() {
  const select = $("#working-mode-select");
  if (!select) return;
  const saved = state.workingMode || "companion";
  if ([...select.options].some((opt) => opt.value === saved)) {
    select.value = saved;
  } else {
    state.workingMode = "companion";
    select.value = "companion";
  }
  syncWorkingModeTooltip(select);
  select.addEventListener("change", () => {
    const next = select.value || "companion";
    state.workingMode = next;
    try { localStorage.setItem("alfie:workingMode", next); } catch {}
    syncWorkingModeTooltip(select);
    const label = select.options[select.selectedIndex]?.textContent || next;
    toast("Working posture: " + label);
  });
}

// ── Ideas Vault Controller ──
const IDEA_STATUS_LABELS = {
  inbox: "Inbox",
  active: "Active",
  parked: "Parked",
  promoted: "Promoted",
  archived: "Archived"
};

const IDEA_PRIORITY_LABELS = {
  high: "High priority",
  medium: "Medium priority",
  low: "Low priority"
};

function toggleIdeaTagFilter(tag) {
  const clean = String(tag || "").trim().toLowerCase().replace(/^#+/, "");
  if (!clean) return;
  state.ideaTagFilter = state.ideaTagFilter === clean ? "" : clean;
  loadIdeas();
}

function resetIdeaFilters() {
  state.ideaStatusFilter = "all";
  state.ideaProjectFilter = "all";
  state.ideaTagFilter = "";
  const searchEl = $("#idea-search");
  if (searchEl) searchEl.value = "";
  const projFilter = $("#idea-project-filter");
  if (projFilter) projFilter.value = "all";
  const tabsHost = $("#idea-status-tabs");
  if (tabsHost) {
    tabsHost.querySelectorAll("button[data-idea-status]").forEach((tab) => {
      const isAll = tab.dataset.ideaStatus === "all";
      tab.classList.toggle("active", isAll);
      tab.setAttribute("aria-selected", String(isAll));
    });
  }
  loadIdeas();
}

function exploreIdeaInChat(idea) {
  if (!idea) return;
  if (idea.projectId && state.projects.some((p) => p.id === idea.projectId)) {
    state.selectedProjectId = idea.projectId;
    renderProjects();
    renderConversations(state.conversations);
  }
  setView("chat");
  const input = $("#chat-form")?.elements?.message;
  if (input) {
    const promptLines = [`Let's think through this idea from my Ideas Vault: "${idea.title}"`];
    if (idea.body) promptLines.push("", idea.body);
    input.value = promptLines.join("\n");
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 180) + "px";
    input.focus();
    if (typeof input.setSelectionRange === "function") {
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
  toast("Loaded idea into chat composer.");
}

function renderIdeaTagFilters() {
  const host = $("#idea-tag-filters");
  if (!host) return;
  host.replaceChildren();

  const tags = Array.isArray(state.ideaTags) ? state.ideaTags : [];
  const activeTag = state.ideaTagFilter || "";
  if (!tags.length && !activeTag) {
    host.hidden = true;
    return;
  }

  host.hidden = false;
  const label = document.createElement("span");
  label.className = "idea-tag-filters-label";
  label.textContent = "Hashtags";
  host.appendChild(label);

  const items = [...tags];
  if (activeTag && !items.some((item) => item.tag === activeTag)) {
    items.unshift({ tag: activeTag, count: 0 });
  }

  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    const isActive = activeTag === item.tag;
    btn.className = "idea-tag-filter-btn" + (isActive ? " active" : "");
    btn.dataset.ideaTag = item.tag;
    btn.setAttribute("aria-pressed", String(isActive));

    const tagText = document.createElement("span");
    tagText.textContent = "#" + item.tag;
    const count = document.createElement("span");
    count.className = "idea-tag-count";
    count.textContent = String(item.count);
    btn.append(tagText, count);

    btn.addEventListener("click", () => toggleIdeaTagFilter(item.tag));
    host.appendChild(btn);
  }

  if (activeTag) {
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "idea-tag-clear-btn";
    clearBtn.textContent = "Clear #" + activeTag;
    clearBtn.addEventListener("click", () => {
      state.ideaTagFilter = "";
      loadIdeas();
    });
    host.appendChild(clearBtn);
  }
}

function createIdeaInlineEditForm(idea) {
  const form = document.createElement("form");
  form.className = "idea-edit-form";
  form.setAttribute("aria-label", "Edit idea " + (idea.title || ""));

  const row = document.createElement("div");
  row.className = "idea-edit-row";

  const titleLabel = document.createElement("label");
  titleLabel.textContent = "Idea";
  const titleInput = document.createElement("input");
  titleInput.name = "title";
  titleInput.maxLength = 160;
  titleInput.required = true;
  titleInput.value = idea.title || "";
  titleLabel.appendChild(titleInput);

  const priorityLabel = document.createElement("label");
  priorityLabel.textContent = "Priority";
  const prioritySelect = document.createElement("select");
  prioritySelect.name = "priority";
  for (const [val, text] of [["high", "High"], ["medium", "Medium"], ["low", "Low"]]) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = text;
    if ((idea.priority || "medium") === val) opt.selected = true;
    prioritySelect.appendChild(opt);
  }
  priorityLabel.appendChild(prioritySelect);

  const projectLabel = document.createElement("label");
  projectLabel.textContent = "Project";
  const projectSelect = document.createElement("select");
  projectSelect.name = "projectId";
  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "Unlinked";
  projectSelect.appendChild(noneOpt);
  for (const proj of state.projects || []) {
    const opt = document.createElement("option");
    opt.value = proj.id;
    opt.textContent = proj.name;
    if (idea.projectId === proj.id) opt.selected = true;
    projectSelect.appendChild(opt);
  }
  projectLabel.appendChild(projectSelect);

  row.append(titleLabel, priorityLabel, projectLabel);

  const bodyLabel = document.createElement("label");
  bodyLabel.textContent = "Notes & #hashtags";
  const bodyInput = document.createElement("textarea");
  bodyInput.name = "body";
  bodyInput.rows = 3;
  bodyInput.maxLength = 4000;
  bodyInput.placeholder = "Add context, details, or #hashtags…";
  bodyInput.value = idea.body || "";
  bodyLabel.appendChild(bodyInput);

  const actions = document.createElement("div");
  actions.className = "idea-edit-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "secondary-button";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => {
    state.editingIdeaId = null;
    renderIdeas();
  });

  const saveBtn = document.createElement("button");
  saveBtn.type = "submit";
  saveBtn.className = "primary-button";
  saveBtn.textContent = "Save changes";

  actions.append(cancelBtn, saveBtn);
  form.append(row, bodyLabel, actions);

  form.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      state.editingIdeaId = null;
      renderIdeas();
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const nextTitle = titleInput.value.trim();
    if (!nextTitle) return;
    saveBtn.disabled = true;
    try {
      await api("/api/core/ideas/" + encodeURIComponent(idea.id), {
        method: "PATCH",
        body: JSON.stringify({
          title: nextTitle,
          body: bodyInput.value.trim(),
          priority: prioritySelect.value,
          projectId: projectSelect.value || null
        })
      });
      state.editingIdeaId = null;
      toast("Idea updated.");
      await loadIdeas();
    } catch (error) {
      toast(error.message || "Could not update idea.");
      saveBtn.disabled = false;
    }
  });

  return form;
}

function renderIdeas() {
  const host = $("#idea-list");
  if (!host) return;
  host.replaceChildren();
  renderIdeaTagFilters();

  const ideas = Array.isArray(state.ideas) ? state.ideas : [];
  if (!ideas.length) {
    const empty = document.createElement("div");
    empty.className = "idea-empty-state";
    const filter = state.ideaStatusFilter || "all";
    const projFilter = state.ideaProjectFilter || "all";
    const activeTag = state.ideaTagFilter || "";
    const q = ($("#idea-search")?.value || "").trim();
    const hasFilters = Boolean(activeTag || q || filter !== "all" || projFilter !== "all");

    const msg = document.createElement("p");
    msg.style.margin = "0";
    msg.textContent = activeTag
      ? "No ideas tagged #" + activeTag + (filter !== "all" ? " in " + filter : "") + "."
      : q
        ? "No ideas match \"" + q + "\"."
        : projFilter !== "all"
          ? "No ideas found for this project filter."
          : filter !== "all"
            ? "No " + filter + " ideas yet. Capture one above or type /idea in chat."
            : "Your Ideas Vault is clear. Park a rough thought above or type /idea in chat.";
    empty.appendChild(msg);

    if (hasFilters) {
      const clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "secondary-button";
      clearBtn.textContent = "Clear filters";
      clearBtn.addEventListener("click", resetIdeaFilters);
      empty.appendChild(clearBtn);
    }

    host.appendChild(empty);
    return;
  }

  for (const idea of ideas) {
    const card = document.createElement("article");
    card.className = "idea-card";
    card.dataset.ideaId = idea.id;

    if (state.editingIdeaId === idea.id) {
      card.appendChild(createIdeaInlineEditForm(idea));
      host.appendChild(card);
      continue;
    }

    const head = document.createElement("div");
    head.className = "idea-card-head";

    const title = document.createElement("h3");
    title.className = "idea-card-title";
    title.textContent = idea.title || "Untitled idea";

    const actions = document.createElement("div");
    actions.className = "idea-card-actions";

    const statusSelect = document.createElement("select");
    statusSelect.className = "idea-status-select";
    statusSelect.setAttribute("aria-label", "Status for " + (idea.title || "idea"));
    for (const statusValue of ["inbox", "active", "parked", "promoted", "archived"]) {
      const opt = document.createElement("option");
      opt.value = statusValue;
      opt.textContent = IDEA_STATUS_LABELS[statusValue] || statusValue;
      if (idea.status === statusValue) opt.selected = true;
      statusSelect.appendChild(opt);
    }
    statusSelect.addEventListener("change", async () => {
      const nextStatus = statusSelect.value;
      statusSelect.disabled = true;
      try {
        await api("/api/core/ideas/" + encodeURIComponent(idea.id), {
          method: "PATCH",
          body: JSON.stringify({ status: nextStatus })
        });
        toast("Idea moved to " + (IDEA_STATUS_LABELS[nextStatus] || nextStatus) + ".");
        await loadIdeas();
      } catch (error) {
        toast(error.message || "Could not update idea.");
        statusSelect.value = idea.status;
      } finally {
        statusSelect.disabled = false;
      }
    });

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "secondary-button";
    editBtn.textContent = "Edit";
    editBtn.setAttribute("aria-label", "Edit idea " + (idea.title || ""));
    editBtn.addEventListener("click", () => {
      state.editingIdeaId = idea.id;
      renderIdeas();
      host.querySelector('.idea-edit-form input[name="title"]')?.focus();
    });

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "secondary-button";
    delBtn.textContent = "Delete";
    delBtn.setAttribute("aria-label", "Delete idea " + (idea.title || ""));
    delBtn.addEventListener("click", async () => {
      delBtn.disabled = true;
      try {
        await api("/api/core/ideas/" + encodeURIComponent(idea.id), { method: "DELETE" });
        if (state.editingIdeaId === idea.id) state.editingIdeaId = null;
        toast("Idea removed from vault.");
        await loadIdeas();
      } catch (error) {
        toast(error.message || "Could not delete idea.");
        delBtn.disabled = false;
      }
    });

    actions.append(statusSelect, editBtn, delBtn);
    head.append(title, actions);
    card.appendChild(head);

    const project = idea.projectId
      ? (state.projects || []).find((p) => p.id === idea.projectId)
      : null;
    const metaParts = [
      IDEA_STATUS_LABELS[idea.status] || idea.status || "Inbox",
      IDEA_PRIORITY_LABELS[idea.priority] || "Medium priority",
      project ? "Project: " + project.name : "Unlinked",
      idea.createdAt ? new Date(idea.createdAt).toLocaleDateString() : ""
    ].filter(Boolean);

    const meta = document.createElement("div");
    meta.className = "idea-card-meta";
    meta.textContent = metaParts.join(" · ");
    card.appendChild(meta);

    if (idea.body) {
      const body = document.createElement("p");
      body.className = "idea-card-body";
      body.textContent = idea.body;
      card.appendChild(body);
    }

    if (Array.isArray(idea.tags) && idea.tags.length) {
      const tagRow = document.createElement("div");
      tagRow.className = "idea-card-tags";
      for (const tag of idea.tags) {
        const tagBtn = document.createElement("button");
        tagBtn.type = "button";
        const isActive = state.ideaTagFilter === tag;
        tagBtn.className = "idea-card-tag-btn" + (isActive ? " active" : "");
        tagBtn.dataset.ideaTag = tag;
        tagBtn.setAttribute("aria-pressed", String(isActive));
        tagBtn.textContent = "#" + tag;
        tagBtn.title = isActive ? "Clear #" + tag + " filter" : "Filter by #" + tag;
        tagBtn.addEventListener("click", () => toggleIdeaTagFilter(tag));
        tagRow.appendChild(tagBtn);
      }
      card.appendChild(tagRow);
    }

    const footer = document.createElement("div");
    footer.className = "idea-card-footer";
    const src = document.createElement("span");
    src.className = "idea-card-source";
    src.textContent = idea.sourceContext ? "Captured from: " + idea.sourceContext : "Ideas Vault";
    const exploreBtn = document.createElement("button");
    exploreBtn.type = "button";
    exploreBtn.className = "idea-explore-btn";
    exploreBtn.textContent = "Explore in chat ↗";
    exploreBtn.setAttribute("aria-label", "Explore " + (idea.title || "idea") + " in chat");
    exploreBtn.addEventListener("click", () => exploreIdeaInChat(idea));
    footer.append(src, exploreBtn);
    card.appendChild(footer);

    host.appendChild(card);
  }
}

async function loadIdeas() {
  const host = $("#idea-list");
  if (!host) return;
  syncIdeaProjectOptions();
  try {
    const params = new URLSearchParams();
    const filter = state.ideaStatusFilter || "all";
    if (filter && filter !== "all") params.set("status", filter);
    const projFilter = state.ideaProjectFilter || "all";
    if (projFilter && projFilter !== "all") params.set("projectId", projFilter);
    const activeTag = state.ideaTagFilter || "";
    if (activeTag) params.set("tag", activeTag);
    const q = ($("#idea-search")?.value || "").trim();
    if (q) params.set("q", q);
    const query = params.toString();
    const data = await api("/api/core/ideas" + (query ? "?" + query : ""));
    state.ideas = Array.isArray(data.ideas) ? data.ideas : [];
    state.ideaTags = Array.isArray(data.tags) ? data.tags : [];
    renderIdeas();
  } catch (error) {
    host.textContent = error.message || "Could not load Ideas Vault.";
  }
}

function initIdeasVault() {
  const form = $("#idea-form");
  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const titleInput = form.elements.title;
      const bodyInput = form.elements.body;
      const prioritySelect = form.elements.priority;
      const projectSelect = form.elements.projectId;
      const title = (titleInput?.value || "").trim();
      if (!title) return;
      const body = (bodyInput?.value || "").trim();
      const priority = prioritySelect?.value || "medium";
      const projectId = projectSelect?.value || null;
      const submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;
      try {
        await api("/api/core/ideas", {
          method: "POST",
          body: JSON.stringify({
            title,
            body,
            priority,
            projectId,
            sourceContext: "Ideas Vault"
          })
        });
        form.reset();
        toast("Idea saved to Vault.");
        await loadIdeas();
      } catch (error) {
        toast(error.message || "Could not save idea.");
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  const tabsHost = $("#idea-status-tabs");
  if (tabsHost) {
    tabsHost.addEventListener("click", (event) => {
      const btn = event.target.closest("button[data-idea-status]");
      if (!btn) return;
      const nextStatus = btn.dataset.ideaStatus || "all";
      state.ideaStatusFilter = nextStatus;
      tabsHost.querySelectorAll("button[data-idea-status]").forEach((tab) => {
        const isActive = tab === btn;
        tab.classList.toggle("active", isActive);
        tab.setAttribute("aria-selected", String(isActive));
      });
      loadIdeas();
    });
  }

  $("#idea-project-filter")?.addEventListener("change", (event) => {
    state.ideaProjectFilter = event.currentTarget.value || "all";
    loadIdeas();
  });

  $("#idea-search")?.addEventListener("input", () => {
    clearTimeout(loadIdeas.timer);
    loadIdeas.timer = setTimeout(loadIdeas, 220);
  });

  $("#refresh-ideas")?.addEventListener("click", loadIdeas);
}

// ── Workflow & Learning Companion Profile Controller ──
const LEARNING_MODE_LABELS = {
  solve: "Solve it",
  explain: "Explain as you go",
  tutor: "Tutor me",
  challenge: "Challenge me",
  attempt_first: "Attempt first"
};

const CONFIDENCE_LABELS = {
  exploring: "Exploring",
  practicing: "Practicing",
  comfortable: "Comfortable",
  confident: "Confident"
};

const CONFIDENCE_SEQUENCE = ["exploring", "practicing", "comfortable", "confident"];

const FEEDBACK_TRAIT_META = [
  {
    key: "concise",
    label: "Concise replies",
    preferHint: "Prefer concise, direct answers without unnecessary padding.",
    avoidHint: "Avoid overly terse replies; include enough context to be self-contained."
  },
  {
    key: "detailed",
    label: "Thorough detail",
    preferHint: "Provide thorough, well-explained answers with deeper rationale and edge cases.",
    avoidHint: "Avoid long walls of text; keep replies tighter and easier to scan."
  },
  {
    key: "structured",
    label: "Structured headings & bullets",
    preferHint: "Organize answers with clear headings and scannable bullet points.",
    avoidHint: "Prefer natural prose paragraphs over heavy bulleted formatting when simple."
  },
  {
    key: "codeExamples",
    label: "Concrete code & commands",
    preferHint: "Include concrete code snippets or runnable commands when explaining technical topics.",
    avoidHint: "Keep code snippets minimal unless explicitly requested."
  },
  {
    key: "stepByStep",
    label: "Step-by-step walkthroughs",
    preferHint: "Present actionable procedures as clear numbered steps with verification points.",
    avoidHint: "Summarize outcomes directly instead of rigid numbered checklists."
  }
];

const FEEDBACK_SENSITIVITY_META = {
  gentle: {
    label: "Gentle",
    threshold: 2,
    description: "Requires repeated feedback (score ±2) before shaping replies."
  },
  balanced: {
    label: "Balanced",
    threshold: 1,
    description: "Adapts steadily from each thumbs-up or flag reaction."
  },
  responsive: {
    label: "Responsive",
    threshold: 1,
    description: "Adapts quickly with stronger weight per reaction (2× per signal)."
  }
};

let editingFeedbackTraitKey = null;

function formatFeedbackScoreLabel(score) {
  if (score > 0) return `Prefer +${score}`;
  if (score < 0) return `Avoid ${score}`;
  return "Neutral (0)";
}

function renderFeedbackLearningSection(profile) {
  const learned = profile.learnedStyle || { likes: 0, flags: 0, sensitivity: "balanced", traits: {}, traitOverrides: {}, recentSignals: [] };
  const learningEnabled = profile.learnFromFeedbackEnabled !== false;
  const sensitivityKey = FEEDBACK_SENSITIVITY_META[learned.sensitivity] ? learned.sensitivity : "balanced";
  const sensitivityMeta = FEEDBACK_SENSITIVITY_META[sensitivityKey];
  const threshold = sensitivityMeta.threshold;
  const likes = Number(learned.likes) || 0;
  const flags = Number(learned.flags) || 0;
  const totalReactions = likes + flags;

  const learnFbEl = $("#wf-learn-feedback");
  if (learnFbEl) learnFbEl.checked = learningEnabled;

  const sensSelectEl = $("#feedback-sensitivity-select");
  if (sensSelectEl) sensSelectEl.value = sensitivityKey;

  const sensHintEl = $("#feedback-sensitivity-hint");
  if (sensHintEl) {
    sensHintEl.textContent = learningEnabled
      ? sensitivityMeta.description
      : "Feedback learning is paused. Existing preferences are kept below until you re-enable or edit them.";
  }

  const statsEl = $("#feedback-learning-stats");
  if (statsEl) {
    statsEl.textContent = !learningEnabled
      ? `Paused · ${totalReactions} ${totalReactions === 1 ? "reaction" : "reactions"}`
      : `👍 ${likes} · 🚩 ${flags} · ${sensitivityMeta.label}`;
  }

  const learnedSummaryEl = $("#learned-style-summary");
  const learnedChipsEl = $("#learned-style-chips");
  const traitsObj = learned.traits || {};
  const overridesObj = learned.traitOverrides || {};

  const preferenceRows = FEEDBACK_TRAIT_META.map((trait) => {
    const score = Number.isFinite(Number(traitsObj[trait.key])) ? Math.max(-10, Math.min(10, Math.round(Number(traitsObj[trait.key])))) : 0;
    const customHint = typeof overridesObj[trait.key] === "string" ? overridesObj[trait.key].trim() : "";
    const direction = score > 0 ? "prefer" : score < 0 ? "avoid" : "neutral";
    const defaultHint = score < 0 ? trait.avoidHint : trait.preferHint;
    const active = learningEnabled && Math.abs(score) >= threshold;
    return {
      ...trait,
      score,
      customHint,
      direction,
      defaultHint,
      effectiveHint: customHint || defaultHint,
      active
    };
  });

  const activeRows = preferenceRows
    .filter((row) => Math.abs(row.score) >= threshold)
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score));

  if (learnedSummaryEl) {
    if (!learningEnabled) {
      learnedSummaryEl.textContent = "Feedback learning is currently paused. Toggle it back on above to apply these style preferences in new replies.";
    } else if (activeRows.length || totalReactions > 0) {
      learnedSummaryEl.textContent = totalReactions > 0
        ? `Learned from ${likes} liked and ${flags} flagged ${totalReactions === 1 ? "reply" : "replies"} (${sensitivityMeta.label} sensitivity, threshold ±${threshold}).`
        : `${activeRows.length} manually tuned style ${activeRows.length === 1 ? "preference" : "preferences"} active (${sensitivityMeta.label} sensitivity).`;
    } else {
      learnedSummaryEl.textContent = "Click 👍 Like or 🚩 Flag on any assistant reply, or edit any style dimension below to shape Alfie's replies across sessions.";
    }
  }

  if (learnedChipsEl) {
    learnedChipsEl.replaceChildren();
    if (activeRows.length) {
      for (const row of activeRows) {
        const chip = document.createElement("span");
        chip.className = "learned-style-chip " + (row.score > 0 ? "is-prefer" : "is-avoid") + (learningEnabled ? "" : " is-paused");
        chip.textContent = row.score > 0
          ? `${row.label} (+${row.score})`
          : `Less ${row.label.toLowerCase()} (${row.score})`;
        if (row.customHint) chip.title = `Custom rule: ${row.customHint}`;
        learnedChipsEl.appendChild(chip);
      }
    } else {
      const emptyNote = document.createElement("span");
      emptyNote.className = "muted";
      emptyNote.textContent = totalReactions > 0 && threshold > 1
        ? `No traits have reached the ±${threshold} threshold yet.`
        : "No active style traits yet.";
      learnedChipsEl.appendChild(emptyNote);
    }
  }

  const prefsHost = $("#feedback-preferences-list");
  if (prefsHost) {
    prefsHost.replaceChildren();
    const sortedRows = [...preferenceRows].sort((a, b) => {
      const aHas = a.score !== 0 || Boolean(a.customHint) ? 1 : 0;
      const bHas = b.score !== 0 || Boolean(b.customHint) ? 1 : 0;
      if (bHas !== aHas) return bHas - aHas;
      return Math.abs(b.score) - Math.abs(a.score);
    });

    for (const row of sortedRows) {
      const card = document.createElement("article");
      card.className = "feedback-pref-card" + (row.score > 0 ? " is-prefer" : row.score < 0 ? " is-avoid" : " is-neutral");
      card.setAttribute("role", "listitem");
      card.dataset.traitKey = row.key;

      const topRow = document.createElement("div");
      topRow.className = "feedback-pref-top";

      const titleGroup = document.createElement("div");
      titleGroup.className = "feedback-pref-title-group";

      const titleEl = document.createElement("strong");
      titleEl.className = "feedback-pref-label";
      titleEl.textContent = row.label;
      titleGroup.appendChild(titleEl);

      const badge = document.createElement("span");
      badge.className = "feedback-pref-badge " + (row.score > 0 ? "is-prefer" : row.score < 0 ? "is-avoid" : "is-neutral");
      badge.textContent = formatFeedbackScoreLabel(row.score);
      titleGroup.appendChild(badge);

      const statusTag = document.createElement("span");
      statusTag.className = "feedback-pref-state";
      if (!learningEnabled && Math.abs(row.score) >= threshold) {
        statusTag.textContent = "Paused";
      } else if (row.active) {
        statusTag.textContent = row.customHint ? "Active · Custom rule" : "Active in prompt";
      } else if (row.score !== 0) {
        statusTag.textContent = `Below ±${threshold} threshold`;
      } else if (row.customHint) {
        statusTag.textContent = "Custom rule saved (set score to activate)";
      } else {
        statusTag.textContent = "Unlearned";
      }
      titleGroup.appendChild(statusTag);

      const actionsWrap = document.createElement("div");
      actionsWrap.className = "feedback-pref-actions";

      const isEditing = editingFeedbackTraitKey === row.key;
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "secondary-button feedback-pref-btn";
      editBtn.textContent = isEditing ? "Close" : "Edit";
      editBtn.dataset.action = "edit-pref";
      editBtn.dataset.traitKey = row.key;
      editBtn.addEventListener("click", () => {
        editingFeedbackTraitKey = isEditing ? null : row.key;
        renderFeedbackLearningSection(state.workflowProfile || profile);
      });
      actionsWrap.appendChild(editBtn);

      if (row.score !== 0 || row.customHint) {
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "secondary-button feedback-pref-btn is-danger";
        delBtn.textContent = "Delete";
        delBtn.dataset.action = "delete-pref";
        delBtn.dataset.traitKey = row.key;
        delBtn.addEventListener("click", async () => {
          try {
            const res = await api(`/api/core/profile/feedback/${encodeURIComponent(row.key)}`, {
              method: "DELETE",
              body: "{}"
            });
            if (editingFeedbackTraitKey === row.key) editingFeedbackTraitKey = null;
            state.workflowProfile = res.profile;
            renderWorkflowProfile();
            toast(`Deleted learned preference for ${row.label}.`);
          } catch (error) {
            toast(error.message || "Could not delete preference.");
          }
        });
        actionsWrap.appendChild(delBtn);
      }

      topRow.appendChild(titleGroup);
      topRow.appendChild(actionsWrap);
      card.appendChild(topRow);

      const descEl = document.createElement("p");
      descEl.className = "feedback-pref-hint muted";
      descEl.textContent = row.score === 0 && !row.customHint
        ? `Default when preferred: ${row.preferHint}`
        : row.effectiveHint;
      card.appendChild(descEl);

      if (isEditing) {
        const editorForm = document.createElement("form");
        editorForm.className = "feedback-pref-editor";
        editorForm.dataset.traitKey = row.key;

        const scoreRow = document.createElement("div");
        scoreRow.className = "feedback-score-row";

        const scoreLabel = document.createElement("label");
        scoreLabel.className = "feedback-score-label";
        const scoreTitle = document.createElement("span");
        scoreTitle.textContent = "Preference weight (−10 avoid to +10 prefer)";
        const scoreVal = document.createElement("strong");
        scoreVal.className = "feedback-score-readout";
        scoreVal.textContent = formatFeedbackScoreLabel(row.score);
        scoreLabel.appendChild(scoreTitle);
        scoreLabel.appendChild(scoreVal);

        const rangeInput = document.createElement("input");
        rangeInput.type = "range";
        rangeInput.name = "score";
        rangeInput.min = "-10";
        rangeInput.max = "10";
        rangeInput.step = "1";
        rangeInput.value = String(row.score);
        rangeInput.setAttribute("aria-label", `${row.label} preference weight`);
        rangeInput.addEventListener("input", () => {
          const val = Number(rangeInput.value) || 0;
          scoreVal.textContent = formatFeedbackScoreLabel(val);
        });
        scoreLabel.appendChild(rangeInput);
        scoreRow.appendChild(scoreLabel);

        const quickWrap = document.createElement("div");
        quickWrap.className = "feedback-quick-presets";
        for (const preset of [
          { label: "Avoid −2", val: -2 },
          { label: "Neutral 0", val: 0 },
          { label: "Prefer +2", val: 2 },
          { label: "Strong +4", val: 4 }
        ]) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "secondary-button feedback-preset-btn";
          btn.textContent = preset.label;
          btn.addEventListener("click", () => {
            rangeInput.value = String(preset.val);
            scoreVal.textContent = formatFeedbackScoreLabel(preset.val);
          });
          quickWrap.appendChild(btn);
        }
        scoreRow.appendChild(quickWrap);
        editorForm.appendChild(scoreRow);

        const hintLabel = document.createElement("label");
        hintLabel.className = "feedback-custom-hint-field";
        const hintCaption = document.createElement("span");
        hintCaption.textContent = "Custom prompt instruction (optional — overrides default wording)";
        const hintInput = document.createElement("input");
        hintInput.type = "text";
        hintInput.name = "customHint";
        hintInput.maxLength = 220;
        hintInput.value = row.customHint;
        hintInput.placeholder = row.defaultHint;
        hintLabel.appendChild(hintCaption);
        hintLabel.appendChild(hintInput);
        editorForm.appendChild(hintLabel);

        const footer = document.createElement("div");
        footer.className = "feedback-editor-footer";
        const saveBtn = document.createElement("button");
        saveBtn.type = "submit";
        saveBtn.className = "primary-button feedback-pref-btn";
        saveBtn.textContent = "Save preference";
        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "secondary-button feedback-pref-btn";
        cancelBtn.textContent = "Cancel";
        cancelBtn.addEventListener("click", () => {
          editingFeedbackTraitKey = null;
          renderFeedbackLearningSection(state.workflowProfile || profile);
        });
        footer.appendChild(saveBtn);
        footer.appendChild(cancelBtn);
        editorForm.appendChild(footer);

        editorForm.addEventListener("submit", async (event) => {
          event.preventDefault();
          let score = Number(rangeInput.value);
          if (!Number.isFinite(score)) score = 0;
          const customHint = hintInput.value.trim();
          // If the user wrote a custom rule while leaving score at 0, nudge it to +1 so it takes effect immediately.
          if (customHint && score === 0) score = threshold;
          try {
            const res = await api(`/api/core/profile/feedback/${encodeURIComponent(row.key)}`, {
              method: "PATCH",
              body: JSON.stringify({ score, customHint })
            });
            editingFeedbackTraitKey = null;
            state.workflowProfile = res.profile;
            renderWorkflowProfile();
            toast(`Updated preference: ${row.label} (${formatFeedbackScoreLabel(score)}).`);
          } catch (error) {
            toast(error.message || "Could not update learned preference.");
          }
        });

        card.appendChild(editorForm);
      }

      prefsHost.appendChild(card);
    }
  }

  const signalsHost = $("#feedback-signals-list");
  if (signalsHost) {
    signalsHost.replaceChildren();
    const signals = Array.isArray(learned.recentSignals) ? learned.recentSignals : [];
    if (!signals.length) {
      const emptyEl = document.createElement("p");
      emptyEl.className = "muted feedback-empty-note";
      emptyEl.textContent = "No captured 👍 Like or 🚩 Flag signals yet. React to any reply in chat to log feedback here.";
      signalsHost.appendChild(emptyEl);
    } else {
      for (const sig of signals) {
        const rowEl = document.createElement("div");
        rowEl.className = "feedback-signal-row " + (sig.reaction === "flag" ? "is-avoid" : "is-prefer");
        rowEl.setAttribute("role", "listitem");
        if (sig.id) rowEl.dataset.signalId = sig.id;

        const iconEl = document.createElement("span");
        iconEl.className = "feedback-signal-icon";
        iconEl.setAttribute("aria-hidden", "true");
        iconEl.textContent = sig.reaction === "flag" ? "🚩" : "👍";

        const bodyEl = document.createElement("div");
        bodyEl.className = "feedback-signal-body";
        const labelEl = document.createElement("span");
        labelEl.className = "feedback-signal-label";
        labelEl.textContent = sig.label || "Captured reaction";
        bodyEl.appendChild(labelEl);

        if (sig.at) {
          const timeEl = document.createElement("span");
          timeEl.className = "feedback-signal-time muted";
          const dt = new Date(sig.at);
          timeEl.textContent = Number.isNaN(dt.getTime()) ? sig.at : dt.toLocaleString();
          bodyEl.appendChild(timeEl);
        }

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "secondary-button feedback-pref-btn";
        removeBtn.textContent = "Delete";
        removeBtn.dataset.action = "delete-signal";
        if (sig.id) removeBtn.dataset.signalId = sig.id;
        removeBtn.addEventListener("click", async () => {
          if (!sig.id) return;
          try {
            const res = await api(`/api/core/profile/feedback/signals/${encodeURIComponent(sig.id)}`, {
              method: "DELETE",
              body: "{}"
            });
            state.workflowProfile = res.profile;
            renderWorkflowProfile();
            toast("Deleted captured feedback signal.");
          } catch (error) {
            toast(error.message || "Could not delete feedback signal.");
          }
        });

        rowEl.appendChild(iconEl);
        rowEl.appendChild(bodyEl);
        rowEl.appendChild(removeBtn);
        signalsHost.appendChild(rowEl);
      }
    }
  }
}

function renderWorkflowProfile() {
  const profile = state.workflowProfile;
  if (!profile) return;
  const setVal = (sel, val) => { const el = $(sel); if (el && val !== undefined) el.value = val; };
  setVal("#wf-explanation-style", profile.explanationStyle || "balanced");
  setVal("#wf-change-presentation", profile.changePresentation || "diffs_and_rollback");
  setVal("#wf-interruption-tolerance", profile.interruptionTolerance || "balanced");
  setVal("#wf-chunk-size", profile.chunkSize || "balanced");
  setVal("#wf-learning-mode", profile.learningMode || "explain");
  setVal("#learning-mode-select", profile.learningMode || "explain");
  const notesEl = $("#wf-custom-notes");
  if (notesEl) notesEl.value = profile.customNotes || "";
  const autoMemEl = $("#wf-auto-memory");
  if (autoMemEl) autoMemEl.checked = profile.autoMemoryEnabled !== false;
  const statusEl = $("#workflow-profile-status");
  if (statusEl && profile.updatedAt) {
    statusEl.textContent = "Updated " + new Date(profile.updatedAt).toLocaleTimeString();
  }

  renderLocationControls(profile);
  renderFeedbackLearningSection(profile);
  updateChatContextSummary();

  const topicHost = $("#learning-topic-list");
  if (!topicHost) return;
  topicHost.replaceChildren();
  const topics = Array.isArray(profile.learningTopics) ? profile.learningTopics : [];
  for (const item of topics) {
    const idx = CONFIDENCE_SEQUENCE.indexOf(item.confidence);
    const nextConf = CONFIDENCE_SEQUENCE[(idx + 1) % CONFIDENCE_SEQUENCE.length];
    const meta = [
      CONFIDENCE_LABELS[item.confidence] || item.confidence,
      item.notes || "",
      item.updatedAt ? "Updated " + new Date(item.updatedAt).toLocaleDateString() : ""
    ].filter(Boolean).join(" · ");
    const actions = [
      {
        label: `Mark ${CONFIDENCE_LABELS[nextConf]}`,
        onClick: async () => {
          try {
            const res = await api(`/api/core/profile/topics/${encodeURIComponent(item.id)}`, {
              method: "PATCH",
              body: JSON.stringify({ confidence: nextConf })
            });
            state.workflowProfile = res.profile;
            renderWorkflowProfile();
            toast(`"${item.topic}" → ${CONFIDENCE_LABELS[nextConf]}`);
          } catch (error) { toast(error.message); }
        }
      },
      {
        label: "Remove",
        onClick: async () => {
          try {
            const res = await api(`/api/core/profile/topics/${encodeURIComponent(item.id)}`, { method: "DELETE", body: "{}" });
            state.workflowProfile = res.profile;
            renderWorkflowProfile();
            toast(`Removed "${item.topic}".`);
          } catch (error) { toast(error.message); }
        }
      }
    ];
    topicHost.appendChild(createItem(item.topic, meta, actions));
  }
  if (!topics.length) {
    topicHost.textContent = "No learning topics tracked yet. Add an area you're exploring above.";
  }
}

async function loadWorkflowProfile() {
  try {
    const res = await api("/api/core/profile");
    state.workflowProfile = res.profile || null;
    renderWorkflowProfile();
  } catch {}
}

function initWorkflowProfile() {
  $("#learning-mode-select")?.addEventListener("change", async (event) => {
    const nextMode = event.currentTarget.value || "explain";
    try {
      const res = await api("/api/core/profile", {
        method: "PUT",
        body: JSON.stringify({ learningMode: nextMode })
      });
      state.workflowProfile = res.profile;
      renderWorkflowProfile();
      toast("Learning posture: " + (LEARNING_MODE_LABELS[nextMode] || nextMode));
    } catch (error) {
      toast(error.message || "Could not update learning posture.");
    }
  });

  $("#workflow-profile-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formEl = event.currentTarget;
    const prevLoc = state.workflowProfile?.location || {};
    const nextLabel = (formEl.elements.locationLabel?.value || "").trim();
    const nextLocEnabled = Boolean(formEl.elements.locationEnabled?.checked) && Boolean(nextLabel || (prevLoc.latitude !== null && prevLoc.latitude !== undefined));
    const payload = {
      explanationStyle: formEl.elements.explanationStyle?.value || "balanced",
      changePresentation: formEl.elements.changePresentation?.value || "diffs_and_rollback",
      interruptionTolerance: formEl.elements.interruptionTolerance?.value || "balanced",
      chunkSize: formEl.elements.chunkSize?.value || "balanced",
      learningMode: formEl.elements.learningMode?.value || "explain",
      customNotes: (formEl.elements.customNotes?.value || "").trim(),
      autoMemoryEnabled: Boolean(formEl.elements.autoMemoryEnabled?.checked),
      learnFromFeedbackEnabled: Boolean($("#wf-learn-feedback")?.checked ?? true),
      location: {
        enabled: nextLocEnabled,
        label: nextLabel,
        latitude: nextLabel && nextLabel !== prevLoc.label ? null : (prevLoc.latitude ?? null),
        longitude: nextLabel && nextLabel !== prevLoc.label ? null : (prevLoc.longitude ?? null),
        timezone: prevLoc.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || ""
      }
    };
    try {
      const res = await api("/api/core/profile", { method: "PUT", body: JSON.stringify(payload) });
      state.workflowProfile = res.profile;
      renderWorkflowProfile();
      toast("Workflow & learning profile saved.");
    } catch (error) {
      toast(error.message || "Could not save workflow profile.");
    }
  });

  $("#wf-learn-feedback")?.addEventListener("change", async (event) => {
    const enabled = Boolean(event.currentTarget.checked);
    try {
      const res = await api("/api/core/profile", {
        method: "PUT",
        body: JSON.stringify({ learnFromFeedbackEnabled: enabled })
      });
      state.workflowProfile = res.profile;
      renderWorkflowProfile();
      toast(enabled ? "Feedback learning enabled." : "Feedback learning paused.");
    } catch (error) {
      event.currentTarget.checked = !enabled;
      toast(error.message || "Could not update feedback learning setting.");
    }
  });

  $("#feedback-sensitivity-select")?.addEventListener("change", async (event) => {
    const feedbackSensitivity = event.currentTarget.value || "balanced";
    try {
      const res = await api("/api/core/profile", {
        method: "PUT",
        body: JSON.stringify({ feedbackSensitivity })
      });
      state.workflowProfile = res.profile;
      renderWorkflowProfile();
      toast(`Feedback sensitivity set to ${FEEDBACK_SENSITIVITY_META[feedbackSensitivity]?.label || feedbackSensitivity}.`);
    } catch (error) {
      toast(error.message || "Could not update learning sensitivity.");
    }
  });

  $("#learned-style-reset-btn")?.addEventListener("click", async () => {
    try {
      const res = await api("/api/core/profile", {
        method: "PUT",
        body: JSON.stringify({ resetLearnedStyle: true })
      });
      editingFeedbackTraitKey = null;
      state.workflowProfile = res.profile;
      renderWorkflowProfile();
      toast("Learned response preferences reset.");
    } catch (error) {
      toast(error.message || "Could not reset learned style.");
    }
  });

  $("#learning-topic-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formEl = event.currentTarget;
    const topic = (formEl.elements.topic?.value || "").trim();
    const confidence = formEl.elements.confidence?.value || "exploring";
    if (!topic) return;
    try {
      const res = await api("/api/core/profile/topics", {
        method: "POST",
        body: JSON.stringify({ topic, confidence })
      });
      state.workflowProfile = res.profile;
      formEl.reset();
      renderWorkflowProfile();
      toast(`Tracking "${topic}".`);
    } catch (error) {
      toast(error.message || "Could not add learning topic.");
    }
  });
}

// ── Context Capsules Controller ──
const PRIVACY_POSTURE_LABELS = {
  local_only: "Local only",
  cloud_isolated: "Cloud (private locked)",
  cloud_scoped: "Cloud (scoped)"
};

function renderCapsules() {
  const listHost = $("#capsule-list");
  const chatWrap = $("#chat-capsule-wrap");
  const chatSelect = $("#chat-capsule-select");
  const projectNameById = new Map((state.projects || []).map((p) => [p.id, p.name]));
  const capsules = state.capsules || [];

  if (chatWrap && chatSelect) {
    chatWrap.hidden = capsules.length === 0;
    chatSelect.replaceChildren();
    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "Manual setup";
    chatSelect.appendChild(noneOpt);
    for (const cap of capsules) {
      const opt = document.createElement("option");
      opt.value = cap.id;
      opt.textContent = cap.name;
      chatSelect.appendChild(opt);
    }
    chatSelect.value = state.activeCapsuleId && capsules.some((c) => c.id === state.activeCapsuleId) ? state.activeCapsuleId : "";
  }

  if (!listHost) return;
  listHost.replaceChildren();
  for (const cap of capsules) {
    const isActive = cap.id === state.activeCapsuleId;
    const projName = cap.projectId ? (projectNameById.get(cap.projectId) || cap.projectId.slice(0, 8)) : "No project";
    const leaseSummary = (cap.leaseTemplate || []).length
      ? cap.leaseTemplate.map((l) => `${l.scope}${l.ttlMinutes ? ` (${Math.round(l.ttlMinutes / 60)}h)` : ""}`).join(", ")
      : "No auto-leases";
    const meta = [
      isActive ? "Active workspace" : "Ready",
      `Project: ${projName}`,
      `Mode: ${cap.workingMode}`,
      `Learn: ${LEARNING_MODE_LABELS[cap.learningMode] || cap.learningMode}`,
      PRIVACY_POSTURE_LABELS[cap.privacyPosture] || cap.privacyPosture,
      `Leases: ${leaseSummary}`
    ].join(" · ") + (cap.description ? ` — ${cap.description}` : "");

    const actions = [
      {
        label: isActive ? "Re-activate" : "Activate",
        kind: isActive ? "secondary-button" : "primary-button",
        onClick: () => activateCapsuleById(cap.id)
      },
      {
        label: "Delete",
        onClick: async (event) => {
          const btn = event?.currentTarget;
          if (btn && btn.dataset.confirmDelete !== "true") {
            btn.dataset.confirmDelete = "true";
            btn.textContent = "Confirm delete";
            btn.classList.add("danger-button");
            setTimeout(() => {
              if (btn.isConnected && btn.dataset.confirmDelete === "true") {
                delete btn.dataset.confirmDelete;
                btn.textContent = "Delete";
                btn.classList.remove("danger-button");
              }
            }, 4000);
            return;
          }
          try {
            await api(`/api/core/capsules/${encodeURIComponent(cap.id)}`, { method: "DELETE", body: "{}" });
            toast(`Deleted capsule "${cap.name}".`);
            await loadCapsules();
          } catch (error) { toast(error.message); }
        }
      }
    ];
    const el = createItem(cap.name, meta, actions);
    if (isActive) el.classList.add("capsule-active");
    listHost.appendChild(el);
  }
  if (!capsules.length) {
    listHost.textContent = "No context capsules saved yet. Save one above to switch project, posture, learning style, and leases in one click.";
  }
}

async function activateCapsuleById(capsuleId) {
  if (!capsuleId) return;
  try {
    const res = await api(`/api/core/capsules/${encodeURIComponent(capsuleId)}/activate`, {
      method: "POST",
      body: "{}"
    });
    const cap = res.capsule;
    state.activeCapsuleId = res.activeCapsuleId || cap.id;
    if (res.profile) {
      state.workflowProfile = res.profile;
      renderWorkflowProfile();
    }
    // Sync working mode selector
    if (cap?.workingMode) {
      state.workingMode = cap.workingMode;
      try { localStorage.setItem("alfie:workingMode", cap.workingMode); } catch {}
      const modeSelect = $("#working-mode-select");
      if (modeSelect) {
        modeSelect.value = cap.workingMode;
        syncWorkingModeTooltip(modeSelect);
      }
    }
    // Sync active project filter if the capsule references an existing project
    if (cap?.projectId && state.projects.some((p) => p.id === cap.projectId)) {
      state.selectedProjectId = cap.projectId;
      renderProjects();
      renderConversations(state.conversations);
    }
    renderCapsules();
    if (state.view === "tools") {
      await loadToolsAndApprovals();
    }
    const leaseNote = res.grantedLeases?.length ? ` · ${res.grantedLeases.length} lease(s) active` : "";
    toast(`Activated capsule "${cap.name}" (${cap.workingMode}${leaseNote}).`);
  } catch (error) {
    toast(error.message || "Could not activate capsule.");
  }
}

async function loadCapsules() {
  try {
    const res = await api("/api/core/capsules");
    state.capsules = res.capsules || [];
    state.activeCapsuleId = res.activeCapsuleId || null;
    renderCapsules();
  } catch {}
}

function initCapsules() {
  $("#refresh-capsules")?.addEventListener("click", loadCapsules);
  $("#chat-capsule-select")?.addEventListener("change", (event) => {
    const id = event.currentTarget.value;
    if (id) activateCapsuleById(id);
  });
  $("#capsule-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formEl = event.currentTarget;
    const name = (formEl.elements.name?.value || "").trim();
    if (!name) return;
    const leaseScope = formEl.elements.leaseScope?.value || "";
    const leaseTtl = Number(formEl.elements.leaseTtl?.value || 60);
    const payload = {
      name,
      description: (formEl.elements.description?.value || "").trim(),
      projectId: formEl.elements.projectId?.value || null,
      workingMode: formEl.elements.workingMode?.value || "engineer",
      learningMode: formEl.elements.learningMode?.value || "explain",
      privacyPosture: formEl.elements.privacyPosture?.value || "local_only",
      leaseTemplate: leaseScope ? [{ scope: leaseScope, ttlMinutes: leaseTtl }] : []
    };
    try {
      await api("/api/core/capsules", { method: "POST", body: JSON.stringify(payload) });
      formEl.reset();
      toast(`Context Capsule "${name}" saved.`);
      await loadCapsules();
    } catch (error) {
      toast(error.message || "Could not save capsule.");
    }
  });
}

// ── Personal Knowledge Graph Explorer ──
function renderKnowledgeGraphInspector() {
  const titleEl = $("#kg-inspector-title");
  const metaEl = $("#kg-inspector-meta");
  const summaryEl = $("#kg-inspector-summary");
  const actionsEl = $("#kg-inspector-actions");
  const neighborsWrap = $("#kg-inspector-neighbors-wrap");
  const neighborsEl = $("#kg-inspector-neighbors");
  if (!titleEl || !metaEl) return;

  const graph = state.knowledgeGraph;
  const kgApi = window.AlfieKnowledgeGraph;
  const node = graph?.nodes?.find((n) => n.id === state.kgSelectedNodeId) || null;

  if (!node) {
    titleEl.textContent = "Select a node";
    metaEl.textContent = graph?.nodes?.length
      ? "Click any node on the map to inspect its provenance and connected neighbors."
      : "Create a Project, Idea, Memory, Capsule, or Watcher to populate your Knowledge Graph.";
    if (summaryEl) { summaryEl.textContent = ""; summaryEl.hidden = true; }
    if (actionsEl) { actionsEl.replaceChildren(); actionsEl.hidden = true; }
    if (neighborsWrap) neighborsWrap.hidden = true;
    return;
  }

  const kindLabel = kgApi?.GRAPH_KIND_LABELS?.[node.kind] || node.kind;
  const trustLabel = kgApi?.GRAPH_TRUST_LABELS?.[node.trust] || node.trust || "User authored";
  titleEl.textContent = node.label;
  metaEl.textContent = [kindLabel, trustLabel, `${node.degree || 0} connection${node.degree === 1 ? "" : "s"}`].join(" · ");

  if (summaryEl) {
    summaryEl.textContent = node.summary || node.subtitle || "";
    summaryEl.hidden = !(node.summary || node.subtitle);
  }

  if (actionsEl) {
    actionsEl.replaceChildren();
    const exploreBtn = document.createElement("button");
    exploreBtn.type = "button";
    exploreBtn.className = "primary-button kg-action-btn";
    exploreBtn.textContent = "Explore in Chat";
    exploreBtn.addEventListener("click", () => {
      const prompt = `Let's examine this ${kindLabel.toLowerCase()} from my workspace: "${node.label}" — ${node.summary || node.subtitle || ""}`.trim();
      setView("chat");
      const input = $("#chat-form textarea");
      if (input) {
        input.value = prompt;
        input.focus();
      }
    });
    actionsEl.appendChild(exploreBtn);

    if (node.kind === "project") {
      const proj = (state.projects || []).find((p) => p.id === node.entityId);
      if (proj) {
        const dossierBtn = document.createElement("button");
        dossierBtn.type = "button";
        dossierBtn.className = "secondary-button kg-action-btn";
        dossierBtn.textContent = "Open Dossier";
        dossierBtn.addEventListener("click", () => openProjectModal(proj));
        actionsEl.appendChild(dossierBtn);
      }
    } else if (node.kind === "tag" && node.meta?.tag) {
      const tagBtn = document.createElement("button");
      tagBtn.type = "button";
      tagBtn.className = "secondary-button kg-action-btn";
      tagBtn.textContent = `Filter #${node.meta.tag} in Ideas`;
      tagBtn.addEventListener("click", () => {
        state.ideaTagFilter = node.meta.tag;
        setView("ideas");
      });
      actionsEl.appendChild(tagBtn);
    }
    actionsEl.hidden = false;
  }

  if (neighborsWrap && neighborsEl) {
    neighborsEl.replaceChildren();
    const edges = Array.isArray(graph?.edges) ? graph.edges : [];
    const nodeById = new Map((graph?.nodes || []).map((n) => [n.id, n]));
    const related = [];
    for (const edge of edges) {
      if (edge.source === node.id && nodeById.has(edge.target)) {
        related.push({ target: nodeById.get(edge.target), relation: edge.relation });
      } else if (edge.target === node.id && nodeById.has(edge.source)) {
        related.push({ target: nodeById.get(edge.source), relation: edge.relation });
      }
    }
    if (related.length) {
      for (const { target, relation } of related.slice(0, 10)) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "kg-neighbor-btn";
        const relLabel = kgApi?.GRAPH_RELATION_LABELS?.[relation] || relation;
        const targetKind = kgApi?.GRAPH_KIND_LABELS?.[target.kind] || target.kind;
        const main = document.createElement("span");
        main.className = "kg-neighbor-label";
        main.textContent = target.label;
        const sub = document.createElement("span");
        sub.className = "kg-neighbor-sub";
        sub.textContent = `${relLabel} · ${targetKind}`;
        btn.append(main, sub);
        btn.addEventListener("click", () => {
          state.kgSelectedNodeId = target.id;
          renderKnowledgeGraph();
        });
        neighborsEl.appendChild(btn);
      }
      neighborsWrap.hidden = false;
    } else {
      neighborsWrap.hidden = true;
    }
  }
}

function renderKnowledgeGraph() {
  const graph = state.knowledgeGraph || { nodes: [], edges: [], stats: { totalNodes: 0, totalEdges: 0, countsByKind: {}, untrustedNodeCount: 0 } };
  const stats = graph.stats || {};
  const setText = (sel, val) => { const el = $(sel); if (el) el.textContent = String(val); };
  setText("#kg-stat-nodes", stats.totalNodes ?? graph.nodes.length);
  setText("#kg-stat-edges", stats.totalEdges ?? graph.edges.length);
  setText("#kg-stat-projects", stats.countsByKind?.project ?? 0);
  const untrustedCount = stats.untrustedNodeCount ?? 0;
  const untrustedWrap = $("#kg-stat-untrusted-wrap");
  if (untrustedWrap) {
    untrustedWrap.hidden = untrustedCount <= 0;
    setText("#kg-stat-untrusted", untrustedCount);
  }

  if (state.kgSelectedNodeId && !graph.nodes.some((n) => n.id === state.kgSelectedNodeId)) {
    state.kgSelectedNodeId = graph.nodes[0]?.id || null;
  } else if (!state.kgSelectedNodeId && graph.nodes.length) {
    state.kgSelectedNodeId = graph.nodes[0].id;
  }

  const host = $("#kg-canvas-wrap");
  window.AlfieKnowledgeGraph?.renderKnowledgeGraphSvg(host, graph, {
    selectedNodeId: state.kgSelectedNodeId,
    zoom: state.kgZoom || 1,
    onSelectNode: (nodeId) => {
      state.kgSelectedNodeId = nodeId;
      renderKnowledgeGraph();
    }
  });
  renderKnowledgeGraphInspector();
}

async function loadKnowledgeGraph() {
  const host = $("#kg-canvas-wrap");
  if (!host) return;
  try {
    const params = new URLSearchParams();
    if (state.kgKindFilter && state.kgKindFilter !== "all") params.set("kind", state.kgKindFilter);
    if (state.kgProjectFilter) params.set("projectId", state.kgProjectFilter);
    const q = ($("#kg-search")?.value || "").trim();
    if (q) params.set("q", q);
    const query = params.toString();
    const res = await api("/api/core/graph" + (query ? "?" + query : ""));
    state.knowledgeGraph = res.graph || { nodes: [], edges: [], stats: {} };
    renderKnowledgeGraph();
  } catch (error) {
    host.textContent = error.message || "Knowledge graph unavailable.";
  }
}

function initKnowledgeGraph() {
  state.kgKindFilter = "all";
  state.kgProjectFilter = "";
  state.kgZoom = 1;
  state.kgSelectedNodeId = null;

  $("#kg-kind-tabs")?.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-kg-kind]");
    if (!btn) return;
    state.kgKindFilter = btn.dataset.kgKind || "all";
    $("#kg-kind-tabs").querySelectorAll("button[data-kg-kind]").forEach((tab) => {
      const active = tab === btn;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    loadKnowledgeGraph();
  });

  $("#kg-project-filter")?.addEventListener("change", (event) => {
    state.kgProjectFilter = event.currentTarget.value || "";
    loadKnowledgeGraph();
  });

  let searchTimer = null;
  $("#kg-search")?.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadKnowledgeGraph, 180);
  });

  $("#kg-zoom-in")?.addEventListener("click", () => {
    state.kgZoom = Math.min(1.65, Number(((state.kgZoom || 1) + 0.15).toFixed(2)));
    renderKnowledgeGraph();
  });
  $("#kg-zoom-out")?.addEventListener("click", () => {
    state.kgZoom = Math.max(0.75, Number(((state.kgZoom || 1) - 0.15).toFixed(2)));
    renderKnowledgeGraph();
  });
  $("#kg-zoom-reset")?.addEventListener("click", () => {
    state.kgZoom = 1;
    renderKnowledgeGraph();
  });
  $("#kg-refresh-btn")?.addEventListener("click", loadKnowledgeGraph);
}

// ── Phase 1–5 Roadmap Surfaces: Recovery, Voice Loop TTS, Hybrid Search, Reflections, Virtual Room, Workshop, Integrations, SQLite WAL, Privacy Airlock ──

let activeTtsAudio = null;

function stopAssistantSpeech() {
  if (activeTtsAudio) {
    try {
      activeTtsAudio.pause();
      activeTtsAudio.src = "";
    } catch {}
    activeTtsAudio = null;
  }
  try {
    window.speechSynthesis?.cancel?.();
  } catch {}
  const stopBtn = $("#voice-tts-stop");
  if (stopBtn) stopBtn.hidden = true;
}

async function speakAssistantReply(text) {
  if (!state.voiceTtsEnabled) return;
  const cleaned = String(text || "")
    .replace(/```[\s\S]*?```/g, " Code block omitted. ")
    .replace(/[#*_>`~]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
  if (!cleaned) return;
  stopAssistantSpeech();
  const stopBtn = $("#voice-tts-stop");
  if (stopBtn) stopBtn.hidden = false;

  try {
    const res = await api("/api/core/voice/synthesize", {
      method: "POST",
      body: JSON.stringify({ text: cleaned })
    });
    if (res?.mode === "local_tts" && res.audioBase64) {
      const audio = new Audio(`data:${res.mimeType || "audio/wav"};base64,${res.audioBase64}`);
      activeTtsAudio = audio;
      audio.addEventListener("ended", () => {
        activeTtsAudio = null;
        if (stopBtn) stopBtn.hidden = true;
      });
      audio.addEventListener("error", () => {
        activeTtsAudio = null;
        if (stopBtn) stopBtn.hidden = true;
      });
      await audio.play();
      return;
    }
  } catch {
    // Fall back seamlessly to browser speech synthesis.
  }

  if (typeof window !== "undefined" && "speechSynthesis" in window && typeof window.SpeechSynthesisUtterance === "function") {
    try {
      const utter = new window.SpeechSynthesisUtterance(cleaned);
      utter.rate = 1.0;
      utter.onend = () => { if (stopBtn) stopBtn.hidden = true; };
      utter.onerror = () => { if (stopBtn) stopBtn.hidden = true; };
      window.speechSynthesis.speak(utter);
      return;
    } catch {}
  }
  if (stopBtn) stopBtn.hidden = true;
}

function initVoiceLoopTts() {
  const toggleBtn = $("#voice-tts-toggle");
  const stopBtn = $("#voice-tts-stop");
  state.voiceTtsEnabled = localStorage.getItem("alfie_voice_tts_enabled") === "1";

  const syncToggle = () => {
    if (!toggleBtn) return;
    toggleBtn.setAttribute("aria-pressed", String(state.voiceTtsEnabled));
    toggleBtn.classList.toggle("is-active", state.voiceTtsEnabled);
    toggleBtn.title = state.voiceTtsEnabled
      ? "Spoken replies ON — click to mute"
      : "Read Alfie's replies aloud (push-to-talk voice loop)";
  };
  syncToggle();

  toggleBtn?.addEventListener("click", () => {
    state.voiceTtsEnabled = !state.voiceTtsEnabled;
    localStorage.setItem("alfie_voice_tts_enabled", state.voiceTtsEnabled ? "1" : "0");
    if (!state.voiceTtsEnabled) stopAssistantSpeech();
    syncToggle();
    toast(state.voiceTtsEnabled ? "Spoken replies enabled (push-to-talk only)" : "Spoken replies muted");
  });

  stopBtn?.addEventListener("click", () => {
    stopAssistantSpeech();
    toast("Stopped speaking");
  });
}

function initAccountRecovery() {
  const loginForm = $("#recovery-form");
  loginForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const errEl = $("#login-error");
    if (errEl) errEl.textContent = "";
    const fd = new FormData(form);
    const username = String(fd.get("username") || "").trim();
    const recoveryCode = String(fd.get("recoveryCode") || "").trim();
    const newPassword = String(fd.get("newPassword") || "");
    try {
      const res = await api("/api/auth/recover", {
        method: "POST",
        body: JSON.stringify({ username, recoveryCode, newPassword })
      });
      form.reset();
      const details = $("#recovery-disclosure");
      if (details) details.open = false;
      const loginUser = $("#login-username");
      if (loginUser) loginUser.value = username;
      const remaining = Number(res?.remainingCodes ?? 0);
      toast(`Password reset complete. ${remaining} recovery code(s) remaining. Please sign in.`);
    } catch (error) {
      if (errEl) errEl.textContent = error.message || "Recovery failed.";
    }
  });

  const genForm = $("#recovery-generate-form");
  genForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const errEl = $("#recovery-generate-error");
    if (errEl) errEl.textContent = "";
    const fd = new FormData(form);
    const currentPassword = String(fd.get("currentPassword") || "");
    try {
      const res = await api("/api/auth/recovery-codes", {
        method: "POST",
        body: JSON.stringify({ currentPassword })
      });
      form.reset();
      const box = $("#recovery-codes-box");
      const pre = $("#recovery-codes-list");
      const codes = Array.isArray(res?.recovery?.codes) ? res.recovery.codes : (Array.isArray(res?.codes) ? res.codes : []);
      if (pre) pre.textContent = codes.join("\n");
      if (box) box.hidden = codes.length === 0;
      await loadRecoveryStatus();
      toast("Generated 8 single-use recovery codes. Store them offline now.");
    } catch (error) {
      if (errEl) errEl.textContent = error.message || "Could not generate recovery codes.";
    }
  });

  $("#recovery-copy-btn")?.addEventListener("click", async () => {
    const text = $("#recovery-codes-list")?.textContent || "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast("Recovery codes copied to clipboard");
    } catch {
      toast("Select and copy the codes manually");
    }
  });
}

async function loadRecoveryStatus() {
  const statusEl = $("#recovery-status-text");
  if (!statusEl) return;
  try {
    const res = await api("/api/auth/recovery-status");
    const count = Number(res?.recovery?.remaining ?? res?.remainingCodes ?? 0);
    statusEl.textContent = count > 0
      ? `${count} single-use recovery code${count === 1 ? "" : "s"} active`
      : "No recovery codes generated yet — recommended for standalone installs.";
  } catch (error) {
    statusEl.textContent = error.message || "Recovery status unavailable.";
  }
}

async function loadStorageStatus() {
  const host = $("#storage-status-grid");
  if (!host) return;
  try {
    const res = await api("/api/core/storage/status");
    host.replaceChildren();
    const st = res?.storage || {};
    const sizeKb = Number.isFinite(st.dbSizeBytes) ? `${(st.dbSizeBytes / 1024).toFixed(1)} KB` : "—";
    const cards = [
      { label: "Backend", value: String(st.backend || "sqlite").toUpperCase() },
      { label: "Journal mode", value: String(st.journalMode || "wal").toUpperCase() },
      { label: "Schema", value: `v${st.schemaVersion ?? 3}` },
      { label: "Integrity", value: st.integrityOk ? "OK (quick_check)" : "Check needed" },
      { label: "DB size", value: sizeKb },
      { label: "Collections", value: String(st.collectionsCount ?? 0) },
      { label: "FTS5 rows", value: String(st.ftsIndexedRows ?? 0) },
      { label: "Graph edges", value: String(st.graphEdgesCount ?? 0) }
    ];
    for (const card of cards) {
      const box = document.createElement("div");
      box.className = "storage-stat-card";
      const lbl = document.createElement("span");
      lbl.className = "storage-stat-label";
      lbl.textContent = card.label;
      const val = document.createElement("strong");
      val.className = "storage-stat-value";
      val.textContent = card.value;
      box.append(lbl, val);
      host.appendChild(box);
    }
  } catch (error) {
    host.textContent = error.message || "Storage status unavailable.";
  }
}

function initStorageAndAirlock() {
  $("#storage-migrate-btn")?.addEventListener("click", async () => {
    const btn = $("#storage-migrate-btn");
    if (btn) btn.disabled = true;
    try {
      const res = await api("/api/core/storage/migrate", { method: "POST", body: "{}" });
      const migrated = res?.migration?.migratedCollections?.length ?? 0;
      await loadStorageStatus();
      toast(migrated > 0
        ? `Migrated ${migrated} legacy collection(s) and verified SQLite WAL index.`
        : "SQLite WAL storage and FTS5 index verified.");
    } catch (error) {
      toast(error.message || "Storage sync failed");
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  $("#airlock-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const out = $("#airlock-preview-output");
    const fd = new FormData(form);
    const text = String(fd.get("text") || "").trim();
    const customTermsRaw = String(fd.get("customTerms") || "");
    const customTerms = customTermsRaw.split(",").map((s) => s.trim()).filter(Boolean);
    if (!text) {
      toast("Enter sample text to preview the Split-Brain Privacy Airlock.");
      return;
    }
    try {
      const res = await api("/api/core/privacy/airlock/preview", {
        method: "POST",
        body: JSON.stringify({ text, customTerms })
      });
      const a = res?.airlock || res || {};
      if (!out) return;
      out.replaceChildren();
      out.hidden = false;

      const summary = document.createElement("div");
      summary.className = "airlock-summary-row";
      const badge = document.createElement("span");
      badge.className = "cloud-status-tag";
      badge.textContent = `${a.redactedCount ?? 0} redaction(s) · ${a.rehydrationVerified ? "Round-trip verified" : "Check"}`;
      summary.appendChild(badge);
      if (a.categoryCounts && Object.keys(a.categoryCounts).length) {
        const cats = document.createElement("span");
        cats.className = "muted";
        cats.textContent = Object.entries(a.categoryCounts).map(([k, v]) => `${k}: ${v}`).join(" · ");
        summary.appendChild(cats);
      }

      const label = document.createElement("strong");
      label.className = "airlock-out-label";
      label.textContent = "Outbound sanitized payload (sent to cloud):";
      const pre = document.createElement("pre");
      pre.className = "airlock-out-pre";
      pre.textContent = a.sanitizedText || "";

      out.append(summary, label, pre);
    } catch (error) {
      toast(error.message || "Airlock preview failed");
    }
  });

  $("#voice-ambient-refresh-btn")?.addEventListener("click", loadVoiceAndAmbientStatus);
}

async function loadVoiceAndAmbientStatus() {
  const host = $("#voice-ambient-status-list");
  if (!host) return;
  try {
    const [voiceRes, ambientRes] = await Promise.all([
      api("/api/core/voice/status"),
      api("/api/core/ambient/state")
    ]);
    host.replaceChildren();
    const v = voiceRes?.voice || {};
    const sttDetail = v.stt?.configured ? `Local Whisper (${v.stt.provider || "configured"})` : "Browser Web Speech API fallback (push-to-talk)";
    const ttsDetail = v.tts?.configured ? `Local TTS (${v.tts.provider || "configured"})` : "Browser Speech Synthesis fallback (interruptible)";
    host.appendChild(createItem("Voice Loop Policy", "Push-to-talk only · Hotword listening permanently disabled"));
    host.appendChild(createItem("Speech-to-Text (STT)", sttDetail));
    host.appendChild(createItem("Text-to-Speech (TTS)", ttsDetail));

    const bridges = ambientRes?.presence?.bridges || {};
    host.appendChild(createItem(
      "Home Assistant Bridge",
      bridges.homeAssistantConfigured ? "Configured via ALFIE_HA_URL" : "Optional — set ALFIE_HA_URL & ALFIE_HA_TOKEN"
    ));
    host.appendChild(createItem(
      "MQTT / Ambient Webhook",
      bridges.webhookConfigured ? `Configured (${bridges.mqttTopic || "alfie/presence/state"})` : `Optional — topic ${bridges.mqttTopic || "alfie/presence/state"} via ALFIE_AMBIENT_WEBHOOK_URL`
    ));
  } catch (error) {
    host.textContent = error.message || "Voice & ambient status unavailable.";
  }
}

function initHybridSearch() {
  const form = $("#workspace-search-form");
  const resultsHost = $("#workspace-search-results");
  const metaBadge = $("#hybrid-search-meta");
  if (!form || !resultsHost) return;

  const ENTITY_LABELS = {
    memory: "Memory",
    project: "Project",
    decision: "Decision",
    idea: "Idea",
    conversation: "Chat"
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const q = ($("#workspace-search-input")?.value || "").trim();
    const mode = $("#workspace-search-mode")?.value || "hybrid";
    resultsHost.replaceChildren();
    if (!q) {
      if (metaBadge) metaBadge.textContent = "Hybrid ready";
      return;
    }
    if (metaBadge) metaBadge.textContent = "Searching…";
    try {
      const params = new URLSearchParams({ q, mode, limit: "15" });
      const res = await api("/api/core/search?" + params.toString());
      const searchData = res?.search || res || {};
      const hits = Array.isArray(searchData.results) ? searchData.results : [];
      if (metaBadge) {
        const provider = searchData.semanticEngine === "python-worker-v1" ? "Python Worker" : "Local Embeddings";
        metaBadge.textContent = `${hits.length} hit(s) · ${searchData.mode === "hybrid" ? `Hybrid (${provider})` : "FTS5 Lexical"}`;
      }
      if (!hits.length) {
        const empty = document.createElement("p");
        empty.className = "muted";
        empty.textContent = `No workspace records matched "${q}".`;
        resultsHost.appendChild(empty);
        return;
      }
      for (const hit of hits) {
        const card = document.createElement("article");
        card.className = "hybrid-hit-card";
        const top = document.createElement("div");
        top.className = "hybrid-hit-top";
        const badge = document.createElement("span");
        badge.className = "hybrid-hit-kind";
        badge.textContent = ENTITY_LABELS[hit.entityType] || hit.entityType;
        const title = document.createElement("strong");
        title.className = "hybrid-hit-title";
        title.textContent = hit.title || hit.docId || hit.entityId || "Record";
        const score = document.createElement("span");
        score.className = "hybrid-hit-score";
        const src = Array.isArray(hit.matchedBy) ? hit.matchedBy.join(" + ") : (Array.isArray(hit.sources) ? hit.sources.join(" + ") : (searchData.mode || "fts5"));
        const rawScore = Number(hit.rrfScore ?? hit.hybridScore ?? hit.semanticScore ?? 0);
        score.textContent = `${src} · ${(rawScore * 100).toFixed(1)}`;
        top.append(badge, title, score);

        const body = document.createElement("p");
        body.className = "hybrid-hit-snippet muted";
        body.textContent = String(hit.snippet || hit.body || "").slice(0, 220);

        const actions = document.createElement("div");
        actions.className = "hybrid-hit-actions";
        const jumpBtn = document.createElement("button");
        jumpBtn.type = "button";
        jumpBtn.className = "secondary-button kg-action-btn";
        const rawTargetId = hit.entityId || hit.docId || "";
        const targetId = String(rawTargetId).replace(/^(conversation|project|idea|memory|decision):/i, "");
        if (hit.entityType === "conversation") {
          jumpBtn.textContent = "Open conversation";
          jumpBtn.addEventListener("click", () => {
            setView("chat");
            loadConversation(targetId).catch((e) => toast(e.message));
          });
        } else if (hit.entityType === "idea") {
          jumpBtn.textContent = "Open in Ideas Vault";
          jumpBtn.addEventListener("click", () => {
            setView("ideas");
            const searchEl = $("#idea-search");
            if (searchEl) {
              searchEl.value = hit.title || q;
              renderIdeas?.();
            }
          });
        } else if (hit.entityType === "project" || hit.entityType === "decision") {
          jumpBtn.textContent = "Inspect Project Dossier";
          jumpBtn.addEventListener("click", () => {
            const proj = state.projects.find((p) => p.id === (hit.projectId || targetId));
            if (proj && typeof openProjectModal === "function") openProjectModal(proj);
            else toast("Project dossier not found in current list.");
          });
        } else {
          jumpBtn.textContent = "Filter in Garden";
          jumpBtn.addEventListener("click", () => {
            const memSearch = $("#memory-search");
            if (memSearch) {
              memSearch.value = q;
              loadMemories().catch(() => {});
              memSearch.scrollIntoView({ behavior: "smooth", block: "center" });
            }
          });
        }
        actions.appendChild(jumpBtn);
        card.append(top, body, actions);
        resultsHost.appendChild(card);
      }
    } catch (error) {
      if (metaBadge) metaBadge.textContent = "Search error";
      resultsHost.textContent = error.message || "Search unavailable.";
    }
  });
}

async function loadReflections() {
  const metricsHost = $("#reflection-metrics");
  const bodyHost = $("#reflection-body");
  const snapWrap = $("#reflection-snapshots-wrap");
  const snapList = $("#reflection-snapshots");
  if (!metricsHost || !bodyHost) return;
  const period = state.reflectionPeriod || "weekly";
  try {
    const res = await api(`/api/core/reflections?period=${encodeURIComponent(period)}`);
    const ref = res?.reflection;
    metricsHost.replaceChildren();
    bodyHost.replaceChildren();

    if (ref?.metrics) {
      const m = ref.metrics;
      const pills = [
        { label: "Active projects", value: m.activeProjects ?? 0 },
        { label: "Recent memories", value: m.recentMemories ?? 0 },
        { label: "Open ideas", value: m.openIdeas ?? 0 },
        { label: "Open blockers", value: m.openBlockers ?? 0 },
        { label: "Learning topics", value: m.learningTopics ?? 0 },
        { label: "Active watchers", value: m.activeWatchers ?? 0 }
      ];
      for (const pill of pills) {
        const el = document.createElement("div");
        el.className = "storage-stat-card";
        const l = document.createElement("span");
        l.className = "storage-stat-label";
        l.textContent = pill.label;
        const v = document.createElement("strong");
        v.className = "storage-stat-value";
        v.textContent = String(pill.value);
        el.append(l, v);
        metricsHost.appendChild(el);
      }
    }

    if (Array.isArray(ref?.highlights) && ref.highlights.length) {
      const ul = document.createElement("ul");
      ul.className = "reflection-list";
      for (const item of ref.highlights) {
        const li = document.createElement("li");
        li.textContent = item;
        ul.appendChild(li);
      }
      bodyHost.appendChild(ul);
    } else {
      const summaryP = document.createElement("p");
      summaryP.className = "reflection-summary-text";
      summaryP.textContent = "No activity recorded yet in this window.";
      bodyHost.appendChild(summaryP);
    }

    if (Array.isArray(ref?.openBlockers) && ref.openBlockers.length) {
      const h = document.createElement("h4");
      h.className = "watchers-subhead";
      h.textContent = "Open blockers";
      const ul = document.createElement("ul");
      ul.className = "reflection-list";
      for (const b of ref.openBlockers.slice(0, 6)) {
        const li = document.createElement("li");
        li.textContent = `${b.project}: ${b.blocker || b.text || ""}`;
        ul.appendChild(li);
      }
      bodyHost.append(h, ul);
    }

    const snapshots = Array.isArray(res?.snapshots) ? res.snapshots : [];
    if (snapWrap && snapList) {
      snapList.replaceChildren();
      snapWrap.hidden = snapshots.length === 0;
      for (const snap of snapshots.slice(0, 5)) {
        const when = snap.generatedAt ? new Date(snap.generatedAt).toLocaleString() : "";
        const summary = Array.isArray(snap.highlights) && snap.highlights.length
          ? snap.highlights.join(" · ")
          : (snap.summary || "Local continuity snapshot");
        snapList.appendChild(createItem(
          `${String(snap.period || "weekly").toUpperCase()} snapshot · ${when}`,
          summary
        ));
      }
    }
  } catch (error) {
    bodyHost.textContent = error.message || "Reflections unavailable.";
  }
}

function initReflectionsAndVirtualRoom() {
  state.reflectionPeriod = "weekly";
  $("#reflection-period-tabs")?.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-reflection-period]");
    if (!btn) return;
    state.reflectionPeriod = btn.dataset.reflectionPeriod || "weekly";
    $("#reflection-period-tabs").querySelectorAll("button[data-reflection-period]").forEach((tab) => {
      const active = tab === btn;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    loadReflections();
  });

  $("#reflection-save-btn")?.addEventListener("click", async () => {
    const btn = $("#reflection-save-btn");
    if (btn) btn.disabled = true;
    try {
      await api("/api/core/reflections/snapshot", {
        method: "POST",
        body: JSON.stringify({ period: state.reflectionPeriod || "weekly" })
      });
      await loadReflections();
      toast("Local reflection snapshot saved to SQLite WAL");
    } catch (error) {
      toast(error.message || "Could not save snapshot");
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  $("#virtual-room-details")?.addEventListener("toggle", (event) => {
    if (event.currentTarget.open) {
      loadVirtualRoom();
    }
  });
  $("#virtual-room-refresh-btn")?.addEventListener("click", loadVirtualRoom);
  $("#ambient-push-btn")?.addEventListener("click", async () => {
    const btn = $("#ambient-push-btn");
    const feedback = $("#ambient-bridge-feedback");
    if (btn) btn.disabled = true;
    try {
      const res = await api("/api/core/ambient/push", { method: "POST", body: "{}" });
      const bridge = res?.bridge || {};
      const dispatched = Array.isArray(bridge.dispatched) ? bridge.dispatched.length : 0;
      const errCount = Array.isArray(bridge.errors) ? bridge.errors.length : 0;
      const haState = bridge.homeAssistantPayload?.state || "calm";
      const mqttTopic = bridge.mqttPayload?.topic || "alfie/presence/state";
      if (feedback) {
        feedback.textContent = dispatched > 0
          ? `Dispatched to ${dispatched} bridge target(s) · HA state: ${haState} · MQTT topic: ${mqttTopic}`
          : `Payload ready (HA state: ${haState}, MQTT topic: ${mqttTopic})${errCount ? ` · ${errCount} error(s)` : " · configure ALFIE_HA_URL or ALFIE_AMBIENT_WEBHOOK_URL to transmit"}`;
      }
      toast("Ambient bridge state evaluated");
    } catch (error) {
      if (feedback) feedback.textContent = error.message || "Bridge push failed.";
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

async function loadVirtualRoom() {
  const canvas = $("#virtual-room-canvas");
  const statusLine = $("#ambient-status-line");
  if (!canvas) return;
  try {
    const res = await api("/api/core/ambient/state");
    const presence = res?.presence;
    if (statusLine && presence?.soul?.statusLine) {
      statusLine.textContent = `${presence.soul.statusLine} · Time: ${presence.environment?.timeLabel || "local"}`;
    }
    window.AlfieVirtualRoom?.renderVirtualRoomSvg(canvas, presence, {
      onNavigate: (view) => setView(view)
    });
  } catch (error) {
    canvas.textContent = error.message || "Virtual room state unavailable.";
  }
}

let workshopPollTimer = null;

async function loadWorkshop() {
  if (workshopPollTimer) { clearTimeout(workshopPollTimer); workshopPollTimer = null; }
  const host = $("#workshop-job-list");
  if (!host) return;
  try {
    const res = await api("/api/core/jobs");
    host.replaceChildren();
    const jobs = Array.isArray(res?.jobs) ? res.jobs : [];
    if (!jobs.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "No specialist jobs yet. Delegate a Researcher, Auditor, Planner, or Developer task above.";
      host.appendChild(empty);
      return;
    }
    for (const job of jobs.slice(0, 12)) {
      const card = document.createElement("article");
      card.className = "workshop-job-card";

      const head = document.createElement("div");
      head.className = "workshop-job-head";
      const titleWrap = document.createElement("div");
      const title = document.createElement("strong");
      const roleLabel = job.kind === "chat_turn" ? "Chat task" : (job.role || job.roleId || "specialist");
      title.textContent = job.title || roleLabel;
      const meta = document.createElement("p");
      meta.className = "muted workshop-job-meta";
      const ceiling = Array.isArray(job.capabilityCeiling) ? job.capabilityCeiling : (Array.isArray(job.effectiveScopes) ? job.effectiveScopes : []);
      const scopesText = ceiling.length ? ceiling.join(", ") : "context-only (read)";
      const stepSuffix = Number.isFinite(job.stepsCompleted) && job.budget?.maxSteps
        ? ` · Steps: ${job.stepsCompleted}/${job.budget.maxSteps}`
        : "";
      meta.textContent = `Role: ${roleLabel}${stepSuffix} · Ceiling: ${scopesText}`;
      titleWrap.append(title, meta);

      const badges = document.createElement("div");
      badges.className = "workshop-job-badges";
      const statusPill = document.createElement("span");
      statusPill.className = `cloud-status-tag workshop-status-${job.status || "queued"}`;
      statusPill.textContent = String(job.status || "queued").replace(/_/g, " ");
      badges.appendChild(statusPill);
      if (job.tainted) {
        const taintPill = document.createElement("span");
        taintPill.className = "cloud-status-tag is-missing";
        taintPill.textContent = `Tainted (${job.lowestTrustTouched || "external"})`;
        badges.appendChild(taintPill);
      }
      if (job.status === "queued" || job.status === "running" || job.status === "awaiting_approval") {
        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "secondary-button kg-action-btn";
        cancelBtn.textContent = "Cancel";
        cancelBtn.addEventListener("click", async () => {
          await api(`/api/core/jobs/${encodeURIComponent(job.id)}/cancel`, { method: "POST", body: "{}" });
          await loadWorkshop();
          toast("Job cancelled");
        });
        badges.appendChild(cancelBtn);
      }
      head.append(titleWrap, badges);
      card.appendChild(head);
      if (job.status === "queued" || job.status === "running") {
        const progress = document.createElement("div");
        progress.className = "workshop-job-progress";
        const track = document.createElement("div");
        track.className = "workshop-job-progress-track";
        const fill = document.createElement("span");
        fill.style.width = `${Math.max(0, Math.min(100, Number(job.progress) || 0))}%`;
        track.appendChild(fill);
        const label = document.createElement("span");
        label.textContent = job.status === "queued" ? "Waiting for worker" : `Working · ${Math.max(0, Math.min(100, Number(job.progress) || 0))}%`;
        progress.append(track, label);
        card.appendChild(progress);
      }
      if (job.error && ["failed", "interrupted", "cancelled"].includes(job.status)) {
        const error = document.createElement("p");
        error.className = "muted workshop-job-error";
        error.textContent = job.error;
        card.appendChild(error);
      }

      const artifact = job.artifact || job.output || null;
      if (artifact?.summary) {
        const sum = document.createElement("p");
        sum.className = "workshop-job-summary";
        sum.textContent = artifact.summary;
        card.appendChild(sum);
      }
      if (Array.isArray(artifact?.findings) && artifact.findings.length) {
        const ul = document.createElement("ul");
        ul.className = "reflection-list";
        for (const f of artifact.findings.slice(0, 5)) {
          const li = document.createElement("li");
          li.textContent = f;
          ul.appendChild(li);
        }
        card.appendChild(ul);
      }
      if (Array.isArray(artifact?.recommendations) && artifact.recommendations.length) {
        const rec = document.createElement("p");
        rec.className = "muted workshop-job-rec";
        rec.textContent = "Next: " + artifact.recommendations.slice(0, 2).join(" · ");
        card.appendChild(rec);
      }
      host.appendChild(card);
    }
    if (jobs.some((job) => job.status === "queued" || job.status === "running")) {
      workshopPollTimer = setTimeout(() => {
        workshopPollTimer = null;
        loadWorkshop();
      }, 2500);
    }
  } catch (error) {
    host.textContent = error.message || "Workshop jobs unavailable.";
  }
}

async function loadIntegrations() {
  const host = $("#integrations-grid");
  if (!host) return;
  try {
    const res = await api("/api/core/integrations/status");
    host.replaceChildren();
    const list = Array.isArray(res?.integrations) ? res.integrations : [];
    for (const item of list) {
      const card = document.createElement("article");
      card.className = "integration-card";
      const head = document.createElement("div");
      head.className = "integration-card-head";
      const title = document.createElement("strong");
      title.textContent = item.name || item.id;
      const badge = document.createElement("span");
      badge.className = "cloud-status-tag" + (item.configured ? "" : " is-missing");
      badge.textContent = item.configured ? "Ready" : "Configure via env";
      head.append(title, badge);

      const desc = document.createElement("p");
      desc.className = "muted integration-card-desc";
      desc.textContent = item.description || "";

      const tools = document.createElement("p");
      tools.className = "integration-card-tools";
      tools.textContent = "Tools: " + (Array.isArray(item.tools) ? item.tools.join(", ") : "—");

      const scopes = document.createElement("p");
      scopes.className = "muted integration-card-scopes";
      scopes.textContent = "Scopes: " + (Array.isArray(item.scopes) ? item.scopes.join(", ") : "—");

      card.append(head, desc, tools, scopes);
      host.appendChild(card);
    }
  } catch (error) {
    host.textContent = error.message || "Integration status unavailable.";
  }
}

function initWorkshopAndIntegrations() {
  $("#workshop-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fd = new FormData(form);
    const roleId = String(fd.get("roleId") || "researcher");
    const projectId = String(fd.get("projectId") || "").trim() || null;
    const objective = String(fd.get("objective") || "").trim();
    if (!objective) return;
    try {
      const res = await api("/api/core/workshop/delegate", {
        method: "POST",
        body: JSON.stringify({ roleId, projectId, objective })
      });
      form.reset();
      await loadWorkshop();
      toast(`Delegated ${res?.role?.name || roleId} job — ${res?.job?.status || "completed"}`);
    } catch (error) {
      toast(error.message || "Workshop delegation failed");
    }
  });
  $("#refresh-workshop")?.addEventListener("click", loadWorkshop);
  $("#refresh-integrations")?.addEventListener("click", loadIntegrations);
}

// ── Phase 6.1: Sovereign Encrypted Vault ──
let lastExportedVaultArchive = null;

function downloadTextBlob(filename, content, mimeType = "application/json") {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function initPhase6Vault() {
  const fileInput = $("#vault-file-input");
  const jsonInput = $("#vault-archive-json");
  fileInput?.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file || !jsonInput) return;
    try {
      jsonInput.value = await file.text();
      toast(`Loaded ${file.name} for verification`);
    } catch {
      toast("Could not read selected vault file.");
    }
  });

  $("#vault-export-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const statusEl = $("#vault-export-status");
    const fd = new FormData(form);
    const passphrase = String(fd.get("passphrase") || "");
    try {
      if (statusEl) statusEl.textContent = "Encrypting workspace with AES-256-GCM + scrypt…";
      const res = await api("/api/core/vault/export", {
        method: "POST",
        body: JSON.stringify({ passphrase })
      });
      lastExportedVaultArchive = res.archive;
      const serialized = JSON.stringify(res.archive, null, 2);
      const stamp = new Date().toISOString().slice(0, 10);
      downloadTextBlob(`alfie-vault-${stamp}.alfie-vault.json`, serialized, "application/json");
      if (jsonInput && !jsonInput.value.trim()) {
        jsonInput.value = serialized;
      }
      if (statusEl) {
        const s = res.summary || {};
        statusEl.textContent = `Encrypted ${s.collectionCount ?? 0} collection(s) (${((s.encryptedBytes || 0) / 1024).toFixed(1)} KB · sha256: ${String(s.manifestSha256 || "").slice(0, 12)}…)`;
      }
      form.reset();
      toast("Encrypted sovereign vault exported");
    } catch (error) {
      if (statusEl) statusEl.textContent = error.message || "Vault export failed.";
      toast(error.message || "Vault export failed");
    }
  });

  function readArchiveInput() {
    const raw = ($("#vault-archive-json")?.value || "").trim();
    if (!raw) throw new Error("Load or paste an .alfie-vault.json archive first.");
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("Vault archive text is not valid JSON.");
    }
  }

  $("#vault-verify-btn")?.addEventListener("click", async () => {
    const statusEl = $("#vault-restore-status");
    const passphrase = $("#vault-restore-passphrase")?.value || "";
    try {
      const archive = readArchiveInput();
      if (statusEl) statusEl.textContent = "Verifying AES-256-GCM tag and SHA-256 manifest…";
      const res = await api("/api/core/vault/verify", {
        method: "POST",
        body: JSON.stringify({ archive, passphrase })
      });
      const v = res.verification || {};
      const countSummary = Object.entries(v.counts || {}).map(([k, n]) => `${k.replace(".json", "")}: ${n}`).join(" · ");
      if (statusEl) {
        statusEl.textContent = `Verified valid (${v.collectionCount ?? 0} collections · ${countSummary || "empty"} · sha256: ${String(v.manifestSha256 || "").slice(0, 12)}…)`;
      }
      toast("Vault archive integrity verified");
    } catch (error) {
      if (statusEl) statusEl.textContent = error.message || "Verification failed.";
      toast(error.message || "Vault verification failed");
    }
  });

  $("#vault-restore-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const statusEl = $("#vault-restore-status");
    const passphrase = $("#vault-restore-passphrase")?.value || "";
    const mode = $("#vault-restore-mode")?.value === "replace" ? "replace" : "merge";
    try {
      const archive = readArchiveInput();
      if (mode === "replace") {
        const collectionNames = Object.keys(archive?.collections || {});
        const collectionSummary = collectionNames.length
          ? collectionNames.map((name) => name.replace(/\.json$/i, "")).join(", ")
          : "no collections";
        const confirmed = window.confirm(
          "Overwrite local data from this encrypted backup?\n\n" +
          "Collections included in this archive will replace their current local contents. " +
          "Collections not included in the archive will remain unchanged.\n\n" +
          "Included: " + collectionSummary + "\n\nThis cannot be undone unless you have a separate backup."
        );
        if (!confirmed) {
          if (statusEl) statusEl.textContent = "Restore cancelled.";
          return;
        }
      }
      if (statusEl) statusEl.textContent = `Restoring vault (${mode} mode)…`;
      const res = await api("/api/core/vault/restore", {
        method: "POST",
        body: JSON.stringify({ archive, passphrase, mode })
      });
      const r = res.restored || {};
      if (statusEl) {
        statusEl.textContent = `Restored ${r.restoredCollections?.length ?? 0} collection(s) in ${r.mode || mode} mode.`;
      }
      form.reset();
      await Promise.all([loadStorageStatus(), loadDiagnosticsAudit(), loadProjects()]);
      toast(`Vault restored (${r.mode || mode} mode)`);
    } catch (error) {
      if (statusEl) statusEl.textContent = error.message || "Vault restore failed.";
      toast(error.message || "Vault restore failed");
    }
  });
}

// ── Phase 6.2: Deterministic Workspace Self-Audit Diagnostics ──
async function loadDiagnosticsAudit() {
  const host = $("#diagnostics-checks-list");
  const badge = $("#diagnostics-score-badge");
  if (!host) return;
  try {
    const res = await api("/api/core/diagnostics/audit");
    const audit = res?.audit || {};
    host.replaceChildren();
    if (badge) {
      badge.textContent = `Score ${audit.score ?? 100}/100 · Grade ${audit.grade || "A"}`;
      badge.className = "cloud-status-tag" + ((audit.score ?? 100) < 80 ? " is-missing" : "");
    }
    const checks = Array.isArray(audit.checks) ? audit.checks : [];
    for (const check of checks) {
      const card = document.createElement("article");
      card.className = `diagnostic-check-card is-${check.status || "pass"}`;
      const head = document.createElement("div");
      head.className = "integration-card-head";
      const title = document.createElement("strong");
      title.textContent = check.title || check.id;
      const statusTag = document.createElement("span");
      statusTag.className = "cloud-status-tag" + (check.status === "pass" ? "" : " is-missing");
      statusTag.textContent = String(check.status || "pass").toUpperCase();
      head.append(title, statusTag);

      const detail = document.createElement("p");
      detail.className = "muted integration-card-desc";
      detail.textContent = `${check.category || "System"} · ${check.detail || ""}`;

      card.append(head, detail);
      host.appendChild(card);
    }
  } catch (error) {
    if (badge) badge.textContent = "Audit error";
    host.textContent = error.message || "Workspace diagnostics unavailable.";
  }
}

function initPhase6Diagnostics() {
  $("#diagnostics-refresh-btn")?.addEventListener("click", loadDiagnosticsAudit);
  document.querySelectorAll("[data-remediate-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const action = btn.dataset.remediateAction;
      if (!action) return;
      btn.disabled = true;
      try {
        const res = await api("/api/core/diagnostics/remediate", {
          method: "POST",
          body: JSON.stringify({ action })
        });
        await Promise.all([loadDiagnosticsAudit(), loadStorageStatus()]);
        toast(res?.remediation?.detail || "Maintenance action completed");
      } catch (error) {
        toast(error.message || "Remediation failed");
      } finally {
        btn.disabled = false;
      }
    });
  });
}

// ── Phase 6.3: Scoped Peer Client Tokens ──
async function loadPeerTokens() {
  const host = $("#peer-tokens-list");
  if (!host) return;
  try {
    const res = await api("/api/core/clients/tokens");
    const tokens = Array.isArray(res?.tokens) ? res.tokens : [];
    host.replaceChildren();
    if (!tokens.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "No peer client tokens minted yet. Create one above to connect bin/alfie-cli.mjs or quick-capture shortcuts.";
      host.appendChild(empty);
      return;
    }
    for (const tok of tokens) {
      const card = document.createElement("article");
      card.className = "workshop-job-card";
      const head = document.createElement("div");
      head.className = "workshop-job-head";
      const left = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = tok.name || tok.prefix;
      const meta = document.createElement("p");
      meta.className = "muted workshop-job-meta";
      const lastUsed = tok.lastUsedAt ? `Last used: ${new Date(tok.lastUsedAt).toLocaleString()}` : "Never used";
      const exp = tok.expiresAt ? ` · Expires: ${new Date(tok.expiresAt).toLocaleDateString()}` : "";
      meta.textContent = `${tok.prefix} · Scopes: ${(tok.scopes || []).join(", ")} · ${lastUsed}${exp}`;
      left.append(title, meta);

      const right = document.createElement("div");
      right.className = "workshop-job-badges";
      const badge = document.createElement("span");
      badge.className = "cloud-status-tag" + (tok.revokedAt ? " is-missing" : "");
      badge.textContent = tok.revokedAt ? "Revoked" : "Active";
      right.appendChild(badge);
      if (!tok.revokedAt) {
        const revokeBtn = document.createElement("button");
        revokeBtn.type = "button";
        revokeBtn.className = "secondary-button kg-action-btn";
        revokeBtn.textContent = "Revoke";
        revokeBtn.addEventListener("click", async () => {
          await api(`/api/core/clients/tokens/${encodeURIComponent(tok.id)}`, { method: "DELETE" });
          await loadPeerTokens();
          toast(`Revoked peer token "${tok.name}"`);
        });
        right.appendChild(revokeBtn);
      }
      head.append(left, right);
      card.appendChild(head);
      host.appendChild(card);
    }
  } catch (error) {
    host.textContent = error.message || "Peer client tokens unavailable.";
  }
}

function initPhase6PeerTokens() {
  let latestPeerToken = "";
  $("#peer-token-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fd = new FormData(form);
    const name = String(fd.get("name") || "").trim();
    const expiresInDays = Number(fd.get("expiresInDays") || 90);
    const scopes = fd.getAll("scopes").map((s) => String(s));
    if (!name) return;
    try {
      const res = await api("/api/core/clients/tokens", {
        method: "POST",
        body: JSON.stringify({ name, scopes, expiresInDays })
      });
      latestPeerToken = res?.token || "";
      const box = $("#peer-token-reveal-box");
      const pre = $("#peer-token-reveal-pre");
      if (box && pre && latestPeerToken) {
        const origin = window.location.origin;
        pre.textContent = [
          `Token: ${latestPeerToken}`,
          "",
          "# Quick-capture CLI example:",
          `ALFIE_URL=${origin} ALFIE_TOKEN="${latestPeerToken}" node bin/alfie-cli.mjs status`
        ].join("\n");
        box.hidden = false;
      }
      form.reset();
      await loadPeerTokens();
      toast(`Minted peer token "${res?.record?.name || name}"`);
    } catch (error) {
      toast(error.message || "Could not mint peer token");
    }
  });
  $("#peer-token-copy-btn")?.addEventListener("click", async () => {
    if (!latestPeerToken) return;
    try {
      await navigator.clipboard.writeText(latestPeerToken);
      toast("Peer token copied to clipboard");
    } catch {
      toast("Select and copy the token from the box.");
    }
  });
  $("#refresh-peer-tokens")?.addEventListener("click", loadPeerTokens);
}

// ── Phase 6.4: Deterministic Playbooks ──
async function loadPlaybooks() {
  const host = $("#playbooks-list");
  if (!host) return;
  try {
    const res = await api("/api/core/playbooks");
    const list = Array.isArray(res?.playbooks) ? res.playbooks : [];
    host.replaceChildren();
    if (!list.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "No deterministic playbooks configured yet. Create a safe rule above to automate reviews, reflections, or idea capture.";
      host.appendChild(empty);
      return;
    }
    for (const pb of list) {
      const card = document.createElement("article");
      card.className = "workshop-job-card";
      const head = document.createElement("div");
      head.className = "workshop-job-head";
      const left = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = pb.name;
      const meta = document.createElement("p");
      meta.className = "muted workshop-job-meta";
      meta.textContent = `Trigger: ${pb.trigger.replace(/_/g, " ")} · Action: ${pb.action.replace(/_/g, " ")} · Runs: ${pb.runCount ?? 0}`;
      left.append(title, meta);

      const badges = document.createElement("div");
      badges.className = "workshop-job-badges";
      const statusTag = document.createElement("span");
      statusTag.className = "cloud-status-tag" + (pb.enabled ? "" : " is-missing");
      statusTag.textContent = pb.enabled ? "Enabled" : "Paused";
      badges.appendChild(statusTag);

      const previewBtn = document.createElement("button");
      previewBtn.type = "button";
      previewBtn.className = "secondary-button kg-action-btn";
      previewBtn.textContent = "Dry-run";
      previewBtn.addEventListener("click", async () => {
        const out = await api(`/api/core/playbooks/${encodeURIComponent(pb.id)}/run`, {
          method: "POST",
          body: JSON.stringify({ dryRun: true })
        });
        const fb = $("#playbook-preview-feedback");
        if (fb) fb.textContent = `Dry-run (${pb.name}): ${out?.preview?.summary || "Safe deterministic action."}`;
        toast("Dry-run preview ready");
      });

      const runBtn = document.createElement("button");
      runBtn.type = "button";
      runBtn.className = "secondary-button kg-action-btn";
      runBtn.textContent = "Run now";
      runBtn.addEventListener("click", async () => {
        runBtn.disabled = true;
        try {
          const out = await api(`/api/core/playbooks/${encodeURIComponent(pb.id)}/run`, {
            method: "POST",
            body: JSON.stringify({ dryRun: false })
          });
          const fb = $("#playbook-preview-feedback");
          if (fb) fb.textContent = `Executed (${pb.name}): ${out?.outcomeSummary || "Completed."}`;
          await Promise.all([loadPlaybooks(), loadWorkshop()]);
          toast(`Playbook "${pb.name}" executed`);
        } finally {
          runBtn.disabled = false;
        }
      });

      const toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.className = "secondary-button kg-action-btn";
      toggleBtn.textContent = pb.enabled ? "Pause" : "Enable";
      toggleBtn.addEventListener("click", async () => {
        await api(`/api/core/playbooks/${encodeURIComponent(pb.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ enabled: !pb.enabled })
        });
        await loadPlaybooks();
      });

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "secondary-button kg-action-btn";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", async () => {
        await api(`/api/core/playbooks/${encodeURIComponent(pb.id)}`, { method: "DELETE" });
        await loadPlaybooks();
        toast(`Deleted playbook "${pb.name}"`);
      });

      badges.append(previewBtn, runBtn, toggleBtn, delBtn);
      head.append(left, badges);
      card.appendChild(head);

      if (pb.lastOutcome) {
        const outP = document.createElement("p");
        outP.className = "workshop-job-summary";
        outP.textContent = `Last outcome: ${pb.lastOutcome}`;
        card.appendChild(outP);
      }
      host.appendChild(card);
    }
  } catch (error) {
    host.textContent = error.message || "Playbooks unavailable.";
  }
}

function initPhase6Playbooks() {
  $("#playbook-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fd = new FormData(form);
    const name = String(fd.get("name") || "").trim();
    const trigger = String(fd.get("trigger") || "manual_run");
    const action = String(fd.get("action") || "delegate_workshop");
    const roleId = String(fd.get("roleId") || "auditor");
    const objective = String(fd.get("objective") || "").trim();
    if (!name) return;
    const config = action === "delegate_workshop"
      ? { roleId, objective: objective || `Review workspace via ${name}` }
      : action === "generate_reflection"
        ? { period: "weekly" }
        : action === "park_idea"
          ? { title: objective || name, notes: "Captured by deterministic Alfie Playbook" }
          : { summary: objective || `Calm digest recorded by ${name}` };
    try {
      await api("/api/core/playbooks", {
        method: "POST",
        body: JSON.stringify({ name, trigger, action, config, enabled: true })
      });
      form.reset();
      await loadPlaybooks();
      toast(`Created playbook "${name}"`);
    } catch (error) {
      toast(error.message || "Could not create playbook");
    }
  });
  $("#refresh-playbooks")?.addEventListener("click", loadPlaybooks);
}

// ── Phase 6.5: Chronological Continuity Timeline & Markdown Digest ──
async function loadTimeline() {
  const host = $("#timeline-list");
  if (!host) return;
  const kind = state.timelineKind || "all";
  try {
    const res = await api(`/api/core/timeline?kind=${encodeURIComponent(kind)}&limit=30`);
    const tl = res?.timeline || {};
    const events = Array.isArray(tl.events) ? tl.events : [];
    host.replaceChildren();
    if (!events.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "No continuity events recorded for this filter yet.";
      host.appendChild(empty);
      return;
    }
    for (const ev of events) {
      const row = document.createElement("article");
      row.className = "timeline-row";
      const top = document.createElement("div");
      top.className = "hybrid-hit-top";
      const kindBadge = document.createElement("span");
      kindBadge.className = "hybrid-hit-kind";
      kindBadge.textContent = ev.kind || "event";
      const title = document.createElement("strong");
      title.className = "hybrid-hit-title";
      title.textContent = ev.title || "Workspace event";
      const meta = document.createElement("span");
      meta.className = "hybrid-hit-score";
      const when = ev.at ? new Date(ev.at).toLocaleString() : "";
      meta.textContent = [ev.trust, when].filter(Boolean).join(" · ");
      top.append(kindBadge, title, meta);

      const detail = document.createElement("p");
      detail.className = "hybrid-hit-snippet muted";
      detail.textContent = ev.detail || "";

      row.append(top, detail);
      host.appendChild(row);
    }
  } catch (error) {
    host.textContent = error.message || "Timeline unavailable.";
  }
}

function initPhase6Timeline() {
  state.timelineKind = "all";
  let lastDigest = null;

  $("#timeline-kind-tabs")?.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-timeline-kind]");
    if (!btn) return;
    state.timelineKind = btn.dataset.timelineKind || "all";
    $("#timeline-kind-tabs").querySelectorAll("button[data-timeline-kind]").forEach((tab) => {
      const active = tab === btn;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    loadTimeline();
  });

  $("#timeline-refresh-btn")?.addEventListener("click", loadTimeline);

  $("#markdown-digest-btn")?.addEventListener("click", async () => {
    const btn = $("#markdown-digest-btn");
    if (btn) btn.disabled = true;
    try {
      const res = await api("/api/core/export/markdown");
      lastDigest = res?.digest || null;
      const box = $("#markdown-digest-box");
      const pre = $("#markdown-digest-pre");
      const meta = $("#markdown-digest-meta");
      if (box && pre && lastDigest) {
        if (meta) meta.textContent = `${lastDigest.filename} (${((lastDigest.byteLength || 0) / 1024).toFixed(1)} KB)`;
        pre.textContent = lastDigest.markdown || "";
        box.hidden = false;
      }
      toast("Portable Markdown digest generated");
    } catch (error) {
      toast(error.message || "Markdown export failed");
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  $("#markdown-digest-copy-btn")?.addEventListener("click", async () => {
    if (!lastDigest?.markdown) return;
    try {
      await navigator.clipboard.writeText(lastDigest.markdown);
      toast("Markdown digest copied");
    } catch {
      toast("Copy failed — use Download .md instead.");
    }
  });

  $("#markdown-digest-download-btn")?.addEventListener("click", () => {
    if (!lastDigest?.markdown) return;
    downloadTextBlob(lastDigest.filename || "alfie-knowledge-digest.md", lastDigest.markdown, "text/markdown");
    toast("Downloaded Markdown digest");
  });
}

// ── V1 Provider Setup & Model Management ──
const providerPanelState = {
  config: { mode: "auto", healthIntervalSeconds: 30, endpoints: [], source: "environment", updatedAt: null },
  healthById: new Map(),
  editingId: null,
  confirmDeleteId: null,
  discoveredModels: []
};

function isLocalLikeUrl(urlStr) {
  try {
    const parsed = new URL(String(urlStr || "").trim());
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!host) return false;
    if (["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host)) return true;
    if (!host.includes(".")) return true;
    if (/^(10\.|192\.168\.|127\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return true;
    return host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".internal");
  } catch {
    return false;
  }
}

function populateEditorModelSelect(models = [], currentModel = "") {
  const select = $("#provider-field-model-select");
  if (!select) return;
  const cleanModels = [...new Set((Array.isArray(models) ? models : []).map((m) => String(m || "").trim()).filter(Boolean))];
  select.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = cleanModels.length
    ? `Select from ${cleanModels.length} installed model${cleanModels.length === 1 ? "" : "s"}…`
    : "Run Test connection to discover installed models…";
  select.appendChild(placeholder);
  for (const modelName of cleanModels) {
    const opt = document.createElement("option");
    opt.value = modelName;
    opt.textContent = modelName;
    if (modelName === currentModel) opt.selected = true;
    select.appendChild(opt);
  }
  if (currentModel && !cleanModels.includes(currentModel)) {
    const customOpt = document.createElement("option");
    customOpt.value = currentModel;
    customOpt.textContent = `${currentModel} (configured)`;
    customOpt.selected = true;
    select.appendChild(customOpt);
  }
}

function setProviderTestResult(result, isError = false) {
  const box = $("#provider-test-result");
  if (!box) return;
  box.replaceChildren();
  if (!result) {
    box.hidden = true;
    box.className = "provider-test-result";
    return;
  }
  box.hidden = false;
  box.className = `provider-test-result ${isError || !result.online ? "is-error" : "is-ok"}`;
  const heading = document.createElement("strong");
  if (isError || !result.online) {
    heading.textContent = "Connection failed";
  } else {
    const latency = Number.isFinite(result.latencyMs) ? ` · ${result.latencyMs} ms` : "";
    const count = Array.isArray(result.models) ? result.models.length : 0;
    heading.textContent = `Connected${latency} · ${count} model${count === 1 ? "" : "s"} discovered`;
  }
  const detail = document.createElement("p");
  if (isError || !result.online) {
    detail.textContent = result.error || "Could not reach endpoint. Check the URL, server status, and Trusted local setting.";
  } else if (result.modelAvailable === false) {
    detail.textContent = "Server is reachable, but the currently entered model name was not found in the installed list. Choose one below.";
  } else if (Array.isArray(result.models) && result.models.length) {
    detail.textContent = `Available: ${result.models.slice(0, 6).join(", ")}${result.models.length > 6 ? ` (+${result.models.length - 6} more)` : ""}`;
  } else {
    detail.textContent = "Server responded, but reported no installed models yet.";
  }
  box.append(heading, detail);
}

function closeProviderEditor() {
  const panel = $("#provider-editor-panel");
  if (panel) panel.hidden = true;
  providerPanelState.editingId = null;
  providerPanelState.discoveredModels = [];
  const err = $("#provider-form-error");
  if (err) err.textContent = "";
  setProviderTestResult(null);
}

function openProviderEditor(endpoint = null) {
  const panel = $("#provider-editor-panel");
  if (!panel) return;
  const isEdit = Boolean(endpoint);
  providerPanelState.editingId = isEdit ? endpoint.id : null;
  const health = isEdit ? providerPanelState.healthById.get(endpoint.id) : null;
  const models = Array.isArray(health?.models) ? health.models : [];
  providerPanelState.discoveredModels = models;

  $("#provider-editor-title").textContent = isEdit ? `Edit endpoint: ${endpoint.name || endpoint.id}` : "Add model endpoint";
  $("#provider-field-id").value = isEdit ? endpoint.id : "";
  $("#provider-field-name").value = isEdit ? (endpoint.name || "") : "";
  const savedBaseUrl = isEdit ? (endpoint.baseUrl || "") : "";
  const lowerSavedUrl = savedBaseUrl.toLowerCase();
  const isGeminiEndpoint = lowerSavedUrl.includes("generativelanguage.googleapis.com/v1beta/openai");
  const isOpenAiEndpoint = lowerSavedUrl.includes("api.openai.com");
  const detectedType = isGeminiEndpoint
    ? "google-gemini"
    : (isOpenAiEndpoint ? "openai" : (isEdit ? (endpoint.provider || "ollama") : "ollama"));
  $("#provider-field-type").value = detectedType;
  $("#provider-field-url").value = isEdit ? savedBaseUrl : "http://127.0.0.1:11434";
  applyProviderEditorPreset(detectedType, { autofillUrl: !isEdit, autofillName: false, focusCredential: false });
  $("#provider-field-mode").value = isEdit ? (endpoint.mode || "standard") : "standard";
  $("#provider-field-priority").value = String(isEdit ? (endpoint.priority ?? 50) : 60);
  $("#provider-field-temperature").value = String(isEdit ? (endpoint.temperature ?? 0.4) : 0.4);
  $("#provider-field-max-tokens").value = String(isEdit ? (endpoint.maxTokens ?? 700) : 700);
  $("#provider-field-trusted-local").checked = isEdit ? Boolean(endpoint.trustedLocal) : (detectedType === "ollama");
  $("#provider-field-enabled").checked = isEdit ? endpoint.enabled !== false : true;
  $("#provider-field-credential").value = "";
  $("#provider-field-clear-key").checked = false;

  const secretHint = $("#provider-secret-hint");
  const clearWrap = $("#provider-clear-key-wrap");
  if (isEdit && endpoint.apiKeyConfigured) {
    if (secretHint) secretHint.textContent = "An encrypted API key is saved on the server. Leave blank to keep it, enter a new key to replace it, or check clear below.";
    if (clearWrap) clearWrap.hidden = false;
  } else {
    if (secretHint) secretHint.textContent = "Encrypted on the server and never sent back to the browser.";
    if (clearWrap) clearWrap.hidden = true;
  }

  $("#provider-field-model").value = isEdit ? (endpoint.model || "") : "";
  populateEditorModelSelect(models, isEdit ? (endpoint.model || "") : "");
  const err = $("#provider-form-error");
  if (err) err.textContent = "";
  setProviderTestResult(null);
  panel.hidden = false;
  $("#provider-field-name")?.focus();
}

function buildEndpointPayloadFromForm() {
  const credential = $("#provider-field-credential")?.value?.trim() || "";
  const clearKey = Boolean($("#provider-field-clear-key")?.checked);
  const payload = {
    name: $("#provider-field-name")?.value?.trim() || "",
    provider: $("#provider-field-type")?.value === "ollama" ? "ollama" : "openai-compatible",
    baseUrl: $("#provider-field-url")?.value?.trim() || "",
    mode: $("#provider-field-mode")?.value || "standard",
    priority: Number($("#provider-field-priority")?.value || 50),
    temperature: Number($("#provider-field-temperature")?.value ?? 0.4),
    maxTokens: Number($("#provider-field-max-tokens")?.value || 700),
    trustedLocal: Boolean($("#provider-field-trusted-local")?.checked),
    enabled: Boolean($("#provider-field-enabled")?.checked),
    model: $("#provider-field-model")?.value?.trim() || ""
  };
  if (credential) payload.apiKey = credential;
  if (clearKey) payload.clearApiKey = true;
  return payload;
}

function renderProvidersPanel() {
  const cfg = providerPanelState.config || { mode: "auto", healthIntervalSeconds: 30, endpoints: [] };
  const modeSelect = $("#provider-default-mode");
  const intervalInput = $("#provider-health-interval");
  const sourceEl = $("#provider-config-source");
  const listHost = $("#provider-endpoints-list");

  if (modeSelect) modeSelect.value = cfg.mode || "auto";
  if (intervalInput) intervalInput.value = String(cfg.healthIntervalSeconds || 30);

  const endpoints = Array.isArray(cfg.endpoints) ? [...cfg.endpoints] : [];
  endpoints.sort((a, b) => (b.priority ?? 50) - (a.priority ?? 50));

  const enabledCount = endpoints.filter((ep) => ep.enabled !== false).length;
  const sourceLabel = cfg.source === "persisted" ? "Saved in workspace" : "Environment defaults";
  if (sourceEl) {
    sourceEl.textContent = `${sourceLabel} · ${endpoints.length} endpoint${endpoints.length === 1 ? "" : "s"} (${enabledCount} enabled)`;
  }

  if (!listHost) return;
  listHost.replaceChildren();

  if (!endpoints.length) {
    const empty = document.createElement("div");
    empty.className = "provider-empty-state";
    const title = document.createElement("strong");
    title.textContent = "No model endpoints configured yet";
    const copy = document.createElement("p");
    copy.className = "muted";
    copy.textContent = "Add a local Ollama server or an OpenAI-compatible endpoint to run Alfie with your chosen models. You can test connectivity and inspect installed models before saving.";
    const cta = document.createElement("button");
    cta.type = "button";
    cta.className = "primary-button";
    cta.textContent = "Add your first endpoint";
    cta.addEventListener("click", () => openProviderEditor(null));
    empty.append(title, copy, cta);
    listHost.appendChild(empty);
    return;
  }

  for (let idx = 0; idx < endpoints.length; idx += 1) {
    const ep = endpoints[idx];
    const health = providerPanelState.healthById.get(ep.id) || null;
    const installedModels = Array.isArray(health?.models) ? health.models : [];
    const card = document.createElement("article");
    card.className = `provider-endpoint-card${ep.enabled === false ? " is-disabled" : ""}${health?.online ? " is-online" : ""}`;
    card.dataset.endpointId = ep.id;

    // Header row
    const head = document.createElement("div");
    head.className = "provider-card-head";
    const titleWrap = document.createElement("div");
    titleWrap.className = "provider-card-title";
    const nameEl = document.createElement("strong");
    nameEl.textContent = ep.name || ep.id;
    const metaEl = document.createElement("span");
    metaEl.className = "provider-card-meta";
    const metaParts = [
      ep.provider === "ollama" ? "Ollama" : "OpenAI-compatible",
      `Priority ${ep.priority ?? 50}`,
      `${(ep.mode || "standard").charAt(0).toUpperCase()}${(ep.mode || "standard").slice(1)} tier`,
      ep.trustedLocal ? "Trusted local" : "External",
      ep.apiKeyConfigured ? "API key saved" : "No API key"
    ];
    metaEl.textContent = metaParts.join(" · ");
    titleWrap.append(nameEl, metaEl);

    const statusText = document.createElement("span");
    statusText.className = "provider-status-text";
    if (ep.enabled === false) {
      statusText.classList.add("is-muted");
      statusText.textContent = "Disabled";
    } else if (!health) {
      statusText.classList.add("is-muted");
      statusText.textContent = "Checking…";
    } else if (!health.online) {
      statusText.classList.add("is-error");
      statusText.textContent = "Offline";
    } else if (!ep.model) {
      statusText.classList.add("is-warn");
      statusText.textContent = `Online · ${health.latencyMs} ms · Select model`;
    } else if (health.modelAvailable === false) {
      statusText.classList.add("is-warn");
      statusText.textContent = `Online · ${health.latencyMs} ms · Model missing`;
    } else {
      statusText.classList.add("is-ok");
      statusText.textContent = `Online · ${health.latencyMs} ms`;
    }
    head.append(titleWrap, statusText);
    card.appendChild(head);

    // URL + active model row
    const details = document.createElement("div");
    details.className = "provider-card-details";
    const urlLine = document.createElement("div");
    urlLine.className = "provider-detail-row";
    const urlLabel = document.createElement("span");
    urlLabel.className = "provider-detail-label";
    urlLabel.textContent = "Endpoint";
    const urlCode = document.createElement("code");
    urlCode.className = "provider-detail-code";
    urlCode.textContent = ep.baseUrl;
    urlLine.append(urlLabel, urlCode);

    const modelLine = document.createElement("div");
    modelLine.className = "provider-detail-row";
    const modelLabel = document.createElement("span");
    modelLabel.className = "provider-detail-label";
    modelLabel.textContent = "Active model";
    if (installedModels.length) {
      const quickSelect = document.createElement("select");
      quickSelect.className = "provider-inline-model-select";
      quickSelect.setAttribute("aria-label", `Select model for ${ep.name || ep.id}`);
      if (!ep.model) {
        const emptyOpt = document.createElement("option");
        emptyOpt.value = "";
        emptyOpt.textContent = "Choose a model…";
        quickSelect.appendChild(emptyOpt);
      } else if (!installedModels.includes(ep.model)) {
        const missingOpt = document.createElement("option");
        missingOpt.value = ep.model;
        missingOpt.textContent = `${ep.model} (not on server)`;
        missingOpt.selected = true;
        quickSelect.appendChild(missingOpt);
      }
      for (const m of installedModels) {
        const opt = document.createElement("option");
        opt.value = m;
        opt.textContent = m;
        if (m === ep.model) opt.selected = true;
        quickSelect.appendChild(opt);
      }
      quickSelect.addEventListener("change", async () => {
        const chosen = quickSelect.value;
        if (!chosen || chosen === ep.model) return;
        quickSelect.disabled = true;
        try {
          const res = await api(`/api/core/providers/endpoints/${encodeURIComponent(ep.id)}`, {
            method: "PATCH",
            body: JSON.stringify({ model: chosen })
          });
          if (res?.config) providerPanelState.config = res.config;
          const updatedHealth = providerPanelState.healthById.get(ep.id);
          if (updatedHealth) {
            updatedHealth.modelAvailable = installedModels.includes(chosen);
          }
          renderProvidersPanel();
          toast(`Active model switched to ${chosen}`);
        } catch (error) {
          toast(error.message || "Could not update model");
          quickSelect.value = ep.model || "";
        } finally {
          quickSelect.disabled = false;
        }
      });
      modelLine.append(modelLabel, quickSelect);
    } else {
      const modelVal = document.createElement("span");
      modelVal.className = "provider-detail-value";
      modelVal.textContent = ep.model || "None selected";
      modelLine.append(modelLabel, modelVal);
    }
    details.append(urlLine, modelLine);
    card.appendChild(details);

    // Installed model summary or error message
    if (health && !health.online && health.error) {
      const errBox = document.createElement("p");
      errBox.className = "provider-card-error";
      errBox.textContent = health.error;
      card.appendChild(errBox);
    } else if (health?.online && ep.model && health.modelAvailable === false) {
      const warnBox = document.createElement("p");
      warnBox.className = "provider-card-warn";
      warnBox.textContent = `Configured model "${ep.model}" was not listed by this server. Select one of the ${installedModels.length} installed model(s) above.`;
      card.appendChild(warnBox);
    }

    const inventory = document.createElement("p");
    inventory.className = "provider-inventory-line muted";
    if (installedModels.length) {
      const preview = installedModels.slice(0, 6).join(" · ");
      inventory.textContent = `Installed (${installedModels.length}): ${preview}${installedModels.length > 6 ? ` · +${installedModels.length - 6} more` : ""}`;
    } else if (health?.online) {
      inventory.textContent = "Server online · No installed models reported.";
    } else {
      inventory.textContent = "Test connection to inspect installed models on this endpoint.";
    }
    card.appendChild(inventory);

    // Actions row
    const actions = document.createElement("div");
    actions.className = "provider-card-actions";

    const testBtn = document.createElement("button");
    testBtn.type = "button";
    testBtn.className = "secondary-button";
    testBtn.textContent = "Test";
    testBtn.addEventListener("click", async () => {
      testBtn.disabled = true;
      testBtn.textContent = "Testing…";
      try {
        const res = await api("/api/core/providers/test", {
          method: "POST",
          body: JSON.stringify({ id: ep.id })
        });
        providerPanelState.healthById.set(ep.id, res);
        renderProvidersPanel();
        toast(res.online ? `${ep.name} online (${res.models?.length || 0} models)` : `${ep.name} offline: ${res.error || "unreachable"}`);
      } catch (error) {
        toast(error.message || "Test failed");
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = "Test";
      }
    });

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "secondary-button";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => openProviderEditor(ep));

    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "secondary-button";
    toggleBtn.textContent = ep.enabled === false ? "Enable" : "Disable";
    toggleBtn.addEventListener("click", async () => {
      toggleBtn.disabled = true;
      try {
        const res = await api(`/api/core/providers/endpoints/${encodeURIComponent(ep.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ enabled: ep.enabled === false })
        });
        if (res?.config) providerPanelState.config = res.config;
        renderProvidersPanel();
        toast(ep.enabled === false ? `Enabled ${ep.name}` : `Disabled ${ep.name}`);
      } catch (error) {
        toast(error.message || "Could not update endpoint");
      } finally {
        toggleBtn.disabled = false;
      }
    });

    actions.append(testBtn, editBtn, toggleBtn);

    if (endpoints.length > 1) {
      const upBtn = document.createElement("button");
      upBtn.type = "button";
      upBtn.className = "secondary-button provider-order-btn";
      upBtn.textContent = "Higher";
      upBtn.disabled = idx === 0;
      upBtn.setAttribute("aria-label", `Increase priority for ${ep.name || ep.id}`);
      upBtn.addEventListener("click", () => reorderProviderEndpoint(ep.id, -1));

      const downBtn = document.createElement("button");
      downBtn.type = "button";
      downBtn.className = "secondary-button provider-order-btn";
      downBtn.textContent = "Lower";
      downBtn.disabled = idx === endpoints.length - 1;
      downBtn.setAttribute("aria-label", `Decrease priority for ${ep.name || ep.id}`);
      downBtn.addEventListener("click", () => reorderProviderEndpoint(ep.id, 1));
      actions.append(upBtn, downBtn);
    }

    if (providerPanelState.confirmDeleteId === ep.id) {
      const confirmBtn = document.createElement("button");
      confirmBtn.type = "button";
      confirmBtn.className = "secondary-button is-danger";
      confirmBtn.textContent = "Confirm remove";
      confirmBtn.addEventListener("click", async () => {
        confirmBtn.disabled = true;
        try {
          const res = await api(`/api/core/providers/endpoints/${encodeURIComponent(ep.id)}`, { method: "DELETE" });
          providerPanelState.confirmDeleteId = null;
          providerPanelState.healthById.delete(ep.id);
          if (providerPanelState.editingId === ep.id) closeProviderEditor();
          if (res?.config) providerPanelState.config = res.config;
          renderProvidersPanel();
          toast(`Removed endpoint ${ep.name}`);
        } catch (error) {
          toast(error.message || "Could not remove endpoint");
        } finally {
          confirmBtn.disabled = false;
        }
      });
      const cancelDelBtn = document.createElement("button");
      cancelDelBtn.type = "button";
      cancelDelBtn.className = "secondary-button";
      cancelDelBtn.textContent = "Keep";
      cancelDelBtn.addEventListener("click", () => {
        providerPanelState.confirmDeleteId = null;
        renderProvidersPanel();
      });
      actions.append(confirmBtn, cancelDelBtn);
    } else {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "secondary-button";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", () => {
        providerPanelState.confirmDeleteId = ep.id;
        renderProvidersPanel();
      });
      actions.appendChild(removeBtn);
    }

    card.appendChild(actions);
    listHost.appendChild(card);
  }
}

async function reorderProviderEndpoint(endpointId, delta) {
  const sorted = [...(providerPanelState.config.endpoints || [])]
    .sort((a, b) => (b.priority ?? 50) - (a.priority ?? 50));
  const idx = sorted.findIndex((ep) => ep.id === endpointId);
  const nextIdx = idx + delta;
  if (idx < 0 || nextIdx < 0 || nextIdx >= sorted.length) return;
  const [moved] = sorted.splice(idx, 1);
  sorted.splice(nextIdx, 0, moved);
  try {
    const res = await api("/api/core/providers/settings", {
      method: "PUT",
      body: JSON.stringify({ endpointOrder: sorted.map((ep) => ep.id) })
    });
    if (res?.config) providerPanelState.config = res.config;
    renderProvidersPanel();
    toast("Endpoint priority updated");
  } catch (error) {
    toast(error.message || "Could not reorder endpoints");
  }
}

async function loadProvidersPanel({ forceRefresh = false } = {}) {
  const listHost = $("#provider-endpoints-list");
  if (!listHost) return;
  try {
    const [configRes, healthRes] = await Promise.all([
      api("/api/core/providers"),
      api("/api/core/providers/health" + (forceRefresh ? "?refresh=1" : ""))
    ]);
    providerPanelState.config = configRes || { mode: "auto", healthIntervalSeconds: 30, endpoints: [] };
    providerPanelState.healthById = new Map(
      (healthRes?.endpoints || []).map((item) => [item.id, item])
    );
    renderProvidersPanel();
  } catch (error) {
    listHost.replaceChildren();
    const errEl = document.createElement("p");
    errEl.className = "error-message";
    errEl.textContent = error.message || "Provider configuration unavailable.";
    listHost.appendChild(errEl);
  }
}

function initProviderManagement() {
  $("#provider-add-btn")?.addEventListener("click", () => openProviderEditor(null));
  $("#provider-editor-close-btn")?.addEventListener("click", closeProviderEditor);
  $("#provider-cancel-btn")?.addEventListener("click", closeProviderEditor);

  $("#providers-refresh-btn")?.addEventListener("click", async () => {
    const btn = $("#providers-refresh-btn");
    if (btn) btn.disabled = true;
    try {
      await loadProvidersPanel({ forceRefresh: true });
      toast("Provider status refreshed");
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  $("#provider-field-type")?.addEventListener("change", (event) => {
    const type = event.target.value;
    applyProviderEditorPreset(type, {
      autofillUrl: true,
      autofillName: true,
      focusCredential: type === "google-gemini" || type === "openai"
    });
  });

  $("#provider-field-url")?.addEventListener("input", (event) => {
    const urlVal = event.target.value;
    const trustedCheckbox = $("#provider-field-trusted-local");
    if (!providerPanelState.editingId && trustedCheckbox) {
      if (!isLocalLikeUrl(urlVal) && /^https:\/\//i.test(urlVal)) {
        trustedCheckbox.checked = false;
      }
    }
  });

  $("#provider-field-model-select")?.addEventListener("change", (event) => {
    const val = event.target.value;
    if (val && $("#provider-field-model")) {
      $("#provider-field-model").value = val;
    }
  });

  $("#provider-routing-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const saveBtn = $("#provider-routing-save-btn");
    const statusEl = $("#provider-routing-status");
    const mode = $("#provider-default-mode")?.value || "auto";
    const healthIntervalSeconds = Number($("#provider-health-interval")?.value || 30);
    if (saveBtn) saveBtn.disabled = true;
    if (statusEl) statusEl.textContent = "Saving…";
    try {
      const res = await api("/api/core/providers/settings", {
        method: "PUT",
        body: JSON.stringify({ mode, healthIntervalSeconds })
      });
      if (res?.config) providerPanelState.config = res.config;
      renderProvidersPanel();
      if (statusEl) statusEl.textContent = "Saved";
      toast(`Default routing set to ${mode}`);
    } catch (error) {
      if (statusEl) statusEl.textContent = error.message || "Save failed";
      toast(error.message || "Could not save routing settings");
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  });

  $("#provider-test-btn")?.addEventListener("click", async () => {
    const testBtn = $("#provider-test-btn");
    const errEl = $("#provider-form-error");
    if (errEl) errEl.textContent = "";
    const payload = buildEndpointPayloadFromForm();
    if (providerPanelState.editingId) payload.id = providerPanelState.editingId;
    if (!payload.baseUrl) {
      if (errEl) errEl.textContent = "Enter an endpoint URL before testing the connection.";
      return;
    }
    if (testBtn) {
      testBtn.disabled = true;
      testBtn.textContent = "Testing…";
    }
    try {
      const res = await api("/api/core/providers/test", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      setProviderTestResult(res, !res.online);
      const discovered = Array.isArray(res.models) ? res.models : [];
      providerPanelState.discoveredModels = discovered;
      const modelInput = $("#provider-field-model");
      let currentModel = modelInput?.value?.trim() || "";
      if (!currentModel && discovered.length) {
        currentModel = discovered[0];
        if (modelInput) modelInput.value = currentModel;
      }
      populateEditorModelSelect(discovered, currentModel);
      if (providerPanelState.editingId) {
        providerPanelState.healthById.set(providerPanelState.editingId, res);
      }
    } catch (error) {
      setProviderTestResult({ online: false, error: error.message || "Connection test failed." }, true);
    } finally {
      if (testBtn) {
        testBtn.disabled = false;
        testBtn.textContent = "Test connection";
      }
    }
  });

  $("#provider-endpoint-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const saveBtn = $("#provider-save-btn");
    const errEl = $("#provider-form-error");
    if (errEl) errEl.textContent = "";
    const payload = buildEndpointPayloadFromForm();
    if (!payload.name) {
      if (errEl) errEl.textContent = "Enter a display name for this endpoint.";
      return;
    }
    if (!payload.baseUrl) {
      if (errEl) errEl.textContent = "Enter a valid HTTP or HTTPS endpoint URL.";
      return;
    }
    if (saveBtn) saveBtn.disabled = true;
    try {
      const editId = providerPanelState.editingId;
      const res = editId
        ? await api(`/api/core/providers/endpoints/${encodeURIComponent(editId)}`, {
            method: "PATCH",
            body: JSON.stringify(payload)
          })
        : await api("/api/core/providers/endpoints", {
            method: "POST",
            body: JSON.stringify(payload)
          });
      if (res?.config) providerPanelState.config = res.config;
      closeProviderEditor();
      await loadProvidersPanel({ forceRefresh: true });
      toast(editId ? `Updated endpoint ${payload.name}` : `Added endpoint ${payload.name}`);
    } catch (error) {
      if (errEl) errEl.textContent = error.message || "Could not save endpoint.";
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  });
}

function formatLocationSummary(loc) {
  if (!loc || !loc.enabled) return "";
  if (loc.label) return loc.label;
  if (Number.isFinite(Number(loc.latitude)) && Number.isFinite(Number(loc.longitude))) {
    return `${Number(loc.latitude).toFixed(2)}, ${Number(loc.longitude).toFixed(2)}`;
  }
  return "";
}

function renderLocationControls(profile) {
  const loc = profile?.location || { enabled: false, label: "", latitude: null, longitude: null, timezone: "" };
  const summary = formatLocationSummary(loc);

  const chatEnabled = $("#chat-location-enabled");
  if (chatEnabled) chatEnabled.checked = Boolean(loc.enabled);
  const chatInput = $("#chat-location-input");
  if (chatInput && document.activeElement !== chatInput) {
    chatInput.value = loc.label || (loc.latitude !== null && loc.longitude !== null ? `${loc.latitude}, ${loc.longitude}` : "");
  }
  const chatStatus = $("#chat-location-status");
  if (chatStatus) {
    chatStatus.textContent = loc.enabled && summary
      ? `Active: ${summary}`
      : (loc.label ? "Saved (paused)" : "Location off");
  }
  const quickBtn = $("#chat-location-pill-btn");
  if (quickBtn) {
    if (loc.enabled && summary) {
      quickBtn.textContent = summary;
      quickBtn.classList.add("is-active");
      quickBtn.title = `Using ${summary} for weather, trains, and local news. Click to edit.`;
    } else {
      quickBtn.textContent = "Set location";
      quickBtn.classList.remove("is-active");
      quickBtn.title = "Set your opt-in location for weather, trains, and local news";
    }
  }

  const wfEnabled = $("#wf-location-enabled");
  if (wfEnabled) wfEnabled.checked = Boolean(loc.enabled);
  const wfLabel = $("#wf-location-label");
  if (wfLabel && document.activeElement !== wfLabel) {
    wfLabel.value = loc.label || "";
  }
}

function updateChatContextSummary() {
  const summaryEl = $("#chat-context-summary");
  if (!summaryEl) return;
  const parts = [];
  const projectSel = $("#chat-project-select");
  if (projectSel && projectSel.value) {
    const label = projectSel.options[projectSel.selectedIndex]?.textContent?.trim();
    if (label && label !== "No project") parts.push(label);
  }
  const postureSel = $("#working-mode-select");
  const postureLabel = postureSel?.options?.[postureSel.selectedIndex]?.textContent?.trim() || "Companion";
  parts.push(postureLabel);

  const agentSel = $("#agent-provider");
  if (agentSel && agentSel.value && agentSel.value !== "local") {
    const agentLabel = agentSel.options[agentSel.selectedIndex]?.textContent?.trim();
    if (agentLabel) parts.push(agentLabel);
  }
  const modeSel = $("#model-mode");
  const modeLabel = modeSel?.options?.[modeSel.selectedIndex]?.textContent?.trim() || "Auto";
  parts.push(modeLabel);

  if ($("#background-task-toggle")?.checked) {
    parts.push("Background");
  }
  summaryEl.textContent = parts.join(" · ");
}

async function saveUserLocation(locationPayload, toastMessage = null) {
  const res = await api("/api/core/profile", {
    method: "PUT",
    body: JSON.stringify({ location: locationPayload })
  });
  state.workflowProfile = res.profile;
  renderWorkflowProfile();
  if (toastMessage) toast(toastMessage);
  return res.profile;
}

async function detectBrowserLocation({ triggerButton = null } = {}) {
  if (!("geolocation" in navigator)) {
    toast("Browser geolocation is unavailable here. Type your town or city instead.");
    return;
  }
  const statusEl = $("#chat-location-status");
  if (triggerButton) triggerButton.disabled = true;
  if (statusEl) statusEl.textContent = "Detecting location…";
  try {
    const coords = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve(pos.coords),
        (err) => reject(new Error(err?.message || "Location permission was denied.")),
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
      );
    });
    const lat = Math.round(Number(coords.latitude) * 10000) / 10000;
    const lon = Math.round(Number(coords.longitude) * 10000) / 10000;
    const typed = ($("#chat-location-input")?.value || $("#wf-location-label")?.value || "").trim();
    const label = typed && !/^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/.test(typed)
      ? typed
      : `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    await saveUserLocation(
      { enabled: true, label, latitude: lat, longitude: lon, timezone },
      `Location saved (${label}).`
    );
  } catch (error) {
    if (statusEl) statusEl.textContent = "Location unavailable";
    toast(error.message || "Could not detect browser location. You can type your town or city instead.");
  } finally {
    if (triggerButton) triggerButton.disabled = false;
  }
}

function initChatOptionsMenu() {
  const menuBtn = $("#chat-options-menu-btn");
  const drawer = $("#chat-options-drawer");
  const closeBtn = $("#chat-options-close-btn");
  const quickLocBtn = $("#chat-location-pill-btn");

  const setOpen = (open) => {
    if (!drawer || !menuBtn) return;
    drawer.hidden = !open;
    menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
  };

  menuBtn?.addEventListener("click", (event) => {
    event.stopPropagation();
    setOpen(Boolean(drawer?.hidden));
  });
  closeBtn?.addEventListener("click", () => {
    setOpen(false);
    menuBtn?.focus();
  });
  quickLocBtn?.addEventListener("click", (event) => {
    event.stopPropagation();
    setOpen(true);
    $("#chat-location-input")?.focus();
  });

  document.addEventListener("click", (event) => {
    if (!drawer || drawer.hidden) return;
    if (drawer.contains(event.target) || menuBtn?.contains(event.target) || quickLocBtn?.contains(event.target)) return;
    setOpen(false);
  });
  $("#stop-stream-btn")?.addEventListener("click", () => {
    cancelActiveChatRequest();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (drawer && !drawer.hidden) {
      setOpen(false);
      menuBtn?.focus();
      return;
    }
    if ((chatLifecycle ? chatLifecycle.busy : Boolean(state.sending && activeChatRequest)) && !document.querySelector(".modal-backdrop:not([hidden]), .dossier-backdrop:not([hidden])")) {
      event.preventDefault();
      cancelActiveChatRequest();
    }
  });

  for (const selector of ["#chat-project-select", "#working-mode-select", "#learning-mode-select", "#agent-provider", "#model-mode", "#background-task-toggle"]) {
    $(selector)?.addEventListener("change", () => updateChatContextSummary());
  }

  $("#chat-location-enabled")?.addEventListener("change", async (event) => {
    const checked = Boolean(event.currentTarget.checked);
    const inputVal = ($("#chat-location-input")?.value || "").trim();
    const prev = state.workflowProfile?.location || {};
    if (checked && !inputVal && prev.latitude === null) {
      $("#chat-location-input")?.focus();
      toast("Enter a town/city or click Use GPS to enable location.");
      event.currentTarget.checked = false;
      return;
    }
    try {
      await saveUserLocation({
        enabled: checked,
        label: inputVal || prev.label || "",
        latitude: prev.latitude ?? null,
        longitude: prev.longitude ?? null,
        timezone: prev.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || ""
      }, checked ? "Location enabled for local answers." : "Location paused.");
    } catch (error) {
      event.currentTarget.checked = !checked;
      toast(error.message || "Could not update location.");
    }
  });

  $("#chat-location-save-btn")?.addEventListener("click", async () => {
    const label = ($("#chat-location-input")?.value || "").trim();
    if (!label) {
      toast("Type a town, city, or postcode first (or click Use GPS).");
      $("#chat-location-input")?.focus();
      return;
    }
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    try {
      await saveUserLocation(
        { enabled: true, label, latitude: null, longitude: null, timezone },
        `Location set to ${label}.`
      );
    } catch (error) {
      toast(error.message || "Could not save location.");
    }
  });

  $("#chat-location-input")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      $("#chat-location-save-btn")?.click();
    }
  });

  $("#chat-location-clear-btn")?.addEventListener("click", async () => {
    try {
      const inputEl = $("#chat-location-input");
      if (inputEl) inputEl.value = "";
      await saveUserLocation(null, "Saved location cleared.");
    } catch (error) {
      toast(error.message || "Could not clear location.");
    }
  });

  $("#chat-location-detect-btn")?.addEventListener("click", (event) => {
    detectBrowserLocation({ triggerButton: event.currentTarget });
  });
  $("#wf-location-detect-btn")?.addEventListener("click", (event) => {
    detectBrowserLocation({ triggerButton: event.currentTarget });
  });

  updateChatContextSummary();
}

// ── Tools & Access Navigation, Scope Filter & Server-Side API Key Vault ──
const CLOUD_API_PRESETS = Object.freeze({
  gemini: Object.freeze({
    id: "gemini",
    name: "Google Gemini",
    endpointName: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.5-flash",
    modelPlaceholder: "e.g. gemini-2.5-flash or gemini-2.5-pro",
    keyLabel: "Google Gemini API key",
    keyPlaceholder: "Paste your Google AI Studio API key (AIza…)",
    urlNote: "Autofilled with Google's official OpenAI-compatible Gemini endpoint. Saved encrypted on the server.",
    keyLinkUrl: "https://aistudio.google.com/apikey",
    keyLinkText: "Get a Gemini API key ↗"
  }),
  openai: Object.freeze({
    id: "openai",
    name: "OpenAI (ChatGPT)",
    endpointName: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4.1-mini",
    modelPlaceholder: "e.g. gpt-4.1-mini or gpt-4.1",
    keyLabel: "OpenAI API key",
    keyPlaceholder: "Paste your OpenAI API key (sk-…)",
    urlNote: "Autofilled with OpenAI's official API root. Saved encrypted on the server.",
    keyLinkUrl: "https://platform.openai.com/api-keys",
    keyLinkText: "Get an OpenAI API key ↗"
  })
});

function applyProviderEditorPreset(type, { autofillUrl = true, autofillName = false, focusCredential = false } = {}) {
  const urlInput = $("#provider-field-url");
  const nameInput = $("#provider-field-name");
  const credentialInput = $("#provider-field-credential");
  const modelInput = $("#provider-field-model");
  const help = $("#provider-url-help");
  const geminiKeyLink = $("#provider-gemini-key-link");
  const openaiKeyLink = $("#provider-openai-key-link");
  const trustedLocal = $("#provider-field-trusted-local");
  const defaultNames = new Set(["", "Local Ollama", "Google Gemini", "OpenAI"]);
  const presetUrls = new Set([
    "",
    "http://127.0.0.1:11434",
    "http://127.0.0.1:1234/v1",
    CLOUD_API_PRESETS.gemini.baseUrl,
    CLOUD_API_PRESETS.openai.baseUrl
  ]);

  if (type === "google-gemini") {
    const preset = CLOUD_API_PRESETS.gemini;
    if (urlInput) {
      if (autofillUrl) urlInput.value = preset.baseUrl;
      urlInput.placeholder = preset.baseUrl;
    }
    if (autofillName && nameInput && defaultNames.has(nameInput.value.trim())) nameInput.value = preset.endpointName;
    if (credentialInput) credentialInput.placeholder = preset.keyPlaceholder;
    if (modelInput) modelInput.placeholder = preset.modelPlaceholder;
    if (help) help.textContent = preset.urlNote;
    if (geminiKeyLink) geminiKeyLink.hidden = false;
    if (openaiKeyLink) openaiKeyLink.hidden = true;
    if (trustedLocal) trustedLocal.checked = false;
    if (focusCredential) credentialInput?.focus();
    return;
  }

  if (type === "openai") {
    const preset = CLOUD_API_PRESETS.openai;
    if (urlInput) {
      if (autofillUrl) urlInput.value = preset.baseUrl;
      urlInput.placeholder = preset.baseUrl;
    }
    if (autofillName && nameInput && defaultNames.has(nameInput.value.trim())) nameInput.value = preset.endpointName;
    if (credentialInput) credentialInput.placeholder = preset.keyPlaceholder;
    if (modelInput) modelInput.placeholder = preset.modelPlaceholder;
    if (help) help.textContent = preset.urlNote;
    if (geminiKeyLink) geminiKeyLink.hidden = true;
    if (openaiKeyLink) openaiKeyLink.hidden = false;
    if (trustedLocal) trustedLocal.checked = false;
    if (focusCredential) credentialInput?.focus();
    return;
  }

  if (geminiKeyLink) geminiKeyLink.hidden = true;
  if (openaiKeyLink) openaiKeyLink.hidden = true;
  if (urlInput) {
    urlInput.placeholder = type === "ollama" ? "http://127.0.0.1:11434" : "https://api.example.com/v1";
    if (autofillUrl && !providerPanelState.editingId && presetUrls.has(urlInput.value.trim())) {
      urlInput.value = type === "ollama" ? "http://127.0.0.1:11434" : "http://127.0.0.1:1234/v1";
    }
  }
  if (credentialInput) credentialInput.placeholder = "API key (leave blank only if the endpoint needs no key)";
  if (modelInput) modelInput.placeholder = "e.g. qwen2.5:14b or llama-3.3-70b";
  if (help) help.textContent = "Choose Google Gemini or OpenAI above to autofill the official API URL and save your key encrypted on the server. For local servers, enter the reachable IP/hostname and port.";
  if (trustedLocal && !providerPanelState.editingId) trustedLocal.checked = type === "ollama";
}

function setToolsTab(tabId = "permissions") {
  const validTabs = new Set(["permissions", "keys", "monitoring", "automation"]);
  const nextTab = validTabs.has(tabId) ? tabId : "permissions";
  state.activeToolsTab = nextTab;
  document.querySelectorAll("#tools-section-tabs [data-tools-tab]").forEach((btn) => {
    const active = btn.dataset.toolsTab === nextTab;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll("#view-tools [data-tools-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.toolsPanel !== nextTab;
  });
}

function applyToolScopeFilter() {
  const query = ($("#tool-scope-filter")?.value || "").trim().toLowerCase();
  document.querySelectorAll("#tool-list .tools-scope-item").forEach((item) => {
    const hay = item.dataset.scopeSearch || item.textContent.toLowerCase();
    item.hidden = Boolean(query) && !hay.includes(query);
  });
}

function updateToolsSummaryStrip() {
  const counts = state.toolsSummaryCounts || {};
  const grantedEl = $("#tools-stat-granted");
  const leasesEl = $("#tools-stat-leases");
  const pendingEl = $("#tools-stat-pending");
  const pendingCard = $("#tools-stat-pending-card");
  const pendingTabBadge = $("#tools-tab-pending-count");
  const keysEl = $("#tools-stat-keys");
  const keysSubEl = $("#tools-stat-keys-sub");
  const keysTabBadge = $("#tools-tab-keys-count");
  const monitorsEl = $("#tools-stat-monitors");

  if (grantedEl && typeof counts.grantedScopes === "number") {
    grantedEl.textContent = `${counts.grantedScopes}/${counts.totalScopes || 0}`;
  }
  if (leasesEl && typeof counts.activeLeases === "number") {
    leasesEl.textContent = `${counts.activeLeases} active ${counts.activeLeases === 1 ? "lease" : "leases"}`;
  }
  if (pendingEl && typeof counts.pendingApprovals === "number") {
    pendingEl.textContent = String(counts.pendingApprovals);
    pendingCard?.classList.toggle("is-attention", counts.pendingApprovals > 0);
  }
  if (pendingTabBadge && typeof counts.pendingApprovals === "number") {
    pendingTabBadge.textContent = String(counts.pendingApprovals);
    pendingTabBadge.hidden = counts.pendingApprovals === 0;
  }

  const agents = Array.isArray(state.cloudAgents) ? state.cloudAgents : [];
  const configuredAgents = agents.filter((a) => a.secretConfigured);
  if (keysEl) {
    keysEl.textContent = `${configuredAgents.length}/${agents.length || 2}`;
  }
  if (keysSubEl) {
    keysSubEl.textContent = configuredAgents.length
      ? configuredAgents.map((a) => (a.provider === "gemini" ? "Gemini" : "OpenAI")).join(" & ") + " ready"
      : "No cloud keys configured";
  }
  if (keysTabBadge) {
    keysTabBadge.textContent = String(configuredAgents.length);
    keysTabBadge.hidden = configuredAgents.length === 0;
  }

  if (monitorsEl) {
    const watcherCount = document.querySelectorAll("#watcher-list .item").length;
    const capsuleCount = document.querySelectorAll("#capsule-list .item").length;
    monitorsEl.textContent = `${watcherCount + capsuleCount}`;
  }
}

function selectCloudKeyProvider(providerId, { focusInput = false } = {}) {
  const select = $("#cloud-key-provider-select");
  const fieldsWrap = $("#cloud-key-fields");
  const emptyPrompt = $("#cloud-key-empty-prompt");
  const urlInput = $("#cloud-key-url-input");
  const urlNote = $("#cloud-key-url-note");
  const credLabel = $("#cloud-key-credential-label");
  const credInput = $("#cloud-key-credential-input");
  const keyLink = $("#cloud-key-get-link");
  const removeBtn = $("#cloud-key-remove-btn");
  const feedbackEl = $("#cloud-key-form-feedback");

  if (select && select.value !== (providerId || "")) {
    select.value = providerId || "";
  }
  if (feedbackEl) {
    feedbackEl.textContent = "";
    feedbackEl.classList.remove("is-error", "is-success");
  }

  const preset = CLOUD_API_PRESETS[providerId];
  if (!preset) {
    if (fieldsWrap) fieldsWrap.hidden = true;
    if (emptyPrompt) emptyPrompt.hidden = false;
    return;
  }

  const agent = findCloudAgent(providerId);
  if (fieldsWrap) fieldsWrap.hidden = false;
  if (emptyPrompt) emptyPrompt.hidden = true;
  if (urlInput) {
    urlInput.value = agent?.baseUrl || preset.baseUrl;
    urlInput.placeholder = preset.baseUrl;
  }
  if (urlNote) urlNote.textContent = preset.urlNote;
  if (credLabel) {
    credLabel.textContent = agent?.vaultKeyConfigured
      ? `${preset.keyLabel} (enter a new key to replace saved server key)`
      : preset.keyLabel;
  }
  if (credInput) {
    credInput.value = "";
    credInput.placeholder = preset.keyPlaceholder;
  }
  if (keyLink) {
    keyLink.href = preset.keyLinkUrl;
    keyLink.textContent = preset.keyLinkText;
  }
  if (removeBtn) {
    removeBtn.hidden = !agent?.vaultKeyConfigured;
  }
  if (focusInput) {
    requestAnimationFrame(() => credInput?.focus());
  }
}

function openToolsApiKeySetup(providerId = "") {
  setView("tools");
  setToolsTab("keys");
  if (providerId && CLOUD_API_PRESETS[providerId]) {
    selectCloudKeyProvider(providerId, { focusInput: true });
  } else {
    requestAnimationFrame(() => $("#cloud-key-provider-select")?.focus());
  }
}

function renderCloudKeyStatusCards() {
  const host = $("#cloud-key-status-cards");
  if (!host) return;
  host.replaceChildren();

  const providers = ["gemini", "openai"];
  for (const providerId of providers) {
    const preset = CLOUD_API_PRESETS[providerId];
    const agent = findCloudAgent(providerId);
    const configured = Boolean(agent?.secretConfigured);
    const fromVault = agent?.secretSource === "server_vault";
    const fromEnv = agent?.secretSource === "environment";
    const currentUrl = agent?.baseUrl || preset.baseUrl;

    const card = document.createElement("article");
    card.className = "tools-key-status-card" + (configured ? " is-configured" : "");
    card.dataset.keyProvider = providerId;

    const top = document.createElement("div");
    top.className = "tools-key-card-top";
    const nameEl = document.createElement("strong");
    nameEl.textContent = preset.name;
    const statusEl = document.createElement("span");
    statusEl.className = "tools-key-status-label " + (configured ? "is-ready" : "is-missing");
    statusEl.textContent = fromVault
      ? "Encrypted on server"
      : (fromEnv ? "Server environment" : "Not configured");
    top.append(nameEl, statusEl);

    const urlEl = document.createElement("code");
    urlEl.className = "tools-key-url-preview";
    urlEl.textContent = currentUrl;

    const metaEl = document.createElement("p");
    metaEl.className = "muted tools-key-card-meta";
    metaEl.textContent = fromVault
      ? "Saved in encrypted server vault · never stored in browser."
      : (fromEnv
        ? `Using server environment variable (${agent.envVar}). You can override it with a vault key anytime.`
        : "Select to autofill the official URL and store a key securely on the server.");

    const actions = document.createElement("div");
    actions.className = "tools-key-card-actions";
    const configBtn = document.createElement("button");
    configBtn.type = "button";
    configBtn.className = configured ? "secondary-button" : "primary-button";
    configBtn.textContent = configured ? "Update key" : "Configure key";
    configBtn.addEventListener("click", () => {
      selectCloudKeyProvider(providerId, { focusInput: true });
    });
    actions.appendChild(configBtn);

    if (fromVault) {
      const clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "secondary-button";
      clearBtn.textContent = "Remove";
      clearBtn.addEventListener("click", async () => {
        clearBtn.disabled = true;
        try {
          await removeServerCloudKey(providerId);
        } finally {
          clearBtn.disabled = false;
        }
      });
      actions.appendChild(clearBtn);
    }

    card.append(top, urlEl, metaEl, actions);
    host.appendChild(card);
  }
}

async function syncCloudKeyToProviderEndpoint(providerId, baseUrl, credential) {
  const preset = CLOUD_API_PRESETS[providerId];
  if (!preset) return;
  let endpoints = providerPanelState.config?.endpoints;
  if (!Array.isArray(endpoints)) {
    try {
      const data = await api("/api/core/providers");
      providerPanelState.config = data;
      endpoints = data?.endpoints || [];
    } catch {
      endpoints = [];
    }
  }
  const matchHost = providerId === "gemini" ? "generativelanguage.googleapis.com" : "api.openai.com";
  const existing = endpoints.find((ep) => String(ep.baseUrl || "").toLowerCase().includes(matchHost));
  if (existing) {
    await api(`/api/core/providers/endpoints/${encodeURIComponent(existing.id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        baseUrl,
        enabled: true,
        trustedLocal: false,
        apiKey: credential
      })
    });
  } else {
    await api("/api/core/providers/endpoints", {
      method: "POST",
      body: JSON.stringify({
        name: preset.endpointName,
        provider: "openai-compatible",
        baseUrl,
        mode: "standard",
        priority: 80,
        trustedLocal: false,
        enabled: true,
        model: preset.defaultModel,
        apiKey: credential
      })
    });
  }
}

async function removeServerCloudKey(providerId) {
  const preset = CLOUD_API_PRESETS[providerId];
  if (!preset) return;
  const feedbackEl = $("#cloud-key-form-feedback");
  try {
    await api(`/api/core/cloud-agents/${encodeURIComponent(providerId)}/credential`, {
      method: "DELETE"
    });
    const endpoints = providerPanelState.config?.endpoints || [];
    const matchHost = providerId === "gemini" ? "generativelanguage.googleapis.com" : "api.openai.com";
    const existing = endpoints.find((ep) => String(ep.baseUrl || "").toLowerCase().includes(matchHost) && ep.apiKeyConfigured);
    if (existing) {
      await api(`/api/core/providers/endpoints/${encodeURIComponent(existing.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ clearApiKey: true })
      }).catch(() => {});
    }
    await Promise.all([loadCloudAgents(), loadProvidersPanel().catch(() => {})]);
    if ($("#cloud-key-provider-select")?.value === providerId) {
      selectCloudKeyProvider(providerId, { focusInput: false });
    }
    if (feedbackEl) {
      feedbackEl.textContent = `Removed saved server API key for ${preset.name}.`;
      feedbackEl.classList.remove("is-error");
      feedbackEl.classList.add("is-success");
    }
    toast(`Removed saved ${preset.name} API key from server.`);
  } catch (error) {
    if (feedbackEl) {
      feedbackEl.textContent = error.message || "Could not remove saved key.";
      feedbackEl.classList.remove("is-success");
      feedbackEl.classList.add("is-error");
    }
    toast(error.message || "Could not remove saved key.");
  }
}

function initToolsAndKeysUi() {
  document.querySelectorAll("#tools-section-tabs [data-tools-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setToolsTab(btn.dataset.toolsTab);
      if (btn.dataset.toolsTab === "keys") {
        renderCloudKeyStatusCards();
      }
    });
  });

  $("#tool-scope-filter")?.addEventListener("input", applyToolScopeFilter);

  $("#tools-quick-add-key-btn")?.addEventListener("click", () => {
    setToolsTab("keys");
    renderCloudKeyStatusCards();
    requestAnimationFrame(() => $("#cloud-key-provider-select")?.focus());
  });

  const openRoutingInSettings = () => {
    setView("settings");
    requestAnimationFrame(() => {
      $("#settings-providers-surface")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };
  $("#tools-open-providers-settings-btn")?.addEventListener("click", openRoutingInSettings);
  $("#tools-keys-manage-endpoints-btn")?.addEventListener("click", openRoutingInSettings);

  $("#cloud-keys-refresh-btn")?.addEventListener("click", async () => {
    await Promise.all([loadCloudAgents(), loadProvidersPanel().catch(() => {})]);
    toast("Server key status refreshed.");
  });

  $("#cloud-key-provider-select")?.addEventListener("change", (event) => {
    const providerId = event.currentTarget.value;
    selectCloudKeyProvider(providerId, { focusInput: Boolean(providerId) });
  });

  $("#cloud-key-remove-btn")?.addEventListener("click", async () => {
    const providerId = $("#cloud-key-provider-select")?.value;
    if (!providerId) return;
    await removeServerCloudKey(providerId);
  });

  $("#cloud-key-test-btn")?.addEventListener("click", async () => {
    const providerId = $("#cloud-key-provider-select")?.value;
    const preset = CLOUD_API_PRESETS[providerId];
    const feedbackEl = $("#cloud-key-form-feedback");
    const testBtn = $("#cloud-key-test-btn");
    if (!preset) return;
    const baseUrl = $("#cloud-key-url-input")?.value?.trim() || preset.baseUrl;
    const credential = $("#cloud-key-credential-input")?.value?.trim() || "";
    const endpoints = providerPanelState.config?.endpoints || [];
    const matchHost = providerId === "gemini" ? "generativelanguage.googleapis.com" : "api.openai.com";
    const matchingEndpoint = endpoints.find((ep) => String(ep.baseUrl || "").toLowerCase().includes(matchHost));

    if (!credential && !matchingEndpoint?.apiKeyConfigured) {
      if (feedbackEl) {
        feedbackEl.textContent = "Paste an API key first to test the connection.";
        feedbackEl.classList.remove("is-success");
        feedbackEl.classList.add("is-error");
      }
      $("#cloud-key-credential-input")?.focus();
      return;
    }

    if (testBtn) {
      testBtn.disabled = true;
      testBtn.textContent = "Testing…";
    }
    if (feedbackEl) {
      feedbackEl.textContent = `Testing connection to ${baseUrl}…`;
      feedbackEl.classList.remove("is-error", "is-success");
    }
    try {
      const payload = {
        provider: "openai-compatible",
        baseUrl,
        trustedLocal: false
      };
      if (credential) payload.apiKey = credential;
      else if (matchingEndpoint?.id) payload.id = matchingEndpoint.id;

      const res = await api("/api/core/providers/test", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      if (res?.ok) {
        const count = Array.isArray(res.models) ? res.models.length : 0;
        if (feedbackEl) {
          feedbackEl.textContent = `Connection verified (${res.latencyMs ?? 0} ms) · ${count} model${count === 1 ? "" : "s"} reachable.`;
          feedbackEl.classList.remove("is-error");
          feedbackEl.classList.add("is-success");
        }
      } else if (feedbackEl) {
        feedbackEl.textContent = res?.error || "Connection test failed. Check your API key and endpoint URL.";
        feedbackEl.classList.remove("is-success");
        feedbackEl.classList.add("is-error");
      }
    } catch (error) {
      if (feedbackEl) {
        feedbackEl.textContent = error.message || "Connection test failed.";
        feedbackEl.classList.remove("is-success");
        feedbackEl.classList.add("is-error");
      }
    } finally {
      if (testBtn) {
        testBtn.disabled = false;
        testBtn.textContent = "Test connection";
      }
    }
  });

  $("#cloud-key-setup-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const providerId = $("#cloud-key-provider-select")?.value;
    const preset = CLOUD_API_PRESETS[providerId];
    const feedbackEl = $("#cloud-key-form-feedback");
    const saveBtn = $("#cloud-key-save-btn");
    const credInput = $("#cloud-key-credential-input");
    const urlInput = $("#cloud-key-url-input");
    const syncEndpoint = Boolean($("#cloud-key-sync-endpoint")?.checked);

    if (!preset) {
      if (feedbackEl) {
        feedbackEl.textContent = "Select Google Gemini or OpenAI first.";
        feedbackEl.classList.add("is-error");
      }
      return;
    }

    const credential = credInput?.value?.trim() || "";
    const baseUrl = urlInput?.value?.trim() || preset.baseUrl;
    if (!credential) {
      if (feedbackEl) {
        feedbackEl.textContent = `Paste your ${preset.keyLabel} before saving.`;
        feedbackEl.classList.remove("is-success");
        feedbackEl.classList.add("is-error");
      }
      credInput?.focus();
      return;
    }

    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving…";
    }
    if (feedbackEl) {
      feedbackEl.textContent = "Encrypting and saving key on server…";
      feedbackEl.classList.remove("is-error", "is-success");
    }

    try {
      await api(`/api/core/cloud-agents/${encodeURIComponent(providerId)}/credential`, {
        method: "PUT",
        body: JSON.stringify({ credential, baseUrl })
      });
      if (syncEndpoint) {
        await syncCloudKeyToProviderEndpoint(providerId, baseUrl, credential).catch(() => {});
      }
      // Clear credential input immediately — never retain or persist secrets in the browser.
      if (credInput) credInput.value = "";
      await Promise.all([loadCloudAgents(), loadProvidersPanel().catch(() => {})]);
      selectCloudKeyProvider(providerId, { focusInput: false });
      if (feedbackEl) {
        feedbackEl.textContent = `${preset.name} API key saved encrypted on server (never stored in browser).`;
        feedbackEl.classList.remove("is-error");
        feedbackEl.classList.add("is-success");
      }
      toast(`${preset.name} API key saved on server.`);
    } catch (error) {
      if (feedbackEl) {
        feedbackEl.textContent = error.message || "Could not save API key.";
        feedbackEl.classList.remove("is-success");
        feedbackEl.classList.add("is-error");
      }
      toast(error.message || "Could not save API key.");
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = "Save key to server";
      }
    }
  });

  renderCloudKeyStatusCards();
}

initWorkingModeSelector();
initIdeasVault();
initWatchers();
initWorkflowProfile();
initChatOptionsMenu();
initToolsAndKeysUi();
initCapsules();
initKnowledgeGraph();
initVoiceLoopTts();
initAccountRecovery();
initStorageAndAirlock();
initHybridSearch();
initReflectionsAndVirtualRoom();
initWorkshopAndIntegrations();
initPhase6Vault();
initPhase6Diagnostics();
initPhase6PeerTokens();
initPhase6Playbooks();
initPhase6Timeline();
initProviderManagement();
initialise();
