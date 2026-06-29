/**
 * Gossip-wiring helpers for multi-replica Engine tests.
 * Keeps conflict detection tests focused on resolution logic, not mesh setup.
 */
import type { Engine } from "../../src/core/engine.ts";
import type { Scope } from "../../src/core/types.ts";
import { ChannelSimulator } from "./channel-simulator.ts";
import type { FaultConfig } from "./channel-simulator.ts";

export interface GossipSetup {
	channels: Map<string, ChannelSimulator>;
	allChannels: ChannelSimulator[];
	throwIfErrors(): void;
}

/**
 * Wire N engines into a full gossip mesh via ChannelSimulators.
 * Each engine's onBatch enqueues to all other engines' inbound channels.
 * Conflicts receive a "defer" response so tests control resolution manually.
 */
export function setupGossip(
	engines: Engine[],
	scope: Scope,
	baseSeed: number,
	faultConfig?: FaultConfig,
): GossipSetup {
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
		// biome-ignore lint/style/noNonNullAssertion: i < n === engines.length
		engines[i]!.subscribe(scope, {
			onBatch: (batch) => {
				for (let j = 0; j < n; j++) {
					if (j === ci) continue;
					// biome-ignore lint/style/noNonNullAssertion: channel created for all i≠j pairs
					channels.get(`${ci}→${j}`)!.enqueue(batch, (b) => {
						// biome-ignore lint/style/noNonNullAssertion: j < n === engines.length
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

/**
 * Drain channels until quiescence (no deliveries in a round) or maxRounds.
 * Throws if maxRounds is exhausted without quiescing — convergence failure.
 */
export async function drainChannels(
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
