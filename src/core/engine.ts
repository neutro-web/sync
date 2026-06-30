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
 *     `"concurrent"` → Model C detect-and-hold, same as state (Phase B / B2).
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
 * The `concurrent` arm in `_applyState` is live as of Phase 2 (Model C). When two
 * causally-independent state changes target the same unit, the engine records the
 * conflict in `openConflicts`, fires `onConflict` as a notification (return value
 * ignored), and returns `false` WITHOUT adding either id to `seenIds`. Resolution
 * is driven by `resolveConflict()` or via `ResolverPump`. The `_applyOp` concurrent
 * arm is live as of Phase B (B2): op-with-version storage carries the full
 * `VersionedChange` (`opUnitChanges`, not just `Version`), so the same Model C
 * detect-and-hold applies to the op path. Landing a winner is generalized by
 * `change.kind` in `_landChange` — an op winner is written to `opUnitChanges`
 * and never touches `durableStateUnits` / `ephemeralStateUnits`.
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

import type { PersistenceStore } from "./persistence.ts";
import {
	type Change,
	type ChangeBatch,
	type ClockStrategy,
	type Conflict,
	type ConflictUnit,
	type Cursor,
	type Feed,
	type OpChange,
	type Resolution,
	type Resolver,
	type Scope,
	type ScopeRouter,
	type Snapshot,
	type StateChange,
	type Subscription,
	type Version,
	type VersionedChange,
	makeChangeId,
	makeCursor,
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
	/**
	 * Last accepted op-with-version per unit, full `VersionedChange` (B2-1, Phase B).
	 * Carries the whole change, not just the version, so a `Conflict` payload can be
	 * built on the op path the same way `_applyState` builds one from
	 * `durableStateUnits`/`ephemeralStateUnits`. Op winners land here only — never
	 * in the state-unit maps (T4 design fork: an op has no confirmed-state-unit
	 * representation).
	 */
	opUnitChanges: Map<string, VersionedChange>;
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
	/**
	 * Open conflicts: units with concurrent competing versions held until resolved.
	 * Last-confirmed-winner semantics: the confirmed maps (durableStateUnits /
	 * ephemeralStateUnits) are unchanged while a conflict is open. The incoming
	 * concurrent change is stored here, not in the confirmed maps, until
	 * resolveConflict() lands a winner.
	 */
	openConflicts: Map<
		string,
		{ local: VersionedChange; remote: VersionedChange }
	>;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class Engine implements Feed, ScopeRouter {
	private readonly _clock: ClockStrategy;
	private readonly _resolver?: Resolver;
	private readonly _store?: PersistenceStore;
	private readonly _chunkSize: number;
	/** Per-scope state. Created lazily on first use. */
	private readonly _scopes = new Map<string, ScopeState>();

	constructor(
		clock: ClockStrategy,
		opts?: {
			resolver?: Resolver;
			store?: PersistenceStore;
			chunkSize?: number;
		},
	) {
		this._clock = clock;
		this._resolver = opts?.resolver;
		this._store = opts?.store;
		this._chunkSize = opts?.chunkSize ?? Number.MAX_SAFE_INTEGER;
	}

	/**
	 * Restore a scope's durable state from the persistence store. Must be called
	 * and awaited before any apply()/subscribe()/changes()/snapshot() on this scope
	 * when a store is configured. No-op if no store is configured or scope already
	 * loaded.
	 *
	 * Cursor is read from the store directly rather than recomputed from replay.
	 * All persisted ids are marked in seenIds (cursor-gated D0 strategy).
	 */
	async hydrateScope(scope: Scope): Promise<void> {
		if (!this._store || this._scopes.has(scope.key)) return;
		const key = scope.key;
		const [records, storedCursor] = await Promise.all([
			this._store.readChanges(key),
			this._store.readCursor(key),
		]);
		const state: ScopeState = {
			durableStateUnits: new Map(),
			ephemeralStateUnits: new Map(),
			opUnitChanges: new Map(),
			durableLog: [],
			cursorSeq: storedCursor ?? 0,
			subs: new Set(),
			seenIds: new Set(),
			openConflicts: new Map(),
		};
		for (const { change, seq } of records) {
			state.durableLog.push({ change, seq });
			if (change.kind === "state") {
				state.durableStateUnits.set(change.unit.key, {
					change: change as StateChange,
				});
			} else if ((change as OpChange).version !== undefined) {
				state.opUnitChanges.set(change.unit.key, change as VersionedChange);
			}
			// Mark all persisted ids seen so seenIds dedup works correctly post-hydration (D0-b).
			state.seenIds.add(change.id.value);
		}
		// If cursor was never explicitly persisted but records exist, derive from last seq.
		if (storedCursor === null && records.length > 0) {
			// biome-ignore lint/style/noNonNullAssertion: records.length > 0 guarded above
			state.cursorSeq = records[records.length - 1]!.seq;
		}
		this._scopes.set(key, state);
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
			const cmp = this._clock.compare(
				change.version,
				currentWinner.change.version,
			);
			if (cmp === "before") {
				scope.seenIds.add(change.id.value);
				return false;
			}
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
					try {
						handlers.onConflict(conflict);
					} catch (err) {
						console.error(
							"[Engine] onConflict handler threw; conflict held open:",
							err,
						);
					}
				}
				return false;
			}
		}

		scope.seenIds.add(change.id.value);

		// T3: route to the appropriate state map based on lifetime.
		if (change.lifetime.class === "durable") {
			scope.durableStateUnits.set(change.unit.key, { change });
			scope.cursorSeq++;
			scope.durableLog.push({ change, seq: scope.cursorSeq });
			if (this._store) {
				const k = change.scope.key;
				const seq = scope.cursorSeq;
				void this._store
					.appendChange(k, { change, seq })
					.catch((err) => console.error("[Engine] store write:", err));
				void this._store
					.writeCursor(k, seq)
					.catch((err) => console.error("[Engine] store cursor:", err));
			}
		} else {
			scope.ephemeralStateUnits.set(change.unit.key, { change });
		}

		return true;
	}

	private _applyOp(change: OpChange, scope: ScopeState): boolean {
		if (change.version !== undefined) {
			// Op-with-version: op-transport-with-local-fold path (T2 / T4).
			const versioned = change as OpChange & { version: Version };
			const existing = scope.opUnitChanges.get(change.unit.key);
			if (existing !== undefined) {
				const cmp = this._clock.compare(versioned.version, existing.version);
				if (cmp === "before") {
					scope.seenIds.add(change.id.value); // stale: permanently block retries
					return false;
				}
				if (cmp === "concurrent") {
					// Model C — detect-and-hold, live for the op path as of Phase B (B2).
					// Mirrors _applyState exactly: record both competing VersionedChanges,
					// fire onConflict as a notification, return synchronously WITHOUT
					// adding either id to seenIds (last-confirmed-winner; re-routable).
					const conflict: Conflict = {
						unit: change.unit,
						scope: change.scope,
						local: existing,
						remote: versioned,
					};
					scope.openConflicts.set(change.unit.key, {
						local: existing,
						remote: versioned,
					});
					for (const handlers of scope.subs) {
						// Notification only — return value intentionally ignored (Model C).
						try {
							handlers.onConflict(conflict);
						} catch (err) {
							console.error(
								"[Engine] onConflict handler threw; conflict held open:",
								err,
							);
						}
					}
					return false;
				}
			}
			scope.opUnitChanges.set(change.unit.key, versioned);
		}

		// Accepted (pure-intent ops reach here directly; versioned ops after passing
		// the compare gate above). Mark seen only on acceptance.
		scope.seenIds.add(change.id.value);

		// T3: only durable ops enter the log.
		if (change.lifetime.class === "durable") {
			scope.cursorSeq++;
			scope.durableLog.push({ change, seq: scope.cursorSeq });
			if (this._store) {
				const k = change.scope.key;
				const seq = scope.cursorSeq;
				void this._store
					.appendChange(k, { change, seq })
					.catch((err) => console.error("[Engine] store write:", err));
				void this._store
					.writeCursor(k, seq)
					.catch((err) => console.error("[Engine] store cursor:", err));
			}
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
		const cmp = this._clock.compare(
			ephemeral.change.version,
			durable.change.version,
		);
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

		for (let i = 0; i < entries.length; i += this._chunkSize) {
			const chunk = entries.slice(i, i + this._chunkSize);
			// biome-ignore lint/style/noNonNullAssertion: chunk is non-empty by slice bounds
			const lastSeq = chunk[chunk.length - 1]!.seq;
			yield {
				scope,
				changes: chunk.map((e) => e.change),
				cursor: makeCursor(scope, lastSeq),
			};
		}
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

	/**
	 * Apply a Resolution to an open conflict on a unit. Engine-internal seam —
	 * not part of the Feed or ScopeRouter interfaces; not the G2 consumer API.
	 *
	 * - `take-local`: local is already confirmed; marks both ids seen so gossip
	 *   redelivery cannot re-open the conflict. No state change, no onBatch.
	 * - `take-remote`: lands the remote change directly into the confirmed maps,
	 *   advances cursor (if durable), fires onBatch.
	 * - `merged`: mints a merged version via `ClockStrategy.mergeVersions`, lands merged value
	 *   in the confirmed maps, advances cursor (if durable), fires onBatch. Throws if the
	 *   active strategy lacks `mergeVersions`.
	 * - `defer`: no-op — conflict stays open.
	 *
	 * Calling resolveConflict on a unit with no open conflict is a no-op.
	 *
	 * **Redelivery note:** Until resolved, the remote change id is NOT in seenIds —
	 * re-applying the same concurrent remote re-opens/overwrites the conflict entry
	 * and re-fires onConflict. Deterministic resolvers are idempotent; stateful
	 * resolvers may fire twice.
	 *
	 * **Reentrancy note (sync resolvers):** A synchronous ResolverPump calls
	 * resolveConflict (and onBatch) from within the onConflict notification loop.
	 * Safe for the current Set-based iteration; do not mutate the subscription set
	 * from inside a handler.
	 */
	resolveConflict(
		scope: Scope,
		unit: ConflictUnit,
		resolution: Resolution,
	): void {
		const scopeState = this._scopes.get(scope.key);
		if (!scopeState) return;
		const open = scopeState.openConflicts.get(unit.key);
		if (!open) return;

		if (resolution.decision === "defer") return; // conflict stays open

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
			const mergedId = makeChangeId(
				`merged:${open.local.id.value}:${open.remote.id.value}`,
			);
			// Generalized by change.kind (B2 design fork) — a merged change preserves
			// whichever kind the conflicting pair was (open.local.kind === open.remote.kind
			// always; both sides of one openConflicts entry are the same conflict-unit's
			// competing writes, which share a kind by construction in _applyState/_applyOp).
			const mergedChange: VersionedChange =
				open.local.kind === "state"
					? {
							id: mergedId,
							kind: "state",
							scope,
							unit,
							value: resolution.value,
							version: mergedVersion,
							lifetime: open.local.lifetime,
						}
					: {
							id: mergedId,
							kind: "op",
							scope,
							unit,
							value: resolution.value,
							version: mergedVersion,
							lifetime: open.local.lifetime,
						};
			scopeState.openConflicts.delete(unit.key);
			scopeState.seenIds.add(open.local.id.value);
			scopeState.seenIds.add(open.remote.id.value);
			this._landChange(mergedChange, scopeState, scope, unit.key);
			return;
		}

		scopeState.openConflicts.delete(unit.key);

		// Prevent gossip redelivery from re-opening this conflict.
		scopeState.seenIds.add(open.local.id.value);
		scopeState.seenIds.add(open.remote.id.value);

		if (resolution.decision === "take-local") {
			// Local is already in the confirmed maps (last-confirmed-winner held it).
			return;
		}

		// take-remote: land the remote change directly into the confirmed maps.
		this._landChange(open.remote, scopeState, scope, unit.key);
	}

	// ---- Private ------------------------------------------------------------

	// Single "land a Change" primitive — avoids duplicating the durable/ephemeral
	// routing + cursor advance + onBatch fire across every resolveConflict arm.
	// Generalized by change.kind (B2): a state winner lands in durableStateUnits /
	// ephemeralStateUnits exactly as before; an op winner lands in opUnitChanges
	// and NEVER touches the state-unit maps (T4 design fork — an op has no
	// confirmed-state-unit representation; routing it through the state maps would
	// corrupt them).
	private _landChange(
		change: VersionedChange,
		scopeState: ScopeState,
		scope: Scope,
		unitKey: string,
	): void {
		const durable = change.lifetime.class === "durable";
		if (change.kind === "state") {
			if (durable) {
				scopeState.durableStateUnits.set(unitKey, { change });
				scopeState.cursorSeq++;
				scopeState.durableLog.push({ change, seq: scopeState.cursorSeq });
				if (this._store) {
					const k = scope.key;
					const seq = scopeState.cursorSeq;
					void this._store
						.appendChange(k, { change, seq })
						.catch((err) => console.error("[Engine] store write:", err));
					void this._store
						.writeCursor(k, seq)
						.catch((err) => console.error("[Engine] store cursor:", err));
				}
			} else {
				scopeState.ephemeralStateUnits.set(unitKey, { change });
			}
		} else {
			// op-with-version winner: opUnitChanges only, never the state maps.
			scopeState.opUnitChanges.set(unitKey, change);
			if (durable) {
				scopeState.cursorSeq++;
				scopeState.durableLog.push({ change, seq: scopeState.cursorSeq });
				if (this._store) {
					const k = scope.key;
					const seq = scopeState.cursorSeq;
					void this._store
						.appendChange(k, { change, seq })
						.catch((err) => console.error("[Engine] store write:", err));
					void this._store
						.writeCursor(k, seq)
						.catch((err) => console.error("[Engine] store cursor:", err));
				}
			}
			// ephemeral op: opUnitChanges updated only; cursor/log untouched (T3).
		}
		const cursor = durable
			? makeCursor(scope, scopeState.cursorSeq)
			: undefined;
		const outBatch: ChangeBatch = {
			scope,
			changes: [change],
			...(cursor && { cursor }),
		};
		for (const handlers of scopeState.subs) {
			handlers.onBatch(outBatch);
		}
	}

	private _getOrCreateScope(scope: Scope): ScopeState {
		const key = scope.key;
		if (!this._scopes.has(key)) {
			this._scopes.set(key, {
				durableStateUnits: new Map(),
				ephemeralStateUnits: new Map(),
				opUnitChanges: new Map(),
				durableLog: [],
				cursorSeq: 0,
				subs: new Set(),
				seenIds: new Set(),
				openConflicts: new Map(),
			});
		}
		// biome-ignore lint/style/noNonNullAssertion: key was just set in this._scopes.set(key, ...)
		return this._scopes.get(key)!;
	}
}
