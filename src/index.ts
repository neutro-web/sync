export { createSync } from "./client/create-sync.ts";
export type {
	ScopeConfig,
	ScopeHandle,
	SyncClient,
	SyncConfig,
	WriteOpts,
} from "./client/create-sync.ts";
export { lww, vectorClock } from "./strategies/index.ts";
