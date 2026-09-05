import type { InteractionPort } from "../pi/ports.js";
import type { SessionRuntimePort } from "../sessions/runtime-port.js";
import { SessionController } from "../sessions/session-controller.js";
import { CurrentTurn, toTurnContext } from "../sessions/turn-context.js";
import { CommandRouter } from "./command-router.js";
import { WeixinInteractionController } from "../weixin/interaction-controller.js";
import type {
  InboundMessage,
  WeixinTransport,
} from "../weixin/types.js";
import type { Logger } from "../util/logger.js";
import type { ProjectRuntimeState } from "./types.js";

/** A participant in a project: a real weixin sender reached via one account. */
export interface Participant {
  accountId: string;
  senderId: string;
  contextToken?: string;
  lastSeenAt: number;
}

function participantKey(accountId: string, senderId: string): string {
  return `${accountId}:${senderId}`;
}

/** Factory builds the per-project agent runtime (real PiSdkHost, or a fake in tests). */
export interface ProjectRuntimeFactoryContext {
  projectId: string;
  cwd: string;
  accounts: string[];
  transport: WeixinTransport;
  interaction: InteractionPort;
  logger: Logger;
}
export type ProjectRuntimeFactory = (ctx: ProjectRuntimeFactoryContext) => Promise<SessionRuntimePort>;

export interface ProjectRuntimeOptions {
  projectId: string;
  cwd: string;
  accounts: string[];
  /** Per-project outbound facade; also used by the weixin runtime extension. */
  transport: WeixinTransport;
  logger: Logger;
  factory: ProjectRuntimeFactory;
  /** Human label for an account (e.g. its name) used in "-- from weixin <name>". */
  resolveSenderName?: (accountId: string) => string;
  /** Idle window before the shared session is auto-closed (min for tests). */
  sessionIdleMs?: number;
}

export interface RuntimeStatusView {
  state: ProjectRuntimeState | "off";
  sessionFile?: string;
  sessionId?: string;
  model?: string;
  configuredTrust?: boolean;
  activeSessionTrust?: boolean;
  error?: string;
}

/**
 * One project's runtime: cwd-bound session + participants/broadcast.
 *
 * Fault isolation: whatever happens here (turn error, pi crash) is contained to
 * this instance. `state` mirrors the session controller's state machine while a
 * turn is active and the lifecycle (starting/stopping/error) otherwise.
 */
export class ProjectRuntime {
  readonly projectId: string;
  readonly cwd: string;
  readonly accounts: string[];
  state: ProjectRuntimeState | "off" = "starting";
  error?: string;

  private session?: SessionController;
  private readonly router = new CommandRouter();

  /** Registered project senders (real senderId, not account.userId). */
  private readonly participants = new Map<string, Participant>();
  /** Set once start() settles (extensions bound / session_start dispatched). */
  private resolveStarted!: () => void;
  private readonly started: Promise<void> = new Promise((r) => (this.resolveStarted = r));

  constructor(private readonly opts: ProjectRuntimeOptions) {
    this.projectId = opts.projectId;
    this.cwd = opts.cwd;
    this.accounts = opts.accounts;
  }

  async start(): Promise<void> {
    this.state = "starting";
    this.error = undefined;
    try {
      const currentTurn = new CurrentTurn();
      const interaction = new WeixinInteractionController({
        getCurrentTurn: () => currentTurn.get(),
        transport: this.opts.transport,
        logger: this.opts.logger,
      });
      const host = await this.opts.factory({
        projectId: this.projectId,
        cwd: this.cwd,
        accounts: this.accounts,
        transport: this.opts.transport,
        interaction,
        logger: this.opts.logger,
      });
      this.session = new SessionController({
        projectId: this.projectId,
        host,
        interaction,
        transport: this.opts.transport,
        currentTurn,
        logger: this.opts.logger,
        sessionIdleMs: this.opts.sessionIdleMs,
        broadcastText: (text) => this.broadcastToRegistry(text),
        resolveSenderLabel: (msg) => this.opts.resolveSenderName?.(msg.accountId) ?? msg.accountId,
      });
      await this.session.start();
      this.state = "idle";
      // No session yet (lazy); idle auto-close is scheduled on first message.
      this.opts.logger.info({ project: this.projectId, cwd: this.cwd }, "project runtime started");
    } catch (err) {
      this.state = "error";
      this.error = err instanceof Error ? err.message : String(err);
      this.opts.logger.error({ err, project: this.projectId }, "project runtime start failed");
      throw err;
    } finally {
      this.resolveStarted();
    }
  }

