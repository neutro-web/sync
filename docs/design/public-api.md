# Design — G2 Public API Surface

> **Status:** Design doc backing the dated decision-log entry of the same date. Draft for `docs/design/public-api.md`.
> **Stream:** Architect (design-only). No engine/strategy/transport/adapter code emitted here.
> **Scope:** Freezes the **plain-TS consumer-facing surface** over the frozen seam (v1.1). Pure-additive — no seam change, no T1–T5 change.
> **Verified against source** at HEAD `950d6d1`: `Engine(clock, resolver?)` is single-clock/single-resolver per engine; engine is transport-unaware; `resolveConflict`/`getCursor` are non-interface methods; `ResolverPump` is a standalone per-scope bridge.

---

## 0. The gap, precisely

A consumer today wires the stack by hand (verified in `test/engine/engine.test.ts`):

```ts
const engine = new Engine(new LWWClockStrategy());     // one clock for the whole engine
const v = clock.mint();                                 // consumer mints the Version
await engine.apply({ scope, changes: [{                 // consumer hand-builds the Change
  id: makeChangeId("..."), scope, unit, lifetime: DURABLE, kind: "state", value, version: v,
}]});
// transport: caller manually bridges Transport.receive -> engine.apply and onBatch -> Transport.send
// conflicts: caller manually constructs a ResolverPump per scope
```

Four leaks the public API must seal: (1) `ClockStrategy.mint()` in consumer code, (2) hand-built `Change` with `id`/`unit`/`version`/`lifetime` ceremony, (3) manual transport bridging, (4) manual `ResolverPump` lifecycle. Plus one structural gap: **the engine takes one clock, but §9 requires per-scope strategy** (CRDT scope beside LWW scope in one app).

---

## 1. Q-B first — per-scope config (the load-bearing question)

This is worked first because it is the only question that *could* reach into the engine and turn G2 from additive into a runtime sub-gate.

**Fact (verified):** `Engine` holds exactly one `_clock` and one optional `_resolver`. No per-scope strategy slot exists.

**Requirement (seam §9):** different `{ ClockStrategy, Resolver, Lifetime-default }` per scope, in one application.

Three ways to close the gap:

| Option | Mechanism | Engine change? | Verdict |
|---|---|---|---|
| **B1 — client multiplexes N engines** | client holds `Map<scopeKey, Engine>`; each scope routed to an engine built with its config | **none** | **chosen** |
| B2 — engine per-scope registration | `engine.registerScope(scope, {strategy, resolver})`; one engine, internal `Map<scopeKey, clock>` | **yes — runtime sub-gate** | rejected for G2 |
| B3 — strategy passed per `apply` | `apply` takes a strategy arg | yes + leaks `ClockStrategy` into write path | rejected (violates pre-commitment) |

**Steelman B2 (the tempting one):** "One engine is conceptually cleaner; N engines duplicate per-scope maps." True, but the duplication is illusory — `Engine` already partitions *all* state per scope (`_scopes: Map<scopeKey, ScopeState>`). A second scope in one engine and a second engine each allocate exactly one `ScopeState`. **There is no shared state between two scopes to amortize**, because **T5 forbids cross-scope coordination by contract.** So B2 buys conceptual tidiness at the cost of an engine change (a runtime sub-gate, a contract-adjacent risk) and buys *nothing* in return — no shared structure, no cross-scope operation, because none is permitted to exist.

**The leak in B2 that kills it:** to register per-scope clocks, the engine's `_applyState` must look up the clock by scope on every apply (it currently closes over one `_clock`). That is a hot-path change to the most performance-sensitive method in the system, to support a capability the client can provide for free by routing. Performance is ns's #1 priority; spending a hot-path indirection to avoid a client-side map is the wrong trade.

**B1 chosen. G2 is pure-additive. No runtime sub-gate spawned.**

Consequence to state plainly: a "client" is a thin multiplexer — a `Map<scopeKey, { engine, clock, lifetimeDefault, transportBinding, cursor }>` plus the transport fan-in/out wiring. It owns no sync logic; every sync decision still happens inside an `Engine`.

> **One honest cost of B1.** A single `Transport` instance feeding multiple scopes must demultiplex inbound batches to the right per-scope engine by `batch.scope.key`. That routing lives in the client. It is trivial (a map lookup) and transport-type-agnostic, but it is a real line of responsibility — named here so it is not discovered as a surprise in implementation. See §6 (Q-E).

---

## 2. Q-A — client shape

**Chosen: `createSync(config)` factory returning a client; `client.scope(key, scopeConfig)` returns a chainable scope handle.**

```ts
const sync = createSync({ transport });                       // client
const presence = sync.scope("room:42", {                      // scope handle
  strategy: lww(),
  lifetime: ephemeral(5_000),
});
```

