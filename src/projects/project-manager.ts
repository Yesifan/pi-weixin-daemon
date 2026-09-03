import type { InboundMessage, WeixinTransport } from "../bridge/types.js";
import type { Logger } from "../util/logger.js";
import { ProjectRuntime, type ProjectRuntimeFactory } from "./project-runtime.js";
import { ProjectTransport } from "./project-transport.js";
import type { ProjectConfig, ProjectStatus } from "./types.js";

export interface ProjectManagerOptions {
  /** Resolve the per-account transport (owned by AccountManager). */
  getTransport: (accountId: string) => WeixinTransport | undefined;
  /** Build the per-project AgentRuntime (real PiRuntime or fake in tests). */
  factory: ProjectRuntimeFactory;
  logger: Logger;
  /** Human label for an account (passed through to ProjectRuntime for markers). */
  resolveSenderName?: (accountId: string) => string;
  /** Idle window before a shared session auto-closes (passed through to ProjectRuntime). */
  sessionIdleMs?: number;
}

/**
 * Owns `Map<ProjectId, ProjectRuntime>` and the derived `accountId -> projectId`
 * index. Reconciles desired-state (`enabled`) from config and dispatches inbound
 * to the owning project's runtime, dropping unbound/disabled messages.
 */
export class ProjectManager {
  private runtimes = new Map<string, ProjectRuntime>();
  private configs = new Map<string, ProjectConfig>();
  private accountProject = new Map<string, string>();

  constructor(private readonly opts: ProjectManagerOptions) {}

  getRuntime(projectId: string): ProjectRuntime | undefined {
    return this.runtimes.get(projectId);
  }

  getProjectIdForAccount(accountId: string): string | undefined {
    return this.accountProject.get(accountId);
  }

  /** Reconcile desired-state from the given configs. */
  async sync(configs: Array<{ name: string; config: ProjectConfig }>): Promise<void> {
    const nextConfigs = new Map<string, ProjectConfig>();
    const nextAccountProject = new Map<string, string>();
    for (const { name, config } of configs) {
      nextConfigs.set(name, config);
      for (const acc of config.accounts) {
        nextAccountProject.set(acc, name);
      }
    }
    this.configs = nextConfigs;
    this.accountProject = nextAccountProject;

    // Stop runtimes for projects no longer enabled or removed.
    for (const [id, rt] of this.runtimes) {
      const cfg = nextConfigs.get(id);
      if (!cfg || !cfg.enabled) {
        await rt.stop().catch((err: unknown) =>
          this.opts.logger.warn({ err, project: id }, "stop project error"),
        );
        this.runtimes.delete(id);
      }
    }

    // Start newly enabled projects (sequentially; avoids concurrent extension load).
    for (const [name, cfg] of nextConfigs) {
      if (cfg.enabled && !this.runtimes.has(name)) {
        const transport = new ProjectTransport(cfg.accounts, this.opts.getTransport);
        const rt = new ProjectRuntime({
          projectId: name,
          cwd: cfg.cwd,
          accounts: cfg.accounts,
          transport,
          logger: this.opts.logger,
          factory: this.opts.factory,
          resolveSenderName: this.opts.resolveSenderName,
          sessionIdleMs: this.opts.sessionIdleMs,
        });
        this.runtimes.set(name, rt);
        try {
          await rt.start();
        } catch (err) {
          this.opts.logger.error({ err, project: name }, "project start failed");
          // Keep the runtime (error state) so `project show` can report the failure.
        }
      }
    }
  }

  /** Dispatch an inbound message: account -> project -> runtime. Drops unbound/off. */
  async dispatch(accountId: string, msg: InboundMessage): Promise<void> {
    const projectId = this.accountProject.get(accountId);
    if (!projectId) {
      this.opts.logger.info({ account: accountId }, "dropping inbound: no project bound");
      return;
    }
    const rt = this.runtimes.get(projectId);
    if (!rt) {
      this.opts.logger.info({ account: accountId, project: projectId }, "dropping inbound: project not running");
      // Tell the sender instead of silently dropping (bound+enabled but runtime not up).
      const transport = this.opts.getTransport(accountId);
      if (transport && msg.senderId) {
        await transport
          .sendText(
            { accountId, senderId: msg.senderId, messageId: "not-running", contextToken: msg.contextToken },
            "⚠️ 项目当前未运行（可能启动失败或仍在启动），请稍后重试。",
          )
          .catch((err: unknown) =>
            this.opts.logger.warn({ err, account: accountId }, "project-not-running reply failed (ignored)"),
          );
      }
      return;
    }
    await rt.handleMessage(msg);
  }

  listStatuses(): ProjectStatus[] {
    return [...this.configs].map(([name, cfg]) => {
      const rt = this.runtimes.get(name);
      const st = rt?.getStatus();
      return {
        name,
        cwd: cfg.cwd,
        accounts: cfg.accounts,
        enabled: cfg.enabled,
        state: st?.state ?? "off",
        sessionFile: st?.sessionFile,
        sessionId: st?.sessionId,
        model: st?.model,
        error: st?.error,
      };
    });
  }

  /** Explicit restart: stop then start a project runtime (if desired-state on). */
  async restart(projectId: string): Promise<void> {
    const rt = this.runtimes.get(projectId);
    if (!rt) throw new Error(`project "${projectId}" is not running`);
    await rt.restart();
  }

  async stopAll(): Promise<void> {
    for (const rt of [...this.runtimes.values()]) {
      await rt.stop().catch(() => {});
    }
    this.runtimes.clear();
  }
}
