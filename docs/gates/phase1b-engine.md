# Acceptance Gate: Phase 1b — Real Engine

> **Gate version**: 0.1 (written before code per AGENTS.md gate discipline).
> **Stream**: Runtime. **Phase**: 1b.
> **Predecessor**: Phase 1a (convergence harness + stubs + in-process transport) is on
> main; 10 tests green.
> **Scope**: The real `Feed.apply` / `changes` / `snapshot`, `ScopeRouter`, and LWW as
> the first concrete `ClockStrategy`. New tests cover P2–P5; the existing 10 tests cover P1.
> **Not in scope**: `concurrent` → `Resolver` conflict path (requires a strategy that
> returns `concurrent`; deferred to Phase 2 — see P6). Real transports / persistence /
> perf numbers (Phase 3, Claude Code).

---

## Gate items (each must be able to fail)

### P1 — Existing 10 harness tests pass, harness files unmodified

**Artifact / command**: `pnpm test` (full suite) + `git diff --name-only HEAD test/harness/`

**What is verified**: The real engine is additive — it does not break the acceptance
instrument built in Phase 1a. The harness tests remain green because the harness itself
is not touched; stubs are unchanged.

**Failure condition**: Any of the 10 original harness tests fail, OR `git diff` shows any
file under `test/harness/` changed.

---

### P2 — LWW contention: two replicas write the same unit; higher version wins everywhere

**Artifact / command**: `pnpm test` → `engine.test.ts` → "P2 · LWW contention"

**Replica count**: 2

**Divergence driver**: R0 and R1 each apply a `state` change to the same `(scope, unit)`
before any drain. Versions are deterministically minted from a shared `LWWClockStrategy`
instance: R0 receives the lower version, R1 the higher. An unreliable channel
(`dropRate: 0.3`, `reorderRate: 0.3`, `duplicateRate: 0.2`) is used to exercise the engine
under fault conditions.

**Asserted end-state**: After `drainToQuiescence`, both replicas hold the value from the
higher-version write. Neither holds the lower-version value.

**Failure condition**: Any replica holds the lower-version value post-drain, OR the two
replicas disagree on the winning value.

---

### P3 — Op dedup: a duplicate-delivered op applies exactly once

**Artifact / command**: `pnpm test` → `engine.test.ts` → "P3 · Op dedup"

**Replica count**: 2

**Setup**: An op change (`kind: "op"`, no version) is applied locally to R0, which
gossips it to R1. `duplicateRate: 1.0` causes the channel to deliver two copies to R1.

**Asserted end-state**: R1's applied-op-id set contains the op id exactly once. The op
is not double-applied (single entry in the op-id set for that id).

**Failure condition**: R1 applies the op twice (observable as the id appearing more than
once, or a counter changing by 2 instead of 1).

---

### P4 — T3: ephemeral changes are off the durable path (three independent assertions)

**Artifact / command**: `pnpm test` → `engine.test.ts` → "P4 · T3 ephemeral is off the durable path"

**Replica count**: 2 (P4a–c use 1 engine directly; no gossip needed — T3 is a local property)

Three sub-assertions, each independently failable:

**P4a — Cursor does not advance on ephemeral changes.**
Apply one durable state change (cursor → seq 1). Apply one ephemeral state change.
Assert cursor seq is still 1 after the ephemeral apply.
*Failure*: cursor seq advances past 1 after ephemeral apply.

**P4b — Ephemeral changes are absent from `changes()` replay.**
With the same setup as P4a, iterate `changes(scope, null)`.
Assert the ephemeral change id does not appear in any replayed `ChangeBatch`.
*Failure*: ephemeral change id appears in the replay output.

**P4c — Ephemeral changes appear in `snapshot()` (they are current state).**
After the ephemeral apply, call `snapshot(scope)`.
Assert the ephemeral change's value is present in the snapshot.
*Failure*: snapshot does not contain the ephemeral value (would mean ephemeral is invisible
to consumers entirely, which is wrong — it is current state, just not durable).

---

### P5 — T4 (LWW path): state collision resolved take-by-version, Resolver not invoked

**Artifact / command**: `pnpm test` → `engine.test.ts` → "P5 · LWW take-by-version, no Resolver"

**Replica count**: 2

**Setup**: R0 applies a state change with version V_low to unit U. R1 applies a
state change with version V_high (> V_low) to the same unit U. Both changes arrive at
the other replica via gossip. A `Resolver` is installed that **throws** if ever called —
this makes any Resolver invocation an observable test failure.

**Asserted end-state**: Both replicas hold the V_high value. The throwing Resolver was
never called (no thrown error).

