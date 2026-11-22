# Alfie Core status and 1.0 readiness

Last reviewed: 22 November 2026  
Repository: Bitterhabit/Alfie-core  
Current main commit: c83ea0bdd504acb8bfd1cafa0ee98b7c561d9b33  
Current package versions: `@alfie/core 0.3.0`, `alfie-interface 0.1.0`

## Current state

Alfie Core is an independent Node.js service with a separate standalone web interface. Phases 1–6 in `docs/ROADMAP.md` describe the implemented capability set. The main branch includes the security and reliability hardening merged through PR #7.

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

## Additional 1.0 hardening awaiting review

These pull requests are source changes only. They have not been merged or deployed. Check their current GitHub status before merging.

| PR | Change | Latest validation known at review |
|---|---|---|
| [#8](https://github.com/Bitterhabit/Alfie-core/pull/8) | Serialize watcher checks, metric ingestion, edits and deletion per watcher | CI passed, including regression tests for check/edit/delete races |
| [#9](https://github.com/Bitterhabit/Alfie-core/pull/9) | Transactional vault restore; SQLite batch rollback and JSON fallback compensation | CI passed, including SQLite/JSON restore tests, both image builds and container smoke test |
| [#10](https://github.com/Bitterhabit/Alfie-core/pull/10) | Reserve authentication attempts before password/recovery verification to close a concurrent rate-limit bypass | CI passed |
| [#11](https://github.com/Bitterhabit/Alfie-core/pull/11) | Expired peer tokens no longer consume active capacity; malformed expiry values fail closed | CI passed, including malformed-expiry tests, both image builds and container smoke test |
| [#12](https://github.com/Bitterhabit/Alfie-core/pull/12) | Correct security documentation for replace/merge vault semantics | CI passed |
| [#13](https://github.com/Bitterhabit/Alfie-core/pull/13) | Use `npm ci` with the committed lockfile in CI and the Core image; syntax-check all application source files | CI passed, including both image builds and container smoke test |
| [#14](https://github.com/Bitterhabit/Alfie-core/pull/14) | Clarify that the peer CLI targets the Interface proxy; test the peer proxy contract | CI passed |
| [#15](https://github.com/Bitterhabit/Alfie-core/pull/15) | Stop advertising the unimplemented `projects:read` peer scope | CI passed |

Do not treat a green PR check as proof of a live homelab deployment. The PRs above still need review/merge approval, followed by a fresh green run on the resulting main branch.

## Remaining 1.0 release gates

1. **Review and merge the hardening PRs.** Confirm the current diff and checks for PRs #8–#15. PR #2 (`Stabilise Alfie 0.9.0 release`) is an old draft based on an earlier main commit and is not a release candidate; do not merge it as a shortcut to versioning.
2. **Prepare a clean 1.0.0 release.** Align the Core package/service version, Interface package version, Compose image tags and lockfile. Add release notes and tag only after the approved hardening changes are on main.
3. **Deploy to the target homelab.** Pull the approved main commit, rebuild both containers, verify volume ownership/persistence, confirm the Core has no published host port, and verify the Interface is reachable only through the intended trusted ingress.
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
