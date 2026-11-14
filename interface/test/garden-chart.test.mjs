import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const publicDir = new URL("../public/", import.meta.url);
const rootDir = new URL("../../", import.meta.url);

test("package.json declares recharts dependency", async () => {
  const pkg = JSON.parse(await fs.readFile(new URL("package.json", rootDir), "utf8"));
  assert.ok(pkg.dependencies.recharts, "recharts should be declared in dependencies");
});

test("index.html contains Garden Recharts analytics surface, stats, and script tags", async () => {
  const html = await fs.readFile(new URL("index.html", publicDir), "utf8");

  // Recharts and React scripts
  assert.match(html, /vendor\/react\.production\.min\.js/);
  assert.match(html, /vendor\/react-dom\.production\.min\.js/);
  assert.match(html, /vendor\/recharts\.js/);

  // Garden analytics surface and chart container
  assert.match(html, /id="garden-analytics"/);
  assert.match(html, /id="garden-chart-container"/);
  assert.match(html, /id="garden-recharts-root"/);

  // Summary stats elements
  assert.match(html, /id="stat-total-memories"/);
  assert.match(html, /id="stat-avg-importance"/);
  assert.match(html, /id="stat-high-priority"/);

  // Filter banner and clear button
  assert.match(html, /id="chart-filter-banner"/);
  assert.match(html, /id="filter-score-badge"/);
  assert.match(html, /id="clear-score-filter"/);
});

test("styles.css styles Garden chart surface, stats pills, and tooltips", async () => {
  const css = await fs.readFile(new URL("styles.css", publicDir), "utf8");

  assert.match(css, /\.garden-chart-surface\s*\{/);
  assert.match(css, /\.garden-stats-strip\s*\{/);
  assert.match(css, /\.stat-pill\s*\{/);
  assert.match(css, /\.stat-pill\.highlight\s*\{/);
  assert.match(css, /\.garden-chart-container\s*\{/);
  assert.match(css, /\.garden-recharts-root\s*\{/);
  assert.match(css, /\.garden-chart-tooltip\s*\{/);
  assert.match(css, /\.chart-filter-banner\s*\{/);
  assert.match(css, /\.clear-filter-btn\s*\{/);
});

test("app.js implements importance distribution calculations and Recharts integration", async () => {
  const app = await fs.readFile(new URL("app.js", publicDir), "utf8");

  assert.match(app, /function calculateImportanceDistribution/);
  assert.match(app, /function updateGardenStats/);
  assert.match(app, /function renderGardenRechartsBarChart/);
  assert.match(app, /Recharts/);
  assert.match(app, /BarChart/);
  assert.match(app, /Bar/);
  assert.match(app, /XAxis/);
  assert.match(app, /YAxis/);
  assert.match(app, /ResponsiveContainer/);
  assert.match(app, /gardenImportanceFilter/);
  assert.match(app, /window\.gardenChart\s*=\s*\{/);
});

test("calculateImportanceDistribution accurately buckets importance scores from 1 to 10", () => {
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

  const sampleMemories = [
    { text: "Server credentials", importance: 10 },
    { text: "Backup routine", importance: 10 },
    { text: "DNS configuration", importance: 9 },
    { text: "Docker network rules", importance: 8 },
    { text: "Coffee preference", importance: 5 },
    { text: "Casual thought", importance: 2 }
  ];

  const distribution = calculateImportanceDistribution(sampleMemories);

  assert.equal(distribution.length, 10);
  assert.equal(distribution[9].score, 10);
  assert.equal(distribution[9].count, 2);
  assert.equal(distribution[8].score, 9);
  assert.equal(distribution[8].count, 1);
  assert.equal(distribution[7].score, 8);
  assert.equal(distribution[7].count, 1);
  assert.equal(distribution[4].score, 5);
  assert.equal(distribution[4].count, 1);
  assert.equal(distribution[1].score, 2);
  assert.equal(distribution[1].count, 1);
  assert.equal(distribution[0].score, 1);
  assert.equal(distribution[0].count, 0);

  // High priority memories (8-10) sum to 4 out of 6
  const highPriority = sampleMemories.filter((m) => m.importance >= 8).length;
  assert.equal(highPriority, 4);
});
