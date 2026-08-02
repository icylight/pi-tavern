# 需求：角色获取新消息的交互调整（推送 + 拉取混合）

> 状态：**历史决策记录**——#24 方案已实施；投递时机口径后经 #60/#64 修订为 **pull 模型**，并经 User 2026-08-02 拍板恢复忙态 steer 投递（闲态 1s 聚合窗口 / 忙态 update 到达即拉取 + steer 通道工具间隙投递 / settle 补拉全兜底；游标双通道判定），本文档中与 pull 模型冲突的旧口径（立即拉取、无防抖、缺口检测、严格不重不漏、群聊级游标文件）以第 11 节修订表为准，其余字段/接口契约仍有效。
> GitHub issue：**#24**（https://github.com/icylight/pi-tavern/issues/24，本地 ISSUE-012）。
> 分支：`feat/new-message-fetch`（已从 main 切出）。
> 本文档是需求的事实来源；协议/实现细节以第 10 节冻结方案为准，验收标准以第 7 节为准。

## 1. 背景与动机

现状（`docs/group-chat-input.md`）：服务端 WebSocket **推送**环境消息，角色侧固定 **1 秒 trailing-edge 防抖**后打包成一条 `pi-tavern.group-chat-input` custom_message 投递给当前 pi Agent。

痛点（User 确认，选项 A）：**消息延迟 / 触发时机不满意**。固定防抖被动接收，角色没有"主动获取"的能力。

目标体验（User 原话）：**像微信**——服务端通知"有新消息"，角色"点进微信"主动从上次看到的位置开始获取。

## 2. 目标形态（User 确认版）

**核心：推送 + 拉取混合。广播只做唤醒通知，内容由角色主动拉取。**

1. **广播 → 通知**：服务端推送简化为"群聊更新"通知，携带最近几条消息（微信通知形态）+ 最新消息序号；不再承载完整消息流职责。
2. **游标（已读位置）**：角色侧本地**持久化**记录"上次成功投递的最后一条消息 sequence"（群聊消息流中的位置），重启不丢。
3. **触发（无防抖）**：收到广播 → 角色**立即**执行一次增量拉取（从持久化游标开始）；**取消现有 1 秒防抖**。
4. **不打断**：拉取与投递**不打断**当前正在进行的 Agent run；当前 run 结束后**立即**投递新消息并触发下一次输入。
5. **兜底**：**缺口检测**（广播携带的最新序号 ≠ 本地游标 + 1 → 立即拉取补齐）+ **重连/join 差分同步**（有游标则按游标拉增量；无游标才走现有全量分页）。
6. **统一逻辑**：通知携带的消息 = 用户（TUI/人）看到的 = agent 上下文收到的，**同一份数据、同一套逻辑**，不做"预览 vs 完整"两套。
7. **验收方向**：当前 run 结束 → 新消息进入角色上下文，间隔 ≤ X 秒（X 待定，建议 5s）；run 全程不被打断；重启后游标保留、消息不重不漏。

## 3. 采访决策记录（2026-08-01，User Persona）

| # | 问题 | 决策 |
| --- | --- | --- |
| 1 | 痛点 | A：消息延迟/触发时机（非上下文膨胀） |
| 2 | 形态 | 推送 + 拉取混合 |
| 3 | 触发时机 | 收到广播后即可执行一次获取；获取不打断 agent 当前工作；当前工作执行完后**立即**获取（确认：空闲立即、忙则 run 结束后立即；**无需防抖**） |
| 4 | 影响面 | 协议层、Server、角色侧都要改 |
| 5 | 验收参照 | 微信：通知有新消息 → 点进微信 → 从上次看到的位置开始获取 |
| 6 | 广播内容 | 简化为"群聊更新"通知，可保留最近几条消息预览（微信通知形态） |
| 7 | 游标位置 | 用户本地记录（角色侧），**持久化**（User 补充） |
| 8 | 兜底 | 经调研业界方案后确认：缺口检测 + 重连差分同步，**非**定期广播/轮询 |
| 9 | 统一逻辑 | 用户看到的与 agent 看到的一致（User 补充） |

