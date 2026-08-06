# ADR-0008：以隐藏 steer 令牌在安全边界打断并重开

- 状态：**Accepted（2026-08-05 安全边界修正）**
- 关联：ADR-0004、#64 pull 模型、`feat/abort-interrupt-delivery`
- 契约影响：wire schema 与持久化 schema 零改动

## 背景

忙态角色收到新的公共群消息后，需要放弃基于旧上下文继续生成的回复，并在看到全部未读后重开。先前实现于通知到达时直接 `ctx.abort()`，可能中止仍在执行的工具；密集通知还会对同一 run 重复 abort，扩大副作用工具重复执行与 livelock 风险。

pi agent-loop 会在当前工具批完成后读取 steer 队列，并在下一次模型调用前把队列消息加入上下文；`context` 扩展钩子随后在 provider 请求前执行。这个位置是无需自行判断工具相位的安全边界。

## 决策

1. 忙态 `group_chat_update` 只置“未读待拉取”标记，不拉取群消息正文。
2. 可确认含他人公共消息时，最多向 steer 队列放一个 `pi-tavern.abort-control` custom message：`display:false`、正文为空。
3. `context` 钩子始终从模型上下文过滤所有该类型令牌。令牌作为内部记录保留在 pi session JSONL，这是已接受的取舍。
4. 仅当当前 Character 的输入管线仍有待打断状态、run 仍活跃且本 run 尚未请求 abort 时，令牌在该边界调用一次 `ctx.abort()`。
5. `agent_settled` 后按本 Session 游标拉取全部未读，过滤自身回显，通过 followUp + triggerTurn 重开；游标只在投递成功或拉取窗口确认全为自身回显时推进。
6. 密集通知合并为一个令牌、一次 abort、settled 后一次拉全。群消息正文从不进入 steer 队列。

## 自身回显

- preview 完整覆盖未读窗口且全部为自身消息：直接忽略，不排令牌、不拉取。
- preview 不完整且含自身消息：无法证明截断部分是否夹有他人消息，只保留未读标记，不排令牌；当前 run 自然 settled 后拉取，避免连续超过 preview 上限的自身消息触发自打断。
- 完整混合窗口或可确认的他人消息：正常排令牌。
- 拉取窗口全为自身回显：不生成 Agent 输入，但推进到窗口最新水位，避免永久重拉。

## 通知与 Agent 输入范围

`group_chat_update` 只由公共消息成功持久化触发。白板继续使用独立 `board_update` 并可进入 Agent 输入；加入时 `message_history` 只展开公共历史。`character_joined`、`character_left` 与流式状态变化只服务运行时状态或界面，不唤醒 Agent、不进入 Agent 输入。wire schema 保持不变。

## 时序

```text
公共消息通知到达
  → 未读标记=true，隐藏令牌最多排一个（当前工具仍执行，abort=0）
  → 当前工具批完成
  → agent-loop 消费 steer 令牌
  → context 过滤令牌，并在待打断状态下 ctx.abort()（abort=1）
  → agent_settled
  → fetch_messages_since(持久化游标)
  → followUp + triggerTurn 重开
```

## 结果与取舍

- 副作用工具不会被通知到达异步打断；工具结果先完成，再在模型边界终止旧 run。
- 公共消息仍以持久消息流和 Session 游标为唯一正文来源，不会因 abort 丢失或提前推进。
- 隐藏令牌会增加 session JSONL 内部记录，但不会展示，也不会进入任何后续模型上下文。
- 若 run 在令牌消费前因其他原因 settle，settle 路径仍拉取未读；残留令牌在后续 context 中只被过滤，不会因历史记录再次打断。

## 验证锚点

- unit：到达时零拉取/零 abort；context 边界一次 abort；历史令牌过滤；密集通知 N→1；自身回显超 preview 不打断；settled 拉全与游标单调。
- integration：成员/流式变化不产生公共消息通知或 Agent 输入；白板仍投递；自身与混合窗口正确。
- acceptance：观察 `abort=0 token=queued → abort=1 boundary=steer → settled → latest_seq/count`；连续消息最终收敛且无 livelock。
