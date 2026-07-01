# Design: `@neutro/form` ↔ `ns` integration spike (Phase 4, first consumer)

> **Status**: executed spike (sandbox), result durable and **replayable**. Not a decision on its
> own — the decision-log entry `2026-06-30 — nf integration spike` records the event; this doc holds
> the reusable analysis a future session (the real-nf CC integration) re-reads.
> **Fidelity**: `ns` is the **real** engine (cloned source, public `createSync` surface). `@neutro/form`
> is a **minimal faithful stand-in** whose seam signatures mirror the verified nf-core source
> (`FormInstance.subscribeToPath` / `set(path, val, SetOptions)` / `submit`; `SetOptions` has **no**
> `silent`/`origin` flag). The real-nf run — real package, real DOM/framework — is **CC's job**; this
> proves the **binding shape composes** and surfaces the API frictions, deterministically.
> **Scope (as agreed)**: connected-only two-replica convergence; **B3 client-reconnect is out**;
> all three §9 form rows included.

---

## 1. What was proven (executed, ≥2 replicas, simulated unreliable channel)

Two `ns` clients, two form stand-ins, connected over a seeded lossy link (**30% drop + reorder +
duplicate**). All three seam-contract §9 form rows converge, verified across **13 seeds**
(`f00d 1234 abcd 5eed 9999 dead beef 0001 cafe 7777 aaaa bbbb 3c3c` → **ALL_PASS on every seed**):

| §9 row | lifetime/kind | nf outbound → ns | ns → nf inbound | result |
|---|---|---|---|---|
| field-state | durable / state | `subscribeToPath(path)` → `fieldScope.set(path, v)` | `fieldScope.subscribe` → `form.set(path, v)` | concurrent same-field edit converges to one resolver-picked winner ✓ |
| submit | durable / op | `onSubmit` → `submitScope.do("submit", payload)` | `submitScope.subscribe` → collect | exactly-once **application** ✓ **(only via a consumer idem key — see §3)** |
| typing-indicator | ephemeral / state | synthetic `setTyping` → `typingScope.set` | `typingScope.subscribe` | delivered live, never persisted/replayed ✓ |

`unit` = nf `Path<T>` (dotted string) throughout. Echo guard clean on both replicas.

**The binding is consumer-side glue only.** It imports `ns`'s public surface (`createSync`, `scope`,
`set`/`do`/`subscribe`) and nothing from `ns/src/core`. `ns` stays standalone; there is no
`ns`-side nf adapter. This is the axiom holding in practice, not just on paper.

---

## 2. The echo guard (load-bearing — the binding's first responsibility)

nf's `set(path, val)` fires `subscribeToPath` listeners identically for a **local user edit** and a
**remote change the binding just applied** — `SetOptions` carries no origin/silent flag (verified in
nf-core source). Without a guard, an inbound `ns` change → `form.set` → outbound emit → back into
`ns` → echo loop.

**Mechanism (proven clean):** the binding holds an `applying: Set<path>`. Before `form.set(...)` for
an inbound change it adds the path; the outbound `subscribeToPath` handler early-returns if the path
is in `applying`; a `finally` removes it. Post-drain assertion: `applying.size === 0` on both
replicas (no leaked in-flight guard). This is standard external-source cycle-breaking; nf provides no
built-in for it, so it lives in the adapter.

---

## 3. FINDING 1 (API gap) — op dedup is unusable for consumer-driven redelivery

**Claim, proven by execution (not argued):** `ns`'s public `do(unit, value, opts?)` mints the op's
`ChangeId` internally as a monotonic counter (`${clientId}:${scope}:do:${unit}:${++_seq}`). The
consumer **cannot supply a stable op id.** Therefore re-emitting the *same logical* submit produces a
**new id each time**, and `ns`'s dedup-by-id does **not** collapse them.

**Probe (reliable channel, isolate from drop-luck):** two `do("submit", {p:1})` calls with identical
payload+unit → **`APPLIED_COUNT=2`** on the peer. Re-delivery double-applies.

**Consequence:** a consumer needing at-least-once delivery with exactly-once *effect* (every real
form submit) **must** carry its own idempotency key **inside the op value** and dedup on receipt —
`ns`'s built-in id-dedup cannot be used for this. The spike does exactly this (`__idem` field +
`seenSubmitKeys` set) and then exactly-once holds under 8 duplicate re-emits.

**This is an API-surface gap, not a config choice.** Options for the real integration / a future
gate (not decided here — surfaced):
- (a) let `do()` accept a caller-supplied stable op id (`WriteOpts.opId?`) so `ns` dedup works for redelivery;
- (b) document "carry your own idempotency key" as the required consumer pattern;
- (c) leave to Phase 5 delivery-above-transport (retry with `ns`-owned stable ids).

