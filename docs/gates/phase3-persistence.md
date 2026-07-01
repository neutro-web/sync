# Acceptance Gate: Phase 3 — Persistence (real hardware)

> **Status**: D0–D6 complete; D7 pending CC/CI bench numbers. HEAD `e0fa01c`.
> D3 is closed by two complementary artifacts: (1) `test/browser/reload.test.ts` — Engine + `hydrateScope()` recovers full state from real IndexedDB (vitest/Playwright, same JS context, fresh instances); (2) `test/e2e/d3-nav-reload.spec.ts` — IDB data survives a genuine `page.reload()` (JS heap cleared, standalone Playwright). Neither alone closes D3 end-to-end; together they do. A single test that runs the TypeScript Engine post-reload would require a build step or dev server not currently in the project — deferred unless Phase 5 adds one.

> **Gate version**: 0.1 (written before code per AGENTS.md gate discipline).
> **Stream**: Claude Code / CI — **NOT sandbox.** Every item below depends on real-platform
> behavior (IndexedDB/OPFS durability, survival across a real reload) or a measured number. A
> sandbox cannot close a single item here. The charter §9 test applies: "does the answer depend
> on a measured number or real-platform behavior?" → yes for all → Claude Code.
> **Predecessor**: HEAD `51dde1d` on main — 130 tests green, `tsc --noEmit` clean, seam **v1.1**
> frozen. Engine is RAM-only: `ScopeState.{durableLog, cursorSeq}` are in-memory; process restart
> loses all durable state and replays from log start (verified — `create-sync.ts` `lastCursor` is
> in-memory).
> **Scope**: A pluggable persistence substrate behind the durable change log + cursor, with
> **replay-after-reload**, plus the persistence-adjacent debt that the in-memory implementation
> deferred. This gate is one of two Phase 3 tracks; the **transports** gate is written *after* this
> one settles the cursor-advancement sub-gate (D0 below), because the transport reconnect path is
> built on the cursor contract this track fixes.
>
> **Frozen-seam guardrail:** persistence must not change `docs/seam-contract.md` (v1.1) or the
> T1–T5 surface. `Cursor` stays `ns`-owned and concrete; `Version` stays opaque. Persistence is a
> substrate behind the existing `Feed`/`changes`/`Cursor` seam, not a new public type. If it
> appears to need a seam change, that is a separate contract-version event — **halt and surface it.**

---

## D0 — OPEN DESIGN SUB-GATE (resolve in CC before D3/D4/D5): cursor-advancement semantics

**Status: OPEN. Do not build the replay items past this without resolving it.**

The known reconnect defect (decision-log 2026-06-30 Phase B / B3) is a cursor-advancement
question, not a storage question: `lastCursor` advances at **durable-accept** today, in the same
synchronous step the durable log grows, so `changes(scope, lastCursor)` always yields zero. Before
the replay items below can be made failable, CC must decide and log:

