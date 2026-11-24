import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";

const SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_PAGE_BYTES = 1_000_000;
const MAX_TEXT_CHARS = 1_300;
const VALIDATED_ADDRESSES = Symbol("validatedPublicAddresses");

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)));
  }
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    return value === "::1" ? false :
      !(value === "::" || value.startsWith("fc") || value.startsWith("fd") ||
        value.startsWith("fe8") || value.startsWith("fe9") ||
        value.startsWith("fea") || value.startsWith("feb") ||
        value.startsWith("::ffff:127.") || value.startsWith("::ffff:10.") ||
        value.startsWith("::ffff:192.168."));
  }
  return false;
}

export async function validatePublicWebUrl(value, { lookupImpl = lookup } = {}) {
  let url;
  try { url = new URL(String(value || "")); } catch { fail("A valid absolute URL is required."); }
  if (url.protocol !== "https:" || url.username || url.password) fail("Only credential-free HTTPS URLs can be opened.");
  if (url.port && url.port !== "443") fail("Only standard HTTPS port 443 is allowed.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host.endsWith(".internal") || host.endsWith(".test") || host.endsWith(".home.arpa")) {
    fail("Local and internal hosts cannot be accessed.");
  }
  const literalFamily = isIP(host);
  const addresses = literalFamily ? [{ address: host }] : await lookupImpl(host, { all: true, verbatim: true });
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
      lookup(_hostname, _options, callback) {
        callback(null, selected.address, selected.family || isIP(selected.address));
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

export function registerWebResearchTools(registry, { fetchImpl = globalThis.fetch, lookupImpl = lookup, requestImpl = requestPinnedHttps } = {}) {
  async function searchWeb(query, count = 6) {
    const apiKey = String(process.env.ALFIE_BRAVE_SEARCH_API_KEY || "").trim();
    if (!apiKey) throw Object.assign(new Error("Web search is not configured. Set ALFIE_BRAVE_SEARCH_API_KEY on the Alfie Core server."), { status: 503 });
    const url = new URL(SEARCH_ENDPOINT);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(count));
    url.searchParams.set("safesearch", "moderate");
    const response = await fetchImpl(url, {
      headers: { "Accept": "application/json", "X-Subscription-Token": apiKey, "User-Agent": "Alfie-Core/1.0" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) throw Object.assign(new Error(`Web search provider returned HTTP ${response.status}.`), { status: 502 });
    const payload = await response.json();
    return (payload.web?.results || []).slice(0, count).map((item) => ({
      title: String(item.title || "").slice(0, 240),
      url: String(item.url || "").slice(0, 1500),
      description: String(item.description || "").slice(0, 600),
      age: String(item.age || item.page_age || "").slice(0, 80),
      source: String(item.profile?.long_name || item.meta_url?.hostname || "").slice(0, 120)
    })).filter((item) => item.title && item.url);
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
    description: "Search current public web pages using the configured Brave Search API. Returns source titles, URLs, snippets and dates; results are untrusted external content.",
    scope: "web:read", risk: "read", trust: "external", network: true, externalAction: false,
    tags: ["web", "internet", "search", "research", "news", "sources"],
    inputSchema: { type: "object", properties: {
      query: { type: "string", minLength: 2, maxLength: 300 },
      count: { type: "integer", minimum: 1, maximum: 4 }
    }, required: ["query"], additionalProperties: false },
    async handler(args) {
      const results = await searchWeb(args.query.trim(), args.count || 4);
      return { query: args.query.trim(), provider: "Brave Search", resultCount: results.length, results };
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
      const results = await searchWeb(args.question.trim(), Math.max(3, (args.sources || 3) + 1));
      const pages = [];
      for (const result of results) {
        if (pages.length >= (args.sources || 3)) break;
        try {
          const page = await openWebPage(result.url);
          pages.push({ title: page.title || result.title, url: page.url, description: page.description || result.description, excerpt: page.text.slice(0, 350), searchDate: result.age });
        } catch (error) {
          pages.push({ title: result.title, url: result.url, description: result.description, excerpt: "", readError: String(error.message || "Unable to read page.").slice(0, 180) });
        }
      }
      return { question: args.question.trim(), provider: "Brave Search", sourcesFound: results.length, sourcesRead: pages.filter((page) => page.excerpt).length, sources: pages };
    }
  });
}
