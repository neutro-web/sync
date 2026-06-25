# Acceptance Gate: Phase 1 — Multi-Replica Convergence Harness

> **Gate version**: 0.1 (seed — written before code per AGENTS.md gate discipline).
> **Stream**: Runtime. **Phase**: 1 (harness-first).
> **Not in scope here**: the real `Feed.apply` + cursor/replay engine (that is Phase 1b,
> the next session). This gate certifies only the harness and the in-process transport.

---

## Gate items (each must be able to fail)

### G1 — Harness catches divergence on a non-converging stub

**Artifact / command**: `pnpm test`

**Test**: `harness.test.ts` → "Gate 1 · Harness reports divergence on non-converging stub"

**Replica count**: 2

**Divergence driver**: Each replica applies a different value to the same `(scope, unit)`.
The `NonConvergingFeed` never calls `Transport.send`; changes never leave the replica.

**Asserted end-state**: `assertConverged().converged === false` with ≥1 divergence record
naming the mismatched `(scopeKey, unitKey)`.

**Failure condition**: Harness reports `converged: true` on a stub that provably keeps
replicas isolated. This is the load-bearing item — a harness that can only ever pass is not
a harness.

---

### G2 — Harness is not vacuously red

**Artifact / command**: `pnpm test`

**Test**: `harness.test.ts` → "Gate 2 · Harness reports convergence on trivially-correct stub"

**Replica count**: 2

**Setup**: `faultConfig = { dropRate: 0, reorderRate: 0, duplicateRate: 0 }` (perfect channel).

**Divergence driver**: R0 writes to unit `u1`; R1 writes to unit `u2` (disjoint — no
conflicting values, no LWW needed to assert convergence).

**Asserted end-state**: `assertConverged().converged === true`; both replicas have both values.

**Failure condition**: Harness reports `converged: false` on a stub that demonstrably gossips
all changes over a perfect channel.

---

### G3 — Deterministic runs

**Artifact / command**: `pnpm test`

**Test**: `harness.test.ts` → "Gate 3 · Deterministic runs"

**Setup**: seed fixed at 99, `faultConfig = { dropRate: 0.3, reorderRate: 0.3, duplicateRate: 0.2 }`,
same 3 batches applied in same order, 2 independent harness instances.

**Asserted end-state**: `getTotalChannelStats()` from run A deep-equals run B (same seed →
same fault decisions → same delivery counts).

**Failure condition**: Two runs with identical seed and inputs produce different stats.

---

### G4 — Channel faults are actually injected

**Artifact / command**: `pnpm test`

**Test**: `harness.test.ts` → "Gate 4 · Channel faults are actually injected"

| Fault | Configured as | Evidence asserted |
|---|---|---|
| drop | `dropRate: 1.0` | `stats.dropped > 0` **and** `stats.delivered === 0` |
| duplicate | `duplicateRate: 1.0` | `stats.duplicated > 0`; convergence still holds (idempotent) |
| partition | `partitionAll()` → drain → `reconnectAll()` → drain | R1 unchanged after partitioned drain; R1 updated after reconnect drain |
| reorder | `reorderRate: 1.0`, 3 batches enqueued before any drain | `stats.reordered > 0` |

**Failure condition for any sub-item**: The configured fault type shows zero events in stats
(a silently no-op'd fault is a vacuous channel — no different from a perfect channel).

---

### G5 — Convergence assertion operates on ≥2 replicas

**Artifact / command**: `pnpm test`

**Test**: `harness.test.ts` → "Gate 5 · Convergence assertion requires ≥2 replicas"

Sub-items:

1. **3-replica convergence**: R0, R1, R2 each write to a distinct unit over a perfect channel.
   All three replicas converge. `assertConverged().converged === true`.
2. **1-replica throws**: `assertConverged()` on a single-replica harness **throws** rather than
   returning `converged: true`. (Per AGENTS.md spike rule: a single-replica "convergence"
   check is vacuous — the sync property requires divergence before reconciliation.)
3. **3-replica non-converging divergence**: three non-converging replicas each write a
   different value to the same unit. `assertConverged().converged === false`.

**Failure conditions**:
- 3-replica convergence test fails.
- 1-replica harness does NOT throw (vacuous pass).
- 3-replica non-converging test reports `converged: true`.

---

### G6 — Two standing gates: `tsc --noEmit` AND `pnpm test` (separate)

**Artifacts / commands**:
- `pnpm typecheck` → `tsc --noEmit` exits 0.
- `pnpm test` → vitest exits 0.

**Failure condition**: Either exits non-zero. Green tests with a failing typecheck is a strict
failure (types are the seam contract's primary expression).

---

## Summary table (AGENTS.md requirement)

| Gate | Replica count | Divergence driver | Asserted end-state |
|---|---|---|---|
| G1 | 2 | local-only writes, no transport propagation | `converged: false` |
| G2 | 2 | disjoint unit writes, zero-fault channel | `converged: true` |
| G3 | 2 | seed-reproducible mixed faults | stats identical across 2 independent runs |
| G4 | 2 | each fault at 100% / partition cycle | fault event counters > 0 per fault type |
| G5a | 3 | disjoint writes, perfect channel | all agree, `converged: true` |
| G5b | 1 | — | `assertConverged()` throws |
| G5c | 3 | same-unit conflicting writes, no transport | `converged: false` |
| G6 | — | — | `tsc --noEmit` exits 0; `vitest` exits 0 |
