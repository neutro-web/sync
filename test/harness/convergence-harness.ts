/**
 * ConvergenceHarness
 *
 * Instantiates N Feed replicas and routes ChangeBatches between them through
 * a ChannelSimulator per directed edge (N×(N-1) simulators total).
 *
 * Topology
 * --------
 * For N replicas {R0…R(N-1)}, channels are keyed "i→j" for every i≠j.
 * Channel seeds are derived as: channelSeed + i*100 + j (stable, no collision
 * for N ≤ 99 which covers all harness use cases).
 *
 * Wiring (TriviallyCorrectFeed)
 * -----------------------------
 * feed.onForward = (batch) => {
 *   for each j ≠ i: channels["i→j"].enqueue(batch, (b) => replicas[j].feed.apply(b))
 * }
 * NonConvergingFeed.onForward is never called; the harness sets it but the
 * feed ignores it.
 *
 * drainToQuiescence()
 * -------------------
 * Loops: drain all channels → await Promise.resolve() (flush microtask queue)
 * → stop when total delivered in this round is 0. Bounded by maxRounds (default
 * 100) to detect runaway loops (e.g. a forwarding cycle that never settles).
 *
 * assertConverged()
 * -----------------
 * Throws if replica count < 2 (per AGENTS.md spike rule: single-replica
 * convergence is vacuous). Otherwise compares all replicas against R0 by:
 *   1. Scope set equality.
 *   2. Per-scope unit key set equality.
 *   3. Per-unit value deep equality (JSON-serialized; values are unknown but
 *      test-authored, so JSON is adequate for the harness).
 *   4. Applied op-id set equality.
 */

import type { ChangeBatch } from "../../src/core/types.ts";
import {
	ChannelSimulator,
	type ChannelStats,
	type FaultConfig,
} from "./channel-simulator.ts";
import {
	NonConvergingFeed,
	type ReplicaStateSnapshot,
	TriviallyCorrectFeed,
} from "./stubs.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FeedKind = "non-converging" | "trivially-correct";

export interface HarnessOptions {
	replicaCount: number;
	feedKind: FeedKind;
	channelSeed: number;
	faultConfig?: FaultConfig;
}

export interface DivergenceRecord {
	scopeKey: string;
	unitKey: string;
	values: unknown[]; // [R0 value, R1 value, … Ri value]
}

export interface ConvergenceResult {
	converged: boolean;
	divergences: DivergenceRecord[];
	snapshots: ReplicaStateSnapshot[];
}

// ---------------------------------------------------------------------------
// Replica wrapper
// ---------------------------------------------------------------------------

type StubFeed = NonConvergingFeed | TriviallyCorrectFeed;

interface Replica {
	id: number;
	feed: StubFeed;
}

// ---------------------------------------------------------------------------
// ConvergenceHarness
// ---------------------------------------------------------------------------

export class ConvergenceHarness {
	private readonly replicas: Replica[];
	// channels["i→j"] delivers from replica i to replica j
	private readonly channels = new Map<string, ChannelSimulator>();
	private readonly opts: HarnessOptions;

	constructor(opts: HarnessOptions) {
		this.opts = opts;
		const { replicaCount, feedKind, channelSeed, faultConfig } = opts;

		// Create replicas
		this.replicas = Array.from({ length: replicaCount }, (_, i) => ({
			id: i,
			feed:
				feedKind === "non-converging"
					? new NonConvergingFeed()
					: new TriviallyCorrectFeed(),
		}));

		// Create N×(N-1) directed channels
		for (let i = 0; i < replicaCount; i++) {
			for (let j = 0; j < replicaCount; j++) {
				if (i === j) continue;
				const seed = channelSeed + i * 100 + j;
				this.channels.set(`${i}→${j}`, new ChannelSimulator(seed, faultConfig));
			}
		}

		// Wire feeds (only TriviallyCorrectFeed actually calls onForward)
		for (let i = 0; i < replicaCount; i++) {
			// biome-ignore lint/style/noNonNullAssertion: i < replicaCount === this.replicas.length
			const srcFeed = this.replicas[i]!.feed;
			const capturedI = i;
			srcFeed.onForward = (batch: ChangeBatch) => {
				for (let j = 0; j < replicaCount; j++) {
					if (j === capturedI) continue;
					// biome-ignore lint/style/noNonNullAssertion: channel created in constructor for all i≠j pairs
					const channel = this.channels.get(`${capturedI}→${j}`)!;
					// biome-ignore lint/style/noNonNullAssertion: j < replicaCount === this.replicas.length
					const destFeed = this.replicas[j]!.feed;
					channel.enqueue(batch, (b) => {
						void destFeed.apply(b);
					});
				}
			};
		}
	}

	// ---- Local write --------------------------------------------------------

	/**
	 * Apply a batch directly to replica `id`'s feed (simulates a local write).
	 * Returns the promise from feed.apply() — callers typically await this.
	 */
	applyLocal(id: number, batch: ChangeBatch): Promise<void> {
		const replica = this.replicas[id];
		if (!replica) throw new Error(`No replica with id ${id}`);
		return replica.feed.apply(batch);
	}

