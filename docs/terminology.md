# PiTavern Terminology

本文定义 PiTavern 在产品文案、需求文档和代码中的统一术语。

## 参考术语

SillyTavern 使用以下概念：

- **Group**：一组角色及其设置。
- **Group Chat**：Group 下的一段具体聊天。
- **Group Member**：参与 Group Chat 的成员。
- **Character**：角色。
- **Character Card**：定义角色的角色卡。
- **User Persona**：用户在聊天中的身份，与 Character 区分。

PiTavern 首版不提供独立的固定 Group 管理，而是将动态成员关系与一段公共聊天绑定。因此首版公开 `Group Chat`，不公开单独的 `Group` 实体。

SillyTavern 使用 AGPL-3.0。PiTavern 只借鉴其术语和交互概念，不复制实现代码。

## 规范术语

| 中文 | 英文及代码概念 | 定义 |
| --- | --- | --- |
| pi-coding-agent | `pi-coding-agent` | PiTavern 所扩展的上游 Coding Agent 项目；其 CLI 命令为 `pi`。 |
| PiTavern | `PiTavern` | 产品、pi-coding-agent 扩展及 `/tavern-*` 命令的命名空间。 |
| 群聊 | `GroupChat` / Group Chat | `/tavern-new` 创建、`/tavern-resume` 恢复的公共聊天。 |
| 活动群聊 | `ActiveGroupChat` / Active Group Chat | 当前项目中正在由某个群聊创建者 pi 承载的群聊；同一项目可以同时存在多个。 |
| 当前群聊 | Current Group Chat | 当前 pi 已创建或加入并正在交互的群聊。 |
| 群聊记录 | `ChatHistory` / Chat History | 独立于所有 pi session 持久化的公共消息历史。 |
| 群聊创建者 | `GroupChatCreator` / Group Chat Creator | 执行 `/tavern-new` 的 pi session；默认绑定一个代表用户的 User Persona。 |
| 用户 | `User` | 操作群聊创建者 pi、通过 User Persona 发送公共消息的人。 |
| 用户 Persona | `UserPersona` / User Persona | 群聊创建者自动代表的内置 `user` role；不是 Markdown、配置资源或 Character。 |
| 角色 | `Character` | 由角色卡定义的身份，不等同于某个 pi-coding-agent 进程。 |
| 角色卡 | `CharacterCard` / Character Card | 使用 Markdown 定义角色提示词的文件。 |
| 群成员 | `GroupMember` / Group Member | 通过 User Persona 或 Character 身份参与某个活动群聊的 pi。 |
| 私聊 | `PrivateChat` / Private Chat | 用户在某个角色 pi 中与该角色进行的非公开对话。 |
| pi session | `PiSession` / pi Session | 每个 pi-coding-agent 进程独立持久化的会话；不是群聊记录。 |
| Character 公共 Agent | `CharacterPublicAgent` / Character Public Agent | 角色 pi 内用于参与群聊的独立 Agent 上下文；只读取 Character Markdown 和公共事件。 |
| 后续消息队列 | `followUp` / Follow-up Queue | 每个 Character 公共 Agent 在当前工作完成后投递公共消息的 pi-coding-agent 原生队列；PiTavern 不自建队列。 |
| 公共事件 | `PublicEvent` / Public Event | 从群聊同步到角色 pi session 的公共消息或状态事件。 |
| 广播 | `Broadcast` | 群聊创建者将同一条逻辑消息无筛选地发送给当前群聊全部在线 Character 的操作；消息发送者同样接收。 |
| 讨论轮次 | `DiscussionRound` / Round | 由一条 User Persona 消息开启的一轮 Character 公共讨论。 |
| 配置总发言次数 | `configMaxMessages` / Configured Maximum Messages | 全局或项目配置解析出的新群聊默认发言上限；首版缺省值为 `10`。 |
| 群聊总发言次数 | `groupMaxMessages` / Group Maximum Messages | 新建群聊时从 `configMaxMessages` 继承并随群聊持久化的默认值。 |
| 轮次总发言次数 | `roundMaxMessages` / Round Maximum Messages | 新建讨论轮次时从 `groupMaxMessages` 继承的不可变硬上限。 |
| 举手 | `HandRaise` / Hand Raise | 总发言次数耗尽后，引导用户前往角色私有 pi session 查看回复的临时 UI 状态；不是公共消息或待发送队列。 |
| 公开发言工具 | `tavern_speak` | Character 唯一用于尝试发送公共回复的 Agent tool；不是用户 `/` 命令。 |

## 使用规则

- `PiTavern` 或“酒馆”只表示产品和交互隐喻，不表示群聊实体。
- 产品文案可以使用“进入酒馆”这类自然表达，需求和代码必须使用“加入群聊”。
- 不使用“房间”或 `Room` 表示群聊。
- `/tavern-new` 表示新建群聊。
- `/tavern-resume` 表示恢复历史群聊。
- `/tavern-join` 表示从当前项目的活动群聊中选择一个加入并成为群成员。
- 一个 pi 同时只能拥有一个当前群聊；创建者身份与 Character 群成员身份互斥。
- `/tavern-set-max <count>` 使用绝对值设置当前群聊的 `groupMaxMessages`，不修改当前 Round。
- `/tavern-name <name>` 按照 pi-coding-agent session name 的相同语义设置群聊显示名；名称不是群聊身份。
- 群聊创建者默认以 User Persona 成为群成员；其他 pi 加入群聊时领取 Character。
- User Persona 表示用户身份，Character 表示 Agent 角色，两者不混用。
- 角色 pi 执行 `/tavern-leave` 表示退出其当前群聊；群聊创建者执行该命令表示关闭其创建的群聊。
- 群聊关闭不等于删除；关闭后的群聊仍可恢复，历史删除在 `/tavern-resume` 选择器中完成。
- 群聊关闭只终止当前活动实例，不向群聊记录写入关闭或结束状态。
- “角色”描述身份，“群成员”描述已连接并领取该身份的 pi，不混用。
- “私聊”描述用户与角色的对话，“pi session”描述承载并保存该私聊的技术会话，不混用。
- 角色 pi 外层私有 pi session 的 `sessionId` 同时作为临时群成员连接和重连身份；不另设 `memberId`。
- “广播”始终面向全部在线 Character，不使用接收者列表或排除列表，也不排除消息发送者。
- 私有 pi session 与 Character 公共 Agent 属于同一个角色 pi，但上下文相互隔离。
- `configMaxMessages`、`groupMaxMessages` 和 `roundMaxMessages` 按配置、群聊、讨论轮次区分，不混用。
- 总发言次数是唯一的发言控制额度；不设置每角色保底机会数或角色活跃度配置。
- “举手”只表示继续发言的意图，不等同于 Character 已经生成或发送公共回复。
- 新 Round 开始时清除上一 Round 的全部举手状态。
- 普通 assistant 输出属于私有 pi session；只有 `tavern_speak.content` 可以尝试进入群聊。
- 首版不引入独立的 `Group` 实体，避免与 `GroupChat` 形成无实际用途的两层模型。
