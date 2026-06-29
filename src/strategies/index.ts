import type { ClockStrategy } from "../core/types.ts";
import { LWWClockStrategy } from "./lww.ts";
import { VectorClockStrategy } from "./vector-clock.ts";

/** Creates a Last-Write-Wins clock strategy. nodeId disambiguates concurrent writes from the same timestamp. */
export function lww(nodeId?: number): ClockStrategy {
	return new LWWClockStrategy(nodeId);
}

/** Creates a Vector Clock strategy. nodeId must be unique per replica in the mesh. */
export function vectorClock(nodeId: string): ClockStrategy {
	return new VectorClockStrategy(nodeId);
}
