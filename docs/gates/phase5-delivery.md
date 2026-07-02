# Gate — Phase 5 Delivery Reliability

> Acceptance contract for the delivery-reliability layer (design:
> `docs/design/delivery-reliability.md`). Written before implementation (CC). Every item names
> the artifact/command that produces evidence and the exact condition that fails it. Convergence
> items specify **replica count / divergence driver / reconciled end-state**. Read back against
> **main HEAD**, not summaries or green counts.
>
> **Contract posture:** items G-D0..G-D7 are **additive over seam v1.1** (option 2). No change to
> `docs/seam-contract.md`, `src/core/types.ts`, `test/harness/`, or `src/transports/in-process.ts`.
> A regression-guard diff over those files must be empty. Option (3) is **not** in this gate
> (deferred contract gate, design §6).

---

## Scope

Closes: B3 second half (peer-pull recovery), nf Finding 2 (consumer must re-drive), Q1/Q2/Q3
(design doc). Does **not** close: open-conflicts-not-persisted, `closedKeys` growth, conformance/
LCD (tracked separately).

---

## Gate items

### G-D0 — Per-peer delivery cursor replaces tip-tracking `lastCursor`
- **Artifact:** `src/client/create-sync.ts`.
- **Evidence:** `ScopeEntry` holds a per-peer `deliveryCursor` map (keyed by peer identity),
  distinct from the durable-accept log cursor. The single tip-tracking `lastCursor` advanced in
  `onBatch` is gone from the reconnect-replay path.
- **Fails if:** a `grep` shows `onBatch` still advancing the value used as `changes(since=…)` on
  reconnect (the B3 inert pattern), or the delivery cursor advances anywhere other than on a
  confirmed ack.

### G-D1 — B3 regression tripwire flips
- **Artifact:** `test/client/reconnect.test.ts` (currently characterizes the inert branch, green
  on purpose).
- **Evidence:** the characterization test that asserts "durable reconnect replay emits nothing" is
  replaced by a test asserting the replay now emits the missing tail; the old inert-behavior
  assertion no longer exists.
- **Fails if:** the inert-behavior assertion is still present and green (B3 not actually fixed).

### G-D2 — Peer-pull recovery, 2 replicas, lossless
- **Replica count:** 2 (A writer, B recovering).
- **Divergence driver:** B partitioned while A commits 3 durable changes; A's per-B send buffer
  cleared on reconnect (absent-peer case — recovery must come via pull, not a flushed buffer).
- **Reconciled end-state:** after B pulls from `deliveryCursor` (0) and drains, `B.snapshot(scope)`
  holds all 3 of A's units.
- **Artifact/command:** `integration/` or `test/client/` spec; `pnpm test`.
- **Fails if:** B's snapshot has < 3 units, or recovery succeeds only because A's self-partition
  buffer flushed (buffer must be cleared in the test to isolate the pull path).

### G-D3 — Peer-pull converges under a lossy channel **with re-drive**
- **Replica count:** 2.
- **Divergence driver:** 30% drop + reorder + duplicate on both directions (`ChannelSimulator`);
  absent-peer buffer cleared; pull re-driven until B's cursor advances (bounded attempts).
- **Reconciled end-state:** **all** seeds in a fixed sweep (≥12) converge to 3 units on B.
- **Artifact/command:** spec with seeded sweep; `pnpm test`.
- **Fails if:** any seed fails to converge within the attempt bound.

### G-D4 — NEGATIVE control: single un-redriven pull is loss-sensitive
- **Replica count:** 2. Same faults as G-D3, but exactly **one** pull, no re-drive.
- **Reconciled end-state asserted:** **not** all seeds converge (demonstrates re-drive is
  load-bearing, not incidental).
- **Fails if:** all seeds converge with a single pull (would mean the channel/test isn't actually
  exercising loss — the sweep is not discriminating).

### G-D5 — Sender-side cursor is locality-sound under mesh relay
- **Replica count:** 3 (A, B, C); C offline during B's writes, recovers B's changes **relayed
  through A**.
- **Divergence driver:** A holds a prior local write so A's seq space diverges from B's; C pulls
  from A only.
- **Reconciled end-state:** C's snapshot holds A's own write + both of B's writes; every `since`
  value C/A exchanged is the relayer's local seq (no foreign cursor interpreted); a second
  reconnect after a new A-write sends **only** that new change (incremental, not full re-send).
- **Artifact/command:** 3-peer spec; `pnpm test`.
- **Fails if:** C's snapshot is missing any of the 3 changes, OR the second reconnect re-sends the
  full log (delivery cursor not advancing on ack), OR a foreign cursor is used as `changes(since)`.

### G-D6 — `send` stays hand-off (mandate preserved)
- **Artifact:** `src/transports/*`, retry loop in `create-sync.ts`.
- **Evidence:** `Transport.send` still resolves on hand-off; retry/re-drive/backpressure live in
  the client layer above `send`, not inside any `Transport`. The in-flight window bounds re-drive.
- **Fails if:** any `send` implementation awaits an ack before resolving, or a `Transport` method
  is added for retry/ack/pull (that would be an option-3 contract delta — out of this gate).

### G-D7 — Additivity / regression guard
- **Command:** `git diff --name-only main -- docs/seam-contract.md src/core/types.ts test/harness/ src/transports/in-process.ts` is **empty**; `pnpm typecheck` clean; `pnpm lint` clean; full
  `pnpm test` green.
- **Fails if:** any frozen file changed, or any standing gate regresses.

---

## Sub-gate (surfaced, NOT closed by this gate)

### D-ACK — Ack message design
The delivery cursor advances only on a confirmed ack; the ack is itself a droppable ordinary-batch
message needing idempotency + re-drive. **Design deferred** (design doc §5, per session scope
decision). This gate assumes an ack exists and advances the delivery cursor; it does **not** verify
the ack wire shape. D-ACK must be resolved (its own design + gate items) before G-D0's "advances
only on ack" is fully specified. Until then, G-D2/G-D3/G-D5 may model the ack as a reliable
in-test signal, and must **say so explicitly** (measurement-semantics discipline).

---

## Deferred contract gate (design §6) — NOT in this gate

Option (3) version-watermark pull → `Feed` pull-by-version + `ClockStrategy` digest op =
**v1.1→v1.2**. Open only on a CC/CI-measured bandwidth justification. Separate decision entry.
