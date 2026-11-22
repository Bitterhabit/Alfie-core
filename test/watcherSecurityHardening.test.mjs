import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import {
  DEFAULT_QUIET_HOURS_TIMEZONE,
  isPrivateOrReservedIp,
  validateWatcherUrl,
  resolveAndValidateWatcherTarget,
  pinnedHttpProbe,
  evaluateWatcher,
  validateTimeZone,
  isWithinQuietHours,
  routeAttentionTier
} from "../src/watchers/engine.mjs";
import { WatcherStore } from "../src/watchers/store.mjs";
import { readUserJsonDocument, writeUserJsonDocument } from "../src/storage/userJsonStore.mjs";

function generateSelfSignedCert(dir, cn = "good.example.test") {
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath,
    "-out", certPath,
    "-days", "1",
    "-subj", `/CN=${cn}`,
    "-addext", `subjectAltName=DNS:${cn}`
  ], { stdio: "ignore" });
  return { keyPath, certPath };
}

test("DNS validation allows public IPv4 and IPv6 and rejects private, loopback, mixed, unusual IPv6, and failed lookups", async () => {
  // Public IPv4
  const okV4 = await resolveAndValidateWatcherTarget("https://status.example.com/health", {
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }]
  });
  assert.equal(okV4.valid, true);
  assert.deepEqual(okV4.pinned, { address: "93.184.216.34", family: 4 });

  // Public IPv6 (IANA Global Unicast 2000::/3)
  const okV6 = await resolveAndValidateWatcherTarget("https://ipv6.example.com/health", {
    dnsLookup: async () => [{ address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }]
  });
  assert.equal(okV6.valid, true);
  assert.deepEqual(okV6.pinned, { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 });

  // Hostname resolving to private/reserved IPv4 or IPv6 (including IPv4-mapped & unusual forms)
  const blockedIps = [
    { address: "127.0.0.1", family: 4 },
    { address: "10.0.0.5", family: 4 },
    { address: "172.16.0.1", family: 4 },
    { address: "192.168.1.10", family: 4 },
    { address: "169.254.169.254", family: 4 },
    { address: "100.100.100.200", family: 4 },
    { address: "0.0.0.0", family: 4 },
    { address: "224.0.0.1", family: 4 },
    { address: "198.18.0.1", family: 4 },
    { address: "::1", family: 6 },
    { address: "::", family: 6 },
    { address: "fe80::1", family: 6 },
    { address: "fc00::1", family: 6 },
    { address: "fd12:3456:789a::1", family: 6 },
    { address: "ff02::1", family: 6 },
    { address: "::ffff:127.0.0.1", family: 6 },
    { address: "::ffff:7f00:1", family: 6 },
    { address: "0:0:0:0:0:ffff:a9fe:a9fe", family: 6 },
    { address: "0000:0000:0000:0000:0000:ffff:10.0.0.1", family: 6 },
    { address: "64:ff9b::10.0.0.1", family: 6 },
    { address: "2001:db8::1", family: 6 },
    { address: "2002:7f00:0001::1", family: 6 },
    { address: "fe80::1%eth0", family: 6 }
  ];

  for (const record of blockedIps) {
    assert.equal(isPrivateOrReservedIp(record.address), true, `Expected ${record.address} to be classified non-public`);
    const res = await resolveAndValidateWatcherTarget("https://rebind.example.com/health", {
      dnsLookup: async () => [record]
    });
    assert.equal(res.valid, false, `Expected DNS resolution to ${record.address} to be rejected`);
  }

  // Mixed public + private IPv4/IPv6 results MUST be rejected as a whole
  const mixedV4 = await resolveAndValidateWatcherTarget("https://dual.example.com/health", {
    dnsLookup: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.2", family: 4 }
    ]
  });
  assert.equal(mixedV4.valid, false);
  assert.equal(mixedV4.code, "WATCHER_DNS_BLOCKED");

  const mixedV6 = await resolveAndValidateWatcherTarget("https://dual.example.com/health", {
    dnsLookup: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "::1", family: 6 }
    ]
  });
  assert.equal(mixedV6.valid, false);
  assert.equal(mixedV6.code, "WATCHER_DNS_BLOCKED");

  // DNS lookup failure and empty results fail closed
  const dnsErr = await resolveAndValidateWatcherTarget("https://missing.example.com/health", {
    dnsLookup: async () => {
      const err = new Error("ENOTFOUND");
      err.code = "ENOTFOUND";
      throw err;
    }
  });
  assert.equal(dnsErr.valid, false);
  assert.equal(dnsErr.code, "WATCHER_DNS_FAILED");

  const dnsEmpty = await resolveAndValidateWatcherTarget("https://empty.example.com/health", {
    dnsLookup: async () => []
  });
  assert.equal(dnsEmpty.valid, false);
  assert.equal(dnsEmpty.code, "WATCHER_DNS_EMPTY");
});

test("URL validation regression coverage: trailing dots, Docker single-label hosts, hex/decimal IPv4 literals, and credentials", () => {
  const blocked = [
    "http://localhost./health",
    "http://metadata.google.internal./computeMetadata/v1/",
    "http://host.docker.internal:8080/",
    "http://redis:6379/",
    "http://alfie-core:3001/health",
    "http://0x7f000001/admin",
    "http://2130706433/admin",
    "http://0177.0.0.1/admin",
    "http://service.local/health",
    "http://service.home.arpa/health",
    "https://user:pass@example.com/health",
    "https://example.com/health#section",
    "ftp://example.com/file"
  ];
  for (const url of blocked) {
    const check = validateWatcherUrl(url);
    assert.equal(check.valid, false, `Expected ${url} to be blocked`);
  }
});

test("DNS rebinding prevention: DNS is queried once and connection lookup is strictly pinned to the validated IP", async () => {
  let dnsCalls = 0;
  // Attacker DNS returns public IP first, then rebinds to 127.0.0.1 on any subsequent query
  const rebindingDnsLookup = async () => {
    dnsCalls += 1;
    if (dnsCalls === 1) return [{ address: "93.184.216.34", family: 4 }];
    return [{ address: "127.0.0.1", family: 4 }];
  };

  let capturedOptions = null;
  let lookupSingleResult = null;
  let lookupAllResult = null;

  const mockRequest = (options, onResponse) => {
    capturedOptions = options;
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => {
      // Simulate Node net.connect calling options.lookup both with and without { all: true }
      options.lookup(options.hostname, { family: 0 }, (err, address, family) => {
        assert.ifError(err);
        lookupSingleResult = { address, family };
        options.lookup(options.hostname, { all: true }, (err2, list) => {
          assert.ifError(err2);
          lookupAllResult = list;
          const res = new EventEmitter();
          res.statusCode = 200;
          res.headers = {};
          res.destroy = () => {};
          onResponse(res);
          res.emit("data", Buffer.from("ok"));
          res.emit("end");
        });
      });
    };
    return req;
  };

  const result = await evaluateWatcher(
    { kind: "http_probe", config: { url: "https://rebind-target.example.com/health", expectedStatus: 200, maxLatencyMs: 3000 } },
    { dnsLookup: rebindingDnsLookup, requestImpl: mockRequest }
  );

  assert.equal(result.severity, "ok");
  assert.equal(result.trust, "external_untrusted");
  assert.equal(dnsCalls, 1, "DNS MUST be queried exactly once; no second lookup allowed");
  assert.deepEqual(lookupSingleResult, { address: "93.184.216.34", family: 4 });
  assert.deepEqual(lookupAllResult, [{ address: "93.184.216.34", family: 4 }]);
  assert.equal(capturedOptions.servername, "rebind-target.example.com");
  assert.equal(capturedOptions.rejectUnauthorized, true);
  assert.equal(capturedOptions.agent, false);
  assert.equal(capturedOptions.headers.host, "rebind-target.example.com");
  assert.equal(result.metrics.pinnedAddress, "93.184.216.34");
});

