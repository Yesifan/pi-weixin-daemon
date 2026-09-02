import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { Command } from "commander";

const SERVICE_NAME = "pi-weixin-daemon";

/** Resolve the CLI entry file's absolute path, verifying it exists. */
function resolveCliEntry(): string {
  const candidates = [
    // Published: dist/index.js next to dist/cli/*.js
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "index.js"),
    // Dev (tsx): src/index.ts next to src/cli/*.ts
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "index.ts"),
  ];
  // Prefer the actually-invoked CLI path (bin symlink target) when available.
  if (process.argv[1]) {
    const invoked = fs.realpathSync(process.argv[1]);
    if (fs.existsSync(invoked)) candidates.unshift(invoked);
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error("cannot resolve pi-weixin-daemon CLI entry path; is the package installed?");
}

function resolveUnitPath(): string {
  return path.join(os.homedir(), ".config", "systemd", "user", `${SERVICE_NAME}.service`);
}

/** The systemd user unit content, with ExecStart resolved to this CLI. */
function buildUnit(): string {
  const cli = resolveCliEntry();
  const node = process.execPath;
  return [
    "[Unit]",
    "Description=Pi Weixin Daemon",
    "Wants=network-online.target",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${node} ${cli} serve`,
    "Restart=on-failure",
    "RestartSec=3",
    "TimeoutStopSec=15",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function serviceCommand(): Command {
  const cmd = new Command("service").description("Manage the systemd user service");

  cmd
    .command("install")
    .description("Write the systemd user unit for this CLI's absolute path")
    .action(() => {
      const unitPath = resolveUnitPath();
      fs.mkdirSync(path.dirname(unitPath), { recursive: true });
      fs.writeFileSync(unitPath, buildUnit(), "utf-8");
      console.log(`Wrote ${unitPath}`);
      console.log(`  ExecStart=${resolveCliEntry()}`);
      console.log("Next: `systemctl --user daemon-reload` then `pi-weixin-daemon start`.");
      console.log(
        "To keep it running without a login shell: `loginctl enable-linger <user>` (do NOT use sudo).",
      );
    });

  cmd
    .command("uninstall")
    .description("Remove the systemd user unit")
    .action(() => {
      const unitPath = resolveUnitPath();
      fs.rmSync(unitPath, { force: true });
      console.log(`Removed ${unitPath}`);
      console.log("Next: `systemctl --user daemon-reload`.");
    });

  return cmd;
}
