# 领域模型（Domain Model）

> 定义 `pi-weixin-daemon` 里各**实体**与**变量**的确切含义，作为所有文档、代码、日志与
> 讨论的**术语基准**。阅读顺序：实体 → 变量速查 → 消息流 → 关键事实。
> 协议机制细节见 [`docs/ilink-protocol.md`](ilink-protocol.md)，路由见
> [`docs/routing.md`](routing.md)。

---

## 1. 实体（Entities）

本系统只有四类核心实体：微信真人用户、Bot 账号、项目、会话。外加两个"过程"实体：
入站消息 / 回合上下文。

### 1.1 微信真人用户（User，即 owner）

- 一个**真实的微信用户**，是系统的最终用户。
- 整个系统面向 **1：1 私聊**：一个 Bot 账号只服务于一个用户（扫码登录的人）。
- 身份标识：
  - `userId`：登录时服务端返回的 `ilink_user_id`（扫码人 = owner）。
  - `senderId`：入站消息里的 `from_user_id`（发消息的人）。
  - **两者恒指向同一个实体**（见 §4 关键事实 1）。

### 1.2 Bot 账号（Account）

- 一个通过**扫码登录**创建出来的"机器人"，绑定到一个微信真人用户。
- **标识**：`accountId`，即登录返回的 `ilink_bot_id`（服务端分配，作为路由 key）。
- **属性**（存于 `accounts/<accountId>.json`）：
  - `name`：用户用 `--name` 起的**别名**（全局唯一，如 `personal`/`work`）。
  - `token`：`bot_token`，用于鉴权（绝不打日志）。
  - `baseUrl`：有效 API base URL。
  - `userId`：绑定的微信真人用户（= owner）。
  - `savedAt`：登录时间。
- **归属**：一个 account 至多属于一个 project（多绑第二个会报错）。

### 1.3 项目（Project）

- 把若干 account 聚合到**同一个工作目录**，并共享一个 Pi 会话。
- **标识**：`projectId`（项目名，配置记录的 key）。
- **属性**（存于 `config.json`）：`cwd`、`accounts: accountId[]`、`enabled`。
- **运行时**：`ProjectRuntime`（一个项目一个），内含 `Bridge`
  （busy / abort / 发言范围 / 命令路由）。

### 1.4 会话（Session）

- 一个项目 = 一个 Pi `AgentSession`，**一份共享上下文**。
- 所有账号 / 用户的普通消息都进入这**同一个**会话；`/new` 换新会话（旧上下文抛弃）。
- 生命周期：新建 → 使用 → （空闲自动关闭，见需求①）→ 下次消息新建。
  （每次项目启动都新建会话，不跨重启恢复。）

### 1.5 入站消息（InboundMessage）

一条被归一化的微信私聊消息，是 agent 的输入。字段：

| 字段 | 含义 |
|---|---|
| `accountId` | 收到这条消息的 **bot 账号** |
| `senderId` | 发消息的**真人**（= owner） |
| `messageId` | 消息 id（`message_id` 或 `client_id`） |
| `contextToken` | 微信下发的会话上下文 token，回复必须回传 |
| `text` | 文本内容 |
| `attachments` | 附件（image / file / video / voice） |
| `createdAt` | `create_time_ms` |

### 1.6 回合上下文（TurnContext）

本轮 agent 回复的"来源 / 接收方"。**发文件、UI 询问只回到这个 context**；文本回复在启用
广播时会给项目内所有参与者各发一份（见 [`routing.md`](routing.md) 的"回复 / 广播"）。
字段：`accountId`、`senderId`、`messageId`、`contextToken`。

### 1.7 组合示例：两个用户 + 一个项目

```
                        项目 project
                ┌───────────┴───────────┐
            账号A (bot)               账号B (bot)
              │  1:1 owner-scoped        │
          用户a ───────────          用户b
        (userId_a / senderId_a)     (userId_b / senderId_b)
```

- 用户a ↔ 账号A：A 只服务 a；用户b ↔ 账号B：B 只服务 b。
- 两个账号都绑到**同一个项目**，共享**同一个会话**。
- 用户a 只通过账号A 发消息（`accountId=A`、`senderId=a`）；用户b 只通过账号B
  （`accountId=B`、`senderId=b`）。
- **a 和 b 是两个不同的人**：`senderId_a ≠ senderId_b`（各自在自己账号里独立）。

对应需求（互通 / 广播）：
- ③ a 发消息 → 通过账号B 给用户b 发一条 "`<账号A.name>`: 消息文本"。
- ④ agent 回复 → 通过账号A 给 a、通过账号B 给 b 各发一份。

---

## 2. 变量速查表

