import type { InteractionPort } from "../pi/ports.js";
import type { SessionRuntimePort } from "./runtime-port.js";
import type { Logger } from "../util/logger.js";
import type { InboundMessage, TurnContext, WeixinTransport } from "../weixin/types.js";
import { helpText, type DaemonCommand } from "./commands.js";
import { buildPromptInput } from "./prompt.js";
import { ResponseAccumulator } from "./response-accumulator.js";
import { BUSY_REPLY, type SessionState } from "./session-state.js";
import { CurrentTurn, toTurnContext } from "./turn-context.js";

/** Default auto-close idle window for a shared session (10 minutes). */
export const DEFAULT_SESSION_IDLE_MS = 10 * 60 * 1000;

export interface SessionControllerDeps {
  projectId: string;
  host: SessionRuntimePort;
  interaction: InteractionPort;
  transport: WeixinTransport;
  /** Shared turn-origin holder (also read by the interaction controller). */
  currentTurn: CurrentTurn;
  logger: Logger;
  /** Idle window before the session is disposed (min for tests). */
  sessionIdleMs?: number;
  /** Broadcast a turn's final reply / idle-close notice to all participants. */
  broadcastText?: (text: string) => Promise<void>;
  /** Human label for an inbound sender (used in "-- from weixin <name>"). */
  resolveSenderLabel?: (msg: InboundMessage) => string;
}

/**
 * Single session lifecycle state machine (ADR-0004 Invariant 2).
 *
 * Owns: turn serialization (busy refusal), idle timer (real dispose), and the
 * `inactive/ready/busy/replacing/faulted` transitions. Command *classification*
 * lives in the project layer (`CommandRouter`); command *execution* lives here.
 */
