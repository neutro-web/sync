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

Last verified against source: **2026-06-25 (Phase 1 harness complete).** Seam Contract **v1.0**.

---

## Status: PHASE 1 HARNESS COMPLETE — real engine not yet built

The convergence harness exists and all 10 gate tests pass. `src/core/types.ts` expresses the
full seam contract in TypeScript. `src/transports/in-process.ts` is the first real transport.
The harness stubs (`NonConvergingFeed`, `TriviallyCorrectFeed`) serve as acceptance instruments
only — they are not the real engine. `Feed.apply` + cursor/replay is the next thing to build
(Phase 1b); it must pass this harness without touching it.

---

## File inventory (status per file)

Legend: **REAL** = production-complete & verified · **PARTIAL** = works for a subset ·
**STUB** = intentionally simplified; named replacement session pending · **DEFERRED** = designed,
not built · **—** = not created.

### Governance / docs
| File | Status | Notes |
|---|---|---|
| `docs/seam-contract.md` | REAL | Frozen seam semantics, v1.0. Eight seam types + T1–T5 + §9 consumer map + §9.1 local-derived rule. Authoritative for semantics. |
| `docs/decision-log.md` | REAL | Current-State + append-only Log. T1–T5 + standalone + harness findings locked; G2–G3 open. |
| `docs/implementation-state.md` | REAL | This file. |
| `docs/gates/phase1-convergence-harness.md` | REAL | Six gate items (G1–G6). Written before code per AGENTS.md discipline. All passing. |
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
| `src/core/types.ts` | REAL | Full TypeScript expression of seam contract v1.0. All eight seam types: `Change`/`StateChange`/`OpChange`/`VersionedChange`, `Cursor`/`Version`/`ClockStrategy`, `Lifetime`, `ChangeBatch`/`Snapshot`/`Feed`, `Conflict`/`Resolution`/`Resolver`, `Scope`/`Subscription`/`ScopeRouter`, `Transport`, opaque tokens. Factory helpers: `makeChangeId`, `makeScope`, `makeConflictUnit`, `makeCursor`, `DURABLE`, `ephemeral`. `ChangeBase` exported. |
| change application / `Feed.apply` | — | **Phase 1b.** Branches on `kind`: idempotent state (LWW via ClockStrategy); dedup-by-id op; op-with-version fold + conflict detection. Must pass the Phase 1 harness. |
| cursor / replay (`Feed.changes`) | — | Phase 1b. Durable-only cursor advance; replay-from-checkpoint. |
| snapshot (`Feed.snapshot`) | — | Phase 1b. Current-state-on-subscribe (ephemeral reconnect + memoryless-transport durable). |
| conflict detection | — | Phase 1b. Calls `ClockStrategy.compare`; builds value-opaque `Conflict`; routes to `Resolver`. |
| scope routing (`ScopeRouter`) | — | Phase 1b. Per-scope causal-order subscription. |

### `src/strategies/` → `@neutro/sync/strategies`
| File | Status | Notes |
|---|---|---|
| LWW `ClockStrategy` + resolver | — | Phase 2. |
| logical/hybrid clock | — | Phase 2. |
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
| `test/harness/stubs.ts` | STUB | `NonConvergingFeed` (local-only, never forwards — proves harness RED). `TriviallyCorrectFeed` (dedup by id + sync forward via `onForward` — proves harness GREEN). `LocalState` (LWW by `Version._seq`). `makeStubVersion(seq)`. Replaced by real engine in Phase 1b. |
| `test/harness/convergence-harness.ts` | REAL | `ConvergenceHarness(opts)`. N replicas, N×(N-1) directed channels seeded `channelSeed + i*100 + j`. `applyLocal(id, batch)`, `drainToQuiescence(maxRounds)` (round-based), `assertConverged()` (throws on <2 replicas), `throwIfDrainErrors()` (surfaces async apply rejections for Phase 1b). Partition/reconnect controls. Channel stats aggregation. |
| `test/harness/harness.test.ts` | REAL | 10 tests, all passing. Covers G1–G6: divergence detection, convergence on perfect channel, deterministic runs, fault injection (drop/dup/partition/reorder), ≥2-replica enforcement. |

### `integration/`
| File | Status | Notes |
|---|---|---|
| multi-replica + real-transport composition | — | Phase 3+. Owns no module; routes bugs to owning stream. |

---

## Load-bearing seams (real signatures)

### Production seams (real)

**`InProcessTransport.send(batch: ChangeBatch): Promise<void>`**
Calls `channelFn(batch)` synchronously, returns `Promise.resolve()`. Resolves on hand-off, not
ack (§7). `channelFn` defaults to a no-op; harness injects the channel simulator. Silent discard
if `channelFn` is never set — correct behavior, not a bug, but worth noting in tests.

**`InProcessTransport._deliver(batch: ChangeBatch): void`**
Called by the harness channel to push an inbound batch. Calls `_onBatch(batch)` if registered
and not closed. Checked for `_closed` before dispatch.

**`InProcessTransport._setConnected(connected: boolean): void`**
Fires registered `onConnect` / `onDisconnect` handlers. The T3 reconnect fork (replay vs.
snapshot) is triggered by these handlers in the real engine — not yet implemented.

### Harness-internal seams (not production)

**`TriviallyCorrectFeed.onForward?: (batch: ChangeBatch) => void`**
Set by `ConvergenceHarness` to route accepted changes to peer channels. Called synchronously
inside `apply()` after dedup — required for drain correctness (drain is synchronous; any await
here would break the round-based loop).

**`ConvergenceHarness.throwIfDrainErrors(): void`**
Surfaces errors from async `apply()` calls during drain. No-op for stubs (synchronous). Phase 1b
tests should call this after `drainToQuiescence()`.

### Seams pending (Phase 1b will fill these)

`Feed.apply` ⟷ `ClockStrategy.compare` ⟷ `Resolver.resolve`; `Feed.changes` ⟷ cursor store;
`ScopeRouter.subscribe` ⟷ feed delivery.

---

## Known gaps / defects

- **T3 unverified.** `LocalState` (stubs) applies all changes regardless of `lifetime`. The
  T3 fork — ephemeral never advances cursor, never persisted, never replayed — is correctly
  specified in `types.ts` but not exercised by any current test. Phase 1b gate must claim and
  test it explicitly.
- **T4 unverified.** No conflict detection in stubs. `Conflict` / `Resolver` types exist but
  the detect-and-route path is entirely untested. Phase 1b gate must claim and test it.
- **Op changes untested.** All 10 gate tests use `kind: "state"` only. The `seenIds` dedup
  path for ops, `appliedOpIds` comparison in `assertConverged`, and `LocalState`'s op branch
  are dead code relative to the current suite.
- **LWW contention untested.** No test exercises same-unit concurrent writes from two replicas
  to verify the higher `Version._seq` wins after convergence.
- **`Feed.changes()` and `Feed.snapshot()` never called.** Both stub implementations return
  empty values and are never exercised. Replay and snapshot seams are untested.
- **`InProcessTransport` connect/disconnect lifecycle untested.** `_setConnected` fires
  handlers but no test verifies the T3 reconnect fork it is meant to drive.

---

## Open gates affecting code (mirror of decision-log Current State)

- **Standalone (locked)** — no `neutro/*` runtime dependency ever enters `src/core`. A reactive
  consumer binds to `ns` on its own side; there is no `ns`-side adapter package in core scope.
- **G2 Public API** — do not create a frozen public client/builder; sketches are design docs.
- **G3 LCD-risk** — the conformance suite is the eventual evidence; not blocking Phase 1.