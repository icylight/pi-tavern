# PiTavern WebSocket Protocol

本文记录 PiTavern 群聊创建者与角色 pi 之间的 WebSocket 消息协议。

当前文档只收录已经确认的协议内容。尚未讨论完成的消息不在本阶段预先定义。

## JSON 约定

- JSON 字段名统一使用 `snake_case`。
- `type` 等类型字符串统一使用 `snake_case`。
- 协议不携带版本字段。
- 请求使用可选的 `id` 关联响应。
- 请求响应复用 pi-coding-agent 的通用响应结构：

```json
{
  "id": "req-1",
  "type": "response",
  "command": "command_name",
  "success": true,
  "data": {}
}
```

通用 JSON 命名规则见 [development-conventions.md](development-conventions.md)。

## 广播

广播（Broadcast）是群聊创建者将同一条逻辑消息发送给当前群聊全部在线 Character 的操作。

- 群聊创建者是唯一执行广播的一方。
- 广播没有接收者参数、候选列表或排除列表。
- 广播发生时，每个拥有活动 WebSocket 连接的 Character 都必须收到该消息。
- 消息来源不影响接收范围；发送消息的 Character 也接收自己的广播。
- Character 刚完成加入后即属于广播接收者，因此能收到紧随其后的广播。
- User Persona 由群聊创建者本地表示，不是 Character WebSocket 接收者。
- 向某个连接发送失败时，该 Character 转入断线处理流程；不能静默跳过并继续将其视为在线。
- 持久化公共消息由重连补齐机制恢复；临时状态由重新请求群聊状态恢复。

后文使用“广播”时均遵循此定义，不再逐项声明是否包含发送者或新加入的 Character。

## Character 摘要

公开的 Character 摘要来自角色卡 frontmatter：

```json
{
  "character_id": "developer",
  "name": "Developer",
  "description": "负责方案实现、代码设计和技术风险分析"
}
```

- `character_id` 是角色的稳定标识。
- `name` 是角色显示名称。
- `description` 是供角色选择器、在线角色列表和状态界面展示的公开简介。
- Character Markdown 正文是角色的完整提示词，不通过角色列表发送。
- Character 列表不包含 User Persona。

在线 Character 在摘要基础上增加：

```json
{
  "character_id": "developer",
  "name": "Developer",
  "description": "负责方案实现、代码设计和技术风险分析",
  "is_self": true,
  "is_streaming": true,
  "hand_raised": false
}
```

- `is_self` 表示该 Character 是否属于当前请求方，根据请求连接动态生成。
- `is_streaming` 对齐 pi-coding-agent 的同名状态，表示 Character 公共 Agent 正在处理一次 Agent run。
- `hand_raised` 是独立状态，可以与其他运行状态同时存在。
- Character 公共 Agent 的 follow-up queue 是其内部状态，不向群聊上报。
- Character 的私有 pi session 是否忙碌不属于公共状态。
- 在线 Character 不携带 `claim_status`；出现在在线列表中即表示已经领取。
- `session_id`、其他私有 pi session 信息和角色卡文件路径不属于公开摘要。
- `is_self` 不持久化，也不由 Character 上报。

## 加入群聊

建立 WebSocket 连接不代表已经成为群成员。加入流程分为请求加入和领取 Character 两个阶段：

```text
建立 WebSocket
    ↓
join_group_chat
    ↓
返回 available Character 列表
    ↓
用户选择 Character
    ↓
claim_character
    ↓
原子领取成功并正式成为群成员
```

### 请求加入

```json
{
  "id": "req-2",
  "type": "join_group_chat",
  "session_id": "pi-session-uuid"
}
```

群聊创建者根据 `session_id` 判断本次请求：

- `session_id` 当前在线：拒绝重复连接。
- `session_id` 处于 30 秒断线窗口：恢复原 Character。
- 不存在有效成员映射：进入普通加入流程。

是否属于重连完全由群聊创建者判断，协议不要求角色维护或发送重连模式。

普通加入响应：

```json
{
  "id": "req-2",
  "type": "response",
  "command": "join_group_chat",
  "success": true,
  "data": {
    "joined": false,
    "available_characters": [
      {
        "character_id": "developer",
        "name": "Developer",
        "description": "负责方案实现、代码设计和技术风险分析"
      }
    ]
  }
}
```

恢复已有成员时返回：

```json
{
  "id": "req-2",
  "type": "response",
  "command": "join_group_chat",
  "success": true,
  "data": {
    "joined": true,
    "character": {
      "character_id": "developer",
      "name": "Developer",
      "description": "负责方案实现、代码设计和技术风险分析",
      "path": "/absolute/path/to/characters/developer.md"
    }
  }
}
```

