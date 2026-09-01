import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import { PiRuntime } from "../../src/agent/runtime.js";
import { WeixinUIContext } from "../../src/agent/ui-context.js";
import { Bridge } from "../../src/bridge/router.js";
import { MultiAccountTransport } from "../../src/bridge/multi-account-transport.js";
import { createLogger } from "../../src/util/logger.js";
import { createTmpProject, waitForMarker } from "../helpers/tmp-project.js";
import { FakeWeixinTransport, makeInboundMessage } from "../helpers/fake-transport.js";

const logger = createLogger({ level: "warn" });
const TIMEOUT = 120_000;

describe("M9 e2e: extension UI dialogs completed over weixin (real SDK)", () => {
  const runtimes: PiRuntime[] = [];

  afterEach(async () => {
    for (const r of runtimes.splice(0)) {
      await r.stop().catch(() => {});
    }
  });

  async function setupProject(name: string) {
    const project = createTmpProject(name, { withUiExtension: true });
    const transport = new FakeWeixinTransport();
    const multi = new MultiAccountTransport();
    multi.register("acct-a", transport);

    const bridge = new Bridge({ transport: multi, logger });
    const runtime = new PiRuntime({
      cwd: project.dir,
      logger,
      uiContext: new WeixinUIContext({
        broker: bridge,
        transport: multi,
        getCurrentTurn: () => bridge.getCurrentTurn(),
        logger,
      }),
    });
    runtimes.push(runtime);
    await runtime.start();
    bridge.bindRuntime(runtime);
    bridge.attach();
    return { project, transport, bridge };
  }

  async function waitForText(transport: FakeWeixinTransport, needle: string, timeoutMs = TIMEOUT): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (transport.sentTexts.some((s) => s.text.includes(needle))) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`never received message containing: ${needle}`);
  }

  it(
    "confirm dialog: agent asks, user replies 1, tool completes with confirmed=true",
    async () => {
      const { project, transport, bridge } = await setupProject("m9-confirm");

      const turnPromise = transport.emit(
        makeInboundMessage({
          accountId: "acct-a",
          senderId: "user-a",
          messageId: "m1",
          text: "请调用 ask_confirm_tool 工具。",
        }),
      );

      // The dialog is rendered over weixin and the bridge enters WAITING_FOR_UI.
      await waitForText(transport, "1. 确认");
      expect(bridge.getState()).toBe("WAITING_FOR_UI");

      // Turn account answers.
      await transport.emit(
        makeInboundMessage({ accountId: "acct-a", senderId: "user-a", messageId: "m2", text: "1" }),
      );
      expect(bridge.getState()).toBe("RUNNING");

      await turnPromise;
      const marker = fs.readFileSync(project.uiMarkerFile, "utf-8");
      expect(marker).toContain("confirmed=true");
      expect(bridge.getState()).toBe("IDLE");
    },
    TIMEOUT + 30_000,
  );

  it(
    "select dialog: agent asks, user picks option 2, tool receives the choice",
    async () => {
      const { project, transport, bridge } = await setupProject("m9-select");

      const turnPromise = transport.emit(
        makeInboundMessage({
          accountId: "acct-a",
          senderId: "user-a",
          messageId: "m1",
          text: "请调用 ask_select_tool 工具。",
        }),
      );

      await waitForText(transport, "选择部署环境");
      expect(bridge.getState()).toBe("WAITING_FOR_UI");

      await transport.emit(
        makeInboundMessage({ accountId: "acct-a", senderId: "user-a", messageId: "m2", text: "2" }),
      );

      await turnPromise;
      const marker = fs.readFileSync(project.uiMarkerFile, "utf-8");
      expect(marker).toContain("select=预发");
      expect(bridge.getState()).toBe("IDLE");
    },
    TIMEOUT + 30_000,
  );

  it(
    "input dialog: agent asks, user types a version, tool receives it",
    async () => {
      const { project, transport, bridge } = await setupProject("m9-input");

      const turnPromise = transport.emit(
        makeInboundMessage({
          accountId: "acct-a",
          senderId: "user-a",
          messageId: "m1",
          text: "请调用 ask_input_tool 工具。",
        }),
      );

      await waitForText(transport, "输入版本号");
      expect(bridge.getState()).toBe("WAITING_FOR_UI");

      await transport.emit(
        makeInboundMessage({ accountId: "acct-a", senderId: "user-a", messageId: "m2", text: "v9.9.9" }),
      );

      await turnPromise;
      const marker = fs.readFileSync(project.uiMarkerFile, "utf-8");
      expect(marker).toContain("input=v9.9.9");
      expect(bridge.getState()).toBe("IDLE");
    },
    TIMEOUT + 30_000,
  );
});
