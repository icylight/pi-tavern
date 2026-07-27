# PiTavern Persistence

本文记录 PiTavern 群聊记录的持久化设计。

## pi session 格式

一个群聊记录文件就是一个有效的 pi-coding-agent session JSONL 文件。PiTavern 直接使用 pi-coding-agent 的 `SessionManager` 创建、读取和追加记录，不实现第二套 session header、entry envelope、ID、父子关系或结束状态。

首条记录使用 pi 原生 `SessionHeader`：

```json
{
  "type": "session",
  "version": 3,
  "id": "group-chat-uuid",
  "timestamp": "2026-07-26T12:00:00.000Z",
  "cwd": "/absolute/project/path"
}
```

字段映射：

- header `id` 就是 `group_chat_id`。
- header `timestamp` 就是 `created_at`。
- header `cwd` 是群聊所属项目工作目录。
- header `version` 使用当前 pi session 格式版本；它与 WebSocket 协议无关。
- 群聊不使用 `parentSession`。

后续 entry 直接使用 pi 原生的 `id`、`parentId` 和 `timestamp`。群聊按照当前 leaf 追加记录，不自行生成另一套 entry envelope。

群聊显示名使用 pi 原生 `session_info` entry，与 pi session name 保持相同语义。

### 群聊显示名

`/tavern-name` 直接复用 pi 原生的 session name 逻辑：

- 空群聊改名时，只修改内存中的群聊显示名。
- 第一条 User Persona 消息触发落盘时，通过 `appendSessionInfo(name)` 写入当时最新的显示名。
- 已开始的群聊改名时，立即通过 `appendSessionInfo(name)` 追加新的 `session_info` entry。
- 恢复群聊时，使用当前 session 中最后一条 `session_info` 的名称。
- 名称只用于显示，不作为群聊身份；`group_chat_id` 始终来自 session header `id`。

## 生命周期

- 新建群聊时只在内存中创建 `SessionManager`、原生 header、群聊 ID 和活动描述，不立即创建 JSONL 文件。
- 群聊产生第一条 User Persona 公开消息时才创建 pi session JSONL 文件。
- 恢复群聊时使用 `SessionManager` 打开原文件并从当前 leaf 继续追加。
- 群聊关闭或创建者异常退出时，不追加关闭或结束 entry。
- 删除群聊复用 pi session 文件删除逻辑。
- 是否存在活动群聊由临时活动描述和当前进程决定，不写入群聊记录。

### 恢复群聊

`/tavern-resume` 的 session 恢复行为与 pi-coding-agent 的 resume 保持一致：

1. 选择一个已有的群聊 session 文件。
2. 使用 `SessionManager.open(path)` 打开该文件。
3. 由 pi 恢复原生 header、session ID、entry 树和当前 leaf。
4. PiTavern 扫描当前 session entry，重建群聊扩展状态。
5. 后续记录从当前 leaf 继续通过 `SessionManager` 原生 append API 写入。

PiTavern 从持久化 entry 恢复：

- 最新 `session_info` 中的群聊显示名。
- 最新 `pi-tavern.group-settings` 中的 `groupMaxMessages`。
- 公开消息历史、消息序号和可恢复的 Round 状态。

恢复 Round 时，以最后一条 `pi-tavern.public-message` 的 `details.round` 快照为准：

- `/tavern-resume` 不创建新 Round，也不刷新发言额度。
- 恢复后的 `roundMaxMessages`、`usedMessages` 和 `remainingMessages` 与关闭前一致。
- Character 重新加入后，可以继续使用该 Round 的剩余额度发言。
- 如果 Round 在关闭前已经耗尽，恢复后仍然保持耗尽。
- 只有新的 User Persona 公开消息才创建并刷新 Round。

PiTavern 不恢复运行期状态：

- WebSocket 连接。
- 在线 Character。
- `is_streaming`。
- 举手状态。
- 监听端口。

