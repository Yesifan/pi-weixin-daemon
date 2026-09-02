import { Command } from "commander";
import { accountsCommand } from "./accounts.js";
import { logsCommand, restartCommand, startCommand, statusCommand, stopCommand } from "./control.js";
import { doctorCommand } from "./doctor.js";
import { loginCommand } from "./login.js";
import { projectCommand } from "./project.js";
import { serveCommand } from "./serve.js";
import { serviceCommand } from "./service.js";

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("pi-wx")
    .description("Connect Weixin iLink Bot with Pi Coding Agent (multi-project daemon)")
    .version("0.3.0");
  program.addCommand(serveCommand());
  program.addCommand(serviceCommand());
  program.addCommand(startCommand());
  program.addCommand(stopCommand());
  program.addCommand(restartCommand());
  program.addCommand(statusCommand());
  program.addCommand(logsCommand());
  program.addCommand(loginCommand());
  program.addCommand(logoutCommand());
  program.addCommand(accountsCommand());
  program.addCommand(projectCommand());
  program.addCommand(doctorCommand());
  return program;
}

function logoutCommand(): Command {
  return new Command("logout")
    .description("Remove a Weixin account (unregisters credentials + notifies daemon)")
    .argument("<account>", "account id")
    .action(async (account: string) => {
      const { unregisterWeixinAccountId, clearWeixinAccount } = await import(
        "../weixin/auth/accounts.js"
      );
      clearWeixinAccount(account);
      unregisterWeixinAccountId(account);
      console.log(`Logged out account "${account}".`);
      try {
        const { rpcCall } = await import("./rpc-client.js");
        await rpcCall("account.reload");
      } catch {
        // daemon not running; fine
      }
    });
}
