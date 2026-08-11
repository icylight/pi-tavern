# ADR-0004：群聊消息投递时机修订——next-LLM-boundary（steer）投递（#38）

- 状态：**Accepted**（2026-08-02，User 批准 #38 四项：口径 A/秒级延迟/分支名/复用 #38；落 feat/issue-38-live-delivery 分支）
- 决策者：架构师（契约定稿/评审）、开发工程师（实现）、产品经理（口径裁决/Task Brief）、测试工程师（验收 T1-T4）
- 关联：GitHub #38（角色发言同步延迟）、M7 A5（投递时机）、new-message-fetch §3 采访决策 #3/#4（原文档 docs/archive/new-message-fetch.md 已随 0.3.0 死文档清理删除，2026-08-08，分支 refactor/cleanup-dead-code；本 ADR 决策内容不受影响）、ADR-0003（不受本修订影响，见「与 ADR-0003 的关系」）
- 修订注记（2026-08-11）：决策 1「run 活跃期收到 group_chat_update 照常拉取 + steer 间隙投递」的**拉取动作**已被 ADR-0008 修订——现行忙态语义 = 零正文拉取（只置未读标记 + 隐藏令牌最多一个经 steer 队列），settled 后拉全未读并投递；本 ADR 其余决策（idle followUp / 忙态 steer 通道 / settle 收尾补投）不受影响，以 ADR-0008 为现行依据。

## 背景

M7（ISSUE-012/#24）冻结方案将投递时机定为「run 结束后立即投递」（需求点 4：「不打断」+「当前 run 结束后立即投递新消息并触发下一次输入」），实现为 `deliverAs:"followUp"` + run 活跃期零拉取（A2 实现层门控）。

User 反馈（#38）：角色发言同步延迟大——run 进行中（写代码/跑测试的长工具循环，分钟级）消息不进入上下文，需等 run 结束。延迟 = 剩余 run 时长。

## 关键事实（pi 源码核实，只读）

pi-agent-core `agent-loop.js` `runLoop`：内层循环每轮 turn（LLM 调用+工具批）结束后重新读取 steering 队列，消息注入于**下一 LLM 调用前**（"user may have typed while waiting" 原生机制）；`agent_end` 仅在外层循环退出时发射。

- `deliverAs:"steer"`：run 中排队，当前工具批结束后、下一 LLM 调用前注入上下文——**不发射 agent_start、不终止 run、无并发 turn**；
- `deliverAs:"followUp"`：等 agent 完成全部工具才投递（M7 现状）；
- 协议零变更：变更全部在 character 侧消费端（group-chat-input.ts），creator 侧零改动。

## 决策

1. **投递时机修订**：M7 A5「run 结束后投递」→「下一 LLM 边界投递（steer）+ settle 收尾补投」。
   - run 活跃期：收到 group_chat_update 照常拉取（放开 A2 零拉取门控），`sendMessage(deliverAs:"steer")` 间隙投递；
   - run 空闲：维持 `deliverAs:"followUp"` + `triggerTurn:true`（立即触发新 turn）；
   - settle 收尾：run 结束后补投游标后新窗口（沿用 onAgentSettled 钩子）。
2. **不变式（全部维持）**：
   - 不打断 run：无 agent_end、无 run 重启、无上下文丢失（steer 通道保证）；
   - 协议格式与消息类型零变更；creator 零改动；
   - isAgentActive 语义保留（仍用于 settle 收尾/守卫；#14 is_streaming 真值不变）；
   - 光标单点推进：run 中拉取照常 saveCursor，settle 补投从 cursor 后拉——单调（只前进不倒退）、不重不漏；
   - **#77 修订（2026-08-03，User 拍板）**：「正在发言」指示语义 = **run 活跃即亮**（agent_start 无条件 updateStreaming(true)），不区分触发源（群聊/steer/救援/私有直聊）；`groupChatTurnTriggered` 标记机制已删除（无消费方）；投递路径（idle followUp / 忙态 steer）不再涉及点亮判定；长工具循环下「正在工作」常亮数分钟 = **预期行为**（run 结束才复位，非卡死）。
3. **延迟目标**：秒级（单次工具调用间隙）。验收先例沿用 M7 A5：单测 ≤5s / 验收 ≤10s。

## 与 ADR-0003 的关系

ADR-0003 **不被修订**：is_streaming 语义收敛、watchdog 兜底、group_chat_update 双触发、与 isAgentActive 解耦——四项决策均与投递时机无关，全部保持。本 ADR 仅修订 M7 A5 投递时机。

## 否决的替代方案

| 方案 | 否决理由 |
| --- | --- |
| 维持 followUp（现状） | 延迟=剩余 run 时长，分钟级，与 #38 痛点同态 |
| steer 打断式投递（中断 run 再开新 turn） | 触碰「不打断 run」红线，上下文丢失风险 |
| agent 主动拉取工具 | 交互模型变更（新工具+行为训练），延迟仅软保证（agent 不自调则不可达），范围大 |
| run 中仅 TUI 可见不投递 | 只解决可观测性，不解决上下文延迟（#38 核心诉求）；且 appendEntry 与游标语义有显示重复代价 |

## 实现级补充（评审修订，随实现同批落盘）

### settle 竞态与修复

`deliverSteer` 原实现于 `await getGroupChatState()` 前检查 `isAgentActive`；若 run 在该 await 期间 settle，`sendMessage` 时 pi 已不 streaming 且 `triggerTurn:false` → 消息仅 append 不唤醒 agent，settle 钩子补拉因光标已推进而空窗口 → 错过唤醒。

修复（Dev 实施）：状态 fetch **之后**重新检查 `isAgentActive`（检查+发送在同一微任务内原子执行——不可分割、无事件交错）——已 settle → 走 idle 路径（markGroupChatTurnTriggered + followUp + triggerTurn=true，群聊触发 turn 点亮 is_streaming 语义正确）；仍活跃 → steer。

### 滞留救援

`agent_settled` 缺失时（wedged/aborted，#14 watchdog 场景）`isAgentActive` 长期滞留 true、settle 钩子永不触发 → 若 `triggerTurn:false` 会无限 append-only。修复：steer 分支 `triggerTurn:true`——streaming 时 pi 忽略该选项照常入队；非 streaming 时触发 run 唤醒。代价：救援 run 无 group-chat marker，is_streaming 显示暗（**接受**，watchdog 仍兜底复位）。

### 已知残余边缘（文档化，不钉测试）

steer 消息恰落在 run 最终边界对 steering 队列的读取之后 → 留在队列等下一次 run 启动时注入（亚毫秒窗口；无丢失、无重复；光标单调性不受影响——T2 断言成立）。

## 验收

QA T1-T4（unit 分支参数钉死：active=steer / idle=followUp+triggerTurn；光标单调不重不漏：间隙已投 7、settle 补 8..9；#14 双防线：steer 不触发 agent_start/不点亮 is_streaming、marker 生命周期；acceptance 端到端一条：streaming-truth 基建、run 窗口内有界可见）+ 3 处 A2 语义用例改写（:508/:567/:617）。
