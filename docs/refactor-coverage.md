# 重构覆盖现状表（QA 属主，2026-08-02，v2 修正版）

> 数据口径：`src/` 下 22 个 .ts 文件（6437 行）；测试引用 = 测试文件显式 import（任意层级相对路径，含 `../../../src/` 形态）。
> **v2 修正**：初版（v1，随 #55 入库）扫描正则漏匹配三层相对路径，严重低估覆盖——「9 unit 钉住 / 12 裸奔」作废，以本版为准。
> 层归属 = ADR-0005 目标映射（v5）。

## 22 文件覆盖现状（v2 实测）

| 文件 | 行数 | 目标层 | 直接测试引用（数量/层级） | 现状 |
| --- | --- | --- | --- | --- |
| creator/creator-runtime.ts | 1882 | runtime（瘦身） | 10（unit×4 + integration×5 + unit-ui×1） | unit+integration 钉住 |
| character/character-runtime.ts | 769 | runtime（瘦身） | 6（unit×3 + integration×2 + unit-char×1） | unit+integration 钉住 |
| character/group-chat-input.ts | 513 | application/character-pipelines | 1（unit 专测，**19 用例**） | unit 钉住（#38 语义面） |
| protocol/messages.ts | 437 | shared | 1（unit，经 group-chat-input 专测引用） | 间接钉住（编解码走 codec 专测） |
| commands.ts | 422 | adapter | 1（unit 专测） | unit 钉住 |
| index.ts | 416 | adapter（入口/装配点） | 1（unit） | unit 钉住 |
| character/join-attempt.ts | 311 | runtime | 6（unit×3 + integration×3） | unit+integration 钉住 |
| controller/tavern-controller.ts | 252 | application（管线雏形） | 4（unit×3 + unit-ui×1） | unit 钉住 |
| discovery/active-descriptor.ts | 185 | skills | **13**（unit×5 + integration×3 + acceptance×5） | **覆盖最厚** |
| config/character-card.ts | 163 | shared | 8（unit×3 + integration×5） | unit+integration 钉住 |
| headless.ts | 150 | adapter | — | 裸奔（薄壳，acceptance 间接） |
| controller/reload-handoff-registry.ts | 150 | runtime | 4（unit×3 + integration×1） | unit+integration 钉住 |
| ui/tavern-ui-presenter.ts | 135 | adapter | 1（unit 专测） | unit 钉住 |
| creator/group-chat-sessions.ts | 126 | skills | 1（unit 专测） | unit 钉住 |
| discovery/discover-group-chats.ts | 125 | skills | 1（integration 专测） | integration 钉住 |
| creator/group-chat-state.ts | 107 | skills | 4（unit×4） | unit 钉住 |
| config/load-config.ts | 88 | shared | 1（unit 专测） | unit 钉住 |
| ui/resume-projection.ts | 73 | skills | 1（unit 专测，**12 用例**） | unit 钉住（#42 契约固化） |
| protocol/codec.ts | 64 | shared | 2（unit 专测 **9 用例** + integration） | unit 钉住（**codec 钉测小项已完成**） |
| ui/renderers.ts | 26 | adapter | — | 裸奔（薄壳） |
| shared/runtime-close.ts | 22 | shared | — | 裸奔（薄壳） |
| shared/constants.ts | 21 | shared | — | 裸奔（薄壳） |

## 汇总

- **unit 钉住 18/22**，integration 钉住 11/22，acceptance 钉住 1/22（active-descriptor 5 引用）
- **裸奔仅 4 个，全是薄壳**：headless（150L）/ renderers（26L）/ runtime-close（22L）/ constants（21L）——无大文件裸奔
- **codec 钉测小项：已存在**（test/unit/protocol/codec.test.ts，9 用例）——立项验收口径中「codec 钉测可先行」已完成，无需新增（如需增强可后续按契约变更走）
- group-chat-input「三重风险」修正：有 19 用例专测（#38 语义面钉测好于 v1 判断），风险降级为「大文件 + 迁移面广」，仍是 Phase 2 最难点

## 试点排序建议（QA，v2 修正）

1. **resume-projection**（73L，12 钉测，#42 契约固化——characterize-first 模板现成）
2. **active-descriptor**（185L，13 引用最厚——迁移兜底最强）
3. **group-chat-state / group-chat-sessions**（107L 4 钉 / 126L 专测）
4. **discover-group-chats**（125L integration 专测——非裸奔，v1 判断修正）
5. **group-chat-input**（513L 19 钉测——Phase 2 最难点，钉测已厚）

## 隐藏收益（v2 修正）

五阶段每拆一层补一层钉测：Phase 1 结束后裸奔 4 薄壳 → 顺带补钉至 1-2；Phase 3 里程碑后全仓直接引用覆盖应达 20+/22。