打开 session 后，PiTavern 只负责重新创建群聊运行时并分配端口。Character 仍然手动加入。session 的打开、迁移、索引和续写不实现第二套逻辑。

### 空群聊与已开始群聊

群聊在运行期有两个可推导状态：

```text
empty
  尚无任何公开消息
  不存在群聊 JSONL 文件

started
  已产生第一条 User Persona 公开消息
  存在群聊 JSONL 文件
```

这两个状态不写入 session entry：

- `empty` 是新建群聊的初始状态。
- 群聊显示名和 `group_max_messages` 在 `empty` 状态下只保存在内存。
- 空群聊关闭后不留下 JSONL 文件，不出现在 `/tavern-resume` 中。
- 恢复出来的群聊必然是 `started`。
- `started` 由群聊存在至少一条公开消息及其 JSONL 文件存在推导。

第一条 User Persona 消息使群聊从 `empty` 转为 `started`：

1. 将内存中由 `SessionManager` 生成的原生 `SessionHeader` 写入文件。
2. 使用 `SessionManager` 重新打开该文件，使后续原生 append 正常落盘。
3. 追加内存中的群聊名称 `session_info`。
4. 追加当前 `group_max_messages` 设置。
5. 追加第一条 User Persona `public_message`。
6. 写入成功后才广播该消息。

header `timestamp` 保持 `/tavern-new` 时在内存中生成的群聊创建时间，不改为第一条消息时间。

该初始化只提前写入 pi 自己生成的原生 header，后续全部使用 `SessionManager` 的 append API，不引入第二套文件格式。

### 空群聊中的成员事件

Character 可以在空群聊中加入或离开。群聊创建者仍然广播并在界面显示对应通知，但这些成员事件：

- 不进入任何角色 pi 的群聊环境批次。
- 不启动 Agent run。
- 不写入 Character 的 session。
- 不写入群聊记录。

群聊进入 `started` 后，新的 Character 加入和离开事件才作为群聊输入模块的环境事件。角色 pi 在提交防抖后的环境批次前获取的最新群聊状态会包含当时的完整在线成员情况。

### 成员事件不持久化

`character_joined` 和 `character_left` 始终只是运行期环境事件：

- 不追加到群聊 session JSONL。
- 不出现在最近消息或更早消息历史中。
- 不出现在群聊记录文件的公开消息记录中。
- 恢复群聊时不回放过去的加入或离开事件。

群聊恢复后的在线成员状态由 Character 实际重新加入形成，不从历史成员事件重建。群聊处于 `started` 状态时，新的加入或离开事件仍会广播，并进入在线 Character 当前的公共环境批次。

## 字段命名

pi session JSONL 完全遵循上游格式。`parentId`、`customType`、`parentSession` 等字段不转换为 `snake_case`。

PiTavern 自己定义的 WebSocket JSON 仍然遵循 `snake_case`。读取 session entry 并生成 WebSocket 消息时才执行明确的字段映射。

## 公开消息

User Persona 和 Character 的公开消息都使用 pi 原生 `custom_message` entry。PiTavern 不增加新的顶层 session entry `type`。

选择 `custom_message` 的原因：

- 它是 pi 扩展向 session 写入上下文消息的原生入口。
- 它支持公开消息正文。
- `details` 可以保存公开消息的群聊元数据。
- 它能被 `SessionManager` 正常读取并参与上下文构建。

公开消息 entry：

```json
{
  "type": "custom_message",
  "id": "a1b2c3d4",
  "parentId": "previous-entry",
  "timestamp": "2026-07-26T11:30:00.000Z",
  "customType": "pi-tavern.public-message",
  "content": "Developer:\n我建议先实现持久化层。\n",
  "display": true,
  "details": {
    "sequence": 42,
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
}
```

约定：

