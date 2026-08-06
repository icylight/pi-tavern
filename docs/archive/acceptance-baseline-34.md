> **已归档**：已废弃基线（#34，被 baseline-45 替代）。本文件不再维护，索引见 docs/README.md。

> **已废弃（#34 2026-08-02 基线，被 acceptance-baseline-0.1.0.md 取代）**——留档不删。

# #34 验收套件基线复核（②号门禁）

- 日期：2026-08-02
- 分支：feat/tui-widget-accuracy（HEAD 于 82547f0 分层①之后）
- 复核人：QA
- 复核对象：`vitest.acceptance.config.ts`（2-worker 限制，QA 属主，#34 调优）
- 入口：`npm run test:acceptance`（**必须**——注入 `PITAVERN_TEST=1`，测试命令
  tavern-test-message/tavern-test-reload 仅在 PITAVERN_TEST=1 时注册；
  直接 `npx vitest` 会因命令未注册而假红，已排除为执行方式问题，非产品回归）

## 结果

| 套件 | 文件 | 用例 | 时长 | 判定 |
| --- | --- | --- | --- | --- |
| acceptance（10 文件） | 10/10 | 16/16 | 70.96s | 通过 |

## 与基线对比

- #34 调优前基线：~66s（2026-08-02 全量）
- main 预演基线：63.6s（2026-08-02 13:20，标准入口）
- 本次：70.96s —— 偏差 +5~7s，属负载敏感型套件已知波动带
  （#32/#34 已记录：验收套件对机器争抢敏感，>5s 超时曾因负载触发）
- 无失败、无 flaky、用例数量一致（16/16）→ **判定：#34 调优无回归**

## 分层①零行为变更复核（顺带确认）

- acceptance 9 个测试文件未在①的 git mv 范围内，`vitest.acceptance.config.ts`
  include 未变 → 可比性成立
- `npm run test:unit`（Dev 门禁）：12/12 文件、121/121 全绿，4.58s
- `npm run test:integration`（QA 属主）：5/5 文件、73/73 全绿，5.48s
- 三层合计 210 用例全绿

## 结论

②号门禁通过。A 组（TUI 增强）可开工，红测先行：
- U1-U4 presenter 单测 → unit 层（Dev 写）
- A1-A4（真实 pi 事件驱动：is_streaming 翻转/非群聊不点亮/悬挂兜底/多连接）
  → acceptance 层（QA 写，进程级依赖，按测试性质落层原则）
- A5（hand_raised 真值流转）、A6（join 后主动拉取成员数）
  → integration 层（QA 写，进程内 WS 可覆盖）
