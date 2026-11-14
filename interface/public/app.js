const $ = (selector) => document.querySelector(selector);
const state = {
  user: null,
  csrfToken: "",
  linked: false,
  activeConversationId: null,
  messages: [],
  conversations: [],
  view: "chat",
  sending: false,
  conversationLoadToken: 0,
  conversationLoading: false
};

let pendingApiCalls = 0;

async function api(route, options = {}) {
  const isSilent = typeof route === "string" && (route.includes("/whoami") || route.includes("/auth/me"));
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
    if (trackSoul) window.alfieSoul?.setState("error", "red");
    throw error;
  } finally {
    if (trackSoul) {
      pendingApiCalls = Math.max(0, pendingApiCalls - 1);
      if (pendingApiCalls === 0) {
        const animationState = window.alfieSoul.getAnimationState();
        if (animationState === "thinking") {
          window.alfieSoul.setState("idle", "purple");
        } else if (animationState === "error") {
          setTimeout(() => {
            if (pendingApiCalls === 0 && window.alfieSoul?.getAnimationState() === "error") {
              window.alfieSoul.setState("idle", "purple");
            }
          }, 2400);
        }
      }
    }
  }
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("visible");
  clearTimeout(toast.timeout);
  toast.timeout = setTimeout(() => el.classList.remove("visible"), 3200);
}

function setConnection(online, label) {
  $("#connection-dot").classList.toggle("online", Boolean(online));
  $("#connection-label").textContent = label;
  if (!online) {
    window.alfieSoul?.setOffline("red");
  } else if (window.alfieSoul?.getAnimationState() === "offline") {
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

function showLogin() {
  const loginScreen = $("#login-screen");
  const appShell = $("#app-shell");
  if (loginScreen) {
    loginScreen.classList.remove("is-leaving", "is-form-focused");
    loginScreen.hidden = false;
  }
  if (appShell) {
    appShell.classList.remove("is-entering");
    appShell.hidden = true;
  }
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
  const loginForm = $("#login-form");
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

  if (loginScreen && loginForm) {
    loginForm.addEventListener("focusin", () => {
      loginScreen.classList.add("is-form-focused");
      if (window.alfieSoul?.getAnimationState() === "idle") {
        window.alfieSoul.setAnimationState("listening");
      }
    });
    loginForm.addEventListener("focusout", (event) => {
      if (event.relatedTarget && loginForm.contains(event.relatedTarget)) return;
      loginScreen.classList.remove("is-form-focused");
      if (window.alfieSoul?.getAnimationState() === "listening") {
        window.alfieSoul.setAnimationState("idle");
      }
    });
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
  setConnection(false, "Account not linked");
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
      showLogin();
      $("#setup-message").hidden = false;
      $("#login-error").textContent = "Create the first account by setting the bootstrap username and password in the server environment.";
      return;
    }
    if (!session.authenticated) {
      showLogin();
      return;
    }
    state.user = session.user;
    state.csrfToken = session.csrfToken;
    showApp();
    try {
      await refreshIdentity();
      if (state.linked) await loadConversations();
    } catch (error) {
      setConnection(false, "Core unavailable");
      toast(error.message);
    }
  } catch (error) {
    showLogin();
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
    if (state.linked) await loadConversations();
  } catch (error) {
    $("#login-error").textContent = error.message;
    window.alfieSoul?.pulse("error", 1600, "idle", "purple");
  } finally {
    if (button) button.disabled = false;
  }
});

