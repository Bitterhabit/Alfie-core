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
- Legacy Petrio identity headers remain compatible.
- Reusable server-side Node.js client SDK for the standalone interface and other trusted clients.
- Core-owned conversation, memory, permission, pending-action and audit persistence.
- One-time import paths for existing Petrio conversation and memory data.
- Revision-aware conversation snapshot writes and stale-snapshot merge/retry in the current Petrio chat client.
- Version-bound memory write approvals, duplicate detection and audit history.
- Python specialist-service boundary documented; Python workers are not part of the authoritative Core.
- Backup and restore procedure documented for the standalone Core volume.
- GitHub Actions validates the standalone Compose project, runs the full Node.js test suite and builds the Core image. Latest run: 94 tests passed, 0 failed; Compose validation and image build succeeded.

## Remaining release gates

1. **Separate Git repository:** complete. The independent repository is Bitterhabit/Alfie-core. The extracted folder has been removed from the Petrio extraction branch; Petrio now retains only the client adapter and optional network overlay.
2. **Canonical identity and account linking:** each trusted client must authenticate its own user session and map that person to the same stable Core user ID. The HMAC identity assertion is not a login system.
3. **Runtime validation:** install dependencies, run the full Node test suite, validate both Compose definitions with Docker Compose, build the image and exercise health/readiness and API flows. Tests have been added but have not been run in this environment.
4. **Migration rehearsal:** test a full Petrio conversation and memory import into a fresh Core volume, verify counts/provenance/relationships, test rollback and confirm Petrio's source data remains intact.
5. **Operational validation:** test backup and restore, permissions, volume ownership, restart behaviour and single-instance storage assumptions.
6. **Petrio network adapter:** connect Petrio to the independent Core private Docker network and verify read-only adapters before enabling the feature flag.
7. **Standalone authentication:** choose and implement the independent interface's user-session mechanism and canonical account mapping. Keep browser clients away from service and identity secrets.

## Architecture boundary

- Node.js Core validates signed identity assertions and isolates data by canonical user ID; trusted clients map authenticated accounts to that shared ID. Core owns conversations, memory, permissions, tool dispatch, approvals and audit.
- Node.js client applications authenticate users and call Core through the server-side SDK.
- Python workers are optional specialist services called through Node-owned adapters. They do not own memory, permissions, tools or approvals.
- Petrio is one integration/client, not a runtime dependency of the Core domain.
- Do not deploy or merge until the release gates above are validated and the user approves.