- `joined: false` 表示需要选择并领取 Character。
- `joined: true` 表示已经恢复原 Character，不需要再次领取。
- 响应不提供 `reconnected` 字段；角色不区分首次连接和重连，只处理当前加入结果。
- 重连不广播 `character_joined`，因为成员从未被移除。
- 恢复成功后与首次领取成功使用相同的后置流程，直接发送最近 10 条 `message_history`。
- 角色不根据 `event_id` 或 `sequence` 去重；收到的最近消息直接进入通用环境批次。
- `session_id` 只用于群聊创建者恢复成员与 Character 映射，不改变角色端的环境消息处理。

收到 `joined: false` 响应后，连接进入临时的加入阶段：

- `session_id` 必须是角色 pi 外层私有 session 的 ID，不是 Character 公共 Agent 的内部 session ID。
- 群聊创建者使用 `session_id` 作为群成员的连接和断线重连身份。
- 同一 `session_id` 已经在线时拒绝新的加入连接。
- `session_id` 到 Character 和 WebSocket 的映射只存在于当前活动实例，不写入群聊记录文件。
- 恢复同一个 pi session 时 `session_id` 保持不变；`/new` 或 fork 产生新 ID，不继承原群成员身份。
- 尚未成为群成员，也不占用任何 Character。
- 不接收群聊广播。
- 不能请求群聊记录文件。
- 可以在同一连接上重新发送 `join_group_chat`，刷新可领取 Character 列表。
- WebSocket 关闭后不留下成员状态。

### 领取 Character

```json
{
  "id": "req-3",
  "type": "claim_character",
  "character_id": "developer"
}
```

群聊创建者按照消息到达顺序原子检查并领取 Character。成功响应：

```json
{
  "id": "req-3",
  "type": "response",
  "command": "claim_character",
  "success": true,
  "data": {
    "character": {
      "character_id": "developer",
      "name": "Developer",
      "description": "负责方案实现、代码设计和技术风险分析",
      "path": "/absolute/path/to/characters/developer.md"
    }
  }
}
```

- `path` 是 Character Markdown 的本机绝对路径。
- WebSocket 不发送 Character Markdown 正文；加入方在共享环境中直接读取该文件。
- 加入方领取成功后立即读取文件并建立 Character 公共 Agent。
- 已经运行的 Character 不因角色卡文件后续变化自动替换提示词。

Character 已经被领取等失败情况使用 pi-coding-agent 风格的通用错误响应：

```json
{
  "id": "req-3",
  "type": "response",
  "command": "claim_character",
  "success": false,
  "error": "Character is no longer available"
}
```

失败时不占用 Character。加入方重新发送 `join_group_chat` 获取最新的可领取 Character 列表并再次选择。

首次领取成功后，群聊创建者先返回 `claim_character` 成功响应，再广播 `character_joined`。无论首次领取还是恢复已有成员，连接成功后都向该 Character 发送最近 10 条 `message_history`；Character 在环境批次防抖结束后主动请求 `get_group_chat_state`。

### Character 加入广播

Character 领取成功并正式成为群成员后，群聊创建者向此时的全部在线 Character 广播：

```json
{
  "type": "character_joined",
  "character": {
    "character_id": "developer",
    "name": "Developer",
    "description": "负责方案实现、代码设计和技术风险分析"
  }
}
```

- 广播遵循协议的统一广播语义。
- 消息只携带公开 Character 摘要，不携带 `is_streaming` 或 `hand_raised`。
- 该消息属于环境事件，进入每个接收方的 1 秒环境防抖批次。
- 新加入的 Character 将自己的加入事件和随后收到的 `message_history` 合并到首次环境批次。
- 群聊创建者界面同时显示一次 Character 加入通知。
- 成员关系是临时状态；加入广播不写入群聊记录文件，也不使用 `event_id` 或 `sequence`。

## 离开群聊

Character 主动离开请求：

```json
{
  "id": "req-4",
  "type": "leave_group_chat"
}
```

群聊创建者按照以下顺序处理：

1. 原子移除群成员。
2. 释放该 Character。
3. 清除该成员的举手和运行状态。
4. 向移除后剩余的全部在线 Character 广播 `character_left`。
5. 向离开方返回成功响应。
6. 成功响应发送完成后关闭离开方 WebSocket。

离开的 Character 已经不属于广播接收者，因此不会收到自己的离开广播。

成功响应：

