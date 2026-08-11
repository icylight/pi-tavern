# PiTavern 文档

> 文档组织（教程 / 参考 / 解释 / 流程）。活文档只保留现行事实；历史过程由 Git 与 GitHub Issue / PR 追溯。新增、移动或删除文档时同步更新本文索引。

## 快速导航

| 你想找 | 去哪 |
| --- | --- |
| 安装 / 更新 / 故障排查 | [getting-started/install-scenarios.md](getting-started/install-scenarios.md) |
| 协议 / 持久化 / 状态机 / 术语 | [reference/](reference/) |
| 架构设计 / 边界条件 | [architecture/](architecture/) |
| 协作流程 / 验收 / 当前需求 | [development/](development/) |

## reference/（契约参考·单一事实源）

- [websocket-protocol.md](reference/websocket-protocol.md) — WebSocket 协议（wire 契约，零漂移）
- [persistence.md](reference/persistence.md) — 持久化模型（会话 / 游标 / 群聊状态 / 白板）
- [runtime-state-machine.md](reference/runtime-state-machine.md) — 运行时状态机
- [environment-injection.md](reference/environment-injection.md) — Agent 环境注入边界与消费路径
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

## development/（贡献者向·流程与约定）

- [workflow.md](development/workflow.md) — 协作工作流（四方/五方协作、分支纪律、验证留痕）
- [acceptance.md](development/acceptance.md) — 现行验收标准（功能「完成」的唯一判据）
- [0.4.0-requirements.md](development/0.4.0-requirements.md) — 当前版本需求基线
- [development-conventions.md](development/development-conventions.md) — 开发约定（注释语言 / prepare 红线 / 依赖归属红线）
- [architecture-backlog.md](development/architecture-backlog.md) — 仍有效的架构优化待办
- [review-checklist.md](development/review-checklist.md) — 方案、代码与交付对抗检查清单

## 维护纪律

- 契约文档（reference/websocket-protocol 等）零漂移：改动须四方声明影响面
- 已完成计划、一次性报告和已被现行事实源吸收的草稿不在仓库重复归档，通过 Git 与 GitHub 追溯
- 文档索引随新增、移动或删除同步更新
