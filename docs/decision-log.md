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

_Last updated: 2026-06-29. Seam Contract **v1.1** (`mergeVersions` optional method added)._ Phase 3 complete; G2 Public API surface resolved, implemented, automated, and locked.

### Status at a glance
- **Seam contract:** v1.1. T1–T5 ratified; eight seam types defined; §9 consumer map
  and §9.1 local-derived-state rule in place. `ClockStrategy.mergeVersions?(a, b)` added as
  optional method (2026-06-29). Founding semantics otherwise unchanged.
- **Governance scaffold:** Complete. Charter, custom instructions, AGENTS.md, decision log,
  implementation-state all in place.
- **Code:** Phase 3 + G2 Public API complete. `createSync` client + `ScopeHandle` (`set`/`do`/
  `subscribe`/`snapshot`/`onConflict`/`close`), per-scope config via client multiplexing (B1),
  auto-resolution default, full T3 reconnect fork in the client. Pure-additive — core engine/types
  bytewise unchanged. Token-leak gate automated + mutation-verified. **109 tests passing**;
  `tsc --noEmit` clean. HEAD `d21f26d`.

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
- **T4 — `concurrent` path — Model C activated [Phase 2]** — detect-and-hold: `apply()` records
  open conflict + fires `onConflict` synchronously; engine does not own resolution lifecycle.
  `resolveConflict(scope, unit, resolution)` is the internal resolution seam. `ResolverPump`
  is the optional automatic bridge. Convergence: approach (a) — deterministic pure-function
  resolver proven on ≥2 replicas under fault injection. `_applyOp` concurrent arm deferred
  (needs full VersionedChange stored per unit). See 2026-06-28 Phase 2 entry.
- **`merged` resolution + `ClockStrategy.mergeVersions` [LOCKED — seam v1.1]** —
  `mergeVersions?(a, b): Version` added as optional to `ClockStrategy`; absent on strategies
  where `compare` never returns `concurrent` (e.g. LWW). Convergence mechanism: element-wise
  max (causal join, no local-slot increment) — deterministic, order-independent, dominating.
  Engine guard: `merged` arm throws a precise error if `mergeVersions` absent. Propagated
  resolution deferred. **Implementation complete (Phase 3).** C1–C7 gate verified; 55 tests passing. See 2026-06-29 Phase 3 entry.
- **Public API shape [LOCKED — G2]** — `createSync(config)` → client; `client.scope(key, cfg)` →
  handle; `set`/`do`/`subscribe`/`snapshot`/`onConflict(manual)`/`close`. Per-scope config via client
  multiplexing one `Engine` per scope-config (no engine change). Transport bridged in the client; T3
  reconnect fork client-driven. No `Version`/`Cursor`/`Change`-construction in any consumer signature
  (automated: `test/types/no-token-leak.test.ts`, mutation-verified). Additive over seam v1.1. See
  2026-06-29 G2 close-out entry.

### Open gates (surfaced, NOT decided — do not build past)
- **G3 — LCD-risk proof**: demonstrate the universal seam isn't worse than a purpose-built
  engine per consumer. Addressed by the conformance suite; not blocking early phases.
- **G2-6d — client T3 durable-fork test** (sandbox; deterministic): the durable replay branch in
  `create-sync.ts` has no test firing `transport.onConnect()`. Not blocking; schedule in the next
  runtime/integration pass.

### Superseded / resolved
- **G1 — Substrate** — RESOLVED 2026-06-24: `ns` is standalone (option a).
- **G2 — Public API surface** — RESOLVED 2026-06-29: designed + implemented + automated, pure-additive
  over seam v1.1, mutation-verified leak gate. Clean on every path G2 owns; the `_applyOp` concurrent
  gap is pre-existing (Phase 3 sub-gate), not a G2 caveat. See 2026-06-29 G2 close-out entry.

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

### 2026-06-27 — Phase 1b review close-out: two convergence tests added; three findings recorded [LOCKED]

**P8 and P9 added to `test/engine/engine.test.ts`.** 21/21 tests passing.

