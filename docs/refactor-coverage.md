# 重构覆盖现状表（QA 属主，2026-08-02，ADR-0005 评审输入）

> 数据口径：`src/` 下 22 个 .ts 文件（6437 行），测试引用 = 测试文件中的显式 import（`from "…/src/….js"`）。
> acceptance 通过 PiProcess 全进程启动会**间接**覆盖多数模块，下表「直接引用」仅指显式 import 钉住。
> 层归属 = ADR-0005 目标映射（Draft 待收敛）。

## 22 文件覆盖现状

| 文件 | 行数 | 目标层 | 直接测试引用 | 现状 |
| --- | --- | --- | --- | --- |
| creator/creator-runtime.ts | 1882 | runtime（瘦身） | commands.test, extension.test（unit） | unit 钉住 |
| character/character-runtime.ts | 769 | runtime（瘦身） | commands.test, extension.test（unit） | unit 钉住 |
| character/group-chat-input.ts | 513 | application/character-pipelines（**补映射**） | — | **裸奔** ⚠️ #38 契约面 |
| protocol/messages.ts | 437 | shared | — | 裸奔（契约面，零 diff 约束） |
| commands.ts | 422 | adapter | commands.test（unit） | unit 钉住 |
| index.ts | 416 | adapter（入口/装配点） | extension.test（unit） | unit 钉住 |
| character/join-attempt.ts | 311 | runtime | commands.test, extension.test（unit） | unit 钉住 |
| controller/tavern-controller.ts | 252 | application（管线雏形） | commands.test, extension.test（unit） | unit 钉住 |
| discovery/active-descriptor.ts | 185 | skills | commands.test, extension.test + **5 个 acceptance** | **覆盖最厚（8 引用）** |
| config/character-card.ts | 163 | shared | commands.test（unit） | unit 钉住 |
| headless.ts | 150 | adapter | — | 裸奔（薄壳，间接覆盖） |
| controller/reload-handoff-registry.ts | 150 | runtime | extension.test（unit） | unit 钉住 |
| ui/tavern-ui-presenter.ts | 135 | adapter | — | 裸奔（UI 渲染，间接覆盖） |
| creator/group-chat-sessions.ts | 126 | skills | — | 裸奔 ⚠️ |
| discovery/discover-group-chats.ts | 125 | skills（按「多处入口复用」裁决可移 application） | — | 裸奔 ⚠️ |
| creator/group-chat-state.ts | 107 | skills | commands.test, extension.test（unit） | unit 钉住 |
| config/load-config.ts | 88 | shared | — | 裸奔（薄壳） |
| ui/resume-projection.ts | 73 | skills | — | 裸奔（**Arch 称有 15 单测先例**，经 presenter 间接测） |
| protocol/codec.ts | 64 | shared | — | 裸奔（契约面，零 diff 约束） |
| ui/renderers.ts | 26 | adapter | — | 裸奔（薄壳） |
| shared/runtime-close.ts | 22 | shared | — | 裸奔（薄壳） |
| shared/constants.ts | 21 | shared | — | 裸奔（薄壳） |

## 试点排序建议（QA）

1. **resume-projection**（73L，纯计算，独立性强，回退成本最低）
2. **active-descriptor**（185L，覆盖最厚 = 迁移兜底最强）
3. **group-chat-state / group-chat-sessions**（107L 有钉 / 126L 裸奔先补钉）
4. **discover-group-chats**（125L，裸奔 → characterize-first 钉测为硬性前置）
5. **group-chat-input**（513L 大文件裸奔 + #38 契约面 → **Phase 2 最难点，先行钉测规划**）

## 钉测优先级（characterize-first）

- 高：group-chat-input（#38 steer 契约）、discover-group-chats、group-chat-sessions
- 中：resume-projection（补正式钉测，现有先例经 presenter 间接）、tavern-ui-presenter
- 低：薄壳（headless/load-config/renderers/constants/runtime-close——迁移时顺带钉即可）

## 隐藏收益

五阶段每拆一层补一层钉测：Phase 1 结束后裸奔文件数应从 12 → 8 以下；
Phase 3 里程碑全链门禁时，全仓直接测试引用覆盖应从 10/22 提升至 14+/22。
