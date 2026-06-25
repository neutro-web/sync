# ns — Implementation State Map

**What this is.** A one-page orientation digest of *what exists in the code right now* — file
inventory, real-vs-stub status, the load-bearing seams, and known gaps. It exists because the
decision log records **decisions** and the seam contract records **semantics**, but neither
records **code facts**. Re-deriving those each session causes churn; this file holds them.

**What this is NOT.** Not a decision record (those go in `decision-log.md`), not a semantics
spec (that is `seam-contract.md`), and **not authoritative** — **GitHub is authoritative for
code.** This is a navigational summary, regenerated when reality moves. If it disagrees with
the source, the source wins and this file is stale → fix it.

**Maintenance.** Update in the same pass that lands code, as a ready-to-commit edit (same
discipline as log entries). Keep it to roughly this length; detail belongs in the code.

Last verified against source: **2026-06-25 (Phase 1b engine complete).** Seam Contract **v1.0**.

---

## Status: PHASE 1b ENGINE COMPLETE — strategies and real transports not yet built

The real `Feed` engine (`Engine` class) is built and verified. `LWWClockStrategy` is the first
concrete `ClockStrategy`. All 18 tests pass (`tsc --noEmit` clean). The stubs in
`test/harness/stubs.ts` are unchanged — the real engine lives alongside them, verified by
separate tests in `test/engine/`. T3 (ephemeral off durable path) and T4 LWW path are now
tested. The `concurrent` → `Resolver` conflict path is consciously deferred to Phase 2
(unreachable under LWW). Phase 2 adds logical/hybrid clock and CRDT-position strategies.

---

## File inventory (status per file)

Legend: **REAL** = production-complete & verified · **PARTIAL** = works for a subset ·
**STUB** = intentionally simplified; named replacement session pending · **DEFERRED** = designed,
not built · **—** = not created.

### Governance / docs
| File | Status | Notes |
|---|---|---|
| `docs/seam-contract.md` | REAL | Frozen seam semantics, v1.0. Eight seam types + T1–T5 + §9 consumer map + §9.1 local-derived rule. Authoritative for semantics. |
| `docs/decision-log.md` | REAL | Current-State + append-only Log. T1–T5 + standalone + harness + engine findings locked; G2–G3 open. |
| `docs/implementation-state.md` | REAL | This file. |
| `docs/gates/phase1-convergence-harness.md` | REAL | Six gate items (G1–G6). Written before code. All passing. |
| `docs/gates/phase1b-engine.md` | REAL | Seven gate items (P1–P7). Written before code. All passing. P6 is named deferral. |
| `AGENTS.md` | REAL | Working instructions (house pattern, ns-tuned). All locked decisions reflected. |
| `CLAUDE.md` | REAL | One-liner pointing to AGENTS.md. |
| Founding Charter | REAL | Project-knowledge orientation (lives in the claude.ai project knowledge). |

### Config / tooling
| File | Status | Notes |
|---|---|---|
| `package.json` | REAL | `@neutro/sync`, `"type": "module"`. devDeps: typescript ^5.5, vitest ^4.1.9, biome ^1.9. Scripts: `typecheck`, `test`, `test:watch`, `lint`. No production deps (standalone). |
| `tsconfig.json` | REAL | `strict: true`, `moduleResolution: "bundler"`, `allowImportingTsExtensions: true`, `noEmit: true`. Includes `src`, `test`, `vitest.config.ts`. |
| `vitest.config.ts` | REAL | Includes `test/**/*.test.ts`. |
| `.gitignore` | REAL | Covers: `node_modules/`, `dist/`, `*.tsbuildinfo`, `coverage/`, logs, OS files, editors, `.env*`, `*.tmp`. |

