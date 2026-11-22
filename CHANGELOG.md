# Changelog

All notable changes to Alfie Core and the standalone Interface are recorded here.

## [1.0.0] — release candidate preparation

This section describes the intended 1.0.0 release scope. The version is prepared in source but is not yet tagged, published or verified on the target homelab.

### Security and reliability
- Harden approval fingerprints, watcher validation, safe local-note writes and recovery flows.
- Pin validated provider DNS addresses for each request and reject redirects.
- Fail closed when model providers are unavailable; remove scripted assistant fallbacks and image-generation bypasses.
- Isolate job cancellation by user and prevent late results overwriting terminal states.
- Serialize watcher checks, metric ingestion, edits and deletion per watcher.
- Restore vault documents as a batch: one SQLite transaction, with compensating rollback for JSON storage.
- Reserve authentication rate-limit attempts before expensive password/recovery verification.
- Reject malformed peer-token expiry values and exclude expired tokens from active-token capacity.

### Build and API
- Use the committed npm lockfile for reproducible CI and Core production dependency installation.
- Syntax-check all application source modules in CI.
- Clarify the peer CLI's Interface proxy endpoint and cover its bearer-token forwarding contract.
- Advertise only peer-token scopes implemented by the API.

### Product boundary
- Alfie Core remains an independent Node.js service with a separate standalone Interface.
- Model output remains a proposal; registered harness tools validate and execute actions.
- Writes and external side effects remain approval-gated.
- Petrio integration remains optional; unfinished mail/calendar write integrations and model download/management are not represented as completed 1.0 features.

### Release verification still required
- GitHub Actions passed on release-preparation commit `aebafa4c51d20b024ed9fcc8bd987617ae83cda1`, including tests, syntax checks, Compose validation, both image builds and container smoke tests.
- Pull/rebuild on the user's Proxmox host and verify container health, storage persistence and ingress.
- Test the configured real model provider and user-facing workflows.
- Rehearse encrypted vault backup/restore using a disposable target.
- Create the `v1.0.0` tag only after those checks pass.

## Earlier development

See the Git history and pull-request descriptions for the pre-1.0 development milestones.