```json
{
  "id": "req-4",
  "type": "response",
  "command": "leave_group_chat",
  "success": true
}
```

离开广播：

```json
{
  "type": "character_left",
  "character": {
    "character_id": "developer",
    "name": "Developer",
    "description": "负责方案实现、代码设计和技术风险分析"
  },
  "reason": "left"
}
```

`reason` 首版支持：

- `left`：Character 主动执行 `/tavern-leave`。
- `disconnect_timeout`：WebSocket 断线超过 30 秒重连窗口后被正式移除。

断线超时时没有离开请求和响应。群聊创建者在重连窗口到期后执行同样的移除、释放和广播流程。

`character_left`：

- 遵循协议的统一广播语义，接收范围基于成员移除后的在线 Character 集合。
- 属于环境事件，进入接收方的 1 秒环境防抖批次。
- 不写入群聊记录文件，也不使用 `event_id` 或 `sequence`。
- 群聊整体关闭使用单独的关闭消息，不将其表示为所有 Character 逐个离开。

## 关闭群聊

群聊创建者在本地执行 `/tavern-leave` 关闭整个群聊，不通过 WebSocket 向自身发送请求。

关闭广播：

```json
{
  "type": "group_chat_closed",
  "group_chat_id": "chat-123"
}
```

群聊创建者按照以下顺序关闭：

1. 将群聊标记为正在关闭，不再接受新的加入、状态更新或公开发言请求。
2. 向全部在线 Character 广播 `group_chat_closed`。
3. 等待广播写入各 Character WebSocket。
4. 关闭全部 Character WebSocket。
5. 删除活动描述文件。
6. 保持群聊记录文件原样，不追加关闭或结束记录。

Character 收到关闭广播后：

- 显示群聊关闭通知。
- 清除当前群聊关联。
- 停止向该群聊上报状态或发送公开消息。
- 释放 Character，使该 pi 可以加入其他群聊。
- 保留并继续使用自己的私有 pi session。
- 不强制中断已经运行的 Character 公共 Agent；该 Agent 后续尝试 `tavern_speak` 时失败，完全结束后释放。

`group_chat_closed` 是仅存在于当前活动实例中的运行期终止信号，不进入 1 秒环境防抖，也不触发新的 Agent run。它不写入群聊记录文件，也不使用 `event_id` 或 `sequence`。

PiTavern 与 pi-coding-agent session 一样，不持久化“已结束”状态。是否存在活动群聊只由临时活动描述和当前进程决定；群聊记录文件始终停留在最后一条完整记录。

群聊创建者异常退出时无法发送关闭广播。加入方通过 WebSocket 断开、活动描述失效和重连失败流程退出当前群聊。恢复群聊时会建立新的活动实例和成员关系，不恢复旧连接。

## 最近群聊消息

Character 加入成功后，群聊创建者自动发送最近 10 条公开消息：

```json
{
  "type": "message_history",
  "messages": [],
  "cursor": "opaque-cursor",
  "has_more": true,
  "total_messages": 128
}
```

- `messages` 最多包含 10 条消息，按时间从旧到新排列。
- 只包含 User Persona 和 Character 的公开发言。
- 加入、离开和状态变化等事件不进入 `messages`。
- 消息元素复用公开发言结构；该结构将在公开发言广播消息中定义。
- `cursor` 用于获取当前批次之前的消息。
- 没有更早消息时，`cursor` 为 `null`，`has_more` 为 `false`。
- `total_messages` 是响应时群聊内公开消息的总数。

获取更早的 10 条消息：

```json
{
  "id": "req-5",
  "type": "get_message_history",
  "cursor": "opaque-cursor"
}
```

响应：

```json
{
  "id": "req-5",
  "type": "response",
  "command": "get_message_history",
  "success": true,
  "data": {
    "messages": [],
    "cursor": "older-opaque-cursor",
    "has_more": true,
    "total_messages": 128
  }
}
```

- 每次固定获取 10 条，首版不提供 `limit`。
- 翻页期间产生新消息不会改变已有 cursor 所指向的历史位置。

## 获取群聊记录文件

请求：

```json
{
  "id": "req-6",
  "type": "get_chat_history_file"
}
```

响应：

```json
{
  "id": "req-6",
  "type": "response",
  "command": "get_chat_history_file",
  "success": true,
  "data": {
    "path": "/absolute/path/to/chats/group-chat-id.jsonl"
  }
}
```

