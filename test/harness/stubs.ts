/**
 * Stub Feed implementations for convergence harness.
 *
 * Two stubs — one proves the harness goes RED, one proves it goes GREEN.
 *
 * LocalState
 * ----------
 * Flat in-memory state store used by both stubs. Tracks:
 *   - StateChange values keyed by (scopeKey, unitKey), LWW by Version._seq.
 *   - OpChange ids in an applied-ops set (dedup only; no ordering replay needed for harness).
 *
 * NonConvergingFeed
 * -----------------
 * apply() writes to LocalState only. Never calls onForward; changes are
 * permanently local. The harness MUST report converged: false for G1.
 *
 * TriviallyCorrectFeed
 * --------------------
 * apply() deduplicates via seenIds, writes to LocalState, then calls
 * onForward(batch) synchronously for each accepted change so the harness
 * can route it to peer channels. The synchronous path is required: drain()
 * calls deliverFn synchronously, deliverFn calls apply(), apply() calls
 * onForward(), which calls channel.enqueue() — all without await. Any await
 * here would break the round-based drain loop in ConvergenceHarness.
 *
 * Version peeking
 * ---------------
 * Stubs are not ns-core; they are allowed to peek inside Version. The shape
 * used is { _seq: number } (same structure as Cursor's internal), cast via
 * makeStubVersion(). LWW: higher _seq wins.
 */

import type {
	Change,
	ChangeBatch,
	Cursor,
	Feed,
	Scope,
	Snapshot,
	StateChange,
} from "../../src/core/types.ts";

// ---------------------------------------------------------------------------
// Internal Version shape the stubs use (opaque outside ns-core, visible here)
// ---------------------------------------------------------------------------

interface StubVersionInternals {
	_seq: number;
}

function getSeq(v: unknown): number {
	return (v as StubVersionInternals)._seq;
}

export function makeStubVersion(
	seq: number,
): import("../../src/core/types.ts").Version {
	return { _seq: seq } as unknown as import("../../src/core/types.ts").Version;
}

// ---------------------------------------------------------------------------
// ReplicaStateSnapshot — what assertConverged() compares across replicas
// ---------------------------------------------------------------------------

export interface ReplicaStateSnapshot {
	/** scopeKey → unitKey → value */
	readonly state: ReadonlyMap<string, ReadonlyMap<string, unknown>>;
	/** ids of all applied OpChanges */
	readonly appliedOpIds: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// LocalState — flat in-memory store
// ---------------------------------------------------------------------------

interface UnitEntry {
	value: unknown;
	versionSeq: number;
}

export class LocalState {
	// scopeKey → unitKey → UnitEntry
	private readonly stateMap = new Map<string, Map<string, UnitEntry>>();
	// applied op ids for dedup
	private readonly opIds = new Set<string>();

	applyBatch(batch: ChangeBatch): void {
		for (const change of batch.changes) {
			if (change.kind === "state") {
				this._applyState(change as StateChange);
			} else {
				// op: record id only — harness doesn't replay ops, just checks id sets
				this.opIds.add(change.id.value);
			}
		}
	}

	private _applyState(change: StateChange): void {
		const scopeKey = change.scope.key;
		const unitKey = change.unit.key;
		const incoming = getSeq(change.version);

		if (!this.stateMap.has(scopeKey)) {
			this.stateMap.set(scopeKey, new Map());
		}
		// biome-ignore lint/style/noNonNullAssertion: scopeKey just set via this.stateMap.set(scopeKey, ...) above
		const unitMap = this.stateMap.get(scopeKey)!;
		const existing = unitMap.get(unitKey);

		// LWW: apply only if incoming seq is strictly greater (or no existing entry)
		if (existing === undefined || incoming > existing.versionSeq) {
			unitMap.set(unitKey, { value: change.value, versionSeq: incoming });
		}
	}

	getSnapshot(): ReplicaStateSnapshot {
		const state = new Map<string, ReadonlyMap<string, unknown>>();
		for (const [scopeKey, unitMap] of this.stateMap) {
			const flat = new Map<string, unknown>();
			for (const [unitKey, entry] of unitMap) {
				flat.set(unitKey, entry.value);
			}
			state.set(scopeKey, flat);
		}
		return {
			state,
			appliedOpIds: new Set(this.opIds),
		};
	}
}

// ---------------------------------------------------------------------------
// NonConvergingFeed — local only, never forwards
// ---------------------------------------------------------------------------

export class NonConvergingFeed implements Feed {
	private readonly localState = new LocalState();

	/** Harness sets this; NonConvergingFeed ignores it intentionally. */
	onForward?: (batch: ChangeBatch) => void;

	async apply(batch: ChangeBatch): Promise<void> {
		this.localState.applyBatch(batch);
		// Intentionally does NOT call onForward — changes never leave this replica.
	}

	async snapshot(_scope: Scope): Promise<Snapshot> {
		// Stub: returns empty snapshot; harness never calls this path for G1–G5.
		return { scope: _scope, changes: [] as readonly Change[] };
	}

	changes(_scope: Scope, _since: Cursor | null): AsyncIterable<ChangeBatch> {
		return { [Symbol.asyncIterator]: async function* () {} };
	}

	getState(): ReplicaStateSnapshot {
		return this.localState.getSnapshot();
	}
}

// ---------------------------------------------------------------------------
// TriviallyCorrectFeed — deduplicates + forwards (synchronously)
// ---------------------------------------------------------------------------

export class TriviallyCorrectFeed implements Feed {
	private readonly localState = new LocalState();
	private readonly seenIds = new Set<string>();

	/** Harness wires this to route accepted changes to peer channels. */
	onForward?: (batch: ChangeBatch) => void;

	apply(batch: ChangeBatch): Promise<void> {
		// Filter to changes this replica hasn't seen yet.
		const newChanges = batch.changes.filter(
			(c) => !this.seenIds.has(c.id.value),
		);

		if (newChanges.length === 0) {
			// Entirely a duplicate batch — nothing new to apply or forward.
			return Promise.resolve();
		}

		// Mark all new ids as seen before forwarding (prevents re-forwarding loops).
		for (const c of newChanges) {
			this.seenIds.add(c.id.value);
		}

		const newBatch: ChangeBatch = { ...batch, changes: newChanges };
		this.localState.applyBatch(newBatch);

		// Forward synchronously — required for drain() round correctness.
		// (drain calls deliverFn → apply → onForward → channel.enqueue, all sync)
		this.onForward?.(newBatch);

		return Promise.resolve();
	}

	async snapshot(_scope: Scope): Promise<Snapshot> {
		return { scope: _scope, changes: [] as readonly Change[] };
	}

	changes(_scope: Scope, _since: Cursor | null): AsyncIterable<ChangeBatch> {
		return { [Symbol.asyncIterator]: async function* () {} };
	}

	getState(): ReplicaStateSnapshot {
		return this.localState.getSnapshot();
	}
}
