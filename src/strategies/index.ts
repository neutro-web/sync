import type { ClockStrategy } from "../core/types.ts";
import { LWWClockStrategy } from "./lww.ts";
import { VectorClockStrategy } from "./vector-clock.ts";

export function lww(nodeId?: number): ClockStrategy {
	return new LWWClockStrategy(nodeId);
}

export function vectorClock(nodeId: string): ClockStrategy {
	return new VectorClockStrategy(nodeId);
}
