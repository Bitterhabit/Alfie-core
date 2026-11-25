import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { isPrivateOrReservedIpv4, isPrivateOrReservedIpv6 } from "../watchers/engine.mjs";

const SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const OPEN_METEO_GEOCODE_ENDPOINT = "https://geocoding-api.open-meteo.com/v1/search";
const OPEN_METEO_FORECAST_ENDPOINT = "https://api.open-meteo.com/v1/forecast";
const REQUEST_TIMEOUT_MS = 6_000;
const OPEN_METEO_TIMEOUT_MS = 5_000;
const SEARXNG_FALLBACK_TIMEOUT_MS = 3_500;
const PAGE_READ_TIMEOUT_MS = 5_000;
const MAX_PAGE_BYTES = 1_000_000;
const MAX_TEXT_CHARS = 1_300;
const GEOCODE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const WEATHER_CACHE_TTL_MS = 5 * 60 * 1000;
const SEARCH_CACHE_TTL_MS = 60 * 1000;
const TRANSIT_SEARCH_CACHE_TTL_MS = 30 * 1000;
const VALIDATED_ADDRESSES = Symbol("validatedPublicAddresses");

export class BoundedTtlCache {
  constructor({ maxEntries = 128, now = () => Date.now() } = {}) {
    this.maxEntries = Math.max(1, Number(maxEntries) || 128);
    this.now = now;
    this.entries = new Map();
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh LRU recency
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs) {
    const ttl = Math.max(0, Number(ttlMs) || 0);
    if (ttl <= 0) return value;
    if (this.entries.has(key)) this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
    this.entries.set(key, { value, expiresAt: this.now() + ttl });
    return value;
  }

  clear() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }
}

export function isTransitTimeQuery(text) {
  return /\b(train|trains|timetable|timetables|departures?|arrivals?|station|rail|railway|national rail|trainline|bus|buses|tram|tube|underground|metro|commute|transit|next\s+\w*\s*(?:train|bus|tram|tube))\b/i.test(String(text || ""));
}

function combineTimeoutSignal(parentSignal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!parentSignal) return timeoutSignal;
  if (parentSignal.aborted) return parentSignal;
  return AbortSignal.any([parentSignal, timeoutSignal]);
}

function raceWithAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(Object.assign(new Error("Request was cancelled."), { name: "AbortError", status: 499 }));
  }
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(Object.assign(new Error("Request was cancelled."), { name: "AbortError", status: 499 }));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => {
    signal.removeEventListener("abort", onAbort);
  });
}

const WMO_WEATHER_LABELS = Object.freeze({
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  56: "Light freezing drizzle",
  57: "Dense freezing drizzle",
  61: "Light rain",
  63: "Moderate rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Heavy freezing rain",
  71: "Light snow",
  73: "Moderate snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Light rain showers",
  81: "Moderate rain showers",
  82: "Heavy rain showers",
  85: "Light snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail"
});

export function describeWeatherCode(code) {
  const numeric = Number(code);
  return WMO_WEATHER_LABELS[numeric] || "Mixed conditions";
}
const BLOCKED_METADATA_HOSTS = new Set([
  "169.254.169.254",
  "100.100.100.200",
  "metadata.google.internal",
  "metadata.goog"
]);

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !isPrivateOrReservedIpv4(address);
  if (family === 6) return !isPrivateOrReservedIpv6(address);
  return false;
}

export async function validatePublicWebUrl(value, { lookupImpl = lookup } = {}) {
  let url;
  try { url = new URL(String(value || "")); } catch { fail("A valid absolute URL is required."); }
  if (url.protocol !== "https:" || url.username || url.password) fail("Only credential-free HTTPS URLs can be opened.");
  if (url.port && url.port !== "443") fail("Only standard HTTPS port 443 is allowed.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (!host || host === "localhost" || BLOCKED_METADATA_HOSTS.has(host) ||
      host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".localdomain") ||
      host.endsWith(".internal") || host.endsWith(".test") || host.endsWith(".home.arpa") ||
      host.endsWith(".lan") || host.endsWith(".docker") || host.endsWith(".svc")) {
    fail("Local and internal hosts cannot be accessed.");
  }
  const literalFamily = isIP(host);
  const addresses = literalFamily ? [{ address: host, family: literalFamily }] : await lookupImpl(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address))) {
    fail("The destination must resolve exclusively to public IP addresses.");
  }
  url.hash = "";
  Object.defineProperty(url, VALIDATED_ADDRESSES, { value: addresses });
  return url;
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n) || 32))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16) || 32));
}

