import type {
	Change,
	ChangeBatch,
	ClockStrategy,
	Conflict,
	Cursor,
	Lifetime,
	Resolution,
	Resolver,
	Scope,
	Subscription,
	Transport,
	Version,
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

// Stub — replaced in Task 3
export function createSync(_config: SyncConfig): SyncClient {
	throw new Error("not implemented");
}
