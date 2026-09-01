import fs from "node:fs";
import path from "node:path";
import { PiRuntime } from "./agent/runtime.js";
import { createWeixinRuntimeExtension } from "./agent/runtime-extension.js";
import { WeixinUIContext } from "./agent/ui-context.js";
import { MultiAccountTransport } from "./bridge/multi-account-transport.js";
import { Bridge } from "./bridge/router.js";
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
 */
export class Daemon {
  private stopped = false;
  private keepAlive: NodeJS.Timeout | undefined;
  private readonly shutdownPromise: Promise<void>;
  private resolveShutdown!: () => void;
  private runtime: PiRuntime | undefined;
  private bridge: Bridge | undefined;
  private transports: ILinkWeixinTransport[] = [];
  private multiTransport = new MultiAccountTransport();

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

    // --- Project-local daemon directories (media inbox + outbound staging) ---
    const inboxDir = path.join(cwd, ".pi-weixin", "inbox");
    const tmpDir = path.join(cwd, ".pi-weixin", "tmp");
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    ensurePiWeixinGitignore(cwd, logger);

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
        inboxDir,
        logger,
      });
      await transport.start();
      this.transports.push(transport);
      this.multiTransport.register(accountId, transport);
    }

    // --- Bridge (M6): routes inbound messages; runtime bound below ---
    this.bridge = new Bridge({ transport: this.multiTransport, logger });

    // --- Pi runtime (M2) + weixin runtime extension (M3) + weixin UI (M9) ---
    // weixin_send_file routes through the multi-account facade, so it always
    // lands on the transport owning the current turn's account.
    this.runtime = new PiRuntime({
      cwd,
      logger,
      extensionFactories: [
        createWeixinRuntimeExtension({
          transport: this.multiTransport,
          getCurrentTurn: () => this.bridge?.getCurrentTurn(),
          cwd,
          tmpDir,
          logger,
        }),
      ],
      uiContext: new WeixinUIContext({
        broker: this.bridge,
        transport: this.multiTransport,
        getCurrentTurn: () => this.bridge?.getCurrentTurn(),
        logger,
      }),
    });
    await this.runtime.start();

    // Bind bridge to runtime and start listening for inbound messages.
    this.bridge.bindRuntime(this.runtime);
    this.bridge.attach();

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

    this.bridge?.detach();
    await this.multiTransport.stop().catch((err: unknown) => logger.warn({ err }, "multi transport stop error"));

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

/**
 * Make sure the project git repo ignores the daemon's .pi-weixin/ directory
 * (media inbox + staging). Best-effort; never rewrites existing entries.
 */
function ensurePiWeixinGitignore(cwd: string, logger: Logger): void {
  try {
    const gitignorePath = path.join(cwd, ".gitignore");
    const entry = ".pi-weixin/";
    let content = "";
    if (fs.existsSync(gitignorePath)) {
      content = fs.readFileSync(gitignorePath, "utf-8");
    }
    if (content.split(/\r?\n/).some((line) => line.trim() === entry)) {
      return;
    }
    const updated = content.endsWith("\n") || content === "" ? `${content}${entry}\n` : `${content}\n${entry}\n`;
    fs.writeFileSync(gitignorePath, updated, "utf-8");
    logger.info({ gitignorePath }, "added .pi-weixin/ to project .gitignore");
  } catch (err) {
    logger.warn({ err }, "failed to update project .gitignore");
  }
}
