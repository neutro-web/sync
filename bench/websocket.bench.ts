/**
 * T7 — WebSocket baseline numbers. CC/CI only (gate docs/gates/phase3-transports.md §T7).
 *
 * MEASUREMENT SEMANTICS (required by AGENTS.md and gate T7):
 * - "send→receive latency": time from calling transport.send() (hand-off)
 *   to the PEER's receive() callback firing, over the real relay. Includes
 *   one full network round-trip through the relay process, NOT just
 *   hand-off — this is a cross-process/network number, unlike the
 *   in-process send-only timing in websocket-transport.test.ts.
 * - Denominator: per single ChangeBatch containing exactly 1 Change.
 * - "batch throughput": count of 1-change batches successfully received by
 *   the peer per second, sustained send loop, denominator = batches/sec.
 *
 * A sandbox/in-process number is invalid here — only a real relay process
 * (this file spawns a real `ws` server on localhost) counts.
 */
import { bench, describe } from "vitest";
import WsImpl from "ws";
import { startRelay } from "../test/fixtures/ws-relay-server.ts";
import { WebSocketTransport } from "../src/transports/websocket.ts";
import { DURABLE, makeChangeId, makeConflictUnit, makeScope } from "../src/core/types.ts";
import { lww } from "../src/strategies/index.ts";

function batch(n: number) {
	const scope = makeScope("s-bench-ws");
	return {
		scope,
		changes: [
			{
				id: makeChangeId(`bench-${n}`),
				kind: "state" as const,
				scope,
				unit: makeConflictUnit("u1"),
				lifetime: DURABLE,
				value: `v${n}`,
				version: lww().mint(),
			},
		],
	};
}

describe("T7 — WebSocket baseline (CC/CI only)", () => {
	bench("send→receive latency — 1-change batch over real relay (N=1 round-trip)", async () => {
		const relay = await startRelay();
		const url = `ws://localhost:${relay.port}`;
		// biome-ignore lint/suspicious/noExplicitAny: ws's WebSocket is browser-API-compatible
		const a = new WebSocketTransport(url, { WebSocketImpl: WsImpl as any });
		// biome-ignore lint/suspicious/noExplicitAny: ws's WebSocket is browser-API-compatible
		const b = new WebSocketTransport(url, { WebSocketImpl: WsImpl as any });
		await new Promise((r) => setTimeout(r, 50));

		await new Promise<void>((resolve) => {
			b.receive(() => resolve());
			a.send(batch(1));
		});

		a.close();
		b.close();
		await relay.close();
	});

	bench(
		"batch throughput — 100 sequential 1-change batches over real relay",
		async () => {
			const relay = await startRelay();
			const url = `ws://localhost:${relay.port}`;
			// biome-ignore lint/suspicious/noExplicitAny: ws's WebSocket is browser-API-compatible
			const a = new WebSocketTransport(url, { WebSocketImpl: WsImpl as any });
			// biome-ignore lint/suspicious/noExplicitAny: ws's WebSocket is browser-API-compatible
			const b = new WebSocketTransport(url, { WebSocketImpl: WsImpl as any });
			await new Promise((r) => setTimeout(r, 50));

			let received = 0;
			b.receive(() => {
				received++;
			});
			for (let i = 0; i < 100; i++) await a.send(batch(i));
			while (received < 100) await new Promise((r) => setTimeout(r, 5));

			a.close();
			b.close();
			await relay.close();
		},
		{ iterations: 5 },
	);
});
