# Alfie Core

Independent service foundation for Alfie, developed separately from Petrio's existing application and chat UI.

## Current status

The independent service currently provides:

- Public liveness at `GET /health` and readiness at `GET /ready`; readiness requires the service token and at least one configured trusted identity provider.
- Bearer-token authentication for the versioned API.
- Short-lived, request-bound HMAC-signed user identity assertions with expiry, request binding and replay protection. A provider registry accepts Petrio and standalone UI backend identities simultaneously. Petrio retains its legacy header format; the standalone backend uses a separate HMAC secret and the x-alfie-identity-* headers.
- Per-user persistent conversation history with isolated storage, atomic writes and restrictive file permissions; full snapshots preserve chat metadata and approval cards, and a one-time import migrates existing Petrio history without deleting the source copy.
- Per-user memory CRUD/search, importance ranking, relationship management and legacy Petrio import, with separate `user-seeded`, `alfie-created` and `integration-imported` provenance. Legacy source/type/tags/importance/metadata/timestamps/relationships are retained.
- Each agent turn retrieves up to six relevant memories using ranked term matching. Origin/source labels are retained in context, and memory text is wrapped as untrusted data so stored content cannot override system instructions.
- Registered memory tools let Alfie search and read memories with `memory:read`, and propose saving, editing or forgetting memories with `memory:write`. New memories explicitly requested by the user are stored as `user-seeded`; reads return untrusted-wrapped content, and all memory writes create pending actions requiring explicit dashboard approval. Memory provenance is immutable through these tools.
- Per-user audit history records requested, approved, completed, rejected and failed tool actions. It stores tool IDs and argument hashes, not raw memory text or action arguments. Petrio's Alfie tool-access panel displays the latest 20 events.
- When Core is enabled, Petrio's shared Memory Engine/Garden adapter now uses Core as its authoritative store. Before the first Core memory operation it imports the complete legacy memory snapshot (up to 2,000 entries); truncated snapshots are rejected rather than partially imported. If Core is explicitly disabled, the adapter continues using the legacy Petrio API. If Core is enabled but unavailable, it fails closed rather than silently splitting memory writes across two stores.
- A provider registry for Ollama and OpenAI-compatible endpoints.
- Provider health inspection, short-lived health caching, mode/priority selection and automatic fallback.
- Non-streaming model chat at `POST /v1/chat` and NDJSON streaming at `POST /v1/chat/stream`.
- Provider failover both during health-based selection and when a provider fails before a response is established.
- API-key-safe provider configuration output at `GET /v1/providers`.

The production agent harness is implemented in Node.js:

- **Model proposes, harness executes:** model responses must be strict JSON proposals; the model has no shell, `eval`, or `exec` capability.
- **Risk tiers:** every tool declares `read`, `draft`, or `write`, plus explicit `internal`/`external` data trust, network-access and external-side-effect classifications. The dispatcher enforces the user's granted scope.
- **Draft/commit:** `read` tools can run immediately when authorised; local `draft` tools can prepare drafts; `write` and external-side-effect tools create persistent pending actions. Read-only external retrieval can run automatically when the turn is trusted, but its output is wrapped as untrusted data; if untrusted content is already in the turn, network tools are held for approval. Only an explicit dashboard approval commits the exact stored action. Reject is supported and direct execution is disabled.
- **Untrusted content:** results from external tools are wrapped in `<untrusted_data>` envelopes before they enter conversation history. External side effects always require approval; untrusted context also blocks draft/write and external-network auto-execution.
- **Validation and deduplication:** Ajv validates registered JSON Schemas, including ISO date formats. Validation errors are returned to the model as structured observations. Identical consecutive tool calls are blocked.
- **Hard budgets:** at most four model steps per request, a 30-second turn deadline, and a 2,000-character cap for individual strings and total structured tool output.
- **Dynamic context:** a `ContextAssembler` adds local system time/day, allowlisted compact dashboard state, only relevant user-authorised tool schemas, and the last eight conversation turns.

The Petrio adapter currently registers read-only Calendar and Journal tools (including selected Journal entry reads) when its private service connection is configured. Alfie Core also registers scoped memory search/read tools and approval-gated memory update/forget tools. Mail tools and Calendar/Journal write tools are not yet registered; they must declare trust, risk, strict schemas and output provenance before being enabled. Automatic memory capture remains disabled.

