import type { ImageContent } from "@earendil-works/pi-ai/compat";
import type { AgentRuntime } from "../agent/runtime.js";
import type { Logger } from "../util/logger.js";
import { CommandRouter } from "./commands.js";
import { ResponseAccumulator } from "./response.js";
import { BUSY_REPLY, type BridgeState } from "./state.js";
import { CurrentTurn, toTurnContext } from "./turn-context.js";
import type { InboundMessage, TurnContext, WeixinTransport } from "./types.js";

export interface BridgeDeps {
  /** Bound after runtime creation via bindRuntime(). */
  runtime?: AgentRuntime;
  transport: WeixinTransport;
  logger: Logger;
}

/**
 * The thin glue between weixin transport(s) and the Pi runtime.
 *
 * - one in-flight turn at a time; no queue
 * - while busy, ordinary messages are refused immediately
 * - commands route through CommandRouter in every state
 * - replies (text/files/UI) always go back to the TurnContext origin account
 */
export class Bridge {
  private runtime: AgentRuntime | undefined;
  private state: BridgeState = "IDLE";
  private currentTurn = new CurrentTurn();
  private turnPromise: Promise<void> | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly commandRouter: CommandRouter;

  constructor(private readonly deps: BridgeDeps) {
    this.commandRouter = new CommandRouter({
      getRuntime: () => this.requireRuntime(),
      state: () => this.state,
      getStatus: () => this.formatStatus(),
      logger: deps.logger,
    });
  }

  bindRuntime(runtime: AgentRuntime): void {
    this.runtime = runtime;
  }

  getState(): BridgeState {
    return this.state;
  }

  getCurrentTurn(): TurnContext | undefined {
    return this.currentTurn.get();
  }

  attach(): void {
    this.unsubscribe = this.deps.transport.onMessage((msg) => this.onMessage(msg));
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private async onMessage(msg: InboundMessage): Promise<void> {
    const log = this.deps.logger;

    // 1. Commands are allowed even while the agent is busy.
    const reply = await this.commandRouter.tryHandle(msg);
    if (reply !== undefined) {
      await this.deps.transport.sendText(toTurnContext(msg), reply);
      return;
    }

    // 2. Busy refusal (no queue, no steering).
    if (this.turnPromise) {
      log.info(
        { accountId: msg.accountId, senderId: msg.senderId, state: this.state },
        "busy refusal",
      );
      await this.deps.transport.sendText(toTurnContext(msg), BUSY_REPLY);
      return;
    }

    // 3. Start the turn. Sequential via turnPromise: while it is set, all
    //    ordinary messages are refused above.
    this.turnPromise = this.runTurn(msg);
    await this.turnPromise;
  }

  private async runTurn(msg: InboundMessage): Promise<void> {
    const runtime = this.requireRuntime();
    const turn = toTurnContext(msg);
    this.currentTurn.set(turn);
    this.state = "RUNNING";
    const log = this.deps.logger;

    try {
      await this.deps.transport.setTyping(turn, true);

      const accumulator = new ResponseAccumulator();
      const unsubscribe = runtime.onEvent((event) => accumulator.handleEvent(event));

      let finalText: string;
      try {
        await runtime.prompt(msg.text ?? "", imagesOf(msg));
        // agent_settled may arrive just after prompt() resolves; wait for it.
        await accumulator.settled;
        finalText = accumulator.accumulatedText.trim();
      } catch (err) {
        log.warn({ err }, "agent run failed");
        finalText = describeRunError(err);
      } finally {
        unsubscribe();
      }

      await this.deps.transport.setTyping(turn, false);

      if (finalText) {
        await this.deps.transport.sendText(turn, finalText);
      }
    } finally {
      this.state = "IDLE";
      this.currentTurn.set(undefined);
      this.turnPromise = undefined;
    }
  }

  private formatStatus(): string {
    const runtime = this.runtime;
    const status = runtime ? runtime.getStatus() : undefined;
    return [
      `Project: ${status?.cwd ?? "(runtime not started)"}`,
      `Session: ${status?.sessionFile ?? "(none)"}`,
      `Agent state: ${this.state}`,
      `Model: ${status?.model ?? "unknown"}`,
      `Thinking: ${status?.thinkingLevel ?? "unknown"}`,
    ].join("\n");
  }

  private requireRuntime(): AgentRuntime {
    if (!this.runtime) throw new Error("Bridge runtime not bound");
    return this.runtime;
  }
}

function describeRunError(err: unknown): string {
  if (err instanceof Error && /abort|cancel/i.test(`${err.name} ${err.message}`)) {
    return "⏹ 已中止。";
  }
  return `⚠️ Agent 运行出错：${err instanceof Error ? err.message : String(err)}`;
}

/** M8: weixin inbound images -> multimodal ImageContent[]. */
function imagesOf(_msg: InboundMessage): ImageContent[] | undefined {
  return undefined;
}
