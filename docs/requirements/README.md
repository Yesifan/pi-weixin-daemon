## 需求与决策记录

- [`requirements/0001-session-trust-fix.md`](requirements/0001-session-trust-fix.md) —— 需求：修复 `PiRuntime` 的 project trust 解析（对齐官方文档）。**✅ 已完成（`0.5.3`，commit `3c4c226`，涉及 ADR-0001/0002）**
- [`adr/0001-session-project-trust-resolution.md`](adr/0001-session-project-trust-resolution.md) —— ADR-0001：会话项目信任解析采用 pi 官方完整决策链。**✅ Accepted（`3c4c226`）**
- [`adr/0002-session-lazy-creation-and-status.md`](adr/0002-session-lazy-creation-and-status.md) —— ADR-0002：会话懒创建 + status 暴露 trust + `/new` 不空转。**✅ Accepted（`3c4c226`）**
- [`requirements/0002-pi-host-compatibility.md`](requirements/0002-pi-host-compatibility.md) —— 需求：Pi host 兼容性重构 —— 架构优先、五阶段（对齐 pi 0.84.4 host 语义）。**✅ 已完成（`0.6.0`，涉及 ADR-0003/0004）**
- [`adr/0003-pi-host-compatibility-policies.md`](adr/0003-pi-host-compatibility-policies.md) —— ADR-0003：Pi host 兼容性策略（per-project fail-closed / cwd 固定 + accounts 重建 / idle 真关闭 / 微信 slash 语义 / UI 降级 / trust 双字段 / send_file 无边界）。**✅ Accepted（`0.6.0`）**
- [`adr/0004-layering-and-dependency-direction.md`](adr/0004-layering-and-dependency-direction.md) —— ADR-0004：分层与依赖方向（PiSdkHost / SessionController / ProjectController，只有 `src/pi/` import SDK）。**✅ Accepted（`0.6.0`）**