1. **When does the persisted cursor advance** — at durable-accept (current), or at
   confirmed-delivery (the B3 finding's direction)? This interacts with real transport ack
   semantics, which is why it is resolved in CC against real delivery, not pre-committed in sandbox.
2. **What does replay-after-reload read from** — the persisted log from the persisted cursor. This
   is *engine-local recovery* (same engine, across a restart), which the frozen cursor's locality
   (`cursorSeq` is a local ordinal, NOT cross-replica) already supports. **Peer-recovery** (pulling
   a peer's missed writes) is a separate Phase 5 concern and is an explicit **non-goal of this
   gate** — do not conflate them.

**Evidence this sub-gate is resolved**: a dated decision-log entry stating the chosen
advancement semantics + the replay read-model, plus (if the analysis is reusable) a
`docs/design/cursor-advancement.md` note. D3/D4/D5 reference its outcome. Until it is logged,
D3/D4/D5 are structured so the answer drops in without a rewrite (the gate items assert
*behavior* — "a reloaded engine recovers exactly the durable changes it had accepted" — not a
specific advancement rule).

**Failure condition for D0**: any of D3/D4/D5 is implemented against an unlogged advancement rule;
OR the implementation silently re-uses the durable-accept timing the B3 finding flagged as broken,
without an entry justifying it.

---

## Persistence substrate

### D1 — Pluggable persistence behind the durable log; in-memory remains a valid impl

**Artifact / command**: CC — the persistence interface + an IndexedDB (or OPFS) impl land in
`src/persistence/` (or equivalent); `pnpm typecheck` clean; `pnpm test` green.

**What is verified**: the durable log + cursor sit behind a pluggable persistence slot (mirrors the
`Transport`/`ClockStrategy` slot discipline — a slot, not a widenable extension point). The existing
in-memory behavior is one impl of that slot; swapping to IndexedDB requires no engine-internal or
seam change. `value` stays `unknown` to the persistence layer (it stores opaque change records).

**Failure condition**: persistence logic leaks into `src/core/engine.ts` conflict/apply paths; OR a
domain type enters the persistence signature; OR the in-memory path regresses (130 existing tests
must stay green).

### D2 — Durable changes survive to the store; ephemeral never touch it (T3 on real storage)

**Artifact / command**: CC — real IndexedDB/OPFS write; assertion via store inspection.

**What is verified** (T3 on real hardware): a durable change is written to the persistent store; an
ephemeral change is **never** written — no IndexedDB/OPFS record, consistent with "ephemeral never
advances the cursor / never persisted." A disk write never sits in the path of an ephemeral
(presence) change.

**Failure condition**: an ephemeral change produces a persistent record; OR a durable change is
absent from the store after write resolves.

---

## Replay-after-reload (depends on D0)

### D3 — Replay-after-reload: a reloaded engine recovers exactly its accepted durable changes

**Artifact / command**: CC — real page reload (or worker restart), not a simulated one.

**Replica count**: 1 (this is engine-local recovery across a restart — the divergence is the engine
vs. its own persisted state, not vs. a peer).

**Divergence driver**: an engine accepts N durable changes (cursor advances, store written), then
the page/worker is **really reloaded** (process memory cleared). A fresh engine instance hydrates
from the persistent store.

**Reconciled assertion**: the reloaded engine's `snapshot(scope)` matches the pre-reload snapshot
for every durable unit; its cursor resumes at the pre-reload terminal position (per D0's read-model,
NOT seq 0); a subsequent `changes(scope, since)` from a mid-point cursor yields exactly the entries
after that point. **No ephemeral value survives the reload** (T3 — ephemeral is snapshot-on-reconnect,
not replay).

**Failure condition**: any durable unit missing post-reload; cursor resets to log start (the current
in-memory failure mode); an ephemeral value survives; OR replay from a mid-point yields wrong entries.

### D4 — Persisted cursor: restart does not replay from log start

**Artifact / command**: CC — restart + cursor inspection.

**What is verified**: closes the standing G2 follow-up ("`lastCursor` is in-memory; process restart
replays from log start"). After reload, the persisted cursor is read from the store; the engine does
**not** re-emit the entire durable log as if `since === null`.

**Failure condition**: post-restart, the engine replays from log start; OR the persisted cursor is
absent/ignored.

### D5 — `seenIds` survives reload sufficiently to keep op-dedup correct across a restart

**Artifact / command**: CC — restart + duplicate-op redelivery.

**What is verified**: an op accepted before reload, redelivered after reload, is **not** double-applied.
This forces a decision on `seenIds` persistence/compaction (flagged unbounded since Phase 1b). The
gate asserts the *property* (no double-apply across restart), not a specific eviction strategy — the
strategy (full persist vs. windowed vs. cursor-derived) is a CC implementation choice to log.

**Failure condition**: a pre-reload op is re-applied after reload; OR the chosen `seenIds` strategy
is unbounded with no compaction (re-deferring the Phase 1b debt rather than closing it).

---

## Production log ergonomics

### D6 — `changes()` chunking: large replay does not materialize the whole log at once

**Artifact / command**: CC — replay of a large durable log; observe batching.

**What is verified**: `changes(scope, since)` yields the durable log in bounded chunks rather than a
single `ChangeBatch` of the entire log (the current impl yields one batch — fine in-memory, a memory
hazard on a real persisted log). Per-scope causal order (T5) is preserved across chunk boundaries.

**Failure condition**: the whole log is materialized in one batch; OR chunking reorders entries
within a scope.

---

## Measurement (numbers — CC/CI only)

### D7 — Baseline persistence numbers logged, with measurement semantics stated

**Artifact / command**: CC/CI — `bench/` run; numbers recorded in the decision-log or a bench report.

**What is verified**: first real numbers for the persisted path — durable write latency, replay
throughput (changes/sec on reload), reload-to-ready time for a representative log size. Per AGENTS.md
measurement-semantics discipline: state **what counts as "ready"** (hydrated + cursor restored?),
**what is in the timed region** (store read only, or read + apply?), and **the denominator**. A
sandbox number is noise; these are CC/CI only.

**Failure condition**: a number is reported without its measurement semantics stated; OR a sandbox
number is presented as a baseline.

---

## Two standing gates (apply to every item)

- `pnpm typecheck` → `tsc --noEmit` exits 0.
- `pnpm test` → vitest exits 0 (130 existing + new; existing stay green).
- `pnpm lint` → biome clean.
- **Regression guard**: `test/harness/`, `docs/seam-contract.md`, `src/core/types.ts` unchanged
  (`git diff --name-only` shows none) unless a seam-version event was explicitly surfaced and logged.

---

## Explicit non-goals (carried forward, NOT closed by this gate)

- **Peer-recovery / pull-based catch-up seam** → Phase 5. D0 resolves *engine-local* reload
  recovery only. The B3 finding's second half (the mechanism republishes this engine's own log,
  never pulls a peer's) is **not** fixed here — it is delivery-above-transport (§7), Phase 5.
- **`transport.send` retry/backpressure/ack** → Phase 5.
- **Real transports** (BroadcastChannel/WebSocket) → the separate Phase 3 transports gate, written
  after D0 settles.
- **`closedKeys` growth bound** → Phase 5.

A Phase 3 persistence landing that claimed "reconnect-replay works" would be **false** — this gate
fixes engine-local replay-after-reload; cross-peer reconnect recovery remains a Phase 5 defect.

---

## Summary table (AGENTS.md requirement)

| Item | Replicas | Driver | Reconciled assertion |
|---|---|---|---|
| D0 | — | open design sub-gate | advancement semantics + replay read-model logged before D3/D4/D5 |
| D1 | — | — | pluggable persistence slot; in-memory still valid; no engine/seam change |
| D2 | 1 | durable vs ephemeral write | durable persisted; ephemeral never written (T3) |
| D3 | 1 | real reload, fresh engine hydrates | snapshot + cursor recovered; no ephemeral survives |
| D4 | 1 | restart | persisted cursor read; no replay-from-start |
| D5 | 1 | op redelivered after reload | no double-apply; `seenIds` strategy bounded |
| D6 | 1 | large log replay | bounded chunks; T5 order preserved across chunks |
| D7 | — | bench | baseline numbers + measurement semantics stated (CC/CI) |
| std | — | — | typecheck / test / lint exit 0; frozen seam + harness unchanged |
