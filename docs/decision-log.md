# ns — Decision Log

> **How to read this file.** Two surfaces:
> 1. **Current State** (below) — the *resolved* picture: what is locked, open, or superseded
>    **right now**. This is the only section that gets *edited*. Read this first.
> 2. **Log** (further down) — an **append-only, date-timed** history of decisions and their
>    rationale. Never edit or delete entries; only append. Read oldest→newest to reconstruct
>    *how* and *why* a decision was reached.
>
> **How to write to this file.** When a session reaches a decision (locks something, opens a
> question, supersedes a prior call, or resolves a research finding), append a new dated entry
> to the Log **and** update the Current State header to match. Never rewrite history; record
> reversals as new entries that explicitly supersede the old one (cite its date). If a decision
> changes the seam contract, note the contract version bump in the entry.
>
> **Maintenance.** When the Log grows unwieldy, move superseded/stale entries to
> `decision-log-archive.md` with a one-line pointer left behind — do not delete, because a
> superseded decision's rationale is often what prevents re-making the mistake.
>
> **Authority.** The **ns Seam Contract** is the source of truth for sync-seam *semantics*.
> This log records decisions, including ones that change the contract. If this log and the
> contract conflict, the conflict must be flagged, not silently resolved.

---

## Current State

_Last updated: 2026-06-25. Seam Contract **v1.0** (frozen)._

### Status at a glance
- **Seam contract:** FROZEN at v1.0. T1–T5 ratified; eight seam types defined; §9 consumer map
  and §9.1 local-derived-state rule in place. This is the founding semantics.
- **Governance scaffold:** Complete. Charter, custom instructions, AGENTS.md, decision log,
  implementation-state all in place.
- **Code:** Phase 1b complete. Real `Engine` (`Feed` + `ScopeRouter`), `LWWClockStrategy`,
  engine gate tests. 18 tests passing. `tsc --noEmit` clean. `concurrent` → `Resolver` path
  deferred to Phase 2 (unreachable under LWW).

### Locked (do not drift without an explicit superseding entry)
- **Standalone** — `ns` has no dependency on any neutro sibling. No `neutro/*` runtime import
  ever enters `src/core`.
- **T1** — one discriminated `Change` type; `kind` encodes (idempotent, replay, ordering);
  heterogeneous batches; no feed-splitting.
- **T2** — `Cursor` (ns-owned, concrete) vs. `Version` (strategy-owned, opaque); ns's only
  versioning act is `ClockStrategy.compare()`.
- **T3** — `Lifetime` gates persistence + replay; ephemeral never advances the cursor / never
  persisted / never replayed. **Verified in Phase 1b (P4a–c).**
- **T4** — detect-not-decide; `Conflict` payload is value-opaque; four-valued `Resolution`;
  `defer` tolerated by contract. LWW path (take-by-version, no Resolver) verified in Phase 1b
  (P5). `concurrent` → Resolver path deferred to Phase 2.
- **T5** — per-scope causal order; cross-scope total order is an anti-promise.
- **§7** — delivery guarantees live above the transport; `send` resolves on hand-off, not ack.
- **OpChange.version** — optional; present only for op-transport-with-local-fold consumers.
- **Framework adapters = subpath exports** — single package, optional peer deps,
  independently tree-shakeable. Write/emit ergonomics remain part of G2.
- **Project structure** — single published package, subpath exports, mirrors nv.
- **Harness channel semantics** — partition is structural buffering; partitioned channels
  consume no RNG on enqueue; `drainToQuiescence` is round-based; `assertConverged()` throws
  on single-replica. See 2026-06-25 Phase 1 entry.
- **LWW behind the ClockStrategy slot** — `LWWClockStrategy` is the first concrete strategy.
  Never inlined into `Feed.apply`; engine calls only `compare()`. Phase 2 (logical clock,
  CRDT position) is pure addition. See 2026-06-25 Phase 1b entry.
- **`concurrent` path deferred to Phase 2** — unreachable under LWW. Branch present in
  engine; Phase 2 entry condition is a strategy that produces `concurrent` plus a concrete
  `Resolver`. See 2026-06-25 Phase 1b entry.

