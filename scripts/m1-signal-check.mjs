// M1 acceptance: daemon starts, runs, and exits gracefully on SIGTERM.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "dist", "index.js");

const child = spawn(process.execPath, [bin, "run", "--cwd", root, "--account", "a"], {
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.on("data", (d) => (output += d.toString()));
child.stderr.on("data", (d) => (output += d.toString()));

const timer = setTimeout(() => child.kill("SIGTERM"), 1500);

child.on("exit", (code, signal) => {
  clearTimeout(timer);
  console.log("exit code:", code, "signal:", signal);
  console.log("--- output ---");
  console.log(output);
  const started = output.includes("daemon started");
  const stopped = output.includes("daemon stopped");
  const ok = started && stopped && code === 0;
  console.log(ok ? "M1 ACCEPT: graceful start + SIGTERM stop" : "M1 FAIL");
  process.exit(ok ? 0 : 1);
});
