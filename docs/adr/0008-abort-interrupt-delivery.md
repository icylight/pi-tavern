# ADR-0008：忙态打断投递——steer 入队即 abort + followUp 重开（#64 投递机制演进）

- 状态：**Accepted**（2026-08-04，苍蓝星拍板 v0.5 定稿；实现中，分支 `feat/abort-interrupt-delivery` @ main 9fa950a）
- 决策者：苍蓝星（拍板）、PM（需求口径 docs/abort-delivery.md）、Arch（架构评审）、Dev（实现）、QA（红测先行/验收）
- 关联：ADR-0004（steer 投递，本 ADR 为其盲区补丁）、#64（pull 模型 / 运行中零注入）、ISSUE-038（口径 A + steer 双通道）、M7 A6（steer 观察通道）、pi SDK `session.abort()`（sdk.md:107）；验收先例 test/acceptance/j2-rpc-abort-no-loss.test.ts

## 背景

ADR-0004 确立忙态投递走 pi steer 通道（工具间隙秒级可见、绝不打断 run）。实测残留两个问题：

1. **收到与响应分离**：steer 注入上下文后，模型仍顺着旧思路写完当前回复，而非立即响应新消息；
2. **纯生成段盲区**：无工具间隙时 steer 事件入队但不注入，要等 run 结束才可见（首局海龟汤实测分钟级滞后）。

苍蓝星拍板（2026-08-04）：「需要打断」「不要保护，就是要密集打断」——以 abort 终止当前 run、带新消息重开，实现可见性与响应合一。

## 决策（口径 v0.5 最终）

### 1. 触发与流程

忙态 + `group_chat_update` 到达 → **立即 `session.abort()`**（主触发，无 steer 中间步）→ 拉取 → flush 重查：run 已空闲 → followUp + triggerTurn 唤醒重开（重开 run 按游标拉全未读）；abort 未生效（run 未终止）→ steer 入队兜底（消息经 pi steer 队列在 abort 后处理）。重开上下文 = 原上下文 + 全部未读，模型从头生成即见新消息。

**steer 退出忙态主链路**（实现形态对齐，2026-08-04 Dev/PM 确认）：消息在持久化流中，重开 run 按游标拉全未读即可，不需要先经 steer 入队——v0.5 的「deliverSteer 后立即 abort」简化为「到达即 abort」，steer 仅作 abort 未生效时的兜底通道。

### 2. 无保护参数

无 N/C 冷却、无次数上限（苍蓝星明确否决保护）。livelock 风险（消息频率 > 单轮完成时间时 run 难完成作答）已尽责告知，QA 红测锚定「消息风暴后 agent 转空闲、队列排空、游标不丢」；若实测卡死，届时苍蓝星再议。

### 3. 语义边界

- ① 忙态消息到达即打断（无 steer 中间步；abort 未生效时 steer 入队兜底）；
- ② idle 不打断（followUp 自然触发，现有路径不变）；
- ③ 被打断的在途输出不发布群聊（无半截消息）；
- ④ 游标单调、消息不重不漏（现有游标/持久化语义不变，零 wire、零持久化改动）；
- ⑤ **不做工具执行相位判断**：苍蓝星判定 steer 投递位置不会遇上工具执行中断，相位判断被否决；残余风险（工具执行中 abort → 在途工具结果丢失 → 重开可能重复执行副作用工具）以 QA 红测 b 锚点（副作用重复检测）+ 异常上报流程兜底，实测出现即上报再议。

### 4. 与 #64 的关系

投递机制演进：从「运行中零注入、绝不打断」（steer 工具间隙投递）演进为「打断 + 重开」路径——不向在途生成注入，而是终止当前 run、以含全部未读的上下文重开一轮。可见性与响应合一，以牺牲在途推理与回复连续性为代价（苍蓝星拍板接受）。

## 否决的替代方案

| 方案 | 否决理由 |
| --- | --- |
| N/C 保护参数（生成超时 + 打断冷却） | 苍蓝星否决（「不要保护，就是要密集打断」） |
| 工具执行相位判断（tool_execution_start/end 事件） | 苍蓝星否决（判定 steer 位置碰不到工具执行；经验路径 + b 锚点兜底） |
| 软修 2（run 起点「从简尽快」提示，压缩窗口） | 不满足「需要打断」拍板；降级为配套项 |
| 运行中注入（mid-generation injection） | pi 无此 API——生成中不可注入；abort 是平台唯一支持的打断路径 |

## 验收锚点

QA 红测 `abort-steer-visibility`（留痕 @ 9fa950a@acceptance，feat/abort-interrupt-delivery）：
- T1 可见性（红已证：忙态入队后 abort 通知缺席——打断逻辑未实现时的红钉有效性证明；形态无关断言：abort=1 通知存在 + 打断后消息可见）；
- T2 风暴排空（消息风暴后 agent 转空闲、队列排空、游标不丢——livelock 锚点）；
- T3 游标语义（单调、不重不漏）；
- b 副作用锚点（工具执行中被打断后无副作用重复执行）；
- 恢复质量（重开后正常作答，基线对照）。

## 测试缝（实现侧，PITAVERTEST 门控）

- `/tavern-test-busy <ms>` 命令（commands.ts + shared/messages.ts 常量）：挂起 isAgentActive + updateStreaming N ms 后复位——无 LLM 环境模拟忙态，使 abort 分支可执行；
- `abort=1` 观察通知：忙态分支 abort 决策处 `[tavern-inject] abort=1`（M7 A6 同款通道），验收可断言打断发生。

## 关联文档同步

- `docs/abort-delivery.md`：需求口径（PM 属主，v0.5 已定稿）；
- `docs/runtime-state-machine.md`：生命周期新增「打断态」（Dev 属主）；
- `docs/extension-architecture.md` 投递章节：abort 决策 + 重开流程（Dev 属主）；
- 边界交互：#66 wedged watchdog 与 abort 时序（abort 后 settle 事件到达处理）、#14 agent_end 看门狗共存（评审重点）。
