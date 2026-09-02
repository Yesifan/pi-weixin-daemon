import fs from "node:fs";
import path from "node:path";
import { PiRuntime } from "./agent/runtime.js";
import { createWeixinRuntimeExtension } from "./agent/runtime-extension.js";
import { WeixinUIContext } from "./agent/ui-context.js";
import { AccountManager } from "./accounts/account-manager.js";
import type { InboundMessage, WeixinTransport } from "./bridge/types.js";
import { migrateLegacyAccounts } from "./config/paths.js";
import { ProjectManager } from "./projects/project-manager.js";
import type {
  ProjectRuntimeFactory,
  ProjectRuntimeFactoryContext,
} from "./projects/project-runtime.js";
import { ProjectStore } from "./projects/project-store.js";
import type { ProjectStoreData } from "./projects/types.js";
import { loadWeixinAccount, listIndexedWeixinAccountIds } from "./weixin/auth/accounts.js";
import { ILinkWeixinTransport } from "./weixin/transport.js";
import type { Logger } from "./util/logger.js";

export interface DaemonDeps {
  logger: Logger;
  /** Inject for tests; default reads from ProjectStore. */
  store?: ProjectStore;
  /** Inject for tests; default builds a real ILinkWeixinTransport per account. */
  getAccountTransport?: (
    accountId: string,
    token?: string,
    baseUrl?: string,
  ) => Promise<WeixinTransport>;
  /** Inject for tests; default builds a real PiRuntime bound to the project cwd. */
  projectPiFactory?: ProjectRuntimeFactory;
}

/** Default project Pi factory: weixin tool + UI context wired to the project bridge. */
async function createProjectPiRuntime(ctx: ProjectRuntimeFactoryContext): Promise<PiRuntime> {
  const { cwd, transport, bridge, logger } = ctx;
  const tmpDir = path.join(cwd, ".pi-weixin", "tmp");
  const inboxDir = path.join(cwd, ".pi-weixin", "inbox");
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(inboxDir, { recursive: true });
  return new PiRuntime({
    cwd,
    logger,
    extensionFactories: [
      createWeixinRuntimeExtension({
        transport,
        getCurrentTurn: () => bridge.getCurrentTurn(),
        cwd,
        tmpDir,
        logger,
      }),
    ],
    uiContext: new WeixinUIContext({
      broker: bridge,
      transport,
      getCurrentTurn: () => bridge.getCurrentTurn(),
      logger,
    }),
  });
}

const defaultProjectPiFactory: ProjectRuntimeFactory = (ctx) => createProjectPiRuntime(ctx);

/**
 * pi-weixin-daemon composition root (one long-running daemon, many projects).
 *
 * Owns: config (ProjectStore) -> AccountManager (per-account transports) ->
 * ProjectManager (ProjectRuntime per project) -> account->project dispatch.
 * Graceful shutdown stops projects first, then account monitors.
 */
export class Daemon {
  private stopped = false;
  private keepAlive: NodeJS.Timeout | undefined;
  private readonly shutdownPromise: Promise<void>;
  private resolveShutdown!: () => void;
  private config!: ProjectStoreData;
  private readonly accountManager: AccountManager;
  private readonly projectManager: ProjectManager;
  private readonly store: ProjectStore;
  private accountTransport: (
    accountId: string,
    token?: string,
    baseUrl?: string,
  ) => Promise<WeixinTransport>;

  constructor(private readonly deps: DaemonDeps) {
    this.store = deps.store ?? new ProjectStore();
    const logger = deps.logger;
    this.accountManager = new AccountManager({ logger });
    this.projectManager = new ProjectManager({
      getTransport: (id) => this.accountManager.getTransport(id),
      factory: deps.projectPiFactory ?? defaultProjectPiFactory,
      logger,
    });
    this.accountTransport =
      deps.getAccountTransport ??
      ((accountId, token, baseUrl) =>
        Promise.resolve(
          new ILinkWeixinTransport({
            accountId,
            token,
            baseUrl,
            resolveInboxDir: (id) => this.resolveInboxDir(id),
            logger,
          }),
        ));
    this.shutdownPromise = new Promise((resolve) => {
      this.resolveShutdown = resolve;
    });
  }

  /** The live project statuses (for RPC / project list). */
  getProjectStatuses() {
    return this.projectManager.listStatuses();
  }

  async start(): Promise<void> {
    const { logger } = this.deps;
    migrateLegacyAccounts();
    this.config = this.store.read();
    logger.info({ projects: Object.keys(this.config.projects).length }, "daemon starting");

    // Keep the event loop alive until stop().
    this.keepAlive = setInterval(() => {}, 1 << 30);

    // --- Account monitors: one per registered account, independent of project ---
    for (const accountId of listIndexedWeixinAccountIds()) {
      const account = loadWeixinAccount(accountId);
      if (!account?.token) {
        logger.warn({ account: accountId }, "account has no token, skipping monitor");
        continue;
      }
      const transport = await this.accountTransport(accountId, account.token, account.baseUrl);
      await this.accountManager.register(accountId, transport, account.userId);
    }

    // --- Project runtimes: reconcile desired state (enabled) from config ---
    await this.projectManager.sync(this.configList());

    // --- Inbound dispatch: account -> project -> runtime ---
    this.accountManager.onInbound((msg) => this.projectManager.dispatch(msg.accountId, msg));

    logger.info(
      { accounts: this.accountManager.listAccounts().length, projects: this.getProjectStatuses().length },
      "daemon started",
    );
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const { logger } = this.deps;
    logger.info("daemon stopping");

    await this.projectManager.stopAll().catch((err: unknown) =>
      logger.warn({ err }, "projectManager stop error"),
    );
    await this.accountManager.stopAll().catch((err: unknown) =>
      logger.warn({ err }, "accountManager stop error"),
    );

    if (this.keepAlive) clearInterval(this.keepAlive);
    logger.info("daemon stopped");
    this.resolveShutdown();
  }

  waitForShutdown(): Promise<void> {
    return this.shutdownPromise;
  }

  /** Reconcile projects + rebuild the account inbox routing after config change. */
  async reload(): Promise<void> {
    this.config = this.store.read();
    await this.projectManager.sync(this.configList());
  }

  private configList() {
    return Object.entries(this.config.projects).map(([name, config]) => ({ name, config }));
  }

  /** Gate + inbox resolution for an account: its project's inbox, or undefined. */
  private resolveInboxDir(accountId: string): string | undefined {
    const projectId = this.projectManager.getProjectIdForAccount(accountId);
    if (!projectId) return undefined;
    const cfg = this.config.projects[projectId];
    if (!cfg || !cfg.enabled) return undefined;
    return path.join(cfg.cwd, ".pi-weixin", "inbox");
  }

  getAccountStatuses() {
    return this.accountManager.listAccounts();
  }
}
