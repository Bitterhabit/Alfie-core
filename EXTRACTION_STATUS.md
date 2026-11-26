# Alfie Core status and 1.0 readiness

Last reviewed: 26 November 2026  
Repository: Bitterhabit/Alfie-core  
Current main commit at release-preparation start: 33d7307fc07a10140c6f629b4228f7188c244c5b  
Main versions: `@alfie/core 1.0.0`, `@alfie/interface 1.0.0` (PR #17 merged; deployment acceptance pending)

## Current state

Alfie Core is an independent Node.js service with a separate standalone web interface. Phases 1–6 in `docs/ROADMAP.md` describe the implemented capability set. The main branch includes the security and reliability hardening merged through PR #16 and the 1.0.0 release-preparation metadata from PR #17.

The service boundary remains deliberate:

- Core owns canonical identity, memory, projects, ideas, permissions, tool dispatch, approvals, audit history, watchers, jobs, vault backup/restore and continuity data.
- The standalone Interface authenticates browser users and calls Core from its backend. Browser code does not receive Core service or identity secrets.
- Models propose structured actions; the harness validates and executes registered tools. There is no arbitrary shell, `eval`, or `exec` path.
- Petrio is an optional client/integration, not a runtime dependency. Petrio-specific write integrations remain deferred until the Petrio side is ready.

## Merged hardening

The following changes are already on `main`:

- **PR #3 — Security hardening:** approval fingerprints, watcher input/timezone validation, safe local-note writes, recovery-code checks and other baseline controls.
- **PR #4 — Provider DNS pinning:** validated addresses are pinned for provider requests; redirects are rejected.
- **PR #5 — Fail-closed model/tool behaviour:** no scripted assistant fallback or image-generation bypass when a model provider is unavailable.
- **PR #6 — Job cancellation isolation:** user-scoped cancellation and protection against late results overwriting terminal states.
- **PR #7 — Vault restore semantics:** replace mode clears collections absent from the archive; merge mode preserves local-only/newer data.

## Merged 1.0 hardening

All changes below are merged into `main` and their PR checks passed:

- **PR #8 — Watcher serialization:** checks, metric ingestion, edits and deletion are serialized per watcher, with concurrency regression tests.
- **PR #9 — Transactional vault restore:** SQLite batch restore is transactional; JSON fallback compensates on failure; replace/merge semantics are covered.
- **PR #10 — Authentication throttling:** attempts are reserved before password/recovery verification, closing the concurrent bypass.
- **PR #11 — Peer token expiry:** expired tokens no longer consume active capacity; malformed expiry values fail closed.
- **PR #12 — Vault security documentation:** documents restore behaviour and safety boundaries.
- **PR #13 — Reproducible production installs:** CI and Core image use the committed lockfile with `npm ci`; all application source files receive syntax checks.
- **PR #14 — Peer CLI contract:** documents the Interface proxy target and tests authenticated peer forwarding.
- **PR #15 — Peer scope accuracy:** only implemented peer scopes are advertised.
- **PR #16 — Readiness gates:** this document distinguishes merged code from deployment acceptance.

Squash merge commits on main:
- PR #8: `33b94df3182890346cb55d408d980c24b464520a`
- PR #9: `36499e05abf1d9974d02b69bdcb8ffdf1dc271c5`
- PR #10: `d85121caf2c6b4d71c6a8c12ebb1b442e319cb59`
- PR #11: `87d31545803815493a618d444b83bb59b366e749`
- PR #12: `0b69f9e83d4abf16fc148350b89f1f3063e8da25`
- PR #13: `9635d7fa32c97d2ec341066a0690aadc9b508292`
- PR #14: `99eebc7a9db9ec5ff283e301790495f77d26b9be`
- PR #15: `aa8817e000b58fca1c3ae8b7735bd21d59fadb18`
- PR #16: `33d7307fc07a10140c6f629b4228f7188c244c5b`
- PR #17: `d7eed92930e28e9d6536945b7cde80dc67f3307a`

These are repository changes and CI results, not evidence of a live homelab deployment.

## Post-1.0 developer integration readiness (26 November 2026)

The GitHub project workflow has since been added to `main` and verified by CI:

- Separate `github:read`, `github:draft` and `github:write` capabilities. Read access covers repository metadata, a bounded file tree, bounded text-file reads, recent commits and open pull requests.
- Project writes create a new `alfie/*` branch and a draft pull request. The default branch is never used as Alfie's working branch; existing files require their expected blob SHA, changes are limited to 10 files / 80 KB, and credential/private-key paths are blocked.
- GitHub writes are approval-gated. The approval card exposes the exact proposed file contents before the user approves. The action is bound to its argument hash and tool fingerprint.
- `ALFIE_GITHUB_TOKEN` is configured only in the Core environment. Compose no longer injects the Core `.env` into the Interface container; the Interface receives an explicit environment allowlist.
- Latest verified main commit: `3a5eb6aa7bb187ad0d6dd9eaa4db2a0a9d74ba30`. GitHub Actions run [45878442069](https://github.com/Bitterhabit/Alfie-core/actions/runs/45878442069) completed successfully for both `test-and-build` and `installer-integration`.

This is code/CI verification only. No homelab deployment, live GitHub token, real repository write, or end-to-end user approval has been tested. Before daily-use acceptance, configure a fine-grained token server-side for the intended repository, grant `github:read` and `github:write` separately in Tools & Access, then test repository browsing and one harmless approval-gated draft PR in a dedicated test repository. Do not paste the token into chat.

## One-week daily-use acceptance sequence

Use this sequence only after deployment to the intended homelab and server-side provider/token configuration. Record pass/fail, the tested model/provider, and any issue for each day. These are planned checks, not claims that they have already passed.

1. **Day 1 — Core chat and reliability:** login, start a fresh conversation, continue an older one, test short and long prompts, restart the containers and confirm conversations persist. Check provider failure and recovery without scripted fallback.
2. **Day 2 — Memory and continuity:** create a memory, inspect its provenance, correct it, ask Alfie to use it in a new chat, and verify edit/forget behaviour. Confirm stale or unwanted details are not reintroduced.
3. **Day 3 — Permissions and approvals:** ask Alfie what access it has, grant and revoke one scope, test read-only access, and verify write actions remain pending until approved. Reject one action and verify it does not execute.
4. **Day 4 — GitHub read workflow:** configure a fine-grained token in Core only; grant `github:read`; inspect a repository tree, read a normal source file, list commits and open PRs. Confirm blocked secret paths fail closed.
5. **Day 5 — GitHub write workflow:** grant `github:write`; ask Alfie to propose a harmless change in a dedicated test repository. Review the exact file contents, branch, base and PR details in the approval card; reject one proposal, then approve a separate one and verify only a draft PR on an `alfie/*` branch is created.
6. **Day 6 — Interface and background work:** use the Interface on mobile and desktop, check session expiry/re-login, notifications/watchers and quiet hours, cancel a safe test job, and check that the UI remains usable after a Core restart.
7. **Day 7 — Recovery and review:** export an encrypted backup, restore it into a disposable target, verify the live data remains untouched, inspect audit receipts, and review performance stage timings against direct provider latency. Decide which issues block wider use.

Do not use a production repository for the first write test. Do not treat a CI pass as a substitute for these real homelab and user-facing checks.

## Remaining 1.0 release gates

1. **1.0.0 preparation is merged.** PR #17 aligns package and image versions and adds release notes. All CI steps, including both container smoke tests, passed on its tested code commit `aebafa4c51d20b024ed9fcc8bd987617ae83cda1`; the documentation-only status corrections were included before merge. The merge commit is `d7eed92930e28e9d6536945b7cde80dc67f3307a`.
2. **Keep the release untagged until acceptance.** Do not create the `v1.0.0` tag or call this a completed release until the homelab deployment, real provider, user workflows and restore rehearsal below have passed. PR #2 (`Stabilise Alfie 0.9.0 release`) remains an obsolete draft and is not a release candidate.
3. **Deploy to the target homelab.** Pull main at or beyond `d7eed92930e28e9d6536945b7cde80dc67f3307a`, rebuild both containers, verify volume ownership/persistence, confirm the Core has no published host port, and verify the Interface is reachable only through the intended trusted ingress.
4. **Validate ingress and browser security.** Confirm the public origin is HTTPS, secure cookies work, CSRF/origin checks pass, and proxy-header trust is enabled only when the Interface is reachable exclusively through a proxy that overwrites those headers.
5. **Exercise a real model provider.** Configure the intended local or remote provider and verify health, a normal chat, a longer response, provider-unavailable behaviour and recovery after the provider returns. CI uses test providers; it does not validate the user's actual model endpoint or model performance.
6. **Run the user-facing acceptance checks.** Verify first-run setup, login, password change/recovery, conversation persistence, memory create/edit/forget and provenance, permission grants, draft/approve/reject flows, job cancellation, watcher checks/quiet hours, peer token creation/revocation, and mobile navigation.
7. **Rehearse a real-data backup restore.** Export and verify an encrypted vault, restore into a disposable target, confirm replace/merge semantics, and verify the original live volume remains intact. Separately verify backups of the Core and Interface persistent volumes.
8. **Keep Petrio integration as a separate gate.** The standalone Alfie 1.0 release should work independently. Link to Petrio only when the Petrio adapter and its private network path are ready; do not make Alfie Core depend on an unfinished Petrio deployment.

## Deferred capabilities (not silently counted as 1.0 complete)

- Model download/pull and persistent in-Interface model selection are not implemented yet; configured provider endpoints and installed-model discovery are available.
- Petrio Mail tools and Calendar/Journal write tools are not enabled; they need their own trust, schema, approval and provenance review.
- Multi-user administration and migration of an already provisioned standalone workspace into a linked Petrio identity remain separate product decisions.

## Architecture boundary

- Node.js Core validates signed identity assertions and isolates data by canonical user ID; trusted clients map authenticated accounts to that shared ID.
- Node.js client applications authenticate users and call Core through the server-side SDK.
- Python workers are optional specialist services behind Node-owned adapters. They do not own memory, permissions, tools or approvals.
- No arbitrary shell or code execution is permitted inside Core.
- External/untrusted content cannot silently trigger writes or outbound network actions.
