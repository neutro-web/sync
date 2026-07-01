/**
 * Dumb fan-out relay — a TEST FIXTURE, not a product (gate T4).
 * One peer's raw message is forwarded verbatim to every OTHER connected
 * peer. No parsing, no sync/merge/cursor logic — that belongs in `ns`
 * client code, never in the carrier (charter §4, AGENTS.md §7 discipline).
 */
import { type WebSocket as WSClient, WebSocketServer } from "ws";

export interface Relay {
	port: number;
	close(): Promise<void>;
}

export function startRelay(port = 0): Promise<Relay> {
	return new Promise((resolve, reject) => {
		const wss = new WebSocketServer({ port });
		const clients = new Set<WSClient>();

		wss.on("connection", (ws) => {
			clients.add(ws);
			ws.on("message", (data, isBinary) => {
				for (const peer of clients) {
					if (peer !== ws && peer.readyState === peer.OPEN) {
						peer.send(data, { binary: isBinary });
					}
				}
			});
			ws.on("close", () => clients.delete(ws));
		});

		wss.on("listening", () => {
			const addr = wss.address();
			const resolvedPort = typeof addr === "object" && addr ? addr.port : port;
			resolve({
				port: resolvedPort,
				close: () =>
					new Promise<void>((res, rej) => {
						for (const c of clients) c.terminate();
						wss.close((err) => (err ? rej(err) : res()));
					}),
			});
		});
		wss.on("error", reject);
	});
}
