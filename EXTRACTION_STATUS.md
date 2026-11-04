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
- Core-owned conversation, memory, permission, pending-action and audit persistence.
- One-time import paths for existing Petrio conversation and memory data.
- Revision-aware conversation snapshot writes and stale-snapshot merge/retry in the current Petrio chat client.
- Version-bound memory write approvals, duplicate detection and audit history.
- Python specialist-service boundary documented; Python workers are not part of the authoritative Core.
- Backup and restore procedure documented for the standalone Core volume.
- GitHub Actions validates the standalone Compose project, runs the full Node.js test suite and builds the Core image. Latest verified run: 107 tests passed, 0 failed; standalone Compose validation and both Core and interface image builds succeeded. The suite now includes an end-to-end test that bootstraps the standalone interface, links it to Petrio identity, and reads/writes the shared conversation and Garden data. Run: https://github.com/Bitterhabit/Alfie-core/actions/runs/41836217216.

## Remaining release gates

1. **Separate Git repository:** complete. The independent repository is Bitterhabit/Alfie-core. The extracted folder has been removed from the Petrio extraction branch; Petrio now retains only the client adapter and optional network overlay.
2. **Canonical identity and account linking:** Core-side linking is implemented and tested. Petrio can issue a one-time link code, and the standalone identity can consume it. The standalone interface now has a first-run bootstrap account, password login, hashed opaque sessions, CSRF protection, idle/absolute expiry and a Core account-link flow. It is a single-admin foundation; account recovery, password change and multi-user administration remain future work.
3. **Runtime validation:** CI now runs the full Node test suite (107 passing), validates the standalone Compose project, and builds both Core and interface images. Actual deployment, ingress, health/readiness against the live environment and end-to-end use with the configured model endpoint remain to be exercised.
4. **Migration rehearsal:** test a full Petrio conversation and memory import into a fresh Core volume, verify counts/provenance/relationships, test rollback and confirm Petrio's source data remains intact.
5. **Operational validation:** test backup and restore, permissions, volume ownership, restart behaviour and single-instance storage assumptions.
6. **Petrio network adapter:** connect Petrio to the independent Core private Docker network and verify read-only adapters before enabling the feature flag.
7. **Account lifecycle:** add password change/recovery and decide whether the single-admin interface should remain single-user or gain multi-user administration. Keep browser clients away from service and identity secrets.

## Architecture boundary

- Node.js Core validates signed identity assertions and isolates data by canonical user ID; trusted clients map authenticated accounts to that shared ID. Core owns conversations, memory, permissions, tool dispatch, approvals and audit.
- Node.js client applications authenticate users and call Core through the server-side SDK.
- Python workers are optional specialist services called through Node-owned adapters. They do not own memory, permissions, tools or approvals.
- Petrio is one integration/client, not a runtime dependency of the Core domain.
- Do not deploy or merge until the release gates above are validated and the user approves.
