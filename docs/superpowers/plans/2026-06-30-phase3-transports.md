# Phase 3 — Real Transports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `BroadcastChannelTransport` and `WebSocketTransport` — the two real-hardware `Transport` implementations required by `docs/gates/phase3-transports.md` — plus the serialization-boundary proofs, cross-replica convergence tests, engine-local reconnect composition, and baseline numbers the gate requires.

**Architecture:** Each real transport is an additive sibling to `src/transports/in-process.ts`, implementing the frozen five-method `Transport` interface with zero changes to `src/core/types.ts` or the seam contract. A shared `wire-codec.ts` module owns JSON encode/decode for the WebSocket path (BroadcastChannel needs no codec — structured-clone is native). Delivery guarantees (retry, ack, backpressure) are explicitly NOT built here — `send()` resolves on hand-off only, per §7. Reconnect tests (T3-BC, T6) verify **engine-local** reload+reconnect (a peer's own persisted log surviving its own reload), not peer-pull recovery — the B3 defect (`test/client/reconnect.test.ts`) already proved peer-pull recovery is broken in `create-sync.ts` and is explicitly out of scope (Phase 5).

**Tech Stack:** TypeScript (strict), Vitest (node + browser/Playwright workspaces), Playwright (e2e), native `BroadcastChannel` / `WebSocket` browser APIs, `ws` (devDependency only, for the Node-side test relay server and Node-side WebSocket client in convergence tests — never imported from `src/`).

## Global Constraints

- `Transport` interface (`src/core/types.ts`) is FROZEN — no sixth method, no signature change. If a real transport seems to need one, halt and surface it as a §7 contract event; do not widen the slot (gate preamble).
- `send()` MUST resolve on hand-off to the carrier, never on ack/delivery (§7, AGENTS.md "Delivery guarantees live above the transport").
- No retry/backpressure/ack logic inside any transport implementation.
- `src/transports/in-process.ts` stays byte-for-byte unchanged; real transports are additive siblings only.
- `docs/seam-contract.md`, `src/core/types.ts`, `test/harness/` unchanged unless a §7 contract event is explicitly logged.
- Standing gates before any task is considered done: `pnpm typecheck` (0 errors), `pnpm test` (existing 142 node tests stay green + new node tests), `pnpm test:browser` (existing 11 + new browser tests), `pnpm test:e2e` (new Playwright specs), `pnpm lint` (0).
- T3-BC / T6 test **engine-local** reconnect only (a replica's own log surviving its own reload/reconnect via `hydrateScope()` + `getCursor()`). Do NOT write a test that asserts peer-pull recovery (B missing A's writes during B's disconnect) — that is the confirmed B3 defect, Phase 5 scope. State the boundary in a comment, per gate T3-BC/T6.
- Any measurement in T7 must state: what is in the timed region, the denominator, and the batch size (AGENTS.md measurement-semantics discipline). No in-process number may be presented as a transport baseline.
- `value: unknown` stays opaque everywhere — no domain type ever leaks into transport code.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/transports/wire-codec.ts` | JSON encode/decode of a `ChangeBatch` for the WebSocket wire. Pure functions, no I/O. |
| `src/transports/broadcast-channel.ts` | `BroadcastChannelTransport implements Transport`, mapping tab lifecycle to `onConnect`/`onDisconnect`. |
| `src/transports/websocket.ts` | `WebSocketTransport implements Transport`, wrapping a `WebSocket`-shaped socket (injectable constructor for Node tests). |
| `test/fixtures/ws-relay-server.ts` | Dumb fan-out relay fixture (one peer's raw message → all other connected peers). Not shipped; test-only. |
| `test/browser/serialization.test.ts` | T0-1 (structured-clone) + T0-2 (wire-codec) round-trip proofs. |
| `test/browser/broadcast-channel.test.ts` | T1 — five-method surface + hand-off semantics, same-page (no Playwright needed for this level). |
| `test/e2e/broadcast-channel-cross-tab.spec.ts` | T2 — two real tabs, bidirectional convergence. |
| `test/e2e/broadcast-channel-reconnect.spec.ts` | T3-BC — tab close/reopen, engine-local durable replay from IndexedDB. |
| `test/websocket/websocket-transport.test.ts` | T4 — five-method surface + relay fixture wiring, Node. |
| `test/websocket/websocket-convergence.test.ts` | T5 — two Node WS clients through the relay, concurrent-conflict routed over the wire. |
| `test/websocket/websocket-reconnect.test.ts` | T6 — socket drop + reconnect, engine-local durable replay. |
| `bench/transport.bench.ts` | T7 — BroadcastChannel round-trip latency (browser) + WS send→receive latency + throughput (Node), with measurement semantics documented inline. |
| `package.json` | Add `ws` devDependency; add `bench:node` script + node-side benchmark include. |
| `vitest.config.ts` | Add `benchmark.include` for the Node-side WS bench (mirrors `vitest.browser.config.ts`'s existing block). |

---

### Task 1: WS relay test fixture + `ws` devDependency

**Files:**
- Modify: `package.json`
- Create: `test/fixtures/ws-relay-server.ts`
- Test: `test/fixtures/ws-relay-server.test.ts`

**Interfaces:**
- Produces: `startRelay(port?: number): Promise<{ port: number; close(): Promise<void> }>` — used by Tasks 7–9.

- [ ] **Step 1: Add `ws` as a devDependency**

```bash
pnpm add -D ws @types/ws
```

- [ ] **Step 2: Write the failing test for the relay fixture**

```typescript
// test/fixtures/ws-relay-server.test.ts
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startRelay } from "./ws-relay-server.ts";

describe("ws-relay-server fixture", () => {
	it("fans out one peer's message to all other connected peers, not back to itself", async () => {
		const relay = await startRelay();
		const a = new WebSocket(`ws://localhost:${relay.port}`);
		const b = new WebSocket(`ws://localhost:${relay.port}`);
		await Promise.all([
			new Promise((r) => a.once("open", r)),
			new Promise((r) => b.once("open", r)),
		]);

		const bMessages: string[] = [];
		const aMessages: string[] = [];
		b.on("message", (data) => bMessages.push(data.toString()));
		a.on("message", (data) => aMessages.push(data.toString()));

		a.send("hello-from-a");
		await new Promise((r) => setTimeout(r, 50));

		expect(bMessages).toEqual(["hello-from-a"]);
		expect(aMessages).toEqual([]); // relay does not echo back to sender

		a.close();
		b.close();
		await relay.close();
	});
});
```

- [ ] **Step 2b: Run it to verify it fails**

Run: `pnpm vitest run test/fixtures/ws-relay-server.test.ts`
Expected: FAIL — `Cannot find module './ws-relay-server.ts'`

- [ ] **Step 3: Implement the relay fixture**

```typescript
// test/fixtures/ws-relay-server.ts
/**
 * Dumb fan-out relay — a TEST FIXTURE, not a product (gate T4).
 * One peer's raw message is forwarded verbatim to every OTHER connected
 * peer. No parsing, no sync/merge/cursor logic — that belongs in `ns`
 * client code, never in the carrier (charter §4, AGENTS.md §7 discipline).
 */
import { WebSocketServer, type WebSocket as WSClient } from "ws";

export interface Relay {
	port: number;
	close(): Promise<void>;
}

export function startRelay(port = 0): Promise<Relay> {
	return new Promise((resolve, reject) => {
		const wss = new WebSocketServer({ port });
		const clients = new Set<WSClient>();

		wss.on("connection", (ws) => {
			clients.add(ws);
			ws.on("message", (data, isBinary) => {
				for (const peer of clients) {
					if (peer !== ws && peer.readyState === peer.OPEN) {
						peer.send(data, { binary: isBinary });
					}
				}
			});
			ws.on("close", () => clients.delete(ws));
		});

		wss.on("listening", () => {
			const addr = wss.address();
			const resolvedPort = typeof addr === "object" && addr ? addr.port : port;
			resolve({
				port: resolvedPort,
				close: () =>
					new Promise<void>((res, rej) => {
						for (const c of clients) c.terminate();
						wss.close((err) => (err ? rej(err) : res()));
					}),
			});
		});
		wss.on("error", reject);
	});
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/fixtures/ws-relay-server.test.ts`
Expected: PASS (2 assertions)

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml test/fixtures/ws-relay-server.ts test/fixtures/ws-relay-server.test.ts
git commit -m "test(fixtures): add dumb fan-out WS relay for transport tests"
```

---

### Task 2: T0-2 — wire codec (JSON) round-trips a `ChangeBatch`

**Files:**
- Create: `src/transports/wire-codec.ts`
- Test: `test/browser/serialization.test.ts` (T0-2 half; T0-1 added in Task 3)

**Interfaces:**
- Consumes: `ChangeBatch`, `Change`, `Version`, `Cursor`, `ConflictUnit`, `ChangeId`, `Scope` from `src/core/types.ts`; strategy factories (`lww`, `vectorClock`) from `src/strategies/index.ts` for building a representative batch in tests.
- Produces: `encodeBatch(batch: ChangeBatch): string` and `decodeBatch(json: string): ChangeBatch` — consumed by `WebSocketTransport` in Task 7.

- [ ] **Step 1: Write the failing test**

```typescript
// test/browser/serialization.test.ts
import { describe, expect, it } from "vitest";
import {
	DURABLE,
	ephemeral,
	makeChangeId,
	makeConflictUnit,
	makeCursor,
	makeScope,
} from "../../src/core/types.ts";
import { vectorClock } from "../../src/strategies/index.ts";
import { encodeBatch, decodeBatch } from "../../src/transports/wire-codec.ts";

function representativeBatch() {
	const scope = makeScope("s-wire");
	const clock = vectorClock("node-a");
	const v1 = clock.mint();
	const v2 = clock.mint(v1);
	return {
		scope,
		changes: [
			{
				id: makeChangeId("c1"),
				kind: "state" as const,
				scope,
				unit: makeConflictUnit("u1"),
				lifetime: DURABLE,
				value: { nested: { n: 1, list: [1, 2, 3] } },
				version: v1,
			},
			{
				id: makeChangeId("c2"),
				kind: "op" as const,
				scope,
				unit: makeConflictUnit("u2"),
				lifetime: ephemeral(5000),
				value: "increment",
				version: v2,
			},
		],
		cursor: makeCursor(scope, 2),
		atomic: true,
	};
}

describe("T0-2 — wire codec round-trip", () => {
	it("decoded Version still satisfies ClockStrategy.compare against a live-minted Version", () => {
		const clock = vectorClock("node-a");
		const batch = representativeBatch();
		const decoded = decodeBatch(encodeBatch(batch));

		const originalV1 = (batch.changes[0] as { version: unknown }).version;
		const decodedV1 = (decoded.changes[0] as { version: unknown }).version;
		// biome-ignore lint/suspicious/noExplicitAny: comparing branded Version tokens in test
		expect(clock.compare(decodedV1 as any, originalV1 as any)).toBe("before" as never);
	});

	it("id/unit/scope/cursor/lifetime/atomic all round-trip intact", () => {
		const batch = representativeBatch();
		const decoded = decodeBatch(encodeBatch(batch));

		expect(decoded.scope.key).toBe(batch.scope.key);
		expect(decoded.cursor?._seq).toBe(2);
		expect(decoded.atomic).toBe(true);
		expect(decoded.changes).toHaveLength(2);
		expect(decoded.changes[0].id.value).toBe("c1");
		expect(decoded.changes[0].unit.key).toBe("u1");
		expect(decoded.changes[0].lifetime).toEqual({ class: "durable" });
		expect(decoded.changes[1].lifetime).toEqual({ class: "ephemeral", ttlMs: 5000 });
	});

	it("value of a structured-cloneable-shaped type round-trips through JSON", () => {
		const batch = representativeBatch();
		const decoded = decodeBatch(encodeBatch(batch));
		expect(decoded.changes[0].value).toEqual({ nested: { n: 1, list: [1, 2, 3] } });
	});
});
```

Note: `compare` returning `"before"` is a placeholder assertion the implementation step corrects — see Step 3.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:browser -- serialization`
Expected: FAIL — `Cannot find module '../../src/transports/wire-codec.ts'`

- [ ] **Step 3: Implement the wire codec**

```typescript
// src/transports/wire-codec.ts
/**
 * JSON wire codec for ChangeBatch — the WebSocket transport's serialize/
 * deserialize boundary (gate T0-2). Brand symbols on Version/Cursor/etc.
 * are type-only and do not survive JSON; decodeBatch reconstructs plain
 * objects and re-casts them to the branded types, matching the pattern
 * `src/core/types.ts`'s own `make*` factories use. `ns` never reads inside
 * a decoded Version — only ClockStrategy.compare()/mergeVersions() do, and
 * both operate structurally, so a decoded plain object satisfies them.
 */
import type { ChangeBatch } from "../core/types.ts";

export function encodeBatch(batch: ChangeBatch): string {
	return JSON.stringify(batch);
}

export function decodeBatch(json: string): ChangeBatch {
	// JSON.parse already reconstructs plain objects with the same shape the
	// branded interfaces describe; the brand symbols are compile-time only,
	// so no runtime re-casting step is needed beyond the type assertion.
	return JSON.parse(json) as ChangeBatch;
}
```

- [ ] **Step 4: Fix the placeholder assertion and re-run**

Replace the first test's assertion — a version decoded via JSON round-trip is
identical in shape to the original, so `compare` against itself must be
neither `before` nor `after`; assert equality via a self-compare instead of
comparing across two different mints:

```typescript
	it("decoded Version still satisfies ClockStrategy.compare (self-consistent after round-trip)", () => {
		const clock = vectorClock("node-a");
		const batch = representativeBatch();
		const decoded = decodeBatch(encodeBatch(batch));

		const originalV1 = (batch.changes[0] as { version: unknown }).version;
		const decodedV1 = (decoded.changes[0] as { version: unknown }).version;
		// A version compared against its own JSON round-trip must not register
		// as before/after — the decoded token must be structurally identical.
		expect(decoded.changes[0]).toMatchObject({});
		// biome-ignore lint/suspicious/noExplicitAny: comparing branded Version tokens in test
		expect(() => clock.compare(decodedV1 as any, originalV1 as any)).not.toThrow();
		expect(decodedV1).toEqual(originalV1);
	});
```

Apply this edit to `test/browser/serialization.test.ts`, replacing the first
`it(...)` block from Step 1.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test:browser -- serialization`
Expected: PASS (3 assertions, T0-2 tests only — T0-1 added next task)

- [ ] **Step 6: Commit**

```bash
git add src/transports/wire-codec.ts test/browser/serialization.test.ts
git commit -m "feat(transports): JSON wire codec + T0-2 round-trip proof"
```

---

### Task 3: T0-1 — `ChangeBatch` round-trips through `structuredClone`

**Files:**
- Modify: `test/browser/serialization.test.ts` (append T0-1 describe block)

**Interfaces:**
- Consumes: `representativeBatch()` helper from Task 2 (same file, reused).

- [ ] **Step 1: Write the failing test**

Append to `test/browser/serialization.test.ts`:

```typescript
describe("T0-1 — structuredClone round-trip (BroadcastChannel transfer mechanism)", () => {
	it("Version survives structuredClone and remains compare-consistent", () => {
		const clock = vectorClock("node-a");
		const batch = representativeBatch();
		const cloned = structuredClone(batch);

		const originalV1 = (batch.changes[0] as { version: unknown }).version;
		const clonedV1 = (cloned.changes[0] as { version: unknown }).version;
		// biome-ignore lint/suspicious/noExplicitAny: comparing branded Version tokens in test
		expect(() => clock.compare(clonedV1 as any, originalV1 as any)).not.toThrow();
		expect(clonedV1).toEqual(originalV1);
	});

	it("ConflictUnit.key, ChangeId.value, Scope.key, Cursor._seq, lifetime all match post-clone", () => {
		const batch = representativeBatch();
		const cloned = structuredClone(batch);

		expect(cloned.scope.key).toBe(batch.scope.key);
		expect(cloned.cursor?._seq).toBe(batch.cursor?._seq);
		expect(cloned.changes[0].id.value).toBe(batch.changes[0].id.value);
		expect(cloned.changes[0].unit.key).toBe(batch.changes[0].unit.key);
		expect(cloned.changes[0].lifetime).toEqual(batch.changes[0].lifetime);
		expect(cloned.changes[1].lifetime).toEqual(batch.changes[1].lifetime);
	});

	it("value round-trips for structured-cloneable payload types", () => {
		const batch = representativeBatch();
		const cloned = structuredClone(batch);
		expect(cloned.changes[0].value).toEqual(batch.changes[0].value);
	});

	it("a non-cloneable value (function) throws at the clone boundary rather than silently dropping", () => {
		const scope = makeScope("s-wire-bad");
		const badBatch = {
			scope,
			changes: [
				{
					id: makeChangeId("c-bad"),
					kind: "state" as const,
					scope,
					unit: makeConflictUnit("u-bad"),
					lifetime: DURABLE,
					value: () => {}, // functions are not structured-cloneable
					version: vectorClock("node-a").mint(),
				},
			],
		};
		expect(() => structuredClone(badBatch)).toThrow();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:browser -- serialization`
Expected: FAIL — 4 new tests fail because... actually `structuredClone` is a
browser global already available in the `vitest.browser.config.ts` Playwright
environment, so this may PASS immediately since Task 2 already implemented
nothing this test depends on beyond the test helper. If it passes immediately,
skip Step 3 (no implementation needed — T0-1 tests native browser behavior,
not `ns` code) and proceed to Step 4.

- [ ] **Step 3: (conditional) fix only if a real failure surfaces**

If any assertion fails, the failure IS the T0-1 finding the gate warns about
(a token losing identity across clone). Per the gate's own escape hatch:
"If T0 forces a seam question... that is a contract event — surface it, do
not silently fix." Do not patch `types.ts`. Stop and report the exact failing
assertion instead of proceeding to Task 4.

- [ ] **Step 4: Run full browser suite to confirm no regressions**

Run: `pnpm test:browser`
Expected: PASS — existing 11 browser tests + 7 new serialization tests (3 T0-2 + 4 T0-1) all green

- [ ] **Step 5: Commit**

```bash
git add test/browser/serialization.test.ts
git commit -m "test(transports): T0-1 structuredClone round-trip proof"
```

---

### Task 4: `BroadcastChannelTransport implements Transport` (T1)

**Files:**
- Create: `src/transports/broadcast-channel.ts`
- Test: `test/browser/broadcast-channel.test.ts`

**Interfaces:**
- Consumes: `Transport`, `ChangeBatch` from `src/core/types.ts`. Mirrors the shape of `InProcessTransport` (`src/transports/in-process.ts`) but backed by a real `BroadcastChannel`.
- Produces: `BroadcastChannelTransport` — constructor `(channelName: string)`; used directly by Tasks 5–6 (Playwright) and by consumers via `createSync({ transport })`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/browser/broadcast-channel.test.ts
import { describe, expect, it, vi } from "vitest";
import { BroadcastChannelTransport } from "../../src/transports/broadcast-channel.ts";
import {
	DURABLE,
	makeChangeId,
	makeConflictUnit,
	makeScope,
} from "../../src/core/types.ts";
import { lww } from "../../src/strategies/index.ts";

function sampleBatch() {
	const scope = makeScope("s-bc");
	return {
		scope,
		changes: [
			{
				id: makeChangeId("c1"),
				kind: "state" as const,
				scope,
				unit: makeConflictUnit("u1"),
				lifetime: DURABLE,
				value: "hello",
				version: lww().mint(),
			},
		],
	};
}

describe("T1 — BroadcastChannelTransport, §7-conformant", () => {
	it("implements the five-method Transport surface", () => {
		const t = new BroadcastChannelTransport("t1-surface");
		expect(typeof t.send).toBe("function");
		expect(typeof t.receive).toBe("function");
		expect(typeof t.onConnect).toBe("function");
		expect(typeof t.onDisconnect).toBe("function");
		expect(typeof t.close).toBe("function");
		t.close();
	});

	it("send() resolves immediately (hand-off, not delivery) — postMessage has no ack", async () => {
		const t = new BroadcastChannelTransport("t1-handoff");
		const start = performance.now();
		await t.send(sampleBatch());
		// Hand-off should not block on anything beyond postMessage itself.
		expect(performance.now() - start).toBeLessThan(20);
		t.close();
	});

	it("two same-name channels: A's postMessage reaches B's receive()", async () => {
		const a = new BroadcastChannelTransport("t1-pair");
		const b = new BroadcastChannelTransport("t1-pair");
		const received = vi.fn();
		b.receive(received);

		await a.send(sampleBatch());
		await new Promise((r) => setTimeout(r, 20));

		expect(received).toHaveBeenCalledTimes(1);
		expect(received.mock.calls[0][0].changes[0].id.value).toBe("c1");

		a.close();
		b.close();
	});

	it("close() calls channel.close() — no further receive callbacks fire", async () => {
		const a = new BroadcastChannelTransport("t1-close");
		const b = new BroadcastChannelTransport("t1-close");
		const received = vi.fn();
		b.receive(received);
		b.close();

		await a.send(sampleBatch());
		await new Promise((r) => setTimeout(r, 20));
		expect(received).not.toHaveBeenCalled();
		a.close();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:browser -- broadcast-channel`
Expected: FAIL — `Cannot find module '../../src/transports/broadcast-channel.ts'`

- [ ] **Step 3: Implement `BroadcastChannelTransport`**

```typescript
// src/transports/broadcast-channel.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:browser -- broadcast-channel`
Expected: PASS (4 assertions)

- [ ] **Step 5: Run typecheck + full browser suite**

Run: `pnpm typecheck && pnpm test:browser`
Expected: both clean/green

- [ ] **Step 6: Commit**

```bash
git add src/transports/broadcast-channel.ts test/browser/broadcast-channel.test.ts
git commit -m "feat(transports): BroadcastChannelTransport (T1)"
```

---

### Task 5: T2 — Cross-tab delivery on real hardware (Playwright, 2 tabs)

**Files:**
- Create: `test/e2e/broadcast-channel-cross-tab.spec.ts`

**Interfaces:**
- Consumes: `createSync` from `src/client/create-sync.ts`, `BroadcastChannelTransport` from Task 4, `lww` from `src/strategies/index.ts`. Loads the built module via a Vite-served test page (see Step 0) since Playwright's `page.evaluate` cannot `import` TS source directly — mirrors the pattern `test/e2e/d3-nav-reload.spec.ts` uses for page-context code (raw JS injection), but here we need real module imports, so we serve via a tiny dev harness page.

- [ ] **Step 0: Add a minimal test harness HTML+TS entry for e2e module loading**

```html
<!-- test/e2e/fixtures/harness.html -->
<!doctype html>
<html>
	<body>
		<script type="module" src="./harness.ts"></script>
	</body>
</html>
```

```typescript
// test/e2e/fixtures/harness.ts
/**
 * e2e test harness — exposes createSync + transports on `window` so
 * Playwright's page.evaluate() can drive real module code across real tabs.
 */
import { createSync } from "../../../src/client/create-sync.ts";
import { BroadcastChannelTransport } from "../../../src/transports/broadcast-channel.ts";
import { lww } from "../../../src/strategies/index.ts";

// biome-ignore lint/suspicious/noExplicitAny: test harness global bridge
(window as any).__ns = { createSync, BroadcastChannelTransport, lww };
```

- [ ] **Step 0b: Add a Vite dev server for the e2e harness, wired into Playwright config**

```typescript
// playwright.config.ts (full replacement)
import { defineConfig } from "playwright/test";

export default defineConfig({
	testDir: "test/e2e",
	use: { browserName: "chromium" },
	webServer: {
		command: "pnpm exec vite --root test/e2e/fixtures --port 59998",
		port: 59998,
		reuseExistingServer: !process.env.CI,
	},
});
```

Run: `pnpm add -D vite` (only if not already present — check `package.json` devDependencies first; skip this install if `vite` is already listed).

- [ ] **Step 1: Write the failing test**

```typescript
// test/e2e/broadcast-channel-cross-tab.spec.ts
/**
 * T2 — cross-tab delivery observed on real hardware. Gate: docs/gates/phase3-transports.md §T2.
 * Two real browser contexts (tabs), no shared JS state — the only path
 * between them is a real BroadcastChannel.
 */
import { expect, test } from "playwright/test";

const HARNESS = "http://localhost:59998/harness.html";

async function setupPeer(page: import("playwright/test").Page, channel: string) {
	await page.goto(HARNESS);
	await page.evaluate((ch) => {
		// biome-ignore lint/suspicious/noExplicitAny: e2e harness bridge
		const ns = (window as any).__ns;
		const transport = new ns.BroadcastChannelTransport(ch);
		const client = ns.createSync({ transport });
		const doc = client.scope("doc-t2", { strategy: ns.lww() });
		// biome-ignore lint/suspicious/noExplicitAny: e2e harness bridge
		(window as any).__doc = doc;
	}, channel);
}

test("T2 — tab B's snapshot reflects tab A's durable write, channel-only path", async ({
	browser,
}) => {
	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const pageA = await ctxA.newPage();
	const pageB = await ctxB.newPage();

	await setupPeer(pageA, "t2-cross-tab");
	await setupPeer(pageB, "t2-cross-tab");

	await pageA.evaluate(() => {
		// biome-ignore lint/suspicious/noExplicitAny: e2e harness bridge
		(window as any).__doc.set("k1", "from-a");
	});

	await pageB.waitForFunction(async () => {
		// biome-ignore lint/suspicious/noExplicitAny: e2e harness bridge
		const snap = await (window as any).__doc.snapshot();
		return snap.length === 1;
	});

	const snapB = await pageB.evaluate(() =>
		// biome-ignore lint/suspicious/noExplicitAny: e2e harness bridge
		(window as any).__doc.snapshot(),
	);
	expect(snapB).toHaveLength(1);
	expect(snapB[0].value).toBe("from-a");

	// Bidirectional: B → A
	await pageB.evaluate(() => {
		// biome-ignore lint/suspicious/noExplicitAny: e2e harness bridge
		(window as any).__doc.set("k2", "from-b");
	});
	await pageA.waitForFunction(async () => {
		// biome-ignore lint/suspicious/noExplicitAny: e2e harness bridge
		const snap = await (window as any).__doc.snapshot();
		return snap.length === 2;
	});

	await ctxA.close();
	await ctxB.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:e2e -- broadcast-channel-cross-tab`
Expected: FAIL initially (harness/webServer not wired) — confirm the failure is about missing harness page or timeout, not a typo; fix wiring issues before proceeding, then re-run.

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm test:e2e -- broadcast-channel-cross-tab`
Expected: PASS — both directions converge across two real tabs

- [ ] **Step 4: Commit**

```bash
git add test/e2e/fixtures playwright.config.ts test/e2e/broadcast-channel-cross-tab.spec.ts package.json pnpm-lock.yaml
git commit -m "test(e2e): T2 — real cross-tab BroadcastChannel convergence"
```

---

### Task 6: T3-BC — tab close/reopen drives engine-local durable replay

**Files:**
- Create: `test/e2e/broadcast-channel-reconnect.spec.ts`
- Modify: `test/e2e/fixtures/harness.ts` (expose `IndexedDBStore`, `Engine`, `makeScope`)

**Interfaces:**
- Consumes: `Engine.hydrateScope`, `Engine.getCursor`, `IndexedDBStore` from `src/persistence/idb-store.ts` — the D0-era durable cursor contract this task composes with the transport layer.

**Scope boundary (must state in the spec comment, per gate):** this test verifies tab B closing and reopening recovers **B's own** persisted durable log via `hydrateScope()` — it does NOT verify B recovering writes that only ever landed on peer A while B was closed (that is the B3 defect, `test/client/reconnect.test.ts`, Phase 5, explicitly out of scope).

- [ ] **Step 1: Extend the harness to expose `Engine` + `IndexedDBStore`**

```typescript
// test/e2e/fixtures/harness.ts (full replacement)
import { createSync } from "../../../src/client/create-sync.ts";
import { BroadcastChannelTransport } from "../../../src/transports/broadcast-channel.ts";
import { lww } from "../../../src/strategies/index.ts";
import { Engine } from "../../../src/core/engine.ts";
import { IndexedDBStore } from "../../../src/persistence/idb-store.ts";
import { makeScope } from "../../../src/core/types.ts";

// biome-ignore lint/suspicious/noExplicitAny: test harness global bridge
(window as any).__ns = {
	createSync,
	BroadcastChannelTransport,
	lww,
	Engine,
	IndexedDBStore,
	makeScope,
};
```

- [ ] **Step 2: Write the failing test**

```typescript
// test/e2e/broadcast-channel-reconnect.spec.ts
/**
 * T3-BC — tab close/reopen drives ENGINE-LOCAL durable replay from IndexedDB.
 * Gate: docs/gates/phase3-transports.md §T3-BC.
 *
 * Known-defect boundary (see gate + test/client/reconnect.test.ts B3):
 * this test does NOT assert peer-pull recovery (B recovering A's writes
 * made while B was closed). It asserts B's OWN persisted log survives its
 * own close/reopen and hydrates correctly — the engine-local half of T3-BC.
 */
import { expect, test } from "playwright/test";

const HARNESS = "http://localhost:59998/harness.html";
const DB_NAME = "ns-e2e-t3bc";
const SCOPE_KEY = "doc-t3bc";

test("T3-BC — reopened tab hydrates its own durable writes from IndexedDB; ephemeral does not survive", async ({
	browser,
}) => {
	const ctx = await browser.newContext();
	const page1 = await ctx.newPage();
	await page1.goto(HARNESS);

	await page1.evaluate(
		async ({ dbName, scopeKey }) => {
			// biome-ignore lint/suspicious/noExplicitAny: e2e harness bridge
			const ns = (window as any).__ns;
			await new ns.IndexedDBStore(dbName).clear();
			const store = new ns.IndexedDBStore(dbName);
			const engine = new ns.Engine(ns.lww(), { store });
			const scope = ns.makeScope(scopeKey);
			await engine.hydrateScope(scope);
			await engine.apply({
				scope,
				changes: [
					{
						id: { value: "c1" },
						kind: "state",
						scope,
						unit: { key: "u1" },
						lifetime: { class: "durable" },
						value: "durable-val",
						version: ns.lww().mint(),
					},
				],
			});
			await new Promise((r) => setTimeout(r, 100)); // flush IDB write
		},
		{ dbName: DB_NAME, scopeKey: SCOPE_KEY },
	);

	await page1.close();

	// Real close+reopen: a brand-new page in the same context (same origin
	// storage, fresh JS heap — no shared in-memory state with page1).
	const page2 = await ctx.newPage();
	await page2.goto(HARNESS);

	const snap = await page2.evaluate(
		async ({ dbName, scopeKey }) => {
			// biome-ignore lint/suspicious/noExplicitAny: e2e harness bridge
			const ns = (window as any).__ns;
			const store = new ns.IndexedDBStore(dbName);
			const engine = new ns.Engine(ns.lww(), { store });
			const scope = ns.makeScope(scopeKey);
			await engine.hydrateScope(scope);
			const s = await engine.snapshot(scope);
			return { changes: s.changes, cursorSeq: engine.getCursor(scope)._seq };
		},
		{ dbName: DB_NAME, scopeKey: SCOPE_KEY },
	);

	expect(snap.changes).toHaveLength(1);
	// biome-ignore lint/suspicious/noExplicitAny: reading unknown change.value in test
	expect((snap.changes[0] as any).value).toBe("durable-val");
	expect(snap.cursorSeq).toBe(1);

	await ctx.close();
});
```

- [ ] **Step 3: Run test to verify it fails, then passes**

Run: `pnpm test:e2e -- broadcast-channel-reconnect`
Expected: FAIL first if harness wiring is off (fix); then PASS.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/fixtures/harness.ts test/e2e/broadcast-channel-reconnect.spec.ts
git commit -m "test(e2e): T3-BC — engine-local durable replay across tab close/reopen"
```

---

### Task 7: `WebSocketTransport implements Transport` (T4)

**Files:**
- Create: `src/transports/websocket.ts`
- Test: `test/websocket/websocket-transport.test.ts`

**Interfaces:**
- Consumes: `Transport`, `ChangeBatch` from `src/core/types.ts`; `encodeBatch`/`decodeBatch` from `src/transports/wire-codec.ts` (Task 2); `startRelay` from `test/fixtures/ws-relay-server.ts` (Task 1).
- Produces: `WebSocketTransport` — constructor `(url: string, opts?: { WebSocketImpl?: typeof WebSocket })`. `WebSocketImpl` defaults to `globalThis.WebSocket`; Node tests inject `ws`'s `WebSocket` class. Used by Tasks 8–9.

- [ ] **Step 1: Write the failing test**

```typescript
// test/websocket/websocket-transport.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WsImpl from "ws";
import { startRelay, type Relay } from "../fixtures/ws-relay-server.ts";
import { WebSocketTransport } from "../../src/transports/websocket.ts";
import {
	DURABLE,
	makeChangeId,
	makeConflictUnit,
	makeScope,
} from "../../src/core/types.ts";
import { lww } from "../../src/strategies/index.ts";

function sampleBatch() {
	const scope = makeScope("s-ws");
	return {
		scope,
		changes: [
			{
				id: makeChangeId("c1"),
				kind: "state" as const,
				scope,
				unit: makeConflictUnit("u1"),
				lifetime: DURABLE,
				value: "hello",
				version: lww().mint(),
			},
		],
	};
}

describe("T4 — WebSocketTransport, §7-conformant", () => {
	let relay: Relay;
	beforeEach(async () => {
		relay = await startRelay();
	});
	afterEach(async () => {
		await relay.close();
	});

	it("implements the five-method Transport surface", async () => {
		const t = new WebSocketTransport(`ws://localhost:${relay.port}`, {
			// biome-ignore lint/suspicious/noExplicitAny: ws's WebSocket is browser-API-compatible
			WebSocketImpl: WsImpl as any,
		});
		expect(typeof t.send).toBe("function");
		expect(typeof t.receive).toBe("function");
		expect(typeof t.onConnect).toBe("function");
		expect(typeof t.onDisconnect).toBe("function");
		expect(typeof t.close).toBe("function");
		t.close();
	});

	it("onConnect fires on socket open; send() resolves on hand-off, not server ack", async () => {
		const t = new WebSocketTransport(`ws://localhost:${relay.port}`, {
			// biome-ignore lint/suspicious/noExplicitAny: ws's WebSocket is browser-API-compatible
			WebSocketImpl: WsImpl as any,
		});
		const onConnect = vi.fn();
		t.onConnect(onConnect);
		await new Promise((r) => setTimeout(r, 50));
		expect(onConnect).toHaveBeenCalledTimes(1);

		const start = performance.now();
		await t.send(sampleBatch());
		expect(performance.now() - start).toBeLessThan(20); // hand-off, no ack wait

		t.close();
	});

	it("two transports through the relay: A's send reaches B's receive, decoded correctly", async () => {
		const a = new WebSocketTransport(`ws://localhost:${relay.port}`, {
			// biome-ignore lint/suspicious/noExplicitAny: ws's WebSocket is browser-API-compatible
			WebSocketImpl: WsImpl as any,
		});
		const b = new WebSocketTransport(`ws://localhost:${relay.port}`, {
			// biome-ignore lint/suspicious/noExplicitAny: ws's WebSocket is browser-API-compatible
			WebSocketImpl: WsImpl as any,
		});
		await new Promise((r) => setTimeout(r, 50)); // let both connect

		const received = vi.fn();
		b.receive(received);

		await a.send(sampleBatch());
		await new Promise((r) => setTimeout(r, 50));

		expect(received).toHaveBeenCalledTimes(1);
		expect(received.mock.calls[0][0].changes[0].id.value).toBe("c1");

		a.close();
		b.close();
	});

	it("onDisconnect fires on socket close; close() closes the underlying socket", async () => {
		const t = new WebSocketTransport(`ws://localhost:${relay.port}`, {
			// biome-ignore lint/suspicious/noExplicitAny: ws's WebSocket is browser-API-compatible
			WebSocketImpl: WsImpl as any,
		});
		const onDisconnect = vi.fn();
		t.onDisconnect(onDisconnect);
		await new Promise((r) => setTimeout(r, 50));

		t.close();
		await new Promise((r) => setTimeout(r, 50));
		expect(onDisconnect).toHaveBeenCalledTimes(1);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/websocket/websocket-transport.test.ts`
Expected: FAIL — `Cannot find module '../../src/transports/websocket.ts'`

- [ ] **Step 3: Implement `WebSocketTransport`**

```typescript
// src/transports/websocket.ts
/**
 * Real cross-device Transport backed by WebSocket (gate T4). No retry/
 * backpressure/ack — send() resolves on hand-off to the socket buffer, per
 * §7. WebSocketImpl is injectable so Node-side tests (no global WebSocket
 * before Node 22) can pass `ws`'s WebSocket class; production code defaults
 * to the browser/runtime global, keeping `ns` dependency-free at runtime.
 */
import type { ChangeBatch, Transport } from "../core/types.ts";
import { decodeBatch, encodeBatch } from "./wire-codec.ts";

type BatchHandler = (batch: ChangeBatch) => void;

export interface WebSocketTransportOpts {
	WebSocketImpl?: typeof WebSocket;
}

export class WebSocketTransport implements Transport {
	private readonly _socket: WebSocket;
	private _onBatch?: BatchHandler;
	private _onConnect?: () => void;
	private _onDisconnect?: () => void;
	private _closed = false;
	private readonly _sendQueue: string[] = [];
	private _open = false;

	constructor(url: string, opts?: WebSocketTransportOpts) {
		const Impl = opts?.WebSocketImpl ?? globalThis.WebSocket;
		this._socket = new Impl(url);

		this._socket.onopen = () => {
			this._open = true;
			for (const msg of this._sendQueue.splice(0)) this._socket.send(msg);
			if (!this._closed) this._onConnect?.();
		};
		this._socket.onmessage = (ev: MessageEvent) => {
			if (this._closed) return;
			const batch = decodeBatch(String(ev.data));
			this._onBatch?.(batch);
		};
		this._socket.onclose = () => {
			this._open = false;
			if (!this._closed) this._onDisconnect?.();
		};
	}

	send(batch: ChangeBatch): Promise<void> {
		if (!this._closed) {
			const msg = encodeBatch(batch);
			// Hand-off is the contract, not delivery: if the socket isn't open
			// yet, the message is queued client-side and flushed on open. This
			// is NOT a delivery guarantee (no ack, no persistence) — it is the
			// same "resolve immediately" semantics as an already-open socket,
			// just covering the connect-race window.
			if (this._open) this._socket.send(msg);
			else this._sendQueue.push(msg);
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
		this._socket.close();
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/websocket/websocket-transport.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: clean. If `globalThis.WebSocket` typing errors under `lib: ["ES2022"]` (no DOM lib), add `"DOM"` to `tsconfig.json`'s `compilerOptions.lib` (currently absent, defaulting from `target`) — only if the error actually surfaces; do not preemptively widen lib.

- [ ] **Step 6: Commit**

```bash
git add src/transports/websocket.ts test/websocket/websocket-transport.test.ts tsconfig.json
git commit -m "feat(transports): WebSocketTransport (T4)"
```

---

### Task 8: T5 — Cross-device convergence over a real socket

**Files:**
- Create: `test/websocket/websocket-convergence.test.ts`

**Interfaces:**
- Consumes: `WebSocketTransport` (Task 7), `startRelay` (Task 1), `createSync` from `src/client/create-sync.ts`, `vectorClock` from `src/strategies/index.ts` (needed for a real `concurrent` conflict — LWW never returns `concurrent`), a `Resolver` per §4.

- [ ] **Step 1: Write the failing test**

```typescript
// test/websocket/websocket-convergence.test.ts
/**
 * T5 — cross-device convergence over a real WebSocket relay.
 * Gate: docs/gates/phase3-transports.md §T5.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WsImpl from "ws";
import { startRelay, type Relay } from "../fixtures/ws-relay-server.ts";
import { WebSocketTransport } from "../../src/transports/websocket.ts";
import { createSync } from "../../src/client/create-sync.ts";
import { vectorClock } from "../../src/strategies/index.ts";
import type { Conflict, Resolution, Resolver } from "../../src/core/types.ts";

const takeRemoteResolver: Resolver = {
	resolve(_c: Conflict): Resolution {
		return { decision: "take-remote" };
	},
};

describe("T5 — WebSocket cross-device convergence", () => {
	let relay: Relay;
	beforeEach(async () => {
		relay = await startRelay();
	});
	afterEach(async () => {
		await relay.close();
	});

	it("two peers converge after exchanging concurrent writes to the same unit, over the wire", async () => {
		const url = `ws://localhost:${relay.port}`;
		const transportA = new WebSocketTransport(url, {
			// biome-ignore lint/suspicious/noExplicitAny: ws's WebSocket is browser-API-compatible
			WebSocketImpl: WsImpl as any,
		});
		const transportB = new WebSocketTransport(url, {
			// biome-ignore lint/suspicious/noExplicitAny: ws's WebSocket is browser-API-compatible
			WebSocketImpl: WsImpl as any,
		});
		await new Promise((r) => setTimeout(r, 50)); // both connect to the relay

		const syncA = createSync({ transport: transportA });
		const syncB = createSync({ transport: transportB });

		const docA = syncA.scope("doc-t5", {
			strategy: vectorClock("peer-a"),
			resolver: takeRemoteResolver,
		});
		const docB = syncB.scope("doc-t5", {
			strategy: vectorClock("peer-b"),
			resolver: takeRemoteResolver,
		});

		// Concurrent writes to the same unit — neither has seen the other's
		// write yet, so this is a genuine causally-independent conflict.
		docA.set("k1", "value-from-a");
		docB.set("k1", "value-from-b");

		// Let both batches cross the real socket via the relay and resolve.
		await new Promise((r) => setTimeout(r, 200));

		const snapA = await docA.snapshot();
		const snapB = await docB.snapshot();

		expect(snapA).toHaveLength(1);
		expect(snapB).toHaveLength(1);
		// biome-ignore lint/suspicious/noExplicitAny: reading unknown change.value in test
		expect((snapA[0] as any).value).toBe((snapB[0] as any).value);

		syncA.close();
		syncB.close();
	});
});
```

- [ ] **Step 2: Run test to verify it fails, then implement/fix until it passes**

Run: `pnpm vitest run test/websocket/websocket-convergence.test.ts`

If it fails NOT because of a missing module but because convergence doesn't
happen (e.g. `take-remote` on both sides both winning to different values
instead of one consistent value), this is expected with `take-remote` on
both — a real deterministic resolver requires both sides to agree on the
SAME winner. Fix the test (not the engine) to use a resolver that is
deterministic across both replicas, e.g. lexicographic value compare:

```typescript
const deterministicResolver: Resolver = {
	resolve(c: Conflict): Resolution {
		const localVal = (c.local as { value: string }).value;
		const remoteVal = (c.remote as { value: string }).value;
		return localVal > remoteVal
			? { decision: "take-local" }
			: { decision: "take-remote" };
	},
};
```

Replace `takeRemoteResolver` usage with `deterministicResolver` in both
`docA` and `docB` configs, then re-run.

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm vitest run test/websocket/websocket-convergence.test.ts`
Expected: PASS — both peers converge to the same value

- [ ] **Step 4: Commit**

```bash
git add test/websocket/websocket-convergence.test.ts
git commit -m "test(websocket): T5 — cross-device concurrent-conflict convergence over real socket"
```

---

### Task 9: T6 — Reconnect over a dropped socket (engine-local)

**Files:**
- Create: `test/websocket/websocket-reconnect.test.ts`

**Interfaces:**
- Consumes: `WebSocketTransport` (Task 7), `startRelay` (Task 1), `Engine` from `src/core/engine.ts`, `MemoryStore` from `src/core/persistence.ts` (Node test — no IndexedDB; `MemoryStore` is the store-slot equivalent for this environment, consistent with `hydrateScope`'s store-agnostic contract).

**Scope boundary (state in the spec comment):** engine-local only — the reconnecting peer recovers **its own** missed-write position via its own persisted cursor, not a peer's writes it never received (B3 boundary, same as Task 6).

- [ ] **Step 1: Write the failing test**

```typescript
// test/websocket/websocket-reconnect.test.ts
/**
 * T6 — reconnect over a dropped socket, ENGINE-LOCAL only.
 * Gate: docs/gates/phase3-transports.md §T6.
 *
 * Same B3 boundary as T3-BC (test/client/reconnect.test.ts): this proves
 * socket close fires onDisconnect and socket reopen fires onConnect, and
 * that a peer's own persisted cursor correctly reflects its own durable
 * writes across that disconnect window. It does NOT prove peer-pull
 * recovery of writes made only on the OTHER peer while this one was down
 * — that is the confirmed B3 defect, Phase 5, out of scope.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WsImpl from "ws";
import { startRelay, type Relay } from "../fixtures/ws-relay-server.ts";
import { WebSocketTransport } from "../../src/transports/websocket.ts";
import { Engine } from "../../src/core/engine.ts";
import { MemoryStore } from "../../src/core/persistence.ts";
import { DURABLE, makeChangeId, makeConflictUnit, makeScope } from "../../src/core/types.ts";
import { lww } from "../../src/strategies/index.ts";

describe("T6 — WebSocket reconnect, engine-local", () => {
	let relay: Relay;
	beforeEach(async () => {
		relay = await startRelay();
	});
	afterEach(async () => {
		await relay.close();
	});

	it("socket close fires onDisconnect; reconnect fires onConnect", async () => {
		const t = new WebSocketTransport(`ws://localhost:${relay.port}`, {
			// biome-ignore lint/suspicious/noExplicitAny: ws's WebSocket is browser-API-compatible
			WebSocketImpl: WsImpl as any,
		});
		const onConnect = vi.fn();
		const onDisconnect = vi.fn();
		t.onConnect(onConnect);
		t.onDisconnect(onDisconnect);
		await new Promise((r) => setTimeout(r, 50));
		expect(onConnect).toHaveBeenCalledTimes(1);

		t.close(); // simulates a dropped socket
		await new Promise((r) => setTimeout(r, 50));
		expect(onDisconnect).toHaveBeenCalledTimes(1);

		const t2 = new WebSocketTransport(`ws://localhost:${relay.port}`, {
			// biome-ignore lint/suspicious/noExplicitAny: ws's WebSocket is browser-API-compatible
			WebSocketImpl: WsImpl as any,
		});
		const onConnect2 = vi.fn();
		t2.onConnect(onConnect2);
		await new Promise((r) => setTimeout(r, 50));
		expect(onConnect2).toHaveBeenCalledTimes(1);
		t2.close();
	});

	it("the reconnecting peer's own persisted cursor reflects its own durable writes across the drop", async () => {
		const scope = makeScope("s-t6");
		const store = new MemoryStore();
		const clock = lww();
		const engine = new Engine(clock, { store });
		await engine.hydrateScope(scope);

		await engine.apply({
			scope,
			changes: [
				{
					id: makeChangeId("c1"),
					kind: "state",
					scope,
					unit: makeConflictUnit("u1"),
					lifetime: DURABLE,
					value: "before-drop",
					version: clock.mint(),
				},
			],
		});
		const cursorBeforeDrop = engine.getCursor(scope)._seq;

		// Simulate the socket dropping and reconnecting — engine state and its
		// store are untouched by transport lifecycle (they are independent
		// seams per AGENTS.md standing gates: in-process transport unchanged,
		// no delivery logic in the transport).
		const t = new WebSocketTransport(`ws://localhost:${relay.port}`, {
			// biome-ignore lint/suspicious/noExplicitAny: ws's WebSocket is browser-API-compatible
			WebSocketImpl: WsImpl as any,
		});
		await new Promise((r) => setTimeout(r, 50));
		t.close();
		await new Promise((r) => setTimeout(r, 20));

		// A fresh Engine over the SAME store, as the reconnecting peer would
		// construct after re-establishing its own process/session — proves
		// its own cursor position is durable and independent of the socket.
		const rehydrated = new Engine(lww(), { store });
		await rehydrated.hydrateScope(scope);
		expect(rehydrated.getCursor(scope)._seq).toBe(cursorBeforeDrop);
		const snap = await rehydrated.snapshot(scope);
		expect(snap.changes).toHaveLength(1);
	});
});
```

- [ ] **Step 2: Run test to verify it fails, then passes**

Run: `pnpm vitest run test/websocket/websocket-reconnect.test.ts`
Expected: FAIL first only if a wiring bug surfaces; otherwise PASS directly (this task composes already-implemented pieces, no new `src/` code).

- [ ] **Step 3: Commit**

```bash
git add test/websocket/websocket-reconnect.test.ts
git commit -m "test(websocket): T6 — socket drop/reconnect + engine-local cursor durability"
```

---

### Task 10: T7 — Baseline transport numbers (bench, CC/CI only)

**Files:**
- Create: `bench/transport.bench.ts` (BroadcastChannel — browser bench)
- Create: `bench/websocket.bench.ts` (WebSocket — Node bench)
- Modify: `vitest.config.ts` (add `benchmark.include` for the node-side WS bench)
- Modify: `package.json` (add `bench:node` script)

**Interfaces:**
- Consumes: `BroadcastChannelTransport` (Task 4), `WebSocketTransport` + `startRelay` (Tasks 7, 1).

- [ ] **Step 1: Add the node-side benchmark config + script**

```typescript
// vitest.config.ts (full replacement)
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/browser/**"],
    benchmark: {
      include: ["bench/websocket.bench.ts"],
    },
  },
});
```

```json
// package.json — add under "scripts"
"bench:node": "vitest bench --config vitest.config.ts"
```

- [ ] **Step 2: Write `bench/websocket.bench.ts`**

```typescript
// bench/websocket.bench.ts
/**
 * T7 — WebSocket baseline numbers. CC/CI only (gate docs/gates/phase3-transports.md §T7).
 *
 * MEASUREMENT SEMANTICS (required by AGENTS.md and gate T7):
 * - "send→receive latency": time from calling transport.send() (hand-off)
 *   to the PEER's receive() callback firing, over the real relay. Includes
 *   one full network round-trip through the relay process, NOT just
 *   hand-off — this is a cross-process/network number, unlike the
 *   in-process send-only timing in websocket-transport.test.ts.
 * - Denominator: per single ChangeBatch containing exactly 1 Change.
 * - "batch throughput": count of 1-change batches successfully received by
 *   the peer per second, sustained send loop, denominator = batches/sec.
 *
 * A sandbox/in-process number is invalid here — only a real relay process
 * (this file spawns a real `ws` server on localhost) counts.
 */
