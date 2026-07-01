// src/client/create-sync.ts  (full replacement)
import { Engine } from "../core/engine.ts";
import type { PersistenceStore } from "../core/persistence.ts";
import { ResolverPump } from "../core/resolver-pump.ts";
import {
	type Change,
	type ChangeBatch,
	type ClockStrategy,
	type Conflict,
	type Cursor,
	DURABLE,
	type Lifetime,
	type Resolution,
	type Resolver,
	type Scope,
	type Subscription,
	type Transport,
	type Version,
	makeChangeId,
	makeConflictUnit,
	makeScope,
} from "../core/types.ts";

export interface ScopeConfig {
	strategy: ClockStrategy;
	resolver?: Resolver;
	lifetime?: Lifetime;
	manual?: boolean;
}

export interface SyncConfig {
	transport: Transport;
	scopes?: Record<string, ScopeConfig>;
	/** Persistence store for the durable log and cursor. Use {@link MemoryStore} (default / in-memory,
	 * no import needed — omit this field) or {@link IndexedDBStore} from `@neutro/sync/persistence`
	 * for durable browser storage. Not a public seam type — do not implement custom stores outside of tests. */
	store?: PersistenceStore;
}

export interface WriteOpts {
	lifetime?: Lifetime;
	unitKey?: string;
	/** Stable op id for dedup across redelivery (op/`do` only). Consumer owns
	 *  uniqueness-per-logical-op. Absent → auto-minted (current behavior). */
	opId?: string;
}

export interface ScopeHandle {
	set(unit: string, value: unknown, opts?: WriteOpts): void;
	do(unit: string, value: unknown, opts?: WriteOpts): void;
	subscribe(onBatch: (changes: readonly Change[]) => void): Subscription;
	snapshot(): Promise<readonly Change[]>;
	/**
	 * Register a handler for manual conflict resolution. Requires `manual: true` in ScopeConfig.
	 * WARNING: In manual mode, unresolved conflicts accumulate in the engine's open-conflicts map
	 * indefinitely. For bounded memory, call resolve() or take-local/take-remote on every conflict.
	 */
	onConflict(
		handler: (conflict: Conflict, resolve: (r: Resolution) => void) => void,
	): void;
	close(): void;
}

export interface SyncClient {
	scope(key: string, config?: ScopeConfig): ScopeHandle;
	close(): void;
}

interface ScopeEntry {
	engine: Engine;
	handle: ScopeHandle;
	config: ScopeConfig;
	pump: ResolverPump | null;
	lastCursor: Cursor | null;
	prevVersions: Map<string, Version>;
	engineSub: Subscription;
	consumerSubs: Set<(changes: readonly Change[]) => void>;
	conflictHandler:
		| ((conflict: Conflict, resolve: (r: Resolution) => void) => void)
		| null;
	scopeObj: Scope;
	replayVersion: number; // monotonic counter; incremented on each onConnect to cancel superseded replay loops
}

