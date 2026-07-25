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
| PiTavern | `PiTavern` | 产品、Pi 扩展及 `/tavern-*` 命令的命名空间。 |
| 群聊 | `GroupChat` / Group Chat | `/tavern-new` 创建、`/tavern-resume` 恢复的公共聊天。 |
| 当前群聊 | Active Group Chat | 当前仓库中唯一正在运行的群聊。 |
| 群聊记录 | `ChatHistory` / Chat History | 独立于所有 Pi session 持久化的公共消息历史。 |
| 群聊创建者 | `GroupChatCreator` / Group Chat Creator | 执行 `/tavern-new` 的 Pi session；默认绑定一个代表用户的 User Persona。 |
| 用户 | `User` | 操作群聊创建者 Pi、通过 User Persona 发送公共消息的人。 |
| 用户 Persona | `UserPersona` / User Persona | 用户在群聊中的公开身份；默认绑定到群聊创建者，不属于 Character。 |
| 角色 | `Character` | 由角色卡定义的身份，不等同于某个 Pi 进程。 |
| 角色卡 | `CharacterCard` / Character Card | 使用 Markdown 定义角色提示词的文件。 |
| 群成员 | `GroupMember` / Group Member | 通过 User Persona 或 Character 身份参与当前群聊的 Pi。 |
| 私聊 | `PrivateChat` / Private Chat | 用户在某个角色 Pi 中与该角色进行的非公开对话。 |
| Pi session | `PiSession` / Pi Session | 每个 Pi 独立持久化的会话；不是群聊记录。 |
| 公共事件 | `PublicEvent` / Public Event | 从群聊同步到角色 Pi session 的公共消息或状态事件。 |

## 使用规则

- `PiTavern` 或“酒馆”只表示产品和交互隐喻，不表示群聊实体。
- 产品文案可以使用“进入酒馆”这类自然表达，需求和代码必须使用“加入群聊”。
- 不使用“房间”或 `Room` 表示群聊。
- `/tavern-new` 表示新建群聊。
- `/tavern-resume` 表示恢复历史群聊。
- `/tavern-join` 表示加入当前群聊并成为群成员。
- 群聊创建者默认以 User Persona 成为群成员；其他 Pi 加入群聊时领取 Character。
- User Persona 表示用户身份，Character 表示 Agent 角色，两者不混用。
- 角色 Pi 执行 `/tavern-leave` 表示退出群聊；群聊创建者执行该命令表示关闭当前群聊。
- “角色”描述身份，“群成员”描述已连接并领取该身份的 Pi，不混用。
- “私聊”描述用户与角色的对话，“Pi session”描述承载并保存该私聊的技术会话，不混用。
- 首版不引入独立的 `Group` 实体，避免与 `GroupChat` 形成无实际用途的两层模型。
