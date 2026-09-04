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

/**
 * Whether this project's trust-requiring resources should load, mirroring pi's
 * official resolution: nearest saved decision in `~/.pi/agent/trust.json`,
 * otherwise fall back to `defaultProjectTrust` ("always" trusts; "ask"/"never"
 * decline in non-interactive mode).
 */
function resolveProjectTrust(cwd: string, agentDir: string): boolean {
  if (!hasTrustRequiringProjectResources(cwd)) return true;
  const saved = new ProjectTrustStore(agentDir).get(cwd);
  if (saved !== null) return saved;
  return SettingsManager.create(cwd, agentDir).getDefaultProjectTrust() === "always";
}

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
  /** Whether the project's trust-requiring resources are loaded. */
  trust: boolean;
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
  hasSession(): boolean;
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
  /** Lazily create the AgentSessionRuntime (and its session) on first use. */
  private async ensureRuntime(): Promise<NonNullable<typeof this.runtime>> {
    if (this.runtime) return this.runtime;
    const { cwd, logger } = this.opts;
    const agentDir = getAgentDir();

    const createRuntime: CreateAgentSessionRuntimeFactory = async ({
      cwd: factoryCwd,
      sessionManager,
      sessionStartEvent,
    }) => {
      const services = await createAgentSessionServices({
        cwd: factoryCwd,
        agentDir,
        settingsManager: SettingsManager.create(factoryCwd, agentDir),
        resourceLoaderOptions: this.opts.extensionFactories?.length
          ? { extensionFactories: this.opts.extensionFactories }
          : undefined,
        // Gate trust-requiring project resources behind the SDK's project-trust
        // decision (mirror pi-web / the pi CLI). Without this, project-scoped
        // extension config is skipped and global policy is used.
        ...(hasTrustRequiringProjectResources(factoryCwd)
          ? {
              resourceLoaderReloadOptions: {
                resolveProjectTrust: async () => resolveProjectTrust(factoryCwd, agentDir),
              },
            }
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
      // Always a fresh session: no cross-restart resume.
      sessionManager: SessionManager.create(cwd),
    });
    // Official hook: called automatically after newSession/switchSession/fork
    // replace the active session. We rebind the UI context and subscriptions.
    runtime.setRebindSession(async (session) => {
      await this.bindSession(session);
    });
    await this.bindSession(runtime.session);
    this.runtime = runtime;

    logger.info(
      { sessionFile: runtime.session.sessionFile, sessionId: runtime.session.sessionId },
      "pi runtime started",
    );
    return runtime;
  }

  async start(): Promise<void> {
    // Lazy start: the session is only created on the first prompt (a user
    // message) or /new. Standing up N sessions at daemon start wastes resources
    // for projects that never receive a message.
    this.opts.logger.debug({ cwd: this.opts.cwd }, "pi runtime ready (session lazy)");
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

  /** Prompt the agent. Creates the session on first use (lazy). */
  async prompt(text: string, images?: ImageContent[]): Promise<void> {
    const { session } = await this.ensureRuntime();
    this.opts.logger.info({ sessionId: session.sessionId }, "prompt");
    await session.prompt(text, images?.length ? { images } : undefined);
  }

  /** Abort the current agent run. No-op when no session is active. */
  async abort(): Promise<void> {
    const session = this.sessionRef;
    if (!session) return;
    this.opts.logger.info("abort requested");
    await session.abort();
  }

  /** Reset the active session. /new only resets an existing session, never creates one. */
  async newSession(): Promise<void> {
    if (!this.runtime) {
      this.opts.logger.info("new session ignored: no active session");
      return;
    }
    this.opts.logger.info("new session requested");
    await this.runtime.newSession();
  }

  /** Compact the current session. No-op when no session exists. */
  async compact(customInstructions?: string): Promise<void> {
    const session = this.sessionRef;
    if (!session) return;
    this.opts.logger.info("compact requested");
    await session.compact(customInstructions);
  }

  hasSession(): boolean {
    return this.sessionRef !== undefined;
  }

  getStatus(): SessionStatus {
    const session = this.sessionRef;
    const model = session?.model;
    return {
      sessionFile: session?.sessionFile,
      sessionId: session?.sessionId,
      cwd: this.opts.cwd,
      model: model ? `${model.provider}/${model.id}` : "unknown",
      thinkingLevel: String(session?.thinkingLevel ?? "unknown"),
      trust: resolveProjectTrust(this.opts.cwd, getAgentDir()),
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


}
