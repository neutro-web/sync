import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WsImpl from "ws";
import {
	DURABLE,
	makeChangeId,
	makeConflictUnit,
	makeScope,
} from "../../src/core/types.ts";
import { lww } from "../../src/strategies/index.ts";
import { WebSocketTransport } from "../../src/transports/websocket.ts";
import { type Relay, startRelay } from "../fixtures/ws-relay-server.ts";

function sampleBatch() {
	const scope = makeScope("s-ws");
	return {
		scope,
		changes: [
			{
				id: makeChangeId("c1"),
				kind: "state" as const,
				scope,
				unit: makeConflictUnit("u1"),
				lifetime: DURABLE,
				value: "hello",
				version: lww().mint(),
			},
		],
	};
}

describe("T4 — WebSocketTransport, §7-conformant", () => {
	let relay: Relay;
	beforeEach(async () => {
		relay = await startRelay();
	});
	afterEach(async () => {
		await relay.close();
	});

	it("implements the five-method Transport surface", async () => {
		const t = new WebSocketTransport(`ws://localhost:${relay.port}`, {
			// biome-ignore lint/suspicious/noExplicitAny: ws's WebSocket is browser-API-compatible
			WebSocketImpl: WsImpl as any,
		});
		expect(typeof t.send).toBe("function");
		expect(typeof t.receive).toBe("function");
		expect(typeof t.onConnect).toBe("function");
		expect(typeof t.onDisconnect).toBe("function");
		expect(typeof t.close).toBe("function");
		t.close();
	});

	it("onConnect fires on socket open; send() resolves on hand-off, not server ack", async () => {
		const t = new WebSocketTransport(`ws://localhost:${relay.port}`, {
			// biome-ignore lint/suspicious/noExplicitAny: ws's WebSocket is browser-API-compatible
			WebSocketImpl: WsImpl as any,
		});
		const onConnect = vi.fn();
		t.onConnect(onConnect);
		await new Promise((r) => setTimeout(r, 50));
		expect(onConnect).toHaveBeenCalledTimes(1);

		const start = performance.now();
		await t.send(sampleBatch());
		expect(performance.now() - start).toBeLessThan(20); // hand-off, no ack wait

		t.close();
	});

	it("two transports through the relay: A's send reaches B's receive, decoded correctly", async () => {
		const a = new WebSocketTransport(`ws://localhost:${relay.port}`, {
			// biome-ignore lint/suspicious/noExplicitAny: ws's WebSocket is browser-API-compatible
			WebSocketImpl: WsImpl as any,
		});
		const b = new WebSocketTransport(`ws://localhost:${relay.port}`, {
			// biome-ignore lint/suspicious/noExplicitAny: ws's WebSocket is browser-API-compatible
			WebSocketImpl: WsImpl as any,
		});
		await new Promise((r) => setTimeout(r, 50)); // let both connect

		const received = vi.fn();
		b.receive(received);

		await a.send(sampleBatch());
		await new Promise((r) => setTimeout(r, 50));

		expect(received).toHaveBeenCalledTimes(1);
		expect(received.mock.calls[0][0].changes[0].id.value).toBe("c1");

		a.close();
		b.close();
	});

	it("onDisconnect fires on socket close; close() closes the underlying socket", async () => {
		const t = new WebSocketTransport(`ws://localhost:${relay.port}`, {
			// biome-ignore lint/suspicious/noExplicitAny: ws's WebSocket is browser-API-compatible
			WebSocketImpl: WsImpl as any,
		});
		const onDisconnect = vi.fn();
		t.onDisconnect(onDisconnect);
		await new Promise((r) => setTimeout(r, 50));

		t.close();
		await new Promise((r) => setTimeout(r, 50));
		expect(onDisconnect).toHaveBeenCalledTimes(1);
	});
});
