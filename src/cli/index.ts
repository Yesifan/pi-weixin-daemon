import { Command } from "commander";
import { accountsCommand } from "./accounts.js";
import { doctorCommand } from "./doctor.js";
import { loginCommand } from "./login.js";
import { serveCommand } from "./serve.js";

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("pi-weixin-daemon")
    .description("Connect Weixin iLink Bot with Pi Coding Agent (multi-project daemon)")
    .version("0.2.0");
  program.addCommand(serveCommand());
  program.addCommand(loginCommand());
  program.addCommand(accountsCommand());
  program.addCommand(doctorCommand());
  return program;
}
