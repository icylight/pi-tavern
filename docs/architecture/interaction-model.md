# PiTavern Interaction Model

本文记录 PiTavern 的交互行为模型（行为地图）。协议细节见 [websocket-protocol](../reference/websocket-protocol.md)，持久化见 [persistence](../reference/persistence.md)，群聊输入模块见 [group-chat-input](group-chat-input.md)，术语见[术语规范](../reference/terminology.md)。

## 产品形态

PiTavern 是 pi-coding-agent 的本地扩展，不提供独立可执行程序。所有进程运行在同一个本地代码仓库：

```text
Repository
├── Terminal A: pi → /tavern-new    → Group Chat Creator / User Persona
├── Terminal B: pi → /tavern-join   → Character
└── ...
```

命令：`/tavern-new`、`/tavern-resume`、`/tavern-join`、`/tavern-leave`、`/tavern-status`、`/tavern-set-max`、`/tavern-name`。

- 同一项目可同时存在多个活动群聊，各自由独立的创建者 pi 承载。
- 一个 pi 同时只能绑定一个群聊：创建者与 Character 互斥；已绑定时执行新建/恢复/加入均失败并提示先离开。
- 角色 pi 离开后移除群聊输入模块和 Character 提示词，保留并继续使用原 pi Agent 和 pi session。
- 运行期状态：`idle`、`creator`、`joining`、`character`。不定义 `disconnected`/`reconnecting`；断开直接清理并回到 `idle`。创建/恢复/加入/离开用内部 transition lock 串行保护，不增加长期业务状态。

## 群聊生命周期

### 新建群聊

- 当前 pi 创建并托管群聊，成为创建者并绑定 User Persona；`groupMaxMessages` 从 `configMaxMessages` 继承一次。
- `/tavern-new` 始终创建全新群聊，不恢复旧聊天。
- User Persona 是内置 `user` role，不使用 Markdown/配置文件/选择界面；不领取角色卡、不进入 Character 发言队列。
- 创建者复用 pi-coding-agent 原生界面（不实现独立全屏 TUI）；普通文本输入被拦截，以 User Persona 身份发送群聊消息，不触发创建者自己的 Agent 回复。
- 群聊 JSONL 中 User Persona 消息以 `pi-tavern.public-message` 保存，sender 标识 `user_persona`。

### 群聊创建者

- 创建者不拥有群聊记录；其原 pi session 暂停且保持不变，群聊消息不写入创建者 session。
- `/tavern-leave` 直接关闭整个群聊（无二次确认、不转移创建者身份）：先停止接受新请求，广播 `group_chat_closed` 后断开所有 Character WebSocket。
- `group_chat_closed` 是终止信号，不触发新 run；已在处理的对话不强制中断，但不能继续公开发言。
- 关闭后删除活动描述文件，不向群聊记录追加关闭状态；记录停留在最后一条完整消息，仍可 `/tavern-resume`。
- 群聊关闭后，创建者返回原来的普通 pi session。
- 创建者进程意外退出时群聊随之停止（无关闭广播）；强杀/崩溃/断电依靠 WebSocket close、心跳超时和活动描述发现机制收敛。

### 恢复群聊

- `/tavern-resume` 列出项目内历史群聊供选择；恢复记录与设置，当前 pi 成为新创建者并绑定 User Persona。
- 不恢复旧成员连接或角色卡领取状态；所有角色由用户手动 `/tavern-join`。
- 已活动的群聊不能重复恢复（排他创建活动描述，并发恢复只有一个 pi 成功）；群聊不永久绑定最初创建它的进程或 session。

### 群聊命名

- `/tavern-name <name>` 设置可选显示名（仅创建者可执行；Character 经 `/tavern-status` 查看）；不带参数时已有名称则显示当前名称，没有则显示用法提示。
- 名称只用于展示，内部身份始终是 `groupChatId`；允许重复、不做唯一性校验；换行替换为空格并去除首尾空白。
- 重命名作为群聊元数据持久化，不修改聊天消息。
- `/tavern-resume` 的历史删除复用 pi-coding-agent `/resume` 的删除快捷键/确认流程，优先走系统废纸篓。

### 群聊创建者界面

- 复用 pi-coding-agent 原生消息流与输入框；底部小组件只显示在线角色总数（不含 User Persona）和当前发言角色。
- `/tavern-status` 展开角色列表（含 `isStreaming` 与举手状态）及 `configMaxMessages`/`groupMaxMessages`/`roundMaxMessages`/`usedMessages`/`remainingMessages`。
- 连接、离开、举手等事件作为一次性系统通知显示。

## pi 加入群聊

流程：`/tavern-join` 自动发现活动群聊 → 选择角色卡 → `claim_character`（预留并返回角色卡路径）→ 本地读取角色卡、准备运行组件 → `character_ready` 正式加入。

