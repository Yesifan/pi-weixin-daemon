# pi-weixin-daemon

将腾讯微信 iLink Bot 与 [Pi Coding Agent](https://github.com/earendil-works/pi) 直接连接的守护进程。

```text
                 Weixin iLink
          ┌──────────┴──────────┐
     Account A            Account B
          │                     │
      AccountManager  (每账号一个 monitor，独立状态)
          └──────────┬──────────┘
                     │
        account→project 路由
                     │
              ProjectManager
        ┌────────────┴────────────┐
      ProjectRuntime foo     ProjectRuntime bar
      │  cwd + Pi session      │  cwd + Pi session
      │  busy/abort 作用域       │  busy/abort 作用域
      │  weixin_send_file 注入   │  weixin_send_file 注入
      └─────────────────────────┘
```

## 特性

- **一个 daemon = 多 project**：一次 `serve` 长期运行，一个 Project 绑定一个 Pi 会话（`ProjectRuntime`），按需启停（`project enable` / `disable`）。
- **一个 account 只属于一个 project**：`account → project` 单向映射；一账号绑第二个 project 会报错。未绑定 / disabled 的账号消息直接丢弃，不进入 Pi。
- **busy / abort 是 Project 作用域**：foo 忙、foo 被 abort、foo 出错都不影响 bar（严格故障隔离）。
- **多微信账号**：一次扫码登录一个账号，可重复添加；每个账号独立 monitor，多个账号可绑定到同一 project。
- **TurnContext 回源**：每一轮请求记录来源（account/sender/context_token），回复、文件、UI 询问都只回到发起者。
- **Busy / Refuse**：不建消息队列；Agent 忙时新普通消息立即拒绝。
- **控制命令**：`/help` `/status` `/new` `/abort` `/compact`，其中 `/status` `/abort` 在 Agent 忙时仍可用。
- **项目自管理**：项目自己的 `.pi/settings.json`、`.pi/extensions/`、`.pi/skills/`、`AGENTS.md` 完全生效；daemon 运行时能力（`weixin_send_file`、微信 UI 适配）在内存中注入，不写入项目。
- **媒体**：微信图片进入 Pi 多模态输入；微信文件/视频/语音下载到 `<cwd>/.pi-weixin/inbox/`；Agent 可通过 `weixin_send_file` 发送原生微信附件。
- **Extension UI 经微信闭环**：项目 extension 的 `ctx.ui.confirm/select/input/notify` 通过微信完成（WAITING_FOR_UI 状态）。
- 无 HTTP server、无数据库、无消息队列、无 tmux、不经过 PI WEB。

## 安装

要求：Node.js >= 22.19，pnpm **11.x**（本项目已用 `packageManager` 固定为 `pnpm@11.25.0`）。

> ⚠️ 推荐 11.x：pnpm 12 对 `install -g <本地路径/tarball>` 有回归（会把本地路径误当 registry 包名，报 `@scope` 错）。

```bash
git clone <repo> && cd pi-weixin-daemon
pnpm install        # 安装依赖并自动构建 dist
```

把 pnpm 全局 bin 目录加到 PATH（`pnpm config get global-bin-dir`，通常 `~/.local/share/pnpm/bin`）。

### 开发时全局安装（推荐）

```bash
pnpm install -g ./            # 跟随仓库构建
pnpm build && pnpm install -g ./   # 改源码后更新
```

`pi-weixin-daemon` 指向仓库里的 `dist/index.js`（依赖走仓库 `node_modules`）。

### 自包含（发布/独立安装）

```bash
pnpm build
pnpm pack --pack-destination release   # 产物集中放 release/（已 gitignore）
pnpm install -g ./release/pi-weixin-daemon-*.tgz
# 更新：重跑 pnpm build && pnpm pack && pnpm install -g ./release/pi-weixin-daemon-*.tgz
```

tarball 自带 dist 与依赖（在全局 store），安装后**不依赖 repo 目录**。

> `pi-weixin-daemon service install` 引用**当前运行的二进制**：开发装指向仓库 `dist`，自包含装指向全局 store。

### npm 等价用法

把 `pnpm` 换成 `npm`（npm 全局 bin 目录：`$(npm config get prefix)/bin`），`npm pack --pack-destination release` 与 `pnpm install -g` 分别对应 npm 的 `npm install -g`。

## 使用

### 1. 登录微信账号

```bash
pi-weixin-daemon login        # 终端显示二维码，手机扫码
pi-weixin-daemon login        # 再次执行，添加第二个账号（须为另一个微信用户）
pi-weixin-daemon accounts     # 查看已登录账号（含 id）
```

账号 id 为扫码返回的 `ilink_bot_id`（服务端分配，作为 Project 路由 key）。**同一微信用户只可扫码一次**；再次登录同一用户会替换旧账号（按 `ilink_user_id` 去重）。

账号凭据保存在 `$XDG_DATA_HOME/pi-weixin-daemon/accounts/`（默认 `~/.local/share/pi-weixin-daemon/accounts/`，可用 `PI_WEIXIN_DATA_DIR` 覆盖），不写入项目。

### 2. 诊断

```bash
pi-weixin-daemon doctor --cwd /path/to/project --account <id>
```

### 3. 启动 daemon + 注册 Project

```bash
# 装 systemd 用户服务 + 启动（前台由 systemd 托管）
pi-weixin-daemon service install
pi-weixin-daemon start

# 登录微信账号（账号 id = 扫码返回的 ilink_bot_id；同一用户只可扫码一次）
pi-weixin-daemon login        # 终端显示二维码，手机扫码
pi-weixin-daemon login        # 再扫一个（必须是另一个微信用户）
pi-weixin-daemon accounts     # 查看已登录账号的 id

# 注册 Project 并启用（--account 用 accounts 列出的账号 id）
pi-weixin-daemon project add foo --cwd ~/code/foo --account <账号id>
pi-weixin-daemon project add bar --cwd ~/code/bar --account <另一个账号id>
pi-weixin-daemon project enable foo
pi-weixin-daemon project enable bar

# 查看
pi-weixin-daemon project list
pi-weixin-daemon accounts
```

### 4. systemd（用户级）

```bash
pi-weixin-daemon service install   # 写入 ~/.config/systemd/user/pi-weixin-daemon.service（解析 CLI 绝对路径，不 sudo）
pi-weixin-daemon start             # systemctl --user start pi-weixin-daemon
pi-weixin-daemon logs              # journalctl --user -u pi-weixin-daemon
```

日志为 JSON 结构化输出（pino），直接适配 journald。`Restart=on-failure` 会在崩溃后自动拉起；`TimeoutStopSec=15` 配合 daemon 的优雅关闭。

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
Tencent/openclaw-weixin          # 微信协议参考（MIT，见 LICENSE.attribution，协议细节见 docs/ilink-protocol.md）
        │ 提供微信协议参考
        ▼
   Weixin Transport / AccountManager   # src/weixin/ + src/accounts/（每账号 monitor，先门后下）
        │
        ▼
   ProjectManager                      # src/projects/（Map<ProjectId, ProjectRuntime> + account→project 路由）
        │
        ├─ ProjectRuntime  →  Pi AgentSession SDK  →  项目 cwd
        └─ UDS RPC（控制面）→  CLI project/service/control/login
```

依赖方向：`weixin → accounts/projects → agent`。`agent/` 不依赖 iLink 类型；`weixin/` 不依赖 AgentSession；`daemon.ts` 做组合。

## 配置与存储（XDG）

- 配置：`$XDG_CONFIG_HOME/pi-weixin-daemon/config.json`（project 配置，daemon 唯一 writer，原子写）。
- 账号凭据：`$XDG_DATA_HOME/pi-weixin-daemon/accounts/`（凭据 + 索引；旧 `~/.local/state/pi-weixin-daemon/weixin/accounts` 会自动无损迁移）。
- 状态：`$XDG_STATE_HOME/pi-weixin-daemon/weixin/`（sync-buf / context-token）。
- UDS：`$XDG_RUNTIME_DIR/pi-weixin-daemon/daemon.sock`（0600）。

## 测试

```bash
corepack pnpm test          # 单元 + fake 集成 + 真 Pi SDK 集成 + UDS RPC 集成
```

层：单元（busy 状态、命令路由、路径校验、账号存储、媒体解密）、fake 集成（A 忙不影响 B、回复只回 A、UI 路由、多 project 隔离）、真 Pi SDK 集成（项目 extension、`weixin_send_file`）、Daemon/UDS RPC 集成（project add/list/enable、DaemonNotRunningError）。

真实微信 E2E（扫码、多账号、媒体收发、重启恢复）需要真实账号，见 `test/integration/`。

## License

MIT。微信 transport 移植自 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（MIT），详见 [LICENSE.attribution](LICENSE.attribution)。
