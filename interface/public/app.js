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
  conversationLoading: false
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

  _transitionMood(prevMood, newMood) {
    if (prevMood === newMood) return;
    if (typeof document !== "undefined") {
      document.querySelectorAll(".alfie-soul").forEach((el) => {
        el.classList.add("mood-transitioning");
        el.dataset.prevMood = prevMood;
        el.setAttribute("data-prev-mood", prevMood);
      });
    }
    if (this._moodTransitionTimeout) {
      clearTimeout(this._moodTransitionTimeout);
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
    }, 650);
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
    document.querySelectorAll(".alfie-soul").forEach((el) => {
      el.dataset.mood = this._mood;
      el.dataset.animationState = this._animationState;
      el.dataset.soulTheme = this._themeProfile;
      el.setAttribute("data-mood", this._mood);
      el.setAttribute("data-animation-state", this._animationState);
      el.setAttribute("data-soul-theme", this._themeProfile);
      el.setAttribute("aria-label", `Alfie Soul: ${this._themeProfile} palette, ${this._mood} mood, ${this._animationState} state`);
    });

    document.querySelectorAll(".mood-chip").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.setMood === this._mood);
    });

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
    "--sidebar-bg": "linear-gradient(180deg,#151125,#110e1f)",
    "--surface-bg": "linear-gradient(145deg,rgba(31,25,49,.8),rgba(21,17,34,.8))",
    "--surface-card-bg": "rgba(14,11,24,.6)",
    "--composer-bg": "linear-gradient(145deg,rgba(34,28,54,.96),rgba(23,19,38,.96))",
    "--composer-border": "rgba(182,162,255,.28)",
    "--user-msg-bg": "rgba(33,27,51,.75)",
    "--code-bg": "#110e1f",
    "--pre-bg": "#0d0a17",
    "--code-text": "#e8ddff",
    "--pre-text": "#e8e3f2",
    "--brand-bg": "linear-gradient(145deg,#292044,#171326)",
    "--bg-gradient": "radial-gradient(ellipse at 70% -10%,rgba(105,76,174,.18),transparent 45%),radial-gradient(ellipse at 15% 105%,rgba(82,53,142,.12),transparent 40%),var(--bg)",
    "--ambient-opacity": "0.11"
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
    "--sidebar-bg": "linear-gradient(180deg,#faf8ff,#f1ecfa)",
    "--surface-bg": "linear-gradient(145deg,#ffffff,#f9f6fd)",
    "--surface-card-bg": "#f4effb",
    "--composer-bg": "linear-gradient(145deg,#ffffff,#faf7fd)",
    "--composer-border": "rgba(128,105,231,.32)",
    "--user-msg-bg": "rgba(235,228,252,.92)",
    "--code-bg": "#ede6fa",
    "--pre-bg": "#f3eefb",
    "--code-text": "#392470",
    "--pre-text": "#221c35",
    "--brand-bg": "linear-gradient(145deg,#ede6fa,#ded4f5)",
    "--bg-gradient": "radial-gradient(ellipse at 70% -10%,rgba(128,105,231,.10),transparent 50%),radial-gradient(ellipse at 15% 105%,rgba(128,105,231,.06),transparent 45%),var(--bg)",
    "--ambient-opacity": "0.04"
  }
};

