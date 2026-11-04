# Alfie Core extraction status

Last reviewed: 4 November 2026
Repository: Bitterhabit/Alfie-core (main)
Source extraction commit: 65cdacd
Current package: @alfie/core 0.3.0

## Completed in the extraction branch

- Independent Node.js Core service extracted into its own GitHub repository, with its own Dockerfile, Compose project, environment template and persistent named volume.
- No published host port; the service is intended to be reached by trusted backends on a private Docker network.
- Non-root container, read-only root filesystem, dropped capabilities, restricted temporary filesystem and a health check.
- Provider-neutral signed identity contract with simultaneous Petrio and standalone-interface identity providers using different secrets.
- One-time cross-client account linking: Petrio issues short-lived single-use codes; the standalone interface consumes them to map its local account to the same canonical Core user ID. Unlinked interface identities cannot access user data.
- Legacy Petrio identity headers remain compatible.
- Reusable server-side Node.js client SDK for the standalone interface and other trusted clients.
- Standalone interface with first-run single-admin bootstrap, password login, secure sessions, CSRF protection, password rotation with global session revocation and one-time Petrio account linking.
- Responsive chat workspace with recent conversation history, automatic conversation titles, mobile history controls, safe Markdown rendering and confirmed conversation deletion.
- Chat composer supports Auto, Light, Standard and Work routing modes; the selected mode is sent to the Core agent loop.
- Pending tool actions are surfaced inside the chat response with a direct handoff to the detailed Tools & access approval view.
- Standalone interface styling aligned to Petrio's purple pixel theme, with crisp square components, square status nodes and themed scrollbars.
- Garden UI with provenance labels, searchable memories, create/edit/forget actions and importance controls.
- Tools & access UI with one permission control per scope, pending-action approvals/rejections and recent audit history.
- Settings view for account-link status, model-provider health and Core capability status.
- Interface/Core end-to-end test proving the linked interface accesses the same canonical conversation and Garden records as Petrio.
- Login hardening: asynchronous scrypt password verification, constant-work unknown-user handling, bounded attempt tracking and explicit trusted-proxy configuration.
- Core-owned conversation, memory, permission, pending-action and audit persistence.
- One-time import paths for existing Petrio conversation and memory data.
- Revision-aware conversation snapshot writes and stale-snapshot merge/retry in the current Petrio chat client. Legacy conversation import now merges server-side and browser-localStorage history into existing Core history without overwriting it, tracks each source separately per user, and rejects oversized or malformed snapshots instead of truncating them.
- Version-bound memory write approvals, duplicate detection and audit history.
- Python specialist-service boundary documented; Python workers are not part of the authoritative Core.
- Backup and restore procedures documented for both Core data and standalone interface account volumes.
- GitHub Actions validates the standalone Compose project, runs the full Node.js test suite and builds the Core image. Latest verified run: 122 tests passed, 0 failed; standalone Compose validation, both image builds, live Core/interface health checks and backup/restore verification of both persistent volumes succeeded. The suite now includes an end-to-end test that bootstraps the standalone interface, links it to Petrio identity, and reads/writes the shared conversation and Garden data. Run: https://github.com/Bitterhabit/Alfie-core/actions/runs/41843763682.

## Remaining release gates

1. **Separate Git repository:** complete. The independent repository is Bitterhabit/Alfie-core. The extracted folder has been removed from the Petrio extraction branch; Petrio now retains only the client adapter and optional network overlay.
2. **Canonical identity and account linking:** Core-side linking is implemented and tested. Petrio can issue a one-time link code, and the standalone identity can consume it. The standalone interface now has a first-run bootstrap account, password login, hashed opaque sessions, CSRF protection, idle/absolute expiry and a Core account-link flow. It is a single-admin foundation; account recovery and multi-user administration remain future work.
3. **Runtime validation:** CI now runs the full Node test suite (120 passing), validates the standalone Compose project, builds both images and starts both containers to verify Core readiness and interface health. Actual deployment on the Petrio host, ingress configuration and end-to-end use with the configured model endpoint remain to be exercised. CI now rehearses backup/restore for both volumes using disposable data.
4. **Migration rehearsal:** test a full Petrio conversation and memory import into a fresh Core volume, verify counts/provenance/relationships, test rollback and confirm Petrio's source data remains intact.
5. **Operational validation:** test backup and restore, permissions, volume ownership, restart behaviour and single-instance storage assumptions.
6. **Petrio network adapter:** connect Petrio to the independent Core private Docker network and verify read-only adapters before enabling the feature flag.
7. **Account lifecycle:** password change is implemented with current-password verification and global session revocation. Recovery and multi-user administration remain future decisions. Keep browser clients away from service and identity secrets.

## Architecture boundary

- Node.js Core validates signed identity assertions and isolates data by canonical user ID; trusted clients map authenticated accounts to that shared ID. Core owns conversations, memory, permissions, tool dispatch, approvals and audit.
- Node.js client applications authenticate users and call Core through the server-side SDK.
- Python workers are optional specialist services called through Node-owned adapters. They do not own memory, permissions, tools or approvals.
- Petrio is one integration/client, not a runtime dependency of the Core domain.
- Do not deploy or merge until the release gates above are validated and the user approves.
