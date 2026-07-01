# Acceptance Gate: Phase 3 — Transports (real hardware)

> **Gate version**: 0.1 (written before code per AGENTS.md gate discipline).
> **Stream**: Claude Code / CI — **NOT sandbox.** Every item depends on real-platform behavior
> (cross-tab `BroadcastChannel`, a real `WebSocket` server, structured-clone / wire serialization)
> or a measured number. A sandbox `InProcessTransport` proves none of it. Charter §9 test → CC.
> **Predecessor**: HEAD `75cb8c4` on main — 142 node + 11 browser tests green, `tsc --noEmit`
> clean, lint clean. Seam **v1.1** frozen. Phase 3 **persistence** D0–D6 landed (D7 numbers open);
> D0 settled cursor-advancement as **durable-accept, engine-local recovery**.
> **Depends on**: the persistence gate's D0 outcome — the transport reconnect path (`onConnect` →
> replay-from-cursor) is built on that cursor contract. This gate is written after D0 for that reason.
>
> **The frozen contract this gate implements against** (`src/core/types.ts` §Transport, unchanged):
> ```ts
> interface Transport {
>   send(batch: ChangeBatch): Promise<void>;   // resolves on hand-off to carrier, NOT on ack
>   receive(onBatch: (batch: ChangeBatch) => void): void;
>   onConnect(handler: () => void): void;
>   onDisconnect(handler: () => void): void;
>   close(): void;
> }
> ```
> Reference impl: `src/transports/in-process.ts` (Phase 1). Each real transport satisfies the same
> five-method surface. **No seam change.** If a real transport appears to need a sixth method or a
> changed signature, that is a §7 contract event — **halt and surface it**, do not widen the slot.
>
> **Slot discipline (AGENTS.md):** `Transport` is a slot, not an extension point. Delivery
> guarantees (retry, backpressure, ack/redelivery) live **above** the transport on the cursor/replay
> seam (§7) — a real transport MUST NOT implement them internally. `send` resolving on hand-off is
> load-bearing: a transport that awaits ack violates the mandate. This gate builds carriers, not
> delivery guarantees (those are Phase 5).

---

## T0 — Serialization boundary (the real-hardware risk in-process never exercises)

**Why this is first:** `InProcessTransport` passes a `ChangeBatch` by reference — same heap, no
copy. Every real transport crosses a boundary that **serializes**: `BroadcastChannel` structured-
clones; `WebSocket` sends bytes. A `ChangeBatch` carries branded opaque tokens (`Version`,
`ConflictUnit`, `ChangeId`, and — on the batch — a `Cursor`) plus `value: unknown`. These must
round-trip intact or convergence breaks in ways no in-process test can catch. This is the single
biggest thing that "worked in sandbox" will not tell you about hardware.

### T0-1 — `ChangeBatch` round-trips through structured-clone with tokens intact

**Artifact / command**: CC — a browser test cloning a representative `ChangeBatch` (state + op,
durable + ephemeral, with a `Version` and a `ConflictUnit`) via `structuredClone` (the
`BroadcastChannel` transfer mechanism) and asserting equivalence.

**What is verified**: after clone, `ClockStrategy.compare(original.version, cloned.version)` is
consistent (the branded `Version` survives — its internal shape, e.g. `{_vec}` / `{_ts,_node}` /
`{_path}`, is preserved); `ConflictUnit.key`, `ChangeId.value`, `Scope.key`, `Cursor._seq`, and
`lifetime` all match; `value` round-trips for the payload types a consumer will realistically send.

**Failure condition**: any token loses identity across clone (e.g. a class instance flattens to a
plain object and `compare` breaks); `value` of a structured-cloneable type is lost; OR a
non-cloneable `value` fails silently instead of surfacing a clear error at the boundary.

### T0-2 — `WebSocket` wire codec round-trips the same batch

**Artifact / command**: CC — a JSON (or chosen codec) encode/decode of the same `ChangeBatch`,
asserting the same token-intactness as T0-1.