export function extractReadableText(html, maxChars = MAX_TEXT_CHARS) {
  const source = String(html || "").slice(0, MAX_PAGE_BYTES);
  const title = decodeEntities((source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 240);
  const description = decodeEntities(source.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1] || "").slice(0, 500);
  const text = decodeEntities(source
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|nav|footer|header|form)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/article|\/section)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t\f\v]+/g, " ").replace(/\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n").trim().slice(0, maxChars);
  return { title, description, text };
}

function orderPinnedAddresses(addresses = []) {
  const valid = (Array.isArray(addresses) ? addresses : [])
    .filter((entry) => entry && isPublicAddress(entry.address))
    .map((entry) => ({
      address: entry.address,
      family: entry.family || isIP(entry.address)
    }));
  const ipv4 = valid.filter((entry) => entry.family === 4);
  const ipv6 = valid.filter((entry) => entry.family !== 4);
  return [...ipv4, ...ipv6];
}

function requestPinnedSingleAddress(url, { selected, headers, signal }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const failOnce = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const req = httpsRequest(url, {
      method: "GET",
      headers,
      signal,
      agent: false,
      servername: isIP(url.hostname) ? undefined : url.hostname,
      lookup(_hostname, options, callback) {
        const resolved = { address: selected.address, family: selected.family || isIP(selected.address) };
        if (options?.all) callback(null, [resolved]);
        else callback(null, resolved.address, resolved.family);
      }
    }, (res) => {
      const chunks = [];
      let total = 0;
      const declaredLength = Number(res.headers["content-length"] || 0);
      if (declaredLength > MAX_PAGE_BYTES) {
        res.destroy();
        failOnce(Object.assign(new Error("The page is larger than the allowed 1 MB limit."), { status: 413 }));
        return;
      }
      res.on("data", (chunk) => {
        total += chunk.length;
        if (total > MAX_PAGE_BYTES) {
          res.destroy();
          failOnce(Object.assign(new Error("The page exceeded the allowed 1 MB limit."), { status: 413 }));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (settled) return;
        settled = true;
        const response = new Response(Buffer.concat(chunks), {
          status: res.statusCode || 502,
          headers: res.headers
        });
        resolve(response);
      });
      res.on("error", failOnce);
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error("The page request timed out.")));
    req.on("error", failOnce);
    req.end();
  });
}

async function requestPinnedHttps(url, { addresses, headers, signal }) {
  const ordered = orderPinnedAddresses(addresses);
  if (!ordered.length) {
    throw new Error("A previously validated public destination is required.");
  }
  let lastError = null;
  for (let i = 0; i < ordered.length; i += 1) {
    try {
      return await requestPinnedSingleAddress(url, { selected: ordered[i], headers, signal });
    } catch (error) {
      lastError = error;
      if (signal?.aborted || error?.status === 413 || i === ordered.length - 1) {
        throw error;
      }
    }
  }
  throw lastError || new Error("The pinned HTTPS request failed.");
}

