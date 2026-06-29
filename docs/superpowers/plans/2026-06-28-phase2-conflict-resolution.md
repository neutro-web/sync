# Phase 2 Conflict Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate the T4 `concurrent` path deferred in Phase 1b by building a vector-clock strategy that produces `"concurrent"`, Model C detect-and-hold conflict handling in the engine, a `resolveConflict()` engine method, and an optional `ResolverPump` — proven end-to-end on ≥2 replicas.

**Architecture:** `VectorClockStrategy` is the first `ClockStrategy` that returns `"concurrent"` for causally-independent writes (vector-clock comparison). The engine's `concurrent` arm records open conflicts in a new `openConflicts` map, fires `onConflict` as a notification, and returns synchronously — `apply()` never awaits resolution. `resolveConflict(scope, unit, resolution)` is a new public engine method that lands a resolution directly into the confirmed state maps. `ResolverPump` bridges `onConflict` → `resolver.resolve` → `resolveConflict` as an optional layer outside `apply()`. Convergence uses approach (a): a deterministic pure-function resolver (pick-by-id lexicographic) so every replica independently computes the same decision without propagating the resolution as a separate change.

**Tech Stack:** TypeScript 5.5+, Vitest 4.1.9. No new dependencies.

## Global Constraints

- No seam-contract change (`Conflict`, `Resolution`, `Resolver`, `onConflict` are frozen at v1.0).
- `apply()` must stay synchronous — no `await` added inside it.
- `lww.ts` must not be modified.
- Harness files (`test/harness/`) must remain unmodified.
- All 24 existing tests must stay green throughout.
- Gate file (`docs/gates/phase2-conflict.md`) must be written before any implementation code.
- `_applyOp`'s `concurrent` arm is consciously out of scope: the op-with-version path lacks a stored full `VersionedChange` for `local`, making a correct `Conflict` payload impossible without a larger refactor. Document this clearly in the gate and move on.
- P8 and P9 are confirmed already present in `test/engine/engine.test.ts` and passing. No carry-forward needed.

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Create | `docs/gates/phase2-conflict.md` | Gate items Q1–Q7, written before code |
| Create | `src/strategies/vector-clock.ts` | `VectorClockStrategy` — first `ClockStrategy` returning `"concurrent"` |
| Modify | `src/core/engine.ts` | `openConflicts` state, `concurrent` arm → detect-and-hold, `resolveConflict()` method |
| Create | `src/core/resolver-pump.ts` | `ResolverPump` — optional bridge from `onConflict` to `resolveConflict` |
| Create | `test/engine/phase2-conflict.test.ts` | Q1–Q7 gate tests |
| Modify | `docs/implementation-state.md` | Flip deferred rows to REAL; note convergence mechanism |
| Modify | `docs/decision-log.md` | Dated entry: Model C activated, convergence mechanism (a), Findings #1/#3 closed |

---

## Task 1: Gate file

**Files:**
- Create: `docs/gates/phase2-conflict.md`

**Interfaces:** None — documentation only.

- [ ] **Step 1: Write `docs/gates/phase2-conflict.md`**

```markdown
# ns Phase 2 Gate — Concurrent Strategy + Conflict Resolution

> Written before code per AGENTS.md discipline.
> Design basis: `docs/design/conflict-resolution.md` (Model C + last-confirmed-winner).
> All items must be independently failable (a pass that cannot fail proves nothing).

## Gate items

**Q1 — Strategy produces `concurrent`.**
A unit test drives two causally-independent versions through `VectorClockStrategy.compare()`.
Expected: `"concurrent"` in both directions.
Failure: returns `"before"` or `"after"` for genuinely unrelated versions.

**Q2 — Conflict detected and held (Model C).**
Two replicas write the same unit concurrently with `VectorClockStrategy`. `apply()` records an
open conflict and fires `onConflict` with both sides. `apply()` must return synchronously
(assert via sync-flag check — no `await` in the call chain). Cursor must NOT advance on the
conflicting change; last-confirmed value must remain the confirmed state.
Failure: `apply()` hangs, conflict silently dropped, cursor advances on unresolved conflict.

**Q3 — Resolver wiring is live (closes Phase 1b Finding #3).**
A `ResolverPump` wired to an engine with a recording resolver IS invoked when a `concurrent`
conflict fires. Assert: resolver was called exactly once with the correct conflict payload.
Failure: resolver never called (the Phase 1b P5 trivial-pass condition — resolver was dead
under ALL paths, not just LWW).

**Q4 — Resolution converges (headline).**
Two replicas driven into a genuine `concurrent` conflict under the unreliable channel (fault
injection). A `ResolverPump` with a deterministic resolver (pick-by-change-id, approach (a))
fires on each replica independently. After resolution + drain, both replicas agree on the same
unit value.
Convergence mechanism: **approach (a) — deterministic pure function of the conflict.** The
resolver selects the change whose `id.value` is lexicographically larger; the same decision is
reached on every replica independently without propagating the resolution as a separate change.
Failure: replicas disagree post-resolution.

**Q5 — `defer` holds, never drops.**
A resolver returning `defer` leaves the open conflict entry intact. The unit keeps its
last-confirmed value. No cursor advance. The conflict remains resolvable (a subsequent
`resolveConflict` with a concrete decision lands correctly).
Failure: `defer` drops either side, advances state, or loses the conflict entry.

**Q6 — Last-confirmed-winner reads.**
During an open conflict, `snapshot()` returns the last resolved value; `changes()` does not
include the concurrent incoming change. Unresolved state must not leak into either read path.
Failure: concurrent/unresolved state appears in `snapshot()` or `changes()`.

**Q7 — No regression.**
All 24 existing tests green, harness files unmodified; `tsc --noEmit` clean.
Failure: any prior test broken, type error introduced.

## Conscious scope boundary

`_applyOp`'s `concurrent` arm is NOT activated in this phase. The op-with-version path stores
only the last accepted `Version` per unit (`opUnitVersions`), not the full `VersionedChange`
needed to populate `Conflict.local`. Routing it correctly requires storing the full change —
a scoped follow-up, not a Phase 2 blocker. The arm remains an honest deferred return.

**Multi-way conflicts (more than two concurrent writes to the same unit before the first is
resolved):** `openConflicts` holds only the LATEST conflict per unit — a second concurrent
write overwrites the first entry's `remote` side. The first `remote`'s id is not in `seenIds`
(per the F3 fix) so it can re-arrive via gossip, opening the conflict again. Phase 2 does not
test or guarantee correct handling of more than two simultaneous concurrent versions per unit.

**`merged` resolution:** the `merged` case in `resolveConflict` is NOT implemented in this
phase. With `VectorClockStrategy`, `this._clock.mint()` produces a version with no causal
history from either input (`{ engineNodeId: N }`), which is `concurrent` with both `local`
and `remote` — gossiping the merged change would open a recursive conflict. The correct fix
requires `ClockStrategy.mergeVersions(a, b)` (a seam-contract addition, out of scope). The
implementation throws to make this explicit; callers must use `take-local`, `take-remote`,
or `defer`.

## Summary table

| Item | Replicas | Driver | Assertion |
|---|---|---|---|
| Q1 | — | two independent `VectorClockStrategy` instances | `compare → "concurrent"` both ways |
| Q2 | 2 | concurrent write, `VectorClockStrategy` | conflict held; `apply` sync; cursor not advanced |
| Q3 | 1+ | conflict + `ResolverPump` + recording resolver | resolver invoked with correct payload |
| Q4 | 2 | concurrent write + faults + pump + deterministic resolver | both agree post-resolution |
| Q5 | 1 | conflict + `defer` | conflict entry intact; last-confirmed shown; subsequent resolution lands |
| Q6 | 1 | open conflict | `snapshot`/`changes` show last-confirmed only |
| Q7 | all | full suite | 24+ green, harness untouched, `tsc --noEmit` clean |
```

