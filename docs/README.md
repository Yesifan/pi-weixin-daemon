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

## 阅读建议

- 想了解"这系统怎么运作" → 先 `domain-model.md`，再看 `routing.md`。
- 遇到协议 / 微信行为疑问 → `ilink-protocol.md`。
