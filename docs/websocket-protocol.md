# PiTavern WebSocket Protocol

本文记录 PiTavern 群聊创建者与角色 pi 之间的 WebSocket 消息协议。

当前文档只收录已经确认的协议内容。尚未讨论完成的消息不在本阶段预先定义。

连接地址为：

```text
ws://127.0.0.1:<port>/<group_chat_id>/<instance_id>
```

`group_chat_id` 是来自群聊 session header 的持久身份，`instance_id` 是本次活动实例的运行期身份。群聊创建者在 WebSocket upgrade 阶段同时校验两者；任一不匹配时直接拒绝连接，不进入应用消息流程。活动描述文件只负责发现候选地址，实际连接是活动群聊有效性的最终判断。

## 连接心跳

PiTavern 使用标准 WebSocket `ping` / `pong` 控制帧检测半开连接，不定义 JSON 心跳消息：

- 群聊创建者每 30 秒向所有 Character WebSocket 发送一次 `ping`。
- Character 收到 `ping` 后由 WebSocket 库返回 `pong`，并记录最近一次收到创建者心跳的时间。
- 群聊创建者连续 120 秒没有收到某个 Character 的 `pong` 时，主动终止该连接。
- Character 连续 120 秒没有收到创建者的 `ping` 时，主动终止该连接。
- 普通 WebSocket `close` 或 `error` 事件立即进入断线处理，不等待心跳超时。
- 心跳超时只用于兜底检测半开连接，不是重连窗口。
- `ping` / `pong` 不进入环境聚合批次、Agent、pi session 或群聊记录。
- 心跳失败后不自动重连，统一执行 `disconnected` 清理。

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

### 非法消息

PiTavern 对协议错误采用 fail-fast：

- frame 不是可解析的 JSON 时，关闭该 WebSocket；
- JSON 不符合对应 TypeBox schema 时，关闭该 WebSocket；
- `type` 未知时，关闭该 WebSocket；
- 不尝试补全字段、转换类型或猜测发送方意图。

合法请求产生的业务失败不属于协议错误。例如 Character 已经被预留、当前没有 Round 或发言额度已经耗尽时，返回对应的 `success: false` 响应，并按照该业务消息已经定义的连接语义继续处理。

### 请求超时

所有 PiTavern WebSocket request/response 使用 5 秒通用短期协调超时：

- 加入阶段任一请求超时，加入方关闭连接、释放 `JoinAttempt` 并回到 `idle`；
- 正式在线后的状态、历史、离开或 `speak` 请求超时，Character 将当前连接视为失效，关闭 WebSocket 并执行统一断线清理；
- `tavern_speak` 超时时 tool 返回未公开错误，不能假设服务端已经接受消息；
- 超时不触发自动重连或请求重试。

服务端对已经完成持久化提交的公开消息不因响应发送超时而回滚。Character 如果没有取得成功响应，只能以后从公开广播或历史中观察该消息是否已经提交，首版不自动重试同一 `speak`，避免重复公开。

### 消息大小

PiTavern 使用两层硬性大小限制：

- 任意 WebSocket frame 最大为 1 MiB；
- 单条 User Persona 或 Character 公开消息的 `content` 最大为 64 KiB UTF-8 字节。

正文大小使用 `Buffer.byteLength(content, "utf8")` 检查，不使用 JavaScript 字符数量估算。1 MiB frame 上限同时配置在 WebSocket Server 和 Character 客户端；发送前的 codec 也必须检查编码结果，不能只依赖接收方断开。

64 KiB 正文上限保证最近 10 条公开消息及其 sender、Round 和 JSON 元数据能够稳定组成一个不超过 1 MiB 的 `message_history` frame。

超限时：

- User Persona 输入不写入群聊 session、不创建新 Round、不展示或广播为公共消息；
- `speak` 返回业务失败，不写入群聊、不消耗额度、不设置举手；
- 不截断、拆分或自动重试正文。

## 广播

广播（Broadcast）是群聊创建者将同一条逻辑消息发送给当前群聊全部在线 Character 的操作。