**What is verified**: the wire codec (the WS transport's serialize/deserialize) preserves every
token and reconstructs branded types such that `compare`, dedup-by-`id`, and unit-equality all
still hold on the far side. If the codec is JSON, brand symbols (type-only) don't serialize — the
test proves the reconstructed plain objects still satisfy the strategy's `compare` contract.

**Failure condition**: a decoded `Version` is not accepted by `compare`; `id`/`unit` equality
breaks post-decode; OR the codec drops `cursor`/`atomic`/`lifetime`.

> **If T0 forces a seam question** — e.g. tokens need an explicit serialize hook to survive a wire
> boundary — that is a contract event, not an in-stream fix. Surface it. (Likely resolvable inside
> the transport as an encode/decode detail without touching the seam, but do not assume.)

---

## Real `BroadcastChannel` transport (cross-tab)

### T1 — `BroadcastChannelTransport implements Transport`, §7-conformant

**Artifact / command**: CC — `src/transports/broadcast-channel.ts`; `pnpm typecheck` clean.

**What is verified**: implements the five-method surface; `send` calls `channel.postMessage(batch)`
and resolves **immediately** (hand-off, not delivery — BroadcastChannel has no ack anyway);
`receive` wires `channel.onmessage → onBatch`; `close` calls `channel.close()`. No retry/backpressure
inside the transport.

**Failure condition**: `send` awaits anything post-`postMessage`; delivery-guarantee logic present
in the transport; OR the five-method surface not satisfied.

### T2 — Cross-tab delivery observed on real hardware (≥2 tabs)

**Artifact / command**: CC — Playwright, two real browser contexts/tabs sharing an origin.

**Replica count**: 2 (two tabs = two engines on one `BroadcastChannel`).

**Divergence driver**: tab A applies a durable state change; the client relays it via
`BroadcastChannel.postMessage`; tab B's engine receives and applies.

**Reconciled assertion**: tab B's `snapshot(scope)` reflects A's change **without any shared
in-memory state** — the only path between them is the real BroadcastChannel. Bidirectional: a
change in B reaches A. This is the "real cross-tab sync works" proof; it cannot pass in-process.

**Failure condition**: B does not receive A's change; OR the test accidentally shares state
(e.g. same JS context) and so doesn't actually exercise the channel.

### T3-BC — Tab close / reopen drives the T3 reconnect fork

**Artifact / command**: CC — Playwright, close tab B, land durable changes in A, reopen B.

**Replica count**: 2

**What is verified**: BroadcastChannel has no built-in connect/disconnect, so the transport must
map tab lifecycle (`pagehide`/`pageshow`, or channel construction/teardown) onto `onConnect`/
`onDisconnect`. On reopen, the client's **durable** reconnect fork replays from the persisted cursor
(the D0 durable-accept cursor + persistence gate D3/D4 hydration); **ephemeral** state comes from
snapshot, not replay (T3). Confirms the persistence and transport layers compose.

> **Known-defect boundary:** the B3 reconnect-replay defect (self-republish, never pulls a peer's
> log) is **Phase 5** and NOT in scope. T3-BC verifies the *engine-local* reload+reconnect
> composition (B reopens and hydrates its own persisted log), NOT peer-pull recovery. State this in
> the test so "reconnect works" is not over-read. If T3-BC cannot pass without peer-pull, that is
> the B3 defect resurfacing — surface it, do not paper over it.

**Failure condition**: reopened tab replays from log start (persistence cursor not used); an
ephemeral value survives as if replayed; OR the test silently relies on peer-pull (out of scope).

---

## Real `WebSocket` transport (cross-device)

### T4 — `WebSocketTransport implements Transport`, §7-conformant; a minimal echo/relay server

**Artifact / command**: CC — `src/transports/websocket.ts` + a test relay server (fixture, not a
product); `pnpm typecheck` clean.

**What is verified**: five-method surface; `send` writes to the socket and resolves on hand-off
(NOT on server ack — the socket buffer is the carrier); `receive` wires `socket.onmessage`;
`onConnect`/`onDisconnect` map to real socket `open`/`close` events; `close` closes the socket.
The relay server is a dumb fan-out fixture (one peer's batch → other peers), NOT an `ns` server —
`ns` is client-side; the server is one peer behind the transport (charter §4).

**Failure condition**: `send` awaits a server ack; the server contains sync/merge/cursor logic
(that belongs in `ns`, not the carrier); OR socket lifecycle not mapped to connect/disconnect.

### T5 — Cross-device (cross-context) convergence over a real socket

**Artifact / command**: CC — two engines in two separate browser contexts (or a browser + a node
client) connected only through the WS relay.

**Replica count**: 2

**Divergence driver**: both apply concurrent changes to the same unit; batches cross the real
socket via the relay; a deterministic resolver (per §5) converges them.

**Reconciled assertion**: after exchange + drain, both peers hold the same converged state for the
unit, with the **only** inter-peer path being the WebSocket. Includes at least one `concurrent`
conflict routed through the resolver end-to-end over the wire (proves T0-2's codec preserves the
`Version` well enough for real conflict detection across the boundary).

**Failure condition**: peers diverge; conflict not detected across the wire (a T0-2 codec leak);
OR convergence depends on shared memory rather than the socket.

### T6 — Reconnect over a dropped socket

**Artifact / command**: CC — kill the socket mid-session, land changes on the peer, reconnect.

**Replica count**: 2

**What is verified**: socket `close` fires `onDisconnect`; on reconnect, `onConnect` drives the
durable replay-from-cursor fork; the reconnecting peer recovers **its own** missed-write position
via the persisted cursor. Same Phase-5 boundary as T3-BC: **engine-local** reconnect only;
peer-pull recovery is the B3 defect, out of scope. State it.

**Failure condition**: reconnect replays from log start; ephemeral treated as durable; OR the test
requires peer-pull (B3, out of scope) to pass.

---

## Measurement (numbers — CC/CI only)

### T7 — Baseline transport numbers, with measurement semantics stated

**Artifact / command**: CC/CI — `bench/` addition; numbers in the decision-log or a bench report.

**What is verified**: first real transport numbers — cross-tab `BroadcastChannel` round-trip
latency; WS send→receive latency over the relay; batch throughput (batches/sec) at a stated batch
size. Per AGENTS.md measurement-semantics discipline: state **what is in the timed region**
(hand-off only, or hand-off→remote-apply?), **the denominator**, and the batch size. A sandbox
number is noise; these are CC/CI only.

**Failure condition**: a number reported without its measurement semantics; OR an in-process number
presented as a transport baseline.

---

## Two standing gates (every item)

- `pnpm typecheck` (0) · `pnpm test` node (142 existing stay green) · `pnpm test:browser` +
  `pnpm test:e2e` (new transport tests) · `pnpm lint` (0).
- **Regression guard**: `docs/seam-contract.md`, `src/core/types.ts`, `test/harness/` unchanged
  (`git diff --name-only` shows none) unless a §7 contract event was explicitly surfaced and logged.
- **In-process transport unchanged**: `src/transports/in-process.ts` is the frozen reference; real
  transports are additive siblings, not edits to it.

---

## Explicit non-goals (carried forward, NOT closed here)

- **Peer-recovery / pull-based catch-up** (B3 defect second half) → Phase 5. T3-BC/T6 verify
  engine-local reconnect only. A landing that claimed "peer reconnect recovery works" would be false.
- **`transport.send` retry / backpressure / ack** → Phase 5. `send` stays hand-off-only.
- **WebRTC / http-poll transports** → later (BroadcastChannel + WebSocket are the two this gate
  requires; others are additive siblings under the same §7 contract).
- **A production relay server** → out of scope; the T4 server is a dumb test fixture.

---

## Summary table (AGENTS.md requirement)

| Item | Replicas | Driver | Reconciled assertion |
|---|---|---|---|
| T0-1 | — | structured-clone a batch | tokens intact; `compare` consistent post-clone |
| T0-2 | — | wire-codec a batch | decoded `Version`/`id`/`unit` still satisfy contract |
| T1 | — | — | `BroadcastChannelTransport` §7-conformant; typecheck clean |
| T2 | 2 tabs | A writes; relay via BC | B's snapshot reflects A, channel-only path |
| T3-BC | 2 | close/reopen tab | reopened tab hydrates from persisted cursor; ephemeral not replayed |
| T4 | — | — | `WebSocketTransport` §7-conformant; relay is dumb fan-out |
| T5 | 2 | concurrent writes over socket | both converge; a `concurrent` conflict routed over the wire |
| T6 | 2 | drop + reconnect socket | onConnect drives durable replay; engine-local only |
| T7 | — | bench | BC/WS latency + throughput + measurement semantics (CC/CI) |
| std | — | — | typecheck/test/lint 0; seam+harness+in-process unchanged |
