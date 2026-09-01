import type { ExtensionUIContext, ExtensionUIDialogOptions, Theme } from "@earendil-works/pi-coding-agent";
import type { Logger } from "../util/logger.js";
import type { TurnContext, UiResponseBroker, WeixinTransport } from "../bridge/types.js";

export interface WeixinUIContextDeps {
  /** Bridges the dialog promise to the weixin message stream + busy state. */
  broker: UiResponseBroker;
  transport: Pick<WeixinTransport, "sendText">;
  getCurrentTurn: () => TurnContext | undefined;
  logger: Logger;
}

function parseConfirm(answer: string): boolean {
  const t = answer.trim().toLowerCase();
  if (/^(1|是|确定|确认|yes|y|true|ok)$/.test(t)) return true;
  if (/^(2|否|取消|no|n|false|cancel)$/.test(t)) return false;
  // Anything else counts as confirmation? No: default to cancel for safety.
  return false;
}

function parseSelect(answer: string, options: string[]): string | undefined {
  const t = answer.trim();
  const num = Number(t);
  if (Number.isInteger(num) && num >= 1 && num <= options.length) {
    return options[num - 1];
  }
  const exact = options.find((o) => o === t);
  if (exact) return exact;
  return options.find((o) => o.includes(t) || t.includes(o));
}

/**
 * ExtensionUIContext implemented over weixin DMs.
 *
 * - confirm/select/input: send the dialog to the current turn's account,
 *   enter WAITING_FOR_UI, resolve with the user's next ordinary message.
 * - notify: fire-and-forget text message.
 * - All terminal/TUI primitives are no-ops (v0.1; editor etc. unsupported).
 */
export class WeixinUIContext implements ExtensionUIContext {
  constructor(private readonly deps: WeixinUIContextDeps) {}

  private requireTurn(): TurnContext {
    const turn = this.deps.getCurrentTurn();
    if (!turn) throw new Error("no active turn for weixin UI interaction");
    return turn;
  }

  async confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean> {
    const turn = this.requireTurn();
    await this.deps.transport.sendText(
      turn,
      `🔔 ${title}\n\n${message}\n\n请回复：\n1. 确认\n2. 取消`,
    );
    this.deps.broker.beginUiInteraction();
    try {
      const answer = await this.deps.broker.waitForResponse(turn, opts);
      return parseConfirm(answer);
    } finally {
      this.deps.broker.endUiInteraction();
    }
  }

  async select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
    const turn = this.requireTurn();
    const list = options.map((o, i) => `${i + 1}. ${o}`).join("\n");
    await this.deps.transport.sendText(turn, `🔔 ${title}\n\n${list}\n\n请回复选项编号或内容。`);
    this.deps.broker.beginUiInteraction();
    try {
      const answer = await this.deps.broker.waitForResponse(turn, opts);
      return parseSelect(answer, options);
    } finally {
      this.deps.broker.endUiInteraction();
    }
  }

  async input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
    const turn = this.requireTurn();
    const hint = placeholder ? `\n\n（例如：${placeholder}）` : "";
    await this.deps.transport.sendText(turn, `⌨️ ${title}${hint}\n\n请直接回复内容。`);
    this.deps.broker.beginUiInteraction();
    try {
      return await this.deps.broker.waitForResponse(turn, opts);
    } finally {
      this.deps.broker.endUiInteraction();
    }
  }

  notify(message: string, type?: "info" | "warning" | "error"): void {
    const turn = this.deps.getCurrentTurn();
    if (!turn) return;
    const icon = type === "error" ? "❌" : type === "warning" ? "⚠️" : "ℹ️";
    void this.deps.transport
      .sendText(turn, `${icon} ${message}`)
      .catch((err: unknown) => this.deps.logger.warn({ err }, "notify send failed"));
  }

  // --- TUI-only primitives: no-ops in v0.1 (weixin has no terminal UI) ---
  // Parameters use loose types on purpose: these are inert stubs for an
  // interface whose TUI types are not exported from the SDK root.

  onTerminalInput(_handler: never): () => void {
    return () => {};
  }
  setStatus(_key: string, _text: string | undefined): void {}
  setWorkingMessage(_message?: string): void {}
  setWorkingVisible(_visible: boolean): void {}
  setWorkingIndicator(_options?: never): void {}
  setHiddenThinkingLabel(_label?: string): void {}
  setWidget(_key: string, _content: never, _options?: never): void {}
  setFooter(_factory: never): void {}
  setHeader(_factory: never): void {}
  setTitle(_title: string): void {}
  custom<T>(_factory: never, _options?: never): Promise<T> {
    return Promise.reject(new Error("custom UI is not supported by the weixin UI context"));
  }
  pasteToEditor(_text: string): void {}
  setEditorText(_text: string): void {}
  getEditorText(): string {
    return "";
  }
  editor(_title: string, _prefill?: string): Promise<string | undefined> {
    return Promise.reject(new Error("editor is not supported by the weixin UI context (v0.1)"));
  }
  addAutocompleteProvider(_factory: never): void {}
  setEditorComponent(_factory: never): void {}
  getEditorComponent(): never {
    return undefined as never;
  }
  readonly theme = {} as Theme;
  getAllThemes(): { name: string; path: string | undefined }[] {
    return [];
  }
  getTheme(_name: string): Theme | undefined {
    return undefined;
  }
  setTheme(_theme: string | Theme): { success: boolean; error?: string } {
    return { success: false, error: "theme switching is not supported by the weixin UI context" };
  }
  getToolsExpanded(): boolean {
    return false;
  }
  setToolsExpanded(_expanded: boolean): void {}
}
