# Global Rules

1. 当我只是在在**询问、征求意见、讨论方案**时，不要擅自进入实施。
2. 在进行和当前上下文无关的独立操作或者用户明确要求时使用 subagents。
3. **版本号更新规则（SemVer）**：
   - 无 **BREAKING** 变更（仅新增/修复/行为增强，用户无需手动升级）→ 只更新 `package.json`
     的 **`z`（patch）**，例如 `0.5.0 → 0.5.1`。
   - 有破坏性 / 需手动升级的变更（标记 `BREAKING`）→ 升 **`minor`**（`x.y`），必要时 **`major`**（`x`）。
   - `src/version.ts` 动态读 `package.json` 作为**唯一版本源**，改版只改 `package.json`。
   - 每次改版同步在 `CHANGELOG.md` 顶部新增对应版本条目（Keep a Changelog）。

---

# 项目文档索引

本项目的机制 / 领域模型文档在 [`docs/README.md`](docs/README.md)，建议按以下顺序阅读：

1. [`docs/domain-model.md`](docs/domain-model.md) —— 实体与变量的术语基准（先读）。
2. [`docs/routing.md`](docs/routing.md) —— 消息路由与会话生命周期。
3. [`docs/ilink-protocol.md`](docs/ilink-protocol.md) —— 微信 iLink 协议机制存档。
