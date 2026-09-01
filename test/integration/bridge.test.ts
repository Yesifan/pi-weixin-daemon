import { describe, it, expect, vi } from "vitest";
import { Bridge } from "../../src/bridge/router.js";
import { MultiAccountTransport } from "../../src/bridge/multi-account-transport.js";
import { BUSY_REPLY } from "../../src/bridge/state.js";
import { createLogger } from "../../src/util/logger.js";
import { FakeAgentRuntime } from "../helpers/fake-runtime.js";
import { FakeWeixinTransport, makeInboundMessage } from "../helpers/fake-transport.js";

const logger = createLogger({ level: "silent" });

function setup() {
  const runtime = new FakeAgentRuntime();
  const transportA = new FakeWeixinTransport();
  const transportB = new FakeWeixinTransport();
  const multi = new MultiAccountTransport();
  multi.register("acct-a", transportA);
  multi.register("acct-b", transportB);
  const bridge = new Bridge({ transport: multi, logger });
  bridge.bindRuntime(runtime);
  bridge.attach();
  return { runtime, transportA, transportB, bridge };
}

const msgA = (text: string, id = "m1") =>
  makeInboundMessage({ accountId: "acct-a", senderId: "user-a", messageId: id, text });

const msgB = (text: string, id = "m2") =>
  makeInboundMessage({ accountId: "acct-b", senderId: "user-b", messageId: id, text });

describe("M6 bridge (fake transport + fake runtime)", () => {
  it("A starts a turn; B gets busy refusal; completion replies only to A", async () => {
    const { runtime, transportA, transportB, bridge } = setup();

    const turnPromise = transportA.emit(msgA("帮我写个计划"));
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(1));
    expect(runtime.prompts[0]?.text).toBe("帮我写个计划");
    expect(bridge.getState()).toBe("RUNNING");

    await transportB.emit(msgB("你好"));
    expect(transportB.textsTo("acct-b")).toEqual([BUSY_REPLY]);
    expect(transportA.textsTo("acct-b")).toEqual([]);

    runtime.complete("这是给 A 的回复。");
    await turnPromise;

    expect(transportA.textsTo("acct-a")).toEqual(["这是给 A 的回复。"]);
    expect(transportB.textsTo("acct-a")).toEqual([]);
    expect(transportA.textsTo("acct-b")).toEqual([]);
    expect(bridge.getState()).toBe("IDLE");
  });

  it("sets typing before the run and clears it after", async () => {
    const { runtime, transportA, bridge } = setup();

    const turnPromise = transportA.emit(msgA("hello"));
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(1));

    expect(transportA.typingEvents.map((t) => t.typing)).toEqual([true]);

    runtime.complete("done");
    await turnPromise;

    expect(transportA.typingEvents.map((t) => t.typing)).toEqual([true, false]);
    expect(bridge.getState()).toBe("IDLE");
  });

  it("two consecutive turns on the same account work", async () => {
    const { runtime, transportA, bridge } = setup();

    const t1 = transportA.emit(msgA("first", "m1"));
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(1));
    runtime.complete("reply one");
    await t1;

    const t2 = transportA.emit(msgA("second", "m2"));
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(2));
    runtime.complete("reply two");
    await t2;

    expect(transportA.textsTo("acct-a")).toEqual(["reply one", "reply two"]);
    expect(bridge.getState()).toBe("IDLE");
  });

  it("agent error produces an error reply to the turn origin", async () => {
    const { runtime, transportA, bridge } = setup();

    const turnPromise = transportA.emit(msgA("boom"));
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(1));
    runtime.fail(new Error("provider exploded"));
    await turnPromise;

    expect(transportA.textsTo("acct-a")[0]).toContain("provider exploded");
    expect(bridge.getState()).toBe("IDLE");
  });
});

describe("M6 commands over weixin", () => {
  it("/status works while running", async () => {
    const { runtime, transportA, bridge } = setup();
    const turnPromise = transportA.emit(msgA("task"));
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(1));

    await transportA.emit(msgA("/status", "m-status"));
    const statusReply = transportA.textsTo("acct-a").at(-1)!;
    expect(statusReply).toContain("Project:");
    expect(statusReply).toContain("Agent state: RUNNING");
    expect(statusReply).toContain("Model:");

    runtime.complete("ok");
    await turnPromise;
    expect(bridge.getState()).toBe("IDLE");
  });

  it("/new is refused while running, allowed when idle", async () => {
    const { runtime, transportA, bridge } = setup();

    const turnPromise = transportA.emit(msgA("task"));
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(1));

    await transportA.emit(msgA("/new", "m-new-busy"));
    expect(transportA.textsTo("acct-a").at(-1)).toContain("忙时不能新建会话");
    expect(runtime.newSessionCalls).toBe(0);

    runtime.complete("done");
    await turnPromise;

    await transportA.emit(msgA("/new", "m-new-idle"));
    expect(runtime.newSessionCalls).toBe(1);
  });

  it("/abort terminates the running agent and notifies the turn origin", async () => {
    const { runtime, transportA, bridge } = setup();

    const turnPromise = transportA.emit(msgA("long task"));
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(1));

    await transportA.emit(msgA("/abort", "m-abort"));
    await turnPromise;

    expect(runtime.prompts.length).toBe(1); // no second prompt
    expect(transportA.textsTo("acct-a").at(-1)).toContain("已中止");
    expect(bridge.getState()).toBe("IDLE");
  });

  it("unknown command gets a hint", async () => {
    const { transportA } = setup();
    await transportA.emit(msgA("/frobnicate"));
    expect(transportA.textsTo("acct-a").at(-1)).toContain("未知命令");
  });
});
