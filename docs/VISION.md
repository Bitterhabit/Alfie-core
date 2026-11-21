# Alfie — Long-Term Vision & Design Principles

## Core Identity

Alfie is a **self-hosted, sovereign personal operating companion**—not a stateless chatbot, not a generic SaaS wrapper, and not an autonomous black box.

Alfie lives on your own infrastructure, retains a calm, distinct identity and visual presence (his Soul), and earns trust through **low-context leverage** paired with **mechanical restraint**.

## The Defining Metric: Context Compression Ratio

Alfie's primary differentiator is not the raw count of tools attached to him. It is **how little context you need to provide** to receive accurate, grounded, safe assistance—because he understands:

- Who you are and how you prefer to work.
- What projects you are advancing, their architecture, decisions, and blockers.
- What changed recently across your systems and workspaces.
- What matters right now versus what can wait for a quiet digest.

## Five Architectural Pillars

1. **Deterministic Core, Probabilistic Edge**
   Storage, permissions, schema validation, scheduling, monitoring probes, diffing, and privacy filtering are deterministic Node.js code. LLMs are bounded reasoning and synthesis engines invoked *after* deterministic filtering.

2. **Model Proposes, Harness Executes**
   Every side effect passes through strict JSON schemas, explicit risk tiers (`read`, `draft`, `write`), optimistic concurrency checks (`approvalGuard`), dry-run previews, and verifiable action receipts.

3. **Sovereign Privacy by Construction**
   Personal memories, mail, calendar, journal, project notes, and homelab telemetry default to **local-only**. External cloud providers (Gemini, OpenAI) are strictly opt-in specialist accelerators governed by fail-closed server-side policy.

4. **Structured Continuity Over Infinite Chat Logs**
   Conversations are ephemeral working sessions. Durable knowledge flows into structured **Living Project Dossiers**, **Decision Ledgers**, the **Ideas Vault**, and **Typed Memories** connected through a personal knowledge graph.

5. **Calm Presence & Earned Interruption**
   Background observation runs deterministically without spamming notifications. Alfie follows one rule for proactive outreach: **interrupt only when the value of interrupting exceeds the cost of interrupting.**

## Long-Term Ecosystem

- **Alfie Core (`@alfie/core`, Node.js):** Sole authoritative owner of identity, memory, projects, ideas, permissions, watchers, jobs, audit logs, and tool dispatch.
- **Peer Clients:** Standalone Web/PWA interface, Petrio OS integration, and future CLI/mobile quick-capture clients communicating with Core via signed identity contracts.
- **Stateless Compute Workers (Optional Internal Services):** Internal Python workers for bounded compute (embeddings, reranking, document analysis) or local voice (STT/TTS) behind Node adapters—never owning durable state or permissions.
- **Modular Integration Layer:** Permissioned, replaceable connectors for Petrio, GitHub, Proxmox, homelab services, email, calendar, notes, and files.

## Non-Negotiable Invariants

- **No arbitrary shell or code execution** inside Alfie Core.
- **No silent autonomous writes** or opaque background memory scraping without provenance and user control.
- **No published host port** on Alfie Core; all access goes through authenticated internal/proxy boundaries.
- **No tight coupling to Petrio** or any single model provider.
- **Untrusted external data can never silently trigger writes or outbound network calls.**
