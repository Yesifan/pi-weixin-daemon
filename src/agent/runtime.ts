import type { ImageContent } from "@earendil-works/pi-ai/compat";
import type {
  AgentSession,
  AgentSessionEvent,
  CreateAgentSessionRuntimeFactory,
  ExtensionFactory,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Logger } from "../util/logger.js";

export interface PiRuntimeOptions {
  /** Project working directory. The single entry point for the project. */
  cwd: string;
  logger: Logger;
  /** In-memory extensions injected into every session (e.g. the weixin runtime extension). */
  extensionFactories?: ExtensionFactory[];
  /** Custom UI context for extension dialogs (confirm/select/input/notify over weixin). */
  uiContext?: ExtensionUIContext;
  /** Matches the official ExtensionMode union ("tui" | "rpc" | "json" | "print"). */
  mode?: "tui" | "rpc" | "json" | "print";
}

export interface SessionStatus {
  sessionFile: string | undefined;
  sessionId: string | undefined;
  cwd: string;
  model: string;
  thinkingLevel: string;
}

type RuntimeListener = (event: AgentSessionEvent) => void;

/** Runtime surface used by the bridge; implemented by PiRuntime, faked in tests. */
export interface AgentRuntime {
  readonly cwd: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  prompt(text: string, images?: ImageContent[]): Promise<void>;
  abort(): Promise<void>;
  newSession(): Promise<void>;
  compact(customInstructions?: string): Promise<void>;
  onEvent(listener: RuntimeListener): () => void;
  getStatus(): SessionStatus;
}

/**
 * Thin wrapper around Pi's AgentSessionRuntime (SDK embedding mode).
 *
 * Responsibilities (and only these):
 *  - create/recover the AgentSessionRuntime for `cwd`
 *  - prompt / abort / newSession / compact
 *  - session status + event subscription
 *  - extension binding, rebound automatically after session replacement
 *
 * Session persistence, extension discovery (project .pi/extensions, user
 * ~/.pi/agent/extensions), skills, settings and tool activation are all
 * delegated to Pi.
 */
export class PiRuntime implements AgentRuntime {
  private runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
  private sessionRef: AgentSession | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly listeners = new Set<RuntimeListener>();
  private readonly opts: PiRuntimeOptions;

  constructor(opts: PiRuntimeOptions) {
    this.opts = opts;
  }

  get session(): AgentSession | undefined {
    return this.sessionRef;
  }

  get cwd(): string {
    return this.opts.cwd;
  }

  /** Create a fresh session for `cwd` and bind session-local subscriptions. */
  async start(): Promise<void> {
    const { cwd, logger } = this.opts;
    const agentDir = getAgentDir();

    const createRuntime: CreateAgentSessionRuntimeFactory = async ({
      cwd: factoryCwd,
      sessionManager,
      sessionStartEvent,
    }) => {
      // Mirror pi-web / the pi CLI: gate trust-requiring project resources
      // behind the SDK's project-trust store (read from ~/.pi/agent/trust.json).
      // Without this the embedded session never resolves project trust and
      // project-scoped extension config (e.g. a project's permission rules) is
      // skipped, falling back to global policy only.
      const trustReloadOptions = hasTrustRequiringProjectResources(factoryCwd)
        ? {
            resolveProjectTrust: async () =>
              new ProjectTrustStore(agentDir).get(factoryCwd) === true,
          }
        : undefined;

      const services = await createAgentSessionServices({
        cwd: factoryCwd,
        agentDir,
        settingsManager: SettingsManager.create(factoryCwd, agentDir),
        resourceLoaderOptions: this.opts.extensionFactories?.length
          ? { extensionFactories: this.opts.extensionFactories }
          : undefined,
        ...(trustReloadOptions
          ? { resourceLoaderReloadOptions: trustReloadOptions }
          : {}),
      });
      return {
        ...(await createAgentSessionFromServices({
          services,
          sessionManager,
          sessionStartEvent,
        })),
        services,
        diagnostics: services.diagnostics,
      };
    };

    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir,
      // Always start a fresh session: no cross-restart resume. Each daemon start
      // (and each project runtime start) gets a new, empty session.
      sessionManager: SessionManager.create(cwd),
    });
    this.runtime = runtime;

    // Official hook: called automatically after newSession/switchSession/fork
    // replace the active session. We rebind the UI context and subscriptions.
    runtime.setRebindSession(async (session) => {
      await this.bindSession(session);
    });

    await this.bindSession(runtime.session);
    logger.info(
      { sessionFile: runtime.session.sessionFile, sessionId: runtime.session.sessionId },
      "pi runtime started",
    );
  }

  private async bindSession(session: AgentSession): Promise<void> {
    this.unsubscribe?.();
    this.sessionRef = session;
    await session.bindExtensions({
      uiContext: this.opts.uiContext,
      mode: this.opts.mode ?? "rpc",
    });
    this.unsubscribe = session.subscribe((event) => {
      for (const listener of this.listeners) {
        listener(event);
      }
    });
    this.opts.logger.debug({ sessionFile: session.sessionFile }, "session bound");
  }

  /** Subscribe to session events. Returns an unsubscribe function. */
  onEvent(listener: RuntimeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Prompt the agent. Throws on abort/error; callers handle busy semantics. */
  async prompt(text: string, images?: ImageContent[]): Promise<void> {
    const session = this.requireSession();
    this.opts.logger.info({ sessionId: session.sessionId }, "prompt");
    await session.prompt(text, images?.length ? { images } : undefined);
  }

  /** Abort the current agent run (official abort API). */
  async abort(): Promise<void> {
    const session = this.requireSession();
    this.opts.logger.info("abort requested");
    await session.abort();
  }

  /** Start a fresh session (replaces the active session; bindings rebind automatically). */
  async newSession(): Promise<void> {
    const runtime = this.requireRuntime();
    this.opts.logger.info("new session requested");
    await runtime.newSession();
  }

  /** Compact the current session. */
  async compact(customInstructions?: string): Promise<void> {
    const session = this.requireSession();
    this.opts.logger.info("compact requested");
    await session.compact(customInstructions);
  }

  getStatus(): SessionStatus {
    const session = this.sessionRef;
    const model = session?.model;
    const modelName = model ? `${model.provider}/${model.id}` : "unknown";
    return {
      sessionFile: session?.sessionFile,
      sessionId: session?.sessionId,
      cwd: this.opts.cwd,
      model: modelName,
      thinkingLevel: String(session?.thinkingLevel ?? "unknown"),
    };
  }

  /** Dispose the runtime and all bindings. */
  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    const runtime = this.runtime;
    this.runtime = undefined;
    this.sessionRef = undefined;
    if (runtime) {
      await runtime.dispose();
    }
    this.opts.logger.info("pi runtime stopped");
  }

  private requireRuntime(): Awaited<ReturnType<typeof createAgentSessionRuntime>> {
    if (!this.runtime) throw new Error("PiRuntime not started");
    return this.runtime;
  }

  private requireSession(): AgentSession {
    if (!this.sessionRef) throw new Error("PiRuntime session not bound");
    return this.sessionRef;
  }
}