### `src/core/` → `@neutro/sync/core` (the engine)
| File | Status | Notes |
|---|---|---|
| `src/core/types.ts` | REAL | Full TypeScript expression of seam contract v1.0. All eight seam types: `Change`/`StateChange`/`OpChange`/`VersionedChange`, `Cursor`/`Version`/`ClockStrategy`, `Lifetime`, `ChangeBatch`/`Snapshot`/`Feed`, `Conflict`/`Resolution`/`Resolver`, `Scope`/`Subscription`/`ScopeRouter`, `Transport`, opaque tokens. Factory helpers: `makeChangeId`, `makeScope`, `makeConflictUnit`, `makeCursor`, `DURABLE`, `ephemeral`. |
| `src/core/engine.ts` | REAL | `Engine implements Feed, ScopeRouter`. In-memory. T1 kind branching; T2 version opacity (only `compare()` called); T3 lifetime fork (ephemeral off durable path); T4 `concurrent` branch present and deferred; T5 per-scope causal order via synchronous subscription dispatch. `getCursor(scope)` for test assertions. |
| conflict detection (`concurrent` path) | DEFERRED | **Phase 2 entry condition.** The `concurrent` arm in `_applyState` and `_applyOp` exists, is documented, and returns without applying. A strategy returning `concurrent` (logical/CRDT clock) plus a concrete `Resolver` are required to exercise it. |
| scope routing (`ScopeRouter`) | REAL | `Engine.subscribe(scope, { onBatch, onConflict })` → `Subscription`. Per-scope; fires synchronously on accepted changes. |

### `src/strategies/` → `@neutro/sync/strategies`
| File | Status | Notes |
|---|---|---|
| `src/strategies/lww.ts` | REAL | `LWWClockStrategy implements ClockStrategy`. Monotonic integer counter; `mint()` increments; `compare()` returns `"before"` or `"after"`, **never `"concurrent"`**. Internal version shape: `{ _ts: number }`. Strategy-owned, opaque to engine. |
| logical/hybrid clock | — | Phase 2. First strategy to produce `concurrent` — required to exercise T4 conflict path. |
| CRDT-position strategy | — | Phase 2. |

### `src/transports/` → `@neutro/sync/transports`
| File | Status | Notes |
|---|---|---|
| `src/transports/in-process.ts` | REAL | `InProcessTransport implements Transport`. `channelFn` injectable by harness. `send()` resolves on hand-off (§7). `_deliver()` for inbound push. `_setConnected()` fires connect/disconnect handlers (T3 reconnect lifecycle hook). `static pair()` for direct no-fault pairing. |
| BroadcastChannel | — | Phase 3 (real hardware). |
| WebSocket / http-poll | — | Phase 3 (real hardware). |

### `src/adapters/` → `@neutro/sync/adapters/<framework>` (subpath exports)
| File | Status | Notes |
|---|---|---|
| react / svelte / vue / solid / angular | — | Phase 4. Thin: map `subscribe`/`snapshot`/`emit` → framework primitive; no sync logic. Optional peer deps; each subpath independently tree-shakeable. Blocked on G2 write/emit ergonomics. |

### `test/harness/`
| File | Status | Notes |
|---|---|---|
| `test/harness/seeded-rng.ts` | REAL | `mulberry32(seed)` — deterministic 32-bit PRNG returning `() => number` in [0, 1). |
| `test/harness/channel-simulator.ts` | REAL | `ChannelSimulator(seed, FaultConfig)`. Drain-based; deterministic drop/reorder/duplicate/partition. Consumes exactly 4 RNG values per non-partitioned `enqueue()` (0 when partitioned — structural, not probabilistic). Stats: sent/dropped/reordered/duplicated/delivered. |
| `test/harness/stubs.ts` | STUB | `NonConvergingFeed` / `TriviallyCorrectFeed` / `LocalState` / `makeStubVersion`. Acceptance instruments for the harness; not replaced by the real engine (they coexist). |
| `test/harness/convergence-harness.ts` | REAL | `ConvergenceHarness(opts)`. N replicas, N×(N-1) directed channels. `applyLocal`, `drainToQuiescence` (round-based), `assertConverged` (throws on <2 replicas), `throwIfDrainErrors`, partition/reconnect controls. |
| `test/harness/harness.test.ts` | REAL | 10 tests, all passing (G1–G6). Untouched by Phase 1b. |

### `test/engine/`
| File | Status | Notes |
|---|---|---|
| `test/engine/engine.test.ts` | REAL | 8 tests covering P2–P5. Gossip wired via `Engine.subscribe()` + `ChannelSimulator` (no harness dependency). P2: LWW contention; P3: op dedup; P4a–c: T3 ephemeral assertions; P5: take-by-version with throwing Resolver. |

### `integration/`
| File | Status | Notes |
|---|---|---|
| multi-replica + real-transport composition | — | Phase 3+. Owns no module; routes bugs to owning stream. |