- 返回当前群聊完整 JSONL 记录文件的本机绝对路径。
- WebSocket 不传输文件内容，请求方直接读取共享环境中的文件。
- 返回成功前，群聊创建者确保已经接受的消息写入文件。
- 只有已经加入当前群聊的 pi 可以请求文件路径。
- 该文件称为“群聊记录文件”，不称为 session 文件。

## 获取群聊状态

请求：

```json
{
  "id": "req-7",
  "type": "get_group_chat_state"
}
```

响应：

```json
{
  "id": "req-7",
  "type": "response",
  "command": "get_group_chat_state",
  "success": true,
  "data": {
    "group_chat": {
      "group_chat_id": "chat-123",
      "name": "PiTavern 技术设计",
      "created_at": "2026-07-26T10:30:00.000Z",
      "group_max_messages": 10
    },
    "round": {
      "round_max_messages": 10,
      "used_messages": 3,
      "remaining_messages": 7
    },
    "online_characters": []
  }
}
```

`group_chat` 包含：

- `group_chat_id`：群聊稳定标识。
- `name`：群聊显示名；未命名时为 `null`。
- `created_at`：群聊首次创建时间，恢复时不改变。
- `group_max_messages`：未来新 Round 继承的总发言次数。

`round` 包含：

- `round_max_messages`：当前 Round 创建时继承的不可变上限。
- `used_messages`：已经成功进入群聊的 Character 公开消息数。
- `remaining_messages`：当前 Round 剩余的公开发言次数。
- 群聊尚未产生第一条 User Persona 消息时，`round` 为 `null`。
- Character 不通过协议维护 Round 身份，因此不提供 `round_id`。

`online_characters`：

- 使用在线 Character 结构。
- 不包含 User Persona。
- 不包含处于断线重连窗口的 Character。
- `is_self` 由群聊创建者根据发起 `get_group_chat_state` 的 WebSocket 连接填写，并且恰好一个为 `true`。

群聊状态不包含地址、端口、创建者 PID、`config_max_messages`、历史消息或群聊记录文件路径。

### 状态拉取

群聊状态不主动广播。Character 在以下场景使用 `get_group_chat_state` 主动获取最新快照：

- 环境消息防抖结束、准备提交一次 Agent run 或 follow-up 时。
- 用户执行需要展示完整状态的命令时。
- 其他明确需要刷新本地群聊状态的交互。

环境批次触发的状态响应与该批次一起交给 Character 公共 Agent。手动状态命令取得的响应只更新界面，不触发 Agent。

Character 成功领取角色后，群聊创建者自动发送 `message_history`。Character 将历史消息加入首次环境批次；1 秒防抖结束后主动请求群聊状态，再使用历史批次和最新状态启动首次 Agent run。

首次处理没有特殊的禁言规则。`tavern_speak` 是否被接受只由收到请求时当前 Round 的剩余发言次数判断；没有当前 Round 或当前 Round 没有剩余次数时，公开消息不能进入群聊。

### 环境消息防抖

Character 使用固定 1 秒的 trailing-edge debounce 合并连续到达的环境消息：

1. 收到环境消息后，将其加入当前待处理环境批次并启动计时。
2. 1 秒内收到新的环境消息时，将新消息合并到当前批次并重新计时。
3. 连续 1 秒没有收到新环境消息时，请求最新群聊状态。
4. 将环境批次和群聊状态快照一起提交。

提交环境批次时：

- Character 公共 Agent 空闲：使用环境批次和状态快照启动一次 Agent run。
- Character 公共 Agent 正在运行：将环境批次和状态快照合并为一条 follow-up，交给 pi-coding-agent 原生队列。

防抖适用于：

- `message_history`
- User Persona 的公开消息
- 其他 Character 的公开消息
- 后续定义的成员加入和离开环境事件

以下消息不进入环境批次，也不重置防抖计时：

- Character 自己公开消息的回传确认
- 普通请求响应

`get_group_chat_state` 响应不独立触发 Agent，而是作为触发它的环境批次的最新快照。防抖等待期间 `is_streaming` 保持 `false`；真正启动 Agent run 后才上报 `true`。防抖批次只是短暂的消息合并机制，不替代 pi-coding-agent 的 follow-up queue。首版固定为 1 秒，不提供配置项。

## Character 状态同步

Character 只向群聊创建者上报自身公共 Agent 的运行状态，不承担向其他 Character 广播的职责。

Character 上报：

```json
{
  "type": "update_character_state",
  "is_streaming": true
}
```

