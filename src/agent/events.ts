import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/** Extract a text delta from a session event, if it is one. */
export function extractTextDelta(event: AgentSessionEvent): string | undefined {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    return event.assistantMessageEvent.delta;
  }
  return undefined;
}

/** True when the agent run has fully finished (all messages settled). */
export function isAgentSettled(event: AgentSessionEvent): boolean {
  return event.type === "agent_settled";
}
