/**
 * Engine — the real `Feed` + `ScopeRouter` implementation.
 *
 * In-memory. Deterministic. No I/O. Suitable for the claude.ai sandbox and for
 * all convergence/correctness testing; real persistence (IndexedDB/OPFS) is Phase 3.
 *
 * ## T1 — Change branching
 * `apply()` branches on `change.kind`:
 *   - `"state"`: LWW via `ClockStrategy.compare(incoming, current)`. Re-applying
 *     the same id is a no-op (seenIds dedup). Different id targeting the same unit:
 *     compare decides (`"after"` → accept; `"before"` → skip; `"concurrent"` → deferred).
 *   - `"op"` (no version): dedup by id only. Never double-applied.
 *   - `"op"` (with version): dedup by id, then version-compare on the unit for collision
 *     detection. `"concurrent"` → deferred (unreachable under LWW; present for Phase 2).
 *
 * ## T2 — Version opacity
 * The engine never reads inside a `Version`. All versioning is delegated to
 * `ClockStrategy.compare()`.
 *
 * ## T3 — Lifetime fork
 * Durable changes: advance the cursor, appended to the durable log (replayed by
 * `changes()`). Ephemeral changes: update current state only, cursor unchanged, never
 * logged, never replayed.
 *
 * ## T4 — Detect, never decide
 * Conflicts are built as `Conflict` payloads and routed to the `Resolver`. Under LWW,
 * `compare()` never returns `"concurrent"`, so this path is unreachable in Phase 1b.
 * The branch exists and is documented; it is not a `throw new Error("unreachable")`.
 *
 * ## T5 — Per-scope causal order
 * Subscriptions fire per scope in the order changes were accepted. No cross-scope
 * ordering is promised or implemented.
 */