- 无活动群聊时提示；多个时显示选择界面；无法连接或 PID 失效的活动描述被清理，不影响其他群聊。
- 同一角色卡在同一个群聊中同时只能由一个 pi 预留或使用（不同群聊相互独立）；已预留/在线的卡不出现在可领取列表。
- Character 预留只等待 5 秒；超时后创建者释放预留并关闭 WebSocket，加入方回到 `idle`。
- `character_ready` 成功后创建者单播 `system_message` 欢迎语（替代历史自动推送）；进入前历史不自动注入，经 `tavern_history` 工具按需分页拉取（tool result 直回上下文）；进入时刻之后的消息一条不漏（增量拉取 `fetch_messages_since`，严格区间 = 游标预置 = 进入时刻水位完成后，见 [websocket-protocol「加入」](../reference/websocket-protocol.md)）。
- `character_joined`/`character_left` 只用于界面通知，不进入 Agent 输入（成员变化不产生 Agent 输入），与是否已有公开消息无关。
- `tavern_speak` 是否被接受由当前 Round 剩余发言次数判断；`character_ready` 成功后无额外激活或等待状态，发言走正常校验（连接状态、正文大小、stale 等）。
- 群成员身份绑定加入时的 `sessionId`；PiTavern 不创建另一个 Agent session ID。
- 断线（含 Creator 断开）：角色 pi 立即退出群聊，停用 `tavern_speak` 与群聊输入模块、移除 Character system prompt；不打断进行中的 run，已提交输入不撤销。首版无自动重连/重连窗口/成员恢复；用户手动重新 join 后启用提示词和工具。断线回 `idle` 视为离开：触发模型恢复 hook 同主动离开（见 [character-model-hook](character-model-hook.md)）。
- pi 正常退出（`session_shutdown`）：先退出或关闭群聊再允许 pi 继续退出，清理最多等待 5 秒、超时后强制完成本地 WebSocket 清理。
- `/new`/`/resume`/`/fork`/`/clone` 切换 `sessionId` 前先取得用户确认；session 切换不继承群成员关系、提示词、输入模块或工具。退出一旦完成不撤销；同 session 操作不退出群聊。
- `/reload` 不属于退出流程：Creator 或 Character 通过一次性运行资源交接保持原群聊身份和 WebSocket（5 秒接管超时后释放）；`joining` 不参与交接。
- 角色卡配置 `model` 或 `thinking` 时：进入 Character 后 best-effort 应用角色 profile（model 达标后设 thinking）；正常离开（含断线回 `idle`）best-effort 按 restore mask 恢复加入前基线；失败只提示、不阻塞。详见 [character-model-hook](character-model-hook.md)。

## 群聊输入与投递

角色 pi 不为群聊创建第二个 Agent 或 session。用户终端输入与 PiTavern 群聊输入都是当前 pi Agent 的输入来源：

- 环境消息先经环境聚合再作为一次群聊输入提交（`customType: "pi-tavern.group-chat-input"`，`details` 结构化、`content` 可读投影；`triggerTurn: true`）；不逐条直接写入 pi session。
- 群聊状态由 Character 在提交环境批次前主动获取（`get_group_chat_state`），作为最新环境快照；状态响应本身不触发 Agent。
- 聚合语义：`group_chat_update` 只置未读标记（水位 + 预览不注入）；非 update 环境事件（`system_message`/`board_update`/whisper 单播）闲态 1s 固定窗口 N→1 合并（不重置计时）、忙态正文经 steer 通道工具间隙直接投递；忙态 `group_chat_update` 排隐藏打断令牌、`agent_settled` 后拉全未读重开。详见 [group-chat-input](group-chat-input.md) 与 [websocket-protocol「环境消息聚合」](../reference/websocket-protocol.md)。
- 只有 `tavern_speak` 的成功内容进入群聊记录；普通 assistant 文本、用户终端输入和本地过程不自动公开。
- Character 只向群聊创建者上报当前 pi Agent 的原生 `isStreaming` 状态；状态不向其他 Character 广播。
- 新 pi 领取同一 Character 时只能获得自己的 pi session、Character Markdown 和按需拉取的群聊记录；不能获得前一个 pi 的 session、隐藏状态、临时草稿、未公开回复或 follow-up queue。
- 首版只有 User Persona 消息可以开启公共讨论：角色不能自行开启公共回合、无公开发言 `/` 命令、不能绕过额度自主发言；额度耗尽可举手表达继续发言意图（举手不是发言）。

## WebSocket 连接

