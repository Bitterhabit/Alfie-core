import path from "node:path";
import fs from "node:fs/promises";
import { createAlfieCoreServer } from "./src/server.mjs";
import { createAlfieInterfaceServer } from "./interface/src/server.mjs";
import { InterfaceAuthStore } from "./interface/src/auth/store.mjs";
import { createAlfieCoreClient } from "./src/client.mjs";
import { createSignedIdentityAuth } from "./src/auth/signedIdentity.mjs";

const rootDir = process.cwd();

// Set sensible defaults for any unconfigured environment variables
process.env.ALFIE_CORE_SERVICE_TOKEN =
  process.env.ALFIE_CORE_SERVICE_TOKEN && Buffer.byteLength(process.env.ALFIE_CORE_SERVICE_TOKEN, "utf8") >= 32
    ? process.env.ALFIE_CORE_SERVICE_TOKEN
    : "alfie-core-service-token-dev-secret-key-32chars";

process.env.ALFIE_CORE_STANDALONE_IDENTITY_SECRET =
  process.env.ALFIE_CORE_STANDALONE_IDENTITY_SECRET && Buffer.byteLength(process.env.ALFIE_CORE_STANDALONE_IDENTITY_SECRET, "utf8") >= 32
    ? process.env.ALFIE_CORE_STANDALONE_IDENTITY_SECRET
    : "alfie-core-standalone-secret-dev-key-32chars";

process.env.ALFIE_CORE_PETRIO_IDENTITY_SECRET =
  process.env.ALFIE_CORE_PETRIO_IDENTITY_SECRET && Buffer.byteLength(process.env.ALFIE_CORE_PETRIO_IDENTITY_SECRET, "utf8") >= 32
    ? process.env.ALFIE_CORE_PETRIO_IDENTITY_SECRET
    : "alfie-core-petrio-secret-dev-key-32chars";

process.env.ALFIE_CORE_DATA_DIR = process.env.ALFIE_CORE_DATA_DIR || path.join(rootDir, "data", "core");
process.env.ALFIE_UI_DATA_DIR = process.env.ALFIE_UI_DATA_DIR || path.join(rootDir, "data", "interface");
process.env.ALFIE_UI_COOKIE_SECURE = process.env.ALFIE_UI_COOKIE_SECURE || "false";
process.env.ALFIE_UI_ALLOW_IFRAME = process.env.ALFIE_UI_ALLOW_IFRAME || "true";

if (!process.env.ALFIE_UI_PUBLIC_ORIGIN || process.env.ALFIE_UI_PUBLIC_ORIGIN === "https://alfie.example.local") {
  process.env.ALFIE_UI_PUBLIC_ORIGIN = process.env.APP_URL || "";
}

const bootstrapUsername = process.env.ALFIE_UI_BOOTSTRAP_USERNAME || "admin";
const bootstrapPassword = process.env.ALFIE_UI_BOOTSTRAP_PASSWORD || "alfie123";

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

// 2. Initialize Interface Auth Store and bootstrap account if required
const authStore = new InterfaceAuthStore({ dataDirectory: process.env.ALFIE_UI_DATA_DIR });
if (bootstrapUsername && bootstrapPassword) {
  try {
    const bootResult = await authStore.bootstrap(bootstrapUsername, bootstrapPassword);
    if (bootResult.created) {
      console.log(`[Alfie] Initial administrator account created: username="${bootstrapUsername}"`);
    } else {
      await authStore.setPassword(bootstrapUsername, bootstrapPassword);
      console.log(`[Alfie] Administrator account password synchronized: username="${bootstrapUsername}"`);
    }
    if (bootstrapUsername.toLowerCase() !== "alfie") {
      await authStore.ensureUser("alfie", bootstrapPassword, { displayName: "Alfie" });
    }
  } catch (err) {
    console.warn("[Alfie] Notice on bootstrap:", err.message);
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
const cookieSecure = process.env.ALFIE_UI_COOKIE_SECURE === "true";
const interfaceServer = createAlfieInterfaceServer({
  authStore,
  coreClient,
  cookieSecure
});

interfaceServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[Alfie] Interface listening on http://0.0.0.0:${PORT}`);
  console.log(`[Alfie] Connected to Alfie Core foundation on ${coreUrl}`);
  console.log(`[Alfie] Login credentials: username="${bootstrapUsername}", password="${bootstrapPassword}"`);
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
