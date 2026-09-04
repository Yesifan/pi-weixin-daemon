import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentRuntime, SessionStatus } from "../../src/agent/runtime.js";
import type { ImageContent } from "@earendil-works/pi-ai/compat";

/**
 * Controllable AgentRuntime for bridge tests: prompt() suspends until the
 * test calls complete()/fail()/abort().
 */
export class FakeAgentRuntime implements AgentRuntime {
  readonly cwd: string;
  prompts: Array<{ text: string; images?: ImageContent[] }> = [];
  newSessionCalls = 0;
  compactCalls = 0;
  private listeners = new Set<(event: AgentSessionEvent) => void>();
  private pending:
    | { resolve: () => void; reject: (err: Error) => void }
    | undefined;

  constructor(cwd = "/fake/project") {
    this.cwd = cwd;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  hasSession(): boolean {
    return true;
  }

  async prompt(text: string, images?: ImageContent[]): Promise<void> {
    this.prompts.push({ text, images });
    await new Promise<void>((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  /** Complete the current prompt: emit text deltas + agent_settled, resolve. */
  complete(reply: string): void {
    const chunks = reply.match(/.{1,10}/gs) ?? [reply];
    for (const delta of chunks) {
      this.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta },
      } as AgentSessionEvent);
    }
    this.emit({ type: "agent_settled" } as AgentSessionEvent);
    this.pending?.resolve();
    this.pending = undefined;
  }

  /** Fail the current prompt with an error. */
  fail(err: Error): void {
    this.pending?.reject(err);
    this.pending = undefined;
  }

  async abort(): Promise<void> {
    this.fail(new Error("aborted by /abort"));
  }

  async newSession(): Promise<void> {
    this.newSessionCalls += 1;
  }

  async compact(): Promise<void> {
    this.compactCalls += 1;
  }

  onEvent(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: AgentSessionEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  getStatus(): SessionStatus {
    return {
      sessionFile: "/fake/session.jsonl",
      sessionId: "fake-session",
      cwd: this.cwd,
      model: "fake/provider",
      thinkingLevel: "medium",
      trust: true,
    };
  }
}