- [ ] **Step 2: Commit the gate file**

```bash
git add docs/gates/phase2-conflict.md
git commit -m "docs(gate): Phase 2 conflict resolution gate — Q1-Q7 (gate-first)"
```

---

## Task 2: VectorClockStrategy + Q1 test

**Files:**
- Create: `src/strategies/vector-clock.ts`
- Create: `test/engine/phase2-conflict.test.ts` (Q1 portion only)

**Interfaces:**
- Produces: `VectorClockStrategy implements ClockStrategy` — `constructor(nodeId: string)`, `mint(prev?: Version): Version`, `compare(a, b): "before" | "after" | "concurrent"`
- Internal version shape: `{ _vec: Record<string, number> }` — maps node ID strings to their logical counter. Strategy-owned, opaque to the engine.

- [ ] **Step 1: Write failing Q1 test (create test file)**

Create `test/engine/phase2-conflict.test.ts`:

```typescript
/**
 * Phase 2 gate tests — Q1-Q7.
 * Design basis: docs/design/conflict-resolution.md (Model C + last-confirmed-winner).
 */

import { describe, it, expect } from "vitest";
import { Engine } from "../../src/core/engine.ts";
import { VectorClockStrategy } from "../../src/strategies/vector-clock.ts";
import { ResolverPump } from "../../src/core/resolver-pump.ts";
import { ChannelSimulator } from "../harness/channel-simulator.ts";
import {
  makeChangeId,
  makeScope,
  makeConflictUnit,
  DURABLE,
} from "../../src/core/types.ts";
import type {
  ChangeBatch,
  Scope,
  Resolver,
  Conflict,
  Resolution,
  Version,
} from "../../src/core/types.ts";
import type { FaultConfig } from "../harness/channel-simulator.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function drainChannels(
  channels: ChannelSimulator[],
  maxRounds = 100,
): Promise<void> {
  for (let round = 0; round < maxRounds; round++) {
    let delivered = 0;
    for (const ch of channels) delivered += ch.drain();
    await Promise.resolve();
    if (delivered === 0) return;
  }
  throw new Error(`drainChannels: did not quiesce after ${maxRounds} rounds`);
}

async function getState(
  engine: Engine,
  scope: Scope,
): Promise<Map<string, unknown>> {
  const snap = await engine.snapshot(scope);
  const state = new Map<string, unknown>();
  for (const c of snap.changes) state.set(c.unit.key, c.value);
  return state;
}

/** Make a durable StateChange batch for a single unit. */
function makeStateBatch(
  scope: Scope,
  unitKey: string,
  value: unknown,
  id: string,
  version: Version,
): ChangeBatch {
  return {
    scope,
    changes: [
      {
        id: makeChangeId(id),
        scope,
        unit: makeConflictUnit(unitKey),
        kind: "state",
        lifetime: DURABLE,
        value,
        version,
      },
    ],
  };
}

function setupGossip(
  engines: Engine[],
  scope: Scope,
  baseSeed: number,
  faultConfig?: FaultConfig,
): {
  channels: Map<string, ChannelSimulator>;
  allChannels: ChannelSimulator[];
  throwIfErrors(): void;
} {
  const n = engines.length;
  const channels = new Map<string, ChannelSimulator>();
  const deliveryErrors: unknown[] = [];

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      channels.set(`${i}→${j}`, new ChannelSimulator(baseSeed + i * 100 + j, faultConfig));
    }
  }

  for (let i = 0; i < n; i++) {
    const ci = i;
    engines[i]!.subscribe(scope, {
      onBatch: (batch) => {
        for (let j = 0; j < n; j++) {
          if (j === ci) continue;
          channels.get(`${ci}→${j}`)!.enqueue(batch, (b) => {
            engines[j]!.apply(b).catch((err) => deliveryErrors.push(err));
          });
        }
      },
      // Return value ignored by engine (Model C); pump drives resolution if wired.
      onConflict: () => ({ decision: "defer" }),
    });
  }

  return {
    channels,
    allChannels: Array.from(channels.values()),
    throwIfErrors(): void {
      if (deliveryErrors.length > 0) throw deliveryErrors[0];
    },
  };
}

// ---------------------------------------------------------------------------
// Q1 — VectorClockStrategy produces "concurrent"
// ---------------------------------------------------------------------------

describe("Q1 · VectorClock: causally-independent versions compare as concurrent", () => {
  it("two nodes mint versions without knowledge of each other → concurrent both ways", () => {
    const clockA = new VectorClockStrategy("node-A");
    const clockB = new VectorClockStrategy("node-B");

    const vA = clockA.mint(); // { _vec: { "node-A": 1 } }
    const vB = clockB.mint(); // { _vec: { "node-B": 1 } }

    expect(clockA.compare(vA, vB)).toBe("concurrent");
    expect(clockA.compare(vB, vA)).toBe("concurrent");
  });

  it("version minted after observing another is causally later (after, not concurrent)", () => {
    const clockA = new VectorClockStrategy("node-A");
    const clockB = new VectorClockStrategy("node-B");

    const vA = clockA.mint();    // { "node-A": 1 }
    const vB = clockB.mint(vA); // { "node-A": 1, "node-B": 1 } — knows about vA

    expect(clockA.compare(vB, vA)).toBe("after");
    expect(clockA.compare(vA, vB)).toBe("before");
  });

  it("identical versions compare as before (idempotent re-apply)", () => {
    const clock = new VectorClockStrategy("node-A");
    const v = clock.mint();
    expect(clock.compare(v, v)).toBe("before");
  });

  it("C minted after merging A and B is after both; A and B are concurrent", () => {
    const clockA = new VectorClockStrategy("A");
    const clockB = new VectorClockStrategy("B");
    const clockC = new VectorClockStrategy("C");

    const vA = clockA.mint(); // { A: 1 }
    const vB = clockB.mint(); // { B: 1 }
    // A mints after seeing B: { B: 1, A: 2 }. C then mints after seeing A's merged
    // vector: { B: 1, A: 2, C: 1 }. C is causally after both A and B; A and B are
    // concurrent with each other.
    const vAseenB = clockA.mint(vB); // { B: 1, A: 2 }
    const vC = clockC.mint(vAseenB); // { B: 1, A: 2, C: 1 }

    expect(clockA.compare(vA, vB)).toBe("concurrent");
    expect(clockA.compare(vC, vA)).toBe("after");
    expect(clockA.compare(vC, vB)).toBe("after");
  });
});
```

