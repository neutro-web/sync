/**
 * Real cross-tab Transport backed by BroadcastChannel (gate T1).
 * Mirrors src/transports/in-process.ts's shape; BroadcastChannel has no
 * built-in connect/disconnect, so tab lifecycle (pagehide/pageshow) is
 * mapped onto onConnect/onDisconnect (gate T3-BC).
 */
import type { ChangeBatch, Transport } from "../core/types.ts";

type BatchHandler = (batch: ChangeBatch) => void;

export class BroadcastChannelTransport implements Transport {
	private readonly _channel: BroadcastChannel;
	private _onBatch?: BatchHandler;
	private _onConnect?: () => void;
	private _onDisconnect?: () => void;
	private _closed = false;

	constructor(channelName: string) {
		this._channel = new BroadcastChannel(channelName);
		this._channel.onmessage = (ev: MessageEvent<ChangeBatch>) => {
			if (!this._closed) this._onBatch?.(ev.data);
		};

		if (typeof window !== "undefined") {
			window.addEventListener("pageshow", this._handlePageShow);
			window.addEventListener("pagehide", this._handlePageHide);
		}
	}

	private _handlePageShow = (): void => {
		if (!this._closed) this._onConnect?.();
	};

	private _handlePageHide = (): void => {
		if (!this._closed) this._onDisconnect?.();
	};

	send(batch: ChangeBatch): Promise<void> {
		if (!this._closed) {
			this._channel.postMessage(batch); // hand-off; §7: resolves here, not on ack
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
		this._channel.close();
		if (typeof window !== "undefined") {
			window.removeEventListener("pageshow", this._handlePageShow);
			window.removeEventListener("pagehide", this._handlePageHide);
		}
	}
}
