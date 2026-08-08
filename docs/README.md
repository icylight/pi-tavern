# PiTavern 文档

> 文档组织（开源通用标准：教程 / 参考 / 解释 / 流程，历史归档分离）。新增/移动文档时按本结构归类，并更新本文索引。

## 快速导航

| 你想找 | 去哪 |
| --- | --- |
| 安装 / 更新 / 故障排查 | [getting-started/install-scenarios.md](getting-started/install-scenarios.md) |
| 协议 / 持久化 / 状态机 / 术语 | [reference/](reference/) |
| 架构设计 / ADR | [architecture/](architecture/) |
| 协作流程 / 验收 / 里程碑 | [development/](development/) |
| 历史归档（已废弃 / 被替代） | [archive/](archive/) |

## reference/（契约参考·单一事实源）

- [websocket-protocol.md](reference/websocket-protocol.md) — WebSocket 协议（wire 契约，零漂移）
- [persistence.md](reference/persistence.md) — 持久化模型（会话 / 游标 / 群聊状态 / 白板）
- [runtime-state-machine.md](reference/runtime-state-machine.md) — 运行时状态机
- [terminology.md](reference/terminology.md) — 规范术语
- [who-is-spy.md](reference/who-is-spy.md) — 「谁是卧底」玩法规则
- [turtle-soup.md](reference/turtle-soup.md) — 「海龟汤」玩法规则（v2，2026-08-07 实战收敛）

## architecture/（架构解释）

- [architecture.md](architecture/architecture.md) — 五层依赖图（活文档，lint:layers 对照）
- [extension-architecture.md](architecture/extension-architecture.md) — pi 扩展架构
- [interaction-model.md](architecture/interaction-model.md) — 交互模型
- [boundary-conditions.md](architecture/boundary-conditions.md) — 边界条件
- [usage-scenarios.md](architecture/usage-scenarios.md) — 使用场景
- [group-chat-input.md](architecture/group-chat-input.md) / [discovery.md](architecture/discovery.md) / [headless-character.md](architecture/headless-character.md) — 设计文档
- [adr/](architecture/adr/) — 架构决策记录（含架构优化待办清单）

## development/（贡献者向·流程与约定）

- [workflow.md](development/workflow.md) — 协作工作流（四方/五方协作、分支纪律、验证留痕）
- [acceptance.md](development/acceptance.md) — 验收标准（功能「完成」的唯一判据）
- [implementation-plan.md](development/implementation-plan.md) — 里程碑计划（M0–M7）
- [development-conventions.md](development/development-conventions.md) — 开发约定（注释语言 / prepare 红线 / 依赖归属红线）
- [refactor-plan.md](development/refactor-plan.md) — 重构计划（五层架构，结构演进中以它为准）

## archive/（历史归档·不再维护）

> 归档文档均已在头部标注归档原因；引用计数应为零（新增引用即视为漂移）。

- [abort-delivery.md](archive/abort-delivery.md) — 被 ADR-0008 固化
- [brainstorm-convergence.md](archive/brainstorm-convergence.md) — 被 ADR-0007 固化
- [issue-123-review.md](archive/issue-123-review.md) — #123 评审留痕（2026-08-08 归档）

## 维护纪律

- 契约文档（reference/websocket-protocol 等）零漂移：改动须四方声明影响面
- 归档目录零引用：新文档不得引用 archive/ 内容（引用 = 应恢复维护）
- 文档索引随新增/移动同步更新
