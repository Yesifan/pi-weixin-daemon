import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { BUSY_REPLY } from "../../src/sessions/session-state.js";
import { SessionController } from "../../src/sessions/session-controller.js";
import { CurrentTurn } from "../../src/sessions/turn-context.js";
import { WeixinInteractionController } from "../../src/weixin/interaction-controller.js";
import { createLogger } from "../../src/util/logger.js";
import { FakeAgentRuntime } from "../helpers/fake-runtime.js";
import { FakeWeixinTransport, makeInboundMessage } from "../helpers/fake-transport.js";

const logger = createLogger({ level: "silent" });

function setup(opts: { broadcastText?: (t: string) => Promise<void>; senderLabel?: (m: { accountId: string }) => string } = {}) {
  const runtime = new FakeAgentRuntime();
  const transport = new FakeWeixinTransport();
  const currentTurn = new CurrentTurn();
  const interaction = new WeixinInteractionController({
    getCurrentTurn: () => currentTurn.get(),
    transport,
    logger,
  });
  const session = new SessionController({
    projectId: "foo",
    host: runtime,
    interaction,
    transport,
    currentTurn,
    logger,
    broadcastText: opts.broadcastText,
    resolveSenderLabel: opts.senderLabel as never,
  });
  return { runtime, transport, session };
}

const msgA = (text: string, id = "m1") =>
  makeInboundMessage({ accountId: "acct-a", senderId: "user-a", messageId: id, text });

const msgB = (text: string, id = "m2") =>
  makeInboundMessage({ accountId: "acct-b", senderId: "user-b", messageId: id, text });

describe("M6 session controller (fake transport + fake runtime)", () => {
  it("A starts a turn; B gets busy refusal; completion replies only to A", async () => {
    const { runtime, transport, session } = setup();

    const turnPromise = session.handleUserMessage(msgA("帮我写个计划"));
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(1));
    expect(runtime.prompts[0]?.text).toBe("帮我写个计划");
    expect(session.getState()).toBe("busy");

    await session.handleUserMessage(msgB("你好"));
    expect(transport.textsTo("acct-b")).toEqual([BUSY_REPLY]);
    expect(transport.textsTo("acct-a")).toEqual([]);

    runtime.complete("这是给 A 的回复。");
    await turnPromise;

    expect(transport.textsTo("acct-a")).toEqual(["这是给 A 的回复。"]);
    expect(transport.textsTo("acct-b")).toEqual([BUSY_REPLY]);
    expect(session.getState()).toBe("ready");
  });

  it("sets typing before the run and clears it after", async () => {
    const { runtime, transport, session } = setup();

    const turnPromise = session.handleUserMessage(msgA("hello"));
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(1));

    expect(transport.typingEvents.map((t) => t.typing)).toEqual([true]);

    runtime.complete("done");
    await turnPromise;

    expect(transport.typingEvents.map((t) => t.typing)).toEqual([true, false]);
    expect(session.getState()).toBe("ready");
  });

  it("two consecutive turns on the same account work", async () => {
    const { runtime, transport, session } = setup();

    const t1 = session.handleUserMessage(msgA("first", "m1"));
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(1));
    runtime.complete("reply one");
    await t1;

    const t2 = session.handleUserMessage(msgA("second", "m2"));
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(2));
    runtime.complete("reply two");
    await t2;

    expect(transport.textsTo("acct-a")).toEqual(["reply one", "reply two"]);
    expect(session.getState()).toBe("ready");
  });

  it("agent error produces an error reply to the turn origin", async () => {
    const { runtime, transport, session } = setup();

    const turnPromise = session.handleUserMessage(msgA("boom"));
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(1));
    runtime.fail(new Error("provider exploded"));
    await turnPromise;

    expect(transport.textsTo("acct-a")[0]).toContain("provider exploded");
    expect(session.getState()).toBe("ready");
  });
});