### Open gates (surfaced, NOT decided — do not build past)
- **G2 — Public API surface**: consumer-facing client/builder ergonomics atop the frozen seam.
  Blocks Phase 4. Sketches allowed as design docs; no frozen API.
- **G3 — LCD-risk proof**: demonstrate the universal seam isn't worse than a purpose-built
  engine per consumer. Addressed by the conformance suite; not blocking early phases.

### Superseded / resolved
- **G1 — Substrate** — RESOLVED 2026-06-24: `ns` is standalone (option a).

---

## Log

### 2026-06-24 — Seam contract frozen at v1.0 [LOCKED]
The founding design session ratified T1–T5 and froze the eight-type seam surface (`Change`,
`Cursor`/`Version`, `Lifetime`, `Feed`, `Conflict`/`Resolver`, `Scope`, `Transport`, opaque
tokens). Verified for fit against three consumer shapes during design: a reactive database
(op-transport-with-local-fold, drove the `OpChange.version` addition), a reactive form library
(three-way state/ephemeral/op split in one scope; surfaced the local-derived-state third
category, §9.1), and a reactive view engine (fit through its external-source seam; drove the
`Snapshot`-serves-memoryless-transport widening). Rationale and full surface: the Seam Contract.
This is the authoritative semantics; all later work configures against it.

### 2026-06-24 — Project bootstrap; governance scaffold established
Stood up `ns` as a multi-session claude.ai project mirroring the neutro house pattern (most
closely `nv`). Authored the Founding Charter (what ns is/isn't, axioms, roadmap, session model,
structure comparison), the project custom instructions, and `AGENTS.md`. Seeded this decision
log and the implementation-state map. No code yet.

### 2026-06-24 — Substrate gate opened then RESOLVED: ns is standalone [LOCKED — G1 closed]
Briefly opened the question of whether the ns core is (a) standalone, (b) built on nv, or (c)
nv-aware-but-independent, because the seam contract is consumer/transport-agnostic and did not
itself decide. **Resolved the same day:** `ns` is **standalone** (option a) — it follows the
neutro family pattern where every package stands alone. `ns` has no dependency on nv or any
sibling; nv and other consumers *may* use `ns`, but `ns` never depends on them. Consequence:
no `neutro/*` runtime import in `src/core`; there is no adapter package in core scope (a
reactive consumer binds to ns through ns's own public surface, on the consumer's side). This
unblocks repo shape and workstreams — both now final, not provisional.

### 2026-06-24 — Public API gate opened [OPEN — G2]
The frozen seam is the *internal* contract between engine/strategies/transports/consumers. The
*consumer-facing* convenience API (client instantiation, scope registration, transport+resolver
attachment, subscription ergonomics) is deliberately left unspecified to avoid baking a public
shape prematurely (mirrors nv's open component-API gate). Sketches welcome as design docs; no
frozen `createSync(...)`.

### 2026-06-24 — Competitive landscape verified (June 2026)
Confirmed the 2026 framing is "which sync-engine boundary?" not "CRDT or OT?", and that the
recurring practical lesson is that CRDTs solve convergence but not collaboration and most
offline-first apps need only queued-writes-that-sync. Positions ns as the universal *seam* into
which a CRDT is one pluggable resolver — not a CRDT competitor. Named the honest risk (LCD-risk,
G3): a thin universal seam must prove it isn't worse than a purpose-built engine per consumer.
Sources: CRDT-library and offline-first-stack surveys, verified not asserted from memory.

### 2026-06-24 — Framework composition model; adapter packaging = subpath exports [LOCKED]
Confirmed ns composes on (a) vanilla JS/TS as the *primary* surface and (b) every frontend
framework via thin adapters — both forced by the standalone axiom + `value:unknown` + the
"subscription delivers changes" seam, not aspirational. The framework-binding seam is three
core primitives — `subscribe(scope, handlers)`, `snapshot(scope)`, `emit`/local-write —
mapped onto each framework's native reactivity primitive (React `useSyncExternalStore`, Svelte
store contract, Vue `shallowRef`, Solid/signals `{subscribe}`, Angular Observable/signal). An
adapter that needs to understand a `Change` or touch a `Cursor` indicates the core API is wrong.

