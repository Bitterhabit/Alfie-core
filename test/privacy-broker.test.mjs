import test from "node:test";
import assert from "node:assert/strict";
import { rehydrateFromCloud, sanitizeForCloud, sanitizeMessagesForCloud } from "../src/privacy/broker.mjs";

test("cloud airlock redacts credentials, private network details, local hosts, and local paths", () => {
  const token = "ghp_123456789012345678901234567890";
  const source = `Use ${token} at 192.168.1.149 on thor.local from /opt/alfie/.env and /etc/alfie/config.json.`;
  const result = sanitizeForCloud(source);

  assert.equal(result.safeToSend, true);
  assert.doesNotMatch(result.sanitizedText, /ghp_123456789012345678901234567890/);
  assert.doesNotMatch(result.sanitizedText, /192\.168\.1\.149/);
  assert.doesNotMatch(result.sanitizedText, /thor\.local/);
  assert.doesNotMatch(result.sanitizedText, /\/opt\/alfie/);
  assert.doesNotMatch(result.sanitizedText, /\/etc\/alfie/);
  assert.ok(result.categoryCounts.secret >= 1);
  assert.ok(result.categoryCounts.private_ip >= 1);
  assert.ok(result.categoryCounts.local_host >= 1);
  assert.ok(result.categoryCounts.local_path >= 2);
  assert.equal(rehydrateFromCloud(result.sanitizedText, result.tokenMap), source);
});

test("cloud airlock shares one collision-free token map across every conversation message", () => {
  const tokenA = "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const tokenB = "ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const result = sanitizeMessagesForCloud([
    { role: "user", content: `First ${tokenA} and 192.168.1.10` },
    { role: "assistant", content: `Repeat ${tokenA}; also ${tokenB} and 192.168.1.11` }
  ]);

  assert.equal(result.manifest.airlockActive, true);
  assert.equal(result.manifest.redactedCount, 4);
  assert.doesNotMatch(JSON.stringify(result.messages), /ghp_[AB]+/);
  assert.doesNotMatch(JSON.stringify(result.messages), /192\.168\.1\./);
  const firstSecretToken = result.messages[0].content.match(/\[SECRET_\d+\]/)?.[0];
  const secondSecretTokens = result.messages[1].content.match(/\[SECRET_\d+\]/g) || [];
  assert.equal(firstSecretToken, secondSecretTokens[0], "The same value must map to the same token across messages");
  assert.notEqual(firstSecretToken, secondSecretTokens[1]);
  const roundTrip = result.messages.map((message) => rehydrateFromCloud(message.content, result.tokenMap));
  assert.match(roundTrip[0], new RegExp(tokenA));
  assert.match(roundTrip[1], new RegExp(tokenA));
  assert.match(roundTrip[1], new RegExp(tokenB));
  assert.match(roundTrip[0], /192\.168\.1\.10/);
  assert.match(roundTrip[1], /192\.168\.1\.11/);
});

test("custom private terms are matched as whole words and restored locally", () => {
  const result = sanitizeForCloud("Petrio is separate from PetrioHouse.", { customTerms: ["Petrio"] });
  assert.equal(result.sanitizedText, "[PRIVATE_TERM_1] is separate from PetrioHouse.");
  assert.equal(rehydrateFromCloud(result.sanitizedText, result.tokenMap), "Petrio is separate from PetrioHouse.");
});