- [ ] **Step 2: Run test to confirm it fails (import cannot be resolved)**

```bash
cd /Users/kofi/_/sync && pnpm test test/engine/phase2-conflict.test.ts 2>&1 | head -20
```

Expected: error — `Cannot find module '../../src/strategies/vector-clock.ts'`

- [ ] **Step 3: Create `src/strategies/vector-clock.ts`**

```typescript
/**
 * VectorClockStrategy — the first ClockStrategy that returns "concurrent".
 *
 * Each instance represents one node in the system, identified by a caller-supplied
 * string node ID. Version shape: { _vec: Record<nodeId, number> } — a vector of
 * logical counters, one per node. Two versions are concurrent if neither's vector
 * dominates the other (neither has a component strictly greater than the other in
 * every dimension).
 *
 * `mint(prev?)` merges all entries from `prev`'s vector (capturing causal history)
 * then increments this node's own slot. A version minted with knowledge of `prev`
 * is always causally after `prev`. A version minted without knowledge of another
 * node's version is concurrent with that node's writes.
 *
 * Internal shape is strategy-owned and opaque to ns — only this file reads inside.
 */

import type { ClockStrategy, Version } from "../core/types.ts";

// ---------------------------------------------------------------------------
// Internal shape — opaque outside this module
// ---------------------------------------------------------------------------

interface VCVersionInternals {
  readonly _vec: Readonly<Record<string, number>>;
}

function asVC(v: Version): VCVersionInternals {
  return v as unknown as VCVersionInternals;
}

// ---------------------------------------------------------------------------
// VectorClockStrategy
// ---------------------------------------------------------------------------

export class VectorClockStrategy implements ClockStrategy {
  private readonly _nodeId: string;

  constructor(nodeId: string) {
    this._nodeId = nodeId;
  }

  mint(prev?: Version): Version {
    const prevVec = prev ? asVC(prev)._vec : {};
    const vec: Record<string, number> = { ...prevVec };
    vec[this._nodeId] = (vec[this._nodeId] ?? 0) + 1;
    return { _vec: vec } as unknown as Version;
  }

  compare(a: Version, b: Version): "before" | "after" | "concurrent" {
    const av = asVC(a)._vec;
    const bv = asVC(b)._vec;
    const keys = new Set([...Object.keys(av), ...Object.keys(bv)]);
    let aGtB = false;
    let bGtA = false;
    for (const k of keys) {
      const ai = av[k] ?? 0;
      const bi = bv[k] ?? 0;
      if (ai > bi) aGtB = true;
      if (bi > ai) bGtA = true;
    }
    if (aGtB && bGtA) return "concurrent";
    if (aGtB) return "after";
    if (bGtA) return "before";
    return "before"; // equal — idempotent re-apply
  }
}
```

- [ ] **Step 4: Run Q1 tests only — confirm they pass**

```bash
cd /Users/kofi/_/sync && pnpm test test/engine/phase2-conflict.test.ts --reporter=verbose 2>&1 | grep -E "Q1|✓|✗|PASS|FAIL|Cannot"
```

Expected: 4 Q1 tests passing. The rest of the file will fail to compile (imports for Engine, ResolverPump not yet changed) — that's fine at this step if Vitest runs the passing tests in isolation. If type errors block the run, comment out the non-Q1 describe blocks temporarily and uncomment after Task 3.

- [ ] **Step 5: Run full suite — existing 24 tests must still pass**

```bash
cd /Users/kofi/_/sync && pnpm test 2>&1 | tail -5
```

Expected: 24 existing tests pass. Q1 tests pass as a bonus. Zero failures.

- [ ] **Step 6: Commit**

```bash
git add src/strategies/vector-clock.ts test/engine/phase2-conflict.test.ts
git commit -m "feat(strategy): VectorClockStrategy — first strategy returning concurrent; Q1 gate tests"
```

---

## Task 3: Engine Model C — `openConflicts`, detect-and-hold, `resolveConflict`

**Files:**
- Modify: `src/core/engine.ts`
- Modify: `test/engine/phase2-conflict.test.ts` (add Q2, Q5, Q6 describes)

**Interfaces:**
- Consumes: `VectorClockStrategy` from Task 2
- Produces:
  - `ScopeState.openConflicts: Map<string, { local: VersionedChange; remote: VersionedChange }>` — open conflicts keyed by unit key
  - `Engine.resolveConflict(scope: Scope, unit: ConflictUnit, resolution: Resolution): void` — public method; engine-internal seam, not G2 API

- [ ] **Step 1: Write failing Q2, Q5, Q6 tests (append to test file)**

Append these describe blocks to `test/engine/phase2-conflict.test.ts`, after the Q1 describe:

```typescript
// ---------------------------------------------------------------------------
// Q2 — Model C: conflict detected and held; apply() stays synchronous
// ---------------------------------------------------------------------------

describe("Q2 · Model C: concurrent conflict detected, held, apply() synchronous", () => {
  it("concurrent writes open a conflict; apply() returns synchronously; cursor does not advance", async () => {
    const clockA = new VectorClockStrategy("A");
    const clockB = new VectorClockStrategy("B");
    const scope = makeScope("q2-doc");
    const engine = new Engine(new VectorClockStrategy("engine"));

    // Land confirmed state via A's version.
    const vA = clockA.mint();
    await engine.apply(makeStateBatch(scope, "u1", "val-A", "id-A", vA));
    const cursorAfterFirst = engine.getCursor(scope);
    expect(cursorAfterFirst._seq).toBe(1);

    // Apply causally-independent version from B — must be concurrent.
    const vB = clockB.mint(); // no knowledge of vA → concurrent

    let conflictFired = false;
    engine.subscribe(scope, {
      onBatch: () => {},
      onConflict: () => {
        conflictFired = true;
        return { decision: "defer" };
      },
    });

    // apply() fires onConflict synchronously during the call — no microtask needed.
    // If conflictFired is true BEFORE await, the notification happened inline.
    const p = engine.apply(makeStateBatch(scope, "u1", "val-B", "id-B", vB));
    expect(conflictFired).toBe(true); // fires synchronously inside apply(), before any yield
    await p;
    // Cursor must NOT have advanced — concurrent change does not confirm.
    expect(engine.getCursor(scope)._seq).toBe(1);
  });

  it("snapshot() shows last-confirmed value immediately after conflict detection", async () => {
    const clockA = new VectorClockStrategy("A");
    const clockB = new VectorClockStrategy("B");
    const scope = makeScope("q2-snap");
    const engine = new Engine(new VectorClockStrategy("engine"));

    const vA = clockA.mint();
    await engine.apply(makeStateBatch(scope, "u1", "confirmed-val", "id-A", vA));

    const vB = clockB.mint();
    await engine.apply(makeStateBatch(scope, "u1", "concurrent-val", "id-B", vB));

    const state = await getState(engine, scope);
    // last-confirmed-winner: concurrent incoming must NOT overwrite confirmed state.
    expect(state.get("u1")).toBe("confirmed-val");
  });
});

// ---------------------------------------------------------------------------
// Q5 — defer leaves conflict open
// ---------------------------------------------------------------------------

describe("Q5 · defer: conflict stays open, state unchanged, subsequent resolution lands", () => {
  it("resolver returning defer keeps last-confirmed; subsequent take-remote lands correctly", async () => {
    const clockA = new VectorClockStrategy("A");
    const clockB = new VectorClockStrategy("B");
    const scope = makeScope("q5-doc");
    const unit = makeConflictUnit("u1");
    const engine = new Engine(new VectorClockStrategy("engine"));

    const vA = clockA.mint();
    await engine.apply(makeStateBatch(scope, "u1", "confirmed-val", "id-A", vA));

    const vB = clockB.mint();
    await engine.apply(makeStateBatch(scope, "u1", "concurrent-val", "id-B", vB));

    // Confirmed state unchanged after conflict detected.
    expect((await getState(engine, scope)).get("u1")).toBe("confirmed-val");

    // Call resolveConflict with defer — must leave conflict open.
    engine.resolveConflict(scope, unit, { decision: "defer" });
    expect((await getState(engine, scope)).get("u1")).toBe("confirmed-val");

    // Resolve with take-remote — concurrent-val should now land.
    engine.resolveConflict(scope, unit, { decision: "take-remote" });
    expect((await getState(engine, scope)).get("u1")).toBe("concurrent-val");
  });

  it("resolveConflict on a unit with no open conflict is a no-op and does not throw", () => {
    const engine = new Engine(new VectorClockStrategy("engine"));
    expect(() =>
      engine.resolveConflict(
        makeScope("no-conflict"),
        makeConflictUnit("u1"),
        { decision: "take-local" },
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Q6 — last-confirmed-winner reads during open conflict
// ---------------------------------------------------------------------------

describe("Q6 · last-confirmed-winner reads during open conflict", () => {
  it("snapshot() returns confirmed value; changes() excludes concurrent incoming", async () => {
    const clockA = new VectorClockStrategy("A");
    const clockB = new VectorClockStrategy("B");
    const scope = makeScope("q6-doc");
    const engine = new Engine(new VectorClockStrategy("engine"));

    const vA = clockA.mint();
    await engine.apply(makeStateBatch(scope, "u1", "confirmed-val", "id-A", vA));

    const vB = clockB.mint();
    await engine.apply(makeStateBatch(scope, "u1", "concurrent-val", "id-B", vB));

    // snapshot: confirmed only.
    const state = await getState(engine, scope);
    expect(state.get("u1")).toBe("confirmed-val");

    // changes(): concurrent incoming must not appear in the durable log.
    const logIds = new Set<string>();
    for await (const batch of engine.changes(scope, null)) {
      for (const c of batch.changes) logIds.add(c.id.value);
    }
    expect(logIds.has("id-A")).toBe(true);  // confirmed change is in log
    expect(logIds.has("id-B")).toBe(false); // concurrent incoming is NOT in log
  });
});
```

- [ ] **Step 2: Run the new tests — confirm they fail before engine changes**

```bash
cd /Users/kofi/_/sync && pnpm test test/engine/phase2-conflict.test.ts --reporter=verbose 2>&1 | grep -E "Q2|Q5|Q6|FAIL|Error"
```

Expected: Q2/Q5/Q6 tests fail (no `resolveConflict` method, `concurrent` arm still returns without firing `onConflict`).

- [ ] **Step 3: Modify `src/core/engine.ts`**

**3a — Update imports** (add `ConflictUnit` and `VersionedChange` to the import statement; `makeChangeId` was removed in F7 and is not needed again since `merged` is deferred):

```typescript
import {
  makeCursor,
  type Feed,
  type ScopeRouter,
  type ClockStrategy,
  type Resolver,
  type Scope,
  type Cursor,
  type Change,
  type StateChange,
  type OpChange,
  type VersionedChange,
  type ConflictUnit,
  type Version,
  type ChangeBatch,
  type Snapshot,
  type Conflict,
  type Resolution,
  type Subscription,
} from "./types.ts";
```

**3b — Add `openConflicts` to `ScopeState` interface** (after the `seenIds` field):

```typescript
  /**
   * Open conflicts: units with concurrent competing versions held until resolved.
   * Last-confirmed-winner semantics: the confirmed maps (durableStateUnits /
   * ephemeralStateUnits) are unchanged while a conflict is open. The incoming
   * concurrent change is stored here, not in the confirmed maps, until
   * resolveConflict() lands a winner.
   */
  openConflicts: Map<string, { local: VersionedChange; remote: VersionedChange }>;
```

**3c — Initialize `openConflicts` in `_getOrCreateScope`** (add inside the object literal):

```typescript
        openConflicts: new Map(),
```

**3d — Replace the `concurrent` arm in `_applyState`** (the 3-line block starting with `if (cmp === "concurrent")`):

