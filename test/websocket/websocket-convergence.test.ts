/**
 * T5 — cross-device convergence over a real WebSocket relay.
 * Gate: docs/gates/phase3-transports.md §T5.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WsImpl from "ws";
import { createSync } from "../../src/client/create-sync.ts";
import type { Conflict, Resolution, Resolver } from "../../src/core/types.ts";
import { vectorClock } from "../../src/strategies/index.ts";
import { WebSocketTransport } from "../../src/transports/websocket.ts";
import { type Relay, startRelay } from "../fixtures/ws-relay-server.ts";

const deterministicResolver: Resolver = {
	resolve(c: Conflict): Resolution {
		const localVal = (c.local as { value: string }).value;
		const remoteVal = (c.remote as { value: string }).value;
		return localVal > remoteVal
			? { decision: "take-local" }
			: { decision: "take-remote" };
	},
};

describe("T5 — WebSocket cross-device convergence", () => {
	let relay: Relay;
	beforeEach(async () => {
		relay = await startRelay();
	});
	afterEach(async () => {
		await relay.close();
	});

	it("two peers converge after exchanging concurrent writes to the same unit, over the wire", async () => {
		const url = `ws://localhost:${relay.port}`;
		const transportA = new WebSocketTransport(url, {
			// biome-ignore lint/suspicious/noExplicitAny: ws's WebSocket is browser-API-compatible
			WebSocketImpl: WsImpl as any,
		});
		const transportB = new WebSocketTransport(url, {
			// biome-ignore lint/suspicious/noExplicitAny: ws's WebSocket is browser-API-compatible
			WebSocketImpl: WsImpl as any,
		});
		await new Promise((r) => setTimeout(r, 50)); // both connect to the relay

		const syncA = createSync({ transport: transportA });
		const syncB = createSync({ transport: transportB });

		const docA = syncA.scope("doc-t5", {
			strategy: vectorClock("peer-a"),
			resolver: deterministicResolver,
		});
		const docB = syncB.scope("doc-t5", {
			strategy: vectorClock("peer-b"),
			resolver: deterministicResolver,
		});

		// Concurrent writes to the same unit — neither has seen the other's
		// write yet, so this is a genuine causally-independent conflict.
		docA.set("k1", "value-from-a");
		docB.set("k1", "value-from-b");

		// Let both batches cross the real socket via the relay and resolve.
		await new Promise((r) => setTimeout(r, 200));

		const snapA = await docA.snapshot();
		const snapB = await docB.snapshot();

		expect(snapA).toHaveLength(1);
		expect(snapB).toHaveLength(1);
		// biome-ignore lint/suspicious/noExplicitAny: reading unknown change.value in test
		expect((snapA[0] as any).value).toBe((snapB[0] as any).value);
		// Both replicas independently applied the same lexicographic rule to
		// the same pair of values ("value-from-a" vs "value-from-b"), so both
		// must pick "value-from-b" (b > a). Assert the concrete winner too,
		// so this isn't just "both sides happened to agree on something.")
		// biome-ignore lint/suspicious/noExplicitAny: reading unknown change.value in test
		expect((snapA[0] as any).value).toBe("value-from-b");

		syncA.close();
		syncB.close();
	});
});