## Provider configuration

Set `ALFIE_CORE_PROVIDERS_JSON` in the Core container environment. Example:

```json
{
  "mode": "auto",
  "healthIntervalSeconds": 30,
  "endpoints": [
    {
      "id": "thor-local",
      "name": "Thor local Ollama",
      "provider": "ollama",
      "baseUrl": "http://thor:11434",
      "model": "qwen2.5:14b",
      "mode": "standard",
      "priority": 80,
      "enabled": true
    }
  ]
}
```

The value is server-side configuration; API keys are never returned by `GET /v1/providers`. Do not put credentials in endpoint URLs. Use private network addresses for model endpoints and keep the Core service off the public internet.

## API

All `/v1/*` routes require `Authorization: Bearer <ALFIE_CORE_SERVICE_TOKEN>`. All user-scoped chat, conversation, memory, tool and permission routes additionally require a one-time identity signature bound to the exact HTTP method and path.

- `GET /v1/status` — implemented/planned capabilities.
- `GET /v1/whoami` — validates the signed identity and reports provider ID, canonical user ID and whether the interface account is linked.
- `POST /v1/identity/link-codes` — Petrio-only; creates a five-minute, single-use account-link code for the signed-in Petrio user.
- `POST /v1/identity/link` — standalone-interface-only; consumes a code and maps that local interface identity to the same canonical Core user ID.
- `POST /v1/identity/unlink` — lets a standalone interface identity remove its own link.
- `GET /v1/conversations/database` and `PUT /v1/conversations/database` — load or save the authenticated user's complete conversation database, including the active conversation.
- `POST /v1/conversations/import` — import the legacy Petrio conversation snapshot once; an existing Core history is never overwritten.
- `GET /v1/conversations` — list the authenticated user's conversations.
- `POST /v1/conversations` — create a conversation with an optional title.
- `GET /v1/conversations/:id` — retrieve one of the authenticated user's conversations.
- `POST /v1/conversations/:id/messages` — append a user or assistant message.
- `DELETE /v1/conversations/:id` — delete that user's conversation.
- `GET /v1/memories` — list/search memories; optional `origin`, `source`, `type`, `tag`, `minImportance`, `q`, `limit` and `sort` query parameters.
- `GET /v1/memories/stats` — counts by source/type and relationship totals.
- `GET /v1/memories/:id` — retrieve a memory.
- `GET /v1/memories/:id/relationships` and `POST /v1/memories/:id/relationships` — inspect or create a relationship.
- `GET /v1/memories/:id/related` — retrieve both incoming and outgoing related memories.
- `DELETE /v1/memories/:id/relationships/:relationshipId` — remove a relationship.
- `POST /v1/memories` — explicitly create a memory with provenance.
- `PATCH /v1/memories/:id` — edit title, text, tags or importance without changing provenance.
- `DELETE /v1/memories/:id` — delete a memory and remove incoming links.
- `POST /v1/memories/import` — idempotently import an existing Petrio memory array for the authenticated user, retaining existing memory IDs.
- `GET /v1/providers` — redacted provider configuration.
- `GET /v1/providers/health` — provider health and model availability.
- `POST /v1/chat` and `POST /v1/agent/run` — run the guarded agent loop with `messages`, optional compact `dashboardState`, and `mode`.
- `POST /v1/chat/stream` — runs the same guarded agent loop and returns newline-delimited `meta`, `delta`, `approval_required` and `done` events. The current implementation emits the completed answer as one delta rather than token-by-token model streaming.
- `GET /v1/tools` — list registered tools and whether the user has granted their scope.
- `GET /v1/audit` — retrieve the authenticated user's recent action audit events (maximum 500).
- `GET /v1/permissions` — list the user's permission grants.
- `POST /v1/permissions` and `DELETE /v1/permissions` — grant/revoke a registered tool scope.
- `POST /v1/tools/plan` — dispatch a registered tool; authorised read/draft results may return immediately, while write/external-side-effect calls and network calls made in an untrusted turn return `202 { status: "awaiting_user_approval", actionId }`.
- `GET /v1/tools/pending` — list the current user's pending actions.
- `POST /v1/tools/approve` — explicitly approve and commit the exact pending action.
- `POST /v1/tools/reject` — reject a pending action.
- `POST /v1/tools/execute` — intentionally disabled (`410`); no direct execution path is available.

