import test from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/tools/registry.mjs";
import {
  registerWebResearchTools,
  validatePublicWebUrl,
  extractReadableText,
  parseWeatherLocationQuery,
  selectBestGeocodeResult,
  BoundedTtlCache,
  isTransitTimeQuery
} from "../src/integrations/webResearch.mjs";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

test("web reader extracts title, description and readable text without scripts", () => {
  const result = extractReadableText('<html><head><title>Example &amp; Test</title><meta name="description" content="A page"></head><body><nav>Menu</nav><h1>Hello</h1><script>ignoreThis()</script><p>Useful content.</p></body></html>');
  assert.equal(result.title, "Example & Test");
  assert.equal(result.description, "A page");
  assert.match(result.text, /Hello/);
  assert.match(result.text, /Useful content/);
  assert.doesNotMatch(result.text, /ignoreThis|Menu/);
});

test("web URL validation allows public HTTPS and blocks local or non-HTTPS destinations", async () => {
  const url = await validatePublicWebUrl("https://example.com/article#section", { lookupImpl: publicLookup });
  assert.equal(url.hash, "");
  await assert.rejects(() => validatePublicWebUrl("http://example.com", { lookupImpl: publicLookup }), /HTTPS/);
  await assert.rejects(() => validatePublicWebUrl("https://localhost", { lookupImpl: publicLookup }), /Local and internal/);
  await assert.rejects(() => validatePublicWebUrl("https://192.168.1.1", { lookupImpl: publicLookup }), /public IP/);
  await assert.rejects(() => validatePublicWebUrl("https://example.com", { lookupImpl: async () => [{ address: "10.0.0.2", family: 4 }] }), /public IP/);
});

test("registers four read-only external web tools under one permission scope", () => {
  const registry = new ToolRegistry();
  registerWebResearchTools(registry, { fetchImpl: async () => new Response(JSON.stringify({ web: { results: [] } }), { status: 200, headers: { "content-type": "application/json" } }), lookupImpl: publicLookup });
  const tools = registry.list(["web:read"]);
  assert.deepEqual(tools.map((tool) => tool.id), ["web.search", "web.open", "web.research", "web.weather"]);
  for (const tool of tools) {
    assert.equal(tool.scope, "web:read");
    assert.equal(tool.risk, "read");
    assert.equal(tool.network, true);
    assert.equal(tool.externalAction, false);
    assert.equal(tool.permitted, true);
  }
});

test("Brave fallback requires a server-side API key and returns bounded results", async () => {
  const previous = process.env.ALFIE_BRAVE_SEARCH_API_KEY;
  const previousSearxng = process.env.ALFIE_SEARXNG_URL;
  delete process.env.ALFIE_SEARXNG_URL;
  process.env.ALFIE_BRAVE_SEARCH_API_KEY = "test-key";
  try {
    let requested;
    const registry = new ToolRegistry();
    registerWebResearchTools(registry, { fetchImpl: async (url, options) => {
      requested = { url: String(url), options };
      return new Response(JSON.stringify({ web: { results: [
        { title: "One", url: "https://example.com/one", description: "Summary" },
        { title: "Two", url: "https://example.com/two", description: "Summary" }
      ] } }), { status: 200, headers: { "content-type": "application/json" } });
    }, lookupImpl: publicLookup });
    const result = await registry.tools.get("web.search").handler({ query: "test topic", count: 1 });
    assert.equal(result.resultCount, 1);
    assert.equal(result.results[0].title, "One");
    assert.match(requested.url, /q=test\+topic/);
    assert.equal(requested.options.headers["X-Subscription-Token"], "test-key");
  } finally {
    if (previous === undefined) delete process.env.ALFIE_BRAVE_SEARCH_API_KEY;
    else process.env.ALFIE_BRAVE_SEARCH_API_KEY = previous;
    if (previousSearxng === undefined) delete process.env.ALFIE_SEARXNG_URL;
    else process.env.ALFIE_SEARXNG_URL = previousSearxng;
  }
});

test("web.open pins the request to the validated public DNS address and refuses private redirects", async () => {
  let calls = 0;
  let pinnedAddresses;
  const registry = new ToolRegistry();
  registerWebResearchTools(registry, {
    requestImpl: async (_url, options) => {
      calls += 1;
      pinnedAddresses = options.addresses;
      return new Response("", { status: 302, headers: { location: "https://127.0.0.1/admin" } });
    },
    lookupImpl: publicLookup
  });
  await assert.rejects(() => registry.tools.get("web.open").handler({ url: "https://example.com" }), /public IP/);
  assert.equal(calls, 1);
  assert.deepEqual(pinnedAddresses, [{ address: "93.184.216.34", family: 4 }]);
});


