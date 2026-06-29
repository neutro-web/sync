# G2 Public API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `createSync` client factory and `ScopeHandle` as a pure consumer of `Engine`/`ResolverPump`/`Transport`, sealing all four consumer-facing leaks from the raw seam and passing all G2 gates.

**Architecture:** One `Engine` per scope (B1 multiplexing); the client holds `Map<scopeKey, ScopeEntry>` plus a single `Transport`. Outbound: `engine.onBatch → transport.send`. Inbound: `transport.receive → engine.apply` demuxed by `batch.scope.key`. T3 reconnect: `transport.onConnect` drives durable replay via `engine.changes()` or ephemeral resend via `engine.snapshot()`. Consumer subs always receive `readonly Change[]` — cursor is tracked in `ScopeEntry` and never forwarded to callbacks.

**Tech Stack:** TypeScript 5.5 strict (`noEmit: true`), Vitest 4.x, no runtime dependencies.

## Global Constraints

- **Additive only:** `src/core/engine.ts` and `src/core/types.ts` must not change.
- `pnpm test` must stay green at every commit (baseline: 78 tests at `HEAD 950d6d1`). Verify before any commit: run `pnpm test` and confirm the count.
- `pnpm typecheck` (tsc --strict) must be clean at every commit.
- `pnpm lint` (`biome check src test`) must pass at every commit.
- No framework types (`React`, `svelte`, `vue`, `solid`, `angular`, `JSX`, `Signal`, `useSyncExternalStore`) in any public-surface file.
- No `Version`, `Cursor`, `makeChangeId`, `makeConflictUnit`, `mint`, or `makeCursor` in any consumer-facing signature.
- `git diff --stat main -- src/core/engine.ts src/core/types.ts` must return empty at the final commit.

---

## File Map

| Status | Path | Responsibility |
|--------|------|----------------|
| Create | `src/strategies/index.ts` | `lww()` and `vectorClock()` factory functions |
| Create | `src/client/create-sync.ts` | `createSync`, `ScopeHandle` impl, `ScopeEntry` internals |
| Create | `src/index.ts` | Public root export (`@neutro/sync`) |
| Create | `test/client/create-sync.test.ts` | Functional: G2-3, G2-4, G2-5, G2-6, local smoke tests |
| Create | `test/types/public-surface.test.ts` | Type-level assertions (G2-2) via `expectTypeOf` |

**Unchanged:** `src/core/engine.ts`, `src/core/types.ts`, `src/core/resolver-pump.ts`, `src/strategies/lww.ts`, `src/strategies/vector-clock.ts`, `src/transports/in-process.ts`, all files under `test/engine/`, `test/harness/`.

---

## Task 1: Strategy Factories

**Files:**
- Create: `src/strategies/index.ts`
- Create: `test/client/strategies.test.ts`

**Interfaces:**
- Consumes: `LWWClockStrategy` from `../strategies/lww.ts`, `VectorClockStrategy` from `../strategies/vector-clock.ts`
- Produces: `lww(nodeId?: number): LWWClockStrategy`, `vectorClock(nodeId?: string): VectorClockStrategy`

- [ ] **Step 1: Write the failing test**

```typescript
// test/client/strategies.test.ts
import { describe, expect, test } from "vitest";
import { lww, vectorClock } from "../../src/strategies/index.ts";

describe("lww()", () => {
  test("returns a ClockStrategy that never returns concurrent", () => {
    const s = lww();
    const v1 = s.mint();
    const v2 = s.mint(v1);
    expect(s.compare(v1, v2)).not.toBe("concurrent");
    expect(s.compare(v2, v1)).not.toBe("concurrent");
  });

  test("two instances with explicit nodeIds break ties deterministically", () => {
    const sLow = lww(0);
    const sHigh = lww(1);
    // Both mint at ts=1; higher node wins
    const vLow = sLow.mint();
    const vHigh = sHigh.mint();
    expect(sLow.compare(vHigh, vLow)).toBe("after");
    expect(sLow.compare(vLow, vHigh)).toBe("before");
  });

  test("successive calls without args produce unique instances", () => {
    const a = lww();
    const b = lww();
    const va = a.mint();
    const vb = b.mint();
    // Different instances — same ts, different nodes — still total order
    expect(a.compare(va, vb)).not.toBe("concurrent");
  });
});

describe("vectorClock()", () => {
  test("returns a ClockStrategy that can return concurrent", () => {
    const a = vectorClock("node-a");
    const b = vectorClock("node-b");
    // Independent mints with no shared causal history are concurrent
    const va = a.mint();
    const vb = b.mint();
    expect(a.compare(va, vb)).toBe("concurrent");
  });

  test("after minting with prev, the result is causally after prev", () => {
    const s = vectorClock("n1");
    const v1 = s.mint();
    const v2 = s.mint(v1);
    expect(s.compare(v2, v1)).toBe("after");
    expect(s.compare(v1, v2)).toBe("before");
  });

  test("auto-generated nodeId produces unique strategies", () => {
    const a = vectorClock();
    const b = vectorClock();
    const va = a.mint();
    const vb = b.mint();
    // Different auto-node ids → concurrent independent writes
    expect(a.compare(va, vb)).toBe("concurrent");
  });

  test("supports mergeVersions", () => {
    const s = vectorClock("n");
    const va = s.mint();
    const vb = s.mint();
    const merged = s.mergeVersions!(va, vb);
    expect(s.compare(merged, va)).toBe("after");
    expect(s.compare(merged, vb)).toBe("after");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
pnpm test test/client/strategies.test.ts
```
Expected: FAIL with "Cannot find module '../../src/strategies/index.ts'"

- [ ] **Step 3: Implement the factories**