- **P8 — Reconnect replay.** Two sub-tests verify `changes(scope, since)` as the fault-recovery
  primitive: (a) full replay — B misses all of A's writes, requests `changes(scope, cursorAt0)`,
  applies the yielded batch, snapshot matches and cursor advances; T3 sanity check confirms no
  ephemeral ids appear in replay. (b) Partial replay — B already holds entries 1–2, requests
  only since cursor-at-2, receives exactly 2 entries, durable log size = 4 not 6.
- **P9 — 3-replica contention under partition.** Three replicas write the same unit; initial
  drain converges on v3. Replica 2 is then isolated; isolated replica writes v_island (_ts=4),
  replicas 0 and 1 write v_winner (_ts=5) and gossip between themselves. Reconnect + drain:
  all 3 converge on v_winner. Verifies that the globally-highest version wins across a
  partition boundary.

**Three findings recorded (no code change — engine logic unchanged):**

1. **`concurrent` arm silently drops the incoming change [HIGH].** `_applyState` / `_applyOp`
   call `_seenIds.add` then `return false` on `cmp === "concurrent"`. The comment says "hold
   both, do not silently decide" but the code holds neither — the incoming change is lost and
   its id is permanently marked seen. Inert under LWW (unreachable); live T4 violation the
   moment a Phase 2 strategy returns `concurrent`. **Phase 2 must fix this before testing any
   `concurrent`-producing strategy.** Trust the code, not the comment.

2. **`_seenIds` grows unbounded [MED].** No eviction. Correct for in-memory Phase 1b; Phase 3
   (persistence) needs compaction.

3. **`Resolver` / `onConflict` are dead under all current paths [MED].** The only call site is
   the `concurrent` arm, which returns before it. P5's "throwing Resolver never invoked" passes
   trivially — the Resolver is never invoked under *any* current path, not just the LWW path.
   Phase 2 must activate this wiring; P5 proves less than its name suggests.

### 2026-06-28 — Phase 1b code review: 10 findings fixed [LOCKED]

A high-effort code review of all Phase 1b work surfaced 10 findings (8 finders × 5 verifiers).
All 10 fixed in this session. 24/24 tests passing; `tsc --noEmit` clean.

**Structural fixes (code changes):**

1. **F1 — LWW cross-instance tiebreaking.** `compare()` returned `"before"` on equal `_ts`,
   silently making equal-ts from independent instances first-write-wins and non-deterministic.
   Fix: `LWWVersionInternals` now carries `_node` (unique per instance, module-level counter).
   `compare()` uses `_ts` first, then `_node` as a deterministic tiebreaker. `mint(prev?)` is
   now a Lamport clock (`max(_counter, prev._ts) + 1`). New regression test P10 verifies.

2. **F2 — Ephemeral overwrites durable base.** `stateUnits` was a single map; an ephemeral
   change with a higher version would overwrite the durable entry, permanently losing the durable
   base. Fix: `ScopeState` now has two separate maps — `durableStateUnits` and
   `ephemeralStateUnits`. `_stateWinner()` picks the higher-version entry per unit. `snapshot()`
   merges both maps. Durable base is preserved even when ephemeral is currently winning.
   New regression test P11 verifies.

3. **F3 — `concurrent` arm poisoned seenIds.** Both `_applyState` and `_applyOp` called
   `seenIds.add(id)` then `return false` in the `concurrent` branch, permanently blocking
   Phase 2 re-routing. Fix: the `concurrent` branch no longer adds to seenIds. The id stays
   open for Phase 2 re-routing. Inert under LWW; correct for Phase 2.

4. **F5 — seenIds was global across scopes.** A single `Set<string>` on `Engine` meant the
   same id string in two different scopes would be cross-deduped (the second would be silently
   dropped). Fix: `seenIds` moved to `ScopeState` — one `Set<string>` per scope. New regression
   test P12 verifies same-id-in-different-scopes accepted independently.

**Test/harness fixes:**

