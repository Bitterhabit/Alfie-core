import path from "node:path";
import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createAlfieCoreServer } from "./src/server.mjs";
import { createAlfieInterfaceServer } from "./interface/src/server.mjs";
import { InterfaceAuthStore } from "./interface/src/auth/store.mjs";
import { createAlfieCoreClient } from "./src/client.mjs";
import { createSignedIdentityAuth } from "./src/auth/signedIdentity.mjs";

const rootDir = process.cwd();

function ensureSecret(envName) {
  const existing = process.env[envName];
  if (existing && Buffer.byteLength(existing, "utf8") >= 32) return existing;
  const generated = randomBytes(32).toString("hex");
  process.env[envName] = generated;
  return generated;
}

// Generate ephemeral per-process secrets if not supplied in the environment
ensureSecret("ALFIE_CORE_SERVICE_TOKEN");
ensureSecret("ALFIE_CORE_STANDALONE_IDENTITY_SECRET");
ensureSecret("ALFIE_CORE_PETRIO_IDENTITY_SECRET");

process.env.ALFIE_CORE_DATA_DIR = process.env.ALFIE_CORE_DATA_DIR || path.join(rootDir, "data", "core");
process.env.ALFIE_UI_DATA_DIR = process.env.ALFIE_UI_DATA_DIR || path.join(rootDir, "data", "interface");
process.env.ALFIE_UI_COOKIE_SECURE = process.env.ALFIE_UI_COOKIE_SECURE || "false";
if (process.env.APP_URL) {
  process.env.ALFIE_UI_ALLOW_IFRAME = process.env.ALFIE_UI_ALLOW_IFRAME || "true";
  process.env.ALFIE_UI_FRAME_ANCESTORS = process.env.ALFIE_UI_FRAME_ANCESTORS || "https://aistudio.google.com https://*.google.com https://*.googleusercontent.com 'self'";
  process.env.ALFIE_UI_COOKIE_SAMESITE = process.env.ALFIE_UI_COOKIE_SAMESITE || "none";
}

if (process.env.ALFIE_UI_PUBLIC_ORIGIN === "https://alfie.example.local") {
  process.env.ALFIE_UI_PUBLIC_ORIGIN = "";
}

const bootstrapUsername = (process.env.ALFIE_UI_BOOTSTRAP_USERNAME || "").trim();
const bootstrapPassword = process.env.ALFIE_UI_BOOTSTRAP_PASSWORD || "";

// Ensure data directories exist
await fs.mkdir(process.env.ALFIE_CORE_DATA_DIR, { recursive: true, mode: 0o700 });
await fs.mkdir(process.env.ALFIE_UI_DATA_DIR, { recursive: true, mode: 0o700 });

// 1. Start Alfie Core server on internal loopback
const corePort = Number(process.env.ALFIE_CORE_INTERNAL_PORT || 8780);
const coreServer = createAlfieCoreServer();

await new Promise((resolve, reject) => {
  coreServer.listen(corePort, "127.0.0.1", () => {
    resolve();
  });
  coreServer.once("error", reject);
});

const coreUrl = `http://127.0.0.1:${corePort}`;
process.env.ALFIE_CORE_URL = coreUrl;

// 2. Initialize Interface Auth Store and bootstrap account only when explicitly configured
const authStore = new InterfaceAuthStore({ dataDirectory: process.env.ALFIE_UI_DATA_DIR });
if (bootstrapUsername && bootstrapPassword) {
  try {
    const bootResult = await authStore.bootstrap(bootstrapUsername, bootstrapPassword);
    if (bootResult.created) {
      console.log(`[Alfie] Initial administrator account created for "${bootstrapUsername}". Remove bootstrap credentials from the environment after startup.`);
    }
  } catch (err) {
    console.warn("[Alfie] Bootstrap skipped:", err.message);
  }
}

// 3. Connect Interface client to Alfie Core
const coreClient = createAlfieCoreClient({
  baseUrl: coreUrl,
  serviceToken: process.env.ALFIE_CORE_SERVICE_TOKEN,
  identityAuth: createSignedIdentityAuth({
    secret: process.env.ALFIE_CORE_STANDALONE_IDENTITY_SECRET,
    providerId: "standalone-ui"
  })
});

// 4. Start Interface server on port 3000 (required by AI Studio)
const PORT = Number(process.env.ALFIE_PORT || (process.env.PORT === "8080" ? 3000 : (process.env.PORT || 3000)));
const cookieSecure = process.env.ALFIE_UI_COOKIE_SECURE !== "false";
const interfaceServer = createAlfieInterfaceServer({
  authStore,
  coreClient,
  cookieSecure,
  allowLocalHttpOrigin: !process.env.ALFIE_UI_PUBLIC_ORIGIN
});

const needsSetup = await authStore.setupRequired();
interfaceServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[Alfie] Interface listening on http://0.0.0.0:${PORT}`);
  console.log(`[Alfie] Connected to Alfie Core foundation on ${coreUrl}`);
  if (needsSetup) {
    console.log("[Alfie] First-run setup required. Open the web interface to create the initial administrator account or configure ALFIE_UI_BOOTSTRAP_USERNAME and ALFIE_UI_BOOTSTRAP_PASSWORD.");
  }
});

function shutdown() {
  interfaceServer.close(() => {
    coreServer.close(() => {
      process.exit(0);
    });
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
