import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { validateSendFileParams } from "../../src/agent/runtime-extension.js";
import { sanitizeFilename } from "../../src/util/sanitize.js";

describe("validateSendFileParams", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(process.cwd(), "test/.tmp", "path-validate-"));
  });

  it("accepts a regular file inside cwd", () => {
    const file = path.join(root, "ok.txt");
    fs.writeFileSync(file, "hi");
    const result = validateSendFileParams(file, root, path.join(root, "tmp"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedPath).toBe(file);
      expect(result.basename).toBe("ok.txt");
    }
  });

  it("rejects a missing file", () => {
    const result = validateSendFileParams(path.join(root, "nope.txt"), root, path.join(root, "tmp"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("does not exist");
  });

  it("rejects a directory", () => {
    const dir = path.join(root, "subdir");
    fs.mkdirSync(dir);
    const result = validateSendFileParams(dir, root, path.join(root, "tmp"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not a regular file");
  });

  it("rejects a file outside cwd and tmp", () => {
    const outside = path.join(root, "..", "outside.txt");
    fs.writeFileSync(outside, "secret");
    const result = validateSendFileParams(outside, root, path.join(root, "tmp"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("outside cwd/tmp");
  });

  it("rejects path traversal attempts", () => {
    const result = validateSendFileParams("../outside.txt", root, path.join(root, "tmp"));
    expect(result.ok).toBe(false);
  });

  it("accepts a file inside the daemon tmp dir", () => {
    const tmp = path.join(root, "daemon-tmp");
    fs.mkdirSync(tmp);
    const file = path.join(tmp, "staged.bin");
    fs.writeFileSync(file, "data");
    const result = validateSendFileParams(file, root, tmp);
    expect(result.ok).toBe(true);
  });

  it("rejects an empty basename after sanitization", () => {
    const file = path.join(root, " \u0001");
    fs.writeFileSync(file, "x");
    const result = validateSendFileParams(file, root, path.join(root, "tmp"));
    expect(result.ok).toBe(false);
  });
});

describe("sanitizeFilename", () => {
  it("strips control characters and path separators", () => {
    expect(sanitizeFilename("a\u0001b/c\\d.txt")).toBe("ab_c_d.txt");
  });
  it("trims whitespace", () => {
    expect(sanitizeFilename("  file.txt  ")).toBe("file.txt");
  });
});