5. **F6 — gossip apply() errors silently swallowed.** `void engines[j]!.apply(b)` in gossip
   wiring discarded the returned Promise; a rejected apply would be invisible. Fix: `setupGossip`
   now collects errors via `.catch()` and exposes `throwIfErrors()` on its return value. All
   gossip-based tests call `throwIfErrors()` after `drainChannels()`.

6. **F10 — `drainChannels` co-location rationale.** Added a doc comment explaining why the
   drain algorithm is co-located with the engine tests rather than extracted to the harness
   (different wiring context; harness files must remain unmodified per P1 gate).

**Import cleanup:**

7. **F7** — Removed dead `makeChangeId` import from `src/core/engine.ts`.
8. **F8** — Removed dead `type VersionedChange` import from `src/core/engine.ts`.
9. **F9** — Removed inline `import("./types.ts").Version` from `ScopeState` interface;
   `Version` is now a top-level named import.

**Documentation fixes:**

10. **F4** — Cursor locality documented in `Engine.getCursor()` and the class-level JSDoc:
    cursors are engine-local ordinals; cross-replica use is incorrect.

**Regression tests added:** P10 (LWW tie), P11 (ephemeral preserves durable), P12 (per-scope seenIds).

### 2026-06-28 — Phase 2 conflict resolution activated: Model C, VectorClockStrategy, ResolverPump [LOCKED]

**Entry condition met.** A strategy returning `"concurrent"` (`VectorClockStrategy`) implemented
and a real `Resolver` path activated. All seven Phase 2 gate items (Q1–Q7) passing. 36 total
tests; `tsc --noEmit` clean.

**Closed findings from Phase 1b review:**
- Finding #1 (`concurrent` arm silent drop + seenIds poisoning): the F3 fix (arm no longer adds
  to seenIds) was a prerequisite; this phase activated the arm with correct detect-and-hold behavior.
- Finding #3 (`Resolver`/`onConflict` dead under all paths): `ResolverPump` makes the wiring live.
  Q3 proves the resolver is now invoked. P5's "throwing Resolver never invoked" premise was
  correct at the time; Phase 2 has now superseded it.

**VectorClockStrategy (Q1).** `src/strategies/vector-clock.ts`. Version shape:
`{ _vec: Record<nodeId, number> }`. `mint(prev?)` merges all entries from `prev`'s vector then
increments the local node's slot. `compare()` returns `"concurrent"` for causally-independent
pairs (neither vector dominates the other); `"before"`/`"after"` for ordered pairs. Replaces the
"never concurrent" LWW guarantee for use cases that require causal conflict detection.

**Model C engine changes (Q2, Q5, Q6).** `ScopeState.openConflicts: Map<unitKey, {local, remote}>`
holds both competing `VersionedChange`s. The `concurrent` arm in `_applyState` records the open
conflict, fires `onConflict` as a notification on all subscriptions, and returns synchronously —
`apply()` never awaits resolution. `resolveConflict(scope, unit, resolution)` is a new public
engine method (internal seam, NOT G2 API): `take-local` marks both ids seen and returns (local
is already confirmed); `take-remote` directly writes the winner to the confirmed maps, advances
cursor/log (if durable), and fires `onBatch`; `merged` throws — deferred pending
`ClockStrategy.mergeVersions` (a seam-contract addition needed to produce a version that causally
dominates both inputs, preventing recursive conflict on gossip); `defer` is a no-op — conflict
stays open. Phase 2 holds one open conflict per unit (last-in wins on overwrite); multi-way
conflict handling is a follow-up. Last-confirmed-winner read semantics hold automatically because
open conflicts never write to the confirmed maps.

**ResolverPump (Q3).** `src/core/resolver-pump.ts`. Subscribes to `onConflict`; calls
`resolver.resolve(conflict)`; calls `resolveConflict` with the result. Async resolvers: returns
`defer` synchronously while the promise settles. Absent ⇒ conflicts stay open for manual
`resolveConflict` calls.

