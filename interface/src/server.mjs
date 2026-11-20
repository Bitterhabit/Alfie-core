import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAlfieCoreClient } from "../../src/client.mjs";
import { createSignedIdentityAuth } from "../../src/auth/signedIdentity.mjs";
import { InterfaceAuthStore } from "./auth/store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.resolve(here, "../public");
const PORT = Number(process.env.PORT || 8781);
const COOKIE_NAME = "alfie_ui_session";
const isCookieSecure = () => process.env.ALFIE_UI_COOKIE_SECURE !== "false";
const MAX_BODY_BYTES = 1024 * 1024;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(body);
}

function cookies(header = "") {
  const result = {};
  for (const part of String(header).split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    try { result[key] = decodeURIComponent(part.slice(index + 1).trim()); } catch {}
  }
  return result;
}

function sessionCookieFlags(cookieSecure) {
  const requestedSameSite = String(process.env.ALFIE_UI_COOKIE_SAMESITE || "").trim().toLowerCase();
  const sameSite = !cookieSecure
    ? "SameSite=Lax"
    : (requestedSameSite === "none" ? "SameSite=None" : "SameSite=Strict");
  const flags = ["Path=/", "HttpOnly", sameSite];
  if (cookieSecure) {
    flags.push("Secure");
    if (requestedSameSite === "none") flags.push("Partitioned");
  }
  return flags;
}

function setSessionCookie(res, token, cookieSecure = isCookieSecure()) {
  const flags = [`${COOKIE_NAME}=${encodeURIComponent(token)}`, ...sessionCookieFlags(cookieSecure), "Max-Age=43200"];
  res.setHeader("set-cookie", flags.join("; "));
}

function clearSessionCookie(res, cookieSecure = isCookieSecure()) {
  const flags = [`${COOKIE_NAME}=`, ...sessionCookieFlags(cookieSecure), "Max-Age=0"];
  res.setHeader("set-cookie", flags.join("; "));
}

async function readJson(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("Request body is too large."), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object.");
    return value;
  } catch {
    throw Object.assign(new Error("Request body must be a valid JSON object."), { status: 400 });
  }
}

function originAllowed(req, {
  publicOrigin = process.env.ALFIE_UI_PUBLIC_ORIGIN,
  cookieSecure = isCookieSecure(),
  trustProxyHeaders = process.env.ALFIE_UI_TRUST_PROXY_HEADERS === "true",
  allowLocalHttpOrigin = false
} = {}) {
  const origin = req.headers.origin;
  if (!origin || typeof origin !== "string") return false;
  const configured = typeof publicOrigin === "string" && publicOrigin.trim() && publicOrigin.trim() !== "https://alfie.example.local"
    ? publicOrigin.trim()
    : "";
  if (configured) {
    return origin === configured;
  }
  try {
    const parsed = new URL(origin);
    const isLocalLoopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    const protocolAllowed = parsed.protocol === "https:"
      || (!cookieSecure && parsed.protocol === "http:")
      || (allowLocalHttpOrigin && isLocalLoopback && parsed.protocol === "http:");
    if (!protocolAllowed) return false;
    const forwardedHost = trustProxyHeaders && typeof req.headers["x-forwarded-host"] === "string"
      ? req.headers["x-forwarded-host"].split(",")[0].trim()
      : "";
    const host = forwardedHost || req.headers.host;
    if (host && parsed.host === host) return true;
    if (process.env.APP_URL) {
      try {
        if (origin === new URL(process.env.APP_URL).origin) return true;
      } catch {}
    }
    return false;
  } catch {
    return false;
  }
}

function sendError(res, error) {
  return json(res, Number.isInteger(error?.status) ? error.status : 502, {
    error: error?.message || "Alfie interface request failed.",
    ...(error?.code ? { code: error.code } : {}),
    ...(Number.isInteger(error?.revision) ? { revision: error.revision } : {})
  });
}