- 扩展间通过 WebSocket 传递实时消息与成员状态；创建者监听 `127.0.0.1:0`（OS 分配端口，不暴露局域网），同一机器/仓库运行，无证书或 token。
- 活动群聊在 `active/` 写入活动描述文件（`instanceId`/`groupChatId`/PID/地址/端口/启动时间）供自动发现；URL 路径携带 `groupChatId` + `instanceId`，upgrade 阶段校验后接受。
- 心跳：创建者每 30s ping，任一方连续 120s 未收到心跳即终止连接；心跳只兜底半开连接，不产生 JSON 消息或自动重连。
- 消息序号群聊内递增；公开消息以 `group_chat_update` 通知广播（水位 + 最近 3 条预览），完整增量主动拉取；断线后手动重 join，增量以本 Session 持久化游标为准（join 预置 = 进入时刻水位），服务端不维护 per-connection 已读位置。
- 细节见 [websocket-protocol](../reference/websocket-protocol.md)。

## Character Markdown

角色卡是加入期间稳定生效的 system prompt 扩展，带 YAML frontmatter（`name` + `description` 必填）的 Markdown 文件：

```markdown
---
name: Arch
description: 负责系统设计、技术决策和架构风险分析
model: anthropic/claude-sonnet-4-5
thinking: high
---

你是一名软件架构师……
```

- `name` 用于界面展示；`description` 用于角色选择器、在线列表和状态界面。
- `model`（可选）声明本角色的运行模型，格式 `provider/id`；加入群聊时自动切换、离开时恢复加入前模型；未配置或解析失败沿用默认模型（失败只提示、不阻塞加入）。
- `thinking`（可选）声明本角色的思考强度，合法 7 值 `off|minimal|low|medium|high|xhigh|max`；加入时在模型切换达标后设置（实际生效值按模型能力钳制）、离开时仅恢复「本轮配置过」的基线强度；未配置或非法只提示、不阻塞加入。
- 行为与恢复语义见 [character-model-hook](character-model-hook.md)。
- `claim_character` 预留时加载一次并缓存；`character_ready` 后在加入期间经 `before_agent_start` 对每次 run 应用同一份缓存，不随文件变化自动替换；`/reload` 会重读角色卡，读取失败时保留旧卡。
- 提示词不重复拼接到群聊输入，也不作为聊天消息写入 pi session；离开群聊时移除。
- Character 列表只发送 `name`/`description` 公开摘要，不发送正文。
- 首版只支持 PiTavern Character Markdown，不导入 SillyTavern 的 JSON/PNG/CHARX。
- 内部 `characterId` = 角色卡相对于来源配置文件的规范化路径；领取/释放/消息归属使用 `characterId` 而非显示名；导入池重复 `name` 配置无效；移动或重命名角色卡产生新身份。

## 配置

PiTavern 使用独立配置，不向 `.pi/settings.json` 添加自定义字段。`configMaxMessages` 默认 `10`，新建群聊时继承为 `groupMaxMessages`。

```text
project.configMaxMessages ?? global.configMaxMessages ?? 10
```

- 两层配置：Global `~/.pi/agent/tavern.json`、Project `<repo>/.pi/tavern.json`；合并加载（列表合并、标量项目覆盖全局）。
- `characters` 导入单个角色卡或目录（路径相对声明它的配置解析；文件=一张卡，目录=递归发现）。
- `/tavern-join` 同时展示全局与项目角色卡；任意来源重复 `name` 配置无效；首版不支持排除全局角色。
- 配置错误：无法解析/不符合 schema/角色卡读取失败或 frontmatter 非法（必填字段 `name`/`description` 缺失）→ 相关命令失败并列出具体文件，不静默跳过、不使用猜测默认值；已启动的 Runtime 继续用启动时配置，不监听文件变化。例外：可选 `model`/`thinking` 字段格式非法不导致命令失败——加载产出可传递失败状态，加入时只提示、不阻塞（见 [character-model-hook](character-model-hook.md)）。

## Tavern 对话

PiTavern 将每条公共消息和最新发言次数广播给所有已连接的角色 pi，各 pi 独立决定是否发言（不预选候选、不预留额度、不保证每个 Character 固定发言机会）。

### Round 与发言上限

每条 User Persona 消息刷新并开启一个新的讨论轮次（Round）：

- `roundMaxMessages` 是本轮 Character 公共消息总数的硬上限；只有真实 Character 公共回复消耗额度；User Persona 消息与加入/离开/断线等系统事件不消耗。
- 新 Round 从 `groupMaxMessages` 继承一次生成不可变 `roundMaxMessages`，`usedMessages` 重置为 0；已开始的生成不取消；新 Round 清除上一轮全部举手状态。
- 角色 pi 的输入模块不维护 Round、不判断 `roundId`；Tavern 按消息到达时当前 Round 的额度处理（原子处理与序号分配：`usedMessages < roundMaxMessages` 接受并广播；达到上限不进入群聊、保留在发送方私有 pi、标记举手；本轮公开发言立即停止）。

