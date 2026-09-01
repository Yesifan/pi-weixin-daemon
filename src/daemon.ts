import type { Logger } from "./util/logger.js";

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
 * Owns: weixin monitors (one per account) -> bridge (busy state, TurnContext,
 * command routing) -> Pi AgentSessionRuntime (bound to `cwd`).
 *
 * Milestone roadmap:
 *  M1: lifecycle skeleton (start/stop + signals)
 *  M2: Pi SDK runtime
 *  M3: runtime weixin extension (weixin_send_file)
 *  M4: Tencent QR login / account storage
 *  M5: monitors (getUpdates long-poll)
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
    // (Replaced by long-lived monitor loops in M5+.)
    this.keepAlive = setInterval(() => {}, 1 << 30);

    // M2+: create PiRuntime + bind session
    // M5+: start per-account monitors

    logger.info("daemon started");
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const { logger } = this.opts;
    logger.info("daemon stopping");
    if (this.keepAlive) clearInterval(this.keepAlive);
    // M2+: dispose runtime
    // M5+: stop monitors
    logger.info("daemon stopped");
    this.resolveShutdown();
  }

  /** Resolves once stop() has completed. Keeps the process alive while running. */
  waitForShutdown(): Promise<void> {
    return this.shutdownPromise;
  }
}
