/**
 * e2e test harness — exposes createSync + transports on `window` so
 * Playwright's page.evaluate() can drive real module code across real tabs.
 */
import { createSync } from "../../../src/client/create-sync.ts";
import { Engine } from "../../../src/core/engine.ts";
import { makeScope } from "../../../src/core/types.ts";
import { IndexedDBStore } from "../../../src/persistence/idb-store.ts";
import { lww } from "../../../src/strategies/index.ts";
import { BroadcastChannelTransport } from "../../../src/transports/broadcast-channel.ts";

// biome-ignore lint/suspicious/noExplicitAny: test harness global bridge
(window as any).__ns = {
	createSync,
	BroadcastChannelTransport,
	lww,
	Engine,
	IndexedDBStore,
	makeScope,
};
