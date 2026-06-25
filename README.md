# **@neutro/sync (ns)** — A universal client-side sync layer.

Sync is the reconciliation of two or more diverging replicas of some state over an unreliable
channel, where local progress must never block on the channel. `ns` is the **seam**, not the
store and not the merge algorithm: one engine that every consumer — a reactive database, a
view engine, a form library, a queue, presence, rich-text, settings — configures against,
with zero domain-specific code inside it.

- **State and op in one feed.** "Field X is now Y" and "do X" flow through a single
   discriminated `Change` type — neither privileged.
- **Durable and ephemeral in one pipe.** A database and live presence share one transport;
   ephemeral never pays durability's cost and never advances the cursor.
- **Detect, never decide.** Conflicts are surfaced to a pluggable resolver (LWW → CRDT →
   manual); `ns` never inspects your values.
- **Pluggable everywhere.** Clock strategy, resolver, and transport are slots — not a CRDT,
   not a database, not a server, not tied to any framework.
- **Standalone.** No dependency on any neutro sibling; others may consume it.

> Status: pre-alpha. The seam contract is frozen; the reference engine is in progress.
