/** Parse a command like "/status" or "/new" from message text. */
export function parseCommand(
  text: string | undefined,
): { name: string; args: string } | undefined {
  if (!text) return undefined;
  const m = /^\/([a-z][a-z0-9-]*)\s*(.*)$/i.exec(text.trim());
  if (!m) return undefined;
  return { name: m[1]!.toLowerCase(), args: m[2]!.trim() };
}

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
