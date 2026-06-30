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

Last verified against source: **2026-06-29 (Phase 3 + G2 Public API complete).** Seam Contract **v1.1**.

---

## Status: PHASE 3 + G2 PUBLIC API COMPLETE — `createSync` client, `ScopeHandle`, token-leak gate automated

Phase 3 landed `VectorClockStrategy.mergeVersions` + engine `merged` resolution arm (C1–C7 gate). G2
landed the full consumer-facing public API: `createSync(config)` factory returning a `SyncClient`;
`client.scope(key, cfg)` returning a `ScopeHandle` (`set`/`do`/`subscribe`/`snapshot`/`onConflict`/
`close`). Per-scope config via client-side multiplexing (one `Engine` per scope-config, B1 — no engine
change). Transport bridged in the client; T3 reconnect fork client-driven. Token-leak gate automated
and mutation-verified (`test/types/no-token-leak.test.ts`). **109/109 tests passing**; `tsc --noEmit`
clean; lint clean. HEAD `d21f26d`. Core engine/types/resolver-pump bytewise unchanged across G2 branch.

---

## File inventory (status per file)

Legend: **REAL** = production-complete & verified · **PARTIAL** = works for a subset ·
**STUB** = intentionally simplified; named replacement session pending · **DEFERRED** = designed,
not built · **—** = not created.

### Governance / docs
| File | Status | Notes |
|---|---|---|
| `docs/seam-contract.md` | REAL | Frozen seam semantics, v1.0. Eight seam types + T1–T5 + §9 consumer map + §9.1 local-derived rule. Authoritative for semantics. |
| `docs/decision-log.md` | REAL | Current-State + append-only Log. T1–T5 + standalone + harness + engine findings locked; G2 closed (2026-06-29); G3 + G2-6d open. |
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
| `src/core/engine.ts` | REAL | `Engine implements Feed, ScopeRouter`. In-memory. T1 kind branching; T2 version opacity (only `compare()` called); T3 lifetime fork (ephemeral off durable path); T4 `concurrent` path activated (Model C); T5 per-scope causal order via synchronous subscription dispatch. `getCursor(scope)` for test assertions. `resolveConflict(scope, unit, resolution)` for manual/automatic resolution. |
| conflict detection (`concurrent` path) | REAL | Model C detect-and-hold. `ScopeState.openConflicts` holds both competing `VersionedChange`s per unit. `concurrent` arm fires `onConflict` as notification, returns synchronously. `resolveConflict(scope, unit, resolution)` lands resolution directly into confirmed maps; advances cursor/log for durable wins. `take-local`/`take-remote` supported; `defer` leaves conflict open; `merged` throws (deferred — requires `ClockStrategy.mergeVersions`). **Convergence expectation documented in seam-contract.md §5: local resolver MUST be a deterministic pure function; propagated resolution is Phase 3.** Note: `_applyOp` concurrent arm consciously deferred — op-with-version path stores only `Version`, not full `VersionedChange`; needs follow-up. |
| scope routing (`ScopeRouter`) | REAL | `Engine.subscribe(scope, { onBatch, onConflict })` → `Subscription`. Per-scope; fires synchronously on accepted changes. |
| `src/core/resolver-pump.ts` | REAL | `ResolverPump`. Subscribes to `onConflict`; calls `resolver.resolve(conflict)`; calls `resolveConflict` with the result. Async resolvers: returns `defer` synchronously while the promise settles. Absent ⇒ conflicts stay open for manual resolution. Closes Phase 1b Finding #3 (Resolver/onConflict were dead under all paths). |

### `src/strategies/` → `@neutro/sync/strategies`
| File | Status | Notes |
|---|---|---|
| `src/strategies/lww.ts` | REAL | `LWWClockStrategy implements ClockStrategy`. Lamport-style counter; `mint(prev?)` advances past `prev._ts`. `compare()` returns `"before"` or `"after"`, **never `"concurrent"`**. Internal version shape: `{ _ts: number, _node: number }` — `_node` breaks equal-`_ts` ties deterministically. Strategy-owned, opaque to engine. |
| `src/strategies/vector-clock.ts` | REAL | `VectorClockStrategy implements ClockStrategy`. Version shape: `{ _vec: Record<nodeId, number> }`. `mint(prev?)` merges prev vector then increments own slot. `compare()` returns `"concurrent"` for causally-independent versions; `"before"`/`"after"` for ordered versions. `mergeVersions(a, b)` returns element-wise max (causal join, no local-slot increment) — seam v1.1. |
| `src/strategies/index.ts` | REAL | Public factory functions: `lww(nodeId?: number): ClockStrategy`, `vectorClock(nodeId: string): ClockStrategy`. Both return `ClockStrategy` interface (no concrete class leak). `nodeId` required on `vectorClock`. |
| CRDT-position strategy | — | Phase 3+. |

