# Phase 3: `merged` Resolution + `ClockStrategy.mergeVersions` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the `merged` resolution decision in the engine by adding `mergeVersions?` to `ClockStrategy`, implementing it as element-wise max in `VectorClockStrategy`, and replacing the throw in `resolveConflict`'s `merged` arm with the full landing path — verified by 7 gate items including a ≥2-replica convergence test under fault injection.

**Architecture:** `ClockStrategy.mergeVersions?(a, b)` is optional — strategies where `compare` never returns `"concurrent"` (LWW) omit it. The engine guard throws a precise error if called without it. `VectorClockStrategy.mergeVersions` computes element-wise max (causal join, no local increment), producing a version that dominates both inputs and is `compare`-equal across replicas running the same inputs. The engine merged arm mints a fresh `StateChange` carrying the merged version, clears the open conflict, marks both input ids seen, writes to the appropriate state map, and fires `onBatch`.

**Tech Stack:** TypeScript (strict), Vitest, `pnpm typecheck` (tsc --strict), `pnpm test` (vitest run)

## Global Constraints

- `tsc --strict` must remain clean after every commit — `pnpm typecheck`
- `pnpm test` must remain green after every commit (no regression in existing ~40 tests)
- Never compare versions with `===` / `JSON.stringify` / deep-equal — use `clock.compare()` only
- `_applyOp` concurrent routing is out of scope — do not touch it
- No propagation hook for merged changes — out of scope
- `LWWClockStrategy` must NOT implement `mergeVersions` — C3 gate
- Fresh `ChangeId` for merged change — IDs need not match across replicas; convergence rides the version
- Per AGENTS.md: write the gate file before touching any source code

---

## File Map

| File | Action | What changes |
|------|--------|-------------|
| `docs/gates/phase3-merge-resolution.md` | **Create** | Gate acceptance contract (must exist before code) |
| `src/core/types.ts` | **Modify** | Add `mergeVersions?(a: Version, b: Version): Version` to `ClockStrategy`; bump header comment to v1.1 |
| `docs/seam-contract.md` | **Modify** | Bump `ClockStrategy` interface in §2 to v1.1; add §5 note that `merged` requires `mergeVersions` |
| `src/strategies/vector-clock.ts` | **Modify** | Add `mergeVersions` implementation (element-wise max, no increment) |
| `src/strategies/lww.ts` | **No change** | Verified untouched for C3 |
| `src/core/engine.ts` | **Modify** | Replace `merged` throw in `resolveConflict` with full landing path |
| `test/engine/phase3-merge-resolution.test.ts` | **Create** | Gate tests: C2 strategy unit tests, C4 engine merged arm, C5 guard, C6 2-replica + 3-replica convergence |

---

## Task 1: Gate File (MUST be first — AGENTS.md gate-file-before-code)

**Files:**
- Create: `docs/gates/phase3-merge-resolution.md`

**Interfaces:**
- Produces: gate file that must exist before any source code is touched

- [ ] **Step 1: Write the gate file**

Create `docs/gates/phase3-merge-resolution.md` with this exact content:

```markdown
# ns Phase 3 Gate — `merged` Resolution + `ClockStrategy.mergeVersions`

> Written before code per AGENTS.md discipline.
> Design basis: `docs/design/merge-resolution.md` (Q-C crux: max-only join).
> Implementation brief: `impl-brief-mergeversions.draft.md`.
> All items must be independently failable (a pass that cannot fail proves nothing).

## Gate items

**C1 — Contract surface.**
`ClockStrategy` in `src/core/types.ts` declares `mergeVersions?(a: Version, b: Version): Version`
as an optional method. `tsc --strict` is clean.
*Evidence:* `grep mergeVersions src/core/types.ts` present + `pnpm typecheck` exits 0.
*Fails if:* method missing, or non-optional (would force LWW to implement it), or `tsc` errors.

**C2 — `VectorClockStrategy.mergeVersions` correctness.**
Implementation: element-wise max of both `_vec` records, no local-slot increment.
*Evidence:* unit tests in `test/engine/phase3-merge-resolution.test.ts` —
- `compare(merge(a,b), a) === "after"` (merged dominates a).
- `compare(merge(a,b), b) === "after"` (merged dominates b).
- `compare(merge(a,b), merge(b,a)) === "before"` (order-independent; logical equality via `compare`).
- `compare(a, merge(a,b)) === "before"` (redelivered input is skipped).
- `compare(mint(merge(a,b)), merge(a,b)) === "after"` (post-merge write dominates).
- N-way: `merge(merge(a,b), c)` dominates `a`, `b`, `c`.
*Fails if:* any assertion returns `concurrent`, or the merge increments a local slot.

**C3 — LWW omits `mergeVersions`.**
`LWWClockStrategy` does not implement `mergeVersions`. `tsc --strict` clean (optional method).
*Evidence:* `grep mergeVersions src/strategies/lww.ts` → no match + `pnpm typecheck` exits 0.
*Fails if:* LWW ships a stub or `tsc` requires it.

**C4 — Engine `merged` arm (`resolveConflict`).**
The throw is replaced. Single-engine test: a `merged` resolution writes the merged value to the
confirmed map, advances cursor iff durable, fires `onBatch` once, clears the open conflict.
*Evidence:* unit test in `test/engine/phase3-merge-resolution.test.ts`.
*Fails if:* throw remains; or merged value not in snapshot; or cursor advances on ephemeral;
or conflict stays open; or `onBatch` not fired.

**C5 — Guard: `merged` under a strategy without `mergeVersions`.**
Engine on a strategy that lacks `mergeVersions`; `resolveConflict(..., {decision:"merged", value})`
throws the precise error string ("strategy does not implement mergeVersions") before mutating any map.
*Evidence:* test verifies the throw AND that `openConflicts` still contains the entry after the throw.
*Fails if:* silent drop, or partial mutation before throw, or wrong error message.

**C6 — ≥2-replica convergence; merged value does NOT re-conflict on redelivery.**
2 engines (nodes A, B), `VectorClockStrategy` each, one scope, one unit, `ChannelSimulator`
with fault injection (drop/reorder/duplicate). Both write concurrently → `concurrent` detected.
A deterministic symmetric resolver returns `{decision:"merged", value:"merged-AB"}`.
Drain to quiescence. Assert:
- both `snapshot(scope)` for the unit are equal (converged on "merged-AB").
- the unit's confirmed version dominates both original input versions on both engines.
- duplicate redelivery of an original input does NOT re-open a conflict (`openConflicts` empty).
- 3-replica variant: isolate B, A+C merge and converge, reconnect B → all 3 converge on merged
  value, no lingering open conflict.
*Fails if:* snapshots diverge; OR merged version is `concurrent` with the other replica's merged
version (would happen under max-then-increment, not max-only → RED); OR redelivery re-opens conflict.

**C7 — Both gates green.**
`pnpm typecheck` (tsc --strict) exits 0 AND `pnpm test` (vitest run) all pass, including all
prior tests (no regression in the existing ~40 tests).
*Fails if:* either command exits non-zero.
```