**Convergence mechanism: approach (a) — deterministic pure-function resolver (Q4).** The
deterministic resolver is a pure function of the conflict payload: picks the change with the
lexicographically-larger `id.value`. Because the function is symmetric (same winner regardless
of which side is `local` vs `remote`), every replica independently computes the same decision
without propagating the resolution as a separate change. Proven on 2 replicas under fault
injection (drop/reorder/duplicate). `merged` is not implemented in Phase 2 (throws explicitly); correct support requires
`ClockStrategy.mergeVersions` to produce a version that causally dominates both inputs —
documented in the gate file's scope boundary.

**Conscious scope boundary.** `_applyOp`'s `concurrent` arm remains deferred: the path stores
only `Version` per unit (`opUnitVersions`), not a full `VersionedChange`. A correct `Conflict`
payload requires both `local` and `remote` as full `VersionedChange`. Follow-up: rename
`opUnitVersions` to `opUnitChanges: Map<string, VersionedChange>` and route op conflicts through
the same Model C path.

---

### 2026-06-28 — Phase 2/3 Consolidation close-out

**P8 and P9 confirmed landed.** Both tests exist and are green (40/40). No carried debt remains from the Phase 1b hardening brief on reconnect-replay and 3-replica-contention-under-partition.

**Resolver-determinism expectation documented.** The convergence guarantee (Q4: independent replica resolution converges) holds only if the `Resolver` is a deterministic pure function of its `Conflict` input. Now a stated requirement in `seam-contract.md` §5 at v1.0. Constrains resolver implementations, not the type surface — `types.ts` unchanged.

**`merged`/`mergeVersions` deferred to Phase 3 architect sub-gate.** Phase 2 `throw` stays. Correct `merged` support requires `ClockStrategy.mergeVersions(a, b)` — a seam-contract addition needing its own gate.

**`_applyOp` concurrent routing confirmed Phase 3.** Op-path concurrent arm stays deferred. Stale comment ("Phase 2 will route") corrected to "Phase 3 will route (op path)". Op routing requires the op path to carry `VersionedChange` (not just `Version`) to build a `Conflict` payload.

---

### 2026-06-29 — `merged` resolution mechanism + `ClockStrategy.mergeVersions` [LOCKED — seam v1.0 → v1.1]

**Gate:** Phase 3 architect sub-gate (`merged`/`mergeVersions` design). Resolved by an architect
session; design doc `docs/design/merge-resolution.md`. Crux (Q-C) grounded by a throwaway spike
against `src/strategies/vector-clock.ts` (discarded per artifact discipline). Full engine ≥2-replica
convergence proof routed to the implementation brief, not asserted here.

**Decision.**

1. **Add `mergeVersions` to `ClockStrategy` as an OPTIONAL method** — contract change, **seam v1.0 →
   v1.1**:
   ```ts
   interface ClockStrategy {
     mint(prev?: Version): Version;
     compare(a: Version, b: Version): "before" | "after" | "concurrent";
     mergeVersions?(a: Version, b: Version): Version;   // NEW — optional
   }
   ```
   - **Versions only** (not values, not `base`): version-merge is value-opaque (T2); value-merge is
     the Resolver's job. Passing values would leak domain data into the version slot.
   - **Binary** (not variadic): Phase 2 holds exactly one `{local, remote}` open conflict per unit;
     N-way composes by association. Variadic is a separate future gate.
   - **Optional, not mandatory:** a strategy whose `compare` never returns `concurrent` (LWW) can
     never reach `merged`; forcing a throwing stub is noise. Engine guards: the `merged` arm throws
     a precise error if `mergeVersions` is absent — converting "merged under a non-merge strategy"
     from silent divergence into a loud, accurate failure.

2. **Convergence mechanism: LOCAL merge with a deterministic dominating version** (handoff §4 option
   a) — **propagation is NOT required** for vector clock. Rationale (Q-C): the merged version is the
   **element-wise max with NO local-slot increment** (a causal join, not an authored event). Max is
   deterministic and order-independent → every replica computes a `compare`-equal version that
   dominates both inputs → redelivery of either input compares `before` and is skipped → no
   re-conflict. Combined with the §5 deterministic-resolver requirement, independent local merge
   converges without gossiping the resolution.
   - **Equality is tested only via `compare`, never structurally** — two replicas may build the
     version record with different key order. Stated in the contract.
   - Rule rejected: max-**then**-local-increment. Each replica increments its own slot → the two
     merged versions are mutually `concurrent` → re-conflict forever. This is the trap the
     ≥2-replica test must catch.

