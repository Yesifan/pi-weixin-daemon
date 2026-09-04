# 文档索引（docs/）

> pi-weixin-daemon 的机制 / 领域模型文档，建议按下面顺序阅读。

## 先读

- [`domain-model.md`](domain-model.md) —— 实体（微信真人 / 账号 / 项目 / 会话）与变量
  （`accountId`、`senderId`、`userId`、`context_token`…）的**术语基准**。

## 主题文档

- [`routing.md`](routing.md) —— 一条微信消息如何从真人到达 agent、回复如何回、会话如何生老病死。
- [`ilink-protocol.md`](ilink-protocol.md) —— 所依赖的微信 iLink 协议机制与官方参考实现的行为依据（登录产物、端点、媒体 CDN、monitor 容错、"两道门"、脱敏等）。**只引用、不发明。**
- [`LOCAL-DEPLOYMENT.md`](LOCAL-DEPLOYMENT.md) —— 本地部署 / 安装运行说明。

## 决策与需求存档

- 既定方案 / 待办需求：`requirements/`
- 架构决策记录（ADR）：`adr/`

## 阅读建议

想了解"系统怎么运作" → `domain-model.md` → `routing.md`；遇到协议 / 微信行为疑问 → `ilink-protocol.md`；想查某已定方案 / 待办 → `requirements/`、`adr/`。