**Packaging DECIDED:** framework adapters are **subpath exports** of the single `@neutro/sync`
package (`@neutro/sync/adapters/react`, `/adapters/svelte`, …), not separate packages — one
version, one release, one install. Requirements this imposes on the build (gate items, not
free): framework peers declared as **optional peer dependencies** (`peerDependenciesMeta`), and
each adapter subpath **independently tree-shakeable** so importing `/adapters/react` pulls no
other adapter's code and requires no other framework installed. nv already proves the
subpath-export half in-repo; the optional-peer half is the addition.

**Pre-committed constraint on G2 (Public API):** the core consumer-facing API is plain TS
(callbacks + promises, no framework type or reactivity primitive in any core signature);
framework integration is exclusively additive. The **write/emit ergonomics remain open** under
G2 — discovered in design and implementation, not pinned now. Reusable analysis: design note
`docs/design/framework-composition.md`.

### 2026-06-24 — BCon working rule adopted [LOCKED]
Adopted **BCon** ("Be concise" + no BS / no fluff / no sycophancy / only-valid / no-hallucinations
/ ground-assumptions / steelman-then-leak) as the default working contract for all ns sessions —
discussion, design, implementation. Defined identically in `custom-instructions` (claude.ai
project) and `AGENTS.md` (repo/Claude Code) so the rule holds across session types. The user may
type `BCon` mid-session to refresh context. BCon is tone+rigor; it does not override halt-at-gates,
spike discipline, or external-claim verification — it is the manner in which those are delivered.

### 2026-06-25 — Phase 1 harness built and verified [LOCKED]
Implemented the multi-replica convergence harness (the acceptance instrument for all Phase 1
work). Built stub-first: `NonConvergingFeed` proved the harness goes RED before
`TriviallyCorrectFeed` proved it goes GREEN. 10 gate tests passing; `tsc --noEmit` clean.
Gate file written before code per AGENTS.md discipline: `docs/gates/phase1-convergence-harness.md`.

**Files landed:**
- `src/core/types.ts` — TypeScript expression of the frozen seam contract v1.0. All eight seam
  types: `Change`/`StateChange`/`OpChange`/`VersionedChange`, `Cursor`/`Version`/`ClockStrategy`,
  `Lifetime`, `ChangeBatch`/`Snapshot`/`Feed`, `Conflict`/`Resolution`/`Resolver`,
  `Scope`/`Subscription`/`ScopeRouter`, `Transport`, opaque tokens + factory helpers.
  `ChangeBase` exported (Phase 1b engine will branch on `kind` across the common fields).
- `src/transports/in-process.ts` — `InProcessTransport implements Transport`. `send()` resolves
  on `channelFn` hand-off (§7). `channelFn` injectable by harness; `_deliver()` for inbound;
  `_setConnected()` fires connect/disconnect handlers (T3 reconnect lifecycle).
- `test/harness/seeded-rng.ts` — `mulberry32(seed)` deterministic PRNG.
- `test/harness/channel-simulator.ts` — `ChannelSimulator`. Drain-based; deterministic
  drop/reorder/duplicate/partition. Stats: sent/dropped/reordered/duplicated/delivered.
- `test/harness/stubs.ts` — `NonConvergingFeed` (local-only, never forwards — harness RED),
  `TriviallyCorrectFeed` (dedup by id + sync forward via `onForward` — harness GREEN),
  `LocalState` (LWW by `Version._seq`), `makeStubVersion`.
- `test/harness/convergence-harness.ts` — `ConvergenceHarness`. N replicas, N×(N-1) directed
  channels seeded `channelSeed + i*100 + j`. `applyLocal`, `drainToQuiescence` (round-based),
  `assertConverged` (throws on <2 replicas), `throwIfDrainErrors` (surfaces async apply
  rejections for Phase 1b), partition/reconnect controls, channel stats aggregation.
- `test/harness/harness.test.ts` — 10 tests covering G1–G6.

**Four implementation findings recorded as locked:**

1. **Partition ≠ fault injection.** Batches enqueued during a partition bypass probabilistic
   fault rolls and buffer directly. `reconnect()` restores draining. This matches T3 reconnect
   semantics: a transport must buffer while cut, not discard. Consequence: `enqueue()` during
   partition consumes **zero** RNG values (structural state, not probabilistic). The 4-roll
   determinism guarantee applies only to the non-partitioned path. The two paths are
   intentionally asymmetric and correctly documented.

