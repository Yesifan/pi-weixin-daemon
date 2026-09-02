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

/** `pi-weixin-daemon start` — systemctl --user start pi-weixin-daemon */
export function startCommand(): Command {
  return new Command("start")
    .description("Start the daemon via systemd --user")
    .action(() => run("systemctl", ["--user", "start", SERVICE_NAME], { passthrough: true }));
}

/** `pi-weixin-daemon stop` — systemctl --user stop pi-weixin-daemon */
export function stopCommand(): Command {
  return new Command("stop")
    .description("Stop the daemon via systemd --user")
    .action(() => run("systemctl", ["--user", "stop", SERVICE_NAME], { passthrough: true }));
}

/** `pi-weixin-daemon restart` — systemctl --user restart pi-weixin-daemon */
export function restartCommand(): Command {
  return new Command("restart")
    .description("Restart the daemon via systemd --user")
    .action(() => run("systemctl", ["--user", "restart", SERVICE_NAME], { passthrough: true }));
}

/** `pi-weixin-daemon status` — systemctl --user --no-pager status pi-weixin-daemon */
export function statusCommand(): Command {
  return new Command("status")
    .description("Show systemd --user status")
    .action(() => run("systemctl", ["--user", "--no-pager", "status", SERVICE_NAME], { passthrough: true }));
}

/** `pi-weixin-daemon logs` — journalctl --user -u pi-weixin-daemon */
export function logsCommand(): Command {
  return new Command("logs")
    .description("Show recent daemon logs from journald")
    .option("-n <lines>", "number of lines", "100")
    .action((opts: { n: string }) =>
      run("journalctl", ["--user", "-u", SERVICE_NAME, "-n", opts.n, "--no-pager"], { passthrough: true }),
    );
}