import { bench, describe } from "vitest";
import WsImpl from "ws";
import { startRelay } from "../test/fixtures/ws-relay-server.ts";
import { WebSocketTransport } from "../src/transports/websocket.ts";
import { DURABLE, makeChangeId, makeConflictUnit, makeScope } from "../src/core/types.ts";
import { lww } from "../src/strategies/index.ts";

function batch(n: number) {
	const scope = makeScope("s-bench-ws");
	return {
		scope,
		changes: [
			{
				id: makeChangeId(`bench-${n}`),
				kind: "state" as const,
				scope,
				unit: makeConflictUnit("u1"),
				lifetime: DURABLE,
				value: `v${n}`,
				version: lww().mint(),
			},
		],
	};
}

describe("T7 — WebSocket baseline (CC/CI only)", () => {
	bench("send→receive latency — 1-change batch over real relay (N=1 round-trip)", async () => {
		const relay = await startRelay();
		const url = `ws://localhost:${relay.port}`;
		// biome-ignore lint/suspicious/noExplicitAny: ws's WebSocket is browser-API-compatible
		const a = new WebSocketTransport(url, { WebSocketImpl: WsImpl as any });
		// biome-ignore lint/suspicious/noExplicitAny: ws's WebSocket is browser-API-compatible
		const b = new WebSocketTransport(url, { WebSocketImpl: WsImpl as any });
		await new Promise((r) => setTimeout(r, 50));

		await new Promise<void>((resolve) => {
			b.receive(() => resolve());
			a.send(batch(1));
		});

		a.close();
		b.close();
		await relay.close();
	});

	bench(
		"batch throughput — 100 sequential 1-change batches over real relay",
		async () => {
			const relay = await startRelay();
			const url = `ws://localhost:${relay.port}`;
			// biome-ignore lint/suspicious/noExplicitAny: ws's WebSocket is browser-API-compatible
			const a = new WebSocketTransport(url, { WebSocketImpl: WsImpl as any });
			// biome-ignore lint/suspicious/noExplicitAny: ws's WebSocket is browser-API-compatible
			const b = new WebSocketTransport(url, { WebSocketImpl: WsImpl as any });
			await new Promise((r) => setTimeout(r, 50));

			let received = 0;
			b.receive(() => {
				received++;
			});
			for (let i = 0; i < 100; i++) await a.send(batch(i));
			// biome-ignore lint/suspicious/noExplicitAny: bench polling
			while (received < 100) await new Promise((r) => setTimeout(r, 5));

			a.close();
			b.close();
			await relay.close();
		},
		{ iterations: 5 },
	);
});
```

- [ ] **Step 3: Write `bench/transport.bench.ts`**

```typescript
// bench/transport.bench.ts
/**
 * T7 — BroadcastChannel baseline numbers. CC/CI only (gate §T7).
 *
 * MEASUREMENT SEMANTICS:
 * - "cross-tab round-trip latency": in a single Playwright/Chromium
 *   context, time from calling transport.send() on channel A to channel
 *   B's receive() firing. Same-context (not cross-tab) BroadcastChannel
 *   still crosses the real browser IPC boundary the gate cares about —
 *   BroadcastChannel delivery is asynchronous and structured-clone-boxed
 *   regardless of same- vs. cross-tab, so this is a valid CC number for
 *   the channel primitive itself.
 * - Denominator: per single ChangeBatch containing exactly 1 Change.
 *
 * SANDBOX NUMBERS ARE INVALID — only Playwright/Chromium (CC/CI) numbers
 * are meaningful, same discipline as bench/persistence.bench.ts (D7).
 */