---

## 4. FINDING 2 (contract made concrete) — no delivery reliability; the consumer must re-drive

**Claim, proven by execution:** `ns` has **no** retry/redelivery. A single durable write dropped by
the channel is **lost permanently** — and **draining longer cannot recover it** (the link buffers
undropped batches, but a batch killed at the drop-roll is gone). Verified: with writes emitted
**once**, `ALL_PASS` is **seed-dependent** (5/10 seeds failed). With the consumer **re-driving each
write until the peer observes it**, `ALL_PASS` is **robust across all 13 seeds.**

This is the §7 "delivery guarantees live above the transport" boundary made concrete. The reliability
layer is **the consumer's**, until Phase 5 builds retry/backpressure/ack. Re-drive safety differs by row:
- **state / ephemeral**: safe to re-emit blindly — idempotent by version; re-applying a stale/equal
  version is a `compare` no-op on the peer. (The losing side re-drives the *converged winner* it now
  holds, not its stale local edit — so re-drive is stable, not oscillating.)
- **op**: **not** safe to blindly re-emit (Finding 1) — needs the consumer idem key.

**Consequence for charter §8 Phase 4 exit ("an app syncs a real consumer end-to-end"):** on the
current API this is **not robustly achievable without the consumer reimplementing delivery
reliability.** The first-consumer integration therefore either (i) ships that reliability layer as
part of the adapter, or (ii) waits on Phase 5. Finding 1 makes (i) awkward for ops specifically.

---

## 5. Three lesser frictions (bounded, consumer-side)

1. **Typing-indicator is synthetic.** nf has no native presence/typing field; it rides as a
   dedicated ephemeral scope (or a `setDynamic` dynamic path). The §9 "natural three-row form" is
   really **2 native rows + 1 synthetic**. Not a blocker; state it so it isn't over-read.
2. **Array/dynamic paths.** `unit = Path<T>` is clean for scalar fields; array paths (`items.0.name`)
   and dynamic paths need nf's path-trie (`isKnownPath`) on the binding side. Bounded.
3. **Submit payload shape.** The spike stuffs `__idem` into the op value; a real adapter would use a
   cleaner envelope (`{ payload, idem }`) so the key doesn't pollute the form's submit shape.

---

## 6. Replay

Deterministic and self-contained. The spike script is embedded below (also the throwaway
`spike-nf-integration.ts` used in-session). Re-run: place in an `ns` clone root, `npx tsx
spike-nf-integration.ts`. Fixed `SEED` → identical output. Seed sweep: change `SEED`, re-run.

**Recorded output (SEED `f00d`):**
```json
{
  "SEED": "f00d",
  "row1_field_conflict":     { "nameA": "Alice", "nameB": "Alice", "converged": true },
  "row1b_field_crossapply":  { "emailOnB": "a@x.com", "converged": true },
  "row2_submit_op_exactly_once": { "count": 1, "ok": true },
  "row3_ephemeral_typing":   { "seenOnB": [true], "ok": true },
  "echo_guard_clean": true,
  "ALL_PASS": true
}
```
**Seed sweep:** ALL_PASS on all of `f00d 1234 abcd 5eed 9999 dead beef 0001 cafe 7777 aaaa bbbb 3c3c`.

> Fidelity caveat carried forward: this proves the **binding shape** against nf's **seam signatures**,
> not the real nf runtime. Real-nf (real DOM, real validation/submit lifecycle, real `Path<T>`
> typing) is the CC integration. Findings 1 and 2 are **API/contract** facts that transfer regardless
> of fidelity (they're about `ns`'s public surface, which is real here).

### Embedded spike source
Full runnable source: [`nf-integration.spike.ts`](./nf-integration.spike.ts).
Replay: copy to an `ns` clone root, `npx tsx nf-integration.spike.ts`. Fixed `SEED` →
identical output; change `SEED` to sweep.

---

## 7. What this unblocks / recommends (not decided here)

- The **binding model is validated**: three-row routing, echo guard, `unit = path`. A real nf adapter
  can be built on it.
- **Before a robust end-to-end nf integration ships**, resolve Finding 1 (op idempotency key) —
  it's a small, real API-surface question — and decide where the delivery-reliability layer (Finding
  2) lives: in the adapter now, or wait on Phase 5. Both are gate-level; neither is invented here.
- **G3 LCD-risk**: this is the first datapoint. The seam generalizes to nf's three rows cleanly on
  the *happy path*; the honest cost it exposes is that **`ns` currently offloads all delivery
  reliability to the consumer**, which a purpose-built form-sync engine would bundle. That's the
  LCD-risk made specific — worth carrying into the conformance-suite argument.
```