```typescript
      if (cmp === "concurrent") {
        // Model C — detect-and-hold. Record both competing sides; fire onConflict
        // as a notification; return synchronously. apply() does NOT own the
        // resolution lifecycle. The id stays open (not added to seenIds) so
        // resolveConflict() can re-land the winner without being blocked by dedup.
        const conflict: Conflict = {
          unit: change.unit,
          scope: change.scope,
          local: currentWinner.change as VersionedChange,
          remote: change as VersionedChange,
        };
        scope.openConflicts.set(change.unit.key, {
          local: currentWinner.change as VersionedChange,
          remote: change as VersionedChange,
        });
        for (const handlers of scope.subs) {
          // Notification only — return value intentionally ignored (Model C).
          handlers.onConflict(conflict);
        }
        return false;
      }
```

**3e — Add the `resolveConflict` public method** (after `getCursor`, before `_getOrCreateScope`):

```typescript
  /**
   * Apply a Resolution to an open conflict on a unit. Engine-internal seam —
   * not part of the Feed or ScopeRouter interfaces; not the G2 consumer API.
   *
   * - `take-local`: local is already confirmed; marks both ids seen so gossip
   *   redelivery cannot re-open the conflict. No state change, no onBatch.
   * - `take-remote`: lands the remote change directly into the confirmed maps,
   *   advances cursor (if durable), fires onBatch.
   * - `merged`: NOT supported in Phase 2. With VectorClockStrategy, minting a
   *   fresh version produces a vector with no causal history from either input,
   *   which would compare as `concurrent` with both sides and open a recursive
   *   conflict if gossiped. Correct support requires `ClockStrategy.mergeVersions`
   *   (a seam-contract addition deferred to a later phase). Throws explicitly.
   * - `defer`: no-op — conflict stays open.
   *
   * Phase 2 scope note: `openConflicts` holds one entry per unit key. If a second
   * concurrent write arrives before the first is resolved, the entry is overwritten
   * (only the latest remote is preserved). Multi-way conflict handling is deferred.
   *
   * Calling resolveConflict on a unit with no open conflict is a no-op.
   */
  resolveConflict(scope: Scope, unit: ConflictUnit, resolution: Resolution): void {
    const scopeState = this._scopes.get(scope.key);
    if (!scopeState) return;
    const open = scopeState.openConflicts.get(unit.key);
    if (!open) return;

    if (resolution.decision === "defer") return; // conflict stays open

    if (resolution.decision === "merged") {
      // Deferred: requires ClockStrategy.mergeVersions to produce a version that
      // causally dominates both sides. Without it the merged change would be
      // concurrent with both inputs and trigger a recursive conflict on gossip.
      throw new Error(
        "resolveConflict: 'merged' is not supported in Phase 2. " +
          "Use take-local, take-remote, or defer.",
      );
    }

    scopeState.openConflicts.delete(unit.key);

    // Prevent gossip redelivery from re-opening this conflict.
    scopeState.seenIds.add(open.local.id.value);
    scopeState.seenIds.add(open.remote.id.value);

    if (resolution.decision === "take-local") {
      // Local is already in the confirmed maps (last-confirmed-winner held it).
      // No state change or notification needed — state is already correct.
      return;
    }

    // take-remote: land the remote change directly into the confirmed maps,
    // bypassing _applyState (which would re-detect concurrent and loop).
    const winnerChange = open.remote as StateChange;

    if (winnerChange.lifetime.class === "durable") {
      scopeState.durableStateUnits.set(unit.key, { change: winnerChange });
      scopeState.cursorSeq++;
      scopeState.durableLog.push({ change: winnerChange, seq: scopeState.cursorSeq });
    } else {
      scopeState.ephemeralStateUnits.set(unit.key, { change: winnerChange });
    }

    // Notify subscriptions so gossip wiring propagates the winning value.
    const outBatch: ChangeBatch = {
      scope,
      changes: [winnerChange],
      ...(winnerChange.lifetime.class === "durable"
        ? { cursor: makeCursor(scope, scopeState.cursorSeq) }
        : {}),
    };
    for (const handlers of scopeState.subs) {
      handlers.onBatch(outBatch);
    }
  }
```

- [ ] **Step 4: Run type check**

```bash
cd /Users/kofi/_/sync && pnpm typecheck 2>&1
```

Expected: 0 errors.

- [ ] **Step 5: Run Q2, Q5, Q6 tests — confirm they pass**

```bash
cd /Users/kofi/_/sync && pnpm test test/engine/phase2-conflict.test.ts --reporter=verbose 2>&1 | grep -E "Q1|Q2|Q5|Q6|✓|✗|PASS|FAIL"
```

Expected: Q1 (4), Q2 (2), Q5 (1), Q6 (1) all passing.

- [ ] **Step 6: Run full suite — all 24 existing tests still pass**

```bash
cd /Users/kofi/_/sync && pnpm test 2>&1 | tail -5
```

Expected: 28+ tests passing (24 original + 8 new), 0 failures.

- [ ] **Step 7: Commit**

```bash
git add src/core/engine.ts test/engine/phase2-conflict.test.ts
git commit -m "feat(engine): Model C detect-and-hold — openConflicts, concurrent arm, resolveConflict"
```

---

## Task 4: ResolverPump + Q3 test

**Files:**
- Create: `src/core/resolver-pump.ts`
- Modify: `test/engine/phase2-conflict.test.ts` (add Q3 describe)

**Interfaces:**
- Consumes: `Engine.subscribe`, `Engine.resolveConflict` (Task 3), `Resolver` (frozen seam)
- Produces: `ResolverPump` — `constructor(engine: Engine, resolver: Resolver, scope: Scope)`, `dispose(): void`

- [ ] **Step 1: Write failing Q3 test (append to test file)**

