# ADR-0003：is_streaming 语义收敛与 group_chat_update 双触发（#14 / 方案 A）

- 状态：**Accepted，决策 3/4 已被 v0.5 功能收窄取代**（2026-08-05：`group_chat_update` 恢复为仅公共消息通知）
- 修订注记（2026-08-11）：决策 3「group_chat_update 双触发」（成员加入/离开、`is_streaming` 翻转、举手状态变化均复用广播）**superseded-by ADR-0008**——现行语义 = `group_chat_update` 仅由公共消息成功持久化触发（与 v0.5 超驰注记一致）；白板走独立 `board_update`（ADR-0007）；成员/流式状态变化不唤醒 Agent、不进 Agent 输入。决策 1/2（is_streaming 语义与 watchdog）已被 #77 修订注记覆盖、不受本次影响。
- 决策者：架构师（评审/契约定稿）、开发工程师（实现）、产品经理（#14 口径裁决、谓词式断言裁决）、测试工程师（验收 A1-A6）
- 关联：ISSUE-014 / GitHub #14（正在发言状态）、#12/#20/#21（TUI 呈现）、websocket-protocol.md 双触发注记（c57e28e）；延续 ADR-0002 的 CPU 敏感约束

## 背景

「正在发言」显示存在三类缺陷（#14）：

1. **误报**：`agent_start` 对任何 agent 运行点亮 `is_streaming`——用户直聊、私有分析等非群聊 turn 也显示"正在发言"；
2. **悬挂**：复位单点依赖 `agent_settled`；异常/中止路径走不到 settled 时 `is_streaming` 永久为 true（连接存活时 creator 被动存储并持续广播）；
3. **不即时**：character 侧 TUI 快照仅在 speak 响应与消息投递时刷新，成员/流式状态变化（无消息伴随）不触发刷新。

约束：协议格式与消息类型零变更（PM 裁决）；不引入轮询（ADR-0002 CPU 敏感先例）；与 M7 `isAgentActive`（增量排队语义）完全解耦。

## 决策

### 1. is_streaming 语义收敛（#14-A1/A2）：仅群聊触发 turn 点亮

`GroupChatInput.flush` 在投递前设置一次性标记（`markGroupChatTurnTriggered`），`agent_start` 消费该标记后才点亮 `is_streaming`（`consumeGroupChatTurnTriggered` 读后即清）。用户直聊/非群聊 turn 保持暗。

已知残余边缘（可接受）：flush 置位后若用户直聊 turn 先启动会误消费标记 → ≤5s 瞬态误亮，由 watchdog + settled 双重复位缓解；不为此引入队列级追踪。

> **#77 修订（2026-08-03，User 拍板）**：本决策被「正在工作」语义取代——`is_streaming` = run 活跃即亮（agent_start 无条件 `updateStreaming(true)`），不再区分触发源；`groupChatTurnTriggered` 标记机制已删除（决策 1 的误消费边缘随之消失）。保留部分：watchdog 悬挂兜底（决策 2）、与 `isAgentActive` 解耦——均不变。

### 2. 悬挂兜底（#14-A3）：agent_end watchdog + reload 补发

- **watchdog**：`agent_end` 时布防 5s 定时器，`agent_settled` 清除；超时未清则强制补发 `is_streaming=false`。Node 定时器不依赖 agent 状态，run 卡死仍触发。契约依据：pi `agent.ts` `handleRunFailure`（:511）在错误/中止路径（stopReason=aborted/error）**保证发射 `agent_end`**——布防在 end 即覆盖全部可救悬挂场景；仅进程级 kill/事件循环硬卡死不可救（由既有断连清理兜底）。
- **reload 角例**：reload 时旧 runtime 的定时器随 Extension Runtime 销毁而丢失；`activateFromHandoff` 显式补发一次 `update_character_state(false)`——M5 握手路径是唯一确定性覆盖点。
- `close()` 清理定时器，幂等。

### 3. group_chat_update 双触发语义（方案 A，通道复用）

> **v0.5 超驰（2026-08-05，User 裁决）**：本节不再适用。`group_chat_update` 只由公共消息触发；白板使用独立 `board_update`；成员加入/离开与 `is_streaming` 翻转不再广播该通知。Character 无消息时的成员/流式快照不保证实时刷新，以显式状态查询或下一次消息投递为准。

成员加入/离开、`is_streaming` 翻转、举手状态变化均复用 M7 的 `group_chat_update` 广播（原仅消息发布触发）。**非空群聊中两类触发负载不可区分**（成员广播同样携带最新 `latest_sequence` 与 preview）——这是有意的通道复用（协议格式零变更），消费端靠「每次 update 拉增量（按序号幂等）+ 刷新快照」自洽。无公开消息时广播 `latest_sequence=0`、`preview_messages=[]`。

### 4. 谓词式断言测试契约

> **v0.5 超驰**：双触发已移除，测试应精确断言成员/流式变化不产生 `group_chat_update`，公开消息通知按目标 sequence 断言。

`group_chat_update` 不得按广播触发源或到达顺序作精确断言（两类触发不可区分）；测试用谓词式断言（等快照满足条件：指定 sequence 出现、成员表含/不含某成员、preview 内容匹配）。PM 裁决为 A 组验收适配统一标准，QA 执行（断言强度不降反升）。

### 5. #21 修复：join 后主动拉取快照

`claimCharacter` 激活后主动 `getGroupChatState()`（失败静默，仅影响显示）——消除「首条公开消息前成员数未知」窗口。

## 否决的替代方案

| 方案 | 否决理由 |
| --- | --- |
| creator 侧超时/TTL 复位 | 钝器、引入第二计时来源，需新增协议字段或心跳语义，破坏零变更边界；creator 保持被动是既有架构约束 |
| character 侧定时轮询刷新 | 固定成本，与 ADR-0002 CPU 敏感史相悖；事件驱动（方案 A）零轮询成本 |
| 新增独立消息类型/字段区分触发源 | 违反"协议格式与消息类型零变更"裁决；消费端幂等拉取已自洽，无需区分 |
| watchdog 布防在 agent_start | 正常长 turn（数分钟）会被 5s 窗口误复位；布防在 agent_end（错误路径也保证发射）窗口仅覆盖 end→settled 间隙 |

## 附带决策（#37）

`DEFAULT_CONFIG_MAX_MESSAGES` 三处重复定义（config/creator/commands 各一）是 10→100 历史漏改的结构根因——收敛为 `load-config.ts` 单一导出，其余两处 import（A3-3 断言）。恢复路径（reload-handoff 传持久化值）不读默认值，历史群聊不受影响。
