# PiTavern Group Chat Input

本文定义角色 pi 如何将 WebSocket 群聊环境转换为当前 pi Agent 的一次输入。

## 输入模型

角色 pi 不创建第二个 Agent 或 session。PiTavern 的群聊输入模块是当前 pi Agent 的另一种输入来源：

```text
group_chat_update 通知（广播唤醒：水位 + 最近 3 条预览，不注入）
        ↓
run 边界（#60/#64）：闲态 ≤1s 聚合窗口（N→1 并入一次消费）/ 忙态 settle 后立即
        ↓
fetch_messages_since(本 Session 持久化游标)（扩展机械拉取，sequence 过滤天然补洞）
        ↓
完整未读批注入（保序、幂等可重拉；run 全程零中间注入）
        ↓
生成一条 pi 原生 custom_message（followUp，不打断）
        ↓
当前 pi Agent / pi session
```

- 公开消息走「通知 + 增量拉取」（M7/ISSUE-012）：广播只携带最新序号与最近 3 条预览，完整增量由角色主动拉取，不再逐条推送；正文在 run 期间零中间注入（#64 pull 模型），成员/环境事件经 steer 通道间隙可见（#38，不打断 run、秒级延迟）。
- join 批次（`message_history` + 成员事件）保留 1 秒合并防抖；闲态 `group_chat_update` 固定 1s 聚合窗口（多次变化并入单次消费，N→1），忙态 settle 后立即触发（#60/#62）。
- 游标（上次成功投递的最后一条 message sequence）本地持久化（`<agent-dir>/tavern/<project-key>/cursors/<group_chat_id>/<session_id>.json`，**游标跟随 Session**），投递成功后更新，重启不丢；同群聊多角色互不共用游标文件。**旧版群聊级单文件（`cursors/<group_chat_id>.json`）废弃不读**（值无 Session 身份，回退采用会跳过消息）；新 Session 无独立游标时从完整历史分页重新拉取。
- 一个防抖批次只生成一条输入。单个 WebSocket 消息不直接追加到 pi session。

## pi custom message

群聊输入使用 pi 原生 `sendMessage()`：

```ts
await pi.sendMessage(
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
- 始终使用 `deliverAs: "followUp"` 和 `triggerTurn: true`。
- 当前 pi Agent 空闲时立即触发 Agent run。
- 当前 pi Agent 正在 streaming 时，由 pi 原生 follow-up queue 等待当前工作完成。
- PiTavern 不自行判断并实现另一套投递队列。

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
- `events` 按 WebSocket 广播接收顺序保存当前防抖批次（增量拉取结果与通知预览同源）。
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

成员变化：
Tester 加入了群聊。

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
- 消息正文、成员变化、状态快照和 PiTavern 控制说明使用明确分段。
- `content` 不直接 dump WebSocket JSON。
- Character Markdown 不进入 `content`；它在领取时加载一次，并作为加入期间稳定的 system prompt 扩展。
- Character 自己公开消息的广播回显不进入防抖批次（增量拉取结果同样过滤 `isOwnEcho`）。
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

PiTavern 只管理提交前的防抖缓冲区，不实现 pi 原生队列的回滚或清理。