test("web.search prefers the configured private SearXNG JSON API", async () => {
  const previousUrl = process.env.ALFIE_SEARXNG_URL;
  const previousKey = process.env.ALFIE_BRAVE_SEARCH_API_KEY;
  process.env.ALFIE_SEARXNG_URL = "http://searxng:8080";
  delete process.env.ALFIE_BRAVE_SEARCH_API_KEY;
  try {
    let requested;
    const registry = new ToolRegistry();
    registerWebResearchTools(registry, { fetchImpl: async (url, options) => {
      requested = { url: String(url), options };
      return new Response(JSON.stringify({ results: [
        { title: "SearX result", url: "https://example.com/result", content: "A useful summary", engines: ["duckduckgo"] }
      ] }), { status: 200, headers: { "content-type": "application/json" } });
    }, lookupImpl: publicLookup });
    const result = await registry.tools.get("web.search").handler({ query: "test topic", count: 2 });
    assert.equal(result.provider, "SearXNG");
    assert.equal(result.resultCount, 1);
    assert.equal(result.results[0].title, "SearX result");
    assert.match(requested.url, /^http:\/\/searxng:8080\/search\?/);
    assert.match(requested.url, /format=json/);
    assert.equal(requested.options.headers.Accept, "application/json");
  } finally {
    if (previousUrl === undefined) delete process.env.ALFIE_SEARXNG_URL;
    else process.env.ALFIE_SEARXNG_URL = previousUrl;
    if (previousKey === undefined) delete process.env.ALFIE_BRAVE_SEARCH_API_KEY;
    else process.env.ALFIE_BRAVE_SEARCH_API_KEY = previousKey;
  }
});

test("web.search falls back to Brave when SearXNG is unavailable", async () => {
  const previousUrl = process.env.ALFIE_SEARXNG_URL;
  const previousKey = process.env.ALFIE_BRAVE_SEARCH_API_KEY;
  process.env.ALFIE_SEARXNG_URL = "http://searxng:8080";
  process.env.ALFIE_BRAVE_SEARCH_API_KEY = "fallback-test-key";
  try {
    let calls = 0;
    const registry = new ToolRegistry();
    registerWebResearchTools(registry, { fetchImpl: async (url) => {
      calls += 1;
      if (String(url).startsWith("http://searxng:8080")) {
        return new Response("unavailable", { status: 503 });
      }
      return new Response(JSON.stringify({ web: { results: [
        { title: "Brave fallback", url: "https://example.com/fallback", description: "Fallback summary" }
      ] } }), { status: 200, headers: { "content-type": "application/json" } });
    }, lookupImpl: publicLookup });
    const result = await registry.tools.get("web.search").handler({ query: "test topic" });
    assert.equal(calls, 2);
    assert.equal(result.provider, "Brave Search");
    assert.match(result.fallbackReason, /SearXNG returned HTTP 503/);
    assert.equal(result.results[0].title, "Brave fallback");
  } finally {
    if (previousUrl === undefined) delete process.env.ALFIE_SEARXNG_URL;
    else process.env.ALFIE_SEARXNG_URL = previousUrl;
    if (previousKey === undefined) delete process.env.ALFIE_BRAVE_SEARCH_API_KEY;
    else process.env.ALFIE_BRAVE_SEARCH_API_KEY = previousKey;
  }
});

