import os from "node:os";
import path from "node:path";

const DEFAULT_STATE_DIR = path.join(os.homedir(), ".local", "state", "pi-weixin-daemon");

/** Resolve the daemon state directory (override with PI_WEIXIN_STATE_DIR). */
export function resolveStateDir(): string {
  return process.env.PI_WEIXIN_STATE_DIR?.trim() || DEFAULT_STATE_DIR;
}

/** Directory holding weixin account data: accounts.json, accounts/, sync buffers. */
export function resolveWeixinStateDir(): string {
  return path.join(resolveStateDir(), "weixin");
}

/** Directory holding per-account data files. */
export function resolveAccountsDir(): string {
  return path.join(resolveWeixinStateDir(), "accounts");
}
