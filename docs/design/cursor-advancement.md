# Cursor Advancement and seenIds Strategy — Phase 3 Persistence

## Context

The B3 finding (2026-06-30) confirmed that `create-sync.ts`'s durable reconnect-replay branch
is structurally inert: `entry.lastCursor` advances synchronously in the same `onBatch` callback
that writes to the engine's durable log, so `engine.changes(scope, lastCursor)` always yields
zero batches. Before the Phase 3 persistence replay items (D3/D4/D5) can be built, two
sub-questions must be answered: (a) when does the persisted cursor advance, and (b) how do
`seenIds` survive a restart without re-deferring the unbounded-growth debt flagged in Phase 1b.
Scope: **engine-local reload recovery only** (same engine, process restart). Peer-recovery
(pulling a peer's missed writes) is an explicit non-goal of this gate — it is Phase 5 /
delivery-above-transport (§7).

---

## Sub-question (a): When does the persisted cursor advance?

### Option 1 — Durable-accept (current `cursorSeq` behavior)

`cursorSeq` increments and the durable log entry is pushed in the same synchronous step that
accepts a durable change (`engine.ts` lines ~245–246, ~303–304, ~528–529, ~537–538). The
persisted cursor mirrors this: it advances when the durable log entry is written to the
persistence store.

**Pro:** correct for engine-local reload recovery. A reloaded engine reads its own persisted log
and resumes at `cursorSeq` — no gap, no double-replay. The cursor is a local ordinal (not
cross-replica), so self-replay from the persisted cursor fully restores the pre-reload state.

**Con:** does not track whether the change was ever delivered to any peer. That is intentionally
out of scope for this gate.

### Option 2 — Confirmed-delivery (advance only after `transport.send()` resolves)

Cursor advances only after `send()` resolves, tying the persisted position to network delivery.

**Pro:** a future peer-recovery mechanism could use this cursor to re-send unacknowledged changes.

**Con:** this is delivery-above-transport (§7), explicitly Phase 5. It conflates two distinct
cursors: the engine-local durable-accept ordinal and the delivery-progress marker. Mixing them
into a single persisted cursor requires the persistence layer to know about transport acks —
a seam violation (T5 / `Transport` boundary). The B3 finding names this as the second, separate
problem in the reconnect-replay defect; it is not scoped to this gate.

### Decision (a)

**Chosen: durable-accept.** The persisted cursor advances at the same moment `cursorSeq`
increments — when the durable log entry is written to the persistence store. This is sufficient
for engine-local reload recovery (D3/D4). Peer-delivery tracking is Phase 5 — not conflated
here. If Phase 5 ever needs a delivery-progress cursor, it is a separate cursor type on top of
the durable-accept ordinal, not a change to this one.

---

## Sub-question (b): seenIds across restart

### Candidate 1 — Persist all seenIds

Persist the full `seenIds` set to the store on every change.

**Disqualified.** Unbounded storage growth with no compaction rule — re-deferring the Phase 1b
debt is a gate failure condition (D5 explicit failure condition).

### Candidate 2 — Cursor-gated (chosen)

Any durable change with `seq ≤ persisted cursorSeq` is implicitly seen: it is covered by a
log entry that was already persisted and applied. On reload, these ids need not be stored
separately — the reloaded engine's cursor position already implies they were processed.

Above the cursor, new seenIds (changes accepted since the last persisted cursor) are tracked
in-memory for the duration of the session. This window is small (bounded by the number of
changes accepted since the last cursor flush — can be flushed per-write or batched) and resets
on restart with the cursor.

**Pure-intent ops (no `seq`):** they are id-deduped only (no cursor can cover them). On restart
their ids are lost. Because pure-intent ops carry no state (they are intent-only; the engine
never writes them to `durableStateUnits`), re-application of a redelivered op produces a
duplicate dispatch to the application layer but no state corruption. Acceptable: the
application layer must be idempotent for ops by contract (§3 T1). An in-memory window for
in-flight pure-intent op ids is cleared on restart — this is correct behavior, not a gap.

**Compaction rule:** on restart, populate `seenIds` only with ids whose `seq > persisted
cursorSeq` (i.e., the in-flight window). Everything at or below the cursor is implicitly
compacted. No background compaction process needed.

### Candidate 3 — Windowed persistence (circular buffer)

Persist the last W seenIds in a fixed-size circular buffer (FIFO eviction).

Works for all change kinds including pure-intent ops. Eviction is mechanical and correct.

**Trade-off vs. cursor-gated:** the window size W is a tuning parameter; too small and a
re-delivered change outside the window slips through; too large and the store grows to W
entries regardless of activity. The cursor-gated approach compacts automatically with zero
tuning and is strictly correct for all durable changes — the only approximate case is
pure-intent ops on restart, where the approximation is safe (idempotent by contract).

### Decision (b)

**Chosen: cursor-gated.** Compaction rule: on load, `seenIds` is initialized empty; changes
with `seq ≤ persisted cursorSeq` are implicitly seen by cursor position and never added to the
set. The in-memory `seenIds` set accumulates only entries above the cursor for the current
session. Pure-intent op ids (no `seq`) are tracked in-memory only; their window is cleared on
restart — safe because pure-intent ops are idempotent by contract (T1). This closes the Phase
1b unbounded-growth debt: the set is bounded by the number of changes accepted in the current
session above the persisted cursor, which is a small and naturally-flushed window.

---

## Decision

**(a) Persisted cursor advancement:** durable-accept — the cursor is persisted when the durable
log entry is written, mirroring the current `cursorSeq` increment timing.

**(b) seenIds across restart:** cursor-gated — changes at or below the persisted cursor are
implicitly seen; only the in-flight window above the cursor is tracked in-memory. Pure-intent
op ids are in-memory only, cleared on restart (safe: ops are idempotent by T1 contract).

---

## Impact on gate items

**D3** — reloaded engine recovers exactly its accepted durable changes: assert against the
durable-accept cursor (not a delivery cursor); `snapshot(scope)` and `changes(scope, since)`
correctness follows from the persisted log + cursor.

**D4** — restart does not replay from log start: the persisted cursor (durable-accept ordinal)
is read on load; `engine.changes(scope, null)` is never called post-hydration; the engine
starts from the stored cursor.

**D5** — no double-apply across restart: cursor-gated seenIds means any change whose `seq ≤`
the persisted cursor on reload is not re-applied (cursor implies the log was already applied).
Pure-intent ops re-delivered after restart may re-dispatch to the application layer; gate asserts
no duplicate state mutation, relying on T1 idempotency for ops.