**Steelman the alternatives:**

- **Builder (`new Sync().scope(...).scope(...).build()`)** — reads well for a fixed upfront scope set, but scopes in real consumers are *dynamic* (a doc opened at runtime, a presence room joined on demand). A terminal `.build()` fights dynamic registration; you'd end up calling `.scope()` post-build anyway, so the builder ceremony is dead weight. Rejected.
- **Config-object factory (all scopes declared upfront in `createSync({ scopes: {...} })`)** — forces every scope known at construction. Same dynamic-scope problem; a rich-text app opens documents the client didn't know about at boot. Rejected as the *primary* form, but **allowed as sugar**: `createSync({ transport, scopes })` may pre-register, equivalent to calling `.scope()` for each.

**Why factory + handle wins on ergonomics:** the scope handle is the unit the consumer actually holds and reuses (`presence.set(...)`, `doc.subscribe(...)`). Binding config at `scope()` time and handing back a reusable object means per-write code never re-states the scope, the strategy, or the lifetime. The handle *is* the ergonomic payoff.

**Idempotent re-`scope()`:** calling `sync.scope(key)` twice with the same key returns the **same handle** (cached). Calling it with a *different* config for an existing key throws — silent reconfiguration is a footgun. First call configures; later calls with no config fetch; later calls with conflicting config fail loud.

---

## 3. Q-C — the emit/write surface (perf-first, verified hot path)

**Chosen: verb-per-kind on the bound handle — `set(unit, value, opts?)` for state, `do(unit, value, opts?)` for op.**

```ts
presence.set("cursor-pos", { x: 10, y: 20 });   // state change
queue.do("send-email", { to: "..." });          // op change
```

**Performance grounding (this is why, not decoration).** The verified per-write cost when hand-wiring is: `clock.mint()` + one `Change` object literal + `engine.apply()`. The chosen surface adds **exactly one function-call frame** over that and **zero extra allocation** — the handle is allocated once at `scope()` time and its methods close over `{ engine, clock, scope, lifetimeDefault }`; per write it mints, builds one `Change`, calls `apply`. This is the cheapest possible surface that still hides `Version`/`ClockStrategy`.

Two surfaces were rejected on cost:

- **Per-write builder (`presence.write(unit).value(v).durable().commit()`)** — allocates a builder object per write. In a presence/cursor-stream scope that is the hottest path in the system. Rejected: allocation in the hot path violates the charter's "no allocation in hot apply path beyond the change objects themselves."
- **Single `emit(unit, value, { kind })`** — forces an options-object read and a `kind` branch *per write* at runtime. `set`/`do` resolve the kind at the call site, statically. The cost delta is micro, but it is strictly ≥0 and the verb form also reads better. No reason to pay it.

**Defaults attach to the scope, supplied per-write only to override:**

```ts
interface WriteOpts {
  lifetime?: Lifetime;   // defaults to the scope's lifetime (DURABLE if unset)
  unitKey?: string;      // when the unit key differs from a derived default
}
```

`kind` is **not** in `WriteOpts` — it is the method (`set` = state, `do` = op). This makes the heterogeneous-batch reality of T1 read naturally at the call site: a form does `field.set(...)` for edits and `field.do("submit", ...)` for the submit, in the same scope, and the kind is obvious from the verb.

**`unit` ergonomics.** The first arg *is* the unit key (a string); the handle wraps it via `makeConflictUnit` internally. The consumer never imports `makeConflictUnit` or touches `ConflictUnit`. `unitKey` in opts exists only for the rare case where the addressing key and a derived default diverge — most consumers never use it.

**`version` is fully hidden.** `set` calls `clock.mint(prev?)` internally. The `prev` is the scope's last-minted version for that unit (the handle tracks it), giving a correct Lamport/vector advance without the consumer ever seeing a `Version`. **Confirmed: no `Version` in any consumer-facing signature.**

**Return type.** `set`/`do` return `void` (fire-and-forget at the call site; `apply` is synchronous-internally and resolves immediately). They do **not** return a Promise the consumer must await — awaiting a local write would imply the write blocks on something, contradicting the mandate ("local progress never blocks on the channel"). Local write is synchronous-visible; propagation is off the critical path. *(If a future persistence layer makes the local commit async, this returns a `Promise<void>` whose resolution means "durably logged locally," still never "acked by a peer." Flagged for Phase 5, not decided here.)*

---

## 4. Q-D — subscription + conflict ergonomics

**Subscription:**

```ts
const sub = doc.subscribe((changes) => { /* apply to local view */ });
sub.unsubscribe();
```

