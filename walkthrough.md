# Security Summary

During the full codebase review of Alfie Core, we audited outbound network fetch paths, prompt-injection isolation between personal memories and external web content, container/installer scripts, and dependency health.

### Findings Identified and Fixed

1. **Expanded private-network blocking for web research (`src/integrations/webResearch.mjs`)**
   - **Risk**: `web.fetch` previously checked IPv4 ranges and standard IPv6 local prefixes, but did not decode IPv4-mapped IPv6 addresses (such as `::ffff:169.254.169.254`, `::ffff:a9fe:a9fe`, or `::ffff:172.16.0.1`) or block cloud metadata endpoints on configured search URLs.
   - **Fix**: Reused the full IPv4/IPv6 private-address validator across all DNS-resolved targets, blocked cloud metadata hostnames on search endpoints, disabled automatic HTTP redirects (`redirect: "error"`) on search requests, and ensured TLS server-name verification stays explicit on pinned HTTPS connections.

2. **Redirect and metadata hardening on modular connectors (`src/integrations/modularConnectors.mjs`)**
   - **Risk**: GitHub and Proxmox connector calls followed HTTP redirects by default and did not reject embedded URL credentials or cloud metadata addresses on `ALFIE_PROXMOX_API_URL`.
   - **Fix**: Disabled automatic redirects (`redirect: "error"`) on connector requests and blocked embedded URL credentials and cloud metadata addresses on Proxmox URLs.

3. **Safe environment file updates in `install.sh`**
   - **Risk**: `write_env()` interpolated user-entered values directly into a `sed` replacement string, where characters like `&`, `|`, or `\` could corrupt `.env`.
   - **Fix**: Replaced `sed` substitution with an `awk` `ENVIRON`-based writer outputting to a `0600` temporary file before atomic rename.

4. **Prompt-injection isolation without false web-search blocks (`src/agent/contextAssembler.mjs`, `src/agent/loop.mjs`, `src/agent/toolDispatcher.mjs`)**
   - **Risk / Bug**: User-authored memories are wrapped in data tags to keep instructions separate from notes, which previously caused the agent loop to treat every turn with saved memories as externally untrusted and block `web.search`.
   - **Fix**: Separated genuine external untrusted sources (`external_untrusted` memories, external dashboard feeds, and prior external tool outputs) from user-authored memories so saved personal notes stay isolated in the prompt without blocking ordinary web searches, while external untrusted content continues to require explicit user approval before any outbound or state-changing action.

5. **Dependency & CI check**
   - `npm audit --omit=dev` reported **0 vulnerabilities**.
   - Fixed `.github/workflows/docker-publish.yml` to generate `SEARXNG_SECRET` before validating `compose.yaml`.

## PoC Verification

All security and functional fixes were verified with automated tests in `test/web-approval-and-history.test.mjs`:
- **IPv4-mapped IPv6 & metadata blocking**: Confirmed `web.fetch` rejects resolved addresses `::ffff:169.254.169.254`, `::ffff:a9fe:a9fe`, and `::ffff:172.16.0.5`, `web.search` passes `redirect: "error"`, and cloud metadata SearXNG URLs are rejected.
- **External untrusted turn gating**: Confirmed `AgentLoop` still forces `awaiting_user_approval` when an `external_untrusted` memory is present, while allowing `web.search` to run normally when only `user_authored` memories exist.
- **Approval persistence & chat continuation**: Confirmed `ConversationStore` persists `actionCard` state and updates it on `/v1/tools/approve` and `/v1/tools/reject`, and verified the UI continues the chat after approval.
