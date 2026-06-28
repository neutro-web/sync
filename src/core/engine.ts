/**
 * Engine — the real `Feed` + `ScopeRouter` implementation.
 *
 * In-memory. Deterministic. No I/O. Suitable for the claude.ai sandbox and for
 * all convergence/correctness testing; real persistence (IndexedDB/OPFS) is Phase 3.
 *
 * ## T1 — Change branching
 * `apply()` branches on `change.kind`:
 *   - `"state"`: LWW via `ClockStrategy.compare(incoming, currentWinner)`.
 *     Re-applying the same id is a no-op (seenIds dedup). Different id targeting
 *     the same unit: compare decides (`"after"` → accept; `"before"` → skip;
 *     `"concurrent"` → deferred without marking the id seen).
 *   - `"op"` (no version): dedup by id only. Never double-applied.
 *   - `"op"` (with version): seenIds dedup, then version-compare on the unit.
 *     `"concurrent"` → deferred without marking the id seen (Phase 2 can re-route).
 *
 * ## T2 — Version opacity
 * The engine never reads inside a `Version`. All versioning is delegated to
 * `ClockStrategy.compare()`.
 *
 * ## T3 — Lifetime fork
 * Durable and ephemeral state changes are stored in separate per-unit maps
 * (`durableStateUnits` / `ephemeralStateUnits`). An ephemeral write with a
 * higher version wins in snapshot(), but the durable base is preserved in
 * `durableStateUnits` so it can be promoted back when the ephemeral expires or
 * is superseded. Durable changes advance the cursor and enter the durable log;
 * ephemeral changes do neither.
 *
 * ## T4 — Detect, never decide
 * The `concurrent` arm returns false WITHOUT adding to seenIds, leaving the
 * incoming change id open for Phase 2 re-routing. Under LWW, `compare()` never
 * returns `"concurrent"`, so this path is unreachable in Phase 1b. The branch
 * exists and is documented as an honest deferred arm, not a throw.
 *
 * ## T5 — Per-scope causal order
 * Subscriptions fire per scope in the order changes were accepted. No cross-scope
 * ordering is promised or implemented.
 *
 * ## Cursor locality
 * `cursorSeq` is a local ordinal: it counts durable changes accepted by THIS
 * engine, in the order they arrived. The same logical changes applied in a
 * different order on another replica produce different seq values. A cursor
 * from one engine is NOT safe to use as input to another engine's `changes()`.
 */

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
  type Version,
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
  /**
   * Durable state per unit. Always preserved even when an ephemeral write with
   * a higher version is currently winning in snapshot(). Restored as the winner
   * when its version exceeds the ephemeral's, or when the ephemeral expires.
   */
  durableStateUnits: Map<string, UnitEntry>;
  /**
   * Ephemeral state per unit. Participates in snapshot() alongside
   * durableStateUnits; the per-unit winner is whichever has the higher version.
   * Not persisted, not replayed.
   */
  ephemeralStateUnits: Map<string, UnitEntry>;
  /** Last accepted version per unit for op-with-version collision detection (T4). */
  opUnitVersions: Map<string, Version>;
  /** Durable log for replay. Only durable changes. Monotonically ordered by seq. */
  durableLog: LogEntry[];
  /** Monotonic cursor sequence. Only durable changes advance this. */
  cursorSeq: number;
  /** Active subscriptions for this scope. */
  subs: Set<SubscriptionHandlers>;
  /**
   * Per-scope id dedup. Change ids must be unique within a scope's delivery
   * stream. Per-scope (not global) so that the same id string in two different
   * scopes is accepted independently on each scope.
   */
  seenIds: Set<string>;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class Engine implements Feed, ScopeRouter {
  private readonly _clock: ClockStrategy;
  private readonly _resolver?: Resolver;
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
      // Per-scope dedup: reject any change id already processed on this scope.
      if (scopeState.seenIds.has(change.id.value)) continue;

      if (change.kind === "state") {
        const accepted = this._applyState(change as StateChange, scopeState);
        if (accepted) newChanges.push(change);
      } else {
        const accepted = this._applyOp(change as OpChange, scopeState);
        if (accepted) newChanges.push(change);
      }
    }

    if (newChanges.length === 0) return Promise.resolve();

    const hasDurable = newChanges.some((c) => c.lifetime.class === "durable");

    const outBatch: ChangeBatch = {
      scope: batch.scope,
      changes: newChanges,
      ...(hasDurable
        ? { cursor: makeCursor(batch.scope, scopeState.cursorSeq) }
        : {}),
    };

    // Notify subscriptions synchronously — required for drain-round correctness.
    // Subscription handlers must not throw; a throwing handler breaks apply().
    for (const handlers of scopeState.subs) {
      handlers.onBatch(outBatch);
    }

    return Promise.resolve();
  }

  private _applyState(change: StateChange, scope: ScopeState): boolean {
    const durableEntry = scope.durableStateUnits.get(change.unit.key);
    const ephemeralEntry = scope.ephemeralStateUnits.get(change.unit.key);
    const currentWinner = this._stateWinner(durableEntry, ephemeralEntry);

    if (currentWinner !== undefined) {
      const cmp = this._clock.compare(change.version, currentWinner.change.version);
      if (cmp === "before") {
        scope.seenIds.add(change.id.value);
        return false;
      }
      if (cmp === "concurrent") {
        // T4 deferred path. Under LWW this is unreachable.
        // Do NOT add to seenIds — the id stays open for Phase 2 re-routing.
        return false;
      }
      // cmp === "after": incoming is newer, proceed.
    }

    scope.seenIds.add(change.id.value);

    // T3: route to the appropriate state map based on lifetime.
    if (change.lifetime.class === "durable") {
      scope.durableStateUnits.set(change.unit.key, { change });
      scope.cursorSeq++;
      scope.durableLog.push({ change, seq: scope.cursorSeq });
    } else {
      scope.ephemeralStateUnits.set(change.unit.key, { change });
    }

    return true;
  }

  private _applyOp(change: OpChange, scope: ScopeState): boolean {
    if (change.version !== undefined) {
      // Op-with-version: op-transport-with-local-fold path (T2 / T4).
      const existingVersion = scope.opUnitVersions.get(change.unit.key);
      if (existingVersion !== undefined) {
        const cmp = this._clock.compare(change.version, existingVersion);
        if (cmp === "before") {
          scope.seenIds.add(change.id.value); // stale: permanently block retries
          return false;
        }
        if (cmp === "concurrent") {
          // T4 deferred (unreachable under LWW). Phase 2 will route to Resolver.
          // Do NOT add to seenIds — leave open for re-routing.
          return false;
        }
      }
      scope.opUnitVersions.set(change.unit.key, change.version);
    }

    // Accepted (pure-intent ops reach here directly; versioned ops after passing
    // the compare gate above). Mark seen only on acceptance.
    scope.seenIds.add(change.id.value);

    // T3: only durable ops enter the log.
    if (change.lifetime.class === "durable") {
      scope.cursorSeq++;
      scope.durableLog.push({ change, seq: scope.cursorSeq });
    }

    return true;
  }

  /**
   * Return whichever of `durable` and `ephemeral` has the higher version, or
   * the non-null one if only one exists. Used to find the current winning state
   * for a unit before comparing an incoming change against it.
   */
  private _stateWinner(
    durable: UnitEntry | undefined,
    ephemeral: UnitEntry | undefined,
  ): UnitEntry | undefined {
    if (durable === undefined) return ephemeral;
    if (ephemeral === undefined) return durable;
    const cmp = this._clock.compare(ephemeral.change.version, durable.change.version);
    return cmp === "after" ? ephemeral : durable;
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

    // Merge durable and ephemeral state maps: for each unit, emit the winning
    // entry (higher version). Durable base is preserved in durableStateUnits
    // even when ephemeral is currently winning.
    const allUnitKeys = new Set([
      ...scopeState.durableStateUnits.keys(),
      ...scopeState.ephemeralStateUnits.keys(),
    ]);

    const changes: Change[] = [];
    for (const unitKey of allUnitKeys) {
      const winner = this._stateWinner(
        scopeState.durableStateUnits.get(unitKey),
        scopeState.ephemeralStateUnits.get(unitKey),
      );
      if (winner !== undefined) changes.push(winner.change);
    }

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
   *
   * Cursors are engine-local ordinals: a cursor from THIS engine is only valid
   * as input to THIS engine's `changes()`. Two replicas that accepted the same
   * changes in different orders will assign different seq values to the same
   * logical entries — passing one replica's cursor to another's `changes()` is
   * incorrect.
   *
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
        durableStateUnits: new Map(),
        ephemeralStateUnits: new Map(),
        opUnitVersions: new Map(),
        durableLog: [],
        cursorSeq: 0,
        subs: new Set(),
        seenIds: new Set(),
      });
    }
    return this._scopes.get(key)!;
  }
}
