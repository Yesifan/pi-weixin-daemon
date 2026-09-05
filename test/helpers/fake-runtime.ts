import type { PiHostEvent } from "../../src/pi/events.js";
import type { HostImage, HostPromptInput, HostStatus, SessionSwitchResult } from "../../src/pi/types.js";
import type { SessionRuntimePort } from "../../src/sessions/runtime-port.js";

/**
 * Controllable SessionRuntimePort for bridge/session tests: prompt() suspends
 * until the test calls complete()/fail()/abort().
 */
export class FakeAgentRuntime implements SessionRuntimePort {
  readonly cwd: string;
  prompts: Array<{ text: string; images?: HostImage[] }> = [];
  newSessionCalls = 0;
  compactCalls = 0;
  ensureSessionCalls = 0;
  stopCalls = 0;
  private listeners = new Set<(event: PiHostEvent) => void>();
  private pending:
    | { resolve: () => void; reject: (err: Error) => void }
    | undefined;

  constructor(cwd = "/fake/project") {
    this.cwd = cwd;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {
    this.stopCalls += 1;
  }
  async ensureSession(): Promise<void> {
    this.ensureSessionCalls += 1;
  }

  hasSession(): boolean {
    return true;
  }

  async prompt(input: HostPromptInput): Promise<void> {
    this.prompts.push({ text: input.text, images: input.images });
    await new Promise<void>((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  /** Complete the current prompt: emit text deltas + agent_settled, resolve. */
  complete(reply: string): void {
    const chunks = reply.match(/.{1,10}/gs) ?? [reply];
    for (const delta of chunks) {
      this.emit({ type: "text_delta", delta });
    }
    this.emit({ type: "agent_settled" });
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

  async newSession(): Promise<SessionSwitchResult> {
    this.newSessionCalls += 1;
    return { cancelled: false };
  }

  async compact(): Promise<void> {
    this.compactCalls += 1;
  }

  onEvent(listener: (event: PiHostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: PiHostEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  getStatus(): HostStatus {
    return {
      sessionFile: "/fake/session.jsonl",
      sessionId: "fake-session",
      cwd: this.cwd,
      model: "fake/provider",
      thinkingLevel: "medium",
      configuredTrust: true,
      activeSessionTrust: true,
    };
  }
}