- 群聊创建者是唯一执行广播的一方。
- 广播没有接收者参数、候选列表或排除列表。
- 广播发生时，每个拥有活动 WebSocket 连接的 Character 都必须收到该消息。
- 消息来源不影响接收范围；发送消息的 Character 也接收自己的广播。
- Character 刚完成加入后即属于广播接收者，因此能收到紧随其后的广播。
- User Persona 由群聊创建者本地表示，不是 Character WebSocket 接收者。
- 向某个连接发送失败时，该 Character 转入断线处理流程；不能静默跳过并继续将其视为在线。
- Character 手动重新加入后会重新收到最近消息；协议不提供自动重连或按序号补发。
- 公开消息的广播以 `group_chat_update` 通知形式发出（M7/ISSUE-012）：广播只唤醒角色，完整增量由角色主动 `fetch_messages_since` 拉取（见「增量拉取」）。

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
- `is_streaming` 直接映射当前 pi Agent 的原生 `isStreaming` 状态，不区分本次处理由用户终端输入还是群聊输入触发。
- `hand_raised` 是独立状态，可以与其他运行状态同时存在。
- 当前 pi session 的 follow-up queue 是本地状态，不向群聊上报。
- 群聊创建者只获得 `is_streaming` 布尔值，不获得触发来源、输入内容或其他 pi session 状态。
- 在线 Character 不携带 `claim_status`；出现在在线列表中即表示已经完成 `character_ready`。
- `session_id`、其他私有 pi session 信息和角色卡文件路径不属于公开摘要。
- `is_self` 不持久化，也不由 Character 上报。

## 加入群聊

建立 WebSocket 连接不代表已经成为群成员。Character 使用应用层三阶段握手加入群聊：

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
预留 Character
    ↓
本地读取角色卡并准备 CharacterRuntime
    ↓
character_ready
    ↓
