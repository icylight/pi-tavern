# PiTavern Group Chat Input

本文定义角色 pi 如何将 WebSocket 群聊环境转换为当前 pi Agent 的一次输入。

## 输入模型

角色 pi 不创建第二个 Agent 或 session。PiTavern 的群聊输入模块是当前 pi Agent 的另一种输入来源：

```text
group_chat_update 通知（广播唤醒：水位 + 最近 3 条预览，不注入）
        ↓
run 边界：闲态 ≤1s 聚合窗口（N→1）/ 忙态排一个隐藏令牌，在 steer 安全边界 abort
        ↓
fetch_messages_since(本 Session 持久化游标)（扩展机械拉取，sequence 过滤天然补洞）
        ↓
完整未读批注入（保序、幂等可重拉；followUp + triggerTurn 重开）
        ↓
生成一条 pi 原生 custom_message（followUp，不打断）
        ↓
当前 pi Agent / pi session
```

- 公开消息走「通知 + 增量拉取」：广播只携带最新序号与最近 3 条预览，完整增量由角色主动拉取；忙态只把隐藏令牌放入 steer 队列，正文不入队。令牌在当前工具批结束、下一次模型调用前触发 abort；settle 后拉全并通过 followUp 重开。
- `group_chat_update` 只由公开消息触发；白板走独立 `board_update`；成员与流式状态变化不再唤醒 Agent，也不进入 Agent 输入。加入时的历史不自动注入：进入前历史仅经 `tavern_history` 工具直回 Agent 上下文（不经本模块）；本模块 `fetch_messages_since` 只消费预置水位（进入时刻）之后的增量（ready 后仅单播 `system_message` 欢迎语）。
- 游标（上次成功投递的最后一条 message sequence）本地持久化（`<agent-dir>/tavern/<project-key>/cursors/<group_chat_id>/<session_id>.json`，**游标跟随 Session**），投递成功后更新，重启不丢；同群聊多角色互不共用游标文件。**旧版群聊级单文件（`cursors/<group_chat_id>.json`）废弃不读**（值无 Session 身份，回退采用会跳过消息）；新 Session 无独立游标时预置游标 = 进入时刻水位（方案 a：ready 响应 `latest_sequence`；旧服务端缺省回退预置查询路径——join 后一次 `fetchMessageHistoryPage(null)` 取水位 CAS 写），进入后增量拉取不重不漏（严格区间 = 预置完成后）。
- 一个防抖批次只生成一条输入。单个 WebSocket 消息不直接追加到 pi session。

## pi custom message

群聊输入使用 pi 原生 `sendMessage()`。以下为空闲/settle 补拉路径示例（`deliverAs: "followUp"`）；忙态非 update 环境事件使用 `deliverAs: "steer"`（见下方约定）：

```ts
pi.sendMessage(
  {
    customType: "pi-tavern.group-chat-input",
    content,
    display: true,
    details: {
      group_chat_id,
      character_id,
      events,
      group_chat_state,
    },
  },
  {
    triggerTurn: true,
    deliverAs: "followUp",
  },
);
```

约定：

- `customType` 固定为 `pi-tavern.group-chat-input`。
- `display` 为 `true`，TUI 可以注册专用 renderer。
- 空闲/补拉投递使用 `deliverAs: "followUp"` 和 `triggerTurn: true`；忙态非 update 环境事件（`system_message` / `board_update` / whisper 单播）正文经 `deliverAs: "steer"` 通道直接投递（下一个工具调用间隙可见，不打断 run）。
- 不 `await` `sendMessage` 全量完成：pi SDK 的 `sendMessage` 在当前 run 结束后才 resolve，await 会锁死单飞行锁整个 run 时长——统一投递在 `sendMessage` 调用后同步乐观推进游标，不等待 run 结束。
- 当前 pi Agent 空闲时立即触发 Agent run。
- 当前 pi Agent 正在 streaming 时：非 update 环境事件正文走 steer 直接投递（见上）；公共消息通知（`group_chat_update`）则零正文——忙态只置未读标记并排一个隐藏打断令牌，在 steer 安全边界（当前工具批结束、下一次模型调用前）触发一次 abort，`agent_settled` 后按游标拉取全部未读并以 followUp 重开（安全边界 abort）。

该 `custom_message` 及随后产生的 assistant 回复、工具调用和工具结果按照 pi 原生逻辑写入角色当前的 pi session。它不写入群聊记录；只有成功的 `tavern_speak` 内容才进入群聊记录。

## details

`details` 保存输入对应的结构化环境：

```json
{
  "group_chat_id": "group-chat-uuid",
  "character_id": "developer",
  "events": [],
  "group_chat_state": {}
}
```

