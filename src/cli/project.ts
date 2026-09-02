import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import type { ProjectStatus } from "../projects/types.js";
import { formatProjectRow, rpcCall } from "./rpc-client.js";

const collect = (value: string, previous: string[]) => [...previous, value];

/** Resolve cwd (require exists + dir). Returns resolved absolute path. */
function resolveCwd(cwd: string): string {
  const resolved = path.resolve(cwd);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`cwd does not exist or is not a directory: ${cwd}`);
  }
  return resolved;
}

export function projectCommand(): Command {
  const cmd = new Command("project").description("Manage projects (via daemon RPC)");

  cmd
    .command("add <name>")
    .description("Add a project (enabled=false by default)")
    .requiredOption("--cwd <path>", "project working directory")
    .option("--account <id>", "weixin account id to bind (repeatable)", collect, [] as string[])
    .action(async (name: string, opts: { cwd: string; account?: string[] }) => {
      const config = { cwd: resolveCwd(opts.cwd), accounts: opts.account ?? [], enabled: false };
      await rpcCall("project.add", { name, config });
      console.log(`Added project "${name}" (disabled). Enable it with \`project enable ${name}\`.`);
    });

  cmd
    .command("list")
    .description("List projects")
    .action(async () => {
      const list = await rpcCall<ProjectStatus[]>("project.list");
      if (list.length === 0) {
        console.log("No projects. Add one with `project add <name> --cwd <path> --account <id>`.");
        return;
      }
      console.log("NAME         STATE      ENABLED   ACCOUNTS             CWD");
      for (const p of list) console.log(formatProjectRow(p));
    });

  cmd
    .command("show <name>")
    .description("Show one project")
    .action(async (name: string) => {
      const p = await rpcCall<ProjectStatus>("project.get", { name });
      console.log(formatProjectRow(p));
    });

  cmd
    .command("set <name>")
    .description("Update a project (cwd and/or accounts)")
    .option("--cwd <path>", "project working directory")
    .option("--account <id>", "replace accounts with these ids (repeatable)", collect, [] as string[])
    .action(async (name: string, opts: { cwd?: string; account?: string[] }) => {
      const changes: Record<string, unknown> = {};
      if (opts.cwd) changes.cwd = resolveCwd(opts.cwd);
      if (opts.account) changes.accounts = opts.account;
      await rpcCall("project.set", { name, changes });
      console.log(`Updated project "${name}".`);
    });

  cmd
    .command("enable <name>")
    .description("Enable (start maintaining) a project")
    .action(async (name: string) => {
      await rpcCall("project.enable", { name });
      console.log(`Enabled project "${name}".`);
    });

  cmd
    .command("disable <name>")
    .description("Disable (stop) a project")
    .action(async (name: string) => {
      await rpcCall("project.disable", { name });
      console.log(`Disabled project "${name}".`);
    });

  cmd
    .command("restart <name>")
    .description("Restart a project runtime")
    .action(async (name: string) => {
      await rpcCall("project.restart", { name });
      console.log(`Restarted project "${name}".`);
    });

  cmd
    .command("remove <name>")
    .description("Remove a project")
    .action(async (name: string) => {
      await rpcCall("project.remove", { name });
      console.log(`Removed project "${name}".`);
    });

  return cmd;
}