## Node.js client SDK

The Core includes a reusable Node.js client for trusted backend applications. The standalone interface backend will use this SDK rather than duplicating request signing or Core API handling:

```js
import { createAlfieCoreClient } from "./src/client.mjs";
import { createSignedIdentityAuth } from "./src/auth/signedIdentity.mjs";

const identityAuth = createSignedIdentityAuth({
  secret: process.env.ALFIE_CORE_STANDALONE_IDENTITY_SECRET,
  providerId: "standalone-ui"
});
const alfie = createAlfieCoreClient({
  baseUrl: process.env.ALFIE_CORE_URL,
  serviceToken: process.env.ALFIE_CORE_SERVICE_TOKEN,
  identityAuth
});

const result = await alfie.runAgent(authenticatedUser.id, { messages });
```

The SDK is server-side only. It requires an authenticated user ID from the calling application's own session, signs each request for the exact HTTP method and path, and keeps both service credentials out of the browser. `createIdentityLinkCode`, `linkIdentity` and `unlinkIdentity` support the one-time account-link flow; ordinary user data calls are rejected until the standalone identity is linked. It rejects paths outside the versioned API boundary and preserves structured Core errors such as conversation revision conflicts.

## Local development

Requires Node.js 22 or newer.

```sh
npm install
npm test
ALFIE_CORE_DATA_DIR=./data ALFIE_CORE_SERVICE_TOKEN="$(openssl rand -hex 32)" ALFIE_CORE_STANDALONE_IDENTITY_SECRET="$(openssl rand -hex 32)" npm start
```

The service listens on port 8780 by default.

## Independent Docker deployment

Alfie Core now has its own Compose project and environment template. It can be built and run without starting Petrio:

```sh
cp .env.example .env
# Add a private ALFIE_CORE_SERVICE_TOKEN and at least one trusted identity secret.
docker compose up -d --build
docker compose ps
docker compose logs -f alfie-core
```

The service listens on port 8780 inside the private Compose network. No host port is published. The persistent alfie_core_data volume is owned by this Compose project, and the container runs as a non-root user with a read-only root filesystem, dropped Linux capabilities and a restricted temporary filesystem.

Configure these separate credentials in the repository-root .env file:

- ALFIE_CORE_SERVICE_TOKEN — required by every versioned API request.
- ALFIE_CORE_PETRIO_IDENTITY_SECRET — enables the existing Petrio client adapter.
- ALFIE_CORE_STANDALONE_IDENTITY_SECRET — enables the independent interface backend identity provider.
- ALFIE_CORE_IDENTITY_SECRET — supported only as a legacy alias for the Petrio identity secret.

Petrio and the standalone interface can authenticate to the same Core simultaneously using different HMAC identity secrets. Their trusted Node.js backends sign user IDs server-side; no secret belongs in browser code. Core verifies the exact request method and path, a 60-second validity window and a one-time nonce. The service token is not a user identity. These assertions are backend-to-backend identity, not end-user login: each client must authenticate its own session first and sign the same stable canonical Core user ID for the same person. Provider-specific account IDs must be mapped to that canonical ID before signing, otherwise Core correctly treats them as separate users and separate memory stores.

The standalone Compose project creates the alfie-core-internal network. When Petrio is connected as an adapter, its container must also be attached to this network (or another explicitly configured private network) before enabling the Petrio Core feature flag. The independent interface backend will use the internal service address alfie-core:8780 when attached to this network.

For the current Petrio Compose deployment, start Core first so it creates the network. Then, from the Petrio checkout, attach the Petrio service using the opt-in overlay:

```sh
docker compose -f compose.yaml -f compose.alfie-core.yaml up -d
```

The overlay is stored in the Petrio repository. It preserves Petrio's normal default network and adds the external alfie-core-internal network only when explicitly selected. Set matching ALFIE_CORE_SERVICE_TOKEN and ALFIE_CORE_PETRIO_IDENTITY_SECRET values in both server environments, set ALFIE_CORE_URL=http://alfie-core:8780 in Petrio, and set ALFIE_PETRIO_ADAPTER_URL=http://petrio:3000/v1/alfie-core/tools/run in Core. Keep ALFIE_CORE_ENABLED=false until the private connection and read-only adapter checks have been completed.