```typescript
// src/strategies/index.ts
import { LWWClockStrategy } from "./lww.ts";
import { VectorClockStrategy } from "./vector-clock.ts";

let _vcNodeSeq = 0;

export function lww(nodeId?: number): LWWClockStrategy {
  return new LWWClockStrategy(nodeId);
}

export function vectorClock(nodeId?: string): VectorClockStrategy {
  return new VectorClockStrategy(nodeId ?? `vc-node-${++_vcNodeSeq}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

```
pnpm test test/client/strategies.test.ts
```
Expected: PASS (4 tests)

- [ ] **Step 5: Verify baseline still green**

```
pnpm test
```
Expected: ≥82 tests passing (78 existing + 4 new)

- [ ] **Step 6: Commit**

```bash
git add src/strategies/index.ts test/client/strategies.test.ts
git commit -m "feat(strategies): add lww() and vectorClock() factory functions"
```

---

## Task 2: Public Interface Definitions + Type-Level Test (G2-2)

**Files:**
- Create: `src/client/create-sync.ts` (interfaces only — no implementation yet)
- Create: `test/types/public-surface.test.ts`

**Interfaces:**
- Consumes: `Change`, `Conflict`, `Resolution`, `Subscription`, `Transport`, `ClockStrategy`, `Lifetime`, `Resolver` from `../core/types.ts`
- Produces: `ScopeConfig`, `SyncConfig`, `WriteOpts`, `ScopeHandle`, `SyncClient` (exported types); `createSync` (stub that throws — replaced in Task 3)

- [ ] **Step 1: Write the failing type test**

```typescript
// test/types/public-surface.test.ts
import { describe, expectTypeOf, test } from "vitest";
import type { ScopeHandle, SyncClient, SyncConfig, WriteOpts } from "../../src/client/create-sync.ts";
import { createSync } from "../../src/client/create-sync.ts";
import type {
  Change,
  Conflict,
  Lifetime,
  Resolution,
  Subscription,
  Transport,
} from "../../src/core/types.ts";

describe("ScopeHandle type surface", () => {
  test("set() returns void", () => {
    expectTypeOf<ScopeHandle["set"]>().returns.toBeVoid();
  });

  test("do() returns void", () => {
    expectTypeOf<ScopeHandle["do"]>().returns.toBeVoid();
  });

  test("subscribe() callback receives readonly Change[], not ChangeBatch", () => {
    type Callback = Parameters<ScopeHandle["subscribe"]>[0];
    type Arg = Parameters<Callback>[0];
    expectTypeOf<Arg>().toEqualTypeOf<readonly Change[]>();
  });

  test("subscribe() returns Subscription", () => {
    expectTypeOf<ScopeHandle["subscribe"]>().returns.toEqualTypeOf<Subscription>();
  });

  test("snapshot() returns Promise<readonly Change[]>", () => {
    expectTypeOf<ScopeHandle["snapshot"]>().returns.toEqualTypeOf<
      Promise<readonly Change[]>
    >();
  });

  test("onConflict() handler receives (Conflict, resolve fn), returns void", () => {
    type Handler = Parameters<ScopeHandle["onConflict"]>[0];
    type Arg0 = Parameters<Handler>[0];
    type Arg1 = Parameters<Handler>[1];
    expectTypeOf<Arg0>().toEqualTypeOf<Conflict>();
    expectTypeOf<Arg1>().toEqualTypeOf<(r: Resolution) => void>();
    expectTypeOf<ScopeHandle["onConflict"]>().returns.toBeVoid();
  });

  test("close() returns void", () => {
    expectTypeOf<ScopeHandle["close"]>().returns.toBeVoid();
  });
});

describe("SyncClient type surface", () => {
  test("scope() returns ScopeHandle", () => {
    expectTypeOf<SyncClient["scope"]>().returns.toEqualTypeOf<ScopeHandle>();
  });

  test("close() returns void", () => {
    expectTypeOf<SyncClient["close"]>().returns.toBeVoid();
  });
});

describe("createSync type surface", () => {
  test("createSync returns SyncClient", () => {
    expectTypeOf(createSync).returns.toEqualTypeOf<SyncClient>();
  });

  test("SyncConfig transport field is Transport", () => {
    expectTypeOf<SyncConfig["transport"]>().toEqualTypeOf<Transport>();
  });
});

describe("WriteOpts type surface", () => {
  test("lifetime is optional Lifetime", () => {
    expectTypeOf<WriteOpts["lifetime"]>().toEqualTypeOf<Lifetime | undefined>();
  });

  test("unitKey is optional string", () => {
    expectTypeOf<WriteOpts["unitKey"]>().toEqualTypeOf<string | undefined>();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
pnpm test test/types/public-surface.test.ts
```
Expected: FAIL with "Cannot find module '../../src/client/create-sync.ts'"

- [ ] **Step 3: Create the interface-only stub**

```typescript
// src/client/create-sync.ts
import type {
  Change,
  ChangeBatch,
  ClockStrategy,
  Conflict,
  Cursor,
  Lifetime,
  Resolution,
  Resolver,
  Scope,
  Subscription,
  Transport,
  Version,
} from "../core/types.ts";

export interface ScopeConfig {
  strategy: ClockStrategy;
  resolver?: Resolver;
  lifetime?: Lifetime;
  manual?: boolean;
}

export interface SyncConfig {
  transport: Transport;
  scopes?: Record<string, ScopeConfig>;
}

export interface WriteOpts {
  lifetime?: Lifetime;
  unitKey?: string;
}

export interface ScopeHandle {
  set(unit: string, value: unknown, opts?: WriteOpts): void;
  do(unit: string, value: unknown, opts?: WriteOpts): void;
  subscribe(onBatch: (changes: readonly Change[]) => void): Subscription;
  snapshot(): Promise<readonly Change[]>;
  onConflict(
    handler: (conflict: Conflict, resolve: (r: Resolution) => void) => void,
  ): void;
  close(): void;
}

export interface SyncClient {
  scope(key: string, config?: ScopeConfig): ScopeHandle;
  close(): void;
}

// Stub — replaced in Task 3
export function createSync(_config: SyncConfig): SyncClient {
  throw new Error("not implemented");
}
```