- 上报消息不携带 `character_id`；群聊创建者根据对应的 WebSocket 连接确定 Character 身份。
- 每次都发送完整的 `is_streaming` 状态，不使用局部状态补丁。
- 角色私有 pi session 的运行状态不上报。
- Character 公共 Agent 的 follow-up queue 不上报。
- `hand_raised` 由群聊创建者根据公开发言和举手规则维护，不由 Character 通过运行状态消息设置。

群聊创建者接收上报并更新权威状态，但不向其他 Character 广播状态消息：

- 群聊创建者界面直接读取并展示权威状态。
- 其他 Character 通过 `get_group_chat_state` 按需取得最新状态。
- Character 状态是临时状态，不写入群聊记录文件。
- 协议不定义 `character_state` 消息。

## 公开发言

### 发言请求

Character 的 `tavern_speak` Agent tool 通过以下 WebSocket 请求原子尝试发布完整内容：

```json
{
  "id": "req-8",
  "type": "speak",
  "content": "我建议先实现持久化层。"
}
```

- `id` 用于将 WebSocket 响应关联回本次 `tavern_speak` 调用。
- `content` 是准备公开发布的完整内容。
- 请求不携带 `character_id`；群聊创建者根据对应的 WebSocket 连接确定 Character 身份。
- 该请求不是提前询问发言许可。群聊创建者收到完整内容后，按照消息到达顺序原子检查当前 Round 的剩余发言次数。
- 发言请求本身不广播；只有成功进入群聊的公开消息才广播。

### 发言响应

发言响应区分：

- `success`：`speak` 命令是否被正常处理。
- `published`：提交的内容是否真正进入群聊。

成功发布：

```json
{
  "id": "req-8",
  "type": "response",
  "command": "speak",
  "success": true,
  "data": {
    "published": true,
    "event_id": "event-42",
    "sequence": 42,
    "round": {
      "round_max_messages": 10,
      "used_messages": 4,
      "remaining_messages": 6
    }
  }
}
```

额度耗尽：

```json
{
  "id": "req-8",
  "type": "response",
  "command": "speak",
  "success": true,
  "data": {
    "published": false,
    "reason": "round_limit_reached",
    "hand_raised": true,
    "round": {
      "round_max_messages": 10,
      "used_messages": 10,
      "remaining_messages": 0
    }
  }
}
```

- 额度耗尽时请求已经被正常处理并产生举手状态，因此 `success` 仍为 `true`。
- 未公开的 `content` 不写入群聊记录，也不广播；完整内容只保留在发送方的私有 pi session。
- `reason` 首版定义 `round_limit_reached`。
- 响应中的 Round 快照是处理该请求后的最新值。

协议错误或连接身份错误使用 `success: false`：

```json
{
  "id": "req-8",
  "type": "response",
  "command": "speak",
  "success": false,
  "error": "Character is not a group member"
}
```

### 公开消息广播

User Persona 和 Character 的公开消息统一使用 `public_message`。

Character 消息：

```json
{
  "type": "public_message",
  "event_id": "event-42",
  "sequence": 42,
  "timestamp": "2026-07-26T11:30:00.000Z",
  "sender": {
    "type": "character",
    "character_id": "developer",
    "name": "Developer"
  },
  "content": "我建议先实现持久化层。",
  "round": {
    "round_max_messages": 10,
    "used_messages": 4,
    "remaining_messages": 6
  }
}
```

User Persona 消息：

```json
{
  "type": "public_message",
  "event_id": "event-43",
  "sequence": 43,
  "timestamp": "2026-07-26T11:31:00.000Z",
  "sender": {
    "type": "user_persona"
  },
  "content": "先从持久化层开始。",
  "round": {
    "round_max_messages": 10,
    "used_messages": 0,
    "remaining_messages": 10
  }
}
```

- `event_id` 是公开消息的稳定标识。
- `sequence` 是群聊内公开消息的递增序号。
- `timestamp` 是群聊创建者接受消息的时间。
- `content` 是公开消息的完整内容。
- `sender.type` 首版支持 `user_persona` 和 `character`。
- Character sender 携带 `character_id` 和当时的显示名称；User Persona 不携带 Character 字段。
- Character 消息携带成功计数后的 Round 快照。
- User Persona 消息携带新 Round 的初始快照，其中 `used_messages` 为 `0`。
- `public_message` 遵循协议的统一广播语义。
- Character 发送方接收自己的广播作为正式发布确认，但该回传不进入自己的环境防抖批次。
- `message_history.messages` 与群聊记录中的公开消息复用此结构。

Character 发言成功时，群聊创建者原子分配 `event_id` 和 `sequence`、更新 Round 次数并写入群聊记录，然后先广播 `public_message`，再返回对应的 `speak` 成功响应。
