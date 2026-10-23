import { DiscoveryEngine, type BehaviourGate } from "../../src/discovery/engine.js";
import { createGate, fixedNow } from "../fixtures/detection.js";

export function makeEngine(
  flags: BehaviourGate = createGate(),
  now: () => number = fixedNow(),
): DiscoveryEngine {
  return new DiscoveryEngine({ flags, now });
}