- [ ] **Step 4: Run type test to verify it passes**

```
pnpm test test/types/public-surface.test.ts
```
Expected: PASS (all type assertions compile and run)

- [ ] **Step 5: Verify baseline still green**

```
pnpm test
```
Expected: ≥82 tests passing (no regressions, type test adds passes)

- [ ] **Step 6: Commit**

```bash
git add src/client/create-sync.ts test/types/public-surface.test.ts
git commit -m "feat(client): define public API interfaces + G2-2 type-level test"
```

---

## Task 3: G2-3 End-to-End Gate Test (Write Failing Test)

Write the full G2-3 gate test now — it will fail until the implementation lands in Task 4.

**Files:**
- Create: `test/client/create-sync.test.ts`

**Interfaces:**
- Consumes: `createSync`, `ScopeConfig` from `../../src/client/create-sync.ts`; `lww`, `vectorClock` from `../../src/strategies/index.ts`; `InProcessTransport` from `../../src/transports/in-process.ts`; `ephemeral` from `../../src/core/types.ts`

- [ ] **Step 1: Write the failing G2-3 test**

```typescript
// test/client/create-sync.test.ts
import { describe, expect, test } from "vitest";
import { createSync } from "../../src/client/create-sync.ts";
import { lww, vectorClock } from "../../src/strategies/index.ts";
import { ephemeral } from "../../src/core/types.ts";
import { InProcessTransport } from "../../src/transports/in-process.ts";
import { ChannelSimulator } from "../harness/channel-simulator.ts";
import type { Change } from "../../src/core/types.ts";

// ─── G2-3: Vanilla end-to-end sync ───────────────────────────────────────────

describe("G2-3: vanilla end-to-end sync", () => {
  test("durable VC change reaches B subscribe and B snapshot (direct transport)", async () => {
    const [tA, tB] = InProcessTransport.pair();
    const syncA = createSync({ transport: tA });
    const syncB = createSync({ transport: tB });

    // Ephemeral LWW presence scope
    const presenceA = syncA.scope("room:42/presence", {
      strategy: lww(),
      lifetime: ephemeral(5_000),
    });
    const presenceB = syncB.scope("room:42/presence", {
      strategy: lww(),
      lifetime: ephemeral(5_000),
    });

    // Durable vector-clock doc scope
    const docA = syncA.scope("doc:99", { strategy: vectorClock("g3a") });
    const docB = syncB.scope("doc:99", { strategy: vectorClock("g3b") });

    // B subscribes before A writes
    const bDocChanges: Change[][] = [];
    docB.subscribe((changes) => bDocChanges.push([...changes]));

    // A writes on both scopes
    presenceA.set("user:alice", { x: 10, y: 20 });
    docA.set("para:7", { text: "hello" });

    // InProcessTransport.pair() delivers synchronously; no drain needed
    expect(bDocChanges.length).toBeGreaterThan(0);
    expect(
      bDocChanges.flat().some((c) => (c.value as { text: string }).text === "hello"),
    ).toBe(true);

    // B durable snapshot reflects the doc change
    const docSnap = await docB.snapshot();
    expect(docSnap.length).toBeGreaterThan(0);
    expect(docSnap.some((c) => (c.value as { text: string }).text === "hello")).toBe(true);

    // B ephemeral snapshot reflects the presence change
    const presSnap = await presenceB.snapshot();
    expect(presSnap.length).toBeGreaterThan(0);
    expect(
      presSnap.some((c) => {
        const v = c.value as { x: number; y: number };
        return v.x === 10 && v.y === 20;
      }),
    ).toBe(true);

    syncA.close();
    syncB.close();
  });

  test("durable VC change converges under reorder + duplicate faults (ChannelSimulator)", async () => {
    const tA = new InProcessTransport();
    const tB = new InProcessTransport();

    // Seed 42: deterministic reorder + duplicate faults; no drops so delivery is guaranteed
    const chanAB = new ChannelSimulator(42, { reorderRate: 0.3, duplicateRate: 0.2 });
    const chanBA = new ChannelSimulator(99, { reorderRate: 0.3, duplicateRate: 0.2 });

    tA.channelFn = (batch) => chanAB.enqueue(batch, (b) => tB._deliver(b));
    tB.channelFn = (batch) => chanBA.enqueue(batch, (b) => tA._deliver(b));

    const syncA = createSync({ transport: tA });
    const syncB = createSync({ transport: tB });

    const docA = syncA.scope("doc:fault", { strategy: vectorClock("fa") });
    const docB = syncB.scope("doc:fault", { strategy: vectorClock("fb") });

    const bChanges: Change[][] = [];
    docB.subscribe((changes) => bChanges.push([...changes]));

    docA.set("para", { text: "fault-tolerant" });

    // Drain until stable (duplicates may cause extra rounds)
    for (let i = 0; i < 10; i++) {
      const delivered = chanAB.drain() + chanBA.drain();
      if (delivered === 0) break;
    }

    expect(bChanges.length).toBeGreaterThan(0);
    expect(
      bChanges.flat().some((c) => (c.value as { text: string }).text === "fault-tolerant"),
    ).toBe(true);

    const snap = await docB.snapshot();
    expect(snap.some((c) => (c.value as { text: string }).text === "fault-tolerant")).toBe(true);

    syncA.close();
    syncB.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
pnpm test test/client/create-sync.test.ts
```
Expected: FAIL with "not implemented" error from the createSync stub