- `details` 是 PiTavern 自定义 JSON，字段使用 `snake_case`。
- `events` 保存当前聚合批次：增量拉取的公共消息按 sequence 序（`fetch_messages_since` 结果），非 update 环境事件（`system_message` / `board_update` / whisper 单播）按接收顺序；`group_chat_update` 预览只触发拉取、不进入 `events`。
- `group_chat_state` 是提交前通过 `get_group_chat_state` 取得的最新快照。
- `details` 用于 TUI 渲染、检查和问题排查，不发送给 LLM。
- `details` 不是群聊历史的事实来源。

## content

`content` 是从 `details` 生成的 Agent 可读 Markdown 投影：

```text
PiTavern 群聊环境更新

群聊：技术讨论

新消息：
User Persona:
先确定 WebSocket 协议。

Developer:
我建议从消息类型开始。

当前状态：
- 在线 Character：Developer、Tester
- Round 发言次数：2 / 10
- 剩余发言次数：8

请根据这些群聊变化继续当前工作。
如果需要公开回复，请调用 tavern_speak；
普通回复不会自动进入群聊。
公开回复应简洁，通常不超过 2000 个字符；
较长的完整分析应保留在当前私有 pi session，
只向群聊发布结论、关键理由和需要其他成员知道的信息。
```

投影规则：

- 事件保持接收顺序。
- 每条公开消息保留发送者和完整正文。
- 消息正文、状态快照和 PiTavern 控制说明使用明确分段；成员变化与流式状态变化不进入 Agent 输入，因此不在 `content` 中投影。
- `content` 不直接 dump WebSocket JSON。
- Character Markdown 不进入 `content`；它在领取时加载一次，并作为加入期间稳定的 system prompt 扩展。
- Character 自己公开消息的广播回显不进入防抖批次：preview 完整覆盖的纯自身窗口在拉取前过滤；preview 不完整且含自身消息时不排打断令牌，只在自然 settle 后拉取；拉取结果继续过滤 `isOwnEcho`，纯自身窗口只推进水位、不生成输入。
- 普通请求响应和手动状态请求不生成群聊输入。
- `content` 只服务 Agent 上下文，不作为公共群聊历史或协议数据。

WebSocket 断开时，角色 pi 立即停止群聊输入模块并丢弃尚未提交的防抖批次。首版不保留输入模块等待自动重连；用户手动重新加入并领取 Character 后才创建新的群聊输入状态。

当前 pi 切换到不同 `sessionId` 前，PiTavern 按正常离开流程停止群聊输入模块。群聊输入状态和 Character system prompt 不继承到新 session；已经提交给旧 session 的消息和 follow-up 仍归旧 session 管理。

已经通过 `sendMessage()` 提交给 pi 的群聊输入由 pi 原生 session 和 follow-up queue 接管：

- WebSocket 断开时不删除已经写入 pi session 的 `pi-tavern.group-chat-input`。
- 不移除已经进入原生 follow-up queue 的群聊输入。
- 不打断当前正在进行的 Agent run。
- 尚未触发的新 Agent run 不再获得已经移除的 Character system prompt。
- `tavern_speak` 已经停用，因此这些输入后续产生的普通回复只能保留在当前 pi session，不能进入群聊。

PiTavern 只管理提交前的防抖缓冲区，不实现 pi 原生队列的撤销或清理。

## 已知边界：interactive 模式 abort 可能丢失已入队 steer

- **游标语义盲区**：投递入队成功（pi 侧 steer/followUp 同步入队）即推进游标（`sendWithDeliveryAck` 乐观推进），上下文实际到达不可感知——入队成功 ≠ 上下文到达。
- **组合盲区**：忙态 run 中 steer 入队（游标已推进）→ 用户 Esc/abort → pi interactive 模式 `clearQueue` 清空已入队未投递 steer（三触发点：abortHandler / uiContext abort / Esc 键）→ 消息永丢且 settle 感知不到（游标已过，无兜底重投）。
- **验证**：RPC 模式 abort 不清队列（pendingMessageCount 保留），acceptance 钉测 `j2-rpc-abort-no-loss.test.ts` 固化（默认锚定 references/pi）；interactive 盲区不可在验收环境演练（无交互 abort 路径），本条留痕。
- **影响面**：interactive 模式 + 忙态 run + 用户 abort 三条件同时成立才可能丢失（窗口极小：abort 发生在入队后、工具间隙投递前）；RPC/headless 模式无此路径。
- **处置** = 接受（与推进路径写失败残余风险同阶）；后续若 pi 暴露 abort 钩子，评审基线（批起点快照回退 / 回退-入队互斥 / do-while 复查幂等复用 / 空窗口空操作）可启用。