  /** Route one inbound message into this project's session. */
  async handleMessage(msg: InboundMessage): Promise<void> {
    // Any inbound (command or not) counts as activity and (re)registers the sender.
    this.registerParticipant(msg);

    // ① Wait until the runtime finished starting so the first tool call is gated
    //    against the fully-configured project scope.
    await this.started;

    // W1 fail-closed: a fatal initialization error put this project into the
    // error state. Refuse messages (per-project isolation; daemon keeps running).
    if (this.state === "error") {
      const reason = this.error ?? "unknown error";
      await this.opts.transport
        .sendText(toTurnContext(msg), `⚠️ 项目启动失败，已拒绝消息：${reason}`)
        .catch((err: unknown) =>
          this.opts.logger.warn({ err, project: this.projectId }, "error reply failed (ignored)"),
        );
      return;
    }

    const session = this.requireSession();
    const routed = this.router.classify(msg.text);

    // W4: only the daemon's explicitly-mapped commands enter slash handling.
    if (routed.kind === "daemon-command") {
      await session.handleCommand(routed.command, msg);
      this.reflectState(session);
      return;
    }
    if (routed.kind === "unknown-command") {
      await this.opts.transport
        .sendText(toTurnContext(msg), `未知命令 /${routed.text}，输入 /help 查看可用命令。`)
        .catch((err: unknown) => this.opts.logger.warn({ err, project: this.projectId }, "unknown-command reply failed"));
      return;
    }

    // ③ Notify other project participants when a sender speaks (ordinary messages only).
    await this.notifyOthers(msg).catch((err: unknown) =>
      this.opts.logger.warn({ err, project: this.projectId }, "notify others failed"),
    );

    try {
      await session.handleUserMessage(msg);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.opts.logger.warn({ err, project: this.projectId }, "project message handling error");
      this.state = "error";
      this.error = message;
      return;
    }

    this.reflectState(session);
  }

  /** Reflect the session state machine into the project lifecycle state. */
  private reflectState(session: SessionController): void {
    if (this.state === "stopping") return;
    const s = session.getState();
    if (s === "busy" || s === "replacing") this.state = "busy";
    else if (s === "faulted") {
      this.state = "error";
      this.error = this.error ?? "session faulted";
    } else this.state = "idle";
  }

  async stop(): Promise<void> {
    this.state = "stopping";
    await this.session?.stop().catch((err: unknown) =>
      this.opts.logger.warn({ err, project: this.projectId }, "session stop error"),
    );
    this.session = undefined;
    this.state = "off";
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  getStatus(): RuntimeStatusView {
    let state: ProjectRuntimeState | "off" = this.state;
    const session = this.session;
    // Reflect the live session state machine (mirrors the old bridge.getState()).
    if (session && this.state !== "error" && this.state !== "stopping" && this.state !== "off") {
      const s = session.getState();
      if (s === "busy" || s === "replacing") state = "busy";
      else if (s === "faulted") state = "error";
      else state = "idle";
    }
    const s = session?.getStatus();
    return {
      state,
      sessionFile: s?.sessionFile,
      sessionId: s?.sessionId,
      model: s?.model,
      configuredTrust: s?.configuredTrust,
      activeSessionTrust: s?.activeSessionTrust,
      error: this.error,
    };
  }

  // --- participants / broadcast --------------------------------------------

  private registerParticipant(msg: InboundMessage): void {
    this.participants.set(participantKey(msg.accountId, msg.senderId), {
      accountId: msg.accountId,
      senderId: msg.senderId,
      contextToken: msg.contextToken,
      lastSeenAt: Date.now(),
    });
  }

  /** Send a proactive text to a participant via their account's transport. */
  private async sendTo(p: Participant, text: string): Promise<void> {
    await this.opts.transport.sendText(
      { accountId: p.accountId, senderId: p.senderId, messageId: "broadcast", contextToken: p.contextToken },
      text,
    );
  }

  /** ④ Broadcast the agent's final reply to every registered participant. */
  private readonly broadcastToRegistry = async (text: string): Promise<void> => {
    for (const p of this.participants.values()) {
      await this.sendTo(p, text).catch((err: unknown) =>
        this.opts.logger.warn(
          { err, account: p.accountId, sender: p.senderId },
          "broadcast to participant failed",
        ),
      );
    }
  };

  /** ③ Notify every other participant that a sender spoke. */
  private async notifyOthers(msg: InboundMessage): Promise<void> {
    const originKey = participantKey(msg.accountId, msg.senderId);
    const name = this.opts.resolveSenderName?.(msg.accountId) ?? msg.accountId;
    const text = msg.text?.trim() ? msg.text.trim() : attachmentPlaceholder(msg);
    const notify = `${name}: ${text}`;
    for (const [key, p] of this.participants) {
      if (key === originKey) continue;
      await this.sendTo(p, notify).catch((err: unknown) =>
        this.opts.logger.warn(
          { err, account: p.accountId, sender: p.senderId },
          "notify other participant failed",
        ),
      );
    }
  }

  private requireSession(): SessionController {
    if (!this.session) throw new Error(`project "${this.projectId}" session not started`);
    return this.session;
  }
}

function attachmentPlaceholder(msg: InboundMessage): string {
  const kind = msg.attachments[0]?.kind;
  if (kind === "image") return "[图片]";
  if (kind === "file") return "[文件]";
  if (kind === "video") return "[视频]";
  if (kind === "voice") return "[语音]";
  return "[消息]";
}
