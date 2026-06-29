import { LWWClockStrategy } from "./lww.ts";
import { VectorClockStrategy } from "./vector-clock.ts";

let _vcNodeSeq = 0;

export function lww(nodeId?: number): LWWClockStrategy {
	return new LWWClockStrategy(nodeId);
}

export function vectorClock(nodeId?: string): VectorClockStrategy {
	return new VectorClockStrategy(nodeId ?? `vc-node-${++_vcNodeSeq}`);
}