async function logout() {
  try { await api("/api/auth/logout", { method: "POST", body: "{}" }); }
  catch (error) { toast(error.message); }
  state.user = null;
  state.csrfToken = "";
  state.linked = false;
  state.activeConversationId = null;
  state.conversationLoadToken += 1;
  state.conversationLoading = false;
  state.messages = [];
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
    form.reset();
    state.user = null;
    state.csrfToken = "";
    state.linked = false;
    state.activeConversationId = null;
    state.conversationLoadToken += 1;
    state.conversationLoading = false;
    state.messages = [];
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
    await loadConversations();
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
    await loadConversations();
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

function renderConversationList(host, conversations = []) {
  if (!host) return;
  host.replaceChildren();
  const searchId = host.id === "mobile-conversation-list" ? "#mobile-history-search" : "#history-search";
  const query = String($(searchId)?.value || "").trim().toLowerCase();
  const visibleConversations = conversations.filter((item) => !query || String(item.title || "New conversation").toLowerCase().includes(query));
  for (const item of visibleConversations) {
    const row = document.createElement("div");
    row.className = "conversation-row";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "conversation-item" + (item.id === state.activeConversationId ? " active" : "");
    button.textContent = item.title || "New conversation";
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
    empty.textContent = conversations.length ? "No conversations match that search." : "Your conversations will appear here.";
    host.appendChild(empty);
  }
}

function renderConversations(conversations = []) {
  renderConversationList($("#conversation-list"), conversations);
  renderConversationList($("#mobile-conversation-list"), conversations);
}

async function loadConversations() {
  const payload = await api("/api/core/conversations");
  const conversations = payload.conversations || [];
  state.conversations = conversations;
  renderConversations(conversations);
  if (!state.activeConversationId && conversations.length) await loadConversation(conversations[0].id);
}

async function loadConversation(id) {
  if (state.sending) { toast("Wait for Alfie's current reply before switching conversations."); return; }
  const token = ++state.conversationLoadToken;
  state.conversationLoading = true;
  try {
    const payload = await api("/api/core/conversations/" + encodeURIComponent(id));
    if (token !== state.conversationLoadToken) return;
    state.activeConversationId = id;
    state.messages = payload.conversation?.messages || [];
    renderMessages();
    const list = await api("/api/core/conversations");
    if (token === state.conversationLoadToken) {
      state.conversations = list.conversations || [];
      renderConversations(state.conversations);
    }
  } finally {
    if (token === state.conversationLoadToken) state.conversationLoading = false;
  }
}

async function newConversation({ fromSend = false } = {}) {
  if (state.sending && !fromSend) { toast("Wait for Alfie's current reply before starting another conversation."); return; }
  const token = ++state.conversationLoadToken;
  state.conversationLoading = true;
  $("#mobile-history-sheet").hidden = true;
  try {
    const payload = await api("/api/core/conversations", { method: "POST", body: JSON.stringify({ title: "New conversation" }) });
    if (token !== state.conversationLoadToken) return;
    state.activeConversationId = payload.conversation.id;
    state.messages = [];
    renderMessages();
    await loadConversations();
    setView("chat");
  } finally {
    if (token === state.conversationLoadToken) state.conversationLoading = false;
  }
}

$("#new-chat").addEventListener("click", () => newConversation().catch((error) => toast(error.message)));
$("#refresh-conversations").addEventListener("click", () => loadConversations().catch((error) => toast(error.message)));
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
      state.messages = [];
      state.conversationLoadToken += 1;
      renderMessages();
    }
    await loadConversations();
    toast("Conversation deleted.");
  } catch (error) { toast(error.message); }
}

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

function renderMessages() {
  const host = $("#messages");
  host.replaceChildren();
  if (!state.messages.length) {
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
    return;
  }
  for (const message of state.messages) appendMessageElement(message);
  scrollChatToBottom({ force: true });
}

async function persistMessage(role, content, conversationId = state.activeConversationId, metrics = null) {
  const payload = await api("/api/core/conversations/" + encodeURIComponent(conversationId) + "/messages", {
    method: "POST",
    body: JSON.stringify({ role, content, ...(metrics ? { metrics } : {}) })
  });
  if (conversationId === state.activeConversationId) state.messages.push(payload.message || { role, content, ...(metrics ? { metrics } : {}) });
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
    const response = await fetch("/api/core/chat/stream", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrf-token": state.csrfToken },
      body: JSON.stringify({
        messages: state.messages.slice(-16).map(({ role, content: text, reaction }) => ({
          role,
          content: text,
          ...(reaction ? { reaction } : {})
        })),
        mode: $("#model-mode").value
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
    const metrics = { latencyMs, completionTokens, totalTokens, model };

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

$("#chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage(event.currentTarget.elements.message.value);
});

const composerInput = $("#chat-form").elements.message;
composerInput.addEventListener("focus", () => {
  if (window.alfieSoul?.getAnimationState() === "idle") {
    window.alfieSoul?.setAnimationState("listening");
  }
});
composerInput.addEventListener("blur", () => {
  if (window.alfieSoul?.getAnimationState() === "listening") {
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
  } catch (error) {
    account.textContent = error.message;
    providers.textContent = "Provider information unavailable.";
    core.textContent = "Core status unavailable.";
  }
}

initialise();
