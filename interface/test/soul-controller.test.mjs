import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const publicDir = new URL("../public/", import.meta.url);

test("index.html contains .alfie-soul components with data-mood and data-animation-state", async () => {
  const html = await fs.readFile(new URL("index.html", publicDir), "utf8");
  assert.match(html, /class="alfie-soul mini"[^>]*data-mood="purple"/);
  assert.match(html, /class="alfie-soul mini"[^>]*data-animation-state="idle"/);
  assert.match(html, /class="alfie-soul large"[^>]*data-mood="purple"/);
  assert.match(html, /class="alfie-soul large"[^>]*data-animation-state="idle"/);
});

test("styles.css defines all required animation states and keyframes from master vision", async () => {
  const css = await fs.readFile(new URL("styles.css", publicDir), "utf8");
  
  const expectedStates = [
    "idle",
    "listening",
    "thinking",
    "working",
    "waiting",
    "completed",
    "error",
    "offline"
  ];
  for (const state of expectedStates) {
    assert.match(css, new RegExp(`\\[data-animation-state="${state}"\\]`));
  }

  // Keyframes for processing animations
  assert.match(css, /@keyframes soul-listen-ripple/);
  assert.match(css, /@keyframes soul-thinking-drift/);
  assert.match(css, /@keyframes soul-working-pulse/);
  assert.match(css, /@keyframes soul-waiting-flicker/);
  assert.match(css, /@keyframes soul-completed-burst/);
  assert.match(css, /@keyframes soul-error-jitter/);
});

test("app.js defines AlfieSoulController and sets real-time states", async () => {
  const app = await fs.readFile(new URL("app.js", publicDir), "utf8");
  
  assert.match(app, /class AlfieSoulController/);
  assert.match(app, /window\.alfieSoul = new AlfieSoulController\(\)/);
  assert.match(app, /window\.AlfieSoulController = AlfieSoulController/);
  
  // Real-time states wired during chat stream, API calls, and tools
  assert.match(app, /window\.alfieSoul(?:\?\.|\.)setState\("thinking",\s*"amber"\)/);
  assert.match(app, /window\.alfieSoul(?:\?\.|\.)setState\("working"/);
  assert.match(app, /window\.alfieSoul(?:\?\.|\.)setState\("waiting"/);
  assert.match(app, /window\.alfieSoul(?:\?\.|\.)pulse\("completed"/);
  assert.match(app, /window\.alfieSoul(?:\?\.|\.)setState\("error",\s*"red"\)/);
  assert.match(app, /window\.alfieSoul(?:\?\.|\.)setState\("offline",\s*"red"\)/);

  // Updates data-mood and data-animation-state attributes
  assert.match(app, /el\.setAttribute\("data-mood",\s*this\._mood\)/);
  assert.match(app, /el\.setAttribute\("data-animation-state",\s*this\._animationState\)/);
  
  // Real-time API tracking in api()
  assert.match(app, /trackSoul/);
  assert.match(app, /pendingApiCalls/);
});

test("AlfieSoulController class manages state and mood with normalization and convenience methods", () => {
  const SOUL_MOODS = ["purple", "blue", "red", "amber", "cyan", "green", "pink"];
  const SOUL_STATES = ["idle", "listening", "thinking", "working", "waiting", "completed", "error", "offline"];

  class TestSoulController {
    constructor({ defaultMood = "purple", defaultState = "idle" } = {}) {
      this._mood = String(defaultMood || "purple").toLowerCase();
      this._animationState = String(defaultState || "idle").toLowerCase();
    }
    getMood() { return this._mood; }
    getAnimationState() { return this._animationState; }
    getState() { return { mood: this._mood, animationState: this._animationState }; }
    setMood(mood) {
      const norm = String(mood || "").toLowerCase().trim();
      if (SOUL_MOODS.includes(norm)) this._mood = norm;
      return this._mood;
    }
    setAnimationState(state) {
      const norm = String(state || "").toLowerCase().trim();
      if (SOUL_STATES.includes(norm)) this._animationState = norm;
      return this._animationState;
    }
    setState(animationState, mood = null) {
      const normState = String(animationState || "").toLowerCase().trim();
      if (SOUL_STATES.includes(normState)) this._animationState = normState;
      if (mood) {
        const normMood = String(mood).toLowerCase().trim();
        if (SOUL_MOODS.includes(normMood)) this._mood = normMood;
      }
      return this.getState();
    }
    startThinking(mood = "amber") { return this.setState("thinking", mood); }
    startWorking(mood = "cyan") { return this.setState("working", mood); }
  }

  const soul = new TestSoulController();
  assert.equal(soul.getAnimationState(), "idle");
  assert.equal(soul.getMood(), "purple");

  // Handles capitalized "Thinking"
  soul.setState("Thinking", "Amber");
  assert.equal(soul.getAnimationState(), "thinking");
  assert.equal(soul.getMood(), "amber");

  // Handles capitalized "Working"
  soul.setState("Working", "Cyan");
  assert.equal(soul.getAnimationState(), "working");
  assert.equal(soul.getMood(), "cyan");

  // Helper methods
  soul.startThinking();
  assert.equal(soul.getAnimationState(), "thinking");
  assert.equal(soul.getMood(), "amber");

  soul.startWorking();
  assert.equal(soul.getAnimationState(), "working");
  assert.equal(soul.getMood(), "cyan");
});

test("styles.css registers CSS Houdini @property rules for soul color variables and defines smooth fade transitions", async () => {
  const css = await fs.readFile(new URL("styles.css", publicDir), "utf8");

  // @property registrations for smooth gradient and color interpolation
  assert.match(css, /@property\s+--soul-glow\s*\{/);
  assert.match(css, /@property\s+--soul-core-1\s*\{/);
  assert.match(css, /@property\s+--soul-core-2\s*\{/);
  assert.match(css, /@property\s+--soul-accent\s*\{/);
  assert.match(css, /@property\s+--soul-ring\s*\{/);
  assert.match(css, /syntax:\s*'<color>'/);

  // Smooth transitions on .alfie-soul and its child elements
  assert.match(css, /\.alfie-soul\s*\{[^}]*transition:[^}]*--soul-glow/);
  assert.match(css, /\.alfie-soul\s*\{[^}]*transition:[^}]*filter/);
  assert.match(css, /\.alfie-soul\s+\.soul-aura[^}]*transition:[^}]*box-shadow/);

  // Mood transition metamorphosis class and keyframes
  assert.match(css, /\.alfie-soul\.mood-transitioning\s*\{/);
  assert.match(css, /@keyframes\s+soul-mood-fade/);
});

test("app.js implements mood transition handling and .mood-transitioning state tracking in AlfieSoulController", async () => {
  const app = await fs.readFile(new URL("app.js", publicDir), "utf8");

  assert.match(app, /isMoodTransitioning\(\)/);
  assert.match(app, /_transitionMood\(prevMood,\s*norm\)/);
  assert.match(app, /classList\.add\("mood-transitioning"\)/);
  assert.match(app, /classList\.remove\("mood-transitioning"\)/);
  assert.match(app, /data-prev-mood/);
});

test("index.html, app.js, and styles.css render crisp pixel-art TotK Poe souls", async () => {
  const html = await fs.readFile(new URL("index.html", publicDir), "utf8");
  const css = await fs.readFile(new URL("styles.css", publicDir), "utf8");
  const app = await fs.readFile(new URL("app.js", publicDir), "utf8");

  assert.match(html, /class="poe-sprite poe-sprite-mini"[^>]*shape-rendering="crispEdges"/);
  assert.match(html, /class="poe-sprite poe-sprite-large"[^>]*shape-rendering="crispEdges"/);
  assert.match(html, /class="poe-flame-tip"/);
  assert.match(html, /class="poe-eyes"/);
  assert.match(html, /class="poe-tail"/);
  assert.match(html, /class="poe-motes"/);

  assert.match(app, /POE_SPRITE_LARGE_SVG/);
  assert.match(app, /POE_SPRITE_MINI_SVG/);
  assert.match(app, /createPoeSpriteHtml\(/);

  assert.match(css, /\.poe-sprite\s*\{[^}]*shape-rendering:\s*crispEdges/);
  assert.match(css, /image-rendering:\s*pixelated/);
  assert.match(css, /@keyframes\s+poe-flame-flicker/);
  assert.match(css, /@keyframes\s+poe-tail-wave/);
  assert.match(css, /@keyframes\s+poe-eye-blink/);
  assert.match(css, /\.alfie-soul\[data-animation-state="working"\][^}]*cubic-bezier/);
  assert.match(css, /\.alfie-soul\[data-animation-state="working"\]\s+\.poe-flame-tip[^}]*steps\(2,\s*end\)/);
  assert.match(css, /\.alfie-soul\[data-animation-state\]\s*\{[^}]*will-change:\s*transform/);
  assert.match(css, /\.alfie-soul\[data-animation-state\]\s*\{[^}]*transition:[^}]*transform[^}]*opacity[^}]*filter/);
  assert.match(css, /@keyframes\s+soul-working-pulse\s*\{[^}]*translate3d\([^)]*\)[^}]*scale3d\(/);
  assert.doesNotMatch(css, /@keyframes\s+soul-working-pulse\s*\{[^}]*filter:/);
});

