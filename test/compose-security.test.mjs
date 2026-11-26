import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("GitHub and other integration credentials are not passed into the interface container", async () => {
  const compose = await fs.readFile(new URL("../compose.yaml", import.meta.url), "utf8");
  const coreStart = compose.indexOf("  alfie-core:");
  const interfaceStart = compose.indexOf("  alfie-interface:");
  const searxStart = compose.indexOf("  searxng:");
  assert.ok(coreStart >= 0 && interfaceStart > coreStart && searxStart > interfaceStart);
  const core = compose.slice(coreStart, interfaceStart);
  const ui = compose.slice(interfaceStart, searxStart);
  assert.match(core, /env_file:\s+- \.env/);
  assert.doesNotMatch(ui, /env_file:/);
  assert.doesNotMatch(ui, /ALFIE_GITHUB_TOKEN|ALFIE_PROXMOX_API_TOKEN|ALFIE_BRAVE_SEARCH_API_KEY/);
  for (const key of ["ALFIE_CORE_SERVICE_TOKEN", "ALFIE_CORE_STANDALONE_IDENTITY_SECRET", "ALFIE_UI_BOOTSTRAP_USERNAME", "ALFIE_UI_BOOTSTRAP_PASSWORD"]) {
    assert.match(ui, new RegExp(key));
  }
});