3. **`merged` is available only where the version space admits a dominating join** (a
   join-semilattice). Strategies without one (e.g. a node-less pure wall-clock) omit `mergeVersions`;
   the engine guard refuses `merged` under them. Real finding, not a defect.

4. **Propagated resolution remains deferred** (Phase 3, separate gate). Needed only if a future
   strategy cannot produce a cross-replica-identical dominating version locally, or a resolver cannot
   be deterministic. Not consumed by this decision.

**Engine landing path** (`resolveConflict` `merged` arm replaces the current throw): mint
`mergeVersions(local.version, remote.version)`; build a new `StateChange` carrying
`resolution.value` + the merged version + a fresh local `ChangeId` + `local.lifetime`; delete the
open conflict; add both input ids to `seenIds`; for durable, write `durableStateUnits` + advance
`cursorSeq` + push `durableLog`; for ephemeral, write `ephemeralStateUnits`; fire `onBatch`. Full
spec in the design doc §5; implementation brief carries the failable gate items.

**Supersedes:** the 2026-06-28 consolidation line "`merged`/`mergeVersions` deferred to Phase 3
architect sub-gate" — that gate is now resolved. The Phase 2 `throw` is replaced by the landing path
above once implemented; until the implementation lands, the throw stays (the decision is locked; the
code change is the implementation brief's job).

**Out of scope (unchanged):** `_applyOp` concurrent routing (separate Phase 3 runtime sub-gate;
`merged` for ops inherits this design once the op path carries `VersionedChange`).

---

### 2026-06-29 — G2 Public API surface resolved; pure-additive over seam v1.1 [LOCKED — G2 closed]

**Gate:** G2 (Public API surface), open since 2026-06-24. Resolved by an architect session.
Design doc: `docs/design/public-api.md`. Implementation brief handed to runtime+CC.
**No seam change. No T1–T5 change. No runtime sub-gate spawned.** G2 is purely additive over the
frozen seam (v1.1), as pre-committed in the 2026-06-24 framework-composition entry.

Signatures verified against source at HEAD `950d6d1` before designing: `Engine(clock, resolver?)`
is single-clock/single-resolver per engine; the engine is transport-unaware; `resolveConflict`,
`getCursor` are non-interface methods; `ResolverPump` is a standalone per-scope bridge.

**Decision.**

1. **Q-B (load-bearing) — per-scope config via client multiplexing, NOT an engine change.**
   The public client holds one `Engine` per scope-config (`Map<scopeKey, {engine, clock,
   lifetimeDefault, transportBinding, cursor}>`) and routes each scope to its own engine. The
   `Engine`'s single-clock limitation is **not a defect to fix** — it aligns with T5 (no
   cross-scope coordination is promised), so two scopes share no state to amortize and one
   engine-per-config costs nothing over one engine-with-N-scopes. Registering per-scope clocks
   inside the engine would add a hot-path scope→clock lookup in `_applyState` (the most
   perf-sensitive method) to buy a capability the client provides for free. **Rejected. G2 stays
   additive; no runtime sub-gate.**

2. **Q-A — `createSync(config)` factory → client; `client.scope(key, scopeConfig)` → chainable
   scope handle.** The handle is the reusable unit the consumer holds (`presence.set(...)`,
   `doc.subscribe(...)`). Builder rejected (terminal `.build()` fights dynamic scope
   registration); upfront config-object allowed as sugar (`createSync({transport, scopes})`).
   Re-`scope()` with same key returns the cached handle; with conflicting config, throws.

