> **已归档**：被 ADR-0008 忙态打断投递固化（docs/architecture/adr/0008）。本文件不再维护，索引见 docs/README.md。

# 忙态打断投递（abort delivery）需求口径

> 状态：**安全边界修正已实现，验收中**（2026-08-05，分支 `feat/abort-interrupt-delivery`）
> 属主：PM（需求口径）· Dev（实现）· QA（红测验收）· Arch（架构评审 + ADR）
> 关联：#64（pull 模型/零注入）、ISSUE-038（口径 A + steer）

## 1. 背景

忙态角色收到群聊新消息后，当前 run 继续生成旧回复，「收到」与「响应」分离——即使 steer 已注入新内容到上下文。

## 2. 决策

忙态通知只置未读标记并排一个隐藏 steer 令牌。当前工具批完成、令牌在下一次模型调用前被消费时才 abort；settle 后拉全未读并通过 followUp 重开。群消息正文不进入 steer 队列。

## 3. 需求口径（vFinal）

| 项 | 值 |
| --- | --- |
| 触发 | 忙态 + 他人公共消息通知 → 最多排一个 `pi-tavern.abort-control` 隐藏令牌 |
| 安全边界 | 令牌在下一次模型调用前由 `context` 钩子消费，此时才 `ctx.abort()`；工具调用未完成前 abort=0 |
| 重开 | abort → agent settle/空闲 → 按游标拉全部未读 → followUp + triggerTurn 唤醒新 run |
| 合并 | 同一 run 的密集通知只产生一个令牌、一次安全边界 abort |
| 上下文 | 令牌 `display:false`、正文为空；所有历史令牌从模型上下文过滤，session JSONL 保留内部记录 |
| 自身回显 | 完整纯自身窗口直接忽略；preview 不完整且含自身消息时只保留待拉取状态，自然 settle 后拉取 |

触发门闸：`group_chat_update` 只由公共消息产生；成员/流式状态不走该通知。发送者自身回显在 preview 完整覆盖的纯自身窗口直接过滤，不触发 abort。

## 4. 验收锚点

1. 通知到达时当前工具未结束：abort=0；steer 边界消费令牌：abort=1；settled 后消息可见
2. 游标单调、消息不重不漏
3. 消息风暴只产生一个令牌和一次 abort，最终队列排空
4. 工具执行中不调用 abort，副作用工具结果先正常落定

## 5. 影响面

- 代码：`src/character/group-chat-input.ts`（令牌排队与未读状态）、`agent-lifecycle.ts`（context 过滤 + 安全边界 abort）
- 测试缝：`/tavern-test-busy` + `[tavern-inject] abort=0 token=queued` / `abort=1 boundary=steer`
- 契约：零 wire、零持久化

## 6. 分工

PM：需求口径 + commit/push 归口；Dev：实现；QA：验收；Arch：ADR-0008。