Petrio is deployed separately and connects as a client over a private Docker network. Do not run a second copy of Alfie Core inside the Petrio Compose project.


## Backup and restore

All Core-owned conversations, memories, permissions, pending actions and audit records live under /data in the named Docker volume alfie-core-data. Back up the complete volume together; do not selectively copy individual user files.

Create a consistent backup with a short service pause:

```sh
docker compose stop alfie-core
mkdir -p backups
docker run --rm -v alfie-core-data:/data:ro -v "$PWD/backups:/backup" alpine:3.20 sh -c 'tar -czf /backup/alfie-core-$(date -u +%Y%m%dT%H%M%SZ).tar.gz -C /data .'
docker compose start alfie-core
```

To restore, stop Core, clear the existing volume, extract the chosen archive and restore the non-root container ownership:

```sh
docker compose stop alfie-core
docker run --rm -v alfie-core-data:/data alpine:3.20 sh -c 'find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} +'
docker run --rm -v alfie-core-data:/data -v "$PWD/backups:/backup" alpine:3.20 sh -c 'tar -xzf /backup/alfie-core-BACKUP.tar.gz -C /data && chown -R 1000:1000 /data'
docker compose start alfie-core
```

Replace the archive name with the backup you intend to restore. Backups contain private conversation and memory data; keep them encrypted and outside any public web directory. Test restore periodically before relying on a backup.

## Specialist Python services (planned)

Node.js remains the only Alfie Core and the authority for identity, conversations, memory, permissions, tool execution, approvals and audit. Python is reserved for optional specialist workers where its ecosystem is useful, such as embeddings, semantic reranking, document/data analysis and model-assisted processing.

Python workers will be separate internal services behind Node-owned integration adapters. They must:

- expose versioned, allowlisted operations with strict request and response schemas;
- authenticate service-to-service calls with a dedicated secret and never accept a browser request directly;
- receive only the minimum data needed for the requested operation;
- never access Core's conversation, memory, permission or audit stores directly;
- never register or execute tools, grant permissions, approve actions or contact Petrio/homelab integrations;
- treat all input as untrusted and return results that Core validates and wraps as untrusted context;
- enforce bounded payload sizes, execution deadlines, cancellation and concurrency limits;
- remain optional: if a worker is offline, Core chat and Node-owned tools continue to function.

Core decides whether a specialist operation is appropriate and whether its result can be used. A Python worker returns data; it never becomes another Alfie brain or control plane.

## Extraction rules

- Do not copy Petrio user data into Core until a migration and rollback plan exists.
- Do not trust client-supplied user IDs.
- Keep Petrio adapters outside the Core domain layer.
- Register tool handlers only in trusted server-side integration code; never accept executable handlers or arbitrary endpoint URLs from chat clients.
- Treat model-generated tool plans as proposals. Write/destructive handlers must require a matching, unexpired, one-time user approval.
- Keep the existing Petrio Alfie client operational until the Core integration passes acceptance tests.

## Petrio adapter

Petrio has a separate server-side adapter in the Petrio repository at `server/alfieCoreClient.js` and routes under `/api/alfie/core/*`. It signs the authenticated Petrio user ID for each request and keeps the service token and Petrio identity secret on the server. The adapter remains feature-flagged with `ALFIE_CORE_ENABLED=false` until the standalone service is deployed and network connectivity is verified. Set `ALFIE_CORE_URL=http://alfie-core:8780` when both backends share the private `alfie-core-internal` Docker network. The Petrio service must be attached to that network using an explicit Compose override; the default Petrio deployment does not require the Core network.


## Petrio dashboard integration

Set `ALFIE_CORE_ENABLED=true` only after the Core container and both service/identity secrets are configured. Petrio's Alfie chat then routes through `/api/alfie/core/agent/run`; the dashboard renders pending action previews with explicit Approve and Reject controls, restores pending actions from Core after a refresh, and exposes a grouped permission panel plus recent action history.

If Core is explicitly disabled, the current legacy harness remains available during the migration. If Core is enabled but its status or request fails, the UI fails closed and does not fall back to legacy action execution. This avoids silently bypassing the Core permission and approval boundary.
