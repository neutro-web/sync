/** Public API surface for @neutro/sync. Import from this module in consumer code. */
export { createSync } from "./client/create-sync.ts";
export type {
	ScopeConfig,
	ScopeHandle,
	SyncClient,
	SyncConfig,
	WriteOpts,
} from "./client/create-sync.ts";
export { lww, vectorClock } from "./strategies/index.ts";
export type {
	Change,
	Conflict,
	Lifetime,
	Resolution,
	Subscription,
	Transport,
} from "./core/types.ts";