## 4. 业界参考（Q3 调研结论）

| 方案 | 在线时 | 兜底机制 |
| --- | --- | --- |
| 微信（WeiSync/Diff-Sync） | 长连接推送 | 每条消息全局递增 sequence；客户端记"已同步最大序号"，离线/重连按本地序号拉差值 |
| Telegram（MTProto） | push 实时推 | 本地序号发现**缺口（gap）**→ `getDifference` 拉取补齐；无缺口不拉，非周期轮询 |
| 闲鱼 IM | ACCS 推送 | 数据包版本号不连续（"黑洞"）→ 触发同步拉取 |
| 通用 IM（芋道等） | WebSocket 推 | "WebSocket 不保证送达，业务表才是权威"——在线靠推，漏了靠增量查询补 |

**共识**：① 每条消息必须单调递增序号；② 广播只是加速通道，最终一致性靠"本地游标 + 增量拉取"；③ 兜底触发条件是**发现缺口**或**重连**，不是定时器。

## 5. 现状核实（已查源码）

- ✅ `public_message` 已有全局递增 `sequence`（`src/protocol/messages.ts`，Integer，minimum 1）——序号基础已存在
- ✅ 历史分页已有 cursor/has_more（ISSUE-008）
- ✅ 群聊状态快照（get_group_chat_state）已存在
- ❌ 无"按序号增量拉取"接口（`get_message_history` 是分页游标，非序号增量）
- ❌ 广播仍是完整事件推送（public_message 全量内容），未通知化
- ❌ 无游标持久化概念

## 6. 影响面（User 确认：都要改）

| 层 | 变更 |
| --- | --- |
| 协议层（`docs/websocket-protocol.md`，Dev 属主） | 广播通知化（新消息类型或改造现有广播：通知 + 最近几条 + 最新序号）；新增按序号增量拉取命令 |
| Server 端 | 通知生成（带最新序号与预览）；按 sequence 的增量查询 |
| 角色侧（`src/character/group-chat-input.ts`） | 去 1 秒防抖；收到广播即拉取；游标持久化；缺口检测；投递时机（当前 run 结束后立即） |
| 持久化（`docs/persistence.md`，Dev 属主） | 游标存储（角色侧本地，按 group_chat_id） |
| 验收（`docs/acceptance.md`，PM 属主） | 新增验收标准（见第 7 节方向） |
| 文档（`docs/group-chat-input.md`） | 输入模型改写（推拉混合） |

## 7. 验收方向（QA 可测性评估已确认，2026-08-01；待写入 acceptance.md）

- 广播到达后，角色在无防抖约束下发起增量拉取；拉取内容从持久化游标之后开始，不重不漏、顺序一致（QA：高可测，fake timers 控时）
- 当前 run 正在执行时收到广播：run 不被中断；run 结束 → 新消息进入角色上下文，间隔 ≤ X 秒（QA 确认分层：**单测层 ≤ 5s，验收层放宽 ≤ 10s** 避免并行抖动）
- 重启角色 session 后游标保留，重新 join 后从游标处差分同步（无游标时全量分页）（QA：reload.test.ts 先例可复用）
- 缺口场景（广播丢失/序号跳跃）：角色最终能补齐消息，不永久丢失（QA：控制广播模拟丢帧断言补拉）
- 用户（TUI）看到的消息内容与 agent 上下文收到的内容一致（同一数据源）

### 7.1 可测试性契约（对 Dev 方案的硬性要求，QA 提出）

以下两条验收依赖测试替身，**Dev 技术方案必须包含**，否则验收 5/6 不可测：