function securityHeaders(res) {
  const allowIframe = process.env.ALFIE_UI_ALLOW_IFRAME === "true";
  const rawAncestors = allowIframe ? String(process.env.ALFIE_UI_FRAME_ANCESTORS || "").trim() : "";
  const safeAncestors = rawAncestors && !/[;\r\n]/.test(rawAncestors) ? rawAncestors : "";
  const frameAncestors = !allowIframe
    ? "frame-ancestors 'none'"
    : (safeAncestors ? `frame-ancestors ${safeAncestors}` : "frame-ancestors 'self'");

  res.setHeader("x-content-type-options", "nosniff");
  if (!allowIframe) {
    res.setHeader("x-frame-options", "DENY");
  } else if (!safeAncestors) {
    res.setHeader("x-frame-options", "SAMEORIGIN");
  }
  res.setHeader("referrer-policy", "same-origin");
  res.setHeader("permissions-policy", "camera=(), microphone=(self), geolocation=()");
  res.setHeader("cross-origin-opener-policy", "same-origin");
  res.setHeader("cross-origin-resource-policy", "same-origin");
  res.setHeader("x-permitted-cross-domain-policies", "none");
  res.setHeader(
    "content-security-policy",
    `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-src 'none'; object-src 'none'; ${frameAncestors}`
  );
}

