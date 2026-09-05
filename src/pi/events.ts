import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/**
 * Domain event surface consumed by the business layer.
 *
 * The SDK's `AgentSessionEvent` union is translated at this boundary so that no
 * SDK type leaks into `src/projects/`, `src/sessions/`, or `src/weixin/`.
 */
export type PiHostEvent =
  | { type: "text_delta"; delta: string }
  | { type: "agent_settled" }
  | { type: "other" };

/** Translate a raw SDK session event into the domain event surface. */
export function toPiHostEvent(event: AgentSessionEvent): PiHostEvent {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    return { type: "text_delta", delta: event.assistantMessageEvent.delta };
  }
  if (event.type === "agent_settled") {
    return { type: "agent_settled" };
  }
  return { type: "other" };
}

export function isTextDelta(event: PiHostEvent): event is { type: "text_delta"; delta: string } {
  return event.type === "text_delta";
}

export function isAgentSettled(event: PiHostEvent): event is { type: "agent_settled" } {
  return event.type === "agent_settled";
}