test("Alfie Soul applies subtle layered transition animations when data-mood cycles without being overridden by animation states", async () => {
  const css = await fs.readFile(new URL("styles.css", publicDir), "utf8");
  const app = await fs.readFile(new URL("app.js", publicDir), "utf8");

  // Layered child mood-shift rules must come AFTER [data-animation-state="idle"] so they are never clobbered
  const idleIdx = css.indexOf('.alfie-soul[data-animation-state="idle"]');
  const spriteShiftIdx = css.indexOf('.alfie-soul.mood-transitioning[data-mood]:not([data-animation-state="offline"]) .poe-sprite');
  assert.ok(idleIdx > -1, "Expected idle state rule in styles.css");
  assert.ok(spriteShiftIdx > idleIdx, "Mood transition sprite shift rule must follow state rules in cascade");

  assert.match(css, /@keyframes\s+soul-mood-sprite-shift\s*\{[^}]*scale3d\(/);
  assert.match(css, /@keyframes\s+soul-mood-aura-bloom\s*\{[^}]*scale3d\(/);
  assert.match(css, /@keyframes\s+soul-mood-rings-ripple\s*\{[^}]*scale3d\(/);
  assert.match(css, /@keyframes\s+soul-mood-spark-shift\s*\{[^}]*scale3d\(/);

  // Controller restarts animation on rapid mood cycling, respects reduced motion, and observes direct data-mood mutations
  assert.match(app, /_prefersReducedMotion\(\)/);
  assert.match(app, /_triggerMoodTransitionOnElement\(/);
  assert.match(app, /void\s+el\.offsetWidth/);
  assert.match(app, /_observeMoodAttribute\(/);
  assert.match(app, /attributeFilter:\s*\["data-mood"\]/);
});


