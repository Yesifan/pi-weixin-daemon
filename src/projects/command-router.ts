import { DAEMON_COMMANDS, type DaemonCommand } from "../sessions/commands.js";

/** Classification of a weixin text input (W4 / ADR-0003 D-D). */
export type RoutedInput =
  | { kind: "daemon-command"; command: DaemonCommand }
  | { kind: "unknown-command"; text: string }
  | { kind: "message"; text: string };

/**
 * Pure classifier: decides how a weixin text should be routed.
 *
 * Only the daemon's explicitly mapped commands (`/help /status /abort /new
 * /compact`) enter slash handling. Any other `/xxx` is an unknown command (the
 * caller replies "没有该命令", never forwarding it to Pi or treating it as an
 * ordinary user message). The router has zero knowledge of Pi's command system —
 * Pi extension commands / prompt templates / skills are NOT exposed over weixin.
 */
export class CommandRouter {
  classify(text: string | undefined): RoutedInput {
    if (!text) return { kind: "message", text: text ?? "" };
    const m = /^\/([a-z][a-z0-9-]*)\s*(.*)$/i.exec(text.trim());
    if (!m) return { kind: "message", text };
    const name = m[1]!.toLowerCase();
    if ((DAEMON_COMMANDS as readonly string[]).includes(name)) {
      return { kind: "daemon-command", command: name as DaemonCommand };
    }
    return { kind: "unknown-command", text: name };
  }
}
