import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { GoogleGenAI } from "@google/genai";

export class ImageGenerator {
  constructor({
    dataDirectory = process.env.ALFIE_CORE_DATA_DIR || path.join(process.cwd(), "data", "core"),
    apiKey = process.env.GEMINI_API_KEY || "",
    uuid = randomUUID
  } = {}) {
    this.imagesDirectory = path.join(path.resolve(dataDirectory), "images");
    this.apiKey = apiKey;
    this.uuid = uuid;
    this._dirReady = null;
    this._aiClient = null;
    if (this.apiKey) {
      try {
        this._aiClient = new GoogleGenAI({
          apiKey: this.apiKey,
          httpOptions: {
            headers: {
              "User-Agent": "aistudio-build"
            }
          }
        });
      } catch (err) {
        console.warn("[Alfie ImageGenerator] Failed to initialize GoogleGenAI client:", err.message);
      }
    }
  }

  async ensureDirectory() {
    if (!this._dirReady) {
      this._dirReady = fs.mkdir(this.imagesDirectory, { recursive: true, mode: 0o700 });
    }
    await this._dirReady;
  }

  getFilePath(filename) {
    const clean = path.basename(filename);
    return path.join(this.imagesDirectory, clean);
  }

  async generate({ prompt, style = "pixel-art" }) {
    const cleanPrompt = String(prompt || "").trim().slice(0, 1000);
    if (!cleanPrompt) {
      throw Object.assign(new Error("A descriptive image prompt is required."), { status: 400 });
    }

    await this.ensureDirectory();
    const id = "img-" + this.uuid();

    // 1. If Gemini API key is configured, attempt generation with gemini-3.1-flash-lite-image
    if (this._aiClient && this.apiKey) {
      try {
        const fullPrompt = style && style !== "none"
          ? `${cleanPrompt}, ${style} style, vibrant high quality`
          : cleanPrompt;

        const response = await this._aiClient.models.generateContent({
          model: "gemini-3.1-flash-lite-image",
          contents: {
            parts: [{ text: fullPrompt }]
          }
        });

        for (const part of response.candidates?.[0]?.content?.parts ?? []) {
          if (part.inlineData?.data) {
            const mimeType = part.inlineData.mimeType || "image/png";
            const ext = mimeType.includes("jpeg") || mimeType.includes("jpg") ? "jpg" : "png";
            const filename = `${id}.${ext}`;
            const targetPath = this.getFilePath(filename);
            const buffer = Buffer.from(part.inlineData.data, "base64");
            await fs.writeFile(targetPath, buffer, { mode: 0o600 });
            return {
              id,
              filename,
              url: `/api/core/images/${filename}`,
              prompt: cleanPrompt,
              style,
              mimeType,
              width: 512,
              height: 512,
              provider: "gemini-3.1-flash-lite-image",
              createdAt: new Date().toISOString()
            };
          }
        }
      } catch (apiError) {
        console.warn("[Alfie ImageGenerator] Gemini image generation notice, falling back to local pixel generator:", apiError.message);
      }
    }

    // 2. Procedural Pixel Art Studio Fallback (deterministic, authentic retro pixel aesthetic)
    const svgContent = this.generatePixelArtSvg(cleanPrompt, style);
    const filename = `${id}.svg`;
    const targetPath = this.getFilePath(filename);
    await fs.writeFile(targetPath, svgContent, "utf8");

    return {
      id,
      filename,
      url: `/api/core/images/${filename}`,
      prompt: cleanPrompt,
      style,
      mimeType: "image/svg+xml",
      width: 512,
      height: 512,
      provider: "alfie-pixel-studio",
      createdAt: new Date().toISOString()
    };
  }

  async getImage(filename) {
    const clean = path.basename(filename);
    if (!/^[a-zA-Z0-9._-]{1,128}\.(png|svg|jpg|jpeg|webp)$/.test(clean)) {
      throw Object.assign(new Error("Invalid image filename."), { status: 400 });
    }
    const targetPath = this.getFilePath(clean);
    try {
      const buffer = await fs.readFile(targetPath);
      const ext = path.extname(clean).toLowerCase();
      const mimeTypes = {
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp"
      };
      return {
        buffer,
        mimeType: mimeTypes[ext] || "application/octet-stream"
      };
    } catch (err) {
      if (err.code === "ENOENT") {
        throw Object.assign(new Error("Visual asset not found."), { status: 404 });
      }
      throw err;
    }
  }