3. **Q-C — write surface: verb-per-kind on the bound handle.** `set(unit, value, opts?)` (state)
   / `do(unit, value, opts?)` (op). Perf-grounded: per-write cost equals hand-wiring
   (`mint()` + one `Change` literal + `apply()`), one call frame over, zero extra allocation —
   the handle is allocated once at `scope()` time, methods close over scope config. Per-write
   builder rejected (allocates per write in the hot path); single `emit(...,{kind})` rejected
   (runtime kind-branch + options read per write, strictly ≥0 cost, reads worse). `version` is
   minted internally (`clock.mint(prev?)`, handle tracks `prev` per unit); **no `Version`,
   `ClockStrategy`, `ConflictUnit`, or `Cursor` in any consumer-facing signature.** `set`/`do`
   return `void` — awaiting a local write would contradict the mandate.

4. **Q-D — subscription returns `readonly Change[]` (cursor stripped); conflict auto-resolution
   ON by default when a resolver is configured.** Auto-on is the *correct* default, not just
   convenient: §5 requires a deterministic resolver for convergence, so a configured-but-unrun
   resolver = silent divergence — the exact failure the contract prevents. Opt-out via
   `{manual: true}` for intentional hold-open UX, exposing a narrow `handle.onConflict((c,
   resolve)=>…)` hook that wraps `engine.resolveConflict` (consumer never constructs scope/unit).

5. **Q-E — transport attached once at `createSync({transport})`; client owns the full bridge.**
   Outbound `onBatch→send`, inbound `receive→apply` (demultiplexed by `batch.scope.key`),
   T3 reconnect fork client-driven (engine is transport-unaware): durable scopes replay via
   `changes(scope, lastCursor)`, ephemeral via `snapshot(scope)`. Client tracks `lastCursor`
   per durable scope internally. **No `Cursor` reaches the consumer by any path.**

6. **Q-F — internal/public boundary frozen.** Public: `createSync`, `client.scope`,
   `handle.set/do/subscribe/snapshot/close`, `handle.onConflict` (manual only), `client.close`,
   strategy factories `lww()`/`vectorClock()`. Internal: `Engine` ctor, raw `apply`/`changes`,
   `getCursor`, `resolveConflict` (except via the wrapped manual hook), `ResolverPump`, all
   `make*` token factories + `mint`.

**One named residual (steelman-then-leak):** a `StateChange` in the `subscribe` changes array
carries its `.version`. The consumer sees it but it is branded-opaque and inert — stripping it
would force a per-fire clone (allocation in the read hot path). Deliberate zero-copy-over-perfect-
hiding trade; opacity already neutralizes misuse. Recorded as a decision, not an accident.

**Supersedes:** the `2026-06-24 Public API gate opened [OPEN — G2]` entry — gate now closed.
The write/emit ergonomics left open there are resolved by item 3.

**Out of scope (unchanged):** `_applyOp` concurrent routing (Phase 3 runtime sub-gate); async
local write + backpressure (Phase 5); framework adapters (Phase 4 implementation, downstream of
this frozen plain-TS surface); first-consumer integration (CC/build task downstream of this gate).

---

### 2026-06-29 — G2 Public API surface RESOLVED-clean; implemented + automated [LOCKED — G2 closed]

**Gate:** G2 (Public API surface), open since 2026-06-24. Designed, implemented, reviewed (3 rounds +
axiom audit), and automated. **Fully additive over seam v1.1** — verified bytewise: `src/core/engine.ts`,
`src/core/types.ts`, `src/core/resolver-pump.ts` unchanged across the entire branch (`237421c..d21f26d`).
No seam change, no T1–T5 change, no runtime sub-gate spawned.

Design doc: `docs/design/public-api.md`. Implementation: `src/client/create-sync.ts` +
`src/strategies/index.ts` factories + `src/index.ts` barrel. Close-out automation:
`test/types/no-token-leak.test.ts`.

