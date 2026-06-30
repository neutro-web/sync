import type { Change } from "./types.ts";

export interface PersistenceRecord {
	readonly change: Change;
	readonly seq: number;
}

/**
 * Slot contract for durable persistence.
 *
 * Slot discipline: no engine internals (ClockStrategy, ScopeState) leak into
 * this interface. The store is append-only for changes; cursor is a separate
 * entry. Reads happen only at hydration (startup). Writes are fire-and-forget
 * on the hot apply() path — this interface must never be awaited on the hot path.
 */
export interface PersistenceStore {
	/** Append a durable change record. Must preserve call order within a scope. */
	appendChange(scopeKey: string, record: PersistenceRecord): Promise<void>;
	/** Read durable records for a scope with seq > since (or all if since undefined). */
	readChanges(scopeKey: string, since?: number): Promise<PersistenceRecord[]>;
	/** Persist the engine's local durable-accept cursor seq. */
	writeCursor(scopeKey: string, seq: number): Promise<void>;
	/** Read persisted cursor seq. Returns null if never written. */
	readCursor(scopeKey: string): Promise<number | null>;
	/** Drop all persisted data. For testing only. */
	clear(): Promise<void>;
}

/** In-memory implementation — mirrors current engine behavior behind the store slot. */
export class MemoryStore implements PersistenceStore {
	private readonly _logs = new Map<string, PersistenceRecord[]>();
	private readonly _cursors = new Map<string, number>();

	async appendChange(
		scopeKey: string,
		record: PersistenceRecord,
	): Promise<void> {
		let log = this._logs.get(scopeKey);
		if (!log) {
			log = [];
			this._logs.set(scopeKey, log);
		}
		log.push(record);
	}

	async readChanges(
		scopeKey: string,
		since?: number,
	): Promise<PersistenceRecord[]> {
		const log = this._logs.get(scopeKey) ?? [];
		return since === undefined ? [...log] : log.filter((r) => r.seq > since);
	}

	async writeCursor(scopeKey: string, seq: number): Promise<void> {
		this._cursors.set(scopeKey, seq);
	}

	async readCursor(scopeKey: string): Promise<number | null> {
		return this._cursors.get(scopeKey) ?? null;
	}

	async clear(): Promise<void> {
		this._logs.clear();
		this._cursors.clear();
	}
}