- [ ] **Step 3: Commit the failing test**

```bash
git add test/client/create-sync.test.ts
git commit -m "test(client): add failing G2-3 E2E gate test"
```

---

## Task 4: Implement `createSync` (Make G2-3 Pass)

Replace the stub in `src/client/create-sync.ts` with the full implementation.

**Files:**
- Modify: `src/client/create-sync.ts` (full replacement)

**Interfaces:**
- Consumes: `Engine` from `../core/engine.ts`; `ResolverPump` from `../core/resolver-pump.ts`; `DURABLE`, `makeChangeId`, `makeConflictUnit`, `makeScope` from `../core/types.ts`; all type imports from Task 2
- Produces: fully implemented `createSync`, `ScopeHandle`

- [ ] **Step 1: Replace the stub with the full implementation**

```typescript
// src/client/create-sync.ts  (full replacement)
import { Engine } from "../core/engine.ts";
import { ResolverPump } from "../core/resolver-pump.ts";
import {
  DURABLE,
  makeChangeId,
  makeConflictUnit,
  makeScope,
  type Change,
  type ChangeBatch,
  type ClockStrategy,
  type Conflict,
  type Cursor,
  type Lifetime,
  type Resolution,
  type Resolver,
  type Scope,
  type Subscription,
  type Transport,
  type Version,
} from "../core/types.ts";

// ─── Public interfaces ────────────────────────────────────────────────────────

export interface ScopeConfig {
  strategy: ClockStrategy;
  resolver?: Resolver;
  lifetime?: Lifetime;
  manual?: boolean;
}

export interface SyncConfig {
  transport: Transport;
  scopes?: Record<string, ScopeConfig>;
}

export interface WriteOpts {
  lifetime?: Lifetime;
  unitKey?: string;
}

export interface ScopeHandle {
  set(unit: string, value: unknown, opts?: WriteOpts): void;
  do(unit: string, value: unknown, opts?: WriteOpts): void;
  subscribe(onBatch: (changes: readonly Change[]) => void): Subscription;
  snapshot(): Promise<readonly Change[]>;
  onConflict(
    handler: (conflict: Conflict, resolve: (r: Resolution) => void) => void,
  ): void;
  close(): void;
}

export interface SyncClient {
  scope(key: string, config?: ScopeConfig): ScopeHandle;
  close(): void;
}

// ─── Internal ─────────────────────────────────────────────────────────────────

interface ScopeEntry {
  engine: Engine;
  handle: ScopeHandle;
  config: ScopeConfig;
  pump: ResolverPump | null;
  lastCursor: Cursor | null;
  prevVersions: Map<string, Version>;
  engineSub: Subscription;
  consumerSubs: Set<(changes: readonly Change[]) => void>;
  conflictHandler:
    | ((conflict: Conflict, resolve: (r: Resolution) => void) => void)
    | null;
  scopeObj: Scope;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createSync(config: SyncConfig): SyncClient {
  const { transport } = config;
  const entries = new Map<string, ScopeEntry>();
  let _seq = 0;
  const _clientId = Math.random().toString(36).slice(2, 8);

  // Inbound: demultiplex by scope key
  transport.receive((batch: ChangeBatch) => {
    const entry = entries.get(batch.scope.key);
    if (entry) void entry.engine.apply(batch);
  });

  // T3 reconnect fork — fires when this transport reconnects
  transport.onConnect(() => {
    for (const entry of entries.values()) {
      const isEphemeral = entry.config.lifetime?.class === "ephemeral";
      if (isEphemeral) {
        void (async () => {
          const snap = await entry.engine.snapshot(entry.scopeObj);
          if (snap.changes.length > 0) {
            await transport.send({ scope: entry.scopeObj, changes: snap.changes });
          }
        })();
      } else {
        void (async () => {
          for await (const batch of entry.engine.changes(
            entry.scopeObj,
            entry.lastCursor,
          )) {
            await transport.send(batch);
          }
        })();
      }
    }
  });

  function _buildHandle(key: string, cfg: ScopeConfig): ScopeHandle {
    const scopeObj = makeScope(key);
    const engine = new Engine(cfg.strategy);

    const entry: ScopeEntry = {
      engine,
      handle: null as unknown as ScopeHandle,
      config: cfg,
      pump: null,
      lastCursor: null,
      prevVersions: new Map(),
      engineSub: { unsubscribe: () => {} },
      consumerSubs: new Set(),
      conflictHandler: null,
      scopeObj,
    };
    entries.set(key, entry);

    // Wire engine subscription for outbound transport + consumer fan-out
    entry.engineSub = engine.subscribe(scopeObj, {
      onBatch(batch: ChangeBatch): void {
        // Track cursor for durable-scope reconnect replay
        if (batch.cursor) entry.lastCursor = batch.cursor;
        // Outbound to transport (full batch, cursor included — peers need it)
        void transport.send(batch);
        // Consumer fan-out: strip cursor, deliver Change[] only
        for (const cb of entry.consumerSubs) cb(batch.changes);
      },
      onConflict(conflict: Conflict): Resolution {
        // Engine ignores this return value (T4/Model C); it's a notification only.
        // In manual mode, delegate to the registered conflict handler.
        if (cfg.manual && entry.conflictHandler) {
          entry.conflictHandler(conflict, (r: Resolution) => {
            engine.resolveConflict(conflict.scope, conflict.unit, r);
          });
        }
        return { decision: "defer" };
      },
    });

    // Auto-resolution pump (only when resolver present and not manual)
    if (cfg.resolver && !cfg.manual) {
      entry.pump = new ResolverPump(engine, cfg.resolver, scopeObj);
    }

    const handle: ScopeHandle = {
      set(unit: string, value: unknown, opts?: WriteOpts): void {
        const unitKey = opts?.unitKey ?? unit;
        const lifetime = opts?.lifetime ?? cfg.lifetime ?? DURABLE;
        const prev = entry.prevVersions.get(unitKey);
        const version = cfg.strategy.mint(prev);
        entry.prevVersions.set(unitKey, version);
        void engine.apply({
          scope: scopeObj,
          changes: [
            {
              id: makeChangeId(`${_clientId}:${key}:set:${unit}:${++_seq}`),
              kind: "state",
              scope: scopeObj,
              unit: makeConflictUnit(unitKey),
              lifetime,
              value,
              version,
            },
          ],
        });
      },

      do(unit: string, value: unknown, opts?: WriteOpts): void {
        const unitKey = opts?.unitKey ?? unit;
        const lifetime = opts?.lifetime ?? cfg.lifetime ?? DURABLE;
        void engine.apply({
          scope: scopeObj,
          changes: [
            {
              id: makeChangeId(`${_clientId}:${key}:do:${unit}:${++_seq}`),
              kind: "op",
              scope: scopeObj,
              unit: makeConflictUnit(unitKey),
              lifetime,
              value,
            },
          ],
        });
      },

      subscribe(onBatch: (changes: readonly Change[]) => void): Subscription {
        entry.consumerSubs.add(onBatch);
        return {
          unsubscribe: () => {
            entry.consumerSubs.delete(onBatch);
          },
        };
      },

      snapshot(): Promise<readonly Change[]> {
        return entry.engine.snapshot(entry.scopeObj).then((s) => s.changes);
      },

      onConflict(
        handler: (conflict: Conflict, resolve: (r: Resolution) => void) => void,
      ): void {
        if (!cfg.manual) {
          throw new Error(
            `onConflict() requires manual: true on scope '${key}'. Auto-resolution is active; set manual: true in ScopeConfig to use manual conflict handling.`,
          );
        }
        entry.conflictHandler = handler;
      },

      close(): void {
        entry.engineSub.unsubscribe();
        entry.pump?.dispose();
        entry.consumerSubs.clear();
        entries.delete(key);
      },
    };

    entry.handle = handle;
    return handle;
  }

  // Pre-register scopes declared in config
  if (config.scopes) {
    for (const [key, cfg] of Object.entries(config.scopes)) {
      _buildHandle(key, cfg);
    }
  }

  return {
    scope(key: string, cfg?: ScopeConfig): ScopeHandle {
      const existing = entries.get(key);
      if (existing) {
        if (cfg !== undefined) {
          throw new Error(
            `scope '${key}' is already registered; reconfiguration is not allowed. Call scope('${key}') without a config to retrieve the existing handle.`,
          );
        }
        return existing.handle;
      }
      if (!cfg) {
        throw new Error(
          `scope '${key}' is not registered. Provide a ScopeConfig on the first call.`,
        );
      }
      return _buildHandle(key, cfg);
    },

    close(): void {
      for (const entry of entries.values()) {
        entry.engineSub.unsubscribe();
        entry.pump?.dispose();
        entry.consumerSubs.clear();
      }
      entries.clear();
      transport.close();
    },
  };
}
```

