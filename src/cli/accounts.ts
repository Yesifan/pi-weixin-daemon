import { Command } from "commander";
import { listIndexedWeixinAccountIds, loadWeixinAccount } from "../weixin/auth/accounts.js";
import { createLogger } from "../util/logger.js";

/**
 * `pi-weixin-daemon accounts`
 *
 * Show currently logged-in Weixin accounts.
 */
export function accountsCommand(): Command {
  return new Command("accounts")
    .description("List logged-in Weixin accounts")
    .action(async () => {
      const logger = createLogger({ pretty: true });
      const ids = listIndexedWeixinAccountIds();
      if (ids.length === 0) {
        console.log("No accounts. Run `pi-weixin-daemon login` to add one.");
        return;
      }
      for (const id of ids) {
        const data = loadWeixinAccount(id);
        console.log(`- ${id}${data?.userId ? ` (user=${data.userId})` : ""}`);
      }
      logger.info({ count: ids.length }, "accounts listed");
    });
}
