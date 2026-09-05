/** Daemon-owned host commands (the only `/` inputs handled, W4/ADR-0003 D-D). */
export const DAEMON_COMMANDS = ["help", "status", "abort", "new", "compact"] as const;

export type DaemonCommand = (typeof DAEMON_COMMANDS)[number];

export function helpText(): string {
  return [
    "可用命令：",
    "/help - 显示帮助",
    "/status - 显示会话状态",
    "/new - 新建会话（空闲时）",
    "/abort - 中止当前任务",
    "/compact - 压缩会话（空闲时）",
  ].join("\n");
}
