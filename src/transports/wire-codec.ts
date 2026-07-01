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
