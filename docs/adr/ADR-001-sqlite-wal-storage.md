# ADR-001: Embedded SQLite (WAL Mode) Storage Migration

- **Status:** Proposed
- **Target Phase:** Phase 1 -> Phase 2 Transition

## Context

Alfie Core currently persists per-user state in flat JSON files (`memories.json`, `projects.json`, `ideas.json`, `conversations.json`, `audit.json`, `permissions.json`, `pending-actions.json`) under `/data/users/<sha256>/` guarded by in-process async mutex queues and atomic `0o600` temp-file renames.

While simple and reliable for v0.3.x single-instance operation, upcoming capabilities—multi-hop Knowledge Graph traversals, Watcher event histories, full-text + vector hybrid retrieval, and concurrent async jobs—will hit write-amplification, query-latency, and single-instance locking ceilings.

## Decision

Adopt **embedded SQLite in WAL mode** (via Node.js built-in `node:sqlite` or a minimal audited native driver) inside Alfie Core as the next storage tier, preserving strict per-user isolation (either one SQLite file per hashed user directory or strict `owner_id` partitioning with parameterized queries).

## Consequences

- **Positive:** Zero external database containers to operate; ACID transactions; indexed FTS5 lexical search; native relational modeling for cross-entity graph edges (`projects <-> decisions <-> memories <-> ideas`); clean migration path from existing JSON stores.
- **Trade-offs:** Requires schema migration versioning (`schema_migrations` table) and deterministic JSON-to-SQLite one-time importers so existing user data upgrades safely without loss.
- **Boundary:** Single-container self-hosting remains the default; multi-instance horizontal scaling would later swap the repository layer without changing domain logic.
