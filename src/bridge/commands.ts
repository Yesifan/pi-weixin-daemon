import type { AgentRuntime } from "../agent/runtime.js";
import type { Logger } from "../util/logger.js";
import type { BridgeState } from "./state.js";
import type { InboundMessage } from "./types.js";

/** Parse a command like "/status" or "/new" from message text. */
export function parseCommand(
  text: string | undefined,
): { name: string; args: string } | undefined {
  if (!text) return undefined;
  const m = /^\/([a-z][a-z0-9-]*)\s*(.*)$/i.exec(text.trim());
  if (!m) return undefined;
  return { name: m[1]!.toLowerCase(), args: m[2]!.trim() };
}

function helpText(): string {
  return [
    "可用命令：",
    "/help - 显示帮助",
    "/status - 显示会话状态",
    "/new - 新建会话（空闲时）",
    "/abort - 中止当前任务",
    "/compact - 压缩会话（空闲时）",
  ].join("\n");
}

/** Runtime surface needed by commands (satisfied by AgentRuntime). */
export interface CommandRuntime {
  abort(): Promise<void>;
  newSession(): Promise<void>;
  compact(): Promise<void>;
}

export interface CommandRouterDeps {
  getRuntime: () => CommandRuntime;
  state: () => BridgeState;
  getStatus: () => string;
  logger: Logger;
}

/**
 * v0.1 commands. Routing rules:
 *   /status, /abort  — allowed in every state
 *   /new, /compact   — IDLE only (busy -> refused)
 *   /help            — any state
 */
export class CommandRouter {
  constructor(private readonly deps: CommandRouterDeps) {}

  /** Returns reply text, or undefined when the message is not a command. */
  async tryHandle(msg: InboundMessage): Promise<string | undefined> {
    const cmd = parseCommand(msg.text);
    if (!cmd) return undefined;

    const state = this.deps.state();
    this.deps.logger.info({ command: cmd.name, accountId: msg.accountId }, "command");

    switch (cmd.name) {
      case "help":
        return helpText();
      case "status":
        return this.deps.getStatus();
      case "abort":
        if (state === "IDLE") return "当前没有正在执行的任务。";
        await this.deps.getRuntime().abort();
        return "⏹ 已发送中止指令。";
      case "new":
        if (state !== "IDLE") return "Agent 忙时不能新建会话，请先 /abort 或等待完成。";
        await this.deps.getRuntime().newSession();
        return "✅ 已新建会话。";
      case "compact":
        if (state !== "IDLE") return "Agent 忙时不能压缩会话，请先 /abort 或等待完成。";
        await this.deps.getRuntime().compact();
        return "✅ 已请求会话压缩。";
      default:
        return `未知命令 /${cmd.name}，输入 /help 查看可用命令。`;
    }
  }
}
