import { Command } from "commander";
import { accountsCommand } from "./accounts.js";
import { doctorCommand } from "./doctor.js";
import { loginCommand } from "./login.js";
import { runCommand } from "./run.js";

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("pi-weixin-daemon")
    .description("Connect Weixin iLink Bot with Pi Coding Agent")
    .version("0.1.0");
  program.addCommand(loginCommand());
  program.addCommand(accountsCommand());
  program.addCommand(doctorCommand());
  program.addCommand(runCommand());
  return program;
}