- `customType` 固定为 `pi-tavern.public-message`。
- `display` 为 `true`。
- entry `id` 直接作为 WebSocket `public_message.event_id`。
- entry `timestamp` 直接作为 WebSocket `public_message.timestamp`。
- `details` 保存广播消息中不能由 pi entry envelope 直接取得的结构化主体。
- `details` 是 PiTavern 自定义 JSON，因此内部字段使用 `snake_case`。
- `details.content` 原样保存公开消息正文，不执行展示格式规范化。

`content` 是从 `details` 生成的 Agent 上下文投影：

```text
<sender label>:
<message content>
\n
```

Character 使用角色显示名称作为 sender label：

```text
Developer:
我建议先实现持久化层。
\n
```

User Persona 使用固定标签：

```text
User Persona:
先从持久化层开始。
\n
```

投影时移除正文末尾已有的连续 LF，再追加一个 LF，保证整个 `content` 恰好以一个 `\n` 结尾。该规范化只影响 Agent 上下文投影，不改变 `details.content` 中的原始公开正文。

从 entry 生成 WebSocket 广播时：

```text
type       = "public_message"
event_id   = entry.id
timestamp  = entry.timestamp
sequence   = entry.details.sequence
sender     = entry.details.sender
content    = entry.details.content
round      = entry.details.round
```

### 公开消息序号

`sequence` 是群聊内部的公开消息递增序号：

- 每个群聊的第一条公开消息使用 `sequence: 1`。
- 只有成功写入 session 的 `pi-tavern.public-message` 才占用并递增序号。
- 群聊设置、成员事件、状态变化和举手不占用序号。
- 恢复群聊时，从最后一条 `pi-tavern.public-message` 的 `details.sequence` 继续递增。
- 群聊不删除单条公开消息，因此当前最后一个 `sequence` 同时也是 `total_messages`。

### 公开消息提交顺序

群聊创建者先持久化公开消息，再进行 WebSocket 广播：

1. 在当前群聊的串行提交区内检查 Round 额度。
2. 计算候选 `sequence` 和新的 Round 快照。
3. 通过 `SessionManager` 追加 `pi-tavern.public-message`。
4. 追加成功后，正式提交内存中的序号和 Round 计数。
5. 使用已持久化 entry 广播 `public_message`。

如果 session append 失败：

- 不递增 `sequence`。
- 不消耗 Round 发言额度。
- 不广播公开消息。
- Character 的 `speak` 返回失败。
- User Persona 的发送在群聊创建者界面显示失败。

如果持久化成功后部分 WebSocket 发送失败，公开消息仍然有效。发送失败的连接进入断线处理；Character 重新加入后可通过最近消息历史取得该消息。

## 群聊设置

`group_max_messages` 使用 pi 原生 `custom` entry 持久化：

```json
{
  "type": "custom",
  "id": "b2c3d4e5",
  "parentId": "previous-entry",
  "timestamp": "2026-07-26T12:00:00.000Z",
  "customType": "pi-tavern.group-settings",
  "data": {
    "group_max_messages": 10
  }
}
```

约定：

- `customType` 固定为 `pi-tavern.group-settings`。
- `data` 是 PiTavern 自定义 JSON，字段使用 `snake_case`。
- 每条 entry 保存完整设置快照，不保存增量。
- 空群聊执行 `/tavern-set-max` 时，只修改内存中的 `groupMaxMessages`。
- 第一条 User Persona 消息触发落盘时，写入当时最新的 `groupMaxMessages`。
- 已开始的群聊执行 `/tavern-set-max` 时，立即追加一条新的设置 entry。
- 恢复群聊时，读取当前分支最后一条 `pi-tavern.group-settings` entry。
- 修改 `groupMaxMessages` 只影响未来创建的 Round；当前 Round 已继承的 `roundMaxMessages` 不变。
- `custom` entry 不进入 Agent 上下文。
- `configMaxMessages` 不写入群聊记录，只在创建群聊时提供默认值。

三个值的继承关系为：

```text
configMaxMessages
    ↓ 创建群聊时继承
groupMaxMessages
    ↓ 创建 Round 时继承
roundMaxMessages
```
