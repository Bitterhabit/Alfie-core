import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const USER_ID_PATTERN = /^[a-zA-Z0-9._:@-]{1,128}$/;
const NONCE_PATTERN = /^[a-zA-Z0-9_-]{16,128}$/;

function validSecret(secret) {
  return typeof secret === "string" && Buffer.byteLength(secret, "utf8") >= 32;
}

function signatureFor(secret, userId, timestamp, nonce, method, requestPath) {
  return createHmac("sha256", secret)
    .update(`${userId}\n${timestamp}\n${nonce}\n${method}\n${requestPath}`, "utf8")
    .digest("hex");
}

export function createSignedIdentityAuth({
  secret = process.env.ALFIE_CORE_IDENTITY_SECRET || "",
  providerId = "alfie-client",
  headerPrefix = "x-alfie-identity",
  headerNames = null,
  providerHeader = "x-alfie-identity-provider",
  now = () => Date.now(),
  maxSkewSeconds = 60
} = {}) {
  const usedNonces = new Map();
  const headerMap = headerNames || {
    userId: headerPrefix + "-user-id", timestamp: headerPrefix + "-timestamp",
    nonce: headerPrefix + "-nonce", method: headerPrefix + "-method",
    path: headerPrefix + "-path", signature: headerPrefix + "-signature"
  };

  function sign(userId, { method = "GET", path: requestPath = "/v1/whoami" } = {}) {
    if (!validSecret(secret)) throw new Error(`${providerId} identity signing is not configured.`);
    if (typeof userId !== "string" || !USER_ID_PATTERN.test(userId)) {
      throw new TypeError("A valid authenticated user ID is required.");
    }
    const requestMethod = String(method).toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(requestMethod) ||
        typeof requestPath !== "string" || !requestPath.startsWith("/v1/") ||
        requestPath.length > 2048 || /\s/.test(requestPath)) {
      throw new TypeError("A valid Core API method and path are required.");
    }
    const timestamp = String(Math.floor(now() / 1000));
    const nonce = randomUUID();
    return {
      [headerMap.userId]: userId,
      [headerMap.timestamp]: timestamp,
      [headerMap.nonce]: nonce,
      [headerMap.method]: requestMethod,
      [headerMap.path]: requestPath,
      [headerMap.signature]: signatureFor(secret, userId, timestamp, nonce, requestMethod, requestPath),
      ...(providerHeader ? { [providerHeader]: providerId } : {})
    };
  }

  function verify(requestHeaders = {}, { method, path: requestPath } = {}) {
    if (!validSecret(secret)) {
      throw Object.assign(new Error(`${providerId} identity verification is not configured.`), { status: 503 });
    }
    const userId = String(requestHeaders[headerMap.userId] || "");
    const timestamp = String(requestHeaders[headerMap.timestamp] || "");
    const nonce = String(requestHeaders[headerMap.nonce] || "");
    const signature = String(requestHeaders[headerMap.signature] || "");
    const signedMethod = String(requestHeaders[headerMap.method] || "");
    const signedPath = String(requestHeaders[headerMap.path] || "");
    if (!USER_ID_PATTERN.test(userId) || !/^\d{10}$/.test(timestamp) ||
        !NONCE_PATTERN.test(nonce) || !/^[a-f0-9]{64}$/i.test(signature) ||
        !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(signedMethod) ||
        signedMethod !== String(method || "").toUpperCase() || signedPath !== requestPath ||
        !signedPath.startsWith("/v1/") || signedPath.length > 2048 || /\s/.test(signedPath)) {
      throw Object.assign(new Error("A valid signed user identity assertion is required."), { status: 401 });
    }
    const issuedAt = Number(timestamp);
    const current = Math.floor(now() / 1000);
    if (!Number.isSafeInteger(issuedAt) || Math.abs(current - issuedAt) > maxSkewSeconds) {
      throw Object.assign(new Error("The signed user identity assertion has expired."), { status: 401 });
    }
    for (const [key, expiry] of usedNonces) {
      if (expiry <= current) usedNonces.delete(key);
    }
    const replayKey = `${userId}:${nonce}`;
    if (usedNonces.has(replayKey)) {
      throw Object.assign(new Error("The signed user identity assertion has already been used."), { status: 401 });
    }
    const expected = Buffer.from(signatureFor(secret, userId, timestamp, nonce, signedMethod, signedPath), "hex");
    const provided = Buffer.from(signature, "hex");
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      throw Object.assign(new Error("The signed user identity assertion is invalid."), { status: 401 });
    }
    usedNonces.set(replayKey, issuedAt + maxSkewSeconds);
    return { userId, providerId };
  }

  return { sign, verify, configured: validSecret(secret), providerId };
}


export function createIdentityAuthRegistry(providers = []) {
  const byId = new Map(providers.filter((provider) => provider?.providerId).map((provider) => [provider.providerId, provider]));
  function resolve(headers = {}) {
    const requested = String(headers["x-alfie-identity-provider"] || "");
    const providerId = requested || (headers["x-petrio-user-id"] ? "petrio" : "");
    const provider = byId.get(providerId);
    if (!provider) throw Object.assign(new Error("The identity provider is not registered."), { status: 401 });
    return provider;
  }
  return {
    configured: [...byId.values()].some((provider) => provider.configured),
    providerIds: [...byId.values()].filter((provider) => provider.configured).map((provider) => provider.providerId),
    sign(userId, { providerId, ...options } = {}) {
      const provider = byId.get(providerId);
      if (!provider) throw new Error("The requested identity provider is not registered.");
      const signed = provider.sign(userId, options);
      return { ...signed, "x-alfie-identity-provider": providerId };
    },
    verify(headers = {}, request = {}) {
      return resolve(headers).verify(headers, request);
    }
  };
}
