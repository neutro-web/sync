// src/client/create-sync.ts  (full replacement)
import { Engine } from "../core/engine.ts";
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

// ─── Public interfaces ────────────────────────────────────────────────────────

export interface ScopeConfig {
	strategy: ClockStrategy;
	resolver?: Resolver;
	lifetime?: Lifetime;
	manual?: boolean;
}

export interface SyncConfig {
	transport: Transport;
	scopes?: Record<string, ScopeConfig>;
}

export interface WriteOpts {
	lifetime?: Lifetime;
	unitKey?: string;
}

export interface ScopeHandle {
	set(unit: string, value: unknown, opts?: WriteOpts): void;
	do(unit: string, value: unknown, opts?: WriteOpts): void;
	subscribe(onBatch: (changes: readonly Change[]) => void): Subscription;
	snapshot(): Promise<readonly Change[]>;
	onConflict(
		handler: (conflict: Conflict, resolve: (r: Resolution) => void) => void,
	): void;
	close(): void;
}

export interface SyncClient {
	scope(key: string, config?: ScopeConfig): ScopeHandle;
	close(): void;
}

// ─── Internal ─────────────────────────────────────────────────────────────────

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
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createSync(config: SyncConfig): SyncClient {
	const { transport } = config;
	const entries = new Map<string, ScopeEntry>();
	let _seq = 0;
	const _clientId = Math.random().toString(36).slice(2, 8);

	// Inbound: demultiplex by scope key
	transport.receive((batch: ChangeBatch) => {
		const entry = entries.get(batch.scope.key);
		if (entry)
			entry.engine
				.apply(batch)
				.catch((err) => console.error("[createSync] apply error:", err));
	});

	// T3 reconnect fork — fires when this transport reconnects
	transport.onConnect(() => {
		for (const entry of entries.values()) {
			const isEphemeral = entry.config.lifetime?.class === "ephemeral";
			if (isEphemeral) {
				(async () => {
					const snap = await entry.engine.snapshot(entry.scopeObj);
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
						await transport.send(batch);
					}
				})().catch((err) => console.error("[createSync]", err));
			}
		}
	});

	function _buildHandle(key: string, cfg: ScopeConfig): ScopeHandle {
		const scopeObj = makeScope(key);
		const engine = new Engine(cfg.strategy);

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
		};
		entries.set(key, entry);

		// Wire engine subscription for outbound transport + consumer fan-out
		entry.engineSub = engine.subscribe(scopeObj, {
			onBatch(batch: ChangeBatch): void {
				// Track cursor for durable-scope reconnect replay
				if (batch.cursor) entry.lastCursor = batch.cursor;
				// Outbound to transport (full batch, cursor included — peers need it)
				transport
					.send(batch)
					.catch((err) => console.error("[createSync] send error:", err));
				// Consumer fan-out: strip cursor, deliver Change[] only
				for (const cb of entry.consumerSubs) cb(batch.changes);
			},
			onConflict(conflict: Conflict): Resolution {
				// Engine ignores this return value (T4/Model C); it's a notification only.
				// In manual mode, delegate to the registered conflict handler.
				if (cfg.manual && entry.conflictHandler) {
					entry.conflictHandler(conflict, (r: Resolution) => {
						engine.resolveConflict(conflict.scope, conflict.unit, r);
					});
				}
				return { decision: "defer" };
			},
		});

		// Auto-resolution pump (only when resolver present and not manual)
		if (cfg.resolver && !cfg.manual) {
			entry.pump = new ResolverPump(engine, cfg.resolver, scopeObj);
		}

		const handle: ScopeHandle = {
			set(unit: string, value: unknown, opts?: WriteOpts): void {
				const unitKey = opts?.unitKey ?? unit;
				const lifetime = opts?.lifetime ?? cfg.lifetime ?? DURABLE;
				const prev = entry.prevVersions.get(unitKey);
				const version = cfg.strategy.mint(prev);
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
					.catch((err) => console.error("[createSync] apply error:", err));
			},

			do(unit: string, value: unknown, opts?: WriteOpts): void {
				const unitKey = opts?.unitKey ?? unit;
				const lifetime = opts?.lifetime ?? cfg.lifetime ?? DURABLE;
				engine
					.apply({
						scope: scopeObj,
						changes: [
							{
								id: makeChangeId(`${_clientId}:${key}:do:${unit}:${++_seq}`),
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
				entry.engineSub.unsubscribe();
				entry.pump?.dispose();
				entry.consumerSubs.clear();
				entries.delete(key);
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
			for (const entry of entries.values()) {
				entry.engineSub.unsubscribe();
				entry.pump?.dispose();
				entry.consumerSubs.clear();
			}
			entries.clear();
			transport.close();
		},
	};
}
