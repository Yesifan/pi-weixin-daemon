import fs from "node:fs";
import type { InteractionPort } from "../pi/ports.js";
import type { HostImage, HostPromptInput } from "../pi/types.js";
import type { SessionRuntimePort } from "../sessions/runtime-port.js";
import { CurrentTurn, toTurnContext } from "../sessions/turn-context.js";
import type { Logger } from "../util/logger.js";
import type {
  InboundAttachment,
  InboundMessage,
  TurnContext,
  WeixinTransport,
} from "../weixin/types.js";
import { CommandRouter } from "./commands.js";
import { ResponseAccumulator } from "./response.js";
import { BUSY_REPLY, type BridgeState } from "./state.js";

interface UiWaiter {
  accountId: string;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
}
export interface BridgeDeps {
  /** Bound after runtime creation via bindRuntime(). */
  runtime?: SessionRuntimePort;
  transport: WeixinTransport;
  logger: Logger;
  /** Human label for an inbound sender (used in "-- from weixin <name>"). Optional. */
  resolveSenderLabel?: (msg: InboundMessage) => string;
  /** Broadcast a turn's final reply to all project participants. Optional. */
  broadcastText?: (text: string) => Promise<void>;
}

/**
 * The thin glue between weixin transport(s) and the Pi runtime.
 *
 * - one in-flight turn at a time; no queue
 * - while busy, ordinary messages are refused immediately
 * - commands route through CommandRouter in every state
 * - replies (text/files/UI) always go back to the TurnContext origin account
 */
export class Bridge implements InteractionPort {
  private runtime: SessionRuntimePort | undefined;
  private state: BridgeState = "IDLE";
  private currentTurn = new CurrentTurn();
  private turnPromise: Promise<void> | undefined;
  private unsubscribe: (() => void) | undefined;
  private uiWaiters: UiWaiter[] = [];
  private readonly commandRouter: CommandRouter;

  constructor(private readonly deps: BridgeDeps) {
    this.commandRouter = new CommandRouter({
      getRuntime: () => this.requireRuntime(),
      state: () => this.state,
      getStatus: () => this.formatStatus(),
      logger: deps.logger,
    });
  }