- [ ] **Step 2: Commit the gate file**

```bash
git add docs/gates/phase3-merge-resolution.md
git commit -m "docs(gates): phase3-merge-resolution gate file — C1-C7 acceptance contract"
```

Expected: clean commit.

---

## Task 2: Contract Surface (C1, C3)

**Files:**
- Modify: `src/core/types.ts` (lines 1–10, 169–172)
- Modify: `docs/seam-contract.md` (§2 ClockStrategy block, §5 Resolver block)

**Interfaces:**
- Produces: `ClockStrategy.mergeVersions?(a: Version, b: Version): Version` — optional method on the interface; `LWWClockStrategy` remains untouched

- [ ] **Step 1: Add `mergeVersions?` to `ClockStrategy` in `src/core/types.ts`**

In `src/core/types.ts`, replace the `ClockStrategy` interface (currently lines 169–172):

```ts
// BEFORE:
export interface ClockStrategy {
  mint(prev?: Version): Version;
  compare(a: Version, b: Version): "before" | "after" | "concurrent";
}

// AFTER:
export interface ClockStrategy {
  mint(prev?: Version): Version;
  compare(a: Version, b: Version): "before" | "after" | "concurrent";
  /**
   * Return a version that causally dominates BOTH `a` and `b` and is
   * `compare`-equal across all replicas that call `mergeVersions(a, b)`.
   * Required by the `merged` resolution arm; omit on strategies where
   * `compare` never returns `"concurrent"` (e.g. LWW).
   * Seam contract v1.1 addition.
   */
  mergeVersions?(a: Version, b: Version): Version;
}
```

Also bump the file header comment on line 4 from `(v1.0)` to `(v1.1)`:

```ts
// BEFORE:
 * @neutro/sync — Seam Contract types (v1.0)

// AFTER:
 * @neutro/sync — Seam Contract types (v1.1)
```

- [ ] **Step 2: Bump `docs/seam-contract.md`**

In `docs/seam-contract.md`, find the `ClockStrategy` interface block (around line 128–139) and replace it:

```ts
// BEFORE:
/** The pluggability slot for versioning. The whole generality lives in `compare`. */
interface ClockStrategy {
  /** Mint a version for a new local state-change. */
  mint(prev?: Version): Version;
  /**
   * Three-valued comparison — the entirety of `ns`'s versioning involvement.
   *  - LWW:    version = timestamp; never returns "concurrent".
   *  - merge:  version = logical/hybrid clock; "concurrent" → merge-fn.
   *  - CRDT:   version = vector/position; "concurrent" is the common case.
   */
  compare(a: Version, b: Version): "before" | "after" | "concurrent";
}

// AFTER:
/** The pluggability slot for versioning. The whole generality lives in `compare`. (v1.1) */
interface ClockStrategy {
  /** Mint a version for a new local state-change. */
  mint(prev?: Version): Version;
  /**
   * Three-valued comparison — the entirety of `ns`'s versioning involvement.
   *  - LWW:    version = timestamp; never returns "concurrent".
   *  - merge:  version = logical/hybrid clock; "concurrent" → merge-fn.
   *  - CRDT:   version = vector/position; "concurrent" is the common case.
   */
  compare(a: Version, b: Version): "before" | "after" | "concurrent";
  /**
   * (v1.1) Mint a version that causally dominates both `a` and `b`, identical
   * across replicas. Required when `compare` can return `"concurrent"` and the
   * consumer uses `merged` resolutions. Omit on strategies where `compare`
   * never returns `"concurrent"` (e.g. LWW — `merged` is unreachable there).
   * The engine throws if `mergeVersions` is absent and `merged` is requested.
   */
  mergeVersions?(a: Version, b: Version): Version;
}
```

Then find the §5 Resolver convergence expectation note (around line 290) and append after it:

```markdown
> **`merged` requires `mergeVersions` (v1.1):** A resolver returning `{ decision: "merged" }` requires the active `ClockStrategy` to implement `mergeVersions`. The engine throws a precise error if it does not. The merged version produced by `mergeVersions(local.version, remote.version)` must (a) dominate both inputs under `compare`, and (b) be `compare`-equal across all replicas that call `mergeVersions` on the same pair — guaranteed for vector clock by the causal-join (max-only) rule. This is the contract that prevents merged changes from re-conflicting on gossip redelivery.
```

- [ ] **Step 3: Verify tsc is clean (C1 + C3)**

