import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { extractTextDelta, isAgentSettled } from "../agent/events.js";

/**
 * Accumulates assistant text deltas for one turn and resolves when the agent
 * run is fully settled. No per-token weixin sends: the final accumulated text
 * is delivered once, after `settled`.
 */
export class ResponseAccumulator {
  private text = "";
  private settledResolve!: () => void;
  readonly settled: Promise<void>;

  constructor() {
    this.settled = new Promise((resolve) => {
      this.settledResolve = resolve;
    });
  }

  handleEvent(event: AgentSessionEvent): void {
    const delta = extractTextDelta(event);
    if (delta) {
      this.text += delta;
    }
    if (isAgentSettled(event)) {
      this.settledResolve();
    }
  }

  get accumulatedText(): string {
    return this.text;
  }
}