  bindRuntime(runtime: SessionRuntimePort): void {
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

  /**
   * Process a single inbound message. Called directly by the daemon's dispatcher
   * (account -> project -> ProjectRuntime.handleMessage). In the multi-project
   * model the bridge lists for no transport subscription; inbound arrives here.
   */
  ingest(msg: InboundMessage): Promise<void> {
    return this.onMessage(msg);
  }

  private async onMessage(msg: InboundMessage): Promise<void> {
    const log = this.deps.logger;

    // 1. Commands are allowed even while the agent is busy / waiting for UI.
    const reply = await this.commandRouter.tryHandle(msg);
    if (reply !== undefined) {
      await this.deps.transport.sendText(toTurnContext(msg), reply);
      return;
    }

    // 2. WAITING_FOR_UI: only the turn origin account's next ordinary message
    //    is a UI response; everyone else is still busy.
    if (this.state === "WAITING_FOR_UI") {
      const turn = this.currentTurn.get();
      if (turn && msg.accountId === turn.accountId && msg.senderId === turn.senderId) {
        log.info({ accountId: msg.accountId }, "UI response received");
        this.tryResolveUi(turn, msg.text ?? "");
      } else {
        log.info({ accountId: msg.accountId, senderId: msg.senderId }, "busy refusal (ui)");
        await this.deps.transport.sendText(toTurnContext(msg), BUSY_REPLY);
      }
      return;
    }

    // 3. Busy refusal (no queue, no steering).
    if (this.turnPromise) {
      log.info(
        { accountId: msg.accountId, senderId: msg.senderId, state: this.state },
        "busy refusal",
      );
      await this.deps.transport.sendText(toTurnContext(msg), BUSY_REPLY);
      return;
    }

    // 4. Start the turn. Sequential via turnPromise: while it is set, all
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
        await runtime.prompt(buildPromptInput(msg, this.deps.resolveSenderLabel?.(msg)));
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
        // ④ When a broadcast hook is provided, the project fan-outs the reply to
        // every participant; otherwise keep current origin-only behavior.
        if (this.deps.broadcastText) {
          await this.deps.broadcastText(finalText);
        } else {
          await this.deps.transport.sendText(turn, finalText);
        }
      }
    } finally {
      this.cancelUiWaiters("turn ended");
      this.state = "IDLE";
      this.currentTurn.set(undefined);
      this.turnPromise = undefined;
    }
  }

  // --- InteractionPort -------------------------------------------------------

  beginUiInteraction(): void {
    this.state = "WAITING_FOR_UI";
  }

  endUiInteraction(): void {
    if (this.state === "WAITING_FOR_UI") {
      this.state = "RUNNING";
    }
  }

  isUiInteractionActive(): boolean {
    return this.state === "WAITING_FOR_UI";
  }

  tryResolveUi(turn: TurnContext, text: string): boolean {
    const waiter = this.uiWaiters.find((w) => w.accountId === turn.accountId);
    if (!waiter) return false;
    waiter.resolve(text);
    return true;
  }

  waitForResponse(
    turn: TurnContext,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const waiter: UiWaiter = {
        accountId: turn.accountId,
        resolve: (text: string) => {
          cleanup();
          resolve(text);
        },
        reject: (err: Error) => {
          cleanup();
          reject(err);
        },
      };
      const cleanup = () => {
        this.uiWaiters = this.uiWaiters.filter((w) => w !== waiter);
        opts?.signal?.removeEventListener("abort", onAbort);
        if (timeoutHandle) clearTimeout(timeoutHandle);
      };
      const onAbort = () => waiter.reject(new Error("UI interaction aborted"));
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      let timeoutHandle: NodeJS.Timeout | undefined;
      if (opts?.timeoutMs) {
        timeoutHandle = setTimeout(() => waiter.reject(new Error("UI interaction timed out")), opts.timeoutMs);
      }
      this.uiWaiters.push(waiter);
    });
  }

  cancelUiWaiters(reason: string): void {
    for (const waiter of this.uiWaiters.splice(0)) {
      waiter.reject(new Error(reason));
    }
  }

  sendText(turn: TurnContext, text: string): Promise<void> {
    return this.deps.transport.sendText(turn, text);
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
      `Trusted: ${status?.configuredTrust ?? "?"}`,
    ].join("\n");
  }

  private requireRuntime(): SessionRuntimePort {
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

/**
 * Build a Hermes-style context note for a non-image attachment (file/video/voice).
 * Tells the agent what the attachment is, where it is, and to read/process it
 * itself rather than punting back to the user.
 */
function contextNote(a: InboundAttachment): string {
  const path = a.localPath;
  const name = a.filename ?? "附件";
  switch (a.kind) {
    case "file":
      return `[用户发送了一个文件: '${name}'。已保存于: ${path}。内容未内联（可能是 PDF/DOCX 等二进制）。若用户的请求涉及该文件内容，请自己用终端或文档工具提取文本后再回答，而不是让用户粘贴内容。]`;
    case "video":
      return `[用户发送了一个视频: '${name}'。已保存于: ${path}。若用户的请求涉及视频内容，请自己用视频分析/媒体工具检查后再回答，而不是让用户描述。]`;
    case "voice":
      return `[用户发送了一条语音消息，已保存于: ${path}。]`;
    default:
      return `[用户发送了一个附件: '${name}'。已保存于: ${path}。]`;
  }
}

/**
 * Build the domain prompt input: message text + context notes for non-image
 * attachments (files/videos/voice; images go as true multimodal input) + any
 * failed media note, and an optional "-- from weixin <name>" sender marker.
 */
function buildPromptInput(msg: InboundMessage, senderLabel?: string): HostPromptInput {
  const parts: string[] = [msg.text ?? ""];
  for (const a of msg.attachments) {
    if (a.kind === "image") continue; // passed as images
    parts.push(contextNote(a));
  }
  for (const f of msg.mediaFailures ?? []) {
    parts.push(`[附件下载失败，可能无法处理: ${f.filename ?? f.kind}]`);
  }
  if (senderLabel) {
    // Put the sender marker on its own line, preceded by a blank line.
    parts.push("");
    parts.push(`-- from weixin ${senderLabel}`);
  }
  return { text: parts.join("\n"), images: imagesOf(msg) };
}

/** Weixin images -> true multimodal domain images (base64 + detected mime). */
function imagesOf(msg: InboundMessage): HostImage[] | undefined {
  const images = msg.attachments.filter((a) => a.kind === "image");
  if (images.length === 0) return undefined;
  const contents: HostImage[] = [];
  for (const img of images) {
    try {
      const buf = fs.readFileSync(img.localPath);
      contents.push({
        data: buf.toString("base64"),
        mimeType: img.mimeType ?? "image/jpeg",
      });
    } catch {
      // Skip unreadable images; the prompt text still flows.
    }
  }
  return contents.length > 0 ? contents : undefined;
}