### `src/transports/` → `@neutro/sync/transports`
| File | Status | Notes |
|---|---|---|
| `src/transports/in-process.ts` | REAL | `InProcessTransport implements Transport`. `channelFn` injectable by harness. `send()` resolves on hand-off (§7). `_deliver()` for inbound push. `_setConnected()` fires connect/disconnect handlers (T3 reconnect lifecycle hook). `static pair()` for direct no-fault pairing. |
| BroadcastChannel | — | Phase 3 (real hardware). |
| WebSocket / http-poll | — | Phase 3 (real hardware). |

### `src/client/` → public API layer
| File | Status | Notes |
|---|---|---|
| `src/client/create-sync.ts` | REAL | `createSync(config: SyncConfig): SyncClient`. Client-side multiplexer: `Map<string, ScopeEntry>` — one `Engine` per scope-config (B1). Wires `transport.receive → engine.apply` (demux by `batch.scope.key`) and `onBatch → transport.send` (relay). T3 reconnect fork: ephemeral scopes → `engine.snapshot()` resend; durable scopes → `engine.changes(scope, lastCursor)` incremental replay. `replayVersion` counter cancels superseded replay loops. `ScopeHandle`: `set`/`do` (verb-per-kind, mint version internally), `subscribe` (cursor stripped → `readonly Change[]`), `snapshot` (`Promise<readonly Change[]>`), `onConflict` (manual mode only), `close` (idempotent, sets `handleClosed`). `closedKeys` tombstone prevents silent re-registration. `client.close()` propagates via `handle.close()` on all held references. |
| `src/index.ts` | REAL | Public barrel. Runtime exports: `createSync`, `lww`, `vectorClock`. Type-only exports: `ScopeConfig`, `ScopeHandle`, `SyncClient`, `SyncConfig`, `WriteOpts`, `Change`, `Conflict`, `Lifetime`, `Resolution`, `Subscription`, `Transport`. No `Cursor`, `Version`, `Engine`, `ResolverPump`, or construction helpers. |

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
| `test/engine/engine.test.ts` | REAL | 24 tests covering P1–P12 (harness + Phase 1b engine). Harness tests (P1–P7, 10 tests) verify convergence harness machinery and engine gate coverage. Engine tests (P8–P12, 14 tests) cover gossip wired via `Engine.subscribe()` + `ChannelSimulator`. P8: reconnect replay via `changes(since)`; P9: 3-replica contention under partition; P10: LWW cross-instance tiebreaking; P11: ephemeral preserves durable base; P12: per-scope seenIds. |
| `test/engine/phase2-conflict.test.ts` | REAL | 12 tests covering Q1–Q7 (Phase 2 gate). Q1: vector clock concurrent detection (4 tests). Q2: Model C detect-and-hold (2). Q3: ResolverPump resolver invocation. Q4: 2-replica convergence under fault injection with deterministic resolver (2). Q5: defer holds + subsequent resolution + no-op on non-conflicting unit (2). Q6: last-confirmed-winner reads during open conflict. |

### `test/client/` and `test/types/`
| File | Status | Notes |
|---|---|---|
| `test/client/create-sync.test.ts` | REAL | 80 tests covering all G2 gates: G2-3 (transport wiring + relay + ChannelSimulator fault injection), G2-4 (per-scope conflict isolation), G2-5 (auto/manual resolution), G2-6 (cursor stripping — subscribe, snapshot, reconnect), G2-6d (durable replay lastCursor correctness), config.scopes pre-registration, handle lifecycle (set/do/snapshot throw after close, scope(closedKey) throw), prevVersions drift regression. |
| `test/types/public-surface.test.ts` | REAL | 14 type-level tests: `ScopeHandle` method signatures, `SyncClient`/`SyncConfig`/`createSync`/`WriteOpts` type surface, barrel re-exports for all six primitive types + four client types (`toEqualTypeOf` from barrel). |
| `test/types/no-token-leak.test.ts` | REAL | **G2-1 gate (automated, mutation-verified).** G2-1a: `@ts-expect-error` assertions on 11 forbidden tokens (`Cursor`, `Version`, `Engine`, `ResolverPump`, `makeChangeId`, `makeConflictUnit`, `makeCursor`, `makeScope`, `resolveConflict`, `getCursor`, `DURABLE`) — `pnpm typecheck` fails if any is added to barrel. G2-1b: `Object.keys(barrel)` equality against exact allow-list `{createSync, lww, vectorClock}` — any new runtime export fails. G2-1c: positive assertion that `Change.version` exists (accepted residual, per decision-log 2026-06-29 — guards against over-tightening). |

### `integration/`
| File | Status | Notes |
|---|---|---|
| multi-replica + real-transport composition | — | Phase 3+. Owns no module; routes bugs to owning stream. |

---

## Load-bearing seams (real signatures)

### Production seams (real)

