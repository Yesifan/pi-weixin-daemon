import type { AgentRuntime } from "../agent/runtime.js";
import { Bridge } from "../bridge/router.js";
import type {
  InboundMessage,
  TurnContext,
  UiResponseBroker,
  WeixinTransport,
} from "../bridge/types.js";
import type { Logger } from "../util/logger.js";
import type { ProjectRuntimeState } from "./types.js";

/** Factory builds the per-project agent runtime (real PiRuntime, or a fake in tests). */
export interface ProjectRuntimeFactoryContext {
  projectId: string;
  cwd: string;
  accounts: string[];
  transport: WeixinTransport;
  bridge: UiResponseBroker & { getCurrentTurn(): TurnContext | undefined };
  logger: Logger;
}
export type ProjectRuntimeFactory = (ctx: ProjectRuntimeFactoryContext) => Promise<AgentRuntime>;

export interface ProjectRuntimeOptions {
  projectId: string;
  cwd: string;
  accounts: string[];
  /** Per-project outbound facade; also used by the weixin runtime extension. */
  transport: WeixinTransport;
  logger: Logger;
  factory: ProjectRuntimeFactory;
}

export interface RuntimeStatusView {
  state: ProjectRuntimeState | "off";
  sessionFile?: string;
  sessionId?: string;
  model?: string;
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

  private runtime?: AgentRuntime;
  private bridge?: Bridge;

  constructor(private readonly opts: ProjectRuntimeOptions) {
    this.projectId = opts.projectId;
    this.cwd = opts.cwd;
    this.accounts = opts.accounts;
  }

  async start(): Promise<void> {
    this.state = "starting";
    this.error = undefined;
    try {
      this.bridge = new Bridge({ transport: this.opts.transport, logger: this.opts.logger });
      this.runtime = await this.opts.factory({
        projectId: this.projectId,
        cwd: this.cwd,
        accounts: this.accounts,
        transport: this.opts.transport,
        bridge: this.bridge,
        logger: this.opts.logger,
      });
      await this.runtime.start();
      this.bridge.bindRuntime(this.runtime);
      this.state = "idle";
      this.opts.logger.info({ project: this.projectId, cwd: this.cwd }, "project runtime started");
    } catch (err) {
      this.state = "error";
      this.error = err instanceof Error ? err.message : String(err);
      this.opts.logger.error({ err, project: this.projectId }, "project runtime start failed");
      throw err;
    }
  }

  /** Route one inbound message into this project's bridge. */
  async handleMessage(msg: InboundMessage): Promise<void> {
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
      error: this.error,
    };
  }

  private requireBridge(): Bridge {
    if (!this.bridge) throw new Error(`project "${this.projectId}" bridge not started`);
    return this.bridge;
  }
}