import {
  makeCursor,
  makeChangeId,
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
  type ChangeBatch,
  type Snapshot,
  type Conflict,
  type Resolution,
  type Subscription,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Per-unit current-state entry (state changes only). */
interface UnitEntry {
  /** The accepted StateChange — returned verbatim from snapshot(). */
  readonly change: StateChange;
}

/** Entry in the durable log — only durable changes are appended here. */
interface LogEntry {
  readonly change: Change;
  readonly seq: number;
}

interface SubscriptionHandlers {
  onBatch(batch: ChangeBatch): void;
  onConflict(conflict: Conflict): Resolution | Promise<Resolution>;
}

interface ScopeState {
  /** Current state per unit (LWW). State changes only. */
  stateUnits: Map<string, UnitEntry>;
  /** Last accepted version per unit for op-with-version collision detection (T4). */
  opUnitVersions: Map<string, import("./types.ts").Version>;
  /** Durable log for replay. Only durable changes. Monotonically ordered by seq. */
  durableLog: LogEntry[];
  /** Monotonic cursor sequence. Only durable changes advance this. */
  cursorSeq: number;
  /** Active subscriptions for this scope. */
  subs: Set<SubscriptionHandlers>;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class Engine implements Feed, ScopeRouter {
  private readonly _clock: ClockStrategy;
  private readonly _resolver?: Resolver;
  /** Global id dedup across all scopes (change ids are globally unique). */
  private readonly _seenIds = new Set<string>();
  /** Per-scope state. Created lazily on first use. */
  private readonly _scopes = new Map<string, ScopeState>();

  constructor(clock: ClockStrategy, resolver?: Resolver) {
    this._clock = clock;
    this._resolver = resolver;
  }

  // ---- Feed.apply ---------------------------------------------------------

  apply(batch: ChangeBatch): Promise<void> {
    const scopeState = this._getOrCreateScope(batch.scope);
    const newChanges: Change[] = [];

    for (const change of batch.changes) {
      // Global dedup: reject any change id we have already processed.
      if (this._seenIds.has(change.id.value)) continue;

      if (change.kind === "state") {
        const accepted = this._applyState(change as StateChange, scopeState);
        if (accepted) newChanges.push(change);
      } else {
        const accepted = this._applyOp(change as OpChange, scopeState);
        if (accepted) newChanges.push(change);
      }
    }

    if (newChanges.length === 0) return Promise.resolve();

    // Compute whether any new change is durable — cursor is only included
    // in the notification batch when durable changes are present (T3).
    const hasDurable = newChanges.some((c) => c.lifetime.class === "durable");

    const outBatch: ChangeBatch = {
      scope: batch.scope,
      changes: newChanges,
      ...(hasDurable
        ? { cursor: makeCursor(batch.scope, scopeState.cursorSeq) }
        : {}),
    };

    // Notify subscriptions synchronously — required for drain-round correctness
    // (same pattern as TriviallyCorrectFeed.onForward).
    for (const handlers of scopeState.subs) {
      handlers.onBatch(outBatch);
    }

    return Promise.resolve();
  }

  private _applyState(change: StateChange, scope: ScopeState): boolean {
    const existing = scope.stateUnits.get(change.unit.key);

    if (existing !== undefined) {
      const cmp = this._clock.compare(change.version, existing.change.version);
      if (cmp === "before") {
        // Older than what we have: mark seen, skip.
        this._seenIds.add(change.id.value);
        return false;
      }
      if (cmp === "concurrent") {
        // T4 deferred path. Under LWW this is unreachable.
        // Phase 2 (logical/vector clock) will exercise this branch.
        // For now: hold both, do not silently decide.
        // If a Resolver is configured, route to it asynchronously.
        // Since apply() is synchronous, we skip and leave conflict open.
        // This is the "defer" outcome until Phase 2 wires the async path.
        this._seenIds.add(change.id.value);
        return false; // deferred — not applied, not lost (Phase 2 will route)
      }
      // cmp === "after": incoming is newer, proceed.
    }

    this._seenIds.add(change.id.value);
    scope.stateUnits.set(change.unit.key, { change });

    // T3: only durable changes advance the cursor and enter the log.
    if (change.lifetime.class === "durable") {
      scope.cursorSeq++;
      scope.durableLog.push({ change, seq: scope.cursorSeq });
    }

    return true;
  }

  private _applyOp(change: OpChange, scope: ScopeState): boolean {
    this._seenIds.add(change.id.value);

    if (change.version !== undefined) {
      // Op-with-version: op-transport-with-local-fold path (T2 / T4).
      const existingVersion = scope.opUnitVersions.get(change.unit.key);
      if (existingVersion !== undefined) {
        const cmp = this._clock.compare(change.version, existingVersion);
        if (cmp === "before") return false; // stale op, skip
        if (cmp === "concurrent") {
          // T4 deferred (unreachable under LWW). Phase 2 will route to Resolver.
          return false;
        }
      }
      scope.opUnitVersions.set(change.unit.key, change.version);
    }
    // Pure-intent ops (no version): dedup by id only (already done above). Apply.

    // T3: only durable ops enter the log.
    if (change.lifetime.class === "durable") {
      scope.cursorSeq++;
      scope.durableLog.push({ change, seq: scope.cursorSeq });
    }

    return true;
  }

  // ---- Feed.changes -------------------------------------------------------

  async *changes(
    scope: Scope,
    since: Cursor | null,
  ): AsyncIterable<ChangeBatch> {
    const scopeState = this._scopes.get(scope.key);
    if (!scopeState || scopeState.durableLog.length === 0) return;

    const sinceSeq = since ? since._seq : 0;
    const entries = scopeState.durableLog.filter((e) => e.seq > sinceSeq);
    if (entries.length === 0) return;

    // Yield all entries since `since` as a single batch with the terminal cursor.
    const lastSeq = entries[entries.length - 1]!.seq;
    yield {
      scope,
      changes: entries.map((e) => e.change),
      cursor: makeCursor(scope, lastSeq),
    };
  }

  // ---- Feed.snapshot ------------------------------------------------------

  async snapshot(scope: Scope): Promise<Snapshot> {
    const scopeState = this._scopes.get(scope.key);
    if (!scopeState) return { scope, changes: [] };

    // Return all current-state changes (durable and ephemeral).
    // Ephemeral values are current state even though they are not in the durable log.
    const changes: Change[] = Array.from(scopeState.stateUnits.values()).map(
      (entry) => entry.change,
    );
    return { scope, changes };
  }

  // ---- ScopeRouter.subscribe ----------------------------------------------

  subscribe(
    scope: Scope,
    handlers: {
      onBatch(batch: ChangeBatch): void;
      onConflict(conflict: Conflict): Resolution | Promise<Resolution>;
    },
  ): Subscription {
    const scopeState = this._getOrCreateScope(scope);
    scopeState.subs.add(handlers);
    return {
      unsubscribe: () => {
        scopeState.subs.delete(handlers);
      },
    };
  }

  // ---- Test-accessible accessors ------------------------------------------

  /**
   * Current cursor for a scope. Returns a cursor at seq 0 if the scope has
   * never received a durable change (no advancement has occurred).
   * Not on the Feed/ScopeRouter interface — for test assertions only.
   */
  getCursor(scope: Scope): Cursor {
    const scopeState = this._scopes.get(scope.key);
    return makeCursor(scope, scopeState?.cursorSeq ?? 0);
  }

  // ---- Private ------------------------------------------------------------

  private _getOrCreateScope(scope: Scope): ScopeState {
    const key = scope.key;
    if (!this._scopes.has(key)) {
      this._scopes.set(key, {
        stateUnits: new Map(),
        opUnitVersions: new Map(),
        durableLog: [],
        cursorSeq: 0,
        subs: new Set(),
      });
    }
    return this._scopes.get(key)!;
  }
}