The public handler is `onBatch(changes: readonly Change[])` — **the changes array, not the `ChangeBatch`.** The consumer never sees `batch.cursor` (engine-local, opaque per T2/§2). The client strips the cursor and tracks it internally for the T3 reconnect fork. This is the "adapter holds no `Cursor`" pre-commitment enforced at the API boundary.

**Conflict handling — auto-on default (decided).**

```ts
// Auto-resolution (default when a resolver is configured for the scope):
// Each replica must pass a unique nodeId to vectorClock().
const doc = sync.scope("doc:1", { strategy: vectorClock("node-a"), resolver: pickByIdResolver });
// → client auto-creates a ResolverPump for this scope. Conflicts resolve per the resolver.

// Manual hold (opt-out):
const doc = sync.scope("doc:1", { strategy: vectorClock("node-a"), resolver: r, manual: true });
doc.onConflict((conflict, resolve) => {        // sanctioned narrow hook
  // inspect, then:
  resolve({ decision: "take-remote" });        // wraps engine.resolveConflict internally
});
```

**Why auto-on is the correct default, not just convenient.** The seam contract §5 requires that a local resolver be a **deterministic pure function** for convergence. A resolver that is configured but *not run* (because the consumer forgot to wire the pump) produces **silent divergence** — exactly the failure mode the contract works hardest to prevent. Making "resolver present ⇒ it runs" the default converts a silent footgun into the obvious behavior. Opt-out (`manual: true`) is for the genuine "surface to a human" case (`defer`-style UX), where the consumer *intends* to hold conflicts open. That intent is explicit, so it should be the explicit path.

**The manual hook is the only sanctioned public exposure of `resolveConflict`.** `resolve(...)` in the `onConflict` callback wraps `engine.resolveConflict(scope, unit, resolution)`, with `scope`/`unit` captured from the conflict — the consumer never constructs them. Raw `engine.resolveConflict` stays internal (§5/Q-F).

**`defer` from a manual hook** leaves the conflict open (engine no-op) — correct; the consumer is choosing to hold it. A later `resolve(...)` call on the same unit lands the winner.

---

## 5. Q-E — transport attachment + T3 reconnect

**Attached once, at the client:**

```ts
const sync = createSync({ transport });
```

The client owns the full transport bridge so no scope handle and no consumer code touches `Transport`:

- **Outbound:** the client subscribes to each scope's engine `onBatch` and calls `transport.send(batch)`. (The full `ChangeBatch`, *with* cursor, crosses the wire — peers need it; only the *consumer* is shielded from the cursor.)
- **Inbound:** the client registers `transport.receive(batch => engine[batch.scope.key].apply(batch))` — the demultiplex named in §1.
- **T3 reconnect fork (client-driven, since the engine is transport-unaware):**
  - `transport.onConnect(() => …)` — for each **durable** scope, the client calls `engine.changes(scope, lastCursor)` and re-applies (replay-from-cursor); for each **ephemeral** scope, it calls `engine.snapshot(scope)` and re-sends current state (snapshot-of-current). This is the T3 fork, placed in the client because the engine has no transport awareness (verified).
  - The client tracks `lastCursor` per durable scope from the stripped `onBatch` cursors. **The consumer never sees it.**

**Confirmed: no `Cursor` reaches the consumer through any path** — not via subscribe (stripped), not via write (never produced consumer-side), not via reconnect (client-internal).

**Lifecycle:** `sync.close()` closes the transport and unsubscribes every scope's pump and subscriptions. `handle.close()` tears down a single scope.

---

## 6. Q-F — the internal/public boundary (explicit)

The public API is a **narrowing** over the engine, not a re-export.

| Surface | Public? | Why |
|---|---|---|
| `createSync(config)` | **public** | the entry point |
| `client.scope(key, config)` | **public** | scope handle factory |
| `handle.set/do(unit, value, opts?)` | **public** | the write surface (Q-C) |
| `handle.subscribe(onBatch)` | **public** | the three-primitive seam |
| `handle.snapshot()` | **public** | returns `Promise<readonly Change[]>`, no cursor |
| `handle.onConflict((c, resolve)=>…)` | **public** (manual mode only) | sanctioned narrow conflict hook |
| `handle.close()` / `client.close()` | **public** | lifecycle |
| `Engine` ctor | internal | client constructs it |
| `engine.apply(batch)` w/ hand-built `Change` | internal | `set`/`do` replace it |
| `engine.changes(scope, cursor)` | internal | reconnect machinery |
| `engine.getCursor` | internal | engine-local ordinal, never consumer-facing |
| `engine.resolveConflict` | internal | exposed only via the wrapped `resolve` in `onConflict` |
| `ResolverPump` | internal | client auto-creates it |
| `makeChangeId`/`makeConflictUnit`/`makeCursor`/`mint` | internal | hidden by the handle |

