import type { InteractionPort } from "../pi/ports.js";
import type { SessionRuntimePort } from "../sessions/runtime-port.js";
import { parseCommand } from "../bridge/commands.js";
import { Bridge } from "../bridge/router.js";
import type {
  InboundMessage,
  WeixinTransport,
} from "../weixin/types.js";
import type { Logger } from "../util/logger.js";
import type { ProjectRuntimeState } from "./types.js";

/** Default auto-close idle window for a shared session (10 minutes). */
export const DEFAULT_SESSION_IDLE_MS = 10 * 60 * 1000;

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
  trust?: boolean;
  error?: string;
}

/**
 * One project's runtime: cwd-bound AgentRuntime + Bridge (busy/abort/turn scope).
 *
 * Fault isolation: whatever happens here (turn error, pi crash) is contained to
 * this instance. `state` mirrors the bridge's concurrency state while a turn is
 * active and the lifecycle (starting/stopping/error) otherwise.
 */
export class ProjectRuntime {
  readonly projectId: string;
  readonly cwd: string;
  readonly accounts: string[];
  state: ProjectRuntimeState | "off" = "starting";
  error?: string;

  private runtime?: SessionRuntimePort;
  private bridge?: Bridge;

  /** Registered project senders (real senderId, not account.userId). */
  private readonly participants = new Map<string, Participant>();
  private lastActivityAt = Date.now();
  private sessionExpired = false;
  private idleTimer: NodeJS.Timeout | undefined;
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
      this.bridge = new Bridge({
        transport: this.opts.transport,
        logger: this.opts.logger,
        resolveSenderLabel: (msg) => this.opts.resolveSenderName?.(msg.accountId) ?? msg.accountId,
        broadcastText: (text) => this.broadcastToRegistry(text),
      });
      this.runtime = await this.opts.factory({
        projectId: this.projectId,
        cwd: this.cwd,
        accounts: this.accounts,
        transport: this.opts.transport,
        interaction: this.bridge,
        logger: this.opts.logger,
      });
      await this.runtime.start();
      this.bridge.bindRuntime(this.runtime);
      this.state = "idle";
      this.lastActivityAt = Date.now();
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

  /** Route one inbound message into this project's bridge. */
  async handleMessage(msg: InboundMessage): Promise<void> {
    // Any inbound (command or not) counts as activity and (re)registers the sender.
    this.registerParticipant(msg);
    this.lastActivityAt = Date.now();
    this.scheduleIdleCheck();

    // ① Wait until the runtime finished starting (extensions bound, session_start
    //    dispatched) so the first tool call is gated against the fully-configured
    //    project scope, not an init/global-only state.
    await this.started;

    // ① A session was auto-closed while idle: start a fresh one on next message.
    if (this.sessionExpired) {
      this.sessionExpired = false;
      try {
        await this.runtime?.newSession();
        this.opts.logger.info({ project: this.projectId }, "new session after idle close");
      } catch (err) {
        this.opts.logger.warn({ err, project: this.projectId }, "newSession after idle close failed");
      }
    }

    // ③ Notify other project participants when a sender speaks (ordinary messages only).
    if (!parseCommand(msg.text)) {
      await this.notifyOthers(msg).catch((err: unknown) =>
        this.opts.logger.warn({ err, project: this.projectId }, "notify others failed"),
      );
    }

    const bridge = this.requireBridge();
    try {
      await bridge.ingest(msg);
      // Bridge may flip to busy/RUNNING during the turn; reflect lifecycle only.
      if (this.state !== "error" && this.state !== "stopping") {
        this.state = bridge.getState() === "IDLE" ? "idle" : "busy";
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.opts.logger.warn({ err, project: this.projectId }, "project message handling error");
      this.state = "error";
      this.error = message;
    }
  }

  async abort(): Promise<void> {
    this.state = "stopping";
    try {
      await this.runtime?.abort();
    } catch (err) {
      this.opts.logger.warn({ err, project: this.projectId }, "abort error");
    } finally {
      this.state = "idle";
    }
  }

  async stop(): Promise<void> {
    this.state = "stopping";
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    this.bridge?.detach();
    await this.runtime?.stop().catch((err: unknown) =>
      this.opts.logger.warn({ err, project: this.projectId }, "pi runtime stop error"),
    );
    this.runtime = undefined;
    this.bridge = undefined;
    this.state = "off";
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  getStatus(): RuntimeStatusView {
    let state: ProjectRuntimeState | "off" = this.state;
    const bridge = this.bridge;
    if (bridge && this.state !== "error" && this.state !== "stopping" && this.state !== "off") {
      state = bridge.getState() === "IDLE" ? "idle" : "busy";
    }
    const s = this.runtime?.getStatus();
    return {
      state,
      sessionFile: s?.sessionFile,
      sessionId: s?.sessionId,
      model: s?.model,
      trust: s?.configuredTrust,
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

  // --- idle auto-close -------------------------------------------------------

  private scheduleIdleCheck(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const idleMs = this.opts.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
    if (!Number.isFinite(idleMs) || idleMs <= 0) return;
    this.idleTimer = setTimeout(() => void this.checkIdle(), idleMs);
  }

  /** ① Auto-close the shared session after an idle window (broadcast + lazy new session). */
  private async checkIdle(): Promise<void> {
    if (this.state === "stopping" || this.state === "off" || this.state === "error") return;
    if (this.sessionExpired) return;
    const idleMs = this.opts.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
    const now = Date.now();
    // Idle auto-close only applies once a session exists; before lazy creation
    // there is nothing to close.
    if (!this.runtime?.hasSession() || this.bridge?.getState() !== "IDLE" || now - this.lastActivityAt < idleMs) {
      this.scheduleIdleCheck();
      return;
    }
    this.sessionExpired = true;
    this.opts.logger.info({ project: this.projectId }, "session auto-closed (idle)");
    await this.broadcastToRegistry("本次会话已关闭");
  }

  private requireBridge(): Bridge {
    if (!this.bridge) throw new Error(`project "${this.projectId}" bridge not started`);
    return this.bridge;
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
