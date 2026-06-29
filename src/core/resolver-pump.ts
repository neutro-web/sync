/**
 * ResolverPump — optional bridge from onConflict notification to resolveConflict().
 *
 * Subscribes to the engine's onConflict stream for a scope. On each conflict,
 * calls resolver.resolve() and feeds the result back to engine.resolveConflict().
 * Lives entirely outside apply() — the engine fires onConflict as a notification
 * and returns; the pump drives resolution as a separate transition (Model C).
 *
 * Absent → conflicts stay open until resolved manually via engine.resolveConflict().
 * Present → automatic resolution per the injected Resolver.
 *
 * Async resolvers: if resolver.resolve() returns a Promise, the pump awaits it and
 * calls resolveConflict when the promise settles. The synchronous return to the
 * engine is { decision: "defer" } — the conflict stays open until the async result
 * lands. This is the correct representation of an in-flight async resolution.
 */

import type { Resolver, Scope, Conflict, Resolution } from "./types.ts";
import type { Engine } from "./engine.ts";

/**
 * Bridges engine conflict notifications to a {@link Resolver}.
 *
 * Subscribes to the engine on construction. **Call {@link dispose} when done**
 * to unsubscribe; a discarded `ResolverPump` without `dispose()` holds its
 * subscription for the engine's lifetime (intentional in the in-memory sandbox,
 * but worth noting for future persistence layers).
 *
 * Sync resolvers: `resolve()` is called synchronously inside the engine's
 * `onConflict` notification loop. `resolveConflict()` fires reentrantly.
 *
 * Async resolvers: `onConflict` returns `{ decision: "defer" }` synchronously;
 * the promise settles and calls `resolveConflict` later.
 *
 * **Convergence requirement:** for local (non-propagated) resolution, the
 * `Resolver` passed here MUST be a deterministic pure function — see
 * `docs/seam-contract.md` §5 for the full expectation.
 */
export class ResolverPump {
  private readonly _sub: { unsubscribe(): void };

  constructor(engine: Engine, resolver: Resolver, scope: Scope) {
    this._sub = engine.subscribe(scope, {
      onBatch: () => {},
      // NOTE: for sync resolvers, this handler calls resolveConflict reentrantly
      // from inside the engine's onConflict notification loop.
      onConflict: (conflict: Conflict): Resolution => {
        const result = resolver.resolve(conflict);
        if (result instanceof Promise) {
          result
            .then((res) => engine.resolveConflict(conflict.scope, conflict.unit, res))
            .catch((err) => {
              // Surface async resolution failures — callers cannot observe them otherwise.
              console.error("[ResolverPump] async resolution failed:", err);
            });
          // Conflict stays open while async resolution is in-flight.
          return { decision: "defer" };
        }
        engine.resolveConflict(conflict.scope, conflict.unit, result);
        return result;
      },
    });
  }

  /** Unsubscribe the pump. Conflicts detected after this call are not auto-resolved. */
  dispose(): void {
    this._sub.unsubscribe();
  }
}