class AlfieThemeController {
  constructor() {
    this._theme = "dark";
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

  init() {
    let saved = "dark";
    try {
      saved = localStorage.getItem(THEME_STORAGE_KEY) || "dark";
    } catch {}
    this.setTheme(saved, false);
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

window.alfieTheme = new AlfieThemeController();
window.alfieTheme.init();

/* Delegated click handler for navigation menus, Soul orbs, mood chips, theme toggle, and soul palette profile buttons */
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
  const imgCmdBtn = event.target.closest("#image-cmd-btn");
  if (imgCmdBtn) {
    const input = $("#chat-form")?.elements?.message;
    if (input) {
      input.value = "/image ";
      input.focus();
      if (typeof input.setSelectionRange === "function") input.setSelectionRange(input.value.length, input.value.length);
      const suggestions = $("#composer-suggestions");
      if (suggestions) suggestions.hidden = false;
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
  const titles = { chat: isChatUnlinked ? "Connect account" : "Chat", garden: "The Garden", tools: "Tools & access", settings: "Settings" };
  $("#view-title").textContent = titles[view] || "Alfie";
  const mobileHistory = $("#mobile-history-sheet");
  if (mobileHistory) mobileHistory.hidden = true;
  if (view === "garden") loadMemories();
  if (view === "tools") loadToolsAndApprovals();
  if (view === "settings") {
    loadSettings();
    window.alfieTheme?._updateUI(window.alfieTheme.getTheme());
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
  state.projects = [];
  state.selectedProjectId = "all";
  state.vram = null;
  state.vramDismissedKey = null;
  state.vramLastAlerted = false;
  state.cloudAgents = [];
  state.selectedAgentProvider = "local";
  state.conversationLoadToken += 1;
  state.conversationLoading = false;
  state.messages = [];
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
    state.projects = [];
    state.selectedProjectId = "all";
    state.vram = null;
    state.vramDismissedKey = null;
    state.vramLastAlerted = false;
    state.cloudAgents = [];
    state.selectedAgentProvider = "local";
    state.conversationLoadToken += 1;
    state.conversationLoading = false;
    state.messages = [];
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
  const form = new FormData(event.currentTarget);
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  $("#link-error").textContent = "";
  try {
    await api("/api/auth/link", { method: "POST", body: JSON.stringify({ code: String(form.get("code") || "").trim().toUpperCase() }) });
    state.linked = true;
    event.currentTarget.reset();
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
  const continueBtn = $("#continue-chat-btn");
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
    select.value = state.projects.some((p) => p.id === activeProjectId) ? activeProjectId : "";
  }
  if (continueBtn) {
    const canContinue = Boolean(state.activeConversationId && (state.messages.length > 0 || state.activeConversation?.handoffContext));
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

function renderProjects() {
  renderProjectList($("#project-list"));
  renderProjectList($("#mobile-project-list"));
  syncNewChatButtonLabel();
  syncChatContextBar();
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

function openProjectModal(project = null) {
  const modal = $("#project-modal");
  const form = $("#project-form");
  const title = $("#project-modal-title");
  const submit = $("#project-submit-btn");
  const err = $("#project-form-error");
  if (!modal || !form) return;
  form.reset();
  if (err) err.textContent = "";
  form.elements.projectId.value = project?.id || "";
  form.elements.name.value = project?.name || "";
  form.elements.description.value = project?.description || "";
  setProjectModalColor(project?.color || "purple");
  if (title) title.textContent = project ? "Edit project" : "New project";
  if (submit) submit.textContent = project ? "Save changes" : "Create project";
  modal.hidden = false;
  $("#mobile-history-sheet").hidden = true;
  $("#project-name-input")?.focus();
}

function closeProjectModal() {
  const modal = $("#project-modal");
  if (modal) modal.hidden = true;
}

async function deleteProject(projectId, projectName) {
  if (!confirm(`Delete project "${projectName}"? Conversations inside it will be kept under Unassigned.`)) return;
  try {
    await api("/api/core/projects/" + encodeURIComponent(projectId), { method: "DELETE", body: "{}" });
    if (state.selectedProjectId === projectId) state.selectedProjectId = "all";
    if (state.activeConversation?.projectId === projectId) {
      state.activeConversation = { ...state.activeConversation, projectId: null };
    }
    await Promise.all([loadProjects(), loadConversations()]);
    toast(`Deleted project "${projectName}".`);
  } catch (error) {
    toast(error.message);
  }
}

$("#new-project-btn")?.addEventListener("click", () => openProjectModal(null));
$("#mobile-new-project-btn")?.addEventListener("click", () => openProjectModal(null));
$("#project-modal-close")?.addEventListener("click", closeProjectModal);
$("#project-cancel-btn")?.addEventListener("click", closeProjectModal);
$("#project-modal")?.querySelector("[data-project-modal-close='backdrop']")?.addEventListener("click", closeProjectModal);
document.querySelectorAll("#project-color-choices .project-color-btn").forEach((btn) => {
  btn.addEventListener("click", () => setProjectModalColor(btn.dataset.projectColor));
});
document.addEventListener("keydown", (event) => {
  const modal = $("#project-modal");
  if (event.key === "Escape" && modal && !modal.hidden) {
    closeProjectModal();
  }
});

$("#project-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const projectId = String(form.elements.projectId.value || "").trim();
  const name = String(form.elements.name.value || "").trim();
  const description = String(form.elements.description.value || "").trim();
  const err = $("#project-form-error");
  const submit = $("#project-submit-btn");
  if (err) err.textContent = "";
  if (!name) {
    if (err) err.textContent = "Please enter a project name.";
    return;
  }
  if (submit) submit.disabled = true;
  try {
    if (projectId) {
      await api("/api/core/projects/" + encodeURIComponent(projectId), {
        method: "PATCH",
        body: JSON.stringify({ name, description, color: projectModalColor })
      });
      toast(`Updated project "${name}".`);
    } else {
      const created = await api("/api/core/projects", {
        method: "POST",
        body: JSON.stringify({ name, description, color: projectModalColor })
      });
      if (created?.project?.id) state.selectedProjectId = created.project.id;
      toast(`Created project "${name}".`);
    }
    closeProjectModal();
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
    keyTag.textContent = agent.secretConfigured ? `${agent.envVar} ready` : `Set ${agent.envVar}`;
    const enabledTag = document.createElement("span");
    enabledTag.className = "cloud-status-tag" + (agent.enabled ? " is-active" : "");
    enabledTag.textContent = agent.enabled ? "Enabled" : "Disabled";
    badges.append(keyTag, enabledTag);
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
    return state.cloudAgents;
  } catch {
    return null;
  }
}

$("#agent-provider")?.addEventListener("change", (event) => {
  const next = event.currentTarget.value || "local";
  state.selectedAgentProvider = next;
  try { localStorage.setItem("alfie_agent_provider", next); } catch {}
  renderCloudPrivacyBanner();
  if (next === "local") {
    toast("Switched to Alfie Local.");
  } else {
    const agent = findCloudAgent(next);
    const label = agent ? `${agent.name} (${agent.model})` : next;
    toast(`Active agent: ${label} — private section access follows your optional privacy controls.`);
  }
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
  await Promise.all([loadProjects(), loadConversations(), loadCloudAgents()]);
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

function renderConversations(conversations = []) {
  renderConversationList($("#conversation-list"), conversations);
  renderConversationList($("#mobile-conversation-list"), conversations);
  renderProjects();
}

async function loadConversations() {
  const payload = await api("/api/core/conversations");
  const conversations = payload.conversations || [];
  state.conversations = conversations;
  renderConversations(conversations);
  if (!state.activeConversationId && conversations.length) await loadConversation(conversations[0].id);
  else syncChatContextBar();
}

async function loadConversation(id) {
  if (state.sending) { toast("Wait for Alfie's current reply before switching conversations."); return; }
  const token = ++state.conversationLoadToken;
  state.conversationLoading = true;
  try {
    const payload = await api("/api/core/conversations/" + encodeURIComponent(id));
    if (token !== state.conversationLoadToken) return;
    state.activeConversationId = id;
    state.activeConversation = payload.conversation || null;
    state.messages = payload.conversation?.messages || [];
    renderMessages();
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
  if (state.sending && !fromSend) { toast("Wait for Alfie's current reply before starting another conversation."); return; }
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
    if (event.key === "Escape") {
      event.preventDefault();
      closeImageLightbox();
    } else if (event.key === "+" || event.key === "=") {
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
      await api("/api/core/conversations/" + encodeURIComponent(state.activeConversationId) + "/messages/" + encodeURIComponent(message.id) + "/reaction", {
        method: "POST",
        body: JSON.stringify({ reaction: nextReaction })
      });
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
    attachCopyButtonToBody(body, message.content);
  }
  article.append(header, body);

  if (message.role === "assistant") {
    const actions = createReactionControls(message);
    article.appendChild(actions);
  }

  $("#messages").appendChild(article);
  return body;
}

/* Chat Auto-Scroll Manager with User Scroll-Lock Protection */
const SCROLL_BOTTOM_THRESHOLD = 96;
let chatAutoScrollEnabled = true;

function isMessagesNearBottom(element = $("#messages"), threshold = SCROLL_BOTTOM_THRESHOLD) {
  if (!element) return true;
  const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
  return distanceFromBottom <= threshold;
}

function updateScrollToBottomIndicator() {
  const scrollBtn = $("#scroll-to-bottom");
  const host = $("#messages");
  if (!scrollBtn || !host) return;
  const hasMessages = state.messages && state.messages.length > 0;
  const isUp = !isMessagesNearBottom(host);
  scrollBtn.hidden = !hasMessages || !isUp;
}

function scrollChatToBottom({ force = false, smooth = false } = {}) {
  const host = $("#messages");
  if (!host) return;
  if (force || chatAutoScrollEnabled) {
    if (smooth) {
      host.scrollTo({ top: host.scrollHeight, behavior: "smooth" });
    } else {
      host.scrollTop = host.scrollHeight;
    }
    chatAutoScrollEnabled = true;
    updateScrollToBottomIndicator();
  }
}

window.chatScroller = {
  scrollToBottom: scrollChatToBottom,
  isNearBottom: isMessagesNearBottom,
  getAutoScroll: () => chatAutoScrollEnabled,
  setAutoScroll: (val) => {
    chatAutoScrollEnabled = Boolean(val);
    updateScrollToBottomIndicator();
  }
};

const messagesHost = $("#messages");
if (messagesHost) {
  messagesHost.addEventListener("scroll", () => {
    if (isMessagesNearBottom(messagesHost)) {
      chatAutoScrollEnabled = true;
    } else {
      chatAutoScrollEnabled = false;
    }
    updateScrollToBottomIndicator();
  }, { passive: true });
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

async function persistMessage(role, content, conversationId = state.activeConversationId, metrics = null) {
  const payload = await api("/api/core/conversations/" + encodeURIComponent(conversationId) + "/messages", {
    method: "POST",
    body: JSON.stringify({ role, content, ...(metrics ? { metrics } : {}) })
  });
  if (conversationId === state.activeConversationId) {
    state.messages.push(payload.message || { role, content, ...(metrics ? { metrics } : {}) });
    syncChatContextBar();
  }
  return payload.message;
}

async function sendMessage(rawText) {
  const content = String(rawText || "").trim();
  if (!content || state.sending || !state.linked) return;
  if (state.conversationLoading) { toast("Wait for the selected conversation to finish loading."); return; }
  state.sending = true;
  const form = $("#chat-form");
  const input = form.elements.message;
  input.disabled = true;
  let assistantBody = null;
  let thinking = null;
  const sendStart = Date.now();
  window.alfieSoul?.setState("thinking", "amber");
  try {
    if (content.startsWith("/image")) {
      const promptText = content.replace(/^\/image\s*/i, "").trim();
      if (!promptText) {
        toast("Please describe the visual asset to generate, e.g. /image A glowing amethyst crystal garden");
        state.sending = false;
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
      attachCopyButtonToBody(assistantBody, assistantText);

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
    await persistMessage("user", content, conversationId);
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
    const activeProject = findProjectById(getConversationProjectId(state.activeConversation));
    const dashboardState = activeProject?.description
      ? { attachedContext: `Project: ${activeProject.name}\n${activeProject.description}` }
      : {};
    const selectedAgentProvider = $("#agent-provider")?.value || state.selectedAgentProvider || "local";
    const response = await fetch("/api/core/chat/stream", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrf-token": state.csrfToken },
      body: JSON.stringify({
        messages: outgoingMessages,
        mode: $("#model-mode").value,
        agentProvider: selectedAgentProvider,
        dashboardState
      })
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      throw new Error(failure.error || "Alfie could not complete the response.");
    }
    let buffer = "";
    let assistantText = "";
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
        const event = JSON.parse(line);
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
        if (event.type === "done") finalEvent = event;
      }
      if (done) break;
    }
    if (buffer.trim()) {
      const event = JSON.parse(buffer);
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
        if (chatAutoScrollEnabled) {
          const host = $("#messages");
          if (host) host.scrollTop = host.scrollHeight;
        }
        updateScrollToBottomIndicator();
      }
      if (event.type === "done") finalEvent = event;
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
    renderMarkdown(assistantBody, assistantText || "I couldn't produce a response.");
    attachCopyButtonToBody(assistantBody, assistantText || "I couldn't produce a response.");
    if (finalEvent?.status === "awaiting_user_approval" && finalEvent.actionId) {
      const approval = document.createElement("section");
      approval.className = "chat-approval-card";
      const heading = document.createElement("strong");
      heading.textContent = "Your approval is needed";
      const detail = document.createElement("p");
      detail.textContent = [finalEvent.toolId, finalEvent.summary].filter(Boolean).join(" · ") || "Alfie has prepared an action for review.";
      const review = document.createElement("button");
      review.type = "button";
      review.className = "secondary-button";
      review.textContent = "Review in Tools & access";
      review.addEventListener("click", () => {
        setView("tools");
        loadToolsAndApprovals().catch((error) => toast(error.message));
      });
      approval.append(heading, detail, review);
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

    const savedMessage = await persistMessage("assistant", assistantText || assistantBody.textContent, conversationId, metrics);
    if (messageArticle) {
      messageArticle.querySelector(".message-actions")?.remove();
      messageArticle.appendChild(createReactionControls(savedMessage || { role: "assistant", content: assistantText, metrics }));
    }
    await loadConversations();
    await refreshVramStatus();
    window.alfieSoul?.pulse("completed", 2200, "idle", "purple");
    if (finalEvent?.status === "awaiting_user_approval") {
      toast("Alfie is waiting for your approval.");
      await loadToolsAndApprovals();
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
    if (assistantBody) {
      assistantBody.querySelector(".streaming-cursor")?.remove();
      const errText = "I couldn't complete that response. " + error.message;
      renderMarkdown(assistantBody, errText);
      attachCopyButtonToBody(assistantBody, errText);
      const messageArticle = assistantBody.closest(".message");
      if (messageArticle) {
        messageArticle.querySelector(".message-actions")?.remove();
        messageArticle.appendChild(createReactionControls({ role: "assistant", content: errText }));
      }
    }
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
    state.sending = false;
    input.disabled = false;
    input.value = "";
    input.style.height = "auto";
    input.focus();
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
composerInput.addEventListener("input", () => {
  composerInput.style.height = "auto";
  composerInput.style.height = Math.min(composerInput.scrollHeight, 180) + "px";
  if (composerInput.value.trim().length > 0 && window.alfieSoul?.getAnimationState() === "idle") {
    window.alfieSoul?.setAnimationState("listening");
  } else if (!composerInput.value.trim().length && window.alfieSoul?.getAnimationState() === "listening") {
    window.alfieSoul?.setAnimationState("idle");
  }
  const suggestions = $("#composer-suggestions");
  if (suggestions) {
    const val = composerInput.value.trim();
    if (val.startsWith("/") && !val.includes(" ")) {
      suggestions.hidden = false;
    } else {
      suggestions.hidden = true;
    }
  }
});
composerInput.addEventListener("keydown", (event) => {
  const suggestions = $("#composer-suggestions");
  if (event.key === "Tab" && suggestions && !suggestions.hidden) {
    event.preventDefault();
    composerInput.value = "/image ";
    suggestions.hidden = true;
    composerInput.focus();
    return;
  }
  if (event.key === "Escape" && suggestions && !suggestions.hidden) {
    event.preventDefault();
    suggestions.hidden = true;
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (suggestions) suggestions.hidden = true;
    $("#chat-form").requestSubmit();
  }
});

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

async function loadMemories() {
  const host = $("#memory-list");
  host.replaceChildren();
  const banner = $("#garden-offline-banner");
  const query = ($("#memory-search")?.value || "").trim().toLowerCase();

  function renderMemoryItems(memories, isCached = false) {
    host.replaceChildren();
    if (banner) banner.hidden = !isCached && navigator.onLine;
    let list = memories || [];

    // Filter by selected importance score from the Recharts bar chart
    if (gardenImportanceFilter !== null) {
      list = list.filter((m) => (Number(m.importance) || 5) === gardenImportanceFilter);
    }

    if (query) {
      list = list.filter((m) =>
        (m.text || "").toLowerCase().includes(query) ||
        (m.title || "").toLowerCase().includes(query) ||
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
      const meta = [
        memory.origin || "garden",
        "importance " + imp + (isHighPriority ? " ★" : ""),
        ...(memory.tags || [])
      ].join(" · ");
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
      const itemEl = createItem(memory.title || memory.text, meta, [edit, forget]);
      if (isHighPriority) {
        itemEl.classList.add("high-priority-memory");
      }
      host.appendChild(itemEl);
    }
    if (!list.length) {
      if (gardenImportanceFilter !== null) {
        host.textContent = `No memories with importance score ${gardenImportanceFilter} found.`;
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
    const payload = await api("/api/core/memories" + (query ? "?q=" + encodeURIComponent(query) : ""));
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

$("#refresh-memories").addEventListener("click", loadMemories);
$("#memory-search").addEventListener("input", () => {
  clearTimeout(loadMemories.timer);
  loadMemories.timer = setTimeout(loadMemories, 250);
});
$("#memory-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = event.currentTarget.elements.text.value.trim();
  if (!text) return;
  try {
    await api("/api/core/memories", { method: "POST", body: JSON.stringify({ text, importance: Number(event.currentTarget.elements.importance.value || 5), origin: "user-seeded", source: "user", type: "note" }) });
    event.currentTarget.reset();
    await loadMemories();
    toast("Memory planted in the Garden.");
  } catch (error) { toast(error.message); }
});

async function loadToolsAndApprovals() {
  const toolsHost = $("#tool-list");
  const pendingHost = $("#pending-list");
  const auditHost = $("#audit-list");
  toolsHost.replaceChildren();
  pendingHost.replaceChildren();
  auditHost.replaceChildren();
  try {
    const [tools, permissions, pending, audit] = await Promise.all([
      api("/api/core/tools"), api("/api/core/permissions"), api("/api/core/tools/pending"), api("/api/core/audit?limit=30")
    ]);
    const scopes = new Set(permissions.scopes || []);
    const groups = new Map();
    for (const tool of (tools.tools || [])) {
      if (!groups.has(tool.scope)) groups.set(tool.scope, []);
      groups.get(tool.scope).push(tool);
    }
    for (const [scope, scopedTools] of groups) {
      const allowed = scopes.has(scope);
      const names = scopedTools.map((tool) => tool.name || tool.id).join(", ");
      const button = {
        label: allowed ? "Revoke" : "Allow",
        kind: allowed ? "secondary-button" : "primary-button",
        onClick: async () => {
          try {
            await api("/api/core/permissions", { method: allowed ? "DELETE" : "POST", body: JSON.stringify({ scope }) });
            await loadToolsAndApprovals();
          } catch (error) { toast(error.message); }
        }
      };
      toolsHost.appendChild(createItem(scope, (allowed ? "Granted" : "Not granted") + " · " + scopedTools.length + " tool(s): " + names, [button]));
    }
    if (!tools.tools?.length) toolsHost.textContent = "No registered tools.";
    for (const action of (pending.actions || [])) {
      const approve = {
        label: "Approve",
        kind: "primary-button",
        onClick: async () => {
          try {
            window.alfieSoul?.setState("working", "cyan");
            await api("/api/core/tools/approve", { method: "POST", body: JSON.stringify({ actionId: action.id }) });
            toast("Action approved.");
            window.alfieSoul?.pulse("completed", 2000, "idle", "purple");
            await loadToolsAndApprovals();
          } catch (error) {
            window.alfieSoul?.setState("error", "red");
            toast(error.message);
          }
        }
      };
      const reject = {
        label: "Reject",
        onClick: async () => {
          try { await api("/api/core/tools/reject", { method: "POST", body: JSON.stringify({ actionId: action.id }) }); toast("Action rejected."); await loadToolsAndApprovals(); }
          catch (error) { toast(error.message); }
        }
      };
      pendingHost.appendChild(createItem(action.toolId, action.preview || action.reason || "Waiting for your decision.", [reject, approve]));
    }
    if (!pending.actions?.length) pendingHost.textContent = "Nothing is waiting for approval.";
    for (const event of (audit.events || [])) {
      auditHost.appendChild(createItem(event.event, [event.toolId, event.status, event.at ? new Date(event.at).toLocaleString() : ""].filter(Boolean).join(" · ")));
    }
    if (!audit.events?.length) auditHost.textContent = "No recent actions.";
  } catch (error) {
    toolsHost.textContent = error.message;
    pendingHost.textContent = "Approval history unavailable.";
    auditHost.textContent = "Activity history unavailable.";
  }
}

async function loadSettings() {
  const account = $("#account-status");
  const providers = $("#provider-status");
  const core = $("#core-status");
  account.textContent = "Checking…";
  providers.replaceChildren();
  core.replaceChildren();
  try {
    const [who, status, providerList, health] = await Promise.all([
      api("/api/core/whoami"), api("/api/core/status"), api("/api/core/providers"), api("/api/core/providers/health")
    ]);
    account.textContent = who.linked ? "Linked to your Petrio account · " + who.userId : "Not linked";
    providers.appendChild(createItem("Routing mode", String(providerList.mode || "auto").toUpperCase() + " · choose a mode from the chat composer to influence model selection."));
    for (const endpoint of (health.endpoints || [])) {
      const config = (providerList.endpoints || []).find((item) => item.id === endpoint.id) || {};
      const details = [
        endpoint.online ? "Online" : "Offline",
        config.provider || "provider",
        endpoint.model || config.model || "No model configured",
        config.mode || "standard",
        Number.isFinite(endpoint.latencyMs) ? endpoint.latencyMs + " ms" : ""
      ].filter(Boolean).join(" · ");
      providers.appendChild(createItem(config.name || endpoint.id, details));
      const installedModels = Array.isArray(endpoint.models) ? endpoint.models : [];
      if (installedModels.length) {
        providers.appendChild(createItem(
          "Installed on " + (config.name || endpoint.id),
          installedModels.map((model) => model === config.model ? model + " · ACTIVE" : model).join("  |  ")
        ));
      } else {
        providers.appendChild(createItem(
          "Model inventory · " + (config.name || endpoint.id),
          endpoint.online ? "No models are installed on this endpoint yet." : "Connect this endpoint to inspect its installed models."
        ));
      }
    }
    if (!health.endpoints?.length) providers.textContent = "No model endpoints configured.";
    core.textContent = (status.implemented || []).length + " capabilities active · " + (status.planned || []).length + " planned";
    await Promise.all([refreshVramStatus(), loadCloudAgents()]);
  } catch (error) {
    account.textContent = error.message;
    providers.textContent = "Provider information unavailable.";
    core.textContent = "Core status unavailable.";
  }
}

initialise();