正式成为群成员
```

### 请求加入

```json
{
  "id": "req-2",
  "type": "join_group_chat",
  "session_id": "pi-session-uuid"
}
```

群聊创建者使用 `session_id` 防止同一个当前 pi session 建立重复成员连接。首版不提供断线重连或成员恢复分支。

加入响应：

```json
{
  "id": "req-2",
  "type": "response",
  "command": "join_group_chat",
  "success": true,
  "data": {
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

收到响应后，连接进入临时的加入阶段：

- `session_id` 必须是角色 pi 当前 session 的 ID；PiTavern 不创建另一个 Agent session ID。
- 群聊创建者使用 `session_id` 作为当前成员连接身份。
- 同一 `session_id` 已经在线时拒绝新的加入连接。
- `session_id` 到 Character 和 WebSocket 的映射只存在于当前活动实例，不写入群聊记录文件。
- 尚未成为群成员，也不占用任何 Character。
- 尚未预留 Character。
- 不接收群聊广播。
- 不能请求群聊记录文件。
- 可以在同一连接上重新发送 `join_group_chat`，刷新可领取 Character 列表。
- WebSocket 关闭后不留下成员状态。
- `available_characters` 排除已经被其他连接预留或已经在线的 Character。

### 领取 Character

```json
{
  "id": "req-3",
  "type": "claim_character",
  "character_id": "developer"
}
```

群聊创建者按照消息到达顺序原子检查并预留 Character。已经预留或已经在线的 Character 不能再次预留。成功响应：

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
- `claim_character` 成功只表示 Character 已由当前连接预留；该连接仍不是群成员，不接收群聊广播。
- 加入方收到成功响应后读取并验证一次文件，在内存中缓存 Character 提示词，并准备尚未激活的 `CharacterRuntime`。
- 此时不为当前 pi Agent 启用群聊输入模块、system prompt 扩展或 `tavern_speak`。
- 已经运行的 Character 不因角色卡文件后续变化自动替换提示词。

Character 已经被预留或已经在线等失败情况使用 pi-coding-agent 风格的通用错误响应：

```json
{
  "id": "req-3",
  "type": "response",
  "command": "claim_character",
  "success": false,
  "error": "Character is no longer available"
}
```

失败时不预留 Character。加入方重新发送 `join_group_chat` 获取最新的可领取 Character 列表并再次选择。

预留只属于当前 WebSocket 连接，不持久化，也不进入在线 Character 列表。连接在正式加入前关闭时，群聊创建者立即释放预留，不广播 `character_left`。

成功预留后，群聊创建者立即启动 5 秒 `character_ready` 超时计时。5 秒内仍未完成 `character_ready` 时，群聊创建者先释放 Character 预留，再关闭当前 WebSocket。

加入方在 `joining` 期间收到该连接关闭后，释放 `JoinAttempt` 并直接回到 `idle`。首版不增加“预留已超时”等中间运行状态；用户需要重新执行 `/tavern-join`。

### Character 准备完成

本地角色卡读取、验证和 `CharacterRuntime` 准备成功后，加入方在同一连接上发送：

```json
{
  "id": "req-4",
  "type": "character_ready"
}
```

请求不携带 `character_id` 或 `session_id`。群聊创建者根据连接闭包中保存的预留确定身份。没有有效预留、预留已释放或连接已经在线时返回通用错误响应。

成功响应：

```json
{
  "id": "req-4",
  "type": "response",
  "command": "character_ready",
  "success": true
}
```

处理 `character_ready` 时，群聊创建者原子执行：

1. 从 Character 预留集合中移除当前预留；
2. 将 `session_id` 与 WebSocket 写入正式连接集合；
3. 将 `session_id` 与 Character 写入在线 Character 状态。

成功响应发出后，群聊创建者先向新 Character 发送最近 10 条 `message_history`，再向全部在线 Character 广播 `character_joined`。加入方收到成功响应后把准备好的 `CharacterRuntime` 激活，转交 WebSocket，并将 Controller 从 `joining` 切换为 `character`；激活前已到达的历史和广播由 `JoinAttempt` 缓冲并按接收顺序转交。Character 在环境批次窗口结束后主动请求 `get_group_chat_state`。

加入方在发送 `character_ready` 前本地准备失败时，关闭 WebSocket 并回到 `idle`；群聊创建者随连接关闭释放预留。首版不自动重试。

### Character 加入广播

Character 完成 `character_ready` 并正式成为群成员后，群聊创建者向此时的全部在线 Character 广播：

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
- 群聊已有公开消息时，该消息属于环境事件，进入每个接收方的环境聚合批次（闲态 1s 窗口，N→1）。
- 群聊尚无公开消息时，该消息只用于界面通知，不进入环境批次，也不触发 Agent run。
- 新加入的 Character 先处理 `message_history`，再处理自己的 `character_joined` 广播。
- 群聊已有公开消息时，历史中的 `public_message` 按历史顺序排在自己的加入事件之前，二者合并到同一个首次环境批次。
- 群聊尚无公开消息时，空 `message_history` 和自己的加入事件都不创建环境批次。
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

角色 pi 执行会产生或切换到不同 `session_id` 的 pi 原生 session 操作前，先询问用户是否退出群聊并继续。取消确认时阻止原生操作；确认后执行相同的主动离开流程，再允许 `/new`、`/resume`、`/fork` 或 `/clone` 继续。新 session 不继承群成员关系。离开请求因连接故障无法送达时，角色 pi 仍立即完成本地清理，群聊创建者通过 WebSocket 断开执行 `disconnected` 清理。

主动离开完成后不提供事务回滚。后续 pi session 操作失败或取消时，角色 pi 保持 `idle`，不自动重连或恢复 Character。

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
- `disconnected`：Character WebSocket 意外断开。

WebSocket 意外断开时没有离开请求和响应。群聊创建者立即执行同样的移除、释放和广播流程，不保留重连窗口。

角色 pi 在检测到 WebSocket 断开时不等待服务端通知，立即清除当前群聊关联、未提交的环境聚合批次、群聊输入模块、Character system prompt 和 `tavern_speak`。已经提交给 pi session 或原生 follow-up queue 的群聊输入不回滚，当前 Agent run 不打断。用户之后只能通过 `/tavern-join` 重新加入。

`character_left`：

- 遵循协议的统一广播语义，接收范围基于成员移除后的在线 Character 集合。
- 群聊已有公开消息时属于环境事件，进入接收方的环境聚合批次（闲态 1s 窗口，N→1）。
- 群聊尚无公开消息时只用于界面通知，不进入环境批次，也不触发 Agent run。
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
- 保留并继续使用当前 pi Agent 和 pi session。
- 不强制中断当前 pi Agent 已经在处理的对话；群聊关联清除后，后续 `tavern_speak` 尝试失败。

`group_chat_closed` 是仅存在于当前活动实例中的运行期终止信号，不进入环境聚合批次，也不触发新的 Agent run。它不写入群聊记录文件，也不使用 `event_id` 或 `sequence`。

PiTavern 与 pi-coding-agent session 一样，不持久化“已结束”状态。是否存在活动群聊只由临时活动描述和当前进程决定；群聊记录文件始终停留在最后一条完整记录。

群聊创建者异常退出时无法发送关闭广播。加入方通过 WebSocket 断开退出当前群聊。恢复群聊时会建立新的活动实例和成员关系，不恢复旧连接。

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
- `cursor` 标识当前批次最早一条公开消息之前的历史位置，用于继续获取更早消息。
- `cursor` 只由群聊创建者生成和解释；Character 不解析其内容，只在后续请求中原样回传。
- 没有更早消息时，`cursor` 为 `null`，`has_more` 为 `false`。
- `total_messages` 是响应时群聊内公开消息的总数。
- 空群聊返回空 `messages`、`cursor: null`、`has_more: false` 和 `total_messages: 0`；空历史不启动 Agent run。

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
- 服务端可以使用 `sequence` 定位 cursor 的分页边界，但具体编码不属于 WebSocket 协议。

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
- 空群聊尚未创建 JSONL 文件，此时返回 `success: false`。

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
- `is_self` 由群聊创建者根据发起 `get_group_chat_state` 的 WebSocket 连接填写，并且恰好一个为 `true`。

群聊状态不包含地址、端口、创建者 PID、`config_max_messages`、历史消息或群聊记录文件路径。

### 状态拉取

群聊状态不主动广播。Character 在以下场景使用 `get_group_chat_state` 主动获取最新快照：

- run 边界（闲态 1s 聚合窗口 / 忙态 settle 后）、准备提交一次 Agent run 或 follow-up 时。
- 用户执行需要展示完整状态的命令时。
- 其他明确需要刷新本地群聊状态的交互。

环境批次触发的状态响应与该批次合并后，作为一次群聊输入提交给当前 pi Agent。Character 提示词由加入期间持续生效的 system prompt 扩展提供，不进入该输入。手动状态命令取得的响应只更新界面，不触发 Agent。

Character 成功领取角色后，群聊创建者自动发送 `message_history`。历史非空时，Character 将其加入首次环境批次；批次窗口（1 秒合并防抖）结束后主动请求群聊状态，再将历史批次和最新状态作为群聊输入提交给当前 pi Agent。空历史只更新界面，不创建环境批次。

首次处理没有特殊的禁言规则。`tavern_speak` 是否被接受只由收到请求时当前 Round 的剩余发言次数判断；没有当前 Round 或当前 Round 没有剩余次数时，公开消息不能进入群聊。

### 环境消息聚合与 run 边界投递（#60/#62/#64 pull 模型）

Character 使用固定 1 秒聚合窗口（闲态）合并连续到达的环境消息；忙态零中间注入，settle 后立即触发：

1. 收到 `group_chat_update` 通知（水位 + 最近 3 条预览）后，将预览并入待处理批次；**公共消息正文不注入**——run 活跃时只置忙态标记（零中间注入红线）。
2. 闲态：固定 1s 聚合窗口，窗口内多次变化并入**单次消费**（N→1），不重置计时（#60/#62）。
3. 忙态：settle 后立即消费（#64）；消费 = 按本 Session 持久化游标 `fetch_messages_since` 拉取全部未读，sequence 过滤天然补洞。
4. 拉取完成后请求最新群聊状态，将批次与状态快照合并提交。

提交环境批次时：

- 当前 pi Agent 空闲：将环境批次和状态快照合并为一次输入并立即提交（触发新 run）。
- 当前 pi Agent 正在运行：将同样的合并输入作为一条 follow-up，交给当前 pi session 的原生队列，由 settle 触发投递。

WebSocket 环境消息不会逐条直接追加到 pi session。只有聚合完成后的合并输入才通过 pi 原生对话入口提交，并与随后的 assistant 回复、工具调用和工具结果一起按照 pi 原生 session 逻辑记录。成员/环境事件（character_joined/left、message_history）经 steer 通道在工具调用间隙可见（#38，不打断 run、秒级延迟）。

聚合批次适用于：

- `message_history`
- User Persona 的公开消息
- 其他 Character 的公开消息
- 已经产生公开消息的群聊中的成员加入和离开环境事件

以下消息不进入环境批次，也不重置聚合窗口计时：

- Character 自己公开消息的回传确认
- 普通请求响应

`get_group_chat_state` 响应不独立触发 Agent，而是作为触发它的环境批次的最新快照。聚合窗口本身不修改 `is_streaming`；该字段始终跟随当前 pi Agent 的原生状态（#14 watchdog 兜底）。聚合批次只是短暂的消息合并机制，不替代 pi-coding-agent 的 follow-up queue。闲态窗口固定为 1 秒，不提供配置项。

## Character 状态同步

Character 只向群聊创建者上报当前 pi Agent 的原生 `isStreaming` 状态，不承担向其他 Character 广播的职责。

Character 上报：

```json
{
  "type": "update_character_state",
  "is_streaming": true
}
```

- 上报消息不携带 `character_id`；群聊创建者根据对应的 WebSocket 连接确定 Character 身份。
- 每次都发送完整的 `is_streaming` 状态，不使用局部状态补丁。
- `is_streaming` 不区分用户终端输入与群聊输入。
- 当前 pi session 的 follow-up queue 不上报。
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
  "content": "我建议先实现持久化层。",
  "based_on_sequence": 41
}
```

- `id` 用于将 WebSocket 响应关联回本次 `tavern_speak` 调用。
- `content` 是准备公开发布的完整内容。
- `based_on_sequence`（可选，ISSUE-013 B1）：发送方最后已见的公开消息序号（与增量拉取游标同一概念——最后一次成功投递的 sequence）。带该字段时，服务端对滞后的发言执行落后校验（B2）；**缺省 = 不校验**——旧客户端/手动 WebSocket/既有测试不带该字段时行为与首版完全一致（平滑演进），但新客户端（`tavern_speak` 工具）总是携带。
- 只有已经完成 `character_ready` 且当前 WebSocket 已连接时，角色 pi 才启用 `tavern_speak`。
- WebSocket 断开后工具立即停用，Character 领取关系同时释放。
- 断线后无法形成 WebSocket `speak` 请求，本地工具调用失败且不产生举手。用户手动重新加入并完成 `character_ready` 后才重新启用工具。
- 请求不携带 `character_id`；群聊创建者根据对应的 WebSocket 连接确定 Character 身份。
- 该请求不是提前询问发言许可。群聊创建者收到完整内容后，按照消息到达顺序原子检查（身份 → Round 存在 → **落后校验** → 剩余发言次数）后决定是否发布。
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
    "event_id": "a1b2c3d4",
    "sequence": 42,
    "latest_sequence": 42,
    "round": {
      "round_max_messages": 10,
      "used_messages": 4,
      "remaining_messages": 6
    }
  }
}
```

- `latest_sequence`（ISSUE-013）：发布后服务端最新序号（成功时等于本次 `sequence`）。**纯信息字段、非推进源**——客户端不据此推进游标或任何已见序号（B6 由服务端排除自身判定保证不误拒），客户端不得依赖该字段做状态推进。

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
- `reason` 首版定义 `round_limit_reached` 与 `stale`。
- 响应中的 Round 快照是处理该请求后的最新值。

落后拒绝（ISSUE-013 B2）：发送方携带的 `based_on_sequence` 小于服务端最新序号时，请求被正常处理（业务拒绝，非协议错误），`success` 仍为 `true`：

```json
{
  "id": "req-8",
  "type": "response",
  "command": "speak",
  "success": true,
  "data": {
    "published": false,
    "reason": "stale",
    "missing_sequences": { "from": 42, "to": 45 },
    "round": {
      "round_max_messages": 10,
      "used_messages": 4,
      "remaining_messages": 6
    }
  }
}
```

- `missing_sequences`：发送方尚未看到的**连续区间** `from..to`（闭区间，`from = based_on_sequence + 1`，`to` = 当前最新总序号）。纯提示信息：补拉复用既有 `fetch_messages_since`，服务端不计算「他人精确区间」，speak 响应不承担第二套拉取协议。
- **stale 语义**：不发布、不写入群聊记录、不广播、**不消耗 Round 额度、不设置举手**（区别于 `round_limit_reached` 的举手——额度耗尽 vs 消息过时是两种语义，后者不是「还有话说」）。
- **落后判定排除自身（B6）**：服务端比较的是「最近一条**他人**消息的序号」（尾部向前扫描，跳过请求者自己的消息）——客户端的拉取游标永不越过自己的消息（回显被客户端过滤），若按最新总序号比较，自己的消息会令下一次发言被误拒。
- **客户端行为（B3/B5，简化终版）**：`tavern_speak` 工具收到 stale 拒绝后**不做任何拉取**——只置 A2 既有「有更新」标记并返回一句提示（无消息全文）；当前 run 结束后由 A2 统一拉取覆盖（被拒时错过的消息与后续增量一并拉全），新 turn 里 LLM 看到完整上下文重新决策（放弃或修改重发）。同轮自动恢复上限 2 次（按响应 Round 快照变化重置），超限后只报告拒绝，不再触发自动注入。

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

### 公开消息广播与增量拉取（M7/ISSUE-012）

#### `public_message`（历史/拉取消息形态）

User Persona 和 Character 的公开消息统一使用 `public_message` 结构。`group_chat_update.preview_messages`、`message_history.messages` 与 `fetch_messages_since` 的响应均复用此结构。

Character 消息：

```json
{
  "type": "public_message",
  "event_id": "a1b2c3d4",
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
  "event_id": "b2c3d4e5",
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

- `event_id` 是对应 pi session `custom_message` entry 的原生 `id`。
- `sequence` 是群聊内公开消息的递增序号，第一条公开消息从 `1` 开始。
- 只有成功落盘的公开消息才占用 `sequence`；群聊设置、成员事件、状态变化和举手不占用。
- 恢复群聊时从最后一条公开消息继续递增，不因重新启动活动实例而重置。
- `timestamp` 是群聊创建者接受消息的时间。
- `content` 是公开消息的完整内容。
- `sender.type` 首版支持 `user_persona` 和 `character`。
- Character sender 携带 `character_id` 和当时的显示名称；User Persona 不携带 Character 字段。
- Character 消息携带成功计数后的 Round 快照。
- User Persona 消息携带新 Round 的初始快照，其中 `used_messages` 为 `0`。
- `public_message` 遵循协议的统一消息结构；广播形态为 `group_chat_update` 通知（见「公开消息广播与增量拉取」）。
- Character 发送方接收自己的广播作为正式发布确认，但该回传不进入自己的环境聚合批次。
- `message_history.messages` 与群聊记录中的公开消息复用此结构。

#### `group_chat_update`（广播通知形态）

公开消息的广播以通知形式发出，不再逐条推送完整消息；成员/流式状态变化（成员加入/离开、`is_streaming` 翻转、举手）同样复用此通道唤醒角色刷新快照（方案 A，ISSUE-014）：

```json
{
  "type": "group_chat_update",
  "latest_sequence": 43,
  "preview_messages": [ { "type": "public_message", ... 最近 3 条 ... } ],
  "total_messages": 43
}
```

- `latest_sequence`：当前最新公开消息序号；角色据此检测缺口（`latest_sequence ≠ 本地游标 + 1` 即应拉取补齐）。无任何公开消息时（群聊刚创建/成员变化先于首条消息）为 `0`、`preview_messages` 为空数组。
- `preview_messages`：最近 3 条公开消息（微信通知形态），与拉取路径同源（同一 `publicMessages` 数据）。
- 角色在 run 边界（闲态 1s 聚合窗口 / 忙态 settle 后立即）按本 Session 持久化游标执行 `fetch_messages_since` 拉取全部未读（N→1 单次投递），投递仍走 followUp（不打断当前 run）；同时刷新本地群聊状态快照（`get_group_chat_state`）。
- **双触发语义（方案 A，ISSUE-014）**：除消息变更（公开消息发布）外，成员加入/离开、`is_streaming` 翻转、举手状态变化也会广播 `group_chat_update`。非空群聊中两类触发在负载上不可区分（成员广播同样携带最新 `latest_sequence` 与预览）——这是有意的通道复用（协议格式零变更），消费端依赖「每次 update 拉增量（按序号幂等）+ 刷新快照」自洽，不得按广播触发源或到达顺序作精确断言（测试宜用谓词式断言）。

#### `fetch_messages_since`（增量拉取命令）

请求：

```json
{
  "id": "req-1",
  "type": "fetch_messages_since",
  "since_sequence": 40
}
```

成功响应：

```json
{
  "id": "req-1",
  "type": "response",
  "command": "fetch_messages_since",
  "success": true,
  "data": {
    "messages": [ { "type": "public_message", "sequence": 41 }, ... ],
    "latest_sequence": 43,
    "total_messages": 43
  }
}
```

- `messages`：`sequence > since_sequence` 的全部公开消息（严格递增、无重复）；按序号过滤天然补齐缺口。
- `latest_sequence`：服务端当前最新序号。
- 与 `message_history`（join 全量/分页）并存：无游标时 join 走历史分页；有持久化游标时 join/重连走增量拉取（差分同步）。

Character 发言成功时，群聊创建者原子分配 `sequence`、更新 Round 次数并通过 `SessionManager` 写入 `custom_message`，使用返回的 entry `id` 作为 `event_id`，然后先广播 `group_chat_update`，再返回对应的 `speak` 成功响应。

session append 成功是公开消息成立的提交点。append 失败时，不递增 `sequence`、不消耗 Round 额度、不广播，并返回 `success: false`。append 成功后，即使某个 WebSocket 发送失败，公开消息也不回滚；对应连接进入断线处理。
