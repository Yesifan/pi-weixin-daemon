import type { InteractionPort } from "../pi/ports.js";
import type { SessionRuntimePort } from "./runtime-port.js";
import type { Logger } from "../util/logger.js";
import type { InboundMessage, TurnContext, WeixinTransport } from "../weixin/types.js";
import { helpText, type DaemonCommand } from "./commands.js";
import { buildPromptInput } from "./prompt.js";
import { ResponseAccumulator } from "./response-accumulator.js";
import { BUSY_REPLY, type SessionState } from "./session-state.js";
import type { DeliveryReport, TurnIssue, TurnOutcome } from "./turn-outcome.js";
import { CurrentTurn, toTurnContext } from "./turn-context.js";
import { formatUserFacingError } from "../util/user-facing-error.js";

/** Default auto-close idle window for a shared session (10 minutes). */
export const DEFAULT_SESSION_IDLE_MS = 10 * 60 * 1000;
/** Maximum turn duration before aborting Pi (30 minutes). */
export const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;
/** Time allowed for Pi to settle after a timeout abort. */
export const DEFAULT_ABORT_GRACE_MS = 10_000;

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
  broadcastText?: (text: string) => Promise<DeliveryReport | void>;
  /** Human label for an inbound sender (used in "-- from weixin <name>"). */
  resolveSenderLabel?: (msg: InboundMessage) => string;
  /** Maximum duration of one Pi turn; 0 disables the watchdog. */
  turnTimeoutMs?: number;
  /** Grace period for Pi to settle after a watchdog abort. */
  abortGraceMs?: number;
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

  getFault(): string | undefined {
    return this.error;
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
    this.deps.logger.info({ command, accountId: msg.accountId, messageId: msg.messageId }, "command");
    try {
      await this.executeCommand(command, turn);
    } catch (err) {
      this.deps.logger.error({ err, command, project: this.deps.projectId }, "command execution failed");
      // A failed outbound send cannot be reported over the same failed channel;
      // let that second failure reach the project boundary for structured logging.
      await this.reply(turn, `⚠️ 命令 /${command} 执行失败：${formatUserFacingError(err)}`);
    }
  }

  private async executeCommand(command: DaemonCommand, turn: TurnContext): Promise<void> {
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
          await this.reply(turn, result.cancelled ? "⚠️ 已取消新建会话。" : "✅ 已新建会话。");
        } catch (err) {
          this.state = "faulted";
          this.error = formatUserFacingError(err);
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
        this.error = formatUserFacingError(err);
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
    let nextState: SessionState = "ready";

    try {
      await this.deps.transport.setTyping(turn, true);
      const accumulator = new ResponseAccumulator();
      const unsubscribe = this.deps.host.onEvent((event) => accumulator.handleEvent(event));
      let outcome: TurnOutcome;

      try {
        const operation = (async () => {
          await this.deps.host.prompt(buildPromptInput(msg, this.deps.resolveSenderLabel?.(msg)));
          await accumulator.settled;
        })();
        // Avoid an unhandled rejection if a hard timeout returns before a stuck
        // provider operation eventually rejects.
        void operation.catch(() => undefined);
        await withTimeout(operation, this.turnTimeoutMs(), "turn");
        outcome = accumulator.getOutcome();
      } catch (err) {
        if (err instanceof TurnTimeoutError) {
          const stopped = await this.abortTimedOutTurn();
          if (!stopped) {
            nextState = "faulted";
            this.error = "Agent 运行超时且未能正常停止";
          }
          outcome = {
            status: "error",
            text: "",
            error: { source: "timeout", message: this.error ?? "任务已中止，请重试" },
            warnings: [],
          };
          this.deps.logger.error(
            { project: this.deps.projectId, messageId: msg.messageId, stopped },
            "agent turn timed out",
          );
        } else {
          this.deps.logger.warn({ err, project: this.deps.projectId, messageId: msg.messageId }, "agent run failed");
          outcome = {
            status: "error",
            text: accumulator.accumulatedText.trim(),
            error: { source: "pi", message: formatUserFacingError(err) },
            warnings: [],
          };
        }
      } finally {
        unsubscribe();
      }

      await this.deps.transport.setTyping(turn, false);
      await this.deliverOutcome(turn, outcome, msg.messageId);
    } finally {
      this.deps.interaction.cancelUiWaiters("turn ended");
      this.state = nextState;
      this.deps.currentTurn.set(undefined);
    }
  }

  private async deliverOutcome(turn: TurnContext, outcome: TurnOutcome, messageId: string): Promise<void> {
    if (outcome.status === "success") {
      if (outcome.text) {
        if (this.deps.broadcastText) {
          const report = await this.deps.broadcastText(outcome.text);
          if (report && report.failed > 0) {
            this.deps.logger[report.succeeded === 0 ? "error" : "warn"](
              { project: this.deps.projectId, messageId, ...report },
              "agent reply broadcast delivery incomplete",
            );
          }
        } else {
          await this.reply(turn, outcome.text);
        }
      }
      if (outcome.warnings.length > 0) await this.reply(turn, formatWarnings(outcome.warnings));
      return;
    }

    if (outcome.status === "aborted") {
      const suffix = outcome.text ? "\n\n⏹ 任务已中止，上述内容可能不完整。" : "⏹ 已中止。";
      await this.reply(turn, `${outcome.text}${suffix}`);
      return;
    }

    const reason = formatUserFacingError(outcome.error.message);
    const prefix = outcome.text ? `${outcome.text}\n\n⚠️ 上述内容可能不完整。` : "⚠️";
    const label = outcome.error.source === "timeout" ? "Agent 运行超时" : "Agent 运行出错";
    await this.reply(turn, `${prefix} ${label}：${reason}`);
  }

  private turnTimeoutMs(): number {
    return normalizeDuration(this.deps.turnTimeoutMs, DEFAULT_TURN_TIMEOUT_MS);
  }

  private async abortTimedOutTurn(): Promise<boolean> {
    try {
      await withTimeout(
        (async () => {
          await this.deps.host.abort();
          await this.deps.host.waitForIdle();
        })(),
        normalizeDuration(this.deps.abortGraceMs, DEFAULT_ABORT_GRACE_MS),
        "abort",
      );
      return true;
    } catch (err) {
      this.deps.logger.error({ err, project: this.deps.projectId }, "timed-out agent did not stop");
      return false;
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
    this.state = "replacing";
    try {
      await withTimeout(
        this.deps.host.stop(),
        normalizeDuration(this.deps.abortGraceMs, DEFAULT_ABORT_GRACE_MS),
        "idle close",
      );
      this.state = "inactive";
      this.deps.logger.info({ project: this.deps.projectId }, "session auto-closed (idle)");
      if (this.deps.broadcastText) {
        await this.deps.broadcastText("本次会话已关闭").catch((err: unknown) =>
          this.deps.logger.warn({ err, project: this.deps.projectId }, "idle close broadcast failed"),
        );
      }
    } catch (err) {
      this.state = "faulted";
      this.error = formatUserFacingError(err);
      this.deps.logger.error({ err, project: this.deps.projectId }, "session auto-close failed");
      if (this.deps.broadcastText) {
        await this.deps.broadcastText(`⚠️ 会话自动关闭失败：${this.error}`).catch((sendErr: unknown) =>
          this.deps.logger.error({ err: sendErr, project: this.deps.projectId }, "idle-close error broadcast failed"),
        );
      }
    }
  }
}

class TurnTimeoutError extends Error {
  constructor(label: string) {
    super(`${label} timed out`);
    this.name = "TurnTimeoutError";
  }
}

function normalizeDuration(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (timeoutMs === 0) return promise;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TurnTimeoutError(label)), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function formatWarnings(warnings: TurnIssue[]): string {
  const messages = warnings.map((warning) => formatUserFacingError(warning.message));
  return `⚠️ 本轮有 Pi 扩展运行异常：${messages.join("；")}`;
}