  generatePixelArtSvg(prompt, style = "pixel-art") {
    const hash = createHash("sha256").update(prompt.toLowerCase()).digest("hex");
    const seed = parseInt(hash.slice(0, 8), 16);

    const lprompt = prompt.toLowerCase();
    let theme = "obsidian";
    if (lprompt.includes("garden") || lprompt.includes("flower") || lprompt.includes("tree") || lprompt.includes("nature") || lprompt.includes("plant") || lprompt.includes("forest")) {
      theme = "garden";
    } else if (lprompt.includes("fire") || lprompt.includes("flame") || lprompt.includes("red") || lprompt.includes("dragon") || lprompt.includes("sun") || lprompt.includes("warm")) {
      theme = "flame";
    } else if (lprompt.includes("cyber") || lprompt.includes("matrix") || lprompt.includes("tech") || lprompt.includes("robot") || lprompt.includes("code") || lprompt.includes("terminal")) {
      theme = "matrix";
    } else if (lprompt.includes("space") || lprompt.includes("star") || lprompt.includes("galaxy") || lprompt.includes("moon") || lprompt.includes("planet") || lprompt.includes("cosmic")) {
      theme = "cosmic";
    } else if (lprompt.includes("soul") || lprompt.includes("orb") || lprompt.includes("alfie") || lprompt.includes("jarvis") || lprompt.includes("siri") || lprompt.includes("spirit")) {
      theme = "soul";
    }

    const palettes = {
      obsidian: {
        bg: "#0b061a",
        border: "#8b5cf6",
        frameBg: "#140c2e",
        c1: "#2e1065",
        c2: "#6b21a8",
        c3: "#8b5cf6",
        c4: "#c084fc",
        c5: "#38bdf8",
        accent: "#a78bfa"
      },
      garden: {
        bg: "#061a12",
        border: "#10b981",
        frameBg: "#0c2b20",
        c1: "#064e3b",
        c2: "#059669",
        c3: "#10b981",
        c4: "#6ee7b7",
        c5: "#fef08a",
        accent: "#34d399"
      },
      flame: {
        bg: "#1a0808",
        border: "#f43f5e",
        frameBg: "#2d0f0f",
        c1: "#7f1d1d",
        c2: "#b91c1c",
        c3: "#ea580c",
        c4: "#f97316",
        c5: "#fde047",
        accent: "#fb923c"
      },
      matrix: {
        bg: "#030d06",
        border: "#22c55e",
        frameBg: "#081f10",
        c1: "#14532d",
        c2: "#16a34a",
        c3: "#22c55e",
        c4: "#4ade80",
        c5: "#38bdf8",
        accent: "#86efac"
      },
      cosmic: {
        bg: "#06081e",
        border: "#38bdf8",
        frameBg: "#0e1338",
        c1: "#1e1b4b",
        c2: "#3730a3",
        c3: "#4f46e5",
        c4: "#818cf8",
        c5: "#f472b6",
        accent: "#38bdf8"
      },
      soul: {
        bg: "#0c0720",
        border: "#a855f7",
        frameBg: "#1b113b",
        c1: "#3b0764",
        c2: "#6b21a8",
        c3: "#9333ea",
        c4: "#c084fc",
        c5: "#38bdf8",
        accent: "#f472b6"
      }
    };

    const p = palettes[theme];
    const gridCols = 32;
    const gridRows = 32;
    const pixelSize = 14;
    const startX = 32;
    const startY = 32;

    const colors = [p.c1, p.c2, p.c3, p.c4, p.c5, p.accent];
    const rects = [];

    // Pseudo-random PRNG from seed
    let state = seed;
    function nextRnd() {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    }

    // Generate symmetrical / artistic pixel grid
    const halfCols = Math.floor(gridCols / 2);
    for (let y = 0; y < gridRows; y++) {
      for (let x = 0; x < halfCols; x++) {
        const dx = (x - halfCols + 0.5) / halfCols;
        const dy = (y - gridRows / 2 + 0.5) / (gridRows / 2);
        const dist = Math.sqrt(dx * dx + dy * dy);

        let active = false;
        let colorIndex = 0;

        if (theme === "soul") {
          // Circular pulsing orb with radiating rings
          if (dist < 0.85 && (Math.sin(dist * 12 + nextRnd() * 1.5) > -0.2)) {
            active = true;
            colorIndex = Math.min(5, Math.floor((1 - dist) * 6));
          }
        } else if (theme === "garden") {
          // Organic upward sprouting shapes
          const wave = Math.sin(x * 0.8) * 0.3 + 0.6;
          if (dy > 0.4 || (dist < wave && nextRnd() > 0.35)) {
            active = true;
            colorIndex = Math.floor(nextRnd() * colors.length);
          }
        } else if (theme === "flame") {
          // Upward flame tapering
          const flameWidth = Math.max(0.1, 1 - (y / gridRows) * 0.9);
          if (Math.abs(dx) < flameWidth && nextRnd() > (y / gridRows) * 0.6) {
            active = true;
            colorIndex = Math.floor((1 - (y / gridRows)) * 5);
          }
        } else if (theme === "matrix") {
          // Digital circuit matrix / glyphs
          if ((x % 3 === 0 || y % 4 === 0) && nextRnd() > 0.4) {
            active = true;
            colorIndex = Math.floor(nextRnd() * colors.length);
          }
        } else {
          // Cosmic / obsidian crest
          if (dist < 0.75 && nextRnd() > 0.32) {
            active = true;
            colorIndex = Math.floor(nextRnd() * colors.length);
          }
        }

        // Add subtle background twinkling stars
        if (!active && nextRnd() > 0.96) {
          active = true;
          colorIndex = 4;
        }

        if (active) {
          const col = colors[colorIndex] || p.c3;
          // Left side
          rects.push(`<rect x="${startX + x * pixelSize}" y="${startY + y * pixelSize}" width="${pixelSize}" height="${pixelSize}" fill="${col}" />`);
          // Right side (symmetrical reflection for striking crest/emblem look)
          const mirrorX = gridCols - 1 - x;
          rects.push(`<rect x="${startX + mirrorX * pixelSize}" y="${startY + y * pixelSize}" width="${pixelSize}" height="${pixelSize}" fill="${col}" />`);
        }
      }
    }

    const titleSafe = prompt
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .slice(0, 48);

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" shape-rendering="crispEdges">
  <defs>
    <radialGradient id="auraGlow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${p.accent}" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="${p.bg}" stop-opacity="0"/>
    </radialGradient>
    <pattern id="scanlines" width="512" height="4" patternUnits="userSpaceOnUse">
      <line x1="0" y1="0" x2="512" y2="0" stroke="#000000" stroke-opacity="0.12" stroke-width="1.5" />
    </pattern>
    <filter id="pixelGlow">
      <feDropShadow dx="0" dy="0" stdDeviation="4" flood-color="${p.accent}" flood-opacity="0.4"/>
    </filter>
  </defs>

  <!-- Background Canvas -->
  <rect width="512" height="512" fill="${p.bg}" />
  <rect x="16" y="16" width="480" height="480" fill="${p.frameBg}" stroke="${p.border}" stroke-width="3" rx="8" />
  <rect x="24" y="24" width="464" height="464" fill="url(#auraGlow)" />

  <!-- Pixel Grid Art -->
  <g filter="url(#pixelGlow)">
    ${rects.join("\n    ")}
  </g>

  <!-- Scanlines overlay -->
  <rect width="512" height="512" fill="url(#scanlines)" pointer-events="none" />

  <!-- Pixel corners & frame accents -->
  <rect x="16" y="16" width="12" height="12" fill="${p.accent}" />
  <rect x="484" y="16" width="12" height="12" fill="${p.accent}" />
  <rect x="16" y="484" width="12" height="12" fill="${p.accent}" />
  <rect x="484" y="484" width="12" height="12" fill="${p.accent}" />

  <!-- Badge banner -->
  <g transform="translate(32, 456)">
    <rect x="0" y="0" width="448" height="32" fill="#000000" fill-opacity="0.75" stroke="${p.border}" stroke-width="1.5" rx="4" />
    <text x="14" y="21" fill="${p.c4}" font-family="monospace, monospace" font-size="12" font-weight="bold">◈ ALFIE STUDIO · ${titleSafe}</text>
  </g>
</svg>`;
  }
}