**`Engine.apply(batch: ChangeBatch): Promise<void>`**
Branches on `change.kind`. State: per-scope seenIds dedup, then `ClockStrategy.compare(incoming,
currentWinner)` — `"after"` accepts, `"before"` skips, `"concurrent"` → Model C detect-and-hold
(records open conflict in `openConflicts`, fires `onConflict` notification, returns without adding
id to seenIds). Op (no version): seenIds dedup only. Op (with version): seenIds dedup, then
version compare (`"concurrent"` arm still deferred for ops — needs full VersionedChange per unit).
T3 fork: durable → advance `cursorSeq` + append to `durableLog`; ephemeral → update
`ephemeralStateUnits` only. Fires subscriptions synchronously for accepted changes (required for
drain-round correctness). Returns `Promise.resolve()` — synchronous internally.

**`Engine.changes(scope, since: Cursor | null): AsyncIterable<ChangeBatch>`**
Yields durable log entries with `seq > since._seq` (or all if `since` is null) as a single
`ChangeBatch`. Ephemeral changes never appear. Cursor on the yielded batch reflects the last
durable seq.

**`Engine.snapshot(scope): Promise<Snapshot>`**
Returns the per-unit winner from `durableStateUnits` ∪ `ephemeralStateUnits` (higher version
wins per unit). No cursor. Ephemeral values are live current state even though they are not in
the durable log. Durable base is preserved in `durableStateUnits` even when ephemeral wins.

**`Engine.subscribe(scope, { onBatch, onConflict }): Subscription`**
Registers per-scope handlers. `onBatch` fires synchronously in `apply()` for each accepted
batch. `onConflict` is live as of Phase 2: fires synchronously in the `concurrent` arm of
`_applyState` as a notification (return value ignored — Model C). `unsubscribe()` is idempotent.

**`Engine.getCursor(scope): Cursor`**
Returns `makeCursor(scope, cursorSeq)`. Not on the `Feed` interface — test assertion helper only.
Cursors are engine-local ordinals: NOT safe to use cross-replica.

**`LWWClockStrategy.mint(prev?): Version`**
Lamport-style advance: `_counter = max(_counter, prev._ts) + 1`. Returns `{ _ts, _node }` cast
to `Version`. `_node` is a per-instance unique id (module-level counter or explicit in ctor).

**`LWWClockStrategy.compare(a, b): "before" | "after" | "concurrent"`**
Orders by `_ts` first; ties broken by `_node`. Never returns `"concurrent"` — LWW's defining
property. An identical `(_ts, _node)` pair returns `"before"` (idempotent re-apply).

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

### Finding — `seenIds` sets grow unbounded [MED — Phase 3]
Per-scope `Set<string>`, no eviction or TTL. Correct for the in-memory Phase 2 sandbox.
A real persistence layer (Phase 3) needs a compaction or sliding-window eviction strategy.

### Finding — `_applyOp` concurrent arm still deferred [Phase 2 follow-up]
`_applyOp` stores only the last accepted `Version` per unit in `opUnitVersions`, not the full
`VersionedChange`. A correct `Conflict` payload requires both `local` and `remote` as
`VersionedChange`. Fix: store the full `VersionedChange` in `opUnitVersions` (rename to
`opUnitChanges: Map<string, VersionedChange>`). Out of scope for Phase 2 per the gate file.

### Finding — G2-6d: client T3 durable-fork has no `onConnect`-firing test [sandbox — schedule next pass]
The durable replay branch in `create-sync.ts` (`engine.changes(scope, lastCursor)` inside the
`transport.onConnect()` handler) is live code but is not triggered by any current test. The G2-6d
test exercises engine-level dedup via direct `tB._deliver()` calls — it does not fire
`transport.onConnect()`. The branch logic is deterministic and sandbox-testable today; no real hardware
required. Tracked as an open gate in `decision-log.md`.

### Deferred (reason recorded)
- **seenIds eviction** → Phase 3 (persistence).
- **`changes()` single-batch / no chunking** → Phase 3 (production log ergonomics).
- **`onBatch` subscriber error isolation** → FIXED (G2 — per-callback try/catch in fan-out loop).
- **`InProcessTransport` connect/disconnect lifecycle (`_setConnected`) / T3 client durable-fork** →
  G2-6d gap (see above). Durable branch exists and is exercised at engine level; `onConnect` path
  untested.
- **`_applyOp` concurrent arm** → Phase 3 (needs full VersionedChange per unit;
  state-path conflicts proven in Phase 2; op-path is independent follow-up).
- **`lastCursor` persistence** → Phase 3 (in-memory; process restart replays from log start).
- **`transport.send` retry/backpressure/ack** → Phase 5 (`.catch()` sites are the seam; documented).
- **`closedKeys` growth bound** → Phase 5 (grows with scope churn; acceptable at current cardinality).

---

## Open gates affecting code (mirror of decision-log Current State)

- **Standalone (locked)** — no `neutro/*` runtime dependency ever enters `src/core`. A reactive
  consumer binds to `ns` on its own side; there is no `ns`-side adapter package in core scope.
- **G2 Public API** — CLOSED 2026-06-29. Implementation complete, automated, mutation-verified.
- **G2-6d** — client T3 durable-fork (`onConnect` path) has no test. Sandbox-testable; schedule
  in the next runtime/integration pass.
- **G3 LCD-risk** — the conformance suite is the eventual evidence; not blocking current phases.