**Independent verification (clone + run + mutation, not report-trusted):**
- HEAD `d21f26d`. `tsc --noEmit` clean; **109/109 tests** green; lint clean.
- Additivity: `git diff 237421c..d21f26d` over the three core files is empty.
- Leak-gate has teeth (mutation-tested): injecting a forbidden named export (`makeCursor`) flips the
  `@ts-expect-error` guard to TS2578 and breaks `typecheck`; injecting a runtime value export
  (`makeScope`) fails the `Object.keys(barrel)` allow-list. Both anti-rot layers bite.

**Shipped surface (frozen).** `createSync(config)` → `SyncClient`; `client.scope(key, cfg)` →
`ScopeHandle` with `set`/`do` (verb-per-kind write), `subscribe` (delivers `readonly Change[]`, cursor
stripped), `snapshot` (`Promise<readonly Change[]>`), `onConflict` (manual mode only), `close`
(idempotent). Strategy factories `lww(nodeId?)` / `vectorClock(nodeId)` return the `ClockStrategy`
interface (no concrete class leak). Per-scope config via **client multiplexing — one `Engine` per
scope-config (B1)** — chosen because the engine's single-clock limit aligns with T5 (no cross-scope
coordination is promised), so per-scope engine isolation costs nothing over one-engine-with-N-scopes
while keeping `_applyState` free of a scope→clock hot-path lookup. Auto-resolution is the default when
a resolver is configured (a configured-but-unrun resolver would be silent divergence per §5); `manual:
true` opts into hold-open.

**Implementation decisions worth recording (from the 3 review rounds):**
- **`prevVersions` updated synchronously** before `engine.apply` (B-10): minting the next local write
  from a stale `prev` produced spurious concurrent-conflict churn. The `onBatch` "only advance" guard
  handles remote-win advancement so a remote winner correctly moves `prev` forward.
- **Reconnect replay race guarded** (C1): a `replayVersion` counter per scope-entry; a replay loop
  aborts if a newer reconnect superseded it.
- **Lifecycle fully guarded** (A-1/A-6/A-9/B-5/B-8): post-`close` writes, `scope(closedKey)`, the
  manual `resolve()` closure, and in-flight replay all throw or short-circuit after close.
- **Relay is O(P²) by design** for a P-peer mesh; dedup via engine `seenIds` prevents loops. A future
  server-relay transport filters by origin. Documented at the relay site.

**Accepted residual (logged, do not "fix").** A `StateChange` in the `subscribe` stream carries its
`.version`. `Version` is branded-opaque (T2) and inert to the consumer; stripping it would force a
per-fire clone (allocation in the read hot path). Zero-copy-over-perfect-hiding, deliberate. `Cursor`
is the asymmetric case — it has a readable `_seq`, so it must never reach a consumer; the leak gate
asserts `Cursor` unreachable while explicitly NOT failing on inert `Version`-in-`Change` (G2-1c guards
against a future over-tightening pass breaking this).

**G2 is clean on every path it owns.** The axiom audit listed Axiom 4 (T4) as "PARTIAL" — that refers
to the **pre-existing `_applyOp` concurrent arm** (deferred since Phase 2), not anything G2 introduced.
G2 builds no op-conflict because the engine surfaces none; its state-path conflict handling is fully
T4-compliant. The op-path gap stays in its existing Phase 3 runtime sub-gate home and is **not** a G2
caveat. Recorded here to prevent re-attribution.

**Supersedes:** `2026-06-24 Public API gate opened [OPEN — G2]` — closed. The write/emit ergonomics
left open there are resolved by the `set`/`do` surface.

**Open follow-ups (deferred, not blocking G2 closure):**
- **G2-6d — client-side T3 durable-fork has no `onConnect`-firing test.** The durable replay branch
  in `create-sync.ts` is live code; the existing reconnect test exercises engine-level dedup via
  `_deliver`, not the client's `transport.onConnect()` fork. Tracked as an open gate in Current State.
- **Persistent cursor (Phase 3)** — `lastCursor` is in-memory; process restart replays from log start.
- **Delivery above transport (Phase 5)** — `transport.send` `.catch()` sites are the
  retry/backpressure/ack seam; identified, not built.
- **`closedKeys` unbounded growth (Phase 5)** — acceptable at current scope cardinality.