```typescript
// ---------------------------------------------------------------------------
// Q3 — Resolver wiring is live (closes Phase 1b Finding #3)
// ---------------------------------------------------------------------------

describe("Q3 · ResolverPump: resolver IS invoked on a concurrent conflict", () => {
  it("recording resolver is called exactly once with the correct conflict payload", async () => {
    const clockA = new VectorClockStrategy("A");
    const clockB = new VectorClockStrategy("B");
    const scope = makeScope("q3-doc");
    const unit = makeConflictUnit("u1");

    const capturedConflicts: Conflict[] = [];
    const recordingResolver: Resolver = {
      resolve(conflict: Conflict): Resolution {
        capturedConflicts.push(conflict);
        return { decision: "take-local" };
      },
    };

    const engine = new Engine(new VectorClockStrategy("engine"));
    new ResolverPump(engine, recordingResolver, scope);

    const vA = clockA.mint();
    await engine.apply(makeStateBatch(scope, "u1", "val-A", "id-A", vA));

    const vB = clockB.mint(); // concurrent — no knowledge of vA
    await engine.apply(makeStateBatch(scope, "u1", "val-B", "id-B", vB));

    // Resolver must have been called exactly once.
    expect(capturedConflicts).toHaveLength(1);
    expect(capturedConflicts[0]!.unit.key).toBe(unit.key);
    expect(capturedConflicts[0]!.scope.key).toBe(scope.key);
    // local = confirmed state (val-A); remote = incoming concurrent (val-B)
    expect(capturedConflicts[0]!.local.value).toBe("val-A");
    expect(capturedConflicts[0]!.remote.value).toBe("val-B");
  });
});
```

- [ ] **Step 2: Run Q3 test — confirm it fails**

```bash
cd /Users/kofi/_/sync && pnpm test test/engine/phase2-conflict.test.ts --reporter=verbose 2>&1 | grep -E "Q3|Cannot|Error"
```

Expected: Q3 fails — `Cannot find module '../../src/core/resolver-pump.ts'`.

- [ ] **Step 3: Create `src/core/resolver-pump.ts`**

```typescript
/**
 * ResolverPump — optional bridge from onConflict notification to resolveConflict().
 *
 * Subscribes to the engine's onConflict stream for a scope. On each conflict,
 * calls resolver.resolve() and feeds the result back to engine.resolveConflict().
 * Lives entirely outside apply() — the engine fires onConflict as a notification
 * and returns; the pump drives resolution as a separate transition (Model C).
 *
 * Absent → conflicts stay open until resolved manually via engine.resolveConflict().
 * Present → automatic resolution per the injected Resolver.
 *
 * Async resolvers: if resolver.resolve() returns a Promise, the pump awaits it and
 * calls resolveConflict when the promise settles. The synchronous return to the
 * engine is { decision: "defer" } — the conflict stays open until the async result
 * lands. This is the correct representation of an in-flight async resolution.
 */

import type { Resolver, Scope, Conflict, Resolution } from "./types.ts";
import type { Engine } from "./engine.ts";

export class ResolverPump {
  private readonly _sub: { unsubscribe(): void };

  constructor(engine: Engine, resolver: Resolver, scope: Scope) {
    this._sub = engine.subscribe(scope, {
      onBatch: () => {},
      onConflict: (conflict: Conflict): Resolution => {
        const result = resolver.resolve(conflict);
        if (result instanceof Promise) {
          result
            .then((res) => engine.resolveConflict(conflict.scope, conflict.unit, res))
            .catch((err) => {
              // Surface async resolution failures — callers cannot observe them otherwise.
              console.error("[ResolverPump] async resolution failed:", err);
            });
          // Conflict stays open while async resolution is in-flight.
          return { decision: "defer" };
        }
        engine.resolveConflict(conflict.scope, conflict.unit, result);
        return result;
      },
    });
  }

  /** Unsubscribe the pump. Conflicts detected after this call are not auto-resolved. */
  dispose(): void {
    this._sub.unsubscribe();
  }
}
```

- [ ] **Step 4: Run type check**

```bash
cd /Users/kofi/_/sync && pnpm typecheck 2>&1
```

Expected: 0 errors.

- [ ] **Step 5: Run Q1–Q3 tests — all pass**

```bash
cd /Users/kofi/_/sync && pnpm test test/engine/phase2-conflict.test.ts --reporter=verbose 2>&1 | grep -E "Q1|Q2|Q3|Q5|Q6|✓|PASS|FAIL"
```

Expected: Q1 (4), Q2 (2), Q3 (1), Q5 (1), Q6 (1) — all passing.

- [ ] **Step 6: Run full suite**

```bash
cd /Users/kofi/_/sync && pnpm test 2>&1 | tail -5
```

Expected: 29+ passing, 0 failures.

- [ ] **Step 7: Commit**

```bash
git add src/core/resolver-pump.ts test/engine/phase2-conflict.test.ts
git commit -m "feat(engine): ResolverPump — bridges onConflict → resolveConflict; Q3 gate test"
```

---

## Task 5: End-to-end convergence test (Q4)

**Files:**
- Modify: `test/engine/phase2-conflict.test.ts` (add Q4 describe)

**Convergence mechanism: approach (a) — deterministic pure function of the conflict.**
The resolver picks the change whose `id.value` is lexicographically larger. Every replica
independently computes the same winner because the resolver is a pure symmetric function of
the conflict payload:

- On Replica A: `local = A's change (id: "id-A")`, `remote = B's change (id: "id-B")`
- On Replica B: `local = B's change (id: "id-B")`, `remote = A's change (id: "id-A")`
- Resolver: `local.id.value > remote.id.value ? take-local : take-remote`
- With ids "id-A" < "id-B": A picks `take-remote` (B's value), B picks `take-local` (B's value) → both converge on B's value ✓

No gossip of the resolution needed — each replica resolves independently to the same answer.

**Interfaces:**
- Consumes: `VectorClockStrategy` (Task 2), `Engine.resolveConflict` (Task 3), `ResolverPump` (Task 4)

- [ ] **Step 1: Write the Q4 test (append to test file)**