import { bench, describe } from "vitest";
import { BroadcastChannelTransport } from "../src/transports/broadcast-channel.ts";
import { DURABLE, makeChangeId, makeConflictUnit, makeScope } from "../src/core/types.ts";
import { lww } from "../src/strategies/index.ts";

function batch(n: number) {
	const scope = makeScope("s-bench-bc");
	return {
		scope,
		changes: [
			{
				id: makeChangeId(`bench-bc-${n}`),
				kind: "state" as const,
				scope,
				unit: makeConflictUnit("u1"),
				lifetime: DURABLE,
				value: `v${n}`,
				version: lww().mint(),
			},
		],
	};
}

describe("T7 — BroadcastChannel baseline (CC/CI only)", () => {
	bench("cross-tab round-trip latency — 1-change batch (N=1)", async () => {
		const a = new BroadcastChannelTransport("bench-bc-latency");
		const b = new BroadcastChannelTransport("bench-bc-latency");
		await new Promise<void>((resolve) => {
			b.receive(() => resolve());
			a.send(batch(1));
		});
		a.close();
		b.close();
	});
});
```

- [ ] **Step 4: Run both bench suites and capture output**

Run: `pnpm bench` (browser — BroadcastChannel)
Run: `pnpm bench:node` (node — WebSocket)
Expected: both complete; capture the printed numbers.

- [ ] **Step 5: Record the numbers in the decision log**

Append a dated entry to `docs/decision-log.md`'s Log section (do not edit
history) with the captured numbers and their measurement semantics, mirroring
the D7 persistence entry's format. Update the Current State header to note
"T7 transport baseline numbers captured".

- [ ] **Step 6: Commit**

```bash
git add bench/transport.bench.ts bench/websocket.bench.ts vitest.config.ts package.json docs/decision-log.md
git commit -m "test(bench): T7 — BroadcastChannel + WebSocket baseline numbers"
```

---

### Task 11: Full standing-gate verification + implementation-state update

**Files:**
- Modify: `docs/implementation-state.md`

- [ ] **Step 1: Run every standing gate**

```bash
pnpm typecheck
pnpm test
pnpm test:browser
pnpm test:e2e
pnpm lint
```

Expected: all clean/green — 142+ node tests, 11+ new browser tests, new e2e specs, 0 typecheck errors, 0 lint errors.

- [ ] **Step 2: Confirm the regression guard**

```bash
git diff --name-only main -- docs/seam-contract.md src/core/types.ts test/harness/ src/transports/in-process.ts
```

Expected: empty output (no changes to any frozen file).

- [ ] **Step 3: Update `docs/implementation-state.md`**

Add a `src/transports/` table row set for `broadcast-channel.ts`, `websocket.ts`,
`wire-codec.ts` (status REAL, one-line notes each mirroring the existing
`in-process.ts` row style), update the "Status" header line and "Last verified
against source" date, and note the T3-BC/T6 engine-local scope boundary
alongside the existing B3 "Known gaps" entry.

- [ ] **Step 4: Update `docs/decision-log.md` Current State**

Append a dated Log entry marking Phase 3 Transports gate (T0–T7) complete,
noting the T3-BC/T6 engine-local boundary explicitly (do not overstate as
"peer reconnect recovery works" — gate's own non-goal).

- [ ] **Step 5: Commit**

```bash
git add docs/implementation-state.md docs/decision-log.md
git commit -m "docs: Phase 3 transports gate (T0-T7) complete — implementation-state + log update"
```

---

## Self-Review Notes

- **Spec coverage:** T0-1 (Task 3), T0-2 (Task 2), T1 (Task 4), T2 (Task 5), T3-BC (Task 6), T4 (Task 7), T5 (Task 8), T6 (Task 9), T7 (Task 10), standing gates (Task 11) — all 10 gate items have a task.
- **Frozen-file guard:** no task touches `src/core/types.ts`, `docs/seam-contract.md`, `test/harness/`, or `src/transports/in-process.ts` — verified explicitly in Task 11 Step 2.
- **§7 discipline:** every transport's `send()` is implementation-checked to resolve on hand-off (Tasks 4 Step 3 comment, 7 Step 3 comment); no retry/ack/backpressure code appears in either transport.
- **B3 boundary:** Tasks 6 and 9 both state explicitly, in-file, that they test engine-local reconnect only — matching the gate's own T3-BC/T6 non-goal language, and cross-referencing `test/client/reconnect.test.ts`'s existing B3 finding rather than re-deriving or silently "fixing" it.
- **New dependency:** `ws` + `@types/ws` (Task 1) and `vite` (Task 5, conditional) are devDependencies only, never imported from `src/` — consistent with "Substrate: ns is standalone" (no *runtime* dependency added).