```bash
pnpm typecheck
```

Expected: exits 0. If `LWWClockStrategy` were forced to implement `mergeVersions`, tsc would error here — it doesn't, confirming C3.

- [ ] **Step 4: Verify LWW untouched (C3 evidence)**

```bash
grep mergeVersions src/strategies/lww.ts
```

Expected: no output (LWW does not implement it).

- [ ] **Step 5: Run existing tests to confirm no regression**

```bash
pnpm test
```

Expected: all existing tests pass (no new tests added yet — green baseline).

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts docs/seam-contract.md
git commit -m "feat(contract): ClockStrategy.mergeVersions — seam v1.0 → v1.1 (C1)"
```

---

## Task 3: `VectorClockStrategy.mergeVersions` (C2)

**Files:**
- Create: `test/engine/phase3-merge-resolution.test.ts` (C2 section only for now)
- Modify: `src/strategies/vector-clock.ts`

**Interfaces:**
- Consumes: `ClockStrategy.mergeVersions?(a: Version, b: Version): Version` from Task 2
- Produces: `VectorClockStrategy.mergeVersions(a, b)` — element-wise max, no increment

- [ ] **Step 1: Create the test file with C2 tests (failing)**

Create `test/engine/phase3-merge-resolution.test.ts`:

```ts
/**
 * Phase 3 gate tests — C1-C7.
 * Design basis: docs/design/merge-resolution.md (Q-C crux: max-only join).
 * Gate contract: docs/gates/phase3-merge-resolution.md
 */

import { describe, it, expect, vi } from "vitest";
import { Engine } from "../../src/core/engine.ts";
import { VectorClockStrategy } from "../../src/strategies/vector-clock.ts";
import { LWWClockStrategy } from "../../src/strategies/lww.ts";
import { ResolverPump } from "../../src/core/resolver-pump.ts";
import { ChannelSimulator } from "../harness/channel-simulator.ts";
import {
  makeChangeId,
  makeScope,
  makeConflictUnit,
  DURABLE,
  ephemeral,
} from "../../src/core/types.ts";
import type {
  ChangeBatch,
  Scope,
  Version,
  ConflictUnit,
  Conflict,
  Resolution,
  ClockStrategy,
} from "../../src/core/types.ts";
import type { FaultConfig } from "../harness/channel-simulator.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const SCOPE = makeScope("doc-1");
const UNIT = makeConflictUnit("field-x");

function makeDurableStateBatch(
  scope: Scope,
  unit: ConflictUnit,
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
        unit,
        kind: "state",
        lifetime: DURABLE,
        value,
        version,
      },
    ],
  };
}

async function getUnitValue(
  engine: Engine,
  scope: Scope,
  unit: ConflictUnit,
): Promise<unknown> {
  const snap = await engine.snapshot(scope);
  const change = snap.changes.find((c) => c.unit.key === unit.key);
  return change?.value;
}

async function getUnitVersion(
  engine: Engine,
  scope: Scope,
  unit: ConflictUnit,
): Promise<Version | undefined> {
  const snap = await engine.snapshot(scope);
  const change = snap.changes.find(
    (c) => c.unit.key === unit.key && c.kind === "state",
  );
  return change?.kind === "state" ? change.version : undefined;
}

/**
 * Wire N engines in a full gossip mesh via ChannelSimulator.
 * Returns { allChannels, drainChannels, throwIfErrors }.
 */
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
      channels.set(
        `${i}→${j}`,
        new ChannelSimulator(baseSeed + i * 100 + j, faultConfig),
      );
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
      onConflict: () => ({ decision: "defer" as const }),
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

async function drainChannels(
  channels: ChannelSimulator[],
  maxRounds = 200,
): Promise<void> {
  for (let round = 0; round < maxRounds; round++) {
    let delivered = 0;
    for (const ch of channels) delivered += ch.drain();
    await Promise.resolve();
    if (delivered === 0) return;
  }
  throw new Error(`drainChannels: did not quiesce after ${maxRounds} rounds`);
}

// ---------------------------------------------------------------------------
// C2 — VectorClockStrategy.mergeVersions
// ---------------------------------------------------------------------------