describe("M6 commands over weixin", () => {
  it("/status works while running", async () => {
    const { runtime, transport, session } = setup();
    const turnPromise = session.handleUserMessage(msgA("task"));
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(1));

    await session.handleCommand("status", msgA("/status", "m-status"));
    const statusReply = transport.textsTo("acct-a").at(-1)!;
    expect(statusReply).toContain("Project:");
    expect(statusReply).toContain("Agent state: busy");
    expect(statusReply).toContain("Model:");
    expect(statusReply).toContain("Configured trust:");

    runtime.complete("ok");
    await turnPromise;
    expect(session.getState()).toBe("ready");
  });

  it("/new is refused while running, allowed when idle", async () => {
    const { runtime, transport, session } = setup();

    const turnPromise = session.handleUserMessage(msgA("task"));
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(1));

    await session.handleCommand("new", msgA("/new", "m-new-busy"));
    expect(transport.textsTo("acct-a").at(-1)).toContain("忙时不能新建会话");
    expect(runtime.newSessionCalls).toBe(0);

    runtime.complete("done");
    await turnPromise;

    await session.handleCommand("new", msgA("/new", "m-new-idle"));
    expect(runtime.newSessionCalls).toBe(1);
  });

  it("/abort terminates the running agent and notifies the turn origin", async () => {
    const { runtime, transport, session } = setup();

    const turnPromise = session.handleUserMessage(msgA("long task"));
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(1));

    await session.handleCommand("abort", msgA("/abort", "m-abort"));
    await turnPromise;

    expect(runtime.prompts.length).toBe(1); // no second prompt
    expect(transport.textsTo("acct-a").at(-1)).toContain("已中止");
    expect(session.getState()).toBe("ready");
  });

});

describe("M8 media routing through the session controller", () => {
  it("image attachments become multimodal domain images in the prompt", async () => {
    const { runtime, session } = setup();
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const imgPath = path.join(process.cwd(), "test/.tmp", "m8-test-image.png");
    fs.mkdirSync(path.dirname(imgPath), { recursive: true });
    fs.writeFileSync(imgPath, Buffer.from(pngBase64, "base64"));

    const turnPromise = session.handleUserMessage(
      makeInboundMessage({
        accountId: "acct-a",
        senderId: "user-a",
        messageId: "m-img",
        text: "看看这张图",
        attachments: [{ kind: "image", localPath: imgPath, filename: "image.png", mimeType: "image/png" }],
      }),
    );
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(1));

    expect(runtime.prompts[0]?.text).toBe("看看这张图");
    const images = runtime.prompts[0]?.images;
    expect(images).toHaveLength(1);
    expect(images?.[0]).toMatchObject({ mimeType: "image/png" });
    expect(images?.[0]?.data).toBeTruthy();

    runtime.complete("图片已收到");
    await turnPromise;
  });

  it("file attachments become a Hermes-style context note (read it yourself, don't ask user)", async () => {
    const { runtime, session } = setup();
    const filePath = path.join(process.cwd(), "test/.tmp", "m8-ctx", "42", "data.csv");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "a,b\n1,2\n");

    const turnPromise = session.handleUserMessage(
      makeInboundMessage({
        accountId: "acct-a",
        senderId: "user-a",
        messageId: "m-ctx",
        text: "分析这个文件",
        attachments: [{ kind: "file", localPath: filePath, filename: "data.csv", mimeType: "text/csv" }],
      }),
    );
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(1));

    const promptText = runtime.prompts[0]?.text ?? "";
    expect(promptText).toContain("用户发送了一个文件");
    expect(promptText).toContain("自己用终端或文档工具提取文本");

    runtime.complete("已分析");
    await turnPromise;
  });

  it("media download failures are injected into the prompt as a note", async () => {
    const { runtime, session } = setup();
    const turnPromise = session.handleUserMessage(
      makeInboundMessage({
        accountId: "acct-a",
        senderId: "user-a",
        messageId: "m-fail",
        text: "看这个",
        attachments: [],
        mediaFailures: [{ kind: "file", filename: "broken.pdf" }],
      }),
    );
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(1));

    const promptText = runtime.prompts[0]?.text ?? "";
    expect(promptText).toContain("附件下载失败");
    expect(promptText).toContain("broken.pdf");

    runtime.complete("嗯");
    await turnPromise;
  });
});

describe("M9 sender marker + broadcast hook", () => {
  it("appends -- from weixin <name> to the prompt", async () => {
    const { runtime, session } = setup({ senderLabel: (m) => `bot-${m.accountId}` });
    const turnPromise = session.handleUserMessage(
      makeInboundMessage({ accountId: "acct-a", senderId: "user-a", text: "hi" }),
    );
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(1));
    expect(runtime.prompts[0]!.text).toBe("hi\n\n-- from weixin bot-acct-a");

    runtime.complete("ok");
    await turnPromise;
  });

  it("broadcast hook gets the reply and skips the origin-only send", async () => {
    let broadcasted = "";
    const { runtime, transport, session } = setup({
      broadcastText: async (text) => {
        broadcasted = text;
      },
    });

    const turnPromise = session.handleUserMessage(
      makeInboundMessage({ accountId: "acct-a", senderId: "user-a", text: "hi" }),
    );
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(1));
    runtime.complete("broadcast me");
    await turnPromise;

    expect(broadcasted).toBe("broadcast me");
    expect(transport.sentTexts).toEqual([]); // origin send skipped when a broadcast hook is present
  });
});