test("web.weather geocodes a named city and returns compact current + 2-day forecast", async () => {
  const requests = [];
  const registry = new ToolRegistry();
  registerWebResearchTools(registry, {
    requestImpl: async () => { throw new Error("should not call default pinned request when custom requestImpl is used"); },
    fetchImpl: async (url) => {
      const target = String(url);
      requests.push(target);
      if (target.includes("geocoding-api.open-meteo.com")) {
        return new Response(JSON.stringify({
          results: [{ name: "Manchester", admin1: "England", country: "United Kingdom", latitude: 53.4808, longitude: -2.2426, timezone: "Europe/London" }]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        timezone: "Europe/London",
        current: { time: "2026-11-25T12:00", temperature_2m: 9.4, apparent_temperature: 7.1, precipitation: 0.2, weather_code: 61, wind_speed_10m: 18.5 },
        daily: {
          time: ["2026-11-25", "2026-11-26"],
          weather_code: [61, 2],
          temperature_2m_max: [11.0, 10.2],
          temperature_2m_min: [6.1, 4.8],
          precipitation_probability_max: [75, 20]
        }
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
    lookupImpl: publicLookup
  });
  const result = await registry.tools.get("web.weather").handler({ location: "Manchester, UK" });
  assert.equal(requests.length, 2);
  assert.match(result.location, /Manchester/);
  assert.equal(result.current.temperatureC, 9.4);
  assert.equal(result.current.condition, "Light rain");
  assert.equal(result.today.highC, 11);
  assert.equal(result.tomorrow.condition, "Partly cloudy");
  assert.equal(result.source, "https://open-meteo.com/");
});

test("web.weather accepts direct coordinates without an extra geocoding round-trip", async () => {
  const requests = [];
  const registry = new ToolRegistry();
  registerWebResearchTools(registry, {
    requestImpl: async () => new Response("", { status: 500 }),
    fetchImpl: async (url) => {
      requests.push(String(url));
      return new Response(JSON.stringify({
        timezone: "Europe/London",
        current: { time: "2026-11-25T13:00", temperature_2m: 12.0, apparent_temperature: 11.2, precipitation: 0, weather_code: 0, wind_speed_10m: 9.0 },
        daily: { time: ["2026-11-25", "2026-11-26"], weather_code: [0, 1], temperature_2m_max: [13, 12], temperature_2m_min: [5, 4], precipitation_probability_max: [5, 10] }
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
    lookupImpl: publicLookup
  });
  const result = await registry.tools.get("web.weather").handler({ latitude: 53.4808, longitude: -2.2426 });
  assert.equal(requests.length, 1);
  assert.match(requests[0], /api\.open-meteo\.com\/v1\/forecast/);
  assert.equal(result.current.condition, "Clear sky");
  assert.match(result.summary, /12°C/);
});

test("parseWeatherLocationQuery and selectBestGeocodeResult disambiguate comma-qualified and country-qualified places", () => {
  const ukParsed = parseWeatherLocationQuery("Manchester, UK");
  assert.equal(ukParsed.primary, "Manchester");
  assert.equal(ukParsed.countryCode, "GB");

  const usParsed = parseWeatherLocationQuery("Manchester, NH");
  assert.equal(usParsed.primary, "Manchester");
  assert.equal(usParsed.countryCode, "US");
  assert.ok(usParsed.adminHints.includes("new hampshire"));

  const unpunctuated = parseWeatherLocationQuery("Leeds UK");
  assert.equal(unpunctuated.primary, "Leeds");
  assert.equal(unpunctuated.countryCode, "GB");

  const candidates = [
    { name: "Manchester", admin1: "New Hampshire", country: "United States", country_code: "US", latitude: 42.9956, longitude: -71.4548, population: 115000 },
    { name: "Manchester", admin1: "England", country: "United Kingdom", country_code: "GB", latitude: 53.4808, longitude: -2.2426, population: 550000 }
  ];
  assert.equal(selectBestGeocodeResult(candidates, ukParsed)?.country_code, "GB");
  assert.equal(selectBestGeocodeResult(candidates, usParsed)?.country_code, "US");
});

test("web.weather automatically uses the user's saved opt-in location when called without arguments", async () => {
  const requests = [];
  const registry = new ToolRegistry();
  registerWebResearchTools(registry, {
    requestImpl: async () => new Response("", { status: 500 }),
    fetchImpl: async (url) => {
      requests.push(String(url));
      return new Response(JSON.stringify({
        timezone: "Europe/London",
        current: { time: "2026-11-25T14:00", temperature_2m: 8.5, apparent_temperature: 6.2, precipitation: 0, weather_code: 3, wind_speed_10m: 14.0 },
        daily: { time: ["2026-11-25", "2026-11-26"], weather_code: [3, 61], temperature_2m_max: [10, 9], temperature_2m_min: [4, 3], precipitation_probability_max: [20, 60] }
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
    lookupImpl: publicLookup,
    profileStore: {
      get: async (userId) => ({
        userId,
        location: { enabled: true, label: "Leeds, UK", latitude: 53.8008, longitude: -1.5491, timezone: "Europe/London" }
      })
    }
  });
  const result = await registry.tools.get("web.weather").handler({}, { userId: "peter" });
  assert.equal(requests.length, 1);
  assert.match(requests[0], /latitude=53\.8008/);
  assert.equal(result.location, "Leeds, UK");
  assert.match(result.summary, /Leeds, UK: 8\.5°C/);
});

test("BoundedTtlCache expires entries by TTL and evicts least-recently-used keys", () => {
  let clock = 1_000;
  const cache = new BoundedTtlCache({ maxEntries: 2, now: () => clock });
  cache.set("a", 1, 100);
  cache.set("b", 2, 100);
  assert.equal(cache.get("a"), 1); // refreshes "a" recency; "b" is now oldest
  cache.set("c", 3, 100);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("c"), 3);
  clock = 1_100;
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("c"), undefined);
  assert.equal(cache.size, 0);
});

test("web.weather caches geocoding and forecasts and coalesces concurrent identical requests", async () => {
  const registry = new ToolRegistry();
  let geocodeCalls = 0;
  let forecastCalls = 0;
  let releaseForecast;
  const forecastGate = new Promise((resolve) => { releaseForecast = resolve; });

  registerWebResearchTools(registry, {
    requestImpl: null,
    lookupImpl: publicLookup,
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.includes("geocoding-api.open-meteo.com")) {
        geocodeCalls += 1;
        return new Response(JSON.stringify({
          results: [{ name: "Manchester", country: "United Kingdom", country_code: "GB", latitude: 53.4808, longitude: -2.2426, timezone: "Europe/London" }]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (target.includes("api.open-meteo.com/v1/forecast")) {
        forecastCalls += 1;
        await forecastGate;
        return new Response(JSON.stringify({
          timezone: "Europe/London",
          current: { temperature_2m: 12.0, apparent_temperature: 10.5, wind_speed_10m: 15, precipitation: 0, weather_code: 2 },
          daily: { time: ["2026-11-25"], temperature_2m_max: [14], temperature_2m_min: [8], precipitation_probability_max: [20], weather_code: [2] }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected URL: ${target}`);
    }
  });

  const weatherTool = registry.tools.get("web.weather");
  const p1 = weatherTool.handler({ location: "Manchester, UK" }, { userId: "u1" });
  const p2 = weatherTool.handler({ location: "Manchester, UK" }, { userId: "u1" });
  // Release upstream forecast while both requests are in flight
  setTimeout(() => releaseForecast(), 10);
  const [r1, r2] = await Promise.all([p1, p2]);

  assert.equal(geocodeCalls, 1, "Concurrent identical calls should coalesce geocoding");
  assert.equal(forecastCalls, 1, "Concurrent identical calls should coalesce forecast");
  assert.equal(r1.location, "Manchester, United Kingdom");
  assert.equal(r2.location, "Manchester, United Kingdom");

  // Repeat call hits both geocode + weather TTL caches with zero upstream fetches
  const r3 = await weatherTool.handler({ location: "Manchester, UK" }, { userId: "u1" });
  assert.equal(geocodeCalls, 1);
  assert.equal(forecastCalls, 1);
  assert.equal(r3.cached, true);
});

test("web.search classifies transit queries, caches results, and respects AbortSignal", async () => {
  assert.equal(isTransitTimeQuery("Next train from Leeds to Manchester?"), true);
  assert.equal(isTransitTimeQuery("How does photosynthesis work?"), false);

  const registry = new ToolRegistry();
  let fetchCalls = 0;
  registerWebResearchTools(registry, {
    env: { ALFIE_BRAVE_SEARCH_API_KEY: "brave-test-key" },
    lookupImpl: publicLookup,
    fetchImpl: async (_url, opts) => {
      fetchCalls += 1;
      if (opts?.signal?.aborted) {
        throw Object.assign(new Error("Aborted"), { name: "AbortError" });
      }
      return new Response(JSON.stringify({
        web: {
          results: [
            { title: "Leeds to Manchester Live Departures", url: "https://www.nationalrail.co.uk/live-trains", description: "Next train 10:14 from Platform 12 (on time)." },
            { title: "TransPennine Express Timetable", url: "https://www.tpexpress.co.uk/timetables", description: "Direct trains every 15 minutes." }
          ]
        }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  const searchTool = registry.tools.get("web.search");
  const first = await searchTool.handler({ query: "Next train from Leeds to Manchester" }, { userId: "u1" });
  assert.equal(first.queryCategory, "transit");
  assert.match(first.responseGuidance, /crisp bullets.*live departures link/i);
  assert.equal(first.cached, false);
  assert.equal(fetchCalls, 1);

  const second = await searchTool.handler({ query: "next train from leeds to manchester" }, { userId: "u1" });
  assert.equal(second.cached, true);
  assert.equal(fetchCalls, 1, "Second identical transit query within TTL must hit search cache");

  // Pre-aborted signal cancels immediately without calling upstream fetch
  const controller = new AbortController();
  controller.abort(new Error("User pressed Stop"));
  await assert.rejects(
    () => searchTool.handler({ query: "Next train from York to London" }, { userId: "u1", signal: controller.signal }),
    (err) => err?.name === "AbortError" || /cancel|abort/i.test(String(err?.message || ""))
  );
  assert.equal(fetchCalls, 1, "Aborted request should not invoke upstream fetch");
});

test("Cancelling one coalesced weather caller does not abort a second concurrent caller", async () => {
  const registry = new ToolRegistry();
  let resolveFetch;
  const fetchGate = new Promise((resolve) => { resolveFetch = resolve; });

  registerWebResearchTools(registry, {
    requestImpl: null,
    lookupImpl: publicLookup,
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.includes("geocoding-api.open-meteo.com")) {
        return new Response(JSON.stringify({
          results: [{ name: "York", country: "United Kingdom", country_code: "GB", latitude: 53.9591, longitude: -1.0815, timezone: "Europe/London" }]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      await fetchGate;
      return new Response(JSON.stringify({
        timezone: "Europe/London",
        current: { temperature_2m: 9.5, apparent_temperature: 8.0, wind_speed_10m: 10, precipitation: 0, weather_code: 1 },
        daily: { time: ["2026-11-25"], temperature_2m_max: [11], temperature_2m_min: [5], precipitation_probability_max: [10], weather_code: [1] }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  const weatherTool = registry.tools.get("web.weather");
  const c1 = new AbortController();
  const c2 = new AbortController();
  const caller1 = weatherTool.handler({ location: "York, UK" }, { userId: "u1", signal: c1.signal });
  const caller2 = weatherTool.handler({ location: "York, UK" }, { userId: "u2", signal: c2.signal });

  c1.abort(new Error("Caller 1 stopped"));
  await assert.rejects(() => caller1, (err) => err?.name === "AbortError" || /cancel/i.test(String(err?.message || "")));

  resolveFetch();
  const result2 = await caller2;
  assert.equal(result2.location, "York, United Kingdom");
  assert.equal(result2.current.temperatureC, 9.5);
});


test("web.weather geocodes a label-only saved location instead of treating null coordinates as zero", async () => {
  const requests = [];
  const registry = new ToolRegistry();
  registerWebResearchTools(registry, {
    requestImpl: async () => new Response("", { status: 500 }),
    fetchImpl: async (url) => {
      requests.push(String(url));
      if (String(url).includes("geocoding-api")) {
        return new Response(JSON.stringify({ results: [{ name: "Liverpool", admin1: "England", country: "United Kingdom", country_code: "GB", latitude: 53.4084, longitude: -2.9916, timezone: "Europe/London" }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        timezone: "Europe/London",
        current: { time: "2026-11-25T14:00", temperature_2m: 8, apparent_temperature: 6, precipitation: 0, weather_code: 3, wind_speed_10m: 10 },
        daily: { time: ["2026-11-25", "2026-11-26"], weather_code: [3, 2], temperature_2m_max: [10, 11], temperature_2m_min: [4, 5], precipitation_probability_max: [20, 30] }
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
    lookupImpl: publicLookup,
    profileStore: { get: async () => ({ location: { enabled: true, label: "Liverpool, UK", latitude: null, longitude: null, timezone: "Europe/London" } }) }
  });
  const result = await registry.tools.get("web.weather").handler({}, { userId: "peter" });
  assert.equal(result.location, "Liverpool, England, United Kingdom");
  assert.ok(requests.some((url) => url.includes("geocoding-api")));
  assert.ok(requests.some((url) => url.includes("latitude=53.4084")));
  assert.ok(!requests.some((url) => url.includes("latitude=0&longitude=0")));
});


test("web.weather surfaces saved-profile read failures instead of silently pretending no location exists", async () => {
  const registry = new ToolRegistry();
  registerWebResearchTools(registry, {
    fetchImpl: async () => { throw new Error("Forecast request should not run."); },
    lookupImpl: publicLookup,
    profileStore: { get: async () => { throw new Error("Workflow profile store unavailable."); } }
  });
  await assert.rejects(
    () => registry.tools.get("web.weather").handler({}, { userId: "peter" }),
    /Workflow profile store unavailable/
  );
});