async function readResponseText(response, maxBytes = MAX_PAGE_BYTES) {
  const length = Number(response.headers.get("content-length") || 0);
  if (length > maxBytes) fail("The page is larger than the allowed 1 MB limit.", 413);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      fail("The page exceeded the allowed 1 MB limit.", 413);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

const COUNTRY_ALIASES = new Map([
  ["uk", { code: "GB", names: ["united kingdom", "great britain", "uk"] }],
  ["gb", { code: "GB", names: ["united kingdom", "great britain"] }],
  ["united kingdom", { code: "GB", names: ["united kingdom"] }],
  ["great britain", { code: "GB", names: ["united kingdom"] }],
  ["britain", { code: "GB", names: ["united kingdom"] }],
  ["england", { code: "GB", names: ["united kingdom", "england"], admin: "england" }],
  ["scotland", { code: "GB", names: ["united kingdom", "scotland"], admin: "scotland" }],
  ["wales", { code: "GB", names: ["united kingdom", "wales"], admin: "wales" }],
  ["northern ireland", { code: "GB", names: ["united kingdom", "northern ireland"], admin: "northern ireland" }],
  ["us", { code: "US", names: ["united states"] }],
  ["usa", { code: "US", names: ["united states"] }],
  ["united states", { code: "US", names: ["united states"] }],
  ["america", { code: "US", names: ["united states"] }],
  ["canada", { code: "CA", names: ["canada"] }],
  ["ca", { code: "CA", names: ["canada"] }],
  ["australia", { code: "AU", names: ["australia"] }],
  ["au", { code: "AU", names: ["australia"] }],
  ["ireland", { code: "IE", names: ["ireland"] }],
  ["france", { code: "FR", names: ["france"] }],
  ["germany", { code: "DE", names: ["germany"] }],
  ["spain", { code: "ES", names: ["spain"] }],
  ["italy", { code: "IT", names: ["italy"] }],
  ["netherlands", { code: "NL", names: ["netherlands"] }],
  ["japan", { code: "JP", names: ["japan"] }],
  ["india", { code: "IN", names: ["india"] }],
  ["new zealand", { code: "NZ", names: ["new zealand"] }],
  ["nz", { code: "NZ", names: ["new zealand"] }],
  ["uae", { code: "AE", names: ["united arab emirates"] }]
]);

const US_STATE_ABBR = new Map([
  ["al", "alabama"], ["ak", "alaska"], ["az", "arizona"], ["ar", "arkansas"],
  ["ca", "california"], ["co", "colorado"], ["ct", "connecticut"], ["de", "delaware"],
  ["fl", "florida"], ["ga", "georgia"], ["hi", "hawaii"], ["id", "idaho"],
  ["il", "illinois"], ["in", "indiana"], ["ia", "iowa"], ["ks", "kansas"],
  ["ky", "kentucky"], ["la", "louisiana"], ["me", "maine"], ["md", "maryland"],
  ["ma", "massachusetts"], ["mi", "michigan"], ["mn", "minnesota"], ["ms", "mississippi"],
  ["mo", "missouri"], ["mt", "montana"], ["ne", "nebraska"], ["nv", "nevada"],
  ["nh", "new hampshire"], ["nj", "new jersey"], ["nm", "new mexico"], ["ny", "new york"],
  ["nc", "north carolina"], ["nd", "north dakota"], ["oh", "ohio"], ["ok", "oklahoma"],
  ["or", "oregon"], ["pa", "pennsylvania"], ["ri", "rhode island"], ["sc", "south carolina"],
  ["sd", "south dakota"], ["tn", "tennessee"], ["tx", "texas"], ["ut", "utah"],
  ["vt", "vermont"], ["va", "virginia"], ["wa", "washington"], ["wv", "west virginia"],
  ["wi", "wisconsin"], ["wy", "wyoming"], ["dc", "district of columbia"]
]);

export function parseWeatherLocationQuery(rawLocation) {
  const cleaned = String(rawLocation || "").trim().replace(/\s+/g, " ").slice(0, 120);
  if (!cleaned) return { primary: "", qualifiers: [], countryCode: null, adminHints: [], fallbacks: [] };

  const parts = cleaned.split(",").map((part) => part.trim()).filter(Boolean);
  let primary = parts[0] || cleaned;
  let qualifiers = parts.slice(1).map((q) => q.toLowerCase());

  // Handle unpunctuated trailing country qualifiers like "Manchester UK" or "Austin USA"
  if (!qualifiers.length) {
    const trailingMatch = /^(.+?)\s+(uk|gb|usa|us|england|scotland|wales|ireland|france|germany|spain|italy|canada|australia|japan|india|uae)$/i.exec(primary);
    if (trailingMatch && trailingMatch[1].trim().length >= 2) {
      primary = trailingMatch[1].trim();
      qualifiers = [trailingMatch[2].toLowerCase()];
    }
  }

  let countryCode = null;
  const adminHints = [];
  for (const qualifier of qualifiers) {
    const alias = COUNTRY_ALIASES.get(qualifier);
    if (alias && !(qualifier === "ca" && parts.length === 2 && !qualifiers.includes("canada"))) {
      countryCode = alias.code;
      if (alias.admin) adminHints.push(alias.admin);
      continue;
    }
    const usState = US_STATE_ABBR.get(qualifier);
    if (usState) {
      adminHints.push(usState);
      if (!countryCode) countryCode = "US";
      continue;
    }
    if (/^[a-z]{2}$/.test(qualifier) && !countryCode) {
      countryCode = qualifier.toUpperCase();
    }
    adminHints.push(qualifier);
  }

  const fallbacks = [];
  const strippedDirection = primary.replace(/^(?:central|greater|downtown|north|south|east|west|inner|outer)\s+/i, "").trim();
  if (strippedDirection && strippedDirection.toLowerCase() !== primary.toLowerCase() && strippedDirection.length >= 2) {
    fallbacks.push(strippedDirection);
  }

  return { primary, qualifiers, countryCode, adminHints, fallbacks };
}

export function selectBestGeocodeResult(results, { primary = "", qualifiers = [], countryCode = null, adminHints = [] } = {}) {
  const list = Array.isArray(results) ? results.filter((item) => item && Number.isFinite(Number(item.latitude)) && Number.isFinite(Number(item.longitude))) : [];
  if (!list.length) return null;
  if (list.length === 1) return list[0];

  const normPrimary = String(primary || "").trim().toLowerCase();
  const normCountryCode = countryCode ? String(countryCode).toUpperCase() : null;
  const normHints = [...new Set([...qualifiers, ...adminHints].map((h) => String(h || "").trim().toLowerCase()).filter(Boolean))];

  const scored = list.map((item, idx) => {
    let score = 0;
    const name = String(item.name || "").trim().toLowerCase();
    const country = String(item.country || "").trim().toLowerCase();
    const code = String(item.country_code || "").trim().toUpperCase();
    const admin1 = String(item.admin1 || "").trim().toLowerCase();
    const admin2 = String(item.admin2 || "").trim().toLowerCase();

    if (normPrimary && name === normPrimary) score += 25;
    if (normCountryCode && code === normCountryCode) score += 40;
    for (const hint of normHints) {
      const alias = COUNTRY_ALIASES.get(hint);
      if (alias) {
        if (code === alias.code) score += 30;
        if (alias.names.some((n) => country === n || country.includes(n))) score += 20;
        if (alias.admin && (admin1 === alias.admin || admin1.includes(alias.admin))) score += 25;
      } else {
        if (country === hint || country.includes(hint)) score += 20;
        if (admin1 === hint || admin1.includes(hint)) score += 25;
        if (admin2 === hint || admin2.includes(hint)) score += 15;
      }
    }
    const pop = Number(item.population || 0);
    if (Number.isFinite(pop) && pop > 0) {
      score += Math.min(12, Math.log10(pop));
    }
    return { item, score, idx };
  });

  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return scored[0].item;
}

export function registerWebResearchTools(registry, { fetchImpl = globalThis.fetch, lookupImpl = lookup, requestImpl = requestPinnedHttps, env = process.env, profileStore = null, now = () => Date.now() } = {}) {
  const geocodeCache = new BoundedTtlCache({ maxEntries: 256, now });
  const weatherCache = new BoundedTtlCache({ maxEntries: 128, now });
  const searchCache = new BoundedTtlCache({ maxEntries: 64, now });
  const inflight = new Map();

  function runCoalesced(key, fn, signal) {
    if (signal?.aborted) {
      return Promise.reject(Object.assign(new Error("Request was cancelled."), { name: "AbortError", status: 499 }));
    }
    let entry = inflight.get(key);
    if (!entry) {
      const controller = new AbortController();
      entry = { controller, waiters: 0, promise: null };
      entry.promise = Promise.resolve()
        .then(() => fn(controller.signal))
        .finally(() => {
          if (inflight.get(key) === entry) inflight.delete(key);
        });
      // Prevent unhandled rejection if all callers cancel before the underlying flight settles
      entry.promise.catch(() => {});
      inflight.set(key, entry);
    }
    entry.waiters += 1;
    let released = false;
    const releaseWaiter = (fromAbort) => {
      if (released) return;
      released = true;
      entry.waiters = Math.max(0, entry.waiters - 1);
      if (fromAbort && entry.waiters === 0 && !entry.controller.signal.aborted) {
        entry.controller.abort(new Error("All callers cancelled request."));
      }
    };
    const onAbort = () => releaseWaiter(true);
    signal?.addEventListener("abort", onAbort, { once: true });
    return raceWithAbort(entry.promise, signal).finally(() => {
      signal?.removeEventListener("abort", onAbort);
      releaseWaiter(false);
    });
  }

  async function searchWeb(query, count = 4, { signal } = {}) {
    if (signal?.aborted) {
      throw Object.assign(new Error("Web search was cancelled."), { name: "AbortError", status: 499 });
    }
    const searxngBase = String(env.ALFIE_SEARXNG_URL || "").trim();
    const braveKey = String(env.ALFIE_BRAVE_SEARCH_API_KEY || "").trim();
    const transitQuery = isTransitTimeQuery(query);
    const cacheKey = `search:${searxngBase ? "sx" : ""}:${braveKey ? "br" : ""}:${count}:${String(query || "").trim().toLowerCase()}`;
    const cached = searchCache.get(cacheKey);
    if (cached) {
      return { ...cached, cached: true };
    }

    return runCoalesced(cacheKey, async (flightSignal) => {
      let searxngError = null;

      if (searxngBase) {
        try {
          const base = new URL(searxngBase);
          const host = base.hostname.toLowerCase().replace(/^\[|\]$/g, "");
          if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) {
            throw new Error("ALFIE_SEARXNG_URL must be an HTTP(S) URL without credentials.");
          }
          if (BLOCKED_METADATA_HOSTS.has(host)) {
            throw new Error("ALFIE_SEARXNG_URL cannot target cloud metadata endpoints.");
          }
          const url = new URL("/search", base);
          url.searchParams.set("q", query);
          url.searchParams.set("format", "json");
          url.searchParams.set("safesearch", "1");
          url.searchParams.set("language", "en-GB");
          const searxngTimeout = braveKey ? SEARXNG_FALLBACK_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
          const response = await fetchImpl(url, {
            headers: { "Accept": "application/json", "User-Agent": "Alfie-Core/1.0" },
            redirect: "error",
            signal: combineTimeoutSignal(flightSignal, searxngTimeout)
          });
          if (!response.ok) throw new Error(`SearXNG returned HTTP ${response.status}.`);
          const payload = await response.json();
          const results = (Array.isArray(payload.results) ? payload.results : []).slice(0, count).map((item) => ({
            title: String(item.title || "").slice(0, 180),
            url: String(item.url || "").slice(0, 500),
            description: String(item.content || item.description || "").slice(0, 260),
            age: String(item.publishedDate || "").slice(0, 40),
            source: Array.isArray(item.engines) ? item.engines.slice(0, 4).join(", ").slice(0, 80) : String(item.engine || "").slice(0, 80)
          })).filter((item) => item.title && item.url);
          const outcome = { provider: "SearXNG", results, ...(transitQuery ? { queryCategory: "transit" } : {}) };
          if (results.length > 0) {
            searchCache.set(cacheKey, outcome, transitQuery ? TRANSIT_SEARCH_CACHE_TTL_MS : SEARCH_CACHE_TTL_MS);
          }
          return outcome;
        } catch (error) {
          if (flightSignal?.aborted) throw error;
          searxngError = String(error?.message || "SearXNG request failed.").slice(0, 180);
        }
      }

      if (braveKey) {
        const url = new URL(SEARCH_ENDPOINT);
        url.searchParams.set("q", query);
        url.searchParams.set("count", String(count));
        url.searchParams.set("safesearch", "moderate");
        const response = await fetchImpl(url, {
          headers: { "Accept": "application/json", "X-Subscription-Token": braveKey, "User-Agent": "Alfie-Core/1.0" },
          redirect: "error",
          signal: combineTimeoutSignal(flightSignal, REQUEST_TIMEOUT_MS)
        });
        if (!response.ok) throw Object.assign(new Error(`Brave Search provider returned HTTP ${response.status}.`), { status: 502 });
        const payload = await response.json();
        const results = (payload.web?.results || []).slice(0, count).map((item) => ({
          title: String(item.title || "").slice(0, 180),
          url: String(item.url || "").slice(0, 500),
          description: String(item.description || "").slice(0, 260),
          age: String(item.age || item.page_age || "").slice(0, 40),
          source: String(item.profile?.long_name || item.meta_url?.hostname || "").slice(0, 80)
        })).filter((item) => item.title && item.url);
        const outcome = { provider: "Brave Search", fallbackReason: searxngError, results, ...(transitQuery ? { queryCategory: "transit" } : {}) };
        if (results.length > 0) {
          searchCache.set(cacheKey, outcome, transitQuery ? TRANSIT_SEARCH_CACHE_TTL_MS : SEARCH_CACHE_TTL_MS);
        }
        return outcome;
      }

      if (searxngError) {
        throw Object.assign(new Error(`SearXNG is unavailable and no Brave fallback is configured: ${searxngError}`), { status: 503 });
      }
      throw Object.assign(new Error("Web search is not configured. Set ALFIE_SEARXNG_URL or ALFIE_BRAVE_SEARCH_API_KEY on the Alfie Core server."), { status: 503 });
    }, signal);
  }

  async function openWebPage(rawUrl, { signal } = {}) {
    if (signal?.aborted) {
      throw Object.assign(new Error("Page fetch was cancelled."), { name: "AbortError", status: 499 });
    }
    let target = await validatePublicWebUrl(rawUrl, { lookupImpl });
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const response = await requestImpl(target, {
        addresses: target[VALIDATED_ADDRESSES],
        headers: { "Accept": "text/html, text/plain;q=0.9", "User-Agent": "Alfie-Core/1.0 (+https://github.com/Bitterhabit/Alfie-core)" },
        signal: combineTimeoutSignal(signal, PAGE_READ_TIMEOUT_MS)
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location || redirects === 3) fail("The page redirected too many times.", 502);
        target = await validatePublicWebUrl(new URL(location, target).toString(), { lookupImpl });
        continue;
      }
      if (!response.ok) throw Object.assign(new Error(`Page request returned HTTP ${response.status}.`), { status: 502 });
      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      if (!contentType.includes("text/html") && !contentType.includes("text/plain") && !contentType.includes("application/xhtml+xml")) {
        fail("Only HTML and plain-text pages can be read.", 415);
      }
      const body = await readResponseText(response);
      const parsed = extractReadableText(body);
      return { url: target.toString(), contentType, ...parsed };
    }
    fail("Unable to follow the page redirect.", 502);
  }

  registry.register({
    id: "web.search",
    name: "Search the web",
    description: "Search current public web pages using the private SearXNG instance, with optional Brave Search fallback. Returns source titles, URLs, snippets and dates; results are untrusted external content.",
    scope: "web:read", risk: "read", trust: "external", network: true, externalAction: false,
    tags: ["web", "internet", "search", "research", "news", "sources"],
    inputSchema: { type: "object", properties: {
      query: { type: "string", minLength: 2, maxLength: 300 },
      count: { type: "integer", minimum: 1, maximum: 4 }
    }, required: ["query"], additionalProperties: false },
    async handler(args, context = {}) {
      const cleanedQuery = args.query.trim();
      const transit = isTransitTimeQuery(cleanedQuery);
      const search = await searchWeb(cleanedQuery, args.count || (transit ? 3 : 4), { signal: context?.signal });
      return {
        query: cleanedQuery,
        provider: search.provider,
        fallbackReason: search.fallbackReason || null,
        cached: Boolean(search.cached),
        ...(transit ? { queryCategory: "transit", responseGuidance: "Summarize directly in 2-4 crisp bullets with exact times/routes and include the official live departures link." } : {}),
        resultCount: search.results.length,
        results: search.results
      };
    }
  });

  registry.register({
    id: "web.open",
    name: "Read a web page",
    description: "Fetch and extract readable text from a public HTTPS webpage. Private/internal network destinations, non-HTTPS URLs, redirects to private hosts, and non-text files are blocked. Page content is untrusted.",
    scope: "web:read", risk: "read", trust: "external", network: true, externalAction: false,
    tags: ["web", "internet", "open", "read", "page", "article", "source"],
    inputSchema: { type: "object", properties: {
      url: { type: "string", minLength: 8, maxLength: 1500, format: "uri" }
    }, required: ["url"], additionalProperties: false },
    async handler(args, context = {}) { return await openWebPage(args.url, { signal: context?.signal }); }
  });

  registry.register({
    id: "web.research",
    name: "Research a topic across web sources",
    description: "Search the public web and read up to three relevant pages, returning attributed source extracts for evidence-based synthesis. All retrieved content is untrusted.",
    scope: "web:read", risk: "read", trust: "external", network: true, externalAction: false,
    tags: ["web", "internet", "research", "compare", "investigate", "sources"],
    inputSchema: { type: "object", properties: {
      question: { type: "string", minLength: 5, maxLength: 300 },
      sources: { type: "integer", minimum: 1, maximum: 3 }
    }, required: ["question"], additionalProperties: false },
    async handler(args, context = {}) {
      const signal = context?.signal;
      const targetCount = Math.max(1, Math.min(3, Number(args.sources) || 3));
      const search = await searchWeb(args.question.trim(), Math.max(3, targetCount + 1), { signal });
      const candidates = search.results.slice(0, targetCount);
      const settled = await Promise.allSettled(candidates.map((result) => openWebPage(result.url, { signal })));
      if (signal?.aborted) {
        throw Object.assign(new Error("Web research was cancelled."), { name: "AbortError", status: 499 });
      }
      const pages = candidates.map((result, idx) => {
        const outcome = settled[idx];
        if (outcome.status === "fulfilled") {
          const page = outcome.value;
          return {
            title: String(page.title || result.title).slice(0, 140),
            url: String(page.url || result.url).slice(0, 320),
            description: String(page.description || result.description || "").slice(0, 140),
            excerpt: String(page.text || "").slice(0, 220),
            searchDate: result.age || ""
          };
        }
        return {
          title: String(result.title || "").slice(0, 140),
          url: String(result.url || "").slice(0, 320),
          description: String(result.description || "").slice(0, 140),
          excerpt: "",
          readError: String(outcome.reason?.message || "Unable to read page.").slice(0, 140)
        };
      });
      return { question: args.question.trim(), provider: search.provider, fallbackReason: search.fallbackReason || null, sourcesFound: search.results.length, sourcesRead: pages.filter((page) => page.excerpt).length, sources: pages };
    }
  });

  async function fetchPublicJson(rawUrl, { signal } = {}) {
    if (signal?.aborted) {
      throw Object.assign(new Error("Weather request was cancelled."), { name: "AbortError", status: 499 });
    }
    const target = await validatePublicWebUrl(rawUrl, { lookupImpl });
    const reqSignal = combineTimeoutSignal(signal, OPEN_METEO_TIMEOUT_MS);
    const response = requestImpl === requestPinnedHttps
      ? await requestImpl(target, {
          addresses: target[VALIDATED_ADDRESSES],
          headers: { "Accept": "application/json", "User-Agent": "Alfie-Core/1.0" },
          signal: reqSignal
        })
      : await fetchImpl(target, {
          headers: { "Accept": "application/json", "User-Agent": "Alfie-Core/1.0" },
          redirect: "error",
          signal: reqSignal
        });
    if (!response.ok) {
      throw Object.assign(new Error(`Weather service returned HTTP ${response.status}.`), { status: 502 });
    }
    return await response.json();
  }

  async function geocodeWeatherPlace(rawLocation, { signal } = {}) {
    const cacheKey = `geo:${String(rawLocation || "").trim().toLowerCase().replace(/\s+/g, " ")}`;
    const cached = geocodeCache.get(cacheKey);
    if (cached) return cached;

    return runCoalesced(cacheKey, async (flightSignal) => {
      const parsed = parseWeatherLocationQuery(rawLocation);
      const searchCandidates = [parsed.primary, ...parsed.fallbacks].filter(Boolean);
      for (const candidateName of searchCandidates) {
        const geocodeUrl = new URL(OPEN_METEO_GEOCODE_ENDPOINT);
        geocodeUrl.searchParams.set("name", candidateName);
        geocodeUrl.searchParams.set("count", "8");
        geocodeUrl.searchParams.set("language", "en");
        geocodeUrl.searchParams.set("format", "json");
        if (parsed.countryCode) {
          geocodeUrl.searchParams.set("countryCode", parsed.countryCode);
        }
        const geoData = await fetchPublicJson(geocodeUrl.toString(), { signal: flightSignal });
        let best = selectBestGeocodeResult(geoData?.results, parsed);
        // If countryCode filter was overly strict (e.g. ambiguous 2-letter region), retry without countryCode
        if (!best && parsed.countryCode) {
          geocodeUrl.searchParams.delete("countryCode");
          const broader = await fetchPublicJson(geocodeUrl.toString(), { signal: flightSignal });
          best = selectBestGeocodeResult(broader?.results, parsed);
        }
        if (best) {
          geocodeCache.set(cacheKey, best, GEOCODE_CACHE_TTL_MS);
          return best;
        }
      }
      return null;
    }, signal);
  }

  async function fetchWeather({ location = "", latitude = null, longitude = null } = {}, context = {}) {
    const signal = context?.signal;
    if (signal?.aborted) {
      throw Object.assign(new Error("Weather lookup was cancelled."), { name: "AbortError", status: 499 });
    }
    let lat = latitude !== null && latitude !== undefined ? Number(latitude) : null;
    let lon = longitude !== null && longitude !== undefined ? Number(longitude) : null;
    let resolvedName = String(location || "").trim().slice(0, 120);
    let resolvedTimezone = "auto";

    // Automatically fall back to the user's opt-in saved location when args are omitted.
    if ((!Number.isFinite(lat) || !Number.isFinite(lon)) && !resolvedName && profileStore?.get && context?.userId) {
      const profile = await profileStore.get(context.userId);
      const savedLoc = profile?.location;
      if (savedLoc?.enabled) {
        if (savedLoc.latitude !== null && savedLoc.latitude !== undefined && savedLoc.latitude !== "" && savedLoc.longitude !== null && savedLoc.longitude !== undefined && savedLoc.longitude !== "" && Number.isFinite(Number(savedLoc.latitude)) && Number.isFinite(Number(savedLoc.longitude))) {
          lat = Number(savedLoc.latitude);
          lon = Number(savedLoc.longitude);
          if (savedLoc.label) resolvedName = String(savedLoc.label).trim().slice(0, 120);
          if (savedLoc.timezone) resolvedTimezone = String(savedLoc.timezone).trim().slice(0, 80);
        } else if (savedLoc.label) {
          resolvedName = String(savedLoc.label).trim().slice(0, 120);
        }
      }
    }

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      if (!resolvedName) {
        fail("Provide a location name (for example 'Manchester, UK') or latitude and longitude, or enable your saved location in Settings.", 400);
      }
      const first = await geocodeWeatherPlace(resolvedName, { signal });
      if (!first || !Number.isFinite(Number(first.latitude)) || !Number.isFinite(Number(first.longitude))) {
        fail(`Could not find weather coordinates for "${resolvedName}". Try a nearby town or city name.`, 404);
      }
      lat = Number(first.latitude);
      lon = Number(first.longitude);
      resolvedName = [first.name, first.admin1, first.country].filter(Boolean).join(", ");
      if (first.timezone) resolvedTimezone = String(first.timezone);
    }

    const roundedLat = Math.round(lat * 10000) / 10000;
    const roundedLon = Math.round(lon * 10000) / 10000;
    const forecastCacheKey = `wx:${Math.round(lat * 100) / 100}:${Math.round(lon * 100) / 100}:${resolvedTimezone}`;
    const cachedForecast = weatherCache.get(forecastCacheKey);
    if (cachedForecast) {
      return {
        ...cachedForecast,
        ...(resolvedName ? { location: resolvedName } : {}),
        cached: true
      };
    }

    return runCoalesced(forecastCacheKey, async (flightSignal) => {
      const forecastUrl = new URL(OPEN_METEO_FORECAST_ENDPOINT);
      forecastUrl.searchParams.set("latitude", String(roundedLat));
      forecastUrl.searchParams.set("longitude", String(roundedLon));
      forecastUrl.searchParams.set("current", "temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m");
      forecastUrl.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max");
      forecastUrl.searchParams.set("forecast_days", "2");
      forecastUrl.searchParams.set("timezone", resolvedTimezone);
      const data = await fetchPublicJson(forecastUrl.toString(), { signal: flightSignal });
      const current = data?.current || {};
      const daily = data?.daily || {};
      const buildDay = (index) => ({
        date: Array.isArray(daily.time) ? String(daily.time[index] || "") : "",
        condition: describeWeatherCode(Array.isArray(daily.weather_code) ? daily.weather_code[index] : undefined),
        highC: Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max[index] : null,
        lowC: Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min[index] : null,
        rainChancePct: Array.isArray(daily.precipitation_probability_max) ? daily.precipitation_probability_max[index] : null
      });
      const finalLocation = resolvedName || `${Math.round(lat * 100) / 100}, ${Math.round(lon * 100) / 100}`;
      const currentCondition = describeWeatherCode(current.weather_code);
      const today = buildDay(0);
      const tomorrow = buildDay(1);
      const summaryParts = [
        `${finalLocation}: ${current.temperature_2m ?? "?"}°C${current.apparent_temperature !== undefined && current.apparent_temperature !== null ? ` (feels like ${current.apparent_temperature}°C)` : ""}, ${currentCondition}${current.wind_speed_10m !== undefined && current.wind_speed_10m !== null ? `, wind ${current.wind_speed_10m} km/h` : ""}.`,
        today.highC !== null ? `Today: ${today.lowC ?? "?"}–${today.highC}°C, ${today.condition}${today.rainChancePct !== null ? ` (${today.rainChancePct}% rain)` : ""}.` : "",
        tomorrow.highC !== null ? `Tomorrow: ${tomorrow.lowC ?? "?"}–${tomorrow.highC}°C, ${tomorrow.condition}${tomorrow.rainChancePct !== null ? ` (${tomorrow.rainChancePct}% rain)` : ""}.` : ""
      ].filter(Boolean);
      const result = {
        location: finalLocation,
        latitude: roundedLat,
        longitude: roundedLon,
        timezone: String(data?.timezone || resolvedTimezone),
        observedAt: String(current.time || ""),
        cached: false,
        summary: summaryParts.join(" "),
        current: {
          temperatureC: current.temperature_2m ?? null,
          feelsLikeC: current.apparent_temperature ?? null,
          condition: currentCondition,
          windKph: current.wind_speed_10m ?? null,
          precipitationMm: current.precipitation ?? null
        },
        today,
        tomorrow,
        source: "https://open-meteo.com/"
      };
      weatherCache.set(forecastCacheKey, result, WEATHER_CACHE_TTL_MS);
      return result;
    }, signal);
  }

  registry.register({
    id: "web.weather",
    name: "Check live weather",
    description: "Fast direct current weather and 2-day forecast lookup via Open-Meteo (no search engine crawl needed). Pass a location name, latitude/longitude, or omit to use the user's saved location.",
    scope: "web:read", risk: "read", trust: "external", network: true, externalAction: false,
    tags: ["weather", "forecast", "temperature", "rain", "wind", "climate", "local", "web"],
    inputSchema: {
      type: "object",
      properties: {
        location: { type: "string", minLength: 1, maxLength: 120 },
        latitude: { type: "number", minimum: -90, maximum: 90 },
        longitude: { type: "number", minimum: -180, maximum: 180 }
      },
      additionalProperties: false
    },
    async handler(args, context) {
      return await fetchWeather(args || {}, context || {});
    }
  });
}