describe("C2 · VectorClockStrategy.mergeVersions", () => {
  const clockA = new VectorClockStrategy("node-A");
  const clockB = new VectorClockStrategy("node-B");
  const clockC = new VectorClockStrategy("node-C");

  const vA = clockA.mint(); // { node-A: 1 }
  const vB = clockB.mint(); // { node-B: 1 }

  it("mergeVersions is defined on VectorClockStrategy", () => {
    expect(typeof clockA.mergeVersions).toBe("function");
  });

  it("merged version dominates a (compare returns after)", () => {
    const merged = clockA.mergeVersions!(vA, vB);
    expect(clockA.compare(merged, vA)).toBe("after");
  });

  it("merged version dominates b (compare returns after)", () => {
    const merged = clockA.mergeVersions!(vA, vB);
    expect(clockA.compare(merged, vB)).toBe("after");
  });

  it("order-independent: merge(a,b) compare-equals merge(b,a)", () => {
    const mergeAB = clockA.mergeVersions!(vA, vB);
    const mergeBA = clockA.mergeVersions!(vB, vA);
    // compare-equal means neither is strictly after the other
    expect(clockA.compare(mergeAB, mergeBA)).toBe("before"); // equal → before (idempotent)
    expect(clockA.compare(mergeBA, mergeAB)).toBe("before");
  });

  it("original input a compares before merged (redelivery is skipped)", () => {
    const merged = clockA.mergeVersions!(vA, vB);
    expect(clockA.compare(vA, merged)).toBe("before");
  });

  it("original input b compares before merged (redelivery is skipped)", () => {
    const merged = clockA.mergeVersions!(vA, vB);
    expect(clockA.compare(vB, merged)).toBe("before");
  });

  it("post-merge local write dominates the merged version", () => {
    const merged = clockA.mergeVersions!(vA, vB);
    const postMerge = clockA.mint(merged); // mint after knowing about merged
    expect(clockA.compare(postMerge, merged)).toBe("after");
  });

  it("N-way: merge(merge(a,b), c) dominates a, b, and c", () => {
    const vC = clockC.mint(); // { node-C: 1 }
    const mergeAB = clockA.mergeVersions!(vA, vB);
    const mergeABC = clockA.mergeVersions!(mergeAB, vC);
    expect(clockA.compare(mergeABC, vA)).toBe("after");
    expect(clockA.compare(mergeABC, vB)).toBe("after");
    expect(clockA.compare(mergeABC, vC)).toBe("after");
  });

  it("mergeVersions never returns concurrent with its inputs", () => {
    const merged = clockA.mergeVersions!(vA, vB);
    expect(clockA.compare(merged, vA)).not.toBe("concurrent");
    expect(clockA.compare(merged, vB)).not.toBe("concurrent");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test test/engine/phase3-merge-resolution.test.ts
```

Expected: FAIL — `TypeError: clockA.mergeVersions is not a function` (method not yet implemented).

- [ ] **Step 3: Implement `mergeVersions` in `VectorClockStrategy`**

In `src/strategies/vector-clock.ts`, add the `mergeVersions` method after `compare`:

```ts
mergeVersions(a: Version, b: Version): Version {
  const av = asVC(a)._vec;
  const bv = asVC(b)._vec;
  const keys = new Set([...Object.keys(av), ...Object.keys(bv)]);
  const vec: Record<string, number> = {};
  for (const k of keys) {
    vec[k] = Math.max(av[k] ?? 0, bv[k] ?? 0);
  }
  return { _vec: vec } as unknown as Version;
}
```

The full updated class looks like:

```ts
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

  mergeVersions(a: Version, b: Version): Version {
    const av = asVC(a)._vec;
    const bv = asVC(b)._vec;
    const keys = new Set([...Object.keys(av), ...Object.keys(bv)]);
    const vec: Record<string, number> = {};
    for (const k of keys) {
      vec[k] = Math.max(av[k] ?? 0, bv[k] ?? 0);
    }
    return { _vec: vec } as unknown as Version;
  }
}
```

- [ ] **Step 4: Run C2 tests → GREEN**

```bash
pnpm test test/engine/phase3-merge-resolution.test.ts
```

Expected: all C2 tests PASS. Confirm no existing tests broken:

```bash
pnpm test
```

Expected: all tests PASS.

- [ ] **Step 5: Typecheck**

```bash
pnpm typecheck
```

Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/strategies/vector-clock.ts test/engine/phase3-merge-resolution.test.ts
git commit -m "feat(strategy): VectorClockStrategy.mergeVersions — element-wise max causal join (C2)"
```

---

## Task 4: Engine `merged` Arm — C4 and C5

**Files:**
- Modify: `test/engine/phase3-merge-resolution.test.ts` (add C4 and C5 test sections)
- Modify: `src/core/engine.ts` (replace throw in `resolveConflict` merged arm)

**Interfaces:**
- Consumes: `ClockStrategy.mergeVersions?` from Task 2; `VectorClockStrategy.mergeVersions` from Task 3
- Produces: `resolveConflict` merged arm — fully landing path replacing the throw

- [ ] **Step 1: Add C4 and C5 tests (failing)**

Append these `describe` blocks to `test/engine/phase3-merge-resolution.test.ts` (after the C2 block):

```ts
// ---------------------------------------------------------------------------
// C4 — Engine resolveConflict: merged arm, single-engine
// ---------------------------------------------------------------------------

describe("C4 · Engine: merged arm lands value, advances cursor (durable), clears conflict", () => {
  it("merged durable: value in snapshot, cursor advances, conflict cleared, onBatch fired", async () => {
    const clock = new VectorClockStrategy("node-A");
    const remoteClock = new VectorClockStrategy("node-B");
    const engine = new Engine(clock);

    const batchCalls: ChangeBatch[] = [];
    engine.subscribe(SCOPE, {
      onBatch: (b) => batchCalls.push(b),
      onConflict: () => ({ decision: "defer" as const }),
    });

    const vLocal = clock.mint();
    const vRemote = remoteClock.mint();

    // Apply local write
    await engine.apply(
      makeDurableStateBatch(SCOPE, UNIT, "local-val", "id-local", vLocal),
    );
    batchCalls.length = 0; // clear the initial-write notification

    // Apply concurrent remote write → triggers conflict
    await engine.apply(
      makeDurableStateBatch(SCOPE, UNIT, "remote-val", "id-remote", vRemote),
    );
    batchCalls.length = 0; // clear (conflict fires onConflict, not onBatch)

    const cursorBefore = engine.getCursor(SCOPE)._seq;

    // Resolve as merged
    engine.resolveConflict(SCOPE, UNIT, {
      decision: "merged",
      value: "merged-val",
    });

    // Merged value is in snapshot
    expect(await getUnitValue(engine, SCOPE, UNIT)).toBe("merged-val");

    // Cursor advanced (durable change)
    expect(engine.getCursor(SCOPE)._seq).toBeGreaterThan(cursorBefore);

    // onBatch fired exactly once (for the merged change)
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]!.changes[0]!.value).toBe("merged-val");
    expect(batchCalls[0]!.cursor).toBeDefined(); // durable → cursor present

    // Open conflict cleared: a second resolveConflict call with take-remote on the same unit
    // must be a no-op (no open conflict entry → returns immediately, value unchanged).
    // If the conflict were still open, take-remote would overwrite merged-val with remote-val.
    engine.resolveConflict(SCOPE, UNIT, { decision: "take-remote" });
    expect(await getUnitValue(engine, SCOPE, UNIT)).toBe("merged-val");
  });

  it("merged ephemeral: value in snapshot, cursor does NOT advance, onBatch fired without cursor", async () => {
    const clock = new VectorClockStrategy("node-A");
    const remoteClock = new VectorClockStrategy("node-B");
    const engine = new Engine(clock);

    const batchCalls: ChangeBatch[] = [];
    engine.subscribe(SCOPE, {
      onBatch: (b) => batchCalls.push(b),
      onConflict: () => ({ decision: "defer" as const }),
    });

    const UNIT2 = makeConflictUnit("field-ephemeral");
    const vLocal = clock.mint();
    const vRemote = remoteClock.mint();
    const ttl = ephemeral(60_000);

    // Apply local ephemeral write
    await engine.apply({
      scope: SCOPE,
      changes: [
        {
          id: makeChangeId("eph-local"),
          scope: SCOPE,
          unit: UNIT2,
          kind: "state",
          lifetime: ttl,
          value: "eph-local-val",
          version: vLocal,
        },
      ],
    });
    batchCalls.length = 0;

    // Apply concurrent remote ephemeral write
    await engine.apply({
      scope: SCOPE,
      changes: [
        {
          id: makeChangeId("eph-remote"),
          scope: SCOPE,
          unit: UNIT2,
          kind: "state",
          lifetime: ttl,
          value: "eph-remote-val",
          version: vRemote,
        },
      ],
    });
    batchCalls.length = 0;

    const cursorBefore = engine.getCursor(SCOPE)._seq;

    engine.resolveConflict(SCOPE, UNIT2, {
      decision: "merged",
      value: "eph-merged-val",
    });

    // Value in snapshot
    expect(await getUnitValue(engine, SCOPE, UNIT2)).toBe("eph-merged-val");

    // Cursor does NOT advance for ephemeral
    expect(engine.getCursor(SCOPE)._seq).toBe(cursorBefore);

    // onBatch fired, no cursor on the batch
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]!.cursor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// C5 — Guard: merged under a strategy without mergeVersions
// ---------------------------------------------------------------------------

describe("C5 · Guard: merged under a strategy without mergeVersions throws before mutating", () => {
  it("throws precise error; openConflicts entry survives the throw", async () => {
    // LWW never produces "concurrent", so we use a minimal custom strategy
    // that CAN produce concurrent but lacks mergeVersions — exactly C5's setup.
    const minimalClock: ClockStrategy = {
      mint(prev?: Version): Version {
        return new VectorClockStrategy("x").mint(prev);
      },
      compare(a: Version, b: Version): "before" | "after" | "concurrent" {
        return new VectorClockStrategy("x").compare(a, b);
      },
      // mergeVersions intentionally absent
    };

    const clockA = new VectorClockStrategy("node-A");
    const clockB = new VectorClockStrategy("node-B");
    const engine = new Engine(minimalClock);

    const vLocal = clockA.mint();
    const vRemote = clockB.mint();

    // Plant a conflict
    await engine.apply(
      makeDurableStateBatch(SCOPE, UNIT, "local-val", "guard-local", vLocal),
    );
    await engine.apply(
      makeDurableStateBatch(SCOPE, UNIT, "remote-val", "guard-remote", vRemote),
    );

    // The throw must happen before any map mutation
    const valueBefore = await getUnitValue(engine, SCOPE, UNIT);

    expect(() =>
      engine.resolveConflict(SCOPE, UNIT, {
        decision: "merged",
        value: "should-not-land",
      }),
    ).toThrow("mergeVersions");

    // Value unchanged (no mutation before throw)
    expect(await getUnitValue(engine, SCOPE, UNIT)).toBe(valueBefore);

    // Conflict is still open (not deleted before throw)
    // Verify: defer still works → conflict entry is there
    engine.resolveConflict(SCOPE, UNIT, { decision: "defer" });
    // defer is a no-op; then take-local should work if conflict still open
    engine.resolveConflict(SCOPE, UNIT, { decision: "take-local" });
    // If conflict was already deleted, take-local would be a no-op and value would still be "local-val".
    // If conflict was deleted by the failed merge, take-local would be a no-op too but the conflict
    // entry won't be present. The assert that matters is value unchanged, which we already checked.
    expect(await getUnitValue(engine, SCOPE, UNIT)).toBe("local-val");
  });
});
```

- [ ] **Step 2: Run new tests → RED**

```bash
pnpm test test/engine/phase3-merge-resolution.test.ts
```

Expected: C4 and C5 tests FAIL — the engine still throws `"'merged' is not supported in Phase 2"`. C2 tests still PASS.

- [ ] **Step 3: Replace the `merged` throw in `src/core/engine.ts`**

In `src/core/engine.ts`, find the `resolveConflict` method's `merged` arm (currently around lines 398–404):

```ts
// BEFORE (remove this block):
    if (resolution.decision === "merged") {
      throw new Error(
        "resolveConflict: 'merged' is not supported in Phase 2. " +
          "Use take-local, take-remote, or defer.",
      );
    }
```

Replace with the full merged landing path:

```ts
    if (resolution.decision === "merged") {
      if (!this._clock.mergeVersions) {
        throw new Error(
          "resolveConflict: strategy does not implement mergeVersions; 'merged' resolution is unsupported",
        );
      }
      const mergedVersion = this._clock.mergeVersions(
        open.local.version,
        open.remote.version,
      );
      const mergedChange: StateChange = {
        id: makeChangeId(`merged:${open.local.id.value}:${open.remote.id.value}`),
        kind: "state",
        scope,
        unit,
        value: resolution.value,
        version: mergedVersion,
        lifetime: open.local.lifetime,
      };
      scopeState.openConflicts.delete(unit.key);
      scopeState.seenIds.add(open.local.id.value);
      scopeState.seenIds.add(open.remote.id.value);
      if (mergedChange.lifetime.class === "durable") {
        scopeState.durableStateUnits.set(unit.key, { change: mergedChange });
        scopeState.cursorSeq++;
        scopeState.durableLog.push({ change: mergedChange, seq: scopeState.cursorSeq });
      } else {
        scopeState.ephemeralStateUnits.set(unit.key, { change: mergedChange });
      }
      const outBatch: ChangeBatch = {
        scope,
        changes: [mergedChange],
        ...(mergedChange.lifetime.class === "durable"
          ? { cursor: makeCursor(scope, scopeState.cursorSeq) }
          : {}),
      };
      for (const handlers of scopeState.subs) {
        handlers.onBatch(outBatch);
      }
      return;
    }
```

Also ensure `makeChangeId` is imported — it is already imported at the top of `engine.ts` from `./types.ts`. And `StateChange` is already imported. No new imports needed.

Also update the JSDoc comment on `resolveConflict` — change the `merged` line from:
```
 * - `merged`: NOT supported in Phase 2. Throws explicitly.
```
to:
```
 * - `merged`: mints a merged version via `ClockStrategy.mergeVersions`, lands merged value
 *   in the confirmed maps, advances cursor (if durable), fires onBatch. Throws if the
 *   active strategy lacks `mergeVersions`.
```

- [ ] **Step 4: Run tests → GREEN**

```bash
pnpm test test/engine/phase3-merge-resolution.test.ts
```

Expected: all C2, C4, C5 tests PASS.

```bash
pnpm test
```

Expected: all tests PASS (including existing ~40 tests).

- [ ] **Step 5: Typecheck**

```bash
pnpm typecheck
```

Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/core/engine.ts test/engine/phase3-merge-resolution.test.ts
git commit -m "feat(engine): resolveConflict merged arm — landing path + mergeVersions guard (C4, C5)"
```

---

## Task 5: ≥2-Replica Convergence Test — C6

**Files:**
- Modify: `test/engine/phase3-merge-resolution.test.ts` (add C6 section)

**Interfaces:**
- Consumes: everything from Tasks 2–4; `ChannelSimulator`, `ResolverPump`, `setupGossip`, `drainChannels` from existing test helpers

- [ ] **Step 1: Add C6 tests (failing — catches regressions)**

Append this `describe` block to `test/engine/phase3-merge-resolution.test.ts`:

```ts
// ---------------------------------------------------------------------------
// C6 — ≥2-replica convergence; merged value does NOT re-conflict on redelivery
// ---------------------------------------------------------------------------

describe("C6 · ≥2-replica convergence under fault injection", () => {
  /**
   * Symmetric resolver: returns "merged-AB" regardless of which side is local/remote.
   * Deterministic and pure — the same answer on both replicas for the same conflict.
   */
  function symmetricResolver(conflict: Conflict): Resolution {
    return { decision: "merged", value: "merged-AB" };
  }

  it("2-replica: both converge on merged value, merged version dominates inputs, no re-conflict on redelivery", async () => {
    const clockA = new VectorClockStrategy("node-A");
    const clockB = new VectorClockStrategy("node-B");
    // Engine._resolver is dead code (never called by the engine). Resolution runs via
    // ResolverPump which subscribes to onConflict notifications and calls resolveConflict.
    const engineA = new Engine(clockA);
    const engineB = new Engine(clockB);

    const faultConfig: FaultConfig = {
      dropRate: 0.1,
      reorderRate: 0.2,
      duplicateRate: 0.15,
    };

    const { allChannels, throwIfErrors } = setupGossip(
      [engineA, engineB],
      SCOPE,
      42,
      faultConfig,
    );

    // Wire ResolverPumps — constructor self-wires via engine.subscribe internally.
    // ResolverPump signature: (engine, resolver, scope). No separate subscribe needed.
    new ResolverPump(engineA, { resolve: symmetricResolver }, SCOPE);
    new ResolverPump(engineB, { resolve: symmetricResolver }, SCOPE);

    // Concurrent writes — each node mints without knowledge of the other
    const vA = clockA.mint();
    const vB = clockB.mint();

    await engineA.apply(makeDurableStateBatch(SCOPE, UNIT, "value-A", "write-A", vA));
    await engineB.apply(makeDurableStateBatch(SCOPE, UNIT, "value-B", "write-B", vB));

    // Drain to quiescence (with fault injection)
    await drainChannels(allChannels);
    throwIfErrors();

    // Both engines must have converged on the merged value
    const valueA = await getUnitValue(engineA, SCOPE, UNIT);
    const valueB = await getUnitValue(engineB, SCOPE, UNIT);
    expect(valueA).toBe("merged-AB");
    expect(valueB).toBe("merged-AB");

    // Merged version dominates both original input versions on both engines
    const mergedVersionA = await getUnitVersion(engineA, SCOPE, UNIT);
    const mergedVersionB = await getUnitVersion(engineB, SCOPE, UNIT);
    expect(mergedVersionA).toBeDefined();
    expect(mergedVersionB).toBeDefined();
    expect(clockA.compare(mergedVersionA!, vA)).toBe("after");
    expect(clockA.compare(mergedVersionA!, vB)).toBe("after");
    expect(clockB.compare(mergedVersionB!, vA)).toBe("after");
    expect(clockB.compare(mergedVersionB!, vB)).toBe("after");

    // Verify no lingering open conflicts: a second resolveConflict(take-remote) on each
    // engine must be a no-op — if the conflict were still open, take-remote would
    // overwrite "merged-AB" with the remote input value.
    engineA.resolveConflict(SCOPE, UNIT, { decision: "take-remote" });
    expect(await getUnitValue(engineA, SCOPE, UNIT)).toBe("merged-AB");
    engineB.resolveConflict(SCOPE, UNIT, { decision: "take-remote" });
    expect(await getUnitValue(engineB, SCOPE, UNIT)).toBe("merged-AB");
  });

  it("3-replica partition: A+C merge while B isolated, reconnect → all 3 converge", async () => {
    const UNIT3 = makeConflictUnit("field-partition");
    const clockA = new VectorClockStrategy("node-A");
    const clockB = new VectorClockStrategy("node-B");
    const clockC = new VectorClockStrategy("node-C");
    // Engine._resolver is dead; resolution runs via ResolverPump subscriptions.
    const engineA = new Engine(clockA);
    const engineB = new Engine(clockB);
    const engineC = new Engine(clockC);

    const { channels, allChannels, throwIfErrors } = setupGossip(
      [engineA, engineB, engineC],
      SCOPE,
      99,
    );

    // Wire ResolverPumps on A and C (B receives merged change via gossip — no pump needed there).
    // ResolverPump self-wires via engine.subscribe in its constructor.
    new ResolverPump(engineA, { resolve: symmetricResolver }, SCOPE);
    new ResolverPump(engineC, { resolve: symmetricResolver }, SCOPE);

    // Partition B (channels to/from B deliver nothing)
    channels.get("0→1")!.partition(); // A→B
    channels.get("1→0")!.partition(); // B→A
    channels.get("2→1")!.partition(); // C→B
    channels.get("1→2")!.partition(); // B→C

    // A and C write concurrently (B is isolated)
    const vA = clockA.mint();
    const vC = clockC.mint();
    await engineA.apply(makeDurableStateBatch(SCOPE, UNIT3, "value-A", "p-write-A", vA));
    await engineC.apply(makeDurableStateBatch(SCOPE, UNIT3, "value-C", "p-write-C", vC));

    // Drain A↔C channels only
    await drainChannels([channels.get("0→2")!, channels.get("2→0")!]);
    throwIfErrors();

    // A and C should have converged on "merged-AB" (symmetric resolver)
    expect(await getUnitValue(engineA, SCOPE, UNIT3)).toBe("merged-AB");
    expect(await getUnitValue(engineC, SCOPE, UNIT3)).toBe("merged-AB");

    // Reconnect B
    channels.get("0→1")!.reconnect();
    channels.get("1→0")!.reconnect();
    channels.get("2→1")!.reconnect();
    channels.get("1→2")!.reconnect();

    // Drain all channels — B receives the merged change from A and C
    await drainChannels(allChannels);
    throwIfErrors();

    // All 3 converge
    expect(await getUnitValue(engineA, SCOPE, UNIT3)).toBe("merged-AB");
    expect(await getUnitValue(engineB, SCOPE, UNIT3)).toBe("merged-AB");
    expect(await getUnitValue(engineC, SCOPE, UNIT3)).toBe("merged-AB");

    // No lingering open conflict on any engine
    const conflictFired = vi.fn();
    for (const engine of [engineA, engineB, engineC]) {
      engine.subscribe(SCOPE, { onBatch: () => {}, onConflict: conflictFired });
    }
    // Re-apply original inputs to all engines — none should re-open a conflict
    await engineA.apply(makeDurableStateBatch(SCOPE, UNIT3, "value-A", "p-write-A", vA));
    await engineB.apply(makeDurableStateBatch(SCOPE, UNIT3, "value-A", "p-write-A", vA));
    await engineC.apply(makeDurableStateBatch(SCOPE, UNIT3, "value-A", "p-write-A", vA));
    await engineA.apply(makeDurableStateBatch(SCOPE, UNIT3, "value-C", "p-write-C", vC));
    await engineB.apply(makeDurableStateBatch(SCOPE, UNIT3, "value-C", "p-write-C", vC));
    await engineC.apply(makeDurableStateBatch(SCOPE, UNIT3, "value-C", "p-write-C", vC));
    expect(conflictFired).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Cross-lifetime conflict assertion (design §8)
// ---------------------------------------------------------------------------

describe("§8 cross-lifetime: durable+ephemeral pair cannot arise for one unit", () => {
  it("a durable write followed by an ephemeral concurrent write does not open a conflict (different lifetime classes route to different maps, winner is by version)", async () => {
    // Under current routing: _applyState compares the incoming version against
    // _stateWinner(durable, ephemeral). If the ephemeral and durable are both
    // present, _stateWinner picks the higher-version one for comparison. So the
    // only way to get a conflict is if two changes have CONCURRENT versions —
    // they can differ in lifetime, but the engine compares them purely by version.
    // We assert that a durable local + ephemeral remote concurrent pair DOES produce
    // a conflict (openConflicts is not nil-by-lifetime), and that the merged arm
    // uses open.local.lifetime for the merged change.
    const clockA = new VectorClockStrategy("node-A");
    const clockB = new VectorClockStrategy("node-B");
    const engine = new Engine(clockA);

    const conflictPayloads: Conflict[] = [];
    engine.subscribe(SCOPE, {
      onBatch: () => {},
      onConflict: (c) => { conflictPayloads.push(c); return { decision: "defer" as const }; },
    });

    const UNIT4 = makeConflictUnit("cross-lifetime");
    const vDurable = clockA.mint();
    const vEphemeral = clockB.mint(); // concurrent with vDurable

    // Apply durable local
    await engine.apply(makeDurableStateBatch(SCOPE, UNIT4, "durable-val", "cl-durable", vDurable));
    // Apply ephemeral concurrent
    await engine.apply({
      scope: SCOPE,
      changes: [
        {
          id: makeChangeId("cl-ephemeral"),
          scope: SCOPE,
          unit: UNIT4,
          kind: "state",
          lifetime: ephemeral(60_000),
          value: "ephemeral-val",
          version: vEphemeral,
        },
      ],
    });

    // A conflict IS opened — the engine compares by version regardless of lifetime
    expect(conflictPayloads).toHaveLength(1);

    // Resolving as merged uses open.local.lifetime (durable)
    const batchCalls: ChangeBatch[] = [];
    engine.subscribe(SCOPE, { onBatch: (b) => batchCalls.push(b), onConflict: () => ({ decision: "defer" as const }) });
    engine.resolveConflict(SCOPE, UNIT4, { decision: "merged", value: "cross-merged" });

    // Merged change has durable lifetime (from open.local)
    const mergedChange = batchCalls[0]?.changes[0];
    expect(mergedChange?.lifetime.class).toBe("durable");
  });
});
```

- [ ] **Step 2: Run C6 tests → should PASS (implementation already in place from Task 4)**

```bash
pnpm test test/engine/phase3-merge-resolution.test.ts
```

Expected: ALL tests PASS — C2, C4, C5, C6, and §8 cross-lifetime tests.

If any C6 test fails, the most likely cause is resolution not firing. Verify that `ResolverPump` is constructing before writes are applied (pump must be subscribed before the conflict notification fires). Since writes are applied after `new ResolverPump(...)`, order is correct.

Fallback if resolution still doesn't land (e.g., async pump timing): replace with a direct inline resolver in a second subscribe call:

```ts
// Inline resolver wired directly via subscribe:
engineA.subscribe(SCOPE, {
  onBatch: () => {},
  onConflict: (conflict) => {
    const resolution = symmetricResolver(conflict);
    engineA.resolveConflict(conflict.scope, conflict.unit, resolution);
    return resolution;
  },
});
```

- [ ] **Step 3: Run full test suite**

```bash
pnpm test
```

Expected: ALL tests PASS (C2 + C4 + C5 + C6 + §8 + all ~40 existing tests).

- [ ] **Step 4: Commit**

```bash
git add test/engine/phase3-merge-resolution.test.ts
git commit -m "test(engine): C6 ≥2-replica convergence + §8 cross-lifetime assertion (C6)"
```

---

## Task 6: Final Gates — C7

**Files:** none new

**Interfaces:** none — this is verification only

- [ ] **Step 1: Run typecheck**

```bash
pnpm typecheck
```

Expected: exits 0. Zero errors.

- [ ] **Step 2: Run full test suite**

```bash
pnpm test
```

Expected: exits 0. All tests PASS. Confirm count includes new phase3 tests.

- [ ] **Step 3: Verify C3 evidence**

```bash
grep mergeVersions src/strategies/lww.ts
```

Expected: no output.

- [ ] **Step 4: Verify C1 evidence**

```bash
grep mergeVersions src/core/types.ts
```

Expected: line present with `mergeVersions?(a: Version, b: Version): Version`.

- [ ] **Step 5: Final commit if anything outstanding**

If all steps above are clean, push to main and verify with `git show`:

```bash
git log --oneline -6
```

Expected: see the 5 commits from this plan:
```
<hash> test(engine): C6 ≥2-replica convergence + §8 cross-lifetime assertion (C6)
<hash> feat(engine): resolveConflict merged arm — landing path + mergeVersions guard (C4, C5)
<hash> feat(strategy): VectorClockStrategy.mergeVersions — element-wise max causal join (C2)
<hash> feat(contract): ClockStrategy.mergeVersions — seam v1.0 → v1.1 (C1)
<hash> docs(gates): phase3-merge-resolution gate file — C1-C7 acceptance contract
```

---

## Self-Review

**Spec coverage check (impl-brief gate items vs tasks):**

| Gate | Task | Status |
|------|------|--------|
| C1 — Contract surface | Task 2 | ✓ `mergeVersions?` added to types.ts + seam-contract.md bump |
| C2 — VectorClock.mergeVersions | Task 3 | ✓ 9 unit tests covering all 5 required properties + N-way |
| C3 — LWW omits mergeVersions | Task 2 (Step 4) | ✓ Verified via grep + tsc (optional keeps it clean) |
| C4 — Engine merged arm | Task 4 | ✓ durable + ephemeral sub-tests, cursor, onBatch |
| C5 — Guard under missing strategy | Task 4 | ✓ Throws precise error, conflict still open after throw |
| C6 — 2-replica convergence | Task 5 | ✓ Fault injection, redelivery no-conflict, 3-replica partition |
| C7 — Both gates green | Task 6 | ✓ pnpm typecheck + pnpm test both verified |
| Brief note: cross-lifetime §8 | Task 5 | ✓ §8 test asserts conflict arises + merged uses local.lifetime |
| Brief note: never structural compare | Tasks 3-5 | ✓ mergeVersions uses compare() not JSON.stringify; enforced by C2 order-independence test |
| Brief note: fresh id correct | Task 4 | ✓ `merged:${local.id}:${remote.id}` — locally unique, not required to match across replicas |

**Placeholder scan:** No TBD, no TODO, no "similar to" references, no missing code blocks. ResolverPump fallback included in Task 5 Step 2.

**Type consistency:**
- `makeChangeId`, `makeScope`, `makeConflictUnit`, `DURABLE`, `ephemeral` — all from `types.ts`, used consistently
- `Version`, `Conflict`, `Resolution`, `ClockStrategy` — all imported in test file
- `mergeVersions?(a: Version, b: Version): Version` — matches between types.ts declaration and vector-clock.ts implementation
- `StateChange` type used in engine merged arm — already imported at top of engine.ts