**Failure condition**: Either replica holds V_low, OR the Resolver throws (meaning the
engine inspected the versions and incorrectly routed to the Resolver when a
`before`/`after` outcome was available).

---

### P8 — Reconnect replay: missed changes recovered via `changes(since)`

**Artifact / command**: `pnpm test` → `engine.test.ts` → "P8 · Reconnect replay"

**Replica count**: 2

**Divergence driver**: Replica A applies three durable state changes while B receives none
(partition simulated by not gossiping). B's cursor is at seq 0 when A's is at seq 3.

**Reconciled assertion**: After B calls `engineA.changes(scope, cursorB)` and applies the
yielded batch, B's `snapshot()` matches A's for every unit. B's cursor advances to A's
terminal seq. B's own `changes(scope, null)` yields exactly the three durable ids; no
ephemeral ids appear (T3 sanity check). A second sub-test (partial replay) verifies that
`changes(scope, cursorAt2)` yields only the two entries B missed, not the two it already
held — total durable log size on B is 4, not 6.

**Failure condition**: Any unit missing from B's snapshot post-replay; B's cursor not
advanced to A's seq; any ephemeral id appearing in `changes()` output; or the partial-replay
sub-test producing more or fewer entries than expected.

---

### P9 — 3-replica contention under partition

**Artifact / command**: `pnpm test` → `engine.test.ts` → "P9 · 3-replica contention under partition"

**Replica count**: 3

**Divergence driver**: All 3 replicas write the same unit concurrently (distinct versions).
After initial convergence on the highest version (v3, _ts=3), replica 2 is isolated. The
isolated replica writes a competing version (v_island, _ts=4). Replicas 0 and 1 write a
higher version (v_winner, _ts=5) and gossip it between themselves. Replica 2 is then
reconnected; all buffered gossip drains to quiescence.

**Asserted end-state**: After drain, all 3 replicas hold `val-winner` (_ts=5). The
island-only write (v_island, _ts=4) is evicted everywhere when the globally-higher version
arrives. No replica holds `val-island` or `val-v3` after reconnect.

**Failure condition**: Any replica holds any value other than `val-winner` after final drain;
any two replicas disagree; a non-maximal version survives reconnect.

---

### P6 — DEFERRED (named): `concurrent` → Resolver path

**Status**: Explicitly not tested in Phase 1b. LWW `compare()` never returns `concurrent`,
so this path is unreachable with the only strategy available in 1b.

**Phase 2 entry condition**: At least one strategy that returns `concurrent` (logical clock
or CRDT position) must be implemented, and a test must drive two replicas into a genuine
`concurrent` outcome, route it to a `Resolver`, and verify the resolution is applied.

**Evidence for this gate item**: This named deferral in the gate file + a corresponding
entry in `decision-log.md`. The branch in `Engine.apply()` must exist (not be absent), be
honest (a comment naming the deferral, not a `throw new Error("unreachable")`), and be
exercised in Phase 2.

---

### P7 — Two standing gates: `tsc --noEmit` AND `pnpm test` (separate)

**Artifacts / commands**:
- `pnpm typecheck` → `tsc --noEmit` exits 0.
- `pnpm test` → vitest exits 0.

**Failure condition**: Either exits non-zero. Green tests with a failing typecheck is a
strict failure — types are the primary expression of the seam contract.

---

## Summary table (AGENTS.md requirement)

| Item | Replicas | Divergence driver | Reconciled assertion |
|---|---|---|---|
| P1 | 2/3 | existing harness scenarios (stubs) | 10 tests green; `test/harness/` unmodified |
| P2 | 2 | same-unit concurrent writes + faults | both replicas hold higher-version value |
| P3 | 2 | duplicated op delivery (`duplicateRate: 1.0`) | op-id set size = 1; no double-apply |
| P4a | 1 | ephemeral + durable mixed | cursor seq unchanged after ephemeral apply |
| P4b | 1 | ephemeral + durable mixed | ephemeral absent from `changes()` replay |
| P4c | 1 | ephemeral + durable mixed | ephemeral value present in `snapshot()` |
| P5 | 2 | same-unit state collision, throwing Resolver | V_high wins; Resolver never called |
| P6 | — | — | named deferral recorded; branch exists in engine |
| P7 | — | — | `tsc --noEmit` exits 0; `vitest` exits 0 |
| P8 | 2 | partition (B misses all writes); `changes(since)` replay | B snapshot = A; cursor advanced; replay excludes ephemeral |
| P9 | 3 | same-unit contention + mid-contention partition | all 3 converge on globally-highest version post-reconnect |
