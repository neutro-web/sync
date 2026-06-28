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

Last verified against source: **2026-06-28 (Phase 2 complete — conflict resolution activated).** Seam Contract **v1.0**.

---

## Status: PHASE 2 CONFLICT RESOLUTION COMPLETE — vector clock, Model C engine, ResolverPump

The T4 `concurrent` path activated in Phase 2. `VectorClockStrategy` is the first strategy
returning `"concurrent"`. Engine now implements Model C (detect-and-hold): the `concurrent` arm
records open conflicts in `ScopeState.openConflicts`, fires `onConflict` as a notification, and
returns synchronously — `apply()` never awaits resolution. `resolveConflict(scope, unit, resolution)`
lands a resolution directly into the confirmed maps. `ResolverPump` bridges `onConflict` →
`resolver.resolve` → `resolveConflict` as an optional layer. Convergence proven on 2 replicas
under fault injection using approach (a): deterministic pure-function resolver (pick-by-id).
Q1–Q7 gate passing; 40 tests total (36 + 4 audit fixes); `tsc --noEmit` clean.

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
| `src/core/engine.ts` | REAL | `Engine implements Feed, ScopeRouter`. In-memory. T1 kind branching; T2 version opacity (only `compare()` called); T3 lifetime fork (ephemeral off durable path); T4 `concurrent` path activated (Model C); T5 per-scope causal order via synchronous subscription dispatch. `getCursor(scope)` for test assertions. `resolveConflict(scope, unit, resolution)` for manual/automatic resolution. |
| conflict detection (`concurrent` path) | REAL | Model C detect-and-hold. `ScopeState.openConflicts` holds both competing `VersionedChange`s per unit. `concurrent` arm fires `onConflict` as notification, returns synchronously. `resolveConflict(scope, unit, resolution)` lands resolution directly into confirmed maps; advances cursor/log for durable wins. `take-local`/`take-remote` supported; `defer` leaves conflict open; `merged` throws (deferred — requires `ClockStrategy.mergeVersions`). Note: `_applyOp` concurrent arm consciously deferred — op-with-version path stores only `Version`, not full `VersionedChange`; needs follow-up. |
| scope routing (`ScopeRouter`) | REAL | `Engine.subscribe(scope, { onBatch, onConflict })` → `Subscription`. Per-scope; fires synchronously on accepted changes. |
| `src/core/resolver-pump.ts` | REAL | `ResolverPump`. Subscribes to `onConflict`; calls `resolver.resolve(conflict)`; calls `resolveConflict` with the result. Async resolvers: returns `defer` synchronously while the promise settles. Absent ⇒ conflicts stay open for manual resolution. Closes Phase 1b Finding #3 (Resolver/onConflict were dead under all paths). |

### `src/strategies/` → `@neutro/sync/strategies`
| File | Status | Notes |
|---|---|---|
| `src/strategies/lww.ts` | REAL | `LWWClockStrategy implements ClockStrategy`. Lamport-style counter; `mint(prev?)` advances past `prev._ts`. `compare()` returns `"before"` or `"after"`, **never `"concurrent"`**. Internal version shape: `{ _ts: number, _node: number }` — `_node` breaks equal-`_ts` ties deterministically. Strategy-owned, opaque to engine. |
| `src/strategies/vector-clock.ts` | REAL | `VectorClockStrategy implements ClockStrategy`. Version shape: `{ _vec: Record<nodeId, number> }`. `mint(prev?)` merges prev vector then increments own slot. `compare()` returns `"concurrent"` for causally-independent versions; `"before"`/`"after"` for ordered versions. First strategy to exercise T4 conflict path. |
| CRDT-position strategy | — | Phase 3+. |

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
| `test/engine/engine.test.ts` | REAL | 24 tests covering P1–P12 (harness + Phase 1b engine). Harness tests (P1–P7, 10 tests) verify convergence harness machinery and engine gate coverage. Engine tests (P8–P12, 14 tests) cover gossip wired via `Engine.subscribe()` + `ChannelSimulator`. P8: reconnect replay via `changes(since)`; P9: 3-replica contention under partition; P10: LWW cross-instance tiebreaking; P11: ephemeral preserves durable base; P12: per-scope seenIds. |
| `test/engine/phase2-conflict.test.ts` | REAL | 12 tests covering Q1–Q7 (Phase 2 gate). Q1: vector clock concurrent detection (4 tests). Q2: Model C detect-and-hold (2). Q3: ResolverPump resolver invocation. Q4: 2-replica convergence under fault injection with deterministic resolver (2). Q5: defer holds + subsequent resolution + no-op on non-conflicting unit (2). Q6: last-confirmed-winner reads during open conflict. |

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

### Deferred (reason recorded)
- **seenIds eviction** → Phase 3 (persistence).
- **`changes()` single-batch / no chunking** → Phase 3 (production log ergonomics).
- **`onBatch` fires synchronously; a throwing subscriber breaks `apply`** → contract note:
  subscription handlers must not throw; no code change needed.
- **`InProcessTransport` connect/disconnect lifecycle untested** → Phase 3 (real transport
  work; `_setConnected` fires handlers but the T3 reconnect fork is not exercised).
- **`_applyOp` concurrent arm** → Phase 3 (needs full VersionedChange per unit;
  state-path conflicts proven in Phase 2; op-path is independent follow-up).

---

## Open gates affecting code (mirror of decision-log Current State)

- **Standalone (locked)** — no `neutro/*` runtime dependency ever enters `src/core`. A reactive
  consumer binds to `ns` on its own side; there is no `ns`-side adapter package in core scope.
- **G2 Public API** — do not create a frozen public client/builder; sketches are design docs.
- **G3 LCD-risk** — the conformance suite is the eventual evidence; not blocking Phase 2.
- **Phase 2 entry condition** — `concurrent` → `Resolver` path requires a strategy that
  produces `concurrent` (logical/hybrid clock or CRDT position). That is Phase 2's first gate.
