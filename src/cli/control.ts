import { execFile } from "node:child_process";
import { Command } from "commander";

const SERVICE_NAME = "pi-weixin-daemon";

/** Run a systemctl/journalctl command and stream stdout to the console. */
function run(cmd: string, args: string[], opts: { passthrough?: boolean } = {}): void {
  const child = execFile(cmd, args, (err, stdout, stderr) => {
    if (opts.passthrough) {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
    }
    if (err) {
      process.exitCode = err.code ?? 1;
    }
  });
}

export function controlCommand(): Command {
  const cmd = new Command("control").description("Start/stop/restart/status/logs the service");

  cmd
    .command("start")
    .description("Start the daemon via systemd --user")
    .action(() => run("systemctl", ["--user", "start", SERVICE_NAME], { passthrough: true }));

  cmd
    .command("stop")
    .description("Stop the daemon via systemd --user")
    .action(() => run("systemctl", ["--user", "stop", SERVICE_NAME], { passthrough: true }));

  cmd
    .command("restart")
    .description("Restart the daemon via systemd --user")
    .action(() => run("systemctl", ["--user", "restart", SERVICE_NAME], { passthrough: true }));

  cmd
    .command("status")
    .description("Show systemd --user status")
    .action(() => run("systemctl", ["--user", "--no-pager", "status", SERVICE_NAME], { passthrough: true }));

  cmd
    .command("logs")
    .description("Show recent daemon logs from journald")
    .option("-n <lines>", "number of lines", "100")
    .action((opts: { n: string }) =>
      run("journalctl", ["--user", "-u", SERVICE_NAME, "-n", opts.n, "--no-pager"], { passthrough: true }),
    );

  return cmd;
}
