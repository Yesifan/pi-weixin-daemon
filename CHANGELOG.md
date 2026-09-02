# Changelog

All notable changes to this project are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/) and [Semantic Versioning](https://semver.org/).
`BREAKING` sections note changes that require manual upgrade action.

---

## [0.3.0] - BREAKING

### BREAKING CHANGES

- **CLI 命令改名**：`pi-weixin-daemon` → `pi-wx`。
  - systemd 单元名**仍为** `pi-weixin-daemon.service`；`pi-wx start` / `stop` / `restart` / `status` / `logs`
    仍操作 `systemctl --user ... pi-weixin-daemon` 与 `journalctl --user -u pi-weixin-daemon`。
- **`login` 现在必需 `--name <label>`**：`name` 是用户起的账号标识（全局唯一），账号 **id 仍为 `ilink_bot_id`**
  （扫码返回，作项目路由 key）。
- **移除 `project add <name> --account <id>`**：改为
  `project create <name> --cwd <path>` + `project <name> add <label>`。
- **账号存储新增 `name` 字段**：旧版无 `name` 的账号**不做迁移**。

### Added

- `project <name> add <label>` / `project <name> remove <label>`：按 `name` 定位账号，落库存 `ilink_bot_id`，展示按 `name`。
- `service install` 的 unit 增加 `EnvironmentFile=-%h/.config/pi-weixin-daemon/env`（`-` 前缀：缺失不致命；用于覆盖 shell 环境变量，例如模型 API key）。
- `accounts` 输出新增 `NAME`（`--name` 标识）与 `SINCE`（登录时间 `savedAt`）。
- `doctor` 新增「模型可用性检查」：解析 `defaultProvider` / `defaultModel`，判断该 provider 是否已配凭据。

### Upgrade

1. **（可选）卸载旧全局 bin**：`pnpm remove -g pi-weixin-daemon`（或 `npm uninstall -g pi-weixin-daemon`）。
2. **安装新的 `pi-wx`**：
   ```bash
   pnpm build
   pnpm pack --pack-destination release
   pnpm install -g ./release/pi-weixin-daemon-*.tgz
   ```
   之后命令变为 `pi-wx`。
3. **旧账号无 `name`**：需重新扫码登录并带 `--name`：
   ```bash
   pi-wx login --name <label>
   ```
   （旧账号不被迁移；重复名会报错。）
4. **已有项目若 `accounts` 引用旧 id**：重建项目（`project create` + `project <name> add <label>`）。
5. **systemd**：单元名未变，`systemctl --user daemon-reload` 即可；如担心可重跑 `pi-wx service install`。

---

## [0.2.0]

### Added

- 单 daemon 管理多 Project（`ProjectManager` / `ProjectRuntime`）。
- `account → project` 单向路由；busy/abort/error 为 Project 作用域。
- UDS RPC 控制面 + `project` / `service` / `control` / `login` / `accounts` CLI。
- systemd 用户服务（`service install` / `start` / `logs`）。
- XDG 路径统一（config / data / state / runtime）。
- `login --name`（0.3.0 变为必选）、`pi-wx` 命令名（0.3.0 正式改名）。
