import { describe, it, expect } from "vitest";
import { CommandRouter } from "../../src/projects/command-router.js";

describe("CommandRouter classifier (W4)", () => {
  const router = new CommandRouter();

  it("classifies the five daemon commands", () => {
    for (const cmd of ["help", "status", "abort", "new", "compact"]) {
      expect(router.classify(`/${cmd}`)).toEqual({ kind: "daemon-command", command: cmd });
    }
  });

  it("classifies unknown /xxx as unknown-command (not message)", () => {
    expect(router.classify("/bar")).toEqual({ kind: "unknown-command", text: "bar" });
    expect(router.classify("/model gpt")).toEqual({ kind: "unknown-command", text: "model" });
  });

  it("classifies non-slash text as an ordinary message", () => {
    expect(router.classify("你好")).toEqual({ kind: "message", text: "你好" });
    expect(router.classify("")).toEqual({ kind: "message", text: "" });
    expect(router.classify(undefined)).toEqual({ kind: "message", text: "" });
  });

  it("is case-insensitive and ignores trailing args for classification", () => {
    expect(router.classify("/STATUS")).toEqual({ kind: "daemon-command", command: "status" });
    expect(router.classify("/compact 请压缩")).toEqual({ kind: "daemon-command", command: "compact" });
  });
});