```typescript
// ---------------------------------------------------------------------------
// Q4 — Resolution converges on ≥2 replicas (headline gate)
// ---------------------------------------------------------------------------

describe("Q4 · Convergence: deterministic resolver produces same result on both replicas", () => {
  it("two replicas independently resolve the same conflict to the same value under fault injection", async () => {
    // Convergence mechanism: approach (a) — deterministic pure function of the
    // conflict. Picks the change with the lexicographically-larger id.value.
    // Symmetric: same winner regardless of which side is "local" vs "remote".
    const deterministicResolver: Resolver = {
      resolve(conflict: Conflict): Resolution {
        return conflict.local.id.value > conflict.remote.id.value
          ? { decision: "take-local" }
          : { decision: "take-remote" };
      },
    };

    const clockA = new VectorClockStrategy("A");
    const clockB = new VectorClockStrategy("B");
    const scope = makeScope("q4-doc");

    // Two engines; each uses its own VectorClockStrategy so their minted versions
    // have no causal relationship (concurrent by construction).
    const engineA = new Engine(new VectorClockStrategy("engine-A"));
    const engineB = new Engine(new VectorClockStrategy("engine-B"));

    // Attach ResolverPumps BEFORE applying local writes so they are subscribed
    // when onConflict fires.
    new ResolverPump(engineA, deterministicResolver, scope);
    new ResolverPump(engineB, deterministicResolver, scope);

    // Wire gossip (with fault injection).
    const { allChannels, throwIfErrors } = setupGossip(
      [engineA, engineB],
      scope,
      400,
      { dropRate: 0.2, reorderRate: 0.2, duplicateRate: 0.1 },
    );

    // Both replicas write to the same unit WITHOUT exchanging first.
    // "id-A" < "id-B" lexicographically → B's value is the expected winner.
    const vA = clockA.mint();
    const vB = clockB.mint(); // no knowledge of vA → concurrent
    await engineA.apply(makeStateBatch(scope, "u1", "val-A", "id-A", vA));
    await engineB.apply(makeStateBatch(scope, "u1", "val-B", "id-B", vB));

    await drainChannels(allChannels);
    throwIfErrors();

    const stateA = await getState(engineA, scope);
    const stateB = await getState(engineB, scope);

    // Both replicas must agree — the deterministic resolver picked the same winner.
    expect(stateA.get("u1")).toBe(stateB.get("u1"));
    // "id-B" > "id-A" → "val-B" is the winner on both replicas.
    expect(stateA.get("u1")).toBe("val-B");
  });

  it("convergence holds across multiple units with independent concurrent conflicts", async () => {
    const deterministicResolver: Resolver = {
      resolve(conflict: Conflict): Resolution {
        return conflict.local.id.value > conflict.remote.id.value
          ? { decision: "take-local" }
          : { decision: "take-remote" };
      },
    };

    const clockA = new VectorClockStrategy("A");
    const clockB = new VectorClockStrategy("B");
    const scope = makeScope("q4-multi");

    const engineA = new Engine(new VectorClockStrategy("engine-A"));
    const engineB = new Engine(new VectorClockStrategy("engine-B"));

    new ResolverPump(engineA, deterministicResolver, scope);
    new ResolverPump(engineB, deterministicResolver, scope);

    const { allChannels, throwIfErrors } = setupGossip([engineA, engineB], scope, 410);

    // Concurrent writes to two different units.
    // u1: "id-u1-A" < "id-u1-B" → val-B wins
    // u2: "id-u2-A" < "id-u2-B" → val-B wins
    await engineA.apply(makeStateBatch(scope, "u1", "u1-val-A", "id-u1-A", clockA.mint()));
    await engineA.apply(makeStateBatch(scope, "u2", "u2-val-A", "id-u2-A", clockA.mint()));
    await engineB.apply(makeStateBatch(scope, "u1", "u1-val-B", "id-u1-B", clockB.mint()));
    await engineB.apply(makeStateBatch(scope, "u2", "u2-val-B", "id-u2-B", clockB.mint()));

    await drainChannels(allChannels);
    throwIfErrors();

    const stateA = await getState(engineA, scope);
    const stateB = await getState(engineB, scope);

    expect(stateA.get("u1")).toBe(stateB.get("u1"));
    expect(stateA.get("u2")).toBe(stateB.get("u2"));
    expect(stateA.get("u1")).toBe("u1-val-B");
    expect(stateA.get("u2")).toBe("u2-val-B");
  });
});
```

- [ ] **Step 2: Run Q4 tests — verify they pass with the full wiring in place**

All dependencies exist from Tasks 2–4 (VectorClockStrategy + Model C engine + ResolverPump). These tests should pass on first run. If they fail, read the error and diagnose — do not proceed until green.

```bash
cd /Users/kofi/_/sync && pnpm test test/engine/phase2-conflict.test.ts --reporter=verbose 2>&1 | grep -E "Q4|✓|✗|PASS|FAIL"
```

- [ ] **Step 3: Run full suite — all tests pass**

```bash
cd /Users/kofi/_/sync && pnpm test 2>&1 | tail -5
```

Expected: 31+ passing, 0 failures.

- [ ] **Step 4: Commit**

```bash
git add test/engine/phase2-conflict.test.ts
git commit -m "test(phase2): Q4 convergence — deterministic resolver proven on 2 replicas under fault injection"
```

---

## Task 6: Q7 regression + documentation update

**Files:**
- Modify: `docs/implementation-state.md`
- Modify: `docs/decision-log.md`

**Interfaces:** None — documentation only.

- [ ] **Step 1: Q7 regression — full suite green, tsc clean**

```bash
cd /Users/kofi/_/sync && pnpm typecheck && pnpm test 2>&1 | tail -8
```

Expected: `tsc --noEmit` exits 0; all tests pass (36 total: 24 original + Q1×4 + Q2×2 + Q3×1 + Q4×2 + Q5×2 + Q6×1 = 36).

- [ ] **Step 2: Update `docs/implementation-state.md`**

In the **Status** section, replace the Phase 1b status paragraph opening with:

```markdown
## Status: PHASE 2 CONFLICT RESOLUTION COMPLETE — vector clock, Model C engine, ResolverPump

The T4 `concurrent` path activated in Phase 2. `VectorClockStrategy` is the first strategy
returning `"concurrent"`. Engine now implements Model C (detect-and-hold): the `concurrent` arm
records open conflicts in `ScopeState.openConflicts`, fires `onConflict` as a notification, and
returns synchronously — `apply()` never awaits resolution. `resolveConflict(scope, unit, resolution)`
lands a resolution directly into the confirmed maps. `ResolverPump` bridges `onConflict` →
`resolver.resolve` → `resolveConflict` as an optional layer. Convergence proven on 2 replicas
under fault injection using approach (a): deterministic pure-function resolver (pick-by-id).
Q1–Q7 gate passing; 36 tests total; `tsc --noEmit` clean.
```

In the **strategies** table, add a row after the LWW row:

```markdown
| `src/strategies/vector-clock.ts` | REAL | `VectorClockStrategy implements ClockStrategy`. Version shape: `{ _vec: Record<nodeId, number> }`. `mint(prev?)` merges prev vector then increments own slot. `compare()` returns `"concurrent"` for causally-independent versions; `"before"`/`"after"` for ordered versions. First strategy to exercise T4 conflict path. |
```

In the **engine** table, change the `concurrent` detection row from DEFERRED to REAL:

```markdown
| conflict detection (`concurrent` path) | REAL | Model C detect-and-hold. `ScopeState.openConflicts` holds both competing `VersionedChange`s per unit. `concurrent` arm fires `onConflict` as notification, returns synchronously. `resolveConflict(scope, unit, resolution)` lands resolution directly into confirmed maps; advances cursor/log for durable wins. `take-local`/`take-remote` supported; `defer` leaves conflict open; `merged` throws (deferred — requires `ClockStrategy.mergeVersions`). Note: `_applyOp` concurrent arm consciously deferred — op-with-version path stores only `Version`, not full `VersionedChange`; needs follow-up. |
```

