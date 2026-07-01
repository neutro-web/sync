/**
 * Real cross-device Transport backed by WebSocket (gate T4). No retry/
 * backpressure/ack — send() resolves on hand-off to the socket buffer, per
 * §7. WebSocketImpl is injectable so Node-side tests (no global WebSocket
 * before Node 22) can pass `ws`'s WebSocket class; production code defaults
 * to the browser/runtime global, keeping `ns` dependency-free at runtime.
 */
import type { ChangeBatch, Transport } from "../core/types.ts";
import { decodeBatch, encodeBatch } from "./wire-codec.ts";

type BatchHandler = (batch: ChangeBatch) => void;

export interface WebSocketTransportOpts {
	WebSocketImpl?: typeof WebSocket;
}

export class WebSocketTransport implements Transport {
	private readonly _socket: WebSocket;
	private _onBatch?: BatchHandler;
	private _onConnect?: () => void;
	private _onDisconnect?: () => void;
	private _closed = false;
	private readonly _sendQueue: string[] = [];
	private _open = false;

	constructor(url: string, opts?: WebSocketTransportOpts) {
		const Impl = opts?.WebSocketImpl ?? globalThis.WebSocket;
		this._socket = new Impl(url);

		this._socket.onopen = () => {
			this._open = true;
			for (const msg of this._sendQueue.splice(0)) this._socket.send(msg);
			if (!this._closed) this._onConnect?.();
		};
		this._socket.onmessage = (ev: MessageEvent) => {
			if (this._closed) return;
			const batch = decodeBatch(String(ev.data));
			this._onBatch?.(batch);
		};
		this._socket.onclose = () => {
			this._open = false;
			// Unlike onConnect/onBatch, onDisconnect must fire even for a
			// self-initiated close(): close() sets _closed = true synchronously
			// before the underlying socket's close completes, so gating on
			// _closed here would suppress the very disconnect event a caller
			// closing the transport expects to observe.
			this._onDisconnect?.();
		};
		// Some WebSocket implementations (e.g. `ws`) emit a socket-level error
		// (not just onclose) when close() is called before the connection
		// finishes establishing. That's expected under this transport's own
		// close() (no ack/retry semantics — closing mid-connect is valid), so
		// swallow it here rather than letting it surface as an unhandled
		// exception; onclose still fires and drives onDisconnect as usual.
		this._socket.onerror = () => {};
	}

	send(batch: ChangeBatch): Promise<void> {
		if (!this._closed) {
			const msg = encodeBatch(batch);
			// Hand-off is the contract, not delivery: if the socket isn't open
			// yet, the message is queued client-side and flushed on open. This
			// is NOT a delivery guarantee (no ack, no persistence) — it is the
			// same "resolve immediately" semantics as an already-open socket,
			// just covering the connect-race window.
			if (this._open) this._socket.send(msg);
			else this._sendQueue.push(msg);
		}
		return Promise.resolve();
	}

	receive(onBatch: BatchHandler): void {
		this._onBatch = onBatch;
	}

	onConnect(handler: () => void): void {
		this._onConnect = handler;
	}

	onDisconnect(handler: () => void): void {
		this._onDisconnect = handler;
	}

	close(): void {
		this._closed = true;
		this._socket.close();
	}
}