	// ---- Draining -----------------------------------------------------------

	/**
	 * Drain all channels to quiescence. Each round: drain every channel; if any
	 * batch was delivered, loop again (deliveries may have enqueued new batches).
	 * Stops when a full round delivers nothing.
	 *
	 * Returns total batches delivered across all rounds.
	 * Throws if maxRounds is exceeded (indicates a forwarding cycle bug).
	 */
	async drainToQuiescence(maxRounds = 100): Promise<number> {
		let totalDelivered = 0;

		for (let round = 0; round < maxRounds; round++) {
			let roundDelivered = 0;
			for (const channel of this.channels.values()) {
				roundDelivered += channel.drain();
			}
			// Flush microtask queue (apply() returns Promise.resolve() but we want
			// any chained .then() handlers to settle before the next round).
			await Promise.resolve();

			totalDelivered += roundDelivered;
			if (roundDelivered === 0) return totalDelivered;
		}

		throw new Error(
			`drainToQuiescence: did not reach quiescence after ${maxRounds} rounds — possible forwarding cycle`,
		);
	}

	// ---- Convergence assertion ----------------------------------------------

	/**
	 * Compare all replicas against R0. Throws if replicaCount < 2.
	 *
	 * Returns ConvergenceResult: { converged, divergences, snapshots }
	 */
	assertConverged(): ConvergenceResult {
		if (this.replicas.length < 2) {
			throw new Error(
				"assertConverged() requires ≥2 replicas (per AGENTS.md spike rule: " +
					"single-replica convergence is vacuous)",
			);
		}

		const snapshots = this.replicas.map((r) => r.feed.getState());
		const divergences: DivergenceRecord[] = [];

		// biome-ignore lint/style/noNonNullAssertion: snapshots.length === replicaCount >= 2 (checked in constructor)
		const base = snapshots[0]!;

		// Collect all scope keys across all replicas
		const allScopeKeys = new Set<string>();
		for (const snap of snapshots) {
			for (const sk of snap.state.keys()) allScopeKeys.add(sk);
		}

		for (const scopeKey of allScopeKeys) {
			// Collect all unit keys for this scope across all replicas
			const allUnitKeys = new Set<string>();
			for (const snap of snapshots) {
				const units = snap.state.get(scopeKey);
				if (units) for (const uk of units.keys()) allUnitKeys.add(uk);
			}

			for (const unitKey of allUnitKeys) {
				const values = snapshots.map((snap) =>
					snap.state.get(scopeKey)?.get(unitKey),
				);
				// Check all values equal the base replica's value
				const baseVal = values[0];
				const allEqual = values.every(
					(v) => JSON.stringify(v) === JSON.stringify(baseVal),
				);
				if (!allEqual) {
					divergences.push({ scopeKey, unitKey, values });
				}
			}
		}

		// Compare op-id sets
		const baseOpIds = Array.from(base.appliedOpIds).sort().join(",");
		for (let i = 1; i < snapshots.length; i++) {
			// biome-ignore lint/style/noNonNullAssertion: i < snapshots.length (loop bound)
			const opIds = Array.from(snapshots[i]!.appliedOpIds).sort().join(",");
			if (opIds !== baseOpIds) {
				divergences.push({
					scopeKey: "__ops__",
					unitKey: `replica-${i}-vs-0`,
					values: [baseOpIds, opIds],
				});
			}
		}

		return {
			converged: divergences.length === 0,
			divergences,
			snapshots,
		};
	}

	// ---- Channel control ----------------------------------------------------

	partition(from: number, to: number): void {
		this._getChannel(from, to).partition();
	}

	reconnect(from: number, to: number): void {
		this._getChannel(from, to).reconnect();
	}

	partitionAll(): void {
		for (const channel of this.channels.values()) channel.partition();
	}

	reconnectAll(): void {
		for (const channel of this.channels.values()) channel.reconnect();
	}

	// ---- Accessors ----------------------------------------------------------

	getReplicaState(id: number): ReplicaStateSnapshot {
		const replica = this.replicas[id];
		if (!replica) throw new Error(`No replica with id ${id}`);
		return replica.feed.getState();
	}

	getTotalChannelStats(): ChannelStats {
		const totals: ChannelStats = {
			sent: 0,
			dropped: 0,
			reordered: 0,
			duplicated: 0,
			delivered: 0,
		};
		for (const ch of this.channels.values()) {
			totals.sent += ch.stats.sent;
			totals.dropped += ch.stats.dropped;
			totals.reordered += ch.stats.reordered;
			totals.duplicated += ch.stats.duplicated;
			totals.delivered += ch.stats.delivered;
		}
		return totals;
	}

	/** Get stats for a specific directed channel. */
	getChannelStats(from: number, to: number): ChannelStats {
		return { ...this._getChannel(from, to).stats };
	}

	get replicaCount(): number {
		return this.replicas.length;
	}

	// ---- Private ------------------------------------------------------------

	private _getChannel(from: number, to: number): ChannelSimulator {
		const ch = this.channels.get(`${from}→${to}`);
		if (!ch) throw new Error(`No channel ${from}→${to}`);
		return ch;
	}
}
