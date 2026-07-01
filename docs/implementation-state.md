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

Last verified against source: **2026-06-30 (Phase 3 Persistence D0–D7 complete; Phase B B1/B2 complete, B3 finding open; Phase 3 Real Transports T0–T7 complete; T3-BC/T6 test-depth fix pass complete same day).** Seam Contract **v1.1**.

---

## Status: PHASE 3 REAL TRANSPORTS COMPLETE — `BroadcastChannelTransport`, `WebSocketTransport`, wire codec, WS relay fixture

Phase 3 Persistence (D0–D7) is complete. **D0** resolved cursor-advancement semantics (durable-accept, cursor-gated
seenIds). **D1–D5** built the pluggable persistence substrate: `PersistenceStore` interface + `MemoryStore` (D1),
real `IndexedDBStore` with dual schema (changes + cursors, D2–D5), and replay-after-reload with durable
cursor recovery + op-dedup across restart. **D6** chunked `changes()` replay. **D7** captured baseline
numbers (durable write latency, replay throughput, reload-to-ready). Phase B landed `CRDTPositionStrategy`
(B1) and op-concurrent routing through Model C (B2); B3 surfaced a confirmed defect in the durable reconnect
branch (see "Known gaps" below). Phase 3 Real Transports (T0–T7) is now also complete: `BroadcastChannelTransport`
(cross-tab, gate T1/T2/T3-BC) and `WebSocketTransport` (cross-device, gate T4) both implement `Transport` against
the frozen seam contract with no changes to `src/transports/in-process.ts`, `src/core/types.ts`,
`docs/seam-contract.md`, or `test/harness/`; a JSON wire codec (`wire-codec.ts`) provides the WebSocket
serialize/deserialize boundary; a WS relay fixture backs the WebSocket test/bench suite. **T3-BC and T6 verify
engine-local reconnect only**: a minimal, test-local durable reconnect fork
(`onConnect` → `engine.changes(cursor)` → `transport.send()`, built directly on the raw Engine +
Transport seam, deliberately NOT `create-sync.ts`'s fork) wired onto real transport lifecycle
events (a real `pageshow` DOM event for BroadcastChannel; a real socket `open` after reconnect for
WebSocket) — proving the persistence and transport layers compose and that ephemeral state is
excluded from cursor replay (T3). This is NOT peer-pull recovery across two separate peers, and
does NOT claim `create-sync.ts`'s own fork works; the B3 defect (peer reconnect recovery) remains
open for Phase 5 (see "Known gaps" below). **151/151 node tests, 24/24 browser tests, 3/3 e2e specs
passing**; `tsc --noEmit` clean; lint clean.
Seam Contract **v1.1** frozen (no T1–T5 change; regression-guard diff against frozen files is empty).

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
| `vitest.config.ts` | REAL | Node workspace + `vitest.browser.config.ts` for browser workspace. `pnpm test` runs node; `pnpm test:browser` runs browser (IndexedDBStore + real reload tests). |
| `.gitignore` | REAL | Covers: `node_modules/`, `dist/`, `*.tsbuildinfo`, `coverage/`, logs, OS files, editors, `.env*`, `*.tmp`. |

### `src/core/` → `@neutro/sync/core` (the engine)
| File | Status | Notes |
|---|---|---|
| `src/core/types.ts` | REAL | Full TypeScript expression of seam contract v1.0. All eight seam types: `Change`/`StateChange`/`OpChange`/`VersionedChange`, `Cursor`/`Version`/`ClockStrategy`, `Lifetime`, `ChangeBatch`/`Snapshot`/`Feed`, `Conflict`/`Resolution`/`Resolver`, `Scope`/`Subscription`/`ScopeRouter`, `Transport`, opaque tokens. Factory helpers: `makeChangeId`, `makeScope`, `makeConflictUnit`, `makeCursor`, `DURABLE`, `ephemeral`. |
| `src/core/persistence.ts` | REAL | `PersistenceStore` interface + `MemoryStore` implementation. Slot discipline: no engine internals in the contract; `write(batch)` + `read(scope, cursor)` seam for fire-and-forget writes only. Opaque change records; no domain types. |
| `src/core/engine.ts` | REAL | `Engine implements Feed, ScopeRouter`. In-memory core (durable log + cursor kept optionally backed by `PersistenceStore`). T1 kind branching; T2 version opacity (only `compare()` called); T3 lifetime fork (ephemeral off durable path); T4 `concurrent` path activated for BOTH state and op (Model C, Phase B / B2); T5 per-scope causal order via synchronous subscription dispatch. Constructor opts: `{resolver?, store?, chunkSize?}`. `hydrateScope(scope): Promise<void>` loads durable state from store. `getCursor(scope)` for test assertions. `changes(scope, since?, chunkSize?)` yields bounded chunks. `resolveConflict(scope, unit, resolution)` for manual/automatic resolution, generalized by `change.kind` (state winners land in the state-unit maps, op winners in `opUnitChanges` only). |
| conflict detection (`concurrent` path) | REAL | Model C detect-and-hold, live on BOTH the state path (`_applyState`) and the op path (`_applyOp`, Phase B / B2). `ScopeState.openConflicts` holds both competing `VersionedChange`s per unit (state or op — never mixed within one entry). `concurrent` arm fires `onConflict` as notification, returns synchronously. `resolveConflict(scope, unit, resolution)` lands resolution via `_landChange`, generalized by `change.kind`: a state winner lands in `durableStateUnits`/`ephemeralStateUnits`; an op winner lands in `opUnitChanges` only, never the state maps. `take-local`/`take-remote`/`merged` all supported on both paths; `defer` leaves conflict open. **Convergence expectation documented in seam-contract.md §5: local resolver MUST be a deterministic pure function.** |
| scope routing (`ScopeRouter`) | REAL | `Engine.subscribe(scope, { onBatch, onConflict })` → `Subscription`. Per-scope; fires synchronously on accepted changes. |
| `src/core/resolver-pump.ts` | REAL | `ResolverPump`. Subscribes to `onConflict`; calls `resolver.resolve(conflict)`; calls `resolveConflict` with the result. Async resolvers: returns `defer` synchronously while the promise settles. Absent ⇒ conflicts stay open for manual resolution. Closes Phase 1b Finding #3 (Resolver/onConflict were dead under all paths). |

### `src/persistence/` → `@neutro/sync/persistence`
| File | Status | Notes |
|---|---|---|
| `src/persistence/idb-store.ts` | REAL | `IndexedDBStore implements PersistenceStore`. IndexedDB schema: `'changes'` (keyPath `[scopeKey, seq]`) stores durable changes; `'cursors'` (keyPath `scopeKey`) stores per-scope cursor records (`{scopeKey, seq}`). Dual schema for efficient per-scope replay and cursor positioning. Fire-and-forget writes only (no await). |

### `src/strategies/` → `@neutro/sync/strategies`
| File | Status | Notes |
|---|---|---|
| `src/strategies/lww.ts` | REAL | `LWWClockStrategy implements ClockStrategy`. Lamport-style counter; `mint(prev?)` advances past `prev._ts`. `compare()` returns `"before"` or `"after"`, **never `"concurrent"`**. Internal version shape: `{ _ts: number, _node: number }` — `_node` breaks equal-`_ts` ties deterministically. Strategy-owned, opaque to engine. |
| `src/strategies/vector-clock.ts` | REAL | `VectorClockStrategy implements ClockStrategy`. Version shape: `{ _vec: Record<nodeId, number> }`. `mint(prev?)` merges prev vector then increments own slot. `compare()` returns `"concurrent"` for causally-independent versions; `"before"`/`"after"` for ordered versions. `mergeVersions(a, b)` returns element-wise max (causal join, no local-slot increment) — seam v1.1. |
| `src/strategies/index.ts` | REAL | Public factory functions: `lww(nodeId?: number): ClockStrategy`, `vectorClock(nodeId: string): ClockStrategy`, `crdtPosition(nodeId: string): ClockStrategy`. All return `ClockStrategy` interface (no concrete class leak). `nodeId` required on `vectorClock` and `crdtPosition`. |
| `src/strategies/crdt-position.ts` | REAL | `CRDTPositionStrategy implements ClockStrategy`. Position-ordered (Dewey-decimal-style path); scope-bounded — not a full sequence CRDT (see decision-log Phase B / B1 entry). `compare()` is a lexicographic total order on distinct paths; `concurrent` only on an exactly-equal path from a different `_node`. `mergeVersions()` required (concurrent is reachable) — symmetric, deterministic tag derived from both inputs' `_node`, never the caller's own. Exported via `crdtPosition(nodeId)` from `src/strategies/index.ts` (strategies subpath only — not in the G2 public barrel). |

### `src/transports/` → `@neutro/sync/transports`
| File | Status | Notes |
|---|---|---|
| `src/transports/in-process.ts` | REAL | `InProcessTransport implements Transport`. `channelFn` injectable by harness. `send()` resolves on hand-off (§7). `_deliver()` for inbound push. `_setConnected()` fires connect/disconnect handlers (T3 reconnect lifecycle hook). `static pair()` for direct no-fault pairing. |
| `src/transports/broadcast-channel.ts` | REAL | `BroadcastChannelTransport implements Transport`, real cross-tab transport over `BroadcastChannel`. `send()` resolves on `postMessage` hand-off (§7), not ack. No native connect/disconnect event on `BroadcastChannel`, so tab lifecycle (`pageshow`/`pagehide`) is mapped onto `onConnect`/`onDisconnect` (gate T3-BC). `close()` tears down the channel and window listeners. |
| `src/transports/websocket.ts` | REAL | `WebSocketTransport implements Transport`, real cross-device transport over a `WebSocket` client connection (gate T4). `WebSocketImpl` injectable (Node tests pass `ws`'s class; browser/runtime defaults to global `WebSocket`, keeping `ns` dependency-free at runtime). `send()` queues client-side and flushes on `onopen` if the socket isn't open yet — still hand-off semantics, no ack/retry/backpressure (§7). Uses `wire-codec.ts` to encode/decode messages. |
| `src/transports/wire-codec.ts` | REAL | `encodeBatch`/`decodeBatch` — plain `JSON.stringify`/`JSON.parse` wire codec for `ChangeBatch`, the WebSocket transport's serialize/deserialize boundary (gate T0-2). Branded types (`Version`/`Cursor`/etc.) are compile-time only and survive JSON as structurally-equivalent plain objects; no runtime re-casting needed since `ClockStrategy.compare()`/`mergeVersions()` operate structurally. |

### `src/client/` → public API layer
| File | Status | Notes |
|---|---|---|
| `src/client/create-sync.ts` | REAL | `createSync(config: SyncConfig): SyncClient`. `SyncConfig` now includes `store?: PersistenceStore` and `chunkSize?: number` for replay batching. Client-side multiplexer: `Map<string, ScopeEntry>` — one `Engine` per scope-config (B1). Wires `transport.receive → engine.apply` (demux by `batch.scope.key`) and `onBatch → transport.send` (relay). Hydration on scope registration: calls `engine.hydrateScope(scope)` if store present. T3 reconnect fork: ephemeral scopes → `engine.snapshot()` resend; durable scopes → `engine.changes(scope, lastCursor)` incremental replay. `replayVersion` counter cancels superseded replay loops. `ScopeHandle`: `set`/`do` (verb-per-kind, mint version internally; `do` accepts `WriteOpts.opId?` for consumer-supplied stable op id — NF-1, dedup-safe redelivery), `subscribe` (cursor stripped → `readonly Change[]`), `snapshot` (`Promise<readonly Change[]>`), `onConflict` (manual mode only), `close` (idempotent, sets `handleClosed`). `closedKeys` tombstone prevents silent re-registration. `client.close()` propagates via `handle.close()` on all held references. **Known defect (Phase B / B3, NOT fixed here):** the `transport.onConnect()` durable replay branch (`engine.changes(scope, lastCursor)`) is structurally inert — see "Known gaps" below. |
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

### `test/persistence/`
| File | Status | Notes |
|---|---|---|
| `test/persistence/memory-store.test.ts` | REAL | MemoryStore contract compliance tests: basic write/read, per-scope isolation, cursor positioning. |
| `test/persistence/idb-store.test.ts` | REAL | IndexedDBStore functional + durability tests: real IndexedDB write/read, schema validation, per-scope change storage, cursor record isolation. (Node via fake-indexeddb). |

### `test/engine/`
| File | Status | Notes |
|---|---|---|
| `test/engine/engine.test.ts` | REAL | 24 tests covering P1–P12 (harness + Phase 1b engine). Harness tests (P1–P7, 10 tests) verify convergence harness machinery and engine gate coverage. Engine tests (P8–P12, 14 tests) cover gossip wired via `Engine.subscribe()` + `ChannelSimulator`. P8: reconnect replay via `changes(since)`; P9: 3-replica contention under partition; P10: LWW cross-instance tiebreaking; P11: ephemeral preserves durable base; P12: per-scope seenIds. |
| `test/engine/engine-chunking.test.ts` | REAL | D6 gate tests: `changes()` chunking with bounded `chunkSize`, per-scope causal order preserved across chunk boundaries, large log stress test. |
| `test/engine/phase2-conflict.test.ts` | REAL | 12 tests covering Q1–Q7 (Phase 2 gate). Q1: vector clock concurrent detection (4 tests). Q2: Model C detect-and-hold (2). Q3: ResolverPump resolver invocation. Q4: 2-replica convergence under fault injection with deterministic resolver (2). Q5: defer holds + subsequent resolution + no-op on non-conflicting unit (2). Q6: last-confirmed-winner reads during open conflict. |
| `test/engine/phaseB-op-conflict.test.ts` | REAL | 5 tests covering B2-2..B2-5 (B2-1 is a typecheck/grep check, no runtime test). Op-with-version concurrent detect-and-hold, resolveConflict landing on the op path (durable + ephemeral), 2-replica convergence under fault injection via a deterministic pick-by-id resolver, pure-intent-op regression. |
| `test/strategies/crdt-position.test.ts` | REAL | 13 tests covering B1-2..B1-5 (B1-1 is a typecheck/grep check). `compare` total-order + concurrent-on-equal-position semantics; `mergeVersions` dominance + replica-identical (verified via two DIFFERENT strategy instances, not the same one twice); 2-replica state convergence (B1-4) and op convergence (B1-5, depends on B2) under fault injection via a `merged` resolver. |

### `test/client/` and `test/types/`
| File | Status | Notes |
|---|---|---|
| `test/client/create-sync.test.ts` | REAL | 80 tests covering all G2 gates: G2-3 (transport wiring + relay + ChannelSimulator fault injection), G2-4 (per-scope conflict isolation), G2-5 (auto/manual resolution), G2-6 (cursor stripping — subscribe, snapshot, reconnect), G2-6d (durable replay lastCursor correctness), config.scopes pre-registration, handle lifecycle (set/do/snapshot throw after close, scope(closedKey) throw), prevVersions drift regression. |
| `test/client/reconnect.test.ts` | REAL | 3 tests. **Not a gate closure** — a deliberate characterization of the confirmed B3 defect (durable reconnect-replay is structurally inert), kept green as a regression trip-wire. See decision-log Phase B / B3 entry and "Known gaps" below. |
| `test/types/public-surface.test.ts` | REAL | 14 type-level tests: `ScopeHandle` method signatures, `SyncClient`/`SyncConfig`/`createSync`/`WriteOpts` type surface, barrel re-exports for all six primitive types + four client types (`toEqualTypeOf` from barrel). |
| `test/types/no-token-leak.test.ts` | REAL | **G2-1 gate (automated, mutation-verified).** G2-1a: `@ts-expect-error` assertions on 11 forbidden tokens (`Cursor`, `Version`, `Engine`, `ResolverPump`, `makeChangeId`, `makeConflictUnit`, `makeCursor`, `makeScope`, `resolveConflict`, `getCursor`, `DURABLE`) — `pnpm typecheck` fails if any is added to barrel. G2-1b: `Object.keys(barrel)` equality against exact allow-list `{createSync, lww, vectorClock}` — any new runtime export fails. G2-1c: positive assertion that `Change.version` exists (accepted residual, per decision-log 2026-06-29 — guards against over-tightening). |

### `test/browser/`
| File | Status | Notes |
|---|---|---|
| `vitest.browser.config.ts` | REAL | Browser test runner config (via `@vitest/browser`). Runs in real browser or headless; targets IndexedDB persistence tests. |
| `test/browser/smoke.test.ts` | REAL | D3–D5 gate tests: real page reload (or worker restart), IndexedDBStore hydration, persisted cursor recovery, op-dedup across restart. |

### `bench/`
| File | Status | Notes |
|---|---|---|
| `bench/persistence.bench.ts` | REAL | D7 baseline measurements: durable write latency (per-call cost, fire-and-forget), replay throughput (changes/sec from 1000 records), reload-to-ready time. Browser-based; runs via `pnpm bench`. Measurement semantics documented inline. |

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

## Known gaps (Phase 5)
- **Open conflicts not persisted**: if a process terminates while a conflict is unresolved, the remote competing change is lost from memory. Re-delivery after reload re-triggers the conflict correctly (T1 idempotency), but the behavior across a reload boundary is undocumented. Phase 5 conflict resolution work should address this.

## Known gaps / defects

### RESOLVED — `seenIds` eviction strategy [Phase 3 / D0–D5, 2026-06-30]
Per-scope `Set<string>` now uses cursor-gated compaction: changes with `seq ≤ persisted
cursorSeq` are implicitly seen on reload (already in persisted log); only in-flight window
above cursor is held in memory. Pure-intent ops (no `seq`) are in-memory only, cleared on
restart. See decision-log Phase 3 / D0 entry and `docs/design/cursor-advancement.md`.

### RESOLVED — `_applyOp` concurrent arm [Phase B / B2, 2026-06-30]
`opUnitVersions: Map<string, Version>` is now `opUnitChanges: Map<string, VersionedChange>`;
the concurrent arm routes through Model C exactly like the state path. See decision-log
Phase B / B2 entry.

### RESOLVED — `changes()` single-batch chunking [Phase 3 / D6, 2026-06-30]
`changes(scope, since?, chunkSize?)` now yields durable log in bounded chunks (configurable
per engine, default size). Per-scope causal order preserved across chunk boundaries. Tested
in `test/engine/engine-chunking.test.ts`. See decision-log Phase 3 / D6 entry.

### Finding — durable reconnect-replay branch is structurally inert [Phase B / B3, HIGH, 2026-06-30]
`create-sync.ts`'s `transport.onConnect()` durable-replay branch
(`engine.changes(scope, entry.lastCursor)`) can never emit a batch: `entry.lastCursor` is
updated synchronously in the same `onBatch` callback that's the only path by which the
durable log grows, so it always equals the engine's own cursor by the time `onConnect`
fires — confirmed by execution (`test/client/reconnect.test.ts`), not just by reading.
Separately, the mechanism only republishes THIS engine's own log (broadcast), never pulls
a peer's — so it cannot recover a peer's missed writes regardless of `lastCursor` timing.
Fix requires deciding when `lastCursor` advances (confirmed-delivery, not durable-accept)
and/or a pull-based catch-up seam — both are §7 delivery-above-transport territory
(Phase 5). NOT fixed in Phase 3; see decision-log Phase B / B3 entry.

**Phase 3 Real Transports (T0–T7, 2026-06-30) does not close this finding.** The new
`test/e2e/broadcast-channel-reconnect.spec.ts` (gate T3-BC) and `test/websocket/websocket-reconnect.test.ts`
(gate T6) verify **engine-local reconnect only** — the same engine instance reconnecting to its own
transport after a disconnect/reload, hydrating its own durable writes. Neither test exercises
peer-pull recovery across two separate peers (one peer catching up on another peer's writes made
while disconnected). The B3 defect described above — the durable reconnect-replay branch cannot
pull a peer's missed writes — remains open for Phase 5.

**Fix pass, 2026-06-30 (post-audit):** an earlier draft of T3-BC/T6 undersold this even further —
T3-BC never touched `BroadcastChannelTransport` at all (pure IndexedDB hydration test with no
transport in the loop), and T6 constructed a `WebSocketTransport` but never had its `onConnect`
actually drive any replay (inert set dressing next to a separately-rehydrated `Engine`). Both were
rewritten to build a **minimal, test-local "durable reconnect fork"** directly on the raw
`Engine` + `Transport` seam — NOT `create-sync.ts`'s fork (which the B3 finding proves can never
emit a replay batch; do not conflate the two): an `onConnect` handler registered in the test itself
that calls `engine.changes(scope, lastCursorBeforeDisconnect)` and forwards each batch via
`transport.send()`, wired onto a REAL `BroadcastChannelTransport` (driven by a real
`window.dispatchEvent(new Event("pageshow"))`) and a REAL `WebSocketTransport` (driven by an
actual socket close + a fresh socket's real `open` event over the WS relay fixture). Both tests
now also add an ephemeral change (`lifetime: ephemeral(ttlMs)`) alongside the durable one and
assert it is excluded from the cursor-based replay (only the durable tail is sent) — closing the
previously-asserted-but-unexercised "ephemeral does not survive" claim (T3). Separately,
`test/browser/broadcast-channel.test.ts` gained direct coverage of
`src/transports/broadcast-channel.ts`'s `pageshow`/`pagehide` → `onConnect`/`onDisconnect` mapping
(previously zero coverage): real `window.dispatchEvent` of both events against a real
`BroadcastChannelTransport`, asserting the registered handlers fire (and stop firing after
`close()`). **This still does not prove peer-pull recovery, and it does not prove `create-sync.ts`'s
own fork works — B3 remains open, unaffected, Phase 5.** It proves the engine-local composition
works when something (here, a minimal test-local fork) correctly drives
`engine.changes(cursor)` from a transport's real connect lifecycle event.

### OPEN (Phase 5) — Peer-recovery / pull-based catch-up seam
The durable-reconnect finding's second half (the mechanism only self-publishes, never pulls
a peer's missed writes) is explicitly deferred to Phase 5 as a delivery-above-transport
concern (§7). Engine-local replay-after-reload (D3–D5) is now closed.

### OPEN (Phase 5) — `transport.send` retry/backpressure/ack
Fire-and-forget `send()` semantics remain (§7). Delivery guarantees and retry logic built
on cursor/replay will be Phase 5 work. Documented at retry sites in the code.

### Deferred (reason recorded)
- **`onBatch` subscriber error isolation** → FIXED (G2 — per-callback try/catch in fan-out loop).
- **`closedKeys` growth bound** → Phase 5 (grows with scope churn; acceptable at current cardinality).
- **Peer-recovery / pull-based catch-up seam** → Phase 5 (delivery-above-transport territory; B3 finding second half).
- **`lastCursor` advancement semantics (confirmed-delivery vs durable-accept)** → Phase 5 (decision-log D0 chose durable-accept for engine-local recovery; peer-recovery is Phase 5).
- **`transport.send` retry/backpressure/ack** → Phase 5 (§7 delivery-above-transport; `.catch()` sites are the seam; documented).

---

## Open gates affecting code (mirror of decision-log Current State)

- **Standalone (locked)** — no `neutro/*` runtime dependency ever enters `src/core`. A reactive
  consumer binds to `ns` on its own side; there is no `ns`-side adapter package in core scope.
- **G2 Public API** — CLOSED 2026-06-29. Implementation complete, automated, mutation-verified.
- **Phase 3 Persistence (D0–D7)** — CLOSED 2026-06-30. Pluggable persistence + IndexedDB + replay-after-reload + baseline numbers. **142 tests passing**.
- **Phase 3 Real Transports (T0–T7)** — CLOSED 2026-06-30; T3-BC/T6 test depth fixed same day
  (post-audit). `BroadcastChannelTransport` + `WebSocketTransport` + wire codec + WS relay
  fixture, real against the frozen seam contract. T3-BC/T6 now compose a minimal test-local
  durable reconnect fork (`onConnect` → `engine.changes(cursor)` → `transport.send()`) onto real
  transport lifecycle events, and exercise ephemeral-exclusion from replay; still engine-local
  only, not peer-pull recovery (B3 remains open, see "Known gaps"). **151 node / 24 browser / 3
  e2e tests passing**.
- **G2-6d-bis** — client T3 durable-fork (`onConnect` path) is tested and confirmed
  structurally inert (see "Known gaps"). Fix is Phase 5 (delivery-above-transport) territory.
- **G3 LCD-risk** — the conformance suite is the eventual evidence; not blocking current phases.
