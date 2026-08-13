// Brain selection: BRAIN=mock|live, default mock — the whole station plays at
// $0 unless the live adapter is explicitly requested (DECISIONS.md).
import type { Brain } from "../ports";
import { AnthropicBrain } from "./anthropic";
import { MockBrain } from "./mock";

export function getBrain(): Brain {
  const kind = (process.env.BRAIN ?? "mock").toLowerCase();
  if (kind === "live") {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("BRAIN=live requires ANTHROPIC_API_KEY");
    }
    return new AnthropicBrain();
  }
  if (kind !== "mock") {
    console.warn(`(!) Unknown BRAIN="${process.env.BRAIN}" — falling back to mock`);
  }
  return new MockBrain();
}

export { AnthropicBrain } from "./anthropic";
export { MockBrain } from "./mock";