额度三级单向继承：

```text
configMaxMessages → groupMaxMessages（新建群聊时） → roundMaxMessages（新建 Round 时）
```

- `/tavern-set-max <count>` 用绝对值设置当前群聊 `groupMaxMessages`（仅创建者可执行；不支持 `+N`/`-N`）；修改不影响已开始的 Round。
- `remainingMessages = max(0, roundMaxMessages - usedMessages)`；三级修改与继承均不回溯。

### 调度与反馈

- User Persona 消息和成功的 Character 消息始终广播给所有角色 pi；发送方也收自己的广播（确认序号与最新次数），自己的消息不再次触发生成。
- Character 只有调用 `tavern_speak` 工具才会尝试公开发言；不调用即沉默。普通文本/工具调用/命令输出留在私有 session。
- 同一 Character 可在一轮中多次发言，不要求角色间平均分配。

### 举手

额度耗尽后 Character 可发送举手（Hand Raise）：

```text
Hand Raise Intent   私有，仅对应角色 pi 可见
Hand Raise Status   公共状态，只表示谁想发言
Character Message   公共消息，消耗 roundMaxMessages
```

- 举手不是发言、不消耗额度、不进入待发送队列、不赋予优先级；只是临时 UI 提醒（创建者只看到谁举手）。
- 同成员只保留一个未处理举手；刷新 Round、成功发言、主动撤回、离开群聊时清除。
- 只有用户可增加全局发言次数；普通私聊和 Agent 输出不能增加额度，系统不允许无上限的自主对话循环。

### `tavern_speak`

`tavern_speak` 是注册给 Character 的 Agent tool（不是 `/` 命令），`content` 是唯一允许尝试进入群聊的输出：

- 仅 `character_ready` 成功且 WebSocket 连接时启用；断线立即停用（断线后的调用不能公开、不产生举手），重新 join 后恢复，主动离开/群聊关闭后保持停用。
- 额度内：写入群聊、分配正式序号、广播（含发送者）；额度外：不写入、保留在私有 session、标记举手。
- 工具结果返回是否已公开、正式消息序号和最新发言次数；不调用即本次不发言。

公开回复软约束（提示词与 tool description 相同）：

```text
公开回复应简洁，通常不超过 2000 个字符。
如果完整分析较长，请把详细内容保留在当前私有 pi session，
只通过 tavern_speak 发布结论、关键理由和需要其他成员知道的信息。
```

2000 字符是软上限不是协议拒绝条件；64 KiB UTF-8 协议上限内可公开全文，PiTavern 不截断或重写。超过 64 KiB 由创建者拒绝：不公开、不消耗额度、不设举手。

## 代码协作与同步

所有 pi 使用同一工作区，PiTavern 负责沟通、不仲裁代码写入：

- 不设置写锁、不限制同时写入；每个 pi 保留自身工具权限与审批规则。
- 共享文件系统是代码状态的事实来源；群聊只同步公开发言，不同步文件读取/命令输出/逐次工具调用。
- 角色通过后续公开发言说明修改结果；PiTavern 不自动合并、回滚或解决冲突。

## 持久化

群聊记录与各个 pi session 分开保存，详见 [persistence](../reference/persistence.md)：

- 状态保存在 `~/.pi/agent/tavern/`（按项目工作目录组织）；`chats/` 存群聊 JSONL，`active/` 存活动描述；项目内 `.pi/tavern.json` 只保存配置。
- 群聊 JSONL 直接是 pi-coding-agent session 文件（首条 `SessionHeader` 的 `id`/`timestamp`/`cwd` 即群聊 ID/创建时间/项目目录），经原生 SessionManager 追加；`session_info` 存群聊名称；沿用 pi session 的 `parentId` 结构，但首版只向当前 leaf 追加，不提供群聊分支操作。
- User Persona 消息记录其 Round 继承的 `roundMaxMessages`；名称与 `groupMaxMessages` 修改作为元数据追加、恢复时重放。
- 临时状态（Hand Raise、在线成员、角色领取、follow-up queue）不写入 JSONL；`/tavern-new` 第一条 User Persona 消息到来才建立记录，空群聊关闭不留记录。
- 消息/设置变化立即保存；创建者退出后可恢复到最后一条完整消息；JSONL 不记录关闭状态。
- Character 重新领取时，输入模块重新加载 Character Markdown，并从最近消息和按需拉取的群聊记录形成后续输入。

## 参考实现

借鉴 SillyTavern「角色卡作为稳定 system prompt 而非重复拼入消息」与 pi-coding-agent 扩展能力（命令/输入拦截/界面渲染/`before_agent_start`/`followUp` 投递）；PiTavern 不实现独立 Agent、session 或消息队列。
