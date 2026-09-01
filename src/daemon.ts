import { PiRuntime } from "./agent/runtime.js";
import type { Logger } from "./util/logger.js";
import { loadWeixinAccount } from "./weixin/auth/accounts.js";
import { ILinkWeixinTransport } from "./weixin/transport.js";

export interface DaemonOptions {
  /** Project working directory. One daemon = one project. */
  cwd: string;
  /** Weixin account ids to monitor. Multiple accounts share one AgentSession. */
  accounts: string[];
  logger: Logger;
}

/**
 * pi-weixin-daemon composition root.
 *
 * Owns: weixin transports (one per account) -> bridge (busy state, TurnContext,
 * command routing) -> Pi AgentSessionRuntime (bound to `cwd`).
 *
 * Milestone roadmap:
 *  M1: lifecycle skeleton (start/stop + signals)            [done]
 *  M2: Pi SDK runtime                                       [done]
 *  M3: runtime weixin extension (weixin_send_file)          [done]
 *  M4: Tencent QR login / account storage                   [done]
 *  M5: monitors (getUpdates long-poll)                      [this]
 *  M6: text bridge (Weixin <-> Pi <-> Weixin)
 *  M7: typing / context_token
 *  M8: media
 *  M9: extension UI (confirm/select/input/notify)
 *  M10: productionization (systemd, structured logging, doctor)
 */
export class Daemon {
  private stopped = false;
  private keepAlive: NodeJS.Timeout | undefined;
  private readonly shutdownPromise: Promise<void>;
  private resolveShutdown!: () => void;
  private runtime: PiRuntime | undefined;
  private transports: ILinkWeixinTransport[] = [];

  constructor(private readonly opts: DaemonOptions) {
    this.shutdownPromise = new Promise((resolve) => {
      this.resolveShutdown = resolve;
    });
  }

  get cwd(): string {
    return this.opts.cwd;
  }

  get accounts(): readonly string[] {
    return this.opts.accounts;
  }

  async start(): Promise<void> {
    const { logger, cwd, accounts } = this.opts;
    logger.info({ cwd, accounts }, "daemon starting");

    // Keep the event loop alive so the daemon runs until stop() is called.
    this.keepAlive = setInterval(() => {}, 1 << 30);

    // --- Weixin transports (M5): one long-poll monitor per account ---
    for (const accountId of accounts) {
      const account = loadWeixinAccount(accountId);
      if (!account?.token) {
        throw new Error(
          `account "${accountId}" has no saved token; run \`pi-weixin-daemon login\` first`,
        );
      }
      const transport = new ILinkWeixinTransport({
        accountId,
        token: account.token,
        logger,
      });
      await transport.start();
      this.transports.push(transport);
    }

    // --- Pi runtime (M2) ---
    // M6+: weixin runtime extension factories + UI context + bridge wiring
    this.runtime = new PiRuntime({ cwd, logger });
    await this.runtime.start();

    logger.info(
      {
        accounts: this.transports.length,
        session: this.runtime.getStatus().sessionFile,
      },
      "daemon started",
    );
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const { logger } = this.opts;
    logger.info("daemon stopping");

    for (const transport of this.transports) {
      await transport.stop().catch((err: unknown) => logger.warn({ err }, "transport stop error"));
    }
    this.transports = [];

    await this.runtime?.stop().catch((err: unknown) => logger.warn({ err }, "runtime stop error"));
    this.runtime = undefined;

    if (this.keepAlive) clearInterval(this.keepAlive);
    logger.info("daemon stopped");
    this.resolveShutdown();
  }

  /** Resolves once stop() has completed. Keeps the process alive while running. */
  waitForShutdown(): Promise<void> {
    return this.shutdownPromise;
  }
}
