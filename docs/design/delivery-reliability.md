# Delivery Reliability Above the Transport (Phase 5)

> **Status:** Design doc. Architect pass @ HEAD `e17ce81`. Resolves the delivery-reliability
> gap that blocks robust end-to-end consumer integration (nf spike Finding 2) and the B3
> peer-recovery defect. **No code lands from this doc** — implementation is CC.
>
> **Scope:** delivery reliability only (confirmed-delivery cursor, retry/re-drive seam,
> peer-pull recovery). Out of scope, tracked elsewhere: open-conflicts-not-persisted,
> `closedKeys` growth, conformance/LCD-risk proof.
>
> **Contract posture:** the primary mechanism (§4, option 2) is **additive over seam v1.1** —
> no `Transport` method, no `Cursor` shape/semantics change, no new wire type. The optimal
> mechanism (option 3) requires a **v1.1 → v1.2** delta and is deferred behind a gate (§6).

---

## 1. The gap, grounded

§7 has always said delivery guarantees (retry, ack, backpressure, redelivery) live **above**
the transport, on the cursor/replay seam — `Transport.send` resolves on hand-off, not ack.
Nothing implements that layer. Three verified facts define the gap (all confirmed against
source/execution at `e17ce81`, not asserted):

**F1 — B3: the current reconnect path cannot recover a peer's missed writes.**
`create-sync.ts`'s `transport.onConnect()` durable branch calls
`engine.changes(scope, entry.lastCursor)`. `entry.lastCursor` is advanced in the `onBatch`
callback (`create-sync.ts:185`), which fires synchronously inside `engine.apply()` for **every**
accepted durable change — local writes *and* remote-received ones. So at the moment `onConnect`
fires, `lastCursor` always equals the engine's cursor tip → `changes()` yields nothing.
Separately, the mechanism only re-publishes **this** engine's own log; it has no path to pull a
**peer's** log. (Source-confirmed; characterized green as a tripwire in
`test/client/reconnect.test.ts`.)

**F2 — nf Finding 2: the consumer currently carries all delivery reliability.**
`ns` has no retry/redelivery. A durable write dropped by the channel is lost permanently;
draining longer cannot recover it (buffering ≠ redelivery). The nf spike converged only when
the consumer re-drove each write until observed. This is F1's consumer-facing symptom.

**F3 — a single engine-local cursor cannot express cross-peer "what am I missing."**
`Cursor._seq` is an engine-local ordinal (engine.ts explicit invariant: *"A cursor from one
engine is NOT safe to use as input to another engine's `changes()`."*). `changes(scope, since)`
filters **only** by `seq > since._seq` (no per-unit/version filter). Spike-verified: two engines
that accept the same logical changes in different orders assign different seqs; a peer pulling
with its **own** cursor from a **peer's** log gets the wrong set (re-sends held changes, omits
missing ones). Only `since = null` (full-log re-send) is sound on a naive reading — but that is
unbounded per reconnect, contradicting "replay is O(durable changes since checkpoint)."

---

## 2. The three questions (from the continuation brief)

They are three faces of one gap.

- **Q1 — When does the cursor advance for confirmed delivery, and against what is `since`
  expressed?** D0 chose **durable-accept** (sufficient for engine-local reload). F1's root cause
  is that durable-accept leaves nothing for reconnect replay to send. A confirmed-delivery notion
  must lag the log — but F3 shows a *single* local cursor cannot be the cross-peer index.
- **Q2 — What is the retry/backpressure/ack seam shape?** `send` stays hand-off (mandate). Retry
  sits above it on the cursor/replay seam.
- **Q3 — Peer-pull recovery: new seam, or ride `changes(since)`?** B3's deeper defect — the
  mechanism self-republishes, never pulls a peer.

---

## 3. What is verified (spikes, ≥2 replicas, real engine + real ChannelSimulator)

Throwaway spikes, discarded per artifact discipline. Results are the durable record.

1. **Peer-pull as ordinary batch exchange composes from the existing surface.** A reconnecting
   peer's pull request rides an ordinary `ChangeBatch` (op-kind, reserved unit, requester's
   `since` in `Change.value` — `value` is `unknown` to ns, legal). The responder answers by
   driving `changes(since)` back over `send`. Imports touched only existing types; engine calls
   only `changes`/`apply`/`getCursor`/`snapshot`; `Transport` calls only `send`/`receive`.
   **No new seam type.** → **Q3 transport mechanism is additive.**
