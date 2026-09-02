# 消息路由与会话生命周期

> 面向非读者，讲清两件事：一条微信消息怎么到达 agent、一个会话怎么生老病死。
> 实体/变量定义见 [`docs/domain-model.md`](domain-model.md)；协议机制见
> [`docs/ilink-protocol.md`](ilink-protocol.md)。

---

## 路由：微信真人 → 账号 → 项目 → 会话

```
  微信真人用户(owner)
     │  把消息发给哪个"账号"(bot)?
     ▼
   账号(account)
     │  查这个账号属于哪个"项目"
     │
     ├─ 未绑定 / 项目停用 ──▶ 丢弃
     │
     └─ 已绑定 ──▶ 项目
                     │
                     │ 一个项目只有一个会话
                     ▼
                   会话
                     │
                     ▼
          agent 处理,回复回给发起者(见下方"回复/广播")
```

- 一个账号只属于一个项目；一个项目可绑多个账号。
- 一个项目只有一个会话，所以多个账号 / 真人共用同一份上下文。
- 因为一个账号（bot）**只服务它绑定的 owner**（owner-scoped），所以
  `senderId`(= `from_user_id`) 恒等于 `account.userId`(= `ilink_user_id`)——
  即"谁发给这个账号"永远是"这个账号的主人"。

---

## 消息流

```
 微信真人(user)  ──发送消息A──▶  账号(bot)
        │
        ▼
   微信服务器 收到消息A
        │
        ▼
  pi-weixin 长轮询(getupdates) 拿到消息A
        │   # 归一化成 InboundMessage{ accountId=bot, senderId=user }
        ▼
  pi-weixin 投递到 项目 → ProjectRuntime → Bridge
        │   # 若加需求②：在文本末尾追加 "-- from weixin <账号name>"
        ▼
  pi agent 处理，生成回复消息B
        │
        ▼
  pi-weixin 把消息B 发给微信服务器      # 接收方 = senderId(=userId) + context_token
        │
        ▼
  微信服务器 通过 bot 把消息B 发回给 user
```

- **入站**：`getupdates` 长轮询 → 归一化 `InboundMessage` → 按 `accountId` 路由到项目 →
  `Bridge.ingest`。
- **出站**：回复使用 `TurnContext`（`accountId`/`senderId`/`context_token`）回传；
  `context_token` 必须原样回传。

---

## 回复 / 广播

- **文本回复**：默认只发给**发起者**（`TurnContext`）；但 project 层注入 `broadcastText` 后，
  agent 的最终回复会**广播**给项目内**所有**参与者（含发起者）——需求④。
- **消息互通**：某账号的 sender 发来消息时，同时通知同项目**其他**参与者，
  内容为 "`<该账号name>`: 消息文本"——需求③。
- **目标来源**：广播 / 互通的目标取自 **参与者注册表**（`ProjectRuntime` 记录每个项目下
  "实际发过消息的 `(accountId, senderId)` + `contextToken`"），不靠 `account.userId` 猜
  （避免 `ilink_user_id ≠ from_user_id` 出错）。
- **限制**：没发过消息 / 无 token 的账号不会出现在注册表里，也就不会收到（已知取舍）。

> 多用户场景（两用户→两账号→一项目）见 [`docs/domain-model.md`](domain-model.md) §1.7。

---

## 会话生命周期

```
   项目启动(新建)
     │  每次启动都新建一个会话
     ▼
   [会话 S]
     │
     ├─ 普通消息 ─▶ 进 S,agent 处理
     ├─ 空闲 ≥10 分钟 ──▶ 自动关闭会话 + 广播"本次会话已关闭"
     │                         └─> 下一条消息再新建一个会话
     ├─ /new     ─▶ 换成新会话 S'(旧上下文抛弃)
     ├─ /compact ─▶ 压缩 S(仍是 S)
     ├─ /abort   ─▶ 中止当前任务(仍是 S)
     └─ daemon 重启 ─▶ 新建一个会话
```

- 项目启动时**总新建**一个会话（不做跨重启恢复）；普通消息始终进这同一个会话。
- 只有 `/new` 或 daemon 重启（均新建）会改变"当前会话"；
  空闲自动关闭也是新建（下一条消息时）。`/compact`、`/abort` 仍只作用于当前会话，不换会话。
- 项目忙时，普通消息直接拒绝、不排队，不进会话。
