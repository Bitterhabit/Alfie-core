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
const COOKIE_SECURE = process.env.ALFIE_UI_COOKIE_SECURE !== "false";
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

function setSessionCookie(res, token, cookieSecure = COOKIE_SECURE) {
  const flags = [`${COOKIE_NAME}=${encodeURIComponent(token)}`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=43200"];
  if (cookieSecure) flags.push("Secure");
  res.setHeader("set-cookie", flags.join("; "));
}

function clearSessionCookie(res, cookieSecure = COOKIE_SECURE) {
  const flags = [`${COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (cookieSecure) flags.push("Secure");
  res.setHeader("set-cookie", flags.join("; "));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Request body is too large."), { status: 413 });
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

function originAllowed(req, publicOrigin = process.env.ALFIE_UI_PUBLIC_ORIGIN, cookieSecure = COOKIE_SECURE) {
  const origin = req.headers.origin;
  if (typeof origin !== "string") return false;
  const configured = publicOrigin;
  if (configured) return origin === configured;
  try {
    const parsed = new URL(origin);
    return parsed.host === req.headers.host &&
      (parsed.protocol === "https:" || (!cookieSecure && parsed.protocol === "http:"));
  } catch { return false; }
}

function sendError(res, error) {
  return json(res, Number.isInteger(error?.status) ? error.status : 502, {
    error: error?.message || "Alfie interface request failed.",
    ...(error?.code ? { code: error.code } : {}),
    ...(Number.isInteger(error?.revision) ? { revision: error.revision } : {})
  });
}

function securityHeaders(res) {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "same-origin");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
}

export function createAlfieInterfaceServer({
  authStore = new InterfaceAuthStore(),
  publicOrigin = process.env.ALFIE_UI_PUBLIC_ORIGIN,
  cookieSecure = COOKIE_SECURE,
  trustProxyHeaders = process.env.ALFIE_UI_TRUST_PROXY_HEADERS === "true",
  coreClient = createAlfieCoreClient({
    baseUrl: process.env.ALFIE_CORE_URL || "http://alfie-core:8780",
    serviceToken: process.env.ALFIE_CORE_SERVICE_TOKEN || "",
    identityAuth: createSignedIdentityAuth({
      secret: process.env.ALFIE_CORE_STANDALONE_IDENTITY_SECRET || "",
      providerId: "standalone-ui"
    })
  }),
  now = () => Date.now()
} = {}) {
  const loginAttempts = new Map();

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
    if (!originAllowed(req, publicOrigin, cookieSecure)) throw Object.assign(new Error("Request origin was not accepted."), { status: 403 });
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
        if (method === "GET" && url.pathname === "/api/auth/me") {
          if (await authStore.setupRequired()) return json(res, 200, { authenticated: false, setupRequired: true });
          const session = await sessionFor(req);
          if (!session) return json(res, 200, { authenticated: false, setupRequired: false });
          return json(res, 200, { authenticated: true, user: session.user, csrfToken: session.csrfToken });
        }

        if (method === "POST" && url.pathname === "/api/auth/login") {
          if (!originAllowed(req, publicOrigin, cookieSecure)) return json(res, 403, { error: "Request origin was not accepted." });
          const forwardedIp = trustProxyHeaders ? req.headers["cf-connecting-ip"] : null;
          const ip = String(forwardedIp || req.socket.remoteAddress || "unknown").slice(0, 100);
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
        if (method === "GET" && url.pathname === "/api/core/conversations") {
          return json(res, 200, await coreClient.listConversations(userId));
        }
        if (method === "POST" && url.pathname === "/api/core/conversations") {
          requireCsrf(req, session);
          return json(res, 201, await coreClient.createConversation(userId, await readJson(req)));
        }
        const conversationMatch = /^\/api\/core\/conversations\/([a-f0-9-]{36})$/.exec(url.pathname);
        const messageMatch = /^\/api\/core\/conversations\/([a-f0-9-]{36})\/messages$/.exec(url.pathname);
        if (method === "GET" && conversationMatch) {
          return json(res, 200, await coreClient.getConversation(userId, conversationMatch[1]));
        }
        if (method === "PATCH" && conversationMatch) {
          requireCsrf(req, session);
          const body = await readJson(req);
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

        return json(res, 404, { error: "Interface API route not found." });
      } catch (error) {
        return sendError(res, error);
      }
    }

    if (method !== "GET" && method !== "HEAD") return json(res, 405, { error: "Method not allowed." });
    const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (!["index.html", "app.js", "styles.css"].includes(relative)) return json(res, 404, { error: "Not found." });
    try {
      const content = await fs.readFile(path.join(publicDirectory, relative));
      const type = relative.endsWith(".html") ? "text/html; charset=utf-8" : relative.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8";
      res.writeHead(200, { "content-type": type, "cache-control": "no-cache", "x-content-type-options": "nosniff" });
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