export class SessionController {
  private state: SessionState = "inactive";
  private error?: string;
  private lastActivityAt = Date.now();
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: SessionControllerDeps) {}

  getState(): SessionState {
    return this.state;
  }

  getCurrentTurn(): TurnContext | undefined {
    return this.deps.currentTurn.get();
  }

  getStatus() {
    return this.deps.host.getStatus();
  }

  async start(): Promise<void> {
    await this.deps.host.start();
    this.state = "inactive";
  }

  async stop(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    await this.deps.host.stop().catch((err: unknown) =>
      this.deps.logger.warn({ err, project: this.deps.projectId }, "host stop error"),
    );
    this.state = "inactive";
  }

  /** Execute an explicitly-mapped daemon command (classification done upstream). */
  async handleCommand(command: DaemonCommand, msg: InboundMessage): Promise<void> {
    this.lastActivityAt = Date.now();
    this.scheduleIdleCheck();

    const turn = toTurnContext(msg);
    const log = this.deps.logger;
    log.info({ command, accountId: msg.accountId }, "command");

    switch (command) {
      case "help":
        await this.reply(turn, helpText());
        return;
      case "status":
        await this.reply(turn, this.formatStatus());
        return;
      case "abort":
        if (this.state !== "busy") {
          await this.reply(turn, "当前没有正在执行的任务。");
          return;
        }
        await this.deps.host.abort();
        await this.reply(turn, "⏹ 已发送中止指令。");
        return;
      case "new":
        if (this.state === "busy" || this.state === "replacing") {
          await this.reply(turn, "Agent 忙时不能新建会话，请先 /abort 或等待完成。");
          return;
        }
        if (this.state !== "ready" || !this.deps.host.hasSession()) {
          await this.reply(turn, "当前无会话，直接发送消息即可开始新会话。");
          return;
        }
        this.state = "replacing";
        try {
          const result = await this.deps.host.newSession();
          this.state = "ready";
          // Transparent {cancelled} (W3): a session_before_switch handler may cancel.
          await this.reply(turn, result.cancelled ? "⚠️ 已取消新建会话。" : "✅ 已新建会话。");
        } catch (err) {
          this.state = "faulted";
          this.error = err instanceof Error ? err.message : String(err);
          await this.reply(turn, `⚠️ 新建会话失败：${this.error}`);
        }
        return;
      case "compact":
        if (this.state === "busy") {
          await this.reply(turn, "Agent 忙时不能压缩会话，请先 /abort 或等待完成。");
          return;
        }
        await this.deps.host.compact();
        await this.reply(turn, "✅ 已请求会话压缩。");
        return;
    }
  }

  /** Route an ordinary user message (UI answer, busy refusal, or a new turn). */
  async handleUserMessage(msg: InboundMessage): Promise<void> {
    this.lastActivityAt = Date.now();
    this.scheduleIdleCheck();

    // UI answer routing: only the turn origin resolves the pending dialog.
    if (this.deps.interaction.isUiInteractionActive()) {
      const turn = this.deps.currentTurn.get();
      if (turn && msg.accountId === turn.accountId && msg.senderId === turn.senderId) {
        this.deps.logger.info({ accountId: msg.accountId }, "UI response received");
        this.deps.interaction.tryResolveUi(turn, msg.text ?? "");
      } else {
        this.deps.logger.info({ accountId: msg.accountId, senderId: msg.senderId }, "busy refusal (ui)");
        await this.reply(toTurnContext(msg), BUSY_REPLY);
      }
      return;
    }

    const turn = toTurnContext(msg);

    if (this.state === "busy" || this.state === "replacing") {
      this.deps.logger.info({ accountId: msg.accountId, senderId: msg.senderId, state: this.state }, "busy refusal");
      await this.reply(turn, BUSY_REPLY);
      return;
    }
    if (this.state === "faulted") {
      await this.reply(turn, `⚠️ 项目会话不可用：${this.error ?? "unknown error"}`);
      return;
    }

    // inactive → ready (fresh session); failure → faulted (never prompt).
    if (this.state === "inactive") {
      try {
        await this.deps.host.ensureSession();
        this.state = "ready";
      } catch (err) {
        this.state = "faulted";
        this.error = err instanceof Error ? err.message : String(err);
        this.deps.logger.error({ err, project: this.deps.projectId }, "session creation failed");
        await this.reply(turn, `⚠️ 项目启动失败，已拒绝消息：${this.error}`);
        return;
      }
    }

    await this.runTurn(msg);
  }

  private async runTurn(msg: InboundMessage): Promise<void> {
    const turn = toTurnContext(msg);
    this.deps.currentTurn.set(turn);
    this.state = "busy";

    try {
      await this.deps.transport.setTyping(turn, true);

      const accumulator = new ResponseAccumulator();
      const unsubscribe = this.deps.host.onEvent((event) => accumulator.handleEvent(event));

      let finalText: string;
      try {
        await this.deps.host.prompt(buildPromptInput(msg, this.deps.resolveSenderLabel?.(msg)));
        // agent_settled may arrive just after prompt() resolves; wait for it.
        await accumulator.settled;
        finalText = accumulator.accumulatedText.trim();
      } catch (err) {
        this.deps.logger.warn({ err }, "agent run failed");
        finalText = describeRunError(err);
      } finally {
        unsubscribe();
      }

      await this.deps.transport.setTyping(turn, false);

      if (finalText) {
        if (this.deps.broadcastText) {
          await this.deps.broadcastText(finalText);
        } else {
          await this.deps.transport.sendText(turn, finalText);
        }
      }
    } finally {
      this.deps.interaction.cancelUiWaiters("turn ended");
      this.state = "ready";
      this.deps.currentTurn.set(undefined);
    }
  }

  private formatStatus(): string {
    const status = this.deps.host.getStatus();
    return [
      `Project: ${status?.cwd ?? "(runtime not started)"}`,
      `Session: ${status?.sessionFile ?? "(none)"}`,
      `Agent state: ${this.state}`,
      `Model: ${status?.model ?? "unknown"}`,
      `Thinking: ${status?.thinkingLevel ?? "unknown"}`,
      `Configured trust: ${status?.configuredTrust ?? "?"}`,
      `Active session trust: ${status?.activeSessionTrust ?? "(no session)"}`,
    ].join("\n");
  }

  private async reply(turn: TurnContext, text: string): Promise<void> {
    await this.deps.transport.sendText(turn, text);
  }

  // --- idle auto-close -------------------------------------------------------

  private scheduleIdleCheck(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const idleMs = this.deps.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
    if (!Number.isFinite(idleMs) || idleMs <= 0) return;
    this.idleTimer = setTimeout(() => void this.checkIdle(), idleMs);
  }

  /** `ready →(timeout)→ inactive` performs a real dispose (W3). */
  private async checkIdle(): Promise<void> {
    if (this.state === "busy" || this.state === "replacing") {
      this.scheduleIdleCheck();
      return;
    }
    // Only a live, idle session can be closed; inactive/faulted have nothing.
    if (this.state !== "ready") return;

    const idleMs = this.deps.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
    if (Date.now() - this.lastActivityAt < idleMs) {
      this.scheduleIdleCheck();
      return;
    }

    // Real dispose: the SDK runtime is torn down; the wrapper/bridge/participants
    // survive. The next message rebuilds a fresh session (new sessionId).
    await this.deps.host.stop();
    this.state = "inactive";
    this.deps.logger.info({ project: this.deps.projectId }, "session auto-closed (idle)");
    if (this.deps.broadcastText) {
      await this.deps.broadcastText("本次会话已关闭").catch((err: unknown) =>
        this.deps.logger.warn({ err, project: this.deps.projectId }, "idle close broadcast failed"),
      );
    }
  }
}

function describeRunError(err: unknown): string {
  if (err instanceof Error && /abort|cancel/i.test(`${err.name} ${err.message}`)) {
    return "⏹ 已中止。";
  }
  return `⚠️ Agent 运行出错：${err instanceof Error ? err.message : String(err)}`;
}
