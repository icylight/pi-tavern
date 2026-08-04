# 忙态打断投递（abort delivery）需求口径

> 状态：**已实现，验收中**（2026-08-04，分支 `feat/abort-interrupt-delivery`，单测 72/72 ✓）
> 属主：PM（需求口径）· Dev（实现）· QA（红测验收）· Arch（架构评审 + ADR）
> 关联：#64（pull 模型/零注入）、ISSUE-038（口径 A + steer）

## 1. 背景

忙态角色收到群聊新消息后，当前 run 继续生成旧回复，「收到」与「响应」分离——即使 steer 已注入新内容到上下文。

## 2. 决策

苍蓝星拍板（2026-08-04）：**忙态到达即 abort**。steer 退出打断主链路，仅作 abort 未生效时的兜底。

## 3. 需求口径（vFinal）

| 项 | 值 |
| --- | --- |
| 触发 | 忙态 + 消息到达 → 立即 `session.abort()` |
| 重开 | abort → agent 空闲 → followUp + triggerTurn 唤醒新 run → 按游标拉全部未读 |
| 参数 | 无（不要 N/C 冷却、不要相位判断） |
| 兜底 | abort 未生效时消息走 steer 入队（pi 队列自动处理） |
| 风险 | livelock（密集打断）→ QA 红测锚定 |

## 4. 验收锚点

1. 忙态到达 abort → 重开后消息可见
2. 游标单调、消息不重不漏
3. livelock：消息风暴后 agent 完成作答、队列排空
4. 副作用：工具执行中不打断（pi 层级保障，非扩展侧相位判断）

## 5. 影响面

- 代码：`src/character/group-chat-input.ts`（到达即 abort）、`character-runtime.ts`（abortAgent 注入）、`agent-lifecycle.ts`（ctx.abort 挂接）
- 测试缝：`/tavern-test-busy`（忙态模拟）+ `[tavern-inject] abort=1` 通知（M7 A6 风格）
- 契约：零 wire、零持久化

## 6. 分工

PM：需求口径 + commit/push 归口；Dev：实现（72/72 ✓）；QA：红测验收；Arch：ADR-0008。
