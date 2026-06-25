/**
 * ChannelSimulator — unreliable channel between two endpoints.
 *
 * Wraps the delivery path between an InProcessTransport sender and a
 * destination deliver callback. Injects faults deterministically using a
 * seeded PRNG. Batches are NOT delivered immediately — they queue in `pending`
 * and are flushed by calling `drain()`.
 *
 * Fault injection:
 *   drop      — batch is permanently discarded (never reaches dest).
 *   reorder   — batch is inserted before an earlier pending entry.
 *   duplicate — an extra copy of the batch is appended to pending.
 *   partition — enqueue continues; drain delivers nothing (simulates network cut).
 *
 * Determinism guarantee: each call to `enqueue()` consumes exactly 4 RNG
 * values (dropRoll, reorderRoll, duplicateRoll, reorderPositionRoll),
 * regardless of which branch is taken. This keeps the RNG state identical
 * across runs with the same seed and the same sequence of enqueue() calls.
 */

import type { ChangeBatch } from "../../src/core/types.ts";
import { mulberry32 } from "./seeded-rng.ts";

export interface FaultConfig {
  /** Probability [0,1] that a batch is permanently dropped. Default 0. */
  dropRate?: number;
  /** Probability [0,1] that a batch is inserted before a random earlier entry. Default 0. */
  reorderRate?: number;
  /** Probability [0,1] that a batch receives a duplicate copy in pending. Default 0. */
  duplicateRate?: number;
}

export interface ChannelStats {
  sent: number;
  dropped: number;
  reordered: number;
  duplicated: number;
  delivered: number;
}

interface PendingEntry {
  batch: ChangeBatch;
  deliverFn: (batch: ChangeBatch) => void;
  sendSeq: number;
}

export class ChannelSimulator {
  private readonly rng: () => number;
  private readonly pending: PendingEntry[] = [];
  private partitioned = false;
  private sendSeq = 0;
  private readonly cfg: Required<FaultConfig>;

  readonly stats: ChannelStats = {
    sent: 0,
    dropped: 0,
    reordered: 0,
    duplicated: 0,
    delivered: 0,
  };

  constructor(seed: number, config: FaultConfig = {}) {
    this.rng = mulberry32(seed);
    this.cfg = {
      dropRate: config.dropRate ?? 0,
      reorderRate: config.reorderRate ?? 0,
      duplicateRate: config.duplicateRate ?? 0,
    };
  }

  /**
   * Enqueue a batch for eventual delivery via `deliverFn`.
   * Consumes exactly 4 RNG values regardless of branch taken (determinism).
   * During partition: batches bypass fault injection and queue directly
   * (partition = network cut, not packet loss — buffered, not dropped).
   */
  enqueue(batch: ChangeBatch, deliverFn: (batch: ChangeBatch) => void): void {
    this.stats.sent++;
    const seq = this.sendSeq++;

    if (this.partitioned) {
      // Consume no RNG during partition (partition is structural, not probabilistic).
      this.pending.push({ batch, deliverFn, sendSeq: seq });
      return;
    }

    // Consume all 4 RNG rolls unconditionally for determinism.
    const dropRoll = this.rng();
    const reorderRoll = this.rng();
    const duplicateRoll = this.rng();
    const reorderPositionRoll = this.rng();

    if (dropRoll < this.cfg.dropRate) {
      this.stats.dropped++;
      return;
    }

    const entry: PendingEntry = { batch, deliverFn, sendSeq: seq };

    if (this.pending.length > 0 && reorderRoll < this.cfg.reorderRate) {
      const insertAt = Math.floor(reorderPositionRoll * this.pending.length);
      this.pending.splice(insertAt, 0, entry);
      this.stats.reordered++;
    } else {
      this.pending.push(entry);
    }

    if (duplicateRoll < this.cfg.duplicateRate) {
      // Duplicate appended at the end (after the original).
      this.pending.push({ ...entry });
      this.stats.duplicated++;
    }
  }

  /**
   * Flush all queued batches in current order. Returns number of batches delivered.
   * No-op (returns 0) when partitioned; queued entries remain for later.
   */
  drain(): number {
    if (this.partitioned) return 0;
    // Splice all at once so deliveries that enqueue new entries don't affect
    // this drain's iteration (they'll be picked up in the next drain round).
    const toDeliver = this.pending.splice(0);
    for (const { batch, deliverFn } of toDeliver) {
      deliverFn(batch);
      this.stats.delivered++;
    }
    return toDeliver.length;
  }

  /** Cut the channel. Subsequent drain() calls deliver nothing; enqueue() still buffers. */
  partition(): void {
    this.partitioned = true;
  }

  /** Restore the channel. Buffered batches will be delivered on the next drain(). */
  reconnect(): void {
    this.partitioned = false;
  }

  get isPartitioned(): boolean {
    return this.partitioned;
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }
}
