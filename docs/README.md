# 文档索引（docs/）

> 本目录收录 pi-weixin-daemon 的机制 / 领域模型文档。建议按下面顺序阅读。

## 0. 领域模型（Domain Model）—— 先读这个

[`domain-model.md`](domain-model.md)
定义所有**实体**（微信真人 / 账号 / 项目 / 会话）与**变量**（`accountId`、`senderId`、
`userId`、`context_token`…）的确切含义，是整个项目与文档的**术语基准**。

## 1. 消息路由与会话生命周期

[`routing.md`](routing.md)
一条微信消息怎么从真人到达 agent、回复怎么回，以及一个会话怎么生老病死。
（术语对齐领域模型；含需求①③④的规划说明。）

## 2. iLink 协议机制存档

[`ilink-protocol.md`](ilink-protocol.md)
所依赖的微信 iLink 协议机制与官方参考实现的行为依据（登录产物、端点、媒体 CDN、
monitor 容错、"两道门"、脱敏等）。**只引用、不发明。**

## 3. 需求与决策记录

- [`requirements/0001-session-trust-fix.md`](requirements/0001-session-trust-fix.md) —— 需求：修复 `PiRuntime` 的 project trust 解析（对齐官方文档）。**✅ 已完成（`0.5.3`，commit `3c4c226`，涉及 ADR-0001/0002）**
- [`adr/0001-session-project-trust-resolution.md`](adr/0001-session-project-trust-resolution.md) —— ADR-0001：会话项目信任解析采用 pi 官方完整决策链。**✅ Accepted（`3c4c226`）**
- [`adr/0002-session-lazy-creation-and-status.md`](adr/0002-session-lazy-creation-and-status.md) —— ADR-0002：会话懒创建 + status 暴露 trust + `/new` 不空转。**✅ Accepted（`3c4c226`）**

## 阅读建议

- 想了解"这系统怎么运作" → 先 `domain-model.md`，再看 `routing.md`。
- 遇到协议 / 微信行为疑问 → `ilink-protocol.md`。
- 想了解某项已定方案/待办需求 → 见 `requirements/`、`adr/`。