1. **run 状态信号**：RPC 测试模式无真实 LLM run，需 Dev 提供可测试的 run 状态信号（如 `runtime.isRunActive` 或 agent_start/agent_settled 事件注入），使测试能断言「run 活跃时排队、结束信号后立即投递」。
2. **观察通道**：RPC 模式下 TUI 注入不可观察（ISSUE-008 已标边界），需沿用 testNotify 通道（或等价持久化断言渠道）验证「TUI 内容 = agent 上下文内容」。

> QA 结论：验收 1-4 直接可测；5-6 依赖上述两条可测试接口。X=5s（单测）/ 10s（验收）无异议。

### 7.2 接口契约（QA 测试设计契约，PM 仲裁 2026-08-01，以 Dev 工作区实现为准）

QA 测试断言与 Dev 实现必须一致的签名（差异点已仲裁）：

- 事件：`group_chat_update` `{ latest_sequence, preview_messages[], total_messages }`
- 命令：`fetch_messages_since` `{ since_sequence }` → 响应 data `{ messages[], latest_sequence, total_messages }`（**含 total_messages**）
- runtime：`isAgentActive` 为 **boolean 字段**（默认 false，非方法）；`onAgentSettled` 为**回调字段**（赋值 `runtime.onAgentSettled = cb`，非方法调用）；`fetchMessagesSince(since): Promise<{ messages, latestSequence, totalMessages } | null>`（**断连返回 null**，调用方需容忍）
- 游标：`<agent-dir>/tavern/<project-key>/cursors/<group_chat_id>.json`，投递成功更新
- 注意：`group-chat-input.ts`（去防抖/游标/缺口检测/单飞行锁）尚未在 Dev 工作区出现，A1/A5/A7 单测依赖其落地

## 8. 明确不做（首版范围外）

- 不做服务端 per-character 已读游标（游标在角色侧本地持久化）
- 不做周期定时轮询兜底（以缺口检测 + 重连差分同步替代）
- 不做多端已读同步（PiTavern 每个角色单一 session）

## 9. 待定点（已全部解决，2026-08-01 三方评审）

- ~~X 的取值~~ → 单测层 ≤5s、验收层 ≤10s（QA 建议 + Dev 认可，PM 裁定）
- ~~广播通知的新消息类型命名与字段~~ → `group_chat_update`（见第 10 节）
- ~~增量拉取命令命名与返回形态~~ → `fetch_messages_since`（见第 10 节）
- ~~游标持久化载体~~ → `<agent-dir>/tavern/<project-key>/cursors/<group_chat_id>.json`（见第 10 节）

## 10. 技术方案要点（已冻结，Dev 2026-08-01，三方评审通过）

### 10.1 协议层

- 广播通知化：public_message 广播 → 新 ServerMessage `group_chat_update`（`latest_sequence` + `preview_messages` 最近 3 条 + `total_messages`）
- 新增增量命令：ClientMessage `fetch_messages_since`（`since_sequence`）→ 响应 messages（sequence > since 全量，天然补齐缺口）+ `latest_sequence`
- 保留：`message_history`（join 全量）、`get_message_history`（向后翻页）——与增量命令并存

### 10.2 游标载体（角色侧本地持久化）

- 文件：`<agent-dir>/tavern/<project-key>/cursors/<group_chat_id>.json`，内容 `{ character_id, last_sequence, updated_at }`
- 更新时机：**每次成功投递后**更新（投递失败游标不动 → 重启不丢）

### 10.3 角色侧（group-chat-input.ts）

- 去 1s 防抖：收到 `group_chat_update` → 立即 `fetch_messages_since(游标)`
- 投递仍 followUp（pi 官方语义 = agent run 结束后投递，不打断已满足，需求点 4 零改动）
- 缺口检测：`latest_sequence ≠ 游标+1` → fetch 按 sequence 过滤天然补齐
- join/重连差分：有游标 → `fetch_messages_since`；无游标 → 现有全量分页
- 单飞行锁：fetch 进行中收到新通知 → 完成后补拉（防并发竞态）
- 自己的 echo 仍过滤（isOwnEcho 复用）

