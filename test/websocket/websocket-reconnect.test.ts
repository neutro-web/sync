/**
 * T6 — reconnect over a dropped socket, ENGINE-LOCAL only.
 * Gate: docs/gates/phase3-transports.md §T6.
 *
 * Same B3 boundary as T3-BC (test/client/reconnect.test.ts): this proves
 * socket close fires onDisconnect and socket reopen fires onConnect, and
 * that a peer's own persisted cursor correctly reflects its own durable
 * writes across that disconnect window. It does NOT prove peer-pull
 * recovery of writes made only on the OTHER peer while this one was down
 * — that is the confirmed B3 defect, Phase 5, out of scope.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WsImpl from "ws";
import { Engine } from "../../src/core/engine.ts";
import { MemoryStore } from "../../src/core/persistence.ts";
import {
	DURABLE,
	makeChangeId,
	makeConflictUnit,
	makeScope,
} from "../../src/core/types.ts";
import { lww } from "../../src/strategies/index.ts";
import { WebSocketTransport } from "../../src/transports/websocket.ts";
import { type Relay, startRelay } from "../fixtures/ws-relay-server.ts";

describe("T6 — WebSocket reconnect, engine-local", () => {
	let relay: Relay;
	beforeEach(async () => {
		relay = await startRelay();
	});
	afterEach(async () => {
		await relay.close();
	});

	it("socket close fires onDisconnect; reconnect fires onConnect", async () => {
		const t = new WebSocketTransport(`ws://localhost:${relay.port}`, {
			// biome-ignore lint/suspicious/noExplicitAny: ws's WebSocket is browser-API-compatible
			WebSocketImpl: WsImpl as any,
		});
		const onConnect = vi.fn();
		const onDisconnect = vi.fn();
		t.onConnect(onConnect);
		t.onDisconnect(onDisconnect);
		await new Promise((r) => setTimeout(r, 50));
		expect(onConnect).toHaveBeenCalledTimes(1);

		t.close(); // simulates a dropped socket
		await new Promise((r) => setTimeout(r, 50));
		expect(onDisconnect).toHaveBeenCalledTimes(1);

		const t2 = new WebSocketTransport(`ws://localhost:${relay.port}`, {
			// biome-ignore lint/suspicious/noExplicitAny: ws's WebSocket is browser-API-compatible
			WebSocketImpl: WsImpl as any,
		});
		const onConnect2 = vi.fn();
		t2.onConnect(onConnect2);
		await new Promise((r) => setTimeout(r, 50));
		expect(onConnect2).toHaveBeenCalledTimes(1);
		t2.close();
	});

	it("the reconnecting peer's own persisted cursor reflects its own durable writes across the drop", async () => {
		const scope = makeScope("s-t6");
		const store = new MemoryStore();
		const clock = lww();
		const engine = new Engine(clock, { store });
		await engine.hydrateScope(scope);

		await engine.apply({
			scope,
			changes: [
				{
					id: makeChangeId("c1"),
					kind: "state",
					scope,
					unit: makeConflictUnit("u1"),
					lifetime: DURABLE,
					value: "before-drop",
					version: clock.mint(),
				},
			],
		});
		const cursorBeforeDrop = engine.getCursor(scope)._seq;

		// Simulate the socket dropping and reconnecting — engine state and its
		// store are untouched by transport lifecycle (they are independent
		// seams per AGENTS.md standing gates: in-process transport unchanged,
		// no delivery logic in the transport).
		const t = new WebSocketTransport(`ws://localhost:${relay.port}`, {
			// biome-ignore lint/suspicious/noExplicitAny: ws's WebSocket is browser-API-compatible
			WebSocketImpl: WsImpl as any,
		});
		await new Promise((r) => setTimeout(r, 50));
		t.close();
		await new Promise((r) => setTimeout(r, 20));

		// A fresh Engine over the SAME store, as the reconnecting peer would
		// construct after re-establishing its own process/session — proves
		// its own cursor position is durable and independent of the socket.
		const rehydrated = new Engine(lww(), { store });
		await rehydrated.hydrateScope(scope);
		expect(rehydrated.getCursor(scope)._seq).toBe(cursorBeforeDrop);
		const snap = await rehydrated.snapshot(scope);
		expect(snap.changes).toHaveLength(1);
	});
});
