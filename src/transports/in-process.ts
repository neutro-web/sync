/**
 * In-process Transport implementation — Phase 1's only transport.
 *
 * Two transports are connected by setting each one's `channelFn` to route
 * through the other (directly or via a ChannelSimulator). `send()` resolves
 * on hand-off to `channelFn` — NOT on delivery, NOT on ack. This matches §7
 * exactly: "send resolves when handed to the carrier."
 *
 * The channel simulator replaces `channelFn` on each side to inject faults.
 *
 * Lifecycle: call `_setConnected(true/false)` to fire `onConnect`/`onDisconnect`
 * handlers (drives the T3 reconnect fork in the harness).
 */

import type { Transport, ChangeBatch } from "../core/types.ts";

type BatchHandler = (batch: ChangeBatch) => void;

export class InProcessTransport implements Transport {
  private _onBatch?: BatchHandler;
  private _onConnect?: () => void;
  private _onDisconnect?: () => void;
  private _connected = false;
  private _closed = false;

  /**
   * Called on `send()`. Defaults to a no-op (unconnected transport).
   * The harness replaces this with a function that routes through a ChannelSimulator.
   */
  channelFn: (batch: ChangeBatch) => void = () => {};

  // ---- called by the channel to push a batch into this transport's receiver ----

  _deliver(batch: ChangeBatch): void {
    if (this._closed) return;
    this._onBatch?.(batch);
  }

  // ---- Transport interface ----

  send(batch: ChangeBatch): Promise<void> {
    if (!this._closed) {
      this.channelFn(batch); // synchronous hand-off; §7: resolves here, not on ack
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
  }

  // ---- connection lifecycle (used by harness to fire T3 reconnect handlers) ----

  _setConnected(connected: boolean): void {
    const was = this._connected;
    this._connected = connected;
    if (connected && !was) this._onConnect?.();
    if (!connected && was) this._onDisconnect?.();
  }

  get connected(): boolean {
    return this._connected;
  }

  /**
   * Convenience: create a directly connected pair with no channel simulator.
   * A.send() → B._deliver() and B.send() → A._deliver().
   * Used in tests that don't need fault injection.
   */
  static pair(): [InProcessTransport, InProcessTransport] {
    const a = new InProcessTransport();
    const b = new InProcessTransport();
    a.channelFn = (batch) => b._deliver(batch);
    b.channelFn = (batch) => a._deliver(batch);
    a._setConnected(true);
    b._setConnected(true);
    return [a, b];
  }
}