export function createAlfieInterfaceServer({
  authStore = new InterfaceAuthStore(),
  publicOrigin = process.env.ALFIE_UI_PUBLIC_ORIGIN,
  cookieSecure = isCookieSecure(),
  trustProxyHeaders = process.env.ALFIE_UI_TRUST_PROXY_HEADERS === "true",
  allowLocalHttpOrigin = false,
  coreClient = createAlfieCoreClient({
    baseUrl: process.env.ALFIE_CORE_URL || "http://alfie-core:8780",
    serviceToken: process.env.ALFIE_CORE_SERVICE_TOKEN || "",
    identityAuth: createSignedIdentityAuth({
      secret: process.env.ALFIE_CORE_STANDALONE_IDENTITY_SECRET || "",
      providerId: "standalone-ui"
    })
  }),
  vramReportToken = process.env.ALFIE_VRAM_REPORT_TOKEN || "",
  now = () => Date.now()
} = {}) {
  const loginAttempts = new Map();
  const telemetryAttempts = new Map();

  function verifyTelemetryBearer(req) {
    const expected = String(vramReportToken || process.env.ALFIE_VRAM_REPORT_TOKEN || "").trim();
    if (Buffer.byteLength(expected, "utf8") < 16) {
      throw Object.assign(
        new Error("External PC VRAM reporting is not configured. Set ALFIE_VRAM_REPORT_TOKEN (16+ characters) on the server."),
        { status: 503, code: "VRAM_TOKEN_NOT_CONFIGURED" }
      );
    }
    const authHeader = String(req.headers.authorization || "");
    const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
    if (!match) {
      throw Object.assign(new Error("Authorization: Bearer <ALFIE_VRAM_REPORT_TOKEN> header is required."), {
        status: 401,
        code: "VRAM_TOKEN_INVALID"
      });
    }
    const providedHash = createHash("sha256").update(match[1], "utf8").digest();
    const expectedHash = createHash("sha256").update(expected, "utf8").digest();
    if (!timingSafeEqual(providedHash, expectedHash)) {
      throw Object.assign(new Error("Invalid VRAM telemetry bearer token."), {
        status: 401,
        code: "VRAM_TOKEN_INVALID"
      });
    }
  }

  function checkTelemetryRateLimit(ip) {
    const current = now();
    if (telemetryAttempts.size > 256) {
      for (const [key, list] of telemetryAttempts.entries()) {
        if (!list.some((ts) => current - ts < 60_000)) telemetryAttempts.delete(key);
      }
    }
    const bucket = telemetryAttempts.get(ip) || [];
    const recent = bucket.filter((ts) => current - ts < 60_000);
    if (recent.length >= 60) {
      telemetryAttempts.set(ip, recent);
      throw Object.assign(new Error("Too many VRAM telemetry updates. Slow polling to <= 1/sec."), { status: 429 });
    }
    recent.push(current);
    telemetryAttempts.set(ip, recent);
  }

  function clientIp(req) {
    const forwardedIp = trustProxyHeaders ? req.headers["cf-connecting-ip"] : null;
    return String(forwardedIp || req.socket.remoteAddress || "unknown").slice(0, 100);
  }

  async function sessionFor(req) {
    const token = cookies(req.headers.cookie)[COOKIE_NAME];
    if (!token) return null;
    return authStore.authenticate(token);
  }

  async function requireSession(req, res) {
    const session = await sessionFor(req);
    if (!session) {
      json(res, 401, { error: "Sign in to Alfie first." });
      return null;
    }
    return session;
  }

  function requireCsrf(req, session) {
    if (!originAllowed(req, { publicOrigin, cookieSecure, trustProxyHeaders, allowLocalHttpOrigin })) {
      throw Object.assign(new Error("Request origin was not accepted."), { status: 403 });
    }
    const token = req.headers["x-csrf-token"];
    if (typeof token !== "string" || token !== session.csrfToken) {
      throw Object.assign(new Error("The session security token is missing or expired. Refresh the page and try again."), { status: 403, code: "CSRF_INVALID" });
    }
  }

  return createServer(async (req, res) => {
    securityHeaders(res);
    const url = new URL(req.url || "/", "http://alfie-interface.local");
    const method = req.method || "GET";

    if (method === "GET" && url.pathname === "/health") {
      return json(res, 200, { status: "ok", service: "alfie-interface" });
    }

    if (url.pathname.startsWith("/api/")) {
      try {
        if (method === "POST" && url.pathname === "/api/telemetry/vram") {
          checkTelemetryRateLimit(clientIp(req));
          verifyTelemetryBearer(req);
          const body = await readJson(req, 8192);
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            return json(res, 400, { error: "Telemetry payload must be a JSON object." });
          }
          if (typeof coreClient.reportExternalVram !== "function") {
            return json(res, 503, { error: "Core client does not support external VRAM reporting." });
          }
          const result = await coreClient.reportExternalVram(body);
          return json(res, 200, result);
        }

        if (method === "GET" && url.pathname === "/api/auth/me") {
          if (await authStore.setupRequired()) return json(res, 200, { authenticated: false, setupRequired: true });
          const session = await sessionFor(req);
          if (!session) return json(res, 200, { authenticated: false, setupRequired: false });
          return json(res, 200, { authenticated: true, user: session.user, csrfToken: session.csrfToken });
        }

        if (method === "POST" && url.pathname === "/api/auth/setup") {
          if (!originAllowed(req, { publicOrigin, cookieSecure, trustProxyHeaders, allowLocalHttpOrigin })) {
            return json(res, 403, { error: "Request origin was not accepted." });
          }
          if (!(await authStore.setupRequired())) {
            return json(res, 409, { error: "Initial administrator setup has already been completed." });
          }
          const ip = clientIp(req);
          const body = await readJson(req);
          const created = await authStore.bootstrap(body.username, body.password);
          if (!created.created) {
            return json(res, 409, { error: "Initial administrator setup has already been completed." });
          }
          const result = await authStore.login(body.username, body.password, { ip });
          setSessionCookie(res, result.token, cookieSecure);
          return json(res, 201, { authenticated: true, user: result.user, csrfToken: result.csrfToken });
        }

        if (method === "POST" && url.pathname === "/api/auth/login") {
          if (!originAllowed(req, { publicOrigin, cookieSecure, trustProxyHeaders, allowLocalHttpOrigin })) {
            return json(res, 403, { error: "Request origin was not accepted." });
          }
          const ip = clientIp(req);
          // Expired buckets are discarded and the map is bounded against random-IP memory growth.
          for (const [key, value] of loginAttempts) {
            if (value.resetAt <= now()) loginAttempts.delete(key);
          }
          while (loginAttempts.size >= 5000) loginAttempts.delete(loginAttempts.keys().next().value);
          const current = loginAttempts.get(ip);
          if (current && current.resetAt > now() && current.count >= 5) {
            return json(res, 429, { error: "Too many sign-in attempts. Wait ten minutes before trying again." });
          }
          const body = await readJson(req);
          try {
            const result = await authStore.login(body.username, body.password, { ip });
            loginAttempts.delete(ip);
            setSessionCookie(res, result.token, cookieSecure);
            return json(res, 200, { authenticated: true, user: result.user, csrfToken: result.csrfToken });
          } catch (error) {
            const attempt = current && current.resetAt > now()
              ? current
              : { count: 0, resetAt: now() + 10 * 60 * 1000 };
            attempt.count += 1;
            loginAttempts.set(ip, attempt);
            throw error;
          }
        }

        if (method === "POST" && url.pathname === "/api/auth/password") {
          const session = await requireSession(req, res);
          if (!session) return;
          requireCsrf(req, session);
          const body = await readJson(req);
          const result = await authStore.changePassword(session.user.id, body.currentPassword, body.newPassword);
          clearSessionCookie(res, cookieSecure);
          return json(res, 200, result);
        }

        if (method === "POST" && url.pathname === "/api/auth/logout") {
          const session = await requireSession(req, res);
          if (!session) return;
          requireCsrf(req, session);
          const token = cookies(req.headers.cookie)[COOKIE_NAME];
          await authStore.logout(token);
          clearSessionCookie(res, cookieSecure);
          return json(res, 200, { authenticated: false });
        }

        const session = await requireSession(req, res);
        if (!session) return;
        const userId = session.user.id;

        const imageMatch = /^\/api\/core\/images\/([a-zA-Z0-9._-]{1,128})$/.exec(url.pathname);
        if (method === "GET" && imageMatch) {
          try {
            const { buffer, mimeType } = await coreClient.getImage(imageMatch[1]);
            res.writeHead(200, {
              "content-type": mimeType,
              "content-length": buffer.length,
              "cache-control": "private, max-age=86400, immutable",
              "x-content-type-options": "nosniff"
            });
            return res.end(buffer);
          } catch (err) {
            return json(res, err.status || 404, { error: err.message || "Visual asset not found." });
          }
        }

        if (method === "POST" && url.pathname === "/api/auth/link") {
          requireCsrf(req, session);
          const body = await readJson(req);
          return json(res, 200, await coreClient.linkIdentity(userId, body.code));
        }

        if (method === "POST" && url.pathname === "/api/auth/standalone") {
          requireCsrf(req, session);
          await readJson(req);
          return json(res, 201, await coreClient.createStandaloneWorkspace(userId));
        }

        if (method === "GET" && url.pathname === "/api/core/whoami") {
          return json(res, 200, await coreClient.whoami(userId));
        }
        if (method === "GET" && url.pathname === "/api/core/status") {
          return json(res, 200, await coreClient.status(userId));
        }
        if (method === "GET" && url.pathname === "/api/core/projects") {
          return json(res, 200, await coreClient.listProjects(userId));
        }
        if (method === "POST" && url.pathname === "/api/core/projects") {
          requireCsrf(req, session);
          return json(res, 201, await coreClient.createProject(userId, await readJson(req)));
        }
        const projectMatch = /^\/api\/core\/projects\/([a-f0-9-]{36})$/.exec(url.pathname);
        if (method === "GET" && projectMatch) {
          return json(res, 200, await coreClient.getProject(userId, projectMatch[1]));
        }
        if (method === "PATCH" && projectMatch) {
          requireCsrf(req, session);
          return json(res, 200, await coreClient.updateProject(userId, projectMatch[1], await readJson(req)));
        }
        if (method === "DELETE" && projectMatch) {
          requireCsrf(req, session);
          return json(res, 200, await coreClient.deleteProject(userId, projectMatch[1]));
        }
        if (method === "GET" && url.pathname === "/api/core/system/vram") {
          return json(res, 200, await coreClient.getVramStatus(userId));
        }
        if (method === "POST" && url.pathname === "/api/core/system/vram/report") {
          requireCsrf(req, session);
          return json(res, 200, await coreClient.reportVramStatus(userId, await readJson(req)));
        }
        if (method === "GET" && url.pathname === "/api/core/conversations") {
          return json(res, 200, await coreClient.listConversations(userId, url.searchParams.toString()));
        }
        if (method === "POST" && url.pathname === "/api/core/conversations") {
          requireCsrf(req, session);
          return json(res, 201, await coreClient.createConversation(userId, await readJson(req)));
        }
        const conversationMatch = /^\/api\/core\/conversations\/([a-f0-9-]{36})$/.exec(url.pathname);
        const handoffMatch = /^\/api\/core\/conversations\/([a-f0-9-]{36})\/handoff$/.exec(url.pathname);
        const messageMatch = /^\/api\/core\/conversations\/([a-f0-9-]{36})\/messages$/.exec(url.pathname);
        const reactionMatch = /^\/api\/core\/conversations\/([a-f0-9-]{36})\/messages\/([a-f0-9-]{36})\/reaction$/.exec(url.pathname);
        if (method === "POST" && handoffMatch) {
          requireCsrf(req, session);
          return json(res, 201, await coreClient.handoffConversation(userId, handoffMatch[1], await readJson(req)));
        }
        if (method === "GET" && conversationMatch) {
          return json(res, 200, await coreClient.getConversation(userId, conversationMatch[1]));
        }
        if (method === "PATCH" && conversationMatch) {
          requireCsrf(req, session);
          const body = await readJson(req);
          if (typeof coreClient.updateConversation === "function") {
            return json(res, 200, await coreClient.updateConversation(userId, conversationMatch[1], {
              ...(body.title !== undefined ? { title: body.title } : {}),
              ...(body.projectId !== undefined ? { projectId: body.projectId } : {})
            }));
          }
          return json(res, 200, { conversation: await coreClient.renameConversation(userId, conversationMatch[1], body.title) });
        }
        if (method === "DELETE" && conversationMatch) {
          requireCsrf(req, session);
          return json(res, 200, await coreClient.deleteConversation(userId, conversationMatch[1]));
        }
        if (method === "POST" && messageMatch) {
          requireCsrf(req, session);
          return json(res, 201, await coreClient.appendMessage(userId, messageMatch[1], await readJson(req)));
        }
        if ((method === "POST" || method === "PUT") && reactionMatch) {
          requireCsrf(req, session);
          const body = await readJson(req);
          return json(res, 200, await coreClient.reactMessage(userId, reactionMatch[1], reactionMatch[2], body.reaction));
        }
        if (method === "POST" && url.pathname === "/api/core/agent/run") {
          requireCsrf(req, session);
          return json(res, 200, await coreClient.runAgent(userId, await readJson(req)));
        }
        if (method === "POST" && url.pathname === "/api/core/chat/stream") {
          requireCsrf(req, session);
          const upstream = await coreClient.stream(userId, await readJson(req));
          if (!upstream.ok) {
            const payload = await upstream.json().catch(() => ({}));
            return json(res, upstream.status, payload);
          }
          res.writeHead(upstream.status, {
            "content-type": upstream.headers.get("content-type") || "application/x-ndjson; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            "x-accel-buffering": "no"
          });
          for await (const chunk of upstream.body) res.write(chunk);
          return res.end();
        }

        if (method === "GET" && url.pathname === "/api/core/memories") {
          return json(res, 200, await coreClient.listMemories(userId, url.searchParams.toString()));
        }
        if (method === "POST" && url.pathname === "/api/core/memories") {
          requireCsrf(req, session);
          return json(res, 201, await coreClient.createMemory(userId, await readJson(req)));
        }
        const memoryMatch = /^\/api\/core\/memories\/([a-f0-9-]{36})$/.exec(url.pathname);
        if (method === "PATCH" && memoryMatch) {
          requireCsrf(req, session);
          return json(res, 200, await coreClient.updateMemory(userId, memoryMatch[1], await readJson(req)));
        }
        if (method === "DELETE" && memoryMatch) {
          requireCsrf(req, session);
          return json(res, 200, await coreClient.deleteMemory(userId, memoryMatch[1]));
        }

        if (method === "GET" && url.pathname === "/api/core/tools") return json(res, 200, await coreClient.listTools(userId));
        if (method === "GET" && url.pathname === "/api/core/permissions") return json(res, 200, await coreClient.listPermissions(userId));
        if (method === "POST" && url.pathname === "/api/core/permissions") {
          requireCsrf(req, session);
          const body = await readJson(req);
          return json(res, 200, await coreClient.request(userId, "/v1/permissions", { method: "POST", body }));
        }
        if (method === "DELETE" && url.pathname === "/api/core/permissions") {
          requireCsrf(req, session);
          const body = await readJson(req);
          return json(res, 200, await coreClient.request(userId, "/v1/permissions", { method: "DELETE", body }));
        }
        if (method === "GET" && url.pathname === "/api/core/tools/pending") return json(res, 200, await coreClient.listPendingActions(userId));
        if (method === "POST" && url.pathname === "/api/core/tools/approve") {
          requireCsrf(req, session);
          const body = await readJson(req);
          return json(res, 200, await coreClient.approveAction(userId, body.actionId));
        }
        if (method === "POST" && url.pathname === "/api/core/tools/reject") {
          requireCsrf(req, session);
          const body = await readJson(req);
          return json(res, 200, await coreClient.rejectAction(userId, body.actionId));
        }
        if (method === "GET" && url.pathname === "/api/core/audit") return json(res, 200, await coreClient.listAudit(userId, Number(url.searchParams.get("limit") || 50)));
        if (method === "GET" && url.pathname === "/api/core/providers") return json(res, 200, await coreClient.request(userId, "/v1/providers"));
        if (method === "GET" && url.pathname === "/api/core/providers/health") return json(res, 200, await coreClient.request(userId, "/v1/providers/health"));
        if (method === "GET" && url.pathname === "/api/core/cloud-agents") {
          return json(res, 200, await coreClient.listCloudAgents(userId));
        }
        const cloudAgentMatch = /^\/api\/core\/cloud-agents\/(gemini|openai)$/.exec(url.pathname);
        if (method === "PATCH" && cloudAgentMatch) {
          requireCsrf(req, session);
          return json(res, 200, await coreClient.updateCloudAgent(userId, cloudAgentMatch[1], await readJson(req)));
        }
        const cloudPreviewMatch = /^\/api\/core\/cloud-agents\/(gemini|openai)\/privacy-preview$/.exec(url.pathname);
        if (method === "POST" && cloudPreviewMatch) {
          requireCsrf(req, session);
          return json(res, 200, await coreClient.previewCloudAgentPrivacy(userId, cloudPreviewMatch[1], await readJson(req)));
        }
        if (method === "POST" && url.pathname === "/api/core/images/generate") {
          requireCsrf(req, session);
          const body = await readJson(req);
          return json(res, 201, await coreClient.generateImage(userId, body));
        }

        return json(res, 404, { error: "Interface API route not found." });
      } catch (error) {
        return sendError(res, error);
      }
    }

    if (method !== "GET" && method !== "HEAD") return json(res, 405, { error: "Method not allowed." });
    const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const ALLOWED_ASSETS = {
      "index.html": "text/html; charset=utf-8",
      "app.js": "text/javascript; charset=utf-8",
      "shortcuts.mjs": "text/javascript; charset=utf-8",
      "voice-waveform.mjs": "text/javascript; charset=utf-8",
      "styles.css": "text/css; charset=utf-8",
      "sw.js": "application/javascript; charset=utf-8",
      "manifest.webmanifest": "application/manifest+json; charset=utf-8",
      "manifest.json": "application/manifest+json; charset=utf-8",
      "icon.svg": "image/svg+xml",
      "icon-192.png": "image/png",
      "icon-512.png": "image/png",
      "apple-touch-icon.png": "image/png",
      "vendor/react.production.min.js": "application/javascript; charset=utf-8",
      "vendor/react-dom.production.min.js": "application/javascript; charset=utf-8",
      "vendor/recharts.js": "application/javascript; charset=utf-8"
    };
    if (!ALLOWED_ASSETS[relative]) return json(res, 404, { error: "Not found." });
    try {
      const content = await fs.readFile(path.join(publicDirectory, relative));
      const headers = {
        "content-type": ALLOWED_ASSETS[relative],
        "cache-control": relative === "sw.js" ? "no-cache, no-store, must-revalidate" : "no-cache",
        "x-content-type-options": "nosniff"
      };
      if (relative === "sw.js") headers["service-worker-allowed"] = "/";
      res.writeHead(200, headers);
      return res.end(method === "HEAD" ? undefined : content);
    } catch {
      return json(res, 404, { error: "Interface asset not found." });
    }
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const authStore = new InterfaceAuthStore();
  const bootstrapUsername = process.env.ALFIE_UI_BOOTSTRAP_USERNAME || "";
  const bootstrapPassword = process.env.ALFIE_UI_BOOTSTRAP_PASSWORD || "";
  if (bootstrapUsername || bootstrapPassword) {
    const result = await authStore.bootstrap(bootstrapUsername, bootstrapPassword);
    if (result.created) process.stdout.write("Created the initial Alfie interface administrator. Remove bootstrap credentials from the environment and restart.\n");
  }
  const server = createAlfieInterfaceServer({ authStore });
  server.listen(PORT, "0.0.0.0", () => process.stdout.write(`Alfie standalone interface listening on port ${PORT}.
`));
}