Factory-strategy helpers (`lww()`, `vectorClock()`) **are** public — they are how a consumer names a strategy without `new LWWClockStrategy()`. Thin wrappers; ship in `@neutro/sync/strategies`.

---

## 7. Worked proof — two §9 consumers in one client, zero per-consumer code

The generalization test: an LWW ephemeral presence scope beside a vector-clock durable collaborative scope, in one client, expressed only in public API.

```ts
import { createSync } from "@neutro/sync";
import { lww, vectorClock } from "@neutro/sync/strategies";
import { InProcessTransport } from "@neutro/sync/transports";

const [a] = InProcessTransport.pair();
const sync = createSync({ transport: a });

// --- presence: ephemeral state, LWW, take-remote (auto, no conflicts ever) ---
const presence = sync.scope("room:42/presence", {
  strategy: lww(),
  lifetime: ephemeral(5_000),
});
presence.subscribe((changes) => renderCursors(changes));
presence.set("user:alice", { x: 10, y: 20 });   // ephemeral; never advances cursor; never persisted

// --- collaborative doc: durable state, vector clock, merge resolver (auto) ---
// Each replica must pass a unique nodeId to vectorClock().
const doc = sync.scope("doc:99", {
  strategy: vectorClock("node-a"),
  resolver: mergeResolver,        // deterministic pure fn (§5) → auto-pump on
  // lifetime defaults to DURABLE
});
doc.subscribe((changes) => applyToDoc(changes));
doc.set("para:7", { text: "hello" });            // durable; advances cursor; vector-clock versioned

// --- queue: durable op, dedup-by-id, no version, no resolver ---
const queue = sync.scope("outbox", { strategy: lww() /* unused for pure ops */ });
queue.do("cmd:send-123", { to: "bob@x.com" });   // op; dedup-by-id; no conflict path
```

**What this proves:**

- **One client, three scopes, three different `{strategy, resolver, lifetime}` triples** — B1's multiplexing delivers per-scope config with no engine change.
- **No consumer code constructs a `Change`, mints a `Version`, touches a `Cursor`, or wires a `ResolverPump`.** All four leaks sealed.
- **The heterogeneous-kind reality (T1) reads naturally:** `set` for state, `do` for op, chosen by verb at the call site.
- **Auto-resolution is invisible when correct** (presence/doc) and explicit only when the consumer wants to hold conflicts open (`manual: true`, not shown — the common path is auto).
- **Zero per-consumer branching in the API.** A reactive database, a form, rich-text would each be more `scope()` calls with their own triples — the §9 table is just a list of constructor arguments.

**The leak hunt (BCon: steelman then find the leak).** Where could a domain type or an internal token escape?

1. *Does `subscribe`'s `changes` array leak `version`?* Yes — a `StateChange` carries `.version`. But `Version` is opaque (branded, no readable fields); the consumer receives it and **ignores it** — it's along for the ride to feed back into nothing. Acceptable: opacity holds; the consumer *can't* misuse it. *Could* we strip it? Only by cloning every change on every subscribe fire — an allocation in the read hot path. Rejected; the branded-opacity guarantee already prevents misuse. **This is the one place an internal token is visible to the consumer; it is inert by construction.**
2. *Does the manual `onConflict` hook leak `Conflict.local.version`?* Same answer — visible, opaque, inert. The consumer inspects `.value` (its own domain type, which it cast in), never `.version`.
3. *Does reconnect leak a cursor?* No — client-internal (§5).

The residual (versions visible-but-inert in the changes stream) is a deliberate, grounded trade: zero-copy reads over perfect hiding, where opacity already neutralizes the exposure. Named so it is a decision, not an accident.

---

## 8. Open sub-questions handed downstream (not blocking the freeze)

- **Async local write** (if Phase 5 persistence makes local commit async) → `set`/`do` return type revisited. Not now.
- **Backpressure on `transport.send`** → delivery-above-transport (§7), Phase 5. The client's outbound `onBatch→send` is where a future send-queue lands; the surface doesn't change.
- **`_applyOp` concurrent path** → still deferred (independent Phase 3 runtime sub-gate). `do` on a versioned op that goes concurrent inherits whatever that gate decides; the *public surface* (`do`) is unchanged regardless. **Known Phase 3 gap:** Concurrent versioned ops are held silently by the engine (no Conflict surfaced). The state path is fully T4-compliant. Versioned-op conflict routing is Phase 3.
- **Multi-transport** (different transports per scope) → B1 already permits it structurally (binding is per-scope-engine); the config surface would gain a per-scope `transport?` override. Sketch only; defer until a consumer needs it.
