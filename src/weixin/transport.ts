import type { Logger } from "../util/logger.js";
import type { InboundMessage, TurnContext, WeixinTransport } from "../bridge/types.js";
import { getConfig, notifyStart, notifyStop, sendTyping as sendTypingApi } from "./api/api.js";
import { WeixinConfigManager } from "./api/config-cache.js";
import { TypingStatus, type WeixinMessage } from "./api/types.js";
import { resolveWeixinBaseUrl } from "./auth/accounts.js";
import { monitorWeixinProvider } from "./monitor/monitor.js";
import { normalizeInboundMessage } from "./normalize.js";
import { sendTextMessage } from "./messaging/send.js";
import { restoreContextTokens, setContextToken } from "./storage/context-token.js";

export interface WeixinTransportOptions {
  accountId: string;
  /** API base URL; defaults to the account's stored baseUrl or the official endpoint. */
  baseUrl?: string;
  token?: string;
  logger: Logger;
  cdnBaseUrl?: string;
}

/**
 * WeixinTransport facade for one account: owns the long-poll monitor, message
 * normalization, outbound text/file sending and the typing indicator.
 *
 * The agent layer only ever sees InboundMessage/TurnContext (bridge/types).
 */
export class ILinkWeixinTransport implements WeixinTransport {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly configManager: WeixinConfigManager;
  private abortController: AbortController | undefined;
  private monitorPromise: Promise<void> | undefined;
  private handlers: Array<(message: InboundMessage) => Promise<void>> = [];
  private stopped = false;

  constructor(private readonly opts: WeixinTransportOptions) {
    this.baseUrl = opts.baseUrl ?? resolveWeixinBaseUrl(opts.accountId);
    this.token = opts.token;
    this.configManager = new WeixinConfigManager(
      { baseUrl: this.baseUrl, token: this.token },
      opts.logger,
    );
  }

  get accountId(): string {
    return this.opts.accountId;
  }

  async start(): Promise<void> {
    if (this.monitorPromise) return;
    const log = this.opts.logger;

    restoreContextTokens(this.opts.accountId);

    // Best-effort start notification (mirrors Tencent's notifyStart on channel start).
    try {
      await notifyStart({ baseUrl: this.baseUrl, token: this.token, logger: log });
    } catch (err) {
      log.warn(`notifyStart failed (ignored): ${String(err)}`);
    }

    this.abortController = new AbortController();
    this.monitorPromise = monitorWeixinProvider({
      baseUrl: this.baseUrl,
      token: this.token,
      accountId: this.opts.accountId,
      abortSignal: this.abortController.signal,
      logger: log,
      onInbound: async (raw: WeixinMessage) => {
        await this.handleInbound(raw);
      },
    });
    this.monitorPromise.catch((err: unknown) => {
      log.error({ err }, `monitor crashed for account ${this.opts.accountId}`);
    });
    log.info({ accountId: this.opts.accountId, baseUrl: this.baseUrl }, "transport started");
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const log = this.opts.logger;
    this.abortController?.abort();
    await this.monitorPromise?.catch(() => {});
    this.monitorPromise = undefined;
    // Best-effort stop notification.
    try {
      await notifyStop({ baseUrl: this.baseUrl, token: this.token, logger: log });
    } catch (err) {
      log.warn(`notifyStop failed (ignored): ${String(err)}`);
    }
    log.info({ accountId: this.opts.accountId }, "transport stopped");
  }

  async sendText(ctx: TurnContext, text: string): Promise<void> {
    await sendTextMessage({
      to: ctx.senderId,
      text,
      opts: {
        baseUrl: this.baseUrl,
        token: this.token,
        contextToken: ctx.contextToken,
        logger: this.opts.logger,
      },
    });
  }

  /** v0.1 outbound media is implemented in M8 (CDN upload + native FILE message). */
  async sendFile(_ctx: TurnContext, _path: string, _caption?: string): Promise<void> {
    throw new Error("sendFile not implemented yet (M8: CDN upload)");
  }

  async setTyping(ctx: TurnContext, typing: boolean): Promise<void> {
    const log = this.opts.logger;
    try {
      const { typingTicket } = await this.configManager.getForUser(ctx.senderId, ctx.contextToken);
      if (!typingTicket) {
        log.debug(`no typing ticket for user ${ctx.senderId}, skipping sendTyping`);
        return;
      }
      await sendTypingApi({
        baseUrl: this.baseUrl,
        token: this.token,
        body: {
          ilink_user_id: ctx.senderId,
          typing_ticket: typingTicket,
          status: typing ? TypingStatus.TYPING : TypingStatus.CANCEL,
        },
        logger: log,
      });
    } catch (err) {
      log.warn(`sendTyping failed (ignored): ${String(err)}`);
    }
  }

  onMessage(handler: (message: InboundMessage) => Promise<void>): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  private async handleInbound(raw: WeixinMessage): Promise<void> {
    const msg = normalizeInboundMessage(this.opts.accountId, raw);
    if (msg.senderId && msg.contextToken) {
      setContextToken(this.opts.accountId, msg.senderId, msg.contextToken);
    }
    for (const handler of [...this.handlers]) {
      await handler(msg);
    }
  }
}