2. **Under a lossy channel (30% drop + reorder + duplicate), re-driven pull converges 12/12
   seeds; a single un-redriven pull converges 0/12.** Re-drive is load-bearing — matching nf
   Finding 2, now on the recovery path. → **Q2: reliability = re-drive on the cursor/replay seam.**
3. **Naive cross-peer cursor is unsound (F3), verified:** B missing `c2`, pulls A with B's seq
   (2), A returns `[c3]` — re-sends held, omits missing.
4. **Sender-side per-peer delivery cursor is locality-sound in a mesh.** `engine.apply()`
   re-stamps every emitted `onBatch` with the **receiving** engine's own `cursorSeq`
   (engine.ts:238) — so a *relayed* batch carries the **relayer's** cursor, never the origin's
   (spike: diverged seq spaces, relayed cursor = relayer ordinal 3, not origin's 2). A peer
   tracking "delivery cursor for peer P" indexes **its own** log; on P's reconnect it re-drives
   `changes(since = deliveryCursor[P])` from its own log. 3-peer spike: offline C recovered B's
   writes *through* A using only A-local seqs; second reconnect was incremental (only the new
   change flowed, not the full log). → **Q1: the confirmed-delivery cursor is per-peer and
   sender-side, dissolving the F3 locality hazard.**

---

## 4. Decision: a layered resolution

Steelman-then-leak across the option space. The resting state is **layered**, not a single
mechanism — the correctness layer is built now; the optimization layer is a deferred contract gate.

### Option matrix

| Option | Mechanism | Incremental? | Locality-sound? | Seam delta? | Role |
|---|---|---|---|---|---|
| **(1) Full reconcile** | pull `since=null` / exchange `snapshot()` | ✗ (O(full log/state) per reconnect) | ✓ | none | **Correctness floor** |
| **(2) Sender-side per-peer cursor** | responder re-drives `changes(since=deliveryCursor[P])` from its **own** log; P acks its high-water | ✓ | ✓ (own cursor only; relay re-stamps) | none | **Primary (build now)** |
| **(3) Version watermark** | requester sends per-unit version digest; responder filters by `compare` | ✓ (optimal) | ✓ (`Version` is cross-replica by T2) | **v1.1→v1.2** (`Feed` pull-by-version + `ClockStrategy` digest op) | **Deferred gate (§6)** |

### Why (2) is primary

- **Additive** — rides `changes(since)` + batch-exchange; no `Transport`/`Cursor`/wire change
  (spike 1). Keeps Phase 5 clean the way G2 was.
- **Locality-sound by construction** — the delivery cursor for peer P indexes the **holder's own**
  log; `apply()` re-stamping (spike 4) guarantees no peer ever interprets a foreign seq, even
  under mesh relay. This is the exact hazard (F3) that sinks the naive approach; (2) sidesteps it
  by never asking a peer to read a foreign cursor.
- **Correct + bounded** — closes B3's second half and makes nf op-redelivery correct. That is all
  B3 and the nf consumer need; they need *correct, bounded* recovery, not *optimal* recovery.

**Leak in (2):** the sender holds O(peers) delivery-cursor state per scope; in a large mesh this
grows, and evicting a peer's cursor forces that peer to fall back to (1) on next contact. Bounded
and acceptable — eviction degrades to the correctness floor, never to incorrectness.

### Why (1) is the floor, not the answer

Sound and zero-delta, but O(full log/state) every reconnect violates the replay-cost axiom.
Its role: the always-safe fallback when no per-peer delivery cursor exists — a cold peer, or a
sender that evicted its cursor state. (2) degrades to (1), never below it.

### Why (3) is deferred, not the resting state

(3) is the only *bandwidth-optimal* incremental option, and `Version` is the naturally
cross-replica token (T2 exists precisely because `compare()` is meaningful across engines). It is
the correct **end state**. But:

- It forces **two contract deltas**: `Feed` needs a pull-by-version primitive (`changes()` has no
  version filter — F3), and `ClockStrategy` must expose a compact "digest / since-version"
  operation because **`Version` is opaque to ns** — ns cannot build the watermark itself. The
  latter widens a slot (against "slots stay narrow").
- Its digest is O(units) where a cursor is O(1); compaction depends on strategy shape
  (LWW/vector-clock admit a node-keyed vector; an opaque position-CRDT may not).
- It buys **optimization, not correctness** — over (2), at the cost of contract surface, for a
  bandwidth win that is **unmeasurable in sandbox** (perf numbers are CC/CI only, charter §9).

Committing (3) now would pre-spend a v1.2 bump to buy performance we cannot yet justify with a
number. (3) is where you go **when a measured bandwidth number justifies the delta** — surfaced
as a contract gate (§6), not built.

---

## 5. The seam shape for (2) — additive, above `send`

All client/engine-composition layer; no seam-type change.

**Delivery cursor (Q1).** Per (holder, peer P, scope): `deliveryCursor[P]` = the highest seq of
**the holder's own** durable log that P has acknowledged receiving. Advances **only** on a
confirmed ack from P — this is the "confirmed-delivery" cursor D0 deferred, kept **distinct** from
the durable-accept log cursor (which is unchanged; D0 stands). Two cursors, two jobs: the log
cursor tracks local durability; the delivery cursor tracks per-peer confirmed receipt.

**Ack (Q2) — sub-gate, not designed here (per scope decision).** The ack ("I have your log up to
seq N", N = what the acker has seen *from this holder*) is itself a droppable message. It must be
an ordinary-batch message with its own idempotency + re-drive. Full design is **sub-gate D-ACK**
(§ gate file). This doc locks that the delivery cursor advances *only* on ack and that ack
delivery is itself unreliable; it does **not** lock the ack wire shape.

**Retry / re-drive (Q2).** The `transport.send(...).catch()` sites (already marked in
`create-sync.ts` as Phase 5) become the re-drive trigger: on reconnect (and optionally on a
timer/nack), for each peer P re-drive `changes(scope, deliveryCursor[P])` and re-send. Backpressure
is a bounded in-flight window on this loop. `send` stays hand-off — the mandate holds.

**Peer-pull (Q3).** Two directions, both over existing `send`/`receive`:
- *Push-catch-up* (holder-initiated): on P's reconnect, holder re-drives from `deliveryCursor[P]`.
- *Pull-request* (P-initiated): P broadcasts "I'm at «my cursor **from holder**»"; holder responds
  with `changes(since=that)`. The `since` P sends is **holder-local** (the last cursor P observed
  *on batches from that holder* — locality-sound per spike 4), not P's own log cursor.

**B3 fix consequence.** `create-sync.ts`'s inert branch is replaced: `lastCursor` (single,
tip-tracking) → per-peer `deliveryCursor` advanced on ack, not on `onBatch`. The replay then has a
real lag to send.

---

## 6. Deferred contract gate — option (3), v1.1 → v1.2

Do **not** build. Surfaced as a named future decision (separate log entry). Open **only** when a
CC/CI-measured bandwidth number shows (2)'s re-send cost is a real bottleneck for a real consumer.

Minimal delta if opened:
- `Feed`: a pull-by-version primitive (new method or `changes()` overload) — `changes()` filtering
  is seq-only today (F3).
- `ClockStrategy`: an optional compact digest / `sinceVersion` op — required because `Version` is
  opaque to ns. Must stay narrow (a digest producer, not a value inspector) to respect the slot
  discipline; if it can't, that is itself the reason to stay on (2).

Both are contract-level (they change what ns promises about delivery/replay). Per escalation
calibration: surfaced here, decided separately, never folded into an implementation detail.

---

## 7. Convergence claims + verification standard (for the gate)

Every recovery claim below is a ≥2-replica property over a simulated unreliable channel; the gate
file names the failable form. Established this pass:

- Re-driven per-peer pull converges under 30% drop+reorder+duplicate (12/12 seeds); single pull
  does not (0/12) — re-drive is required, not optional.
- Sender-side per-peer cursor is mesh-locality-sound (3-peer relay recovery via relayer-local
  seqs; incremental on re-reconnect).
- These are **sandbox correctness** results. Throughput/bandwidth (the only thing that would
  justify option 3) is **CC/CI**, not established here.

---

## 8. Out of scope (tracked elsewhere, not resolved here)

- **Open conflicts not persisted** — `openConflicts` in-memory; reload mid-conflict drops the
  remote side (redelivery re-triggers under T1, but a `defer`'d conflict silently vanishes until
  then). Tied to this same delivery seam (a conflict re-arrives only if the peer re-sends).
  Log-tracked; own resolution.
- **`closedKeys` unbounded growth** — acceptable at current cardinality.
- **Conformance suite + LCD-risk proof** — charter §8 Phase 5 exit; nf spike is the first
  datapoint.
