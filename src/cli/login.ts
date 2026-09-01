import { Command } from "commander";
import { createLogger } from "../util/logger.js";

/**
 * `pi-weixin-daemon login`
 *
 * Run a QR-code login. Each invocation adds one Weixin account.
 * Implemented in Milestone 4 (Tencent account/login).
 */
export function loginCommand(): Command {
  return new Command("login")
    .description("QR-code login to add a Weixin account (repeat to add more)")
    .action(async () => {
      const logger = createLogger({ pretty: true });
      logger.error("login is not implemented yet (milestone M4)");
      process.exitCode = 1;
    });
}
