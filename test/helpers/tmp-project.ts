import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".tmp");

export interface TmpProject {
  dir: string;
  markerFile: string;
}

/** Create a temporary project with a .pi/extensions/test-extension.ts fixture. */
export function createTmpProject(name: string): TmpProject {
  const dir = path.join(TEST_ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  const extDir = path.join(dir, ".pi", "extensions");
  fs.mkdirSync(extDir, { recursive: true });
  const fixture = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "project-extension.ts"),
    "utf-8",
  );
  fs.writeFileSync(path.join(extDir, "test-extension.ts"), fixture, "utf-8");
  const markerFile = path.join(TEST_ROOT, `${name}.marker`);
  fs.rmSync(markerFile, { force: true });
  // The fixture tool reads $MARKER_FILE (same process: jiti loads the extension in-process).
  process.env.MARKER_FILE = markerFile;
  return { dir, markerFile };
}

/** Wait (polling) until the marker file exists, or fail after timeoutMs. */
export async function waitForMarker(
  markerFile: string,
  timeoutMs = 90_000,
  pollMs = 500,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(markerFile)) {
      return fs.readFileSync(markerFile, "utf-8");
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`marker file not created within ${timeoutMs}ms: ${markerFile}`);
}