test("HTTP watcher rejects 3xx redirects and does not follow them", async () => {
  // 1. Live local HTTP server returning 302 redirect to metadata IP
  let targetHit = false;
  const server = http.createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
      res.end("redirecting");
      return;
    }
    targetHit = true;
    res.writeHead(200);
    res.end("should never follow");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    await assert.rejects(
      () => pinnedHttpProbe(new URL(`http://status.example.test:${port}/redirect`), { address: "127.0.0.1", family: 4 }, { timeoutMs: 2000 }),
      (err) => err.code === "WATCHER_REDIRECT_BLOCKED" && /Redirects are not allowed/i.test(err.message)
    );
    assert.equal(targetHit, false);

    // 2. Also verify through evaluateWatcher with mocked 307 response
    const mockRedirectReq = (_opts, onResponse) => {
      const req = new EventEmitter();
      req.destroy = () => {};
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 307;
        res.headers = { location: "http://127.0.0.1/secret" };
        res.destroy = () => {};
        onResponse(res);
      };
      return req;
    };

    const evaluated = await evaluateWatcher(
      { kind: "http_probe", config: { url: "https://redirect.example.com/health", expectedStatus: 200 } },
      { dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }], requestImpl: mockRedirectReq }
    );
    assert.equal(evaluated.severity, "alert");
    assert.equal(evaluated.metrics.blocked, true);
    assert.equal(evaluated.metrics.code, "WATCHER_REDIRECT_BLOCKED");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("HTTPS pinned probe preserves TLS SNI and enforces strict certificate & hostname verification", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-tls-probe-"));
  const { keyPath, certPath } = generateSelfSignedCert(dir, "good.example.test");
  const [key, cert] = await Promise.all([fs.readFile(keyPath), fs.readFile(certPath)]);

  let observedSni = null;
  let observedHost = null;
  const server = https.createServer({ key, cert }, (req, res) => {
    observedSni = req.socket.servername || null;
    observedHost = req.headers.host || null;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("tls-ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    // 1. Matching hostname + trusted CA succeeds and sends SNI + Host header while connecting to pinned IP
    const okRes = await pinnedHttpProbe(
      new URL(`https://good.example.test:${port}/health`),
      { address: "127.0.0.1", family: 4 },
      { timeoutMs: 3000, tlsOptions: { ca: cert } }
    );
    assert.equal(okRes.status, 200);
    assert.equal(observedSni, "good.example.test");
    assert.equal(observedHost, `good.example.test:${port}`);

    // 2. Mismatched hostname MUST fail TLS certificate hostname verification even with trusted CA
    await assert.rejects(
      () => pinnedHttpProbe(
        new URL(`https://wrong.example.test:${port}/health`),
        { address: "127.0.0.1", family: 4 },
        { timeoutMs: 3000, tlsOptions: { ca: cert } }
      ),
      (err) => err.code === "ERR_TLS_CERT_ALTNAME_INVALID" || /altname|certificate|hostname/i.test(err.message)
    );

    // 3. Untrusted self-signed cert MUST fail (rejectUnauthorized: true cannot be bypassed)
    await assert.rejects(
      () => pinnedHttpProbe(
        new URL(`https://good.example.test:${port}/health`),
        { address: "127.0.0.1", family: 4 },
        { timeoutMs: 3000, tlsOptions: { rejectUnauthorized: false } }
      ),
      (err) => /self-signed|unable to verify/i.test(err.message) || err.code === "DEPTH_ZERO_SELF_SIGNED_CERT"
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Pinned HTTP probe enforces request timeout and bounded response size", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/hang") {
      // Never respond
      return;
    }
    if (req.url === "/large") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.alloc(200 * 1024, 0x41));
      return;
    }
    res.writeHead(200);
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    await assert.rejects(
      () => pinnedHttpProbe(new URL(`http://slow.example.test:${port}/hang`), { address: "127.0.0.1", family: 4 }, { timeoutMs: 150 }),
      (err) => err.code === "WATCHER_TIMEOUT" || err.name === "AbortError"
    );

    const bounded = await pinnedHttpProbe(
      new URL(`http://big.example.test:${port}/large`),
      { address: "127.0.0.1", family: 4 },
      { timeoutMs: 2000, maxBytes: 4096 }
    );
    assert.equal(bounded.status, 200);
    assert.equal(bounded.truncated, true);
    assert.equal(bounded.bytesRead, 4096);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("WatcherStore enforces strict boolean validation for enabled and quietHours.enabled", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-watcher-bool-"));
  const store = new WatcherStore({ dataDirectory: dir });

  try {
    // Reject non-boolean enabled values on create
    for (const bad of ["false", "true", 0, 1, null]) {
      await assert.rejects(
        () => store.create("alice", { name: "Bad bool", kind: "vram_threshold", enabled: bad }),
        (err) => err.status === 400
      );
      await assert.rejects(
        () => store.create("alice", { name: "Bad qh bool", kind: "vram_threshold", quietHours: { enabled: bad } }),
        (err) => err.status === 400
      );
    }

    const created = await store.create("alice", {
      name: "Strict Bool Watcher",
      kind: "vram_threshold",
      enabled: true,
      quietHours: { enabled: false, start: "22:00", end: "07:00", timezone: "Europe/London" }
    });
    assert.equal(created.enabled, true);

    // Reject non-boolean values on update (especially string "false" which Boolean("false") previously turned into true!)
    for (const bad of ["false", "true", 0, 1, null]) {
      await assert.rejects(
        () => store.update("alice", created.id, { enabled: bad }),
        (err) => err.status === 400
      );
      await assert.rejects(
        () => store.update("alice", created.id, { quietHours: { enabled: bad } }),
        (err) => err.status === 400
      );
    }

    // Valid booleans succeed
    const disabled = await store.update("alice", created.id, { enabled: false, quietHours: { enabled: true } });
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.quietHours.enabled, true);
    assert.equal(disabled.quietHours.timezone, "Europe/London"); // Preserved on partial quietHours update

    const reenabled = await store.update("alice", created.id, { enabled: true });
    assert.equal(reenabled.enabled, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Timezone-aware quiet hours handle UTC, Europe/London winter & summer, DST transitions, overnight boundaries, invalid timezones, and urgent bypass", async () => {
  // 1. Default timezone is explicitly UTC
  assert.equal(DEFAULT_QUIET_HOURS_TIMEZONE, "UTC");
  assert.equal(validateTimeZone("UTC").valid, true);
  assert.equal(validateTimeZone("Europe/London").valid, true);
  assert.equal(validateTimeZone("America/New_York").valid, true);

  // Invalid timezones rejected
  for (const badTz of ["Mars/Olympus", "BST", "UTC+1", "+01:00", "", "   ", null, 42]) {
    assert.equal(validateTimeZone(badTz).valid, false, `Expected timezone ${JSON.stringify(badTz)} to be invalid`);
  }

  // 2. UTC overnight quiet hours (22:00 - 07:00) + exact start/end boundaries
  const utcQh = { enabled: true, start: "22:00", end: "07:00", timezone: "UTC" };
  assert.equal(isWithinQuietHours(utcQh, new Date("2026-01-15T21:59:00.000Z")), false); // 1 min before start
  assert.equal(isWithinQuietHours(utcQh, new Date("2026-01-15T22:00:00.000Z")), true);  // exact start (inclusive)
  assert.equal(isWithinQuietHours(utcQh, new Date("2026-01-16T06:59:00.000Z")), true);  // 1 min before end
  assert.equal(isWithinQuietHours(utcQh, new Date("2026-01-16T07:00:00.000Z")), false); // exact end (exclusive)

  // 3. Europe/London winter (GMT = UTC+0, Jan 15)
  const londonQh = { enabled: true, start: "22:00", end: "07:00", timezone: "Europe/London" };
  assert.equal(isWithinQuietHours(londonQh, new Date("2026-01-15T21:30:00.000Z")), false); // 21:30 GMT
  assert.equal(isWithinQuietHours(londonQh, new Date("2026-01-15T22:30:00.000Z")), true);  // 22:30 GMT
  assert.equal(isWithinQuietHours(londonQh, new Date("2026-01-16T06:30:00.000Z")), true);  // 06:30 GMT
  assert.equal(isWithinQuietHours(londonQh, new Date("2026-01-16T07:00:00.000Z")), false); // 07:00 GMT

  // 4. Europe/London summer (BST = UTC+1, Jul 15)
  assert.equal(isWithinQuietHours(londonQh, new Date("2026-07-15T20:59:00.000Z")), false); // 21:59 BST
  assert.equal(isWithinQuietHours(londonQh, new Date("2026-07-15T21:00:00.000Z")), true);  // 22:00 BST!
  assert.equal(isWithinQuietHours(londonQh, new Date("2026-07-15T21:30:00.000Z")), true);  // 22:30 BST!
  assert.equal(isWithinQuietHours(londonQh, new Date("2026-07-16T05:59:00.000Z")), true);  // 06:59 BST
  assert.equal(isWithinQuietHours(londonQh, new Date("2026-07-16T06:00:00.000Z")), false); // 07:00 BST!

  // 5. DST spring-forward transition in Europe/London (2026-03-29: 01:00 GMT -> 02:00 BST)
  // Quiet window 01:30 -> 03:00 local:
  const springQh = { enabled: true, start: "01:30", end: "03:00", timezone: "Europe/London" };
  assert.equal(isWithinQuietHours(springQh, new Date("2026-03-29T00:59:00.000Z")), false); // 00:59 GMT
  assert.equal(isWithinQuietHours(springQh, new Date("2026-03-29T01:00:00.000Z")), true);  // 02:00 BST (inside 01:30-03:00)
  assert.equal(isWithinQuietHours(springQh, new Date("2026-03-29T01:59:00.000Z")), true);  // 02:59 BST
  assert.equal(isWithinQuietHours(springQh, new Date("2026-03-29T02:00:00.000Z")), false); // 03:00 BST (end boundary)

  // 6. DST fall-back transition in Europe/London (2026-10-25: 01:59 BST -> 01:00 GMT)
  // Quiet window 22:00 -> 07:00 local: at 06:30 UTC it is 06:30 GMT (still quiet), at 07:00 UTC it is 07:00 GMT (ended)
  assert.equal(isWithinQuietHours(londonQh, new Date("2026-10-25T00:30:00.000Z")), true);  // 01:30 BST
  assert.equal(isWithinQuietHours(londonQh, new Date("2026-10-25T01:30:00.000Z")), true);  // 01:30 GMT (repeated hour)
  assert.equal(isWithinQuietHours(londonQh, new Date("2026-10-25T06:30:00.000Z")), true);  // 06:30 GMT (not 07:30!)
  assert.equal(isWithinQuietHours(londonQh, new Date("2026-10-25T07:00:00.000Z")), false); // 07:00 GMT

  // 7. Invalid timezone passed directly to isWithinQuietHours fails safe (returns false without throwing)
  assert.equal(isWithinQuietHours({ enabled: true, start: "22:00", end: "07:00", timezone: "Bad/Zone" }, new Date("2026-07-15T23:00:00.000Z")), false);

  // 8. routeAttentionTier downgrades notify -> digest during BST quiet hours, while urgent ALWAYS breaks through
  const bstNightMs = Date.parse("2026-07-15T21:15:00.000Z"); // 22:15 BST
  const notifyRouted = routeAttentionTier({ baseTier: "notify", severity: "alert", quietHours: londonQh, nowMs: bstNightMs });
  assert.equal(notifyRouted.tier, "digest");
  assert.equal(notifyRouted.reason, "quiet_hours_downgrade");

  const urgentRouted = routeAttentionTier({ baseTier: "urgent", severity: "alert", quietHours: londonQh, nowMs: bstNightMs });
  assert.equal(urgentRouted.tier, "urgent");

  // 9. WatcherStore validates timezone, persists it, rejects invalid timezones, and preserves legacy records without timezone
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-watcher-tz-"));
  const store = new WatcherStore({ dataDirectory: dir });
  try {
    await assert.rejects(
      () => store.create("alice", {
        name: "Invalid TZ",
        kind: "vram_threshold",
        quietHours: { enabled: true, start: "22:00", end: "07:00", timezone: "Invalid/Zone" }
      }),
      (err) => err.status === 400 && err.code === "INVALID_TIMEZONE"
    );

    const wDefault = await store.create("alice", { name: "Default TZ", kind: "vram_threshold" });
    assert.equal(wDefault.quietHours.timezone, "UTC");

    const wLondon = await store.create("alice", {
      name: "London Watcher",
      kind: "vram_threshold",
      quietHours: { enabled: true, start: "22:00", end: "07:00", timezone: "Europe/London" }
    });
    assert.equal(wLondon.quietHours.timezone, "Europe/London");

    // Simulate a legacy watcher record stored before quietHours.timezone existed
    const parsed = await readUserJsonDocument(dir, "alice", "watchers.json");
    delete parsed.watchers[0].quietHours.timezone;
    await writeUserJsonDocument(dir, "alice", "watchers.json", parsed);

    const loaded = await store.get("alice", wDefault.id);
    assert.equal(loaded.quietHours.timezone, "UTC");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
