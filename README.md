# pi-weixin-daemon

将腾讯微信 iLink Bot 与 [Pi Coding Agent](https://github.com/earendil-works/pi) 直接连接的守护进程。

```text
                 Weixin iLink
          ┌──────────┴──────────┐
     Weixin Account A      Weixin Account B
          │                     │
       Poller A              Poller B
          └──────────┬──────────┘
                     │
              pi-weixin-daemon
                     │
             AgentSessionRuntime
                     │
                     ▼
                Project cwd
                     │
              ├─ .pi/settings.json
              ├─ .pi/extensions/
              ├─ .pi/skills/
              └─ AGENTS.md
```

## 特性

- **一个 daemon = 一个 project**：daemon 直接通过 `@earendil-works/pi-coding-agent` SDK 托管 AgentSession，绑定项目 cwd。
- **多微信账号**：一次扫码登录一个账号，可重复添加；所有账号共享同一个 Pi session。
- **TurnContext 回源**：每一轮请求记录来源（account/sender/context_token），回复、文件、UI 询问都只回到发起者。
- **Busy / Refuse**：不建消息队列；Agent 忙时新普通消息立即拒绝。
- **控制命令**：`/help` `/status` `/new` `/abort` `/compact`，其中 `/status` `/abort` 在 Agent 忙时仍可用。
- **项目自管理**：项目自己的 `.pi/settings.json`、`.pi/extensions/`、`.pi/skills/`、`AGENTS.md` 完全生效；daemon 运行时能力（`weixin_send_file`、微信 UI 适配）在内存中注入，不写入项目。
- **媒体**：微信图片进入 Pi 多模态输入；微信文件/视频/语音下载到 `<cwd>/.pi-weixin/inbox/`；Agent 可通过 `weixin_send_file` 发送原生微信附件。
- **Extension UI 经微信闭环**：项目 extension 的 `ctx.ui.confirm/select/input/notify` 通过微信完成（WAITING_FOR_UI 状态）。
- 无 HTTP server、无数据库、无消息队列、无 tmux、不经过 PI WEB。

## 安装

```bash
git clone <repo> && cd pi-weixin-daemon
corepack pnpm install
corepack pnpm build
# 链接到 PATH（可选）
ln -s "$PWD/dist/index.js" ~/.local/bin/pi-weixin-daemon
```

要求：Node.js >= 22.19。

## 使用

### 1. 登录微信账号

```bash
pi-weixin-daemon login        # 终端显示二维码，手机扫码
pi-weixin-daemon login        # 再次执行，添加第二个账号
pi-weixin-daemon accounts     # 查看已登录账号
```

账号凭据保存在 `~/.local/state/pi-weixin-daemon/`（可用 `PI_WEIXIN_STATE_DIR` 覆盖），不写入项目。

### 2. 诊断

```bash
pi-weixin-daemon doctor --cwd /path/to/project --account <id>
```

### 3. 运行

```bash
pi-weixin-daemon run \
  --cwd /home/you/code/project-a \
  --account account-a --account account-b
```

另一个项目启动另一个 daemon（不同 `--cwd`）。

### 4. systemd（用户级）

```bash
mkdir -p ~/.config/pi-weixin
cat > ~/.config/pi-weixin/project-a.env <<'EOF'
PI_WEIXIN_CWD=/home/you/code/project-a
PI_WEIXIN_ACCOUNTS=account-a account-b
EOF
cp systemd/pi-weixin@.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pi-weixin@project-a
journalctl --user -u pi-weixin@project-a -f
```

日志为 JSON 结构化输出（pino），直接适配 journald。

## 微信内命令

| 命令 | 说明 | 忙时可用 |
|---|---|---|
| `/help` | 显示帮助 | ✓ |
| `/status` | 项目 / session / Agent 状态 / 模型 / thinking | ✓ |
| `/abort` | 中止当前任务 | ✓ |
| `/new` | 新建会话 | 仅空闲 |
| `/compact` | 压缩会话 | 仅空闲 |

## Agent 能力

- **`weixin_send_file(path, caption?)`**：daemon 内存注入的工具（不写入项目 `.pi/extensions`，普通 `pi`/PI WEB 会话不可见）。自动发送到当前 Turn 的微信用户；仅允许 `cwd` 或 daemon 临时目录内的普通文件。
- **入站媒体**：图片 → 多模态输入；文件/视频/语音 → 下载到 `<cwd>/.pi-weixin/inbox/<message-id>/` 并在 prompt 中说明路径。`.pi-weixin/` 会自动加入项目 `.gitignore`。
- **Extension UI**：项目 extension 调用 `ctx.ui.confirm/select/input` 时，daemon 进入 `WAITING_FOR_UI`，通过微信与用户交互（其他账号仍 busy）；`ctx.ui.notify` 直接推送消息。TUI 专属能力（editor 等）v0.1 不实现。

## 架构

```text
Tencent/openclaw-weixin          # 微信协议参考（MIT，见 LICENSE.attribution）
        │ 提供微信协议参考
        ▼
   Weixin Transport              # src/weixin/（移植自腾讯，剥离 OpenClaw 依赖）
        │
        ▼
   pi-weixin-daemon              # src/bridge/ + src/daemon.ts（薄胶水层）
        │  TurnContext / busy state / UI bridge / runtime extension
        ▼
 Pi AgentSession SDK             # src/agent/（仅面向官方 SDK）
        ▼
     Project cwd                 # .pi/extensions .pi/skills .pi/settings AGENTS.md
```

依赖方向：`weixin → bridge → agent`。`agent/` 不依赖 iLink 类型；`weixin/` 不依赖 AgentSession；只有 `daemon.ts` 做组合。

## 测试

```bash
corepack pnpm test          # 单元 + fake transport 集成 + 真 Pi SDK 集成
```

三层测试：单元测试（busy 状态、命令路由、路径校验、账号存储、媒体解密等）、fake transport + fake runtime 集成（A 执行时 B 收 busy、回复只回 A、UI 路由）、真 Pi SDK + 真模型集成（项目 extension 加载、`weixin_send_file`、extension UI 经微信闭环）。

真实微信 E2E（扫码、双账号、媒体收发、重启恢复）需要真实账号，见 `test/integration/`。

## License

MIT。微信 transport 移植自 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（MIT），详见 [LICENSE.attribution](LICENSE.attribution)。