| 变量 | 来源 | 含义 | 等价 / 关系 |
|---|---|---|---|
| `accountId` | 登录 `ilink_bot_id` | **bot 账号**（收消息的一方） | 路由 key；账号存储索引 |
| `name` | `--name` | 账号**别名**（人话标识） | 全局唯一；仅展示/CLI |
| `userId` | 登录 `ilink_user_id` | **owner（微信真人）** | ＝ `senderId`（同实体） |
| `senderId` | 入站 `from_user_id` | 发消息的**真人** | ＝ `userId`（同实体） |
| `context_token` | 入站消息 | 会话上下文 token | 按 (account, user) 持久化 |
| `projectId` | 项目名 | 项目的 key | 一个账号 → 至多一个项目 |
| `sessionFile/sessionId` | Pi 会话 | 当前共享会话 | 一个项目一个会话 |

> **一句话**：`accountId` 是**机器人**；`userId`(=登录 `ilink_user_id`) 与 `senderId`(=消息
> `from_user_id`) 都指向**同一个真人(owner)**，但**字节级相等未被证明**；`name` 是机器人的
> **别名**。因此找人 / 广播用**实际观测到的 `senderId`**（参与者注册表），不靠 `account.userId` 猜。

---

## 3. 消息流

```
 微信真人(user)  ──发送消息A──▶  bot账号(account)
         │
         ▼
    微信服务器(iLink) 收到消息A
         │
         ▼
  pi-weixin 长轮询(getupdates) 拿到消息A   # 持有一条 from_user_id = user
         │        # 归一化成 InboundMessage{ accountId=bot, senderId=user }
         ▼
  pi-weixin 投递到 project → ProjectRuntime → Bridge
         │        # 需求②：给文本追加 "-- from weixin <账号name>"
         ▼
  pi agent 处理，生成回复消息B
         │
         ▼
  pi-weixin 把消息B 发给微信服务器      # 接收方 = senderId(=userId) + context_token
         │
         ▼
  微信服务器 通过 bot 把消息B 发回给 user
```

- 一个项目可绑定多个 account；每个 account 对应一台"bot"，服务各自的 owner。
- 一个项目只有一个会话，所以多个账号 / 用户**共用**同一份上下文。

---

## 4. 关键事实（决定功能可行性）

1. **`accountId` 是 bot；`userId` 与 `senderId` 指向同一个真人（owner）**。
   - bot 是 **owner-scoped**（`bot_type=3`），私聊 1：1、只面向扫码人，
     "没有别人随意给你的 bot 发消息"（见 `ilink-protocol.md` §0 / §1）。
   - `userId`(=登录 `ilink_user_id`) 与 `senderId`(=消息 `from_user_id`) 属同一身份空间，
     **极可能字节相等，但未逐次证明**；因此**不依赖**二者相等。
2. **实现用"参与者注册表"跟踪真实 `senderId`**。
   - 每条入站普通消息都把 `(accountId, senderId)` upsert 进当前项目的注册表，
     记录 `contextToken` / `lastSeenAt`。
   - 找"要给谁发消息 / 广播"**一律用注册表里的 `senderId`（=`from_user_id`）**，不用
     `account.userId` 去猜。这样即使 `ilink_user_id ≠ from_user_id` 也不出错。
3. **`context_token` 只能从入站消息获得**（或从持久化的 context-token 存储取）。
   - 注册表在收到消息时同步保存它；"没发过消息 / 无 token"的账号不会出现在注册表里，
     也就不会被广播到（已知取舍）。
4. **`from_user_id` 稳定不变**：它是 owner 的微信用户 id；只有账号重绑 / 换扫码人才变。

---

## 5. 与官方 openclaw-weixin 的差异

- 官方 `process-message.ts` 有**道 1：发送方鉴权**（`*-allowFrom.json` 白名单，
  兜底只信任扫码人自己的 `userId`）。
- **本地 `src/` 未实现**发送方鉴权，`normalizeInboundMessage` 只按
  `message_type===USER` 过滤。因为 bot 是 owner-scoped（发消息的恒为 owner），
  `senderId` 已代表 owner，按 owner-scoped 成立。
- 找人 / 广播：**不做"白名单"鉴权**，改为**参与者注册表**（记录实际发过消息的
  `senderId`），用它做互通与广播目标（见 `routing.md` 规划）。
- 「道 2：路由解析」对应本项目的 `accountId → projectId` 索引（见 `routing.md`）。

---

## 附：术语对照（本文件 vs 旧文档）

| 旧说法 | 本文件术语 |
|---|---|
| 微信用户 / 用户 | 微信真人用户（owner），标识 `userId`/`senderId` |
| 机器人 | Bot 账号（account），标识 `accountId`，别名 `name` |
| 项目 | 项目（project），`cwd` + 若干账号 + 一个会话 |
| 会话 | 会话（session），一个项目一个 Pi 会话 |
| 回复只回发起者 | 回复只回 `TurnContext`（当前）；广播见 `routing.md` 规划 |