2. **`drainToQuiescence` must be round-based.** A single sweep is not sufficient. Delivering
   a batch from channel i→j causes `TriviallyCorrectFeed` to call `onForward` synchronously,
   which enqueues into channels j→k. Those new entries must be picked up in a subsequent
   drain round. The `splice(0)` snapshot in `ChannelSimulator.drain()` enforces that
   same-round deliveries do not re-enter the current drain pass.

3. **`assertConverged()` throws on a single-replica harness.** Per AGENTS.md spike rule:
   a single-replica convergence check is vacuous — the sync property requires two or more
   replicas to diverge before reconciliation can be demonstrated.

4. **T3 and T4 are consciously unimplemented in the stubs.** `LocalState` applies all changes
   regardless of `lifetime` (T3 fork not implemented); there is no conflict detection (T4 not
   in harness scope). These are correct omissions for a Phase 1 stub. **Consequence for
   Phase 1b:** the real engine gate must explicitly claim and test both T3 (ephemeral never
   advances cursor, never persisted, never replayed) and T4 (conflict detected and routed to
   resolver). Neither is verified by the current 10-test suite.

### 2026-06-25 — LWW pulled forward; `concurrent` path deferred to Phase 2 [LOCKED]
**LWW as first concrete `ClockStrategy` (pulled forward from Phase 2).**
`LWWClockStrategy` is built in `src/strategies/lww.ts` and pointed at the `ClockStrategy`
slot in `Engine`. It is never inlined into `Feed.apply` — the engine calls only
`ClockStrategy.compare()`; LWW is one implementation of that slot. Consequence: Phase 2
(logical clock, CRDT position) is a pure addition of new slot implementations, not a refactor.

**`concurrent` → `Resolver` path consciously deferred.** LWW `compare()` never returns
`"concurrent"` — that is LWW's defining property. The conflict-routing branch in
`Engine._applyState` and `Engine._applyOp` exists and is documented, but is unreachable
in Phase 1b. It is not a `throw new Error("unreachable")` — it is an honest deferred arm.

**Phase 2 entry condition (locked):** at least one strategy that returns `"concurrent"`
(logical/hybrid clock or CRDT position) must be implemented, a test must drive two replicas
into a genuine `"concurrent"` outcome, route it to a `Resolver`, and verify the resolution
is applied. This is the first gate item Phase 2 must claim.

### 2026-06-25 — Phase 1b engine built and verified [LOCKED]
Implemented the real `Feed` + `ScopeRouter` engine and LWW as the first concrete
`ClockStrategy`. Gate file written before code: `docs/gates/phase1b-engine.md`.
18 tests passing (`tsc --noEmit` clean): 10 original harness tests (P1 — harness unmodified)
+ 8 new engine tests (P2–P5). Test/harness files untouched.

**Files landed:**
- `src/core/engine.ts` — `Engine implements Feed, ScopeRouter`. In-memory. T1 kind
  branching; T2 version opacity; T3 lifetime fork; T4 `concurrent` deferred; T5 per-scope
  causal order via synchronous subscription dispatch.
- `src/strategies/lww.ts` — `LWWClockStrategy`. Monotonic integer counter; `compare()`
  returns `"before"` or `"after"`, never `"concurrent"`.
- `test/engine/engine.test.ts` — 8 tests wired via `Engine.subscribe()` + `ChannelSimulator`
  (production API, no harness internals).

**Gate results:**
- P2: LWW contention — higher version wins on both replicas under fault injection. ✓
- P3: op dedup — duplicate-delivered op applied exactly once (seenIds). ✓
- P4a: cursor does not advance on ephemeral changes (T3). ✓
- P4b: ephemeral changes absent from `changes()` replay (T3). ✓
- P4c: ephemeral changes present in `snapshot()` — they are current state (T3). ✓
- P5: state collision resolved take-by-version; throwing `Resolver` never invoked (T4 LWW path). ✓
- P6: `concurrent` → `Resolver` path named deferral; branch present in engine. ✓
- P7: `tsc --noEmit` clean; vitest 18/18. ✓