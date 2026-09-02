import { Command } from "commander";
import type { AccountInfo } from "../projects/types.js";
import { rpcCall } from "./rpc-client.js";

/**
 * `pi-weixin-daemon accounts`
 *
 * Read account status from the running daemon (RPC). Shows online/offline state
 * and the project each account is bound to.
 */
export function accountsCommand(): Command {
  return new Command("accounts")
    .description("List Weixin accounts (from the running daemon)")
    .action(async () => {
      const accounts = await rpcCall<AccountInfo[]>("account.list");
      if (accounts.length === 0) {
        console.log("No accounts. Run `pi-weixin-daemon login` to add one (then the daemon picks it up).");
        return;
      }
      console.log("ACCOUNT       STATUS          USER              PROJECT");
      for (const a of accounts) {
        const user = a.userId ?? "-";
        const project = a.projectId ?? "-";
        console.log(`${a.accountId.padEnd(14)}${a.status.padEnd(16)}${user.padEnd(18)}${project}`);
      }
    });
}