export function createSync(config: SyncConfig): SyncClient {
	const { transport } = config;
	const entries = new Map<string, ScopeEntry>();
	// closedKeys tombstones closed scope keys to prevent silent re-registration.
	// Grows with scope churn for the client's lifetime; bounded by the number of unique
	// scope keys ever registered on this client instance.
	const closedKeys = new Set<string>();
	let _seq = 0;
	const _clientId = Math.random().toString(36).slice(2, 8);
	let closed = false;

	// Inbound: demultiplex by scope key
	transport.receive((batch: ChangeBatch) => {
		const entry = entries.get(batch.scope.key);
		if (entry)
			entry.engine
				.apply(batch)
				.catch((err) => console.error("[createSync] apply error:", err));
	});

	// T3 reconnect fork: ephemeral scopes use full snapshot resend (their state has
	// no stable cursor identity across disconnects); durable scopes use cursor-based
	// incremental replay to re-send only changes the peer hasn't seen yet.
	// Note: lastCursor is in-memory only. After a process restart, replay begins
	// from the beginning of the durable log. Persistent cursor storage is Phase 3.
	transport.onConnect(() => {
		if (closed) return; // client is closing or closed
		for (const entry of entries.values()) {
			entry.replayVersion = (entry.replayVersion + 1) >>> 0;
			const myVersion = entry.replayVersion;
			const isEphemeral = entry.config.lifetime?.class === "ephemeral";
			if (isEphemeral) {
				(async () => {
					const snap = await entry.engine.snapshot(entry.scopeObj);
					if (myVersion !== entry.replayVersion) return; // superseded
					if (closed) return; // client closed during snapshot await
					// Ephemeral reconnect: resend the full snapshot. Note that these change ids
					// were already forwarded via onBatch at write time (relay semantics). Peers
					// that were connected deduplicate via seenIds and silently ignore them; peers
					// that were offline receive the full state. This is correct and intentional —
					// ephemeral state has no stable cursor, so full resend is the only safe strategy.
					// Snapshot changes carry their original ids. If the receiving peer already
					// has those ids in seenIds, the engine silently drops them — the reconnect
					// delivers nothing for that scope. This is correct: the peer's state is already up to date.
					// For a new peer (no prior seenIds), the full snapshot is delivered normally.
					if (snap.changes.length > 0) {
						await transport.send({
							scope: entry.scopeObj,
							changes: snap.changes,
						});
					}
				})().catch((err) => console.error("[createSync]", err));
			} else {
				(async () => {
					for await (const batch of entry.engine.changes(
						entry.scopeObj,
						entry.lastCursor,
					)) {
						if (closed) break; // client closed during replay
						if (myVersion !== entry.replayVersion) break; // superseded
						await transport.send(batch);
						// Track cursor after each successful send so mid-replay disconnect
						// does not re-send already-delivered batches on the next reconnect
						if (batch.cursor) entry.lastCursor = batch.cursor;
					}
				})().catch((err) => console.error("[createSync]", err));
			}
		}
	});

	function _buildHandle(key: string, cfg: ScopeConfig): ScopeHandle {
		const scopeObj = makeScope(key);
		const engine = new Engine(cfg.strategy, {
			store: config.store,
		});

		const entry: ScopeEntry = {
			engine,
			handle: null as unknown as ScopeHandle,
			config: cfg,
			pump: null,
			lastCursor: null,
			prevVersions: new Map(),
			engineSub: { unsubscribe: () => {} },
			consumerSubs: new Set(),
			conflictHandler: null,
			scopeObj,
			replayVersion: 0,
		};
		entries.set(key, entry);

		// N-1: Declare handleClosed before the closures below that capture it by reference.
		// JS closures always reference the same variable — this is safe. Declared here (before
		// engine.subscribe) so it appears before the onConflict closure that references it.
		let handleClosed = false;

		// Wire engine subscription for outbound transport + consumer fan-out
		entry.engineSub = engine.subscribe(scopeObj, {
			onBatch(batch: ChangeBatch): void {
				// Track cursor for durable-scope reconnect replay
				if (batch.cursor) entry.lastCursor = batch.cursor;
				// Relay semantics: every accepted change (local or remote) is forwarded to transport.
				// Peers deduplicate via seenIds — no infinite loop, but bandwidth is multiplied by peer count.
				// This is intentional for peer-to-peer mesh; a future server-relay transport would filter
				// by origin to avoid redundant sends.
				transport
					.send(batch)
					// Phase 5: replace with retry/backpressure queue (delivery-above-transport, charter §8).
					.catch((err) => console.error("[createSync] send error:", err));
				// Keep prevVersions in sync with engine-accepted state so future local
				// mints start from the correct prev. Without this, a remote win would
				// leave prevVersions below the engine's actual version, causing the next
				// local set() to silently lose (LWW stale-prev clock drift).
				for (const change of batch.changes) {
					if (change.kind === "state" && change.version !== undefined) {
						const unitKey = change.unit.key;
						const current = entry.prevVersions.get(unitKey);
						// Only advance — never go backwards
						if (
							current === undefined ||
							cfg.strategy.compare(current, change.version) === "before"
						) {
							entry.prevVersions.set(unitKey, change.version);
						}
					}
				}
				// Consumer fan-out: strip cursor, deliver Change[] only.
				// Note: subscribers added during a callback are NOT included in the current
				// batch's snapshot — they receive subsequent batches only. This is by design.
				// Snapshot consumerSubs to prevent mid-iteration mutation from unsubscribe-during-callback.
				if (entry.consumerSubs.size > 0)
					for (const cb of [...entry.consumerSubs]) {
						try {
							cb(batch.changes);
						} catch (err) {
							console.error("[createSync] subscriber error:", err);
						}
					}
			},
			onConflict(conflict: Conflict): Resolution {
				// Engine.onConflict is a notification-only hook (Model C): the return value is
				// always ignored by the engine. We always return { decision: "defer" } as a
				// protocol placeholder — resolution is driven by the separate resolveConflict()
				// call, either from the consumer (manual mode) or from ResolverPump (auto mode).
				// Auto mode: ResolverPump calls resolveConflict() after this notification returns.
				// Manual mode: the consumer's resolve() callback calls resolveConflict() explicitly.
				// NOTE (Axiom 4 partial gap): The engine's versioned-op concurrent path (engine.ts)
				// silently holds the change without surfacing a Conflict. This is a known open gate
				// for Phase 3. For the state path, Axiom 4 holds fully.
				if (cfg.manual && entry.conflictHandler) {
					// In manual mode, if the consumer never calls resolve(), the conflict stays
					// open in the engine's openConflicts map indefinitely. This is by design —
					// the consumer owns the resolution lifecycle. For bounded memory, resolve or
					// discard every conflict you receive.
					// Post-close calls to resolve() are discarded safely.
					entry.conflictHandler(conflict, (r: Resolution) => {
						if (handleClosed) return; // scope is closed; discard post-close resolution
						engine.resolveConflict(conflict.scope, conflict.unit, r);
					});
				}
				return { decision: "defer" }; // satisfies TypeScript return type; value is always ignored by the engine
			},
		});

		// Auto-resolution pump (only when resolver present and not manual)
		if (cfg.resolver && !cfg.manual) {
			entry.pump = new ResolverPump(engine, cfg.resolver, scopeObj);
		}

		const handle: ScopeHandle = {
			set(unit: string, value: unknown, opts?: WriteOpts): void {
				if (handleClosed)
					throw new Error(`ScopeHandle for scope '${key}' is closed.`);
				const unitKey = opts?.unitKey ?? unit;
				const lifetime = opts?.lifetime ?? cfg.lifetime ?? DURABLE;
				const prev = entry.prevVersions.get(unitKey);
				const version = cfg.strategy.mint(prev);
				// Update prevVersions synchronously so consecutive set() calls on the same unit
				// mint causally-ordered versions (avoids spurious LWW same-tick or VC base-vector conflicts).
				entry.prevVersions.set(unitKey, version);
				engine
					.apply({
						scope: scopeObj,
						changes: [
							{
								id: makeChangeId(`${_clientId}:${key}:set:${unit}:${++_seq}`),
								kind: "state",
								scope: scopeObj,
								unit: makeConflictUnit(unitKey),
								lifetime,
								value,
								version,
							},
						],
					})
					// Phase 5: replace with retry/backpressure queue (delivery-above-transport, charter §8).
					// Note: .then() is intentionally omitted here. prevVersions is updated synchronously above.
					// onBatch will further advance prevVersions if a remote write wins (only-advance guard there).
					.catch((err) => console.error("[createSync] apply error:", err));
			},

			do(unit: string, value: unknown, opts?: WriteOpts): void {
				if (handleClosed)
					throw new Error(`ScopeHandle for scope '${key}' is closed.`);
				const unitKey = opts?.unitKey ?? unit;
				const lifetime = opts?.lifetime ?? cfg.lifetime ?? DURABLE;
				engine
					.apply({
						scope: scopeObj,
						changes: [
							{
								id: makeChangeId(
									opts?.opId ?? `${_clientId}:${key}:do:${unit}:${++_seq}`,
								),
								kind: "op",
								scope: scopeObj,
								unit: makeConflictUnit(unitKey),
								lifetime,
								value,
							},
						],
					})
					.catch((err) => console.error("[createSync] apply error:", err));
			},

			subscribe(onBatch: (changes: readonly Change[]) => void): Subscription {
				entry.consumerSubs.add(onBatch);
				return {
					unsubscribe: () => {
						entry.consumerSubs.delete(onBatch);
					},
				};
			},

			snapshot(): Promise<readonly Change[]> {
				if (handleClosed)
					throw new Error(`ScopeHandle for scope '${key}' is closed.`);
				return entry.engine.snapshot(entry.scopeObj).then((s) => s.changes);
			},

			onConflict(
				handler: (conflict: Conflict, resolve: (r: Resolution) => void) => void,
			): void {
				if (!cfg.manual) {
					throw new Error(
						`onConflict() requires manual: true on scope '${key}'. Auto-resolution is active; set manual: true in ScopeConfig to use manual conflict handling.`,
					);
				}
				entry.conflictHandler = handler;
			},

			close(): void {
				if (!entries.has(key)) return; // already closed — idempotent
				entry.engineSub.unsubscribe();
				entry.pump?.dispose();
				entry.consumerSubs.clear();
				entries.delete(key);
				closedKeys.add(key);
				// Engine has no close() method. Once entries.delete(key) removes the last
				// reference, the GC reclaims it. This is safe because createSync owns all
				// engine references exclusively.
				handleClosed = true;
			},
		};

		entry.handle = handle;
		return handle;
	}

	// Pre-register scopes declared in config
	if (config.scopes) {
		for (const [key, cfg] of Object.entries(config.scopes)) {
			_buildHandle(key, cfg);
		}
	}

	return {
		scope(key: string, cfg?: ScopeConfig): ScopeHandle {
			if (closed)
				throw new Error("SyncClient is closed; cannot create new scopes.");
			if (closedKeys.has(key)) {
				throw new Error(
					`scope '${key}' was closed and cannot be re-registered. Create a new SyncClient to reuse this scope key.`,
				);
			}
			const existing = entries.get(key);
			if (existing) {
				if (cfg !== undefined) {
					throw new Error(
						`scope '${key}' is already registered; reconfiguration is not allowed. Call scope('${key}') without a config to retrieve the existing handle.`,
					);
				}
				return existing.handle;
			}
			if (!cfg) {
				throw new Error(
					`scope '${key}' is not registered. Provide a ScopeConfig on the first call.`,
				);
			}
			return _buildHandle(key, cfg);
		},

		close(): void {
			closed = true;
			// Snapshot entries before iterating — each handle.close() mutates entries.
			// Close each handle so handleClosed is set — prevents ghost writes on held references.
			for (const entry of [...entries.values()]) {
				entry.handle.close();
			}
			// entries is now clear (each handle.close() calls entries.delete(key) + closedKeys.add(key))
			// Unsubscribe all engines before closing transport to prevent onBatch
			// callbacks from firing on a draining transport after teardown begins.
			transport.close();
		},
	};
}