Add a row for `resolver-pump.ts`:

```markdown
| `src/core/resolver-pump.ts` | REAL | `ResolverPump`. Subscribes to `onConflict`; calls `resolver.resolve(conflict)`; calls `resolveConflict` with the result. Async resolvers: returns `defer` synchronously while the promise settles. Absent ⇒ conflicts stay open for manual resolution. Closes Phase 1b Finding #3 (Resolver/onConflict were dead under all paths). |
```

In the **test/engine/** table, update the engine.test.ts row and add phase2-conflict.test.ts:

```markdown
| `test/engine/phase2-conflict.test.ts` | REAL | 12 tests covering Q1–Q7 (Phase 2 gate). Q1: vector clock concurrent detection (4 tests). Q2: Model C detect-and-hold (2). Q3: ResolverPump resolver invocation. Q4: 2-replica convergence under fault injection with deterministic resolver (2). Q5: defer holds + subsequent resolution + no-op on non-conflicting unit (2). Q6: last-confirmed-winner reads during open conflict. |
```

In the **Known gaps / defects** section, remove the `Resolver / onConflict are wired but never invoked` finding and the `concurrent routing to Resolver` deferred item, and add:

```markdown
### Finding — `_applyOp` concurrent arm still deferred [Phase 2 follow-up]
`_applyOp` stores only the last accepted `Version` per unit in `opUnitVersions`, not the full
`VersionedChange`. A correct `Conflict` payload requires both `local` and `remote` as
`VersionedChange`. Fix: store the full `VersionedChange` in `opUnitVersions` (rename to
`opUnitChanges: Map<string, VersionedChange>`). Out of scope for Phase 2 per the gate file.
```

- [ ] **Step 3: Update `docs/decision-log.md`**

Update the `_Last updated_` line:

```markdown
_Last updated: 2026-06-28. Seam Contract **v1.0** (frozen)._
```

Update the **Status at a glance** bullet for the code line:

```markdown
- **Code:** Phase 2 complete. `VectorClockStrategy` + Model C engine (`openConflicts`, `resolveConflict`) + `ResolverPump`. 36 tests passing. `tsc --noEmit` clean. T4 concurrent path activated and proven on ≥2 replicas.
```

Add to the **Locked** section (after the `concurrent path deferred` bullet — which can be updated):

Replace `- **concurrent path deferred to Phase 2** — ...` with:

```markdown
- **T4 — `concurrent` path — Model C activated [Phase 2]** — detect-and-hold: `apply()` records
  open conflict + fires `onConflict` synchronously; engine does not own resolution lifecycle.
  `resolveConflict(scope, unit, resolution)` is the internal resolution seam. `ResolverPump`
  is the optional automatic bridge. Convergence: approach (a) — deterministic pure-function
  resolver proven on ≥2 replicas under fault injection. `_applyOp` concurrent arm deferred
  (needs full VersionedChange stored per unit). See 2026-06-28 Phase 2 entry.
```

Append to the **Log** (after the last entry):

```markdown
### 2026-06-28 — Phase 2 conflict resolution activated: Model C, VectorClockStrategy, ResolverPump [LOCKED]

**Entry condition met.** A strategy returning `"concurrent"` (`VectorClockStrategy`) implemented
and a real `Resolver` path activated. All seven Phase 2 gate items (Q1–Q7) passing. 35 total
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
```

- [ ] **Step 4: Final verification**

```bash
cd /Users/kofi/_/sync && pnpm typecheck && pnpm test 2>&1 | tail -8
```

Expected: `tsc` exits 0; all tests pass.

- [ ] **Step 5: Commit docs + push**

```bash
git add docs/implementation-state.md docs/decision-log.md
git commit -m "docs: Phase 2 complete — implementation-state and decision-log updated"
git push
```

---

## Self-Review

**Spec coverage:**

| Brief requirement | Covered in task |
|---|---|
| `concurrent`-producing ClockStrategy | Task 2 — `VectorClockStrategy` |
| Model C detect-and-hold | Task 3 — `openConflicts` + `concurrent` arm |
| `resolveConflict(scope, unit, resolution)` | Task 3 |
| Optional `ResolverPump` | Task 4 |
| End-to-end ≥2 replica convergence | Task 5 — Q4 |
| Gate file written before code | Task 1 |
| Q1–Q7 gate items | Tasks 1–5 |
| `apply()` stays synchronous | Task 3 (asserted in Q2) |
| Last-confirmed-winner reads | Task 3 (asserted in Q6) |
| No seam-contract change | All tasks — no `types.ts` edits |
| `lww.ts` untouched | All tasks |
| Harness untouched | All tasks |
| 24 existing tests green | Verified in Tasks 2–5 |
| `_applyOp` deferred + documented | Task 1 (gate file), Task 6 (docs) |
| P8/P9 carry-forward | Already present; noted in Global Constraints |
| implementation-state updated | Task 6 |
| decision-log entry | Task 6 |
| Done = committed + pushed | Task 6, Step 5 |

**Placeholder scan:** No TBD, TODO, or "similar to" in any step. All code blocks are complete.

**Type consistency:**
- `VectorClockStrategy` used as `ClockStrategy` in `Engine` constructor — matches `ClockStrategy` interface.
- `Engine.resolveConflict(scope: Scope, unit: ConflictUnit, resolution: Resolution)` — `ConflictUnit` and `VersionedChange` added to engine.ts imports in Task 3 Step 3a. `makeConflictUnit` used in tests. Consistent.
- `makeChangeId` NOT re-added to engine.ts (removed in F7; not needed since `merged` is deferred). ✓
- `ResolverPump` constructor takes `Engine` (concrete class) for access to `resolveConflict` — intentional; `resolveConflict` is not on `Feed`/`ScopeRouter` interfaces.
- `openConflicts: Map<string, { local: VersionedChange; remote: VersionedChange }>` — `VersionedChange` added to engine.ts imports in Task 3 Step 3a.
- Test helper `makeStateBatch` uses `id` directly (not the derived `c-${unitKey}-${idSuffix}` pattern from engine.test.ts) — tests reference ids by the exact strings passed. Consistent within this file.
- `vi` removed from vitest import — no usages in any test. ✓
- Q5 no-op test uses `makeScope`/`makeConflictUnit` — both imported at top of file. ✓