### 10.4 统一逻辑

- 上下文以 fetch 结果为准；preview 仅供 TUI 显示，内容同源不重复（PM 口径裁定：同源一致，数量不强制相等）

### 10.5 可测性契约（QA 缺口 5/6，Dev 已纳入；QA 二评 + PM 裁定补充 2026-08-01）

1. **run 状态信号**：复用 pi 扩展 API 的 agent_start/agent_settled 事件（src/index.ts 已监听，ISSUE-002 语境），桥接为 `CharacterRuntime.isAgentActive()` + `onAgentSettled` 回调；投递逻辑：拉取完成时若 isAgentActive → 排队；onAgentSettled → 立即 flush。顺带修复 ISSUE-002 的 streaming 语义错配（该事件目前被误用为"正在发言"）。
   - **RPC 降级口径（PM 裁定）**：RPC 测试模式无真实 LLM run → 验收层「≤X 间隔」降级为"投递发生 + 进程稳定"烟雾；时序断言（活跃时排队、settled 后 ≤5s 投递）由**单测层** fake timers + 注入 run 状态信号完整执行（单测层是 A5 主验证位）。
   - **isAgentActive 默认语义（必须明确）**：无 run 活跃时视为空闲（false）→ 收到通知立即投递；否则 RPC 验收模式将"永远排队"。请 Dev 在方案中明确该默认值。
2. **观察通道**：沿用 `PITAVERN_TEST=1` testNotify 通道（ISSUE-007 先例）；**投递时注入 `latest_sequence` + 投递消息数**（QA 二评建议，PM 采纳），验收断言与 TUI 预览同源（同一消息数据）。**注入格式（Dev 2026-08-01 提供）**：`[tavern-inject] group=<id> latest_seq=<n> count=<k>`；验收断言：通知 preview 的 latest_sequence == 注入 latest_seq，消息内容同源（TUI 投影数据源 = publicMessages = 拉取数据源）。

## 11. pull 模型修订表（#60/#62/#64 + 游标跟随 Session，2026-08-02）

| 本节旧口径 | 修订后（当前实现/契约） |
| --- | --- |
| 2.3 触发（无防抖）：收到广播 → 立即增量拉取 | 闲态固定 1s 聚合窗口（N→1 并入一次消费）；忙态 update 到达即拉取（单飞行锁，在途合并）+ steer 通道投递（工具间隙秒级）+ settle 补拉全兜底（游标幂等不重不漏；双通道判定推进） |
| 2.5 兜底：缺口检测（最新序号 ≠ 游标+1 → 立即补拉） | sequence 过滤天然补齐——`fetch_messages_since` 返回游标后全部消息，无需缺口检测 |
| 2.7 / 7 验收：消息**不重不漏** | 尽力保序、**幂等可重拉**（重复投递可容忍；游标只在成功投递后推进） |
| 7.2 / 9 / 10.2 游标文件：`cursors/<group_chat_id>.json` | **游标跟随 Session**：`cursors/<group_chat_id>/<session_id>.json`；**旧单文件废弃不读**（值无 Session 身份，回退采用会跳过本 Session 未看过的消息）；新 Session 无独立游标 = 从完整历史分页重新拉取（最多重复、绝不跳过） |
| 10.2 游标内容 `{ character_id, last_sequence, updated_at }` | 实现为 `{ last_sequence, updated_at }`（无 character_id；归属由文件路径的 session 维度表达） |
| 10.3 去 1s 防抖、立即 fetch | 保留 1s 聚合窗口（闲态）；忙态 update 到达即拉取 + steer 投递（2026-08-02 恢复），settle 补拉全兜底 |
| 10.3 缺口检测、单飞行锁 | sequence 过滤补洞；增量窗口内多次变化单次投递 |
