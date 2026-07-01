/**
 * T6 — reconnect over a dropped socket, ENGINE-LOCAL only.
 * Gate: docs/gates/phase3-transports.md §T6.
 *
 * Same B3 boundary as T3-BC (test/client/reconnect.test.ts): this proves
 * socket close fires onDisconnect and socket reopen fires onConnect, and
 * that `onConnect` can drive a durable replay-from-cursor fork — via a
 * minimal, test-local fork built directly on the raw Engine + Transport
 * seam (NOT `create-sync.ts`'s fork, which B3 proves can never emit a
 * replay batch). It does NOT prove peer-pull recovery of writes made only
 * on the OTHER peer while this one was down — that is the confirmed B3
 * defect, Phase 5, out of scope.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WsImpl from "ws";
import { Engine } from "../../src/core/engine.ts";
import { MemoryStore } from "../../src/core/persistence.ts";
import {
	DURABLE,
	ephemeral,
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

	it("onConnect drives a durable replay-from-cursor fork on real socket reconnect; ephemeral does not replay", async () => {
		const scope = makeScope("s-t6-fork");
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
		const cursorBeforeDrop = engine.getCursor(scope);

		const t = new WebSocketTransport(`ws://localhost:${relay.port}`, {
			// biome-ignore lint/suspicious/noExplicitAny: ws's WebSocket is browser-API-compatible
			WebSocketImpl: WsImpl as any,
		});

		// Minimal, test-local durable reconnect fork wired directly onto the
		// raw Engine + Transport seam: onConnect -> engine.changes(cursor) ->
		// transport.send(batch). This is the composition T6 verifies — driven
		// by the transport's REAL socket open event, not a stub — and is
		// deliberately NOT create-sync.ts's fork (see B3 finding above).
		// Registered BEFORE the socket opens so the real open event drives it.
		const sent: unknown[] = [];
		const originalSend = t.send.bind(t);
		t.send = async (batch) => {
			sent.push(batch);
			return originalSend(batch);
		};
		let onConnectFired = false;
		t.onConnect(() => {
			onConnectFired = true;
			void (async () => {
				for await (const batch of engine.changes(scope, cursorBeforeDrop)) {
					await t.send(batch);
				}
			})();
		});
		await new Promise((r) => setTimeout(r, 50)); // real socket open -> onConnect

		// Drop the socket.
		t.close();
		await new Promise((r) => setTimeout(r, 20));

		// While "offline", new durable + ephemeral changes land on this same
		// engine (simulating writes made in the window between disconnect and
		// the transport's reconnect firing onConnect again).
		await engine.apply({
			scope,
			changes: [
				{
					id: makeChangeId("c2"),
					kind: "state",
					scope,
					unit: makeConflictUnit("u2"),
					lifetime: DURABLE,
					value: "during-drop-durable",
					version: clock.mint(),
				},
				{
					id: makeChangeId("eph1"),
					kind: "state",
					scope,
					unit: makeConflictUnit("u3"),
					lifetime: ephemeral(60000),
					value: "during-drop-ephemeral",
					version: clock.mint(),
				},
			],
		});

		// Real reconnect: a new socket, fires a REAL open -> onConnect event.
		const t2 = new WebSocketTransport(`ws://localhost:${relay.port}`, {
			// biome-ignore lint/suspicious/noExplicitAny: ws's WebSocket is browser-API-compatible
			WebSocketImpl: WsImpl as any,
		});
		const sent2: unknown[] = [];
		const originalSend2 = t2.send.bind(t2);
		t2.send = async (batch) => {
			sent2.push(batch);
			return originalSend2(batch);
		};
		let onConnect2Fired = false;
		t2.onConnect(() => {
			onConnect2Fired = true;
			void (async () => {
				for await (const batch of engine.changes(scope, cursorBeforeDrop)) {
					await t2.send(batch);
				}
			})();
		});
		await new Promise((r) => setTimeout(r, 50));

		expect(onConnectFired).toBe(true); // t's own initial connect (from beforeEach setup)
		expect(onConnect2Fired).toBe(true); // real socket reconnect drove the fork

		// The fork sent exactly the durable tail added after
		// cursorBeforeDrop — c2, but NOT eph1 (engine.changes() only walks
		// the durable log; T3 — ephemeral is excluded from cursor replay).
		// biome-ignore lint/suspicious/noExplicitAny: reading unknown batch shape in test
		const sentIds = sent2.flatMap((b: any) =>
			// biome-ignore lint/suspicious/noExplicitAny: reading unknown batch shape in test
			b.changes.map((c: any) => c.id.value),
		);
		expect(sentIds).toEqual(["c2"]);

		t.close();
		t2.close();
	});
});