---

## Load-bearing seams (real signatures)

### Production seams (real)

**`Engine.apply(batch: ChangeBatch): Promise<void>`**
Branches on `change.kind`. State: global seenIds dedup, then `ClockStrategy.compare(incoming,
existing)` — `"after"` accepts, `"before"` skips, `"concurrent"` deferred. Op (no version):
seenIds dedup only. Op (with version): seenIds + version compare. T3 fork: durable → advance
`cursorSeq` + append to `durableLog`; ephemeral → update `stateUnits` only. Fires subscriptions
synchronously for accepted changes (required for drain-round correctness). Returns
`Promise.resolve()` — synchronous internally.

**`Engine.changes(scope, since: Cursor | null): AsyncIterable<ChangeBatch>`**
Yields durable log entries with `seq > since._seq` (or all if `since` is null) as a single
`ChangeBatch`. Ephemeral changes never appear. Cursor on the yielded batch reflects the last
durable seq.

**`Engine.snapshot(scope): Promise<Snapshot>`**
Returns all entries in `stateUnits` (current state, both durable and ephemeral). No cursor.
Ephemeral values are live current state even though they are not in the durable log.

**`Engine.subscribe(scope, { onBatch, onConflict }): Subscription`**
Registers per-scope handlers. `onBatch` fires synchronously in `apply()` for each accepted
batch. `onConflict` is wired but not yet invoked (awaits Phase 2 `concurrent` path).
`unsubscribe()` is idempotent.

**`Engine.getCursor(scope): Cursor`**
Returns `makeCursor(scope, cursorSeq)`. Not on the `Feed` interface — test assertion helper only.

**`LWWClockStrategy.mint(_prev?): Version`**
Increments internal counter, returns `{ _ts: counter }` cast to `Version`. Monotonically
increasing per instance.

**`LWWClockStrategy.compare(a, b): "before" | "after" | "concurrent"`**
Compares `_ts` fields. Returns `"after"` if `a._ts > b._ts`, `"before"` otherwise. Never
returns `"concurrent"`.

**`InProcessTransport.send(batch: ChangeBatch): Promise<void>`**
Calls `channelFn(batch)` synchronously, returns `Promise.resolve()`. Resolves on hand-off (§7).

### Harness-internal seams (not production)

**`TriviallyCorrectFeed.onForward?: (batch: ChangeBatch) => void`**
Set by `ConvergenceHarness` for gossip routing. Called synchronously in `apply()` — required
for drain-round correctness.

**`ConvergenceHarness.throwIfDrainErrors(): void`**
Surfaces errors from async `apply()` calls during drain. No-op for stubs; use in Phase 2+
engine tests after `drainToQuiescence()`.

---

## Known gaps / defects

- **`concurrent` → `Resolver` path untested.** The branch exists in `Engine._applyState` and
  `Engine._applyOp` and is documented as deferred. Phase 2 entry condition: a strategy
  producing `concurrent` plus a concrete `Resolver` must exercise and verify this path.
- **`InProcessTransport` connect/disconnect lifecycle untested.** `_setConnected` fires
  handlers but no test verifies the T3 reconnect fork (replay vs. snapshot on reconnect)
  it is meant to drive. Deferred to Phase 3 (real transport work).
- **`seenIds` grows unboundedly.** No eviction or TTL. Fine for Phase 1b in-memory usage;
  a real persistence layer will need a compaction strategy.
- **`changes()` yields all entries as one batch.** Fine for Phase 1b; a production
  implementation may want paginated/chunked batches for large logs.
- **Op-with-version conflict path untested.** The `opUnitVersions` tracker exists but
  no test exercises a version-compare collision on an op change. Deferred to Phase 2.

---

## Open gates affecting code (mirror of decision-log Current State)

- **Standalone (locked)** — no `neutro/*` runtime dependency ever enters `src/core`. A reactive
  consumer binds to `ns` on its own side; there is no `ns`-side adapter package in core scope.
- **G2 Public API** — do not create a frozen public client/builder; sketches are design docs.
- **G3 LCD-risk** — the conformance suite is the eventual evidence; not blocking Phase 2.
- **Phase 2 entry condition** — `concurrent` → `Resolver` path requires a strategy that
  produces `concurrent` (logical/hybrid clock or CRDT position). That is Phase 2's first gate.
