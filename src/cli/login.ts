import { Command } from "commander";
import {
  clearStaleAccountsForUserId,
  DEFAULT_BASE_URL,
  registerWeixinAccountId,
  saveWeixinAccount,
} from "../weixin/auth/accounts.js";
import { displayQRCode, startWeixinLoginWithQr, waitForWeixinLogin } from "../weixin/auth/login-qr.js";
import { redactToken } from "../weixin/util/redact.js";
import { createLogger } from "../util/logger.js";

/**
 * `pi-weixin-daemon login`
 *
 * QR-code login. Each invocation adds one Weixin account; run it again to
 * add another account. Credentials are stored under the daemon state dir
 * (~/.local/state/pi-weixin-daemon/), never inside the project.
 */
export function loginCommand(): Command {
  return new Command("login")
    .description("QR-code login to add a Weixin account (repeat to add more)")
    .option("--timeout <ms>", "login timeout in milliseconds", "480000")
    .action(async (opts: { timeout: string }) => {
      const logger = createLogger({ pretty: true });
      const timeoutMs = Number(opts.timeout) || 480_000;

      logger.info("starting weixin QR login");
      const start = await startWeixinLoginWithQr({
        apiBaseUrl: DEFAULT_BASE_URL,
        verbose: true,
      });
      if (!start.qrcodeUrl) {
        logger.error({ message: start.message }, "failed to start login");
        console.error(`登录失败：${start.message}`);
        process.exitCode = 1;
        return;
      }

      console.log(start.message);
      await displayQRCode(start.qrcodeUrl);

      const result = await waitForWeixinLogin({
        sessionKey: start.sessionKey,
        apiBaseUrl: DEFAULT_BASE_URL,
        timeoutMs,
      });

      if (result.connected && result.accountId) {
        registerWeixinAccountId(result.accountId);
        saveWeixinAccount(result.accountId, {
          token: result.botToken,
          baseUrl: result.baseUrl,
          userId: result.userId,
        });
        clearStaleAccountsForUserId(result.accountId, result.userId ?? "");
        logger.info(
          { accountId: result.accountId, userId: redactToken(result.userId) },
          "account saved",
        );
        console.log(`\n✅ 微信账号已保存: ${result.accountId}`);
        console.log(`运行 \`pi-weixin-daemon accounts\` 查看全部账号。`);
      } else {
        console.log(result.message);
        if (!result.alreadyConnected) {
          process.exitCode = 1;
        }
      }
    });
}
