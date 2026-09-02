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
const NAME_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * `pi-weixin-daemon login [--name NAME]`
 *
 * QR-code login. Each invocation adds one Weixin account; run it again to add
 * another. `--name` assigns a friendly id used as the Project routing key
 * (defaults to the server-assigned `ilink_bot_id`).
 */
export function loginCommand(): Command {
  return new Command("login")
    .description("QR-code login to add a Weixin account (repeat to add more)")
    .option("--timeout <ms>", "login timeout in milliseconds", "480000")
    .option("--name <name>", "assign an account id/alias (defaults to the server-assigned id)")
    .action(async (opts: { timeout: string; name?: string }) => {
      const logger = createLogger({ pretty: true });
      const timeoutMs = Number(opts.timeout) || 480_000;
      const name = (opts.name ?? "").trim();
      if (name && !NAME_RE.test(name)) {
        console.error(`error: --name must be letters/digits/._- only: "${name}"`);
        process.exitCode = 1;
        return;
      }

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
        // `--name` becomes the account's routing key; otherwise use the bot id.
        const accountId = name || result.accountId;
        registerWeixinAccountId(accountId);
        saveWeixinAccount(accountId, {
          token: result.botToken,
          baseUrl: result.baseUrl,
          userId: result.userId,
        });
        clearStaleAccountsForUserId(accountId, result.userId ?? "");
        logger.info(
          { accountId, userId: redactToken(result.userId) },
          "account saved",
        );
        console.log(`\n✅ 微信账号已保存: ${accountId}${name ? `（bot=${result.accountId}）` : ""}`);
        // Best-effort: ask a running daemon to pick up the new account now.
        try {
          await import("./rpc-client.js").then(({ rpcCall }) => rpcCall("account.reload"));
          console.log(`运行 \`pi-weixin-daemon accounts\` 查看全部账号。`);
        } catch {
          console.log(`Daemon 未运行；账号已保存，下次启动时自动加载。`);
        }
      } else {
        console.log(result.message);
        if (!result.alreadyConnected) {
          process.exitCode = 1;
        }
      }
    });
}
