import { describe, expect, it } from "vitest";
import { canTransitionRuntimeState, transitionRuntimeState } from "../../src/offscreen/runtime-state";
import type { RuntimeState } from "../../src/shared/runtime-types";

const transitions: Readonly<Record<RuntimeState, readonly RuntimeState[]>> = {
  created: ["initializing", "stopping", "stopped", "resetting", "error"],
  initializing: ["ready", "stopping", "resetting", "error"],
  ready: ["active", "stopping", "resetting", "error"],
  active: ["ready", "stopping", "resetting", "error"],
  stopping: ["stopped", "error"],
  stopped: ["initializing", "resetting", "stopped", "stopping"],
  resetting: ["initializing", "stopped", "error"],
  error: ["resetting", "stopping", "stopped"],
};

const states = Object.keys(transitions) as RuntimeState[];

describe("runtime lifecycle transition table", () => {
  it("accepts only the explicitly declared transitions (and idempotent self-transitions)", () => {
    for (const from of states) {
      expect(canTransitionRuntimeState(from, from)).toBe(true);
      for (const to of states) {
        const expected = from === to || transitions[from].includes(to);
        expect(canTransitionRuntimeState(from, to), `${from} → ${to}`).toBe(expected);
        if (expected) expect(transitionRuntimeState(from, to)).toBe(to);
        else expect(() => transitionRuntimeState(from, to)).toThrowError(/not allowed/);
      }
    }
  });
});
