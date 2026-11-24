import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { isPrivateOrReservedIpv4, isPrivateOrReservedIpv6 } from "../watchers/engine.mjs";

const SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_PAGE_BYTES = 1_000_000;
const MAX_TEXT_CHARS = 1_300;
const VALIDATED_ADDRESSES = Symbol("validatedPublicAddresses");
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

function requestPinnedHttps(url, { addresses, headers, signal }) {
  const selected = addresses?.[0];
  if (!selected || !isPublicAddress(selected.address)) {
    return Promise.reject(new Error("A previously validated public destination is required."));
  }
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

export function registerWebResearchTools(registry, { fetchImpl = globalThis.fetch, lookupImpl = lookup, requestImpl = requestPinnedHttps, env = process.env } = {}) {
  async function searchWeb(query, count = 4) {
    const searxngBase = String(env.ALFIE_SEARXNG_URL || "").trim();
    const braveKey = String(env.ALFIE_BRAVE_SEARCH_API_KEY || "").trim();
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
        const response = await fetchImpl(url, {
          headers: { "Accept": "application/json", "User-Agent": "Alfie-Core/1.0" },
          redirect: "error",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
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
        return { provider: "SearXNG", results };
      } catch (error) {
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
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
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
      return { provider: "Brave Search", fallbackReason: searxngError, results };
    }

    if (searxngError) {
      throw Object.assign(new Error(`SearXNG is unavailable and no Brave fallback is configured: ${searxngError}`), { status: 503 });
    }
    throw Object.assign(new Error("Web search is not configured. Set ALFIE_SEARXNG_URL or ALFIE_BRAVE_SEARCH_API_KEY on the Alfie Core server."), { status: 503 });
  }

  async function openWebPage(rawUrl) {
    let target = await validatePublicWebUrl(rawUrl, { lookupImpl });
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const response = await requestImpl(target, {
        addresses: target[VALIDATED_ADDRESSES],
        headers: { "Accept": "text/html, text/plain;q=0.9", "User-Agent": "Alfie-Core/1.0 (+https://github.com/Bitterhabit/Alfie-core)" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
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
    async handler(args) {
      const search = await searchWeb(args.query.trim(), args.count || 4);
      return { query: args.query.trim(), provider: search.provider, fallbackReason: search.fallbackReason || null, resultCount: search.results.length, results: search.results };
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
    async handler(args) { return await openWebPage(args.url); }
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
    async handler(args) {
      const targetCount = Math.max(1, Math.min(3, Number(args.sources) || 3));
      const search = await searchWeb(args.question.trim(), Math.max(3, targetCount + 1));
      const candidates = search.results.slice(0, targetCount);
      const settled = await Promise.allSettled(candidates.map((result) => openWebPage(result.url)));
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
}
