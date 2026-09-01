import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { z } from "zod";
import { Daemon } from "../daemon.js";
import { createLogger } from "../util/logger.js";

const RunArgsSchema = z.object({
  cwd: z.string().min(1, "cwd must not be empty"),
  accounts: z.array(z.string().min(1, "account id must not be empty")).min(1, "at least one --account is required"),
});

type RunArgs = z.infer<typeof RunArgsSchema>;

/** Install SIGINT/SIGTERM handling: graceful stop, force-exit on second signal. */
export function installSignalHandlers(daemon: Daemon, logger: ReturnType<typeof createLogger>): void {
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) {
      logger.warn({ signal }, "second signal received, forcing exit");
      process.exit(130);
    }
    stopping = true;
    logger.info({ signal }, "signal received, shutting down");
    daemon
      .stop()
      .catch((err: unknown) => {
        logger.error({ err }, "error during shutdown");
        process.exit(1);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

/** `pi-weixin-daemon run --cwd <path> --account <id> [--account <id> ...]` */
export function runCommand(): Command {
  const collect = (value: string, previous: string[]) => [...previous, value];

  return new Command("run")
    .description("Run the daemon for one project (one daemon per project cwd)")
    .requiredOption("--cwd <path>", "project working directory")
    .option("--account <id>", "weixin account id to monitor (repeatable)", collect, [] as string[])
    .action(async (opts: { cwd: string; account?: string[] }) => {
      const parsed = RunArgsSchema.safeParse({ cwd: opts.cwd, accounts: opts.account ?? [] });
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          console.error(`error: ${issue.path.join(".")}: ${issue.message}`);
        }
        process.exitCode = 1;
        return;
      }
      const args: RunArgs = parsed.data;

      const cwd = path.resolve(args.cwd);
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        console.error(`error: cwd does not exist or is not a directory: ${cwd}`);
        process.exitCode = 1;
        return;
      }

      const logger = createLogger({ pretty: process.stdout.isTTY });
      const daemon = new Daemon({ cwd, accounts: args.accounts, logger });
      installSignalHandlers(daemon, logger);
      try {
        await daemon.start();
        await daemon.waitForShutdown();
      } catch (err) {
        logger.error({ err }, "daemon failed");
        // start() may have left the keep-alive running; tear down so the
        // process can exit with a failure code instead of hanging.
        await daemon.stop().catch(() => {});
        process.exitCode = 1;
      }
    });
}