- [ ] **Step 2: Run G2-3 test to verify it now passes**

```
pnpm test test/client/create-sync.test.ts
```
Expected: PASS (G2-3 test passes)

- [ ] **Step 3: Verify type test still passes and typecheck is clean**

```
pnpm test test/types/public-surface.test.ts && pnpm typecheck
```
Expected: All pass, no type errors

- [ ] **Step 4: Full suite green**

```
pnpm test
```
Expected: ≥83 tests passing. Confirm no regressions in `test/engine/` or `test/harness/`.

- [ ] **Step 5: Lint**

```
pnpm lint
```
Expected: No errors. `apply` returns `Promise<void>` but is always synchronous-internally (returns `Promise.resolve()` immediately). If biome flags `void entry.engine.apply(batch)` as a lint error, replace with:
```typescript
entry.engine.apply(batch).catch((err) => console.error("[createSync] apply error:", err));
```
Apply the same pattern to `void engine.apply(...)` in `set` and `do`. Use `void transport.send(batch)` only if biome permits it — otherwise `.catch(console.error)` consistently.

- [ ] **Step 6: Commit**

```bash
git add src/client/create-sync.ts
git commit -m "feat(client): implement createSync, ScopeHandle — G2-3 passing"
```

---

## Task 5: G2-4 Per-Scope Config Isolation

**Files:**
- Modify: `test/client/create-sync.test.ts` (add G2-4 tests)

**Interfaces:**
- Consumes: same as Task 3 plus `InProcessTransport` (direct, not paired) for buffered delivery
- Produces: verified G2-4 gate

- [ ] **Step 1: Write the failing G2-4 tests**

Append to `test/client/create-sync.test.ts`:

```typescript
// ─── G2-4: Per-scope config isolation ────────────────────────────────────────

describe("G2-4: per-scope config isolation", () => {
  // Deterministic resolver: lexicographically higher value wins on both replicas
  const alphabetResolver4 = {
    resolve(c: import("../../src/core/types.ts").Conflict): import("../../src/core/types.ts").Resolution {
      const local = c.local.value as string;
      const remote = c.remote.value as string;
      return local >= remote
        ? { decision: "take-local" as const }
        : { decision: "take-remote" as const };
    },
  };

  test("VC scope resolves concurrent via its resolver; LWW scope in same client never gets concurrent", async () => {
    // Buffer outbound batches so we control delivery timing
    const buffA: import("../../src/core/types.ts").ChangeBatch[] = [];
    const buffB: import("../../src/core/types.ts").ChangeBatch[] = [];
    const tA = new InProcessTransport();
    const tB = new InProcessTransport();
    tA.channelFn = (batch) => buffA.push(batch);
    tB.channelFn = (batch) => buffB.push(batch);

    const syncA = createSync({ transport: tA });
    const syncB = createSync({ transport: tB });

    // VC scope: auto-resolver tracks whether it was invoked (proving resolver fired)
    let resolverInvokeCount = 0;
    const trackingResolver = {
      resolve(c: import("../../src/core/types.ts").Conflict): import("../../src/core/types.ts").Resolution {
        resolverInvokeCount++;
        return alphabetResolver4.resolve(c);
      },
    };

    syncA.scope("vc-scope", { strategy: vectorClock("vc-a"), resolver: trackingResolver });
    const vcB = syncB.scope("vc-scope", { strategy: vectorClock("vc-b"), resolver: trackingResolver });

    // LWW scope: manual mode to detect if onConflict ever fires (it must not)
    syncA.scope("lww-scope", { strategy: lww(0), manual: true });
    const lwwB = syncB.scope("lww-scope", { strategy: lww(1), manual: true });

    let lwwConflictCount = 0;
    lwwB.onConflict(() => {
      lwwConflictCount++;
    });

    // Both write to the same unit on each scope, independently (no cross-delivery yet)
    syncA.scope("vc-scope").set("shared", "from-A");
    vcB.set("shared", "from-B");
    syncA.scope("lww-scope").set("shared", "from-A");
    lwwB.set("shared", "from-B");

    // Deliver A's batches to B — both vc-scope and lww-scope batches arrive
    for (const b of buffA.splice(0)) tB._deliver(b);

    // VC scope: B received A's {_vec:{vc-a:1}} against its own {_vec:{vc-b:1}} → concurrent
    // ResolverPump fires → trackingResolver called → conflict resolved
    expect(resolverInvokeCount).toBeGreaterThan(0);

    // LWW scope: B received A's {_ts:1, _node:0} against its own {_ts:1, _node:1}
    // LWWClockStrategy.compare never returns "concurrent" → no onConflict fired
    expect(lwwConflictCount).toBe(0);

    // LWW scope has a clean winner in B's snapshot (node 1 > node 0 → B's value)
    const lwwSnap = await lwwB.snapshot();
    expect(lwwSnap.length).toBe(1);
    expect(lwwSnap[0]!.value).toBe("from-B");

    // VC scope resolved — B's snapshot has a value (not stuck open)
    const vcSnap = await vcB.snapshot();
    expect(vcSnap.length).toBe(1);
    // alphabetResolver: "from-B" > "from-A" → take-local on B → "from-B" wins on B
    expect(vcSnap[0]!.value).toBe("from-B");

    syncA.close();
    syncB.close();
  });

  test("two scopes in one client do not share strategy state", async () => {
    const [t] = InProcessTransport.pair();
    const sync = createSync({ transport: t });

    const s1 = sync.scope("scope-1", { strategy: lww(10) });
    const s2 = sync.scope("scope-2", { strategy: vectorClock("isolated") });

    const s1Changes: import("../../src/core/types.ts").Change[][] = [];
    const s2Changes: import("../../src/core/types.ts").Change[][] = [];
    s1.subscribe((c) => s1Changes.push([...c]));
    s2.subscribe((c) => s2Changes.push([...c]));

    s1.set("unit", "v1");
    s2.set("unit", "v2");

    expect(s1Changes.length).toBe(1);
    expect(s2Changes.length).toBe(1);
    // Changes stay in their own scope
    expect(s1Changes[0]![0]!.value).toBe("v1");
    expect(s2Changes[0]![0]!.value).toBe("v2");

    sync.close();
  });
});
```

- [ ] **Step 2: Run to verify the tests pass (they should, with the Task 4 implementation)**

```
pnpm test test/client/create-sync.test.ts
```
Expected: PASS for all tests in this file so far (G2-3 + G2-4)

- [ ] **Step 3: Full suite**

```
pnpm test
```
Expected: All tests passing, no regressions

- [ ] **Step 4: Commit**

```bash
git add test/client/create-sync.test.ts
git commit -m "test(client): add G2-4 per-scope isolation gate tests"
```

---

## Task 6: G2-5 Auto-Resolution Default + Manual Opt-Out

**Files:**
- Modify: `test/client/create-sync.test.ts` (append G2-5 tests)

**Interfaces:**
- Consumes: `Conflict`, `Resolution` from `../../src/core/types.ts`; same client imports
- Produces: verified G2-5 gate

- [ ] **Step 1: Write the G2-5 tests**

Append to `test/client/create-sync.test.ts`:

```typescript
// ─── G2-5: Auto-resolution default + manual opt-out ──────────────────────────

describe("G2-5: auto-resolution and manual opt-out", () => {
  // Deterministic resolver: pick the lexicographically higher value to ensure
  // both replicas converge to the same winner regardless of which side is "local"
  const alphabetResolver = {
    resolve(c: import("../../src/core/types.ts").Conflict): import("../../src/core/types.ts").Resolution {
      const local = c.local.value as string;
      const remote = c.remote.value as string;
      return local >= remote
        ? { decision: "take-local" as const }
        : { decision: "take-remote" as const };
    },
  };

  test("G2-5a: auto-resolution (resolver + no manual flag) — both replicas converge", async () => {
    const buffA: import("../../src/core/types.ts").ChangeBatch[] = [];
    const buffB: import("../../src/core/types.ts").ChangeBatch[] = [];
    const tA = new InProcessTransport();
    const tB = new InProcessTransport();
    tA.channelFn = (batch) => buffA.push(batch);
    tB.channelFn = (batch) => buffB.push(batch);

    const syncA = createSync({ transport: tA });
    const syncB = createSync({ transport: tB });

    const docA = syncA.scope("doc", {
      strategy: vectorClock("auto-a"),
      resolver: alphabetResolver,
      // manual defaults to false → ResolverPump created automatically
    });
    const docB = syncB.scope("doc", {
      strategy: vectorClock("auto-b"),
      resolver: alphabetResolver,
    });

    // Concurrent writes (buffered, not yet delivered)
    docA.set("para", "value-A");
    docB.set("para", "value-B");

    // Deliver A's write to B → B detects concurrent → auto-resolver fires → B converges
    for (const b of buffA.splice(0)) tB._deliver(b);

    // Deliver B's write to A → A detects concurrent → auto-resolver fires → A converges
    for (const b of buffB.splice(0)) tA._deliver(b);

    // Both should now have the same winning value
    // alphabetResolver picks "value-B" >= "value-A" → take-local on B (B's value wins),
    // take-remote on A (A receives B's value as remote) → both land "value-B"
    const snapA = await docA.snapshot();
    const snapB = await docB.snapshot();

    expect(snapA.length).toBe(1);
    expect(snapB.length).toBe(1);
    expect(snapA[0]!.value).toBe(snapB[0]!.value); // both replicas converge

    syncA.close();
    syncB.close();
  });

  test("G2-5b: manual opt-out — conflict stays open until explicit resolve()", async () => {
    const buffA: import("../../src/core/types.ts").ChangeBatch[] = [];
    const tA = new InProcessTransport();
    const tB = new InProcessTransport();
    tA.channelFn = (batch) => buffA.push(batch);
    tB.channelFn = () => {}; // B's sends go nowhere in this test

    const syncA = createSync({ transport: tA });
    const syncB = createSync({ transport: tB });

    const docA = syncA.scope("doc-manual", {
      strategy: vectorClock("manual-a"),
      manual: true,
    });
    const docB = syncB.scope("doc-manual", {
      strategy: vectorClock("manual-b"),
      manual: true,
    });

    let resolveConflict: ((r: import("../../src/core/types.ts").Resolution) => void) | null = null;
    docB.onConflict((_conflict, resolve) => {
      resolveConflict = resolve;
      // Do NOT resolve immediately — leave conflict open
    });

    // Concurrent writes
    docA.set("field", "from-A");
    docB.set("field", "from-B");

    // Deliver A's write to B → conflict detected, handler called, but NOT resolved
    for (const b of buffA.splice(0)) tB._deliver(b);

    expect(resolveConflict).not.toBeNull();

    // Conflict open: snapshot shows last-confirmed-winner (B's own write, which was confirmed first)
    const snapBeforeResolve = await docB.snapshot();
    expect(snapBeforeResolve.length).toBe(1);
    expect(snapBeforeResolve[0]!.value).toBe("from-B"); // B's confirmed value unchanged

    // Manually resolve: take-remote lands A's value
    resolveConflict!({ decision: "take-remote" });

    const snapAfterResolve = await docB.snapshot();
    expect(snapAfterResolve.length).toBe(1);
    expect(snapAfterResolve[0]!.value).toBe("from-A"); // A's value now confirmed on B

    syncA.close();
    syncB.close();
  });

  test("onConflict() throws when scope is not manual", () => {
    const [t] = InProcessTransport.pair();
    const sync = createSync({ transport: t });
    const handle = sync.scope("doc-auto", { strategy: vectorClock("x") });

    expect(() =>
      handle.onConflict(() => {
        // should not be reachable
      }),
    ).toThrow(/manual: true/);

    sync.close();
  });
});
```

- [ ] **Step 2: Run to verify all tests pass**

```
pnpm test test/client/create-sync.test.ts
```
Expected: PASS for G2-3, G2-4, G2-5 tests

- [ ] **Step 3: Full suite green**

```
pnpm test
```
Expected: All tests passing

- [ ] **Step 4: Commit**

```bash
git add test/client/create-sync.test.ts
git commit -m "test(client): add G2-5 auto/manual conflict resolution gate tests"
```

---

## Task 7: G2-6 No-Cursor Guarantee + Reconnect

**Files:**
- Modify: `test/client/create-sync.test.ts` (append G2-6 tests)

**Interfaces:**
- Consumes: same client imports; `InProcessTransport` for reconnect control via `_setConnected`

- [ ] **Step 1: Write the G2-6 tests**

Append to `test/client/create-sync.test.ts`:

```typescript
// ─── G2-6: No Cursor reaches the consumer ────────────────────────────────────

describe("G2-6: no cursor reaches the consumer", () => {
  test("subscribe callbacks receive Change[], not ChangeBatch (no cursor property)", async () => {
    const [tA, tB] = InProcessTransport.pair();
    const syncA = createSync({ transport: tA });
    const syncB = createSync({ transport: tB });

    const docA = syncA.scope("doc", { strategy: vectorClock("cur-a") });
    const docB = syncB.scope("doc", { strategy: vectorClock("cur-b") });

    const callbackArgs: unknown[] = [];
    docB.subscribe((changes) => {
      callbackArgs.push(changes);
      // changes is typed as readonly Change[] — verify at runtime too
      expect(Array.isArray(changes)).toBe(true);
      // A ChangeBatch would have a `.cursor` property; Change[] does not
      expect((changes as Record<string, unknown>)["cursor"]).toBeUndefined();
    });

    docA.set("k1", "v1");
    docA.set("k2", "v2");
    docA.set("k3", "v3");

    expect(callbackArgs.length).toBeGreaterThan(0);
    for (const arg of callbackArgs) {
      expect(Array.isArray(arg)).toBe(true);
      expect((arg as Record<string, unknown>)["cursor"]).toBeUndefined();
    }

    syncA.close();
    syncB.close();
  });

  test("snapshot() returns readonly Change[], not a ChangeBatch (no cursor property)", async () => {
    const [tA, tB] = InProcessTransport.pair();
    const syncA = createSync({ transport: tA });
    const syncB = createSync({ transport: tB });

    syncA.scope("doc-snap", { strategy: vectorClock("snap-a") }).set("x", 1);
    const docB = syncB.scope("doc-snap", { strategy: vectorClock("snap-b") });

    const snap = await docB.snapshot();

    expect(Array.isArray(snap)).toBe(true);
    expect((snap as Record<string, unknown>)["cursor"]).toBeUndefined();

    syncA.close();
    syncB.close();
  });

  test("reconnect replay does not expose cursor to consumer subscribers", async () => {
    // Set up A with changes already written, B starts disconnected
    const tA = new InProcessTransport();
    const tB = new InProcessTransport();
    // Wire directly (no simulator)
    tA.channelFn = (batch) => tB._deliver(batch);
    tB.channelFn = (batch) => tA._deliver(batch);

    const syncA = createSync({ transport: tA });
    const docA = syncA.scope("doc-reconnect", { strategy: vectorClock("rc-a") });

    const syncB = createSync({ transport: tB });
    const docB = syncB.scope("doc-reconnect", { strategy: vectorClock("rc-b") });

    const bCallbackArgs: unknown[] = [];
    docB.subscribe((changes) => {
      bCallbackArgs.push(changes);
      expect((changes as Record<string, unknown>)["cursor"]).toBeUndefined();
    });

    // Connect A first — A's onConnect fires, replays (nothing yet since no changes)
    tA._setConnected(true);

    // A writes 3 changes while both are "connected"
    docA.set("p1", "v1");
    docA.set("p2", "v2");
    docA.set("p3", "v3");

    // Simulate B reconnecting — B's onConnect fires, B replays its (empty) state
    tB._setConnected(false);
    tB._setConnected(true);

    // Verify all callbacks received arrays, never a ChangeBatch
    for (const arg of bCallbackArgs) {
      expect(Array.isArray(arg)).toBe(true);
      expect((arg as Record<string, unknown>)["cursor"]).toBeUndefined();
    }

    syncA.close();
    syncB.close();
  });
});
```

- [ ] **Step 2: Run to verify all tests pass**

```
pnpm test test/client/create-sync.test.ts
```
Expected: PASS for all G2-3 through G2-6 tests

- [ ] **Step 3: Full suite green**

```
pnpm test
```
Expected: All tests passing, no regressions

- [ ] **Step 4: Commit**

```bash
git add test/client/create-sync.test.ts
git commit -m "test(client): add G2-6 no-cursor guarantee and reconnect tests"
```

---

## Task 8: Public Exports + All G2 Gate Verification

**Files:**
- Create: `src/index.ts`

**Interfaces:**
- Produces: public `@neutro/sync` root export with `createSync`, `SyncClient`, `ScopeHandle`, `SyncConfig`, `WriteOpts`

- [ ] **Step 1: Write the public root export**

```typescript
// src/index.ts
export { createSync } from "./client/create-sync.ts";
export type {
  ScopeConfig,
  ScopeHandle,
  SyncClient,
  SyncConfig,
  WriteOpts,
} from "./client/create-sync.ts";
```

- [ ] **Step 2: Verify typecheck is clean**

```
pnpm typecheck
```
Expected: No errors

- [ ] **Step 3: G2-1 — No framework type in any public signature**

```bash
grep -rnE "React|svelte|vue|solid|angular|JSX|Signal|useSyncExternalStore" src/client src/index.ts
```
Expected: No output (zero hits)

- [ ] **Step 4: G2-2 — No internal token in consumer-facing code (grep check)**

The worked consumer example is `test/client/create-sync.test.ts`. Run:
```bash
grep -nE "mint\(|makeChangeId|makeConflictUnit|makeCursor" test/client/create-sync.test.ts
```
Expected: No output (zero hits). Consumer tests never import or call these internal helpers.

Also run the type test suite to confirm the compile-time assertions pass:
```
pnpm test test/types/public-surface.test.ts
```
Expected: PASS

- [ ] **Step 5: G2-3 through G2-6 — Run all client gate tests**

```
pnpm test test/client/
```
Expected: All tests in `test/client/strategies.test.ts` and `test/client/create-sync.test.ts` pass.
Count the G2 tests:
- G2-3: 1 test
- G2-4: 2 tests
- G2-5: 3 tests
- G2-6: 3 tests

- [ ] **Step 6: G2-7 — Engine files untouched**

```bash
git diff --stat main -- src/core/engine.ts src/core/types.ts
```
Expected: No output (neither file changed)

- [ ] **Step 7: G2-8 — Full standing gates**

```bash
pnpm typecheck && pnpm test && pnpm lint
```
Expected: All three commands exit 0.
Test count: verify it shows ≥91 tests passing (78 existing + 4 strategies + 2 type + 1 G2-3 + 2 G2-4 + 3 G2-5 + 3 G2-6 + 2 scope isolation = at minimum 95 total — exact count confirmed by `pnpm test` output).

- [ ] **Step 8: Commit public exports**

```bash
git add src/index.ts
git commit -m "feat(index): add @neutro/sync public root export — all G2 gates passing"
```

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-29-g2-public-api.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints.

**Which approach?**
