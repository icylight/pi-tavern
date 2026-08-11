# PiTavern Extension Architecture

> 状态：已定稿。本文记录 PiTavern 首版 Extension Runtime 的技术结构。

PiTavern 作为 pi-coding-agent 扩展实现。技术设计以 `references/pi` 中的当前实现为准。

## 源码顶层模块

首版源码使用以下顶层结构：

```text
src/
├── index.ts
├── controller/
├── creator/
├── character/
├── protocol/
├── persistence/
├── discovery/
├── config/
└── ui/
```

- `index.ts` 是 pi `ExtensionFactory` 入口和组合根，只负责创建顶层对象并注册 pi 命令、事件、工具及 renderer；
- `controller/` 实现 `TavernController`、顶层状态转换和 transition lock；
- `creator/` 实现 `CreatorRuntime`、`GroupChatState`、群聊服务端与创建者侧消息处理；
- `character/` 实现 `JoinAttempt`、`CharacterRuntime`、Character prompt 和群聊输入接入；
- `protocol/` 定义、解析和校验 PiTavern WebSocket JSON；
- `persistence/` 负责可恢复的群聊 session 记录及其读写；
- `discovery/` 负责活动实例描述的发布、枚举、清理以及 PID 和 WebSocket 身份校验；
- `config/` 负责全局与项目 PiTavern 配置、Character Markdown 发现和加载；
- `ui/` 负责 Presenter、view model 及 pi TUI renderer。

`discovery/` 不并入 `persistence/`。活动描述是当前进程的临时发现信息，不属于可恢复的群聊记录；发现过程还包含进程与实际 WebSocket 身份校验，不是单纯的文件存储。

首版不建立顶层 `types/`、`shared/` 或同类公共模块。类型跟随其权威模块定义，并由使用方直接导入：

- WebSocket JSON 类型归 `protocol/`；
- `GroupChatState` 归 `creator/`；
- Character Markdown 解析结果归 `config/`；
- 群聊 session entry 类型归 `persistence/`；
- TUI view model 归 `ui/`。

只有出现无法归属于现有权威模块、并且已经被多个模块稳定复用的实现后，才重新讨论公共模块，不能为可能的未来复用预先建立。

跨 reload 的资源载荷由原资源模块定义：

- `creator/` 定义 `CreatorReloadHandoff`；
- `character/` 定义 `CharacterReloadHandoff`；
- `controller/reload-handoff-registry.ts` 定义两类载荷的一次性进程内 registry，并负责发布、按当前 pi session ID 取回和超时清理。

pi 在 `/reload` 时清除 Extension loader 缓存，并以禁用 module cache 的方式重新加载扩展源码，因此普通模块级变量不能作为跨 reload 的 handoff 存储。registry 使用 `globalThis` 上的 PiTavern 私有 `Symbol.for(...)` key 保存一次性槽位，使重新加载后的扩展代码可以取得旧 Runtime 发布的底层资源。

该全局槽位只能短期保存带 5 秒期限的 `CreatorReloadHandoff` 或 `CharacterReloadHandoff`，不能保存 `TavernController`、`CreatorRuntime`、`CharacterRuntime`、pi API 或 UI context。`take()`、不匹配和超时后的清理继续遵循本文的一次性所有权规则；这不是进程级全局 Controller。

源码目录遵循“按已经存在的职责拆文件、尽可能保持扁平”的原则。首版不建立只有一层实现的 `server/`、`service/`、`repository/` 等包装目录。

`creator/` 固定为：

```text
creator/
├── creator-runtime.ts
├── group-chat-state.ts
└── creator-reload-handoff.ts
```

- `creator-runtime.ts` 实现 WebSocket Server、连接处理、Runtime 任务队列、消息提交、广播和关闭；
- `group-chat-state.ts` 定义唯一权威状态及其纯状态操作；
- `creator-reload-handoff.ts` 定义 Creator reload 载荷及资源接管辅助。

WebSocket Server 和群聊 `SessionManager` 继续由 `CreatorRuntime` 直接持有，不为了目录形式额外拆出 server、service 或 repository 对象。

`character/` 固定为：

```text
character/
├── character-runtime.ts
├── join-attempt.ts
├── group-chat-input.ts
└── character-reload-handoff.ts
```

- `character-runtime.ts` 实现 Character WebSocket、状态上报、心跳、发言请求和关闭；
- `join-attempt.ts` 实现三阶段加入和 WebSocket 所有权转交；
- `group-chat-input.ts` 实现群聊环境事件聚合（#64 pull 模型：`group_chat_update` 纯标记、非 update 批次 1s 合并、闲态固定 1s 窗口并入不重置、忙态 settle 触发）、拉取最新群聊状态，以及生成并提交 `pi-tavern.group-chat-input`；
- `character-reload-handoff.ts` 定义 Character reload 载荷及资源接管辅助。

群聊输入已经是边界明确的另一种 pi Agent 输入来源，因此独立成文件，但不建立子目录。Character prompt 注入逻辑首版保留在 `character-runtime.ts`，不为少量接线预先拆出文件。

`protocol/` 固定为：

```text
protocol/
├── messages.ts
└── codec.ts
```

- `messages.ts` 定义全部 WebSocket wire message、公共结构和可辨识联合类型；
- `codec.ts` 负责 JSON 解析、运行时校验、协议错误归一化和编码。

协议 schema 使用与 `references/pi` 一致的 TypeBox：

- `messages.ts` 使用 `Type.Object()` 等 schema 定义 wire message；
- TypeScript 类型通过 `Static<typeof Schema>` 从 schema 推导，不再手写一份重复接口；
- `codec.ts` 使用 `typebox/compile` 的 `Compile()` 构建运行时 validator；
- `tavern_speak` 的 pi tool 参数复用同一个 TypeBox 依赖。

首版不引入第二个 schema 库，也不为 WebSocket JSON 手写另一套类型守卫。

首版不按 join、history、state 或 speak 再建立消息子目录。请求 `id` 与本地 Promise 的关联属于 `JoinAttempt` 或 `CharacterRuntime` 的连接运行逻辑，不进入无连接状态的 `protocol/`。

`persistence/` 固定为：

```text
persistence/
├── entries.ts
└── group-chat-session.ts
```

- `entries.ts` 定义群聊 session header、公开消息和设置 entry 的结构、解析及转换；
- `group-chat-session.ts` 基于 pi 原生 `SessionManager` 实现新建、恢复、列表、删除、追加消息、状态重建和历史读取。

首版不创建 `GroupChatRepository` 或第二套 session 类。`CreatorRuntime` 继续直接持有 pi `SessionManager`；`group-chat-session.ts` 只提供围绕该对象的函数。

`controller/` 固定为：

```text
controller/
├── tavern-controller.ts
├── pi-runtime-bindings.ts
└── reload-handoff-registry.ts
```

- `tavern-controller.ts` 定义顶层状态、transition lock 和命令路由；
- `pi-runtime-bindings.ts` 封装当前 Extension Runtime 的 pi API、session ID 和 UI context 生命周期；
- `reload-handoff-registry.ts` 实现前文确定的进程内一次性 reload 槽位。

`config/` 固定为：

```text
config/
├── load-config.ts
└── character-card.ts
```

- `load-config.ts` 读取并合并全局与项目 `tavern.json`；
- `character-card.ts` 发现、读取、解析和校验 Character Markdown。

首版不创建 `ConfigManager`。新建群聊或加入流程按需要读取配置；已经启动的 Runtime 继续使用启动时取得的配置快照，不建立配置文件 watcher。

`discovery/` 固定为：

```text
discovery/
├── active-descriptor.ts
└── discover-group-chats.ts
```

- `active-descriptor.ts` 定义描述结构和路径，负责一次性写入、读取及所有者删除；
- `discover-group-chats.ts` 枚举候选描述、检查 PID、通过实际 WebSocket 地址验证实例身份、清理失效描述并返回可加入列表。

PID 检查只用于快速排除失效候选，实际 WebSocket 地址和实例身份校验仍是发现结果的最终判断。

`ui/` 固定为：

```text
ui/
├── tavern-presenter.ts
└── renderers.ts
```

- `tavern-presenter.ts` 从权威状态或最近状态快照生成并更新 status、widget 和通知；
- `renderers.ts` 同时注册 `pi-tavern.creator-display` entry renderer 与 `pi-tavern.group-chat-input` message renderer。

两个 renderer 都是无状态纯函数，首版不为每个 `customType` 单独建立文件。

pi 接线使用 `src/` 根部的两个扁平文件：

```text
src/
├── index.ts
├── commands.ts
└── events.ts
```

- `index.ts` 只创建顶层对象，并调用命令、事件、tool 和 renderer 注册函数；
- `commands.ts` 注册七个 `/tavern-*` 命令；
- `events.ts` 注册 session、input 和 Agent 生命周期事件。

`tavern_speak` 的注册函数放在 `character/tavern-speak-tool.ts`，因为该工具只服务 `CharacterRuntime`；tool execute 仍通过 Controller 校验当前状态并找到 Runtime。

首版不建立 `utils/`。路径、解析和转换函数放在拥有对应语义的模块；超时常量放在实际定义该约定的模块；串行队列先作为对应 Runtime 的内部实现。只有形成多个模块稳定复用且无法合理归属的代码后，才重新讨论提取。

首版测试与源码分开：

```text
test/
├── protocol/
├── persistence/
├── discovery/
├── creator/
└── character/
```

不在 `src/` 旁放置 `*.test.ts`。自动化集成测试的每个测试或 worker 使用独立的临时 `PI_CODING_AGENT_DIR`；同一个多人群聊用例中的多个 pi 共享该用例自己的临时目录。

目前确定的完整首版结构为：

```text
src/
├── index.ts
├── commands.ts
├── events.ts
├── controller/
│   ├── tavern-controller.ts
│   ├── pi-runtime-bindings.ts
│   └── reload-handoff-registry.ts
├── creator/
│   ├── creator-runtime.ts
│   ├── group-chat-state.ts
│   └── creator-reload-handoff.ts
├── character/
│   ├── character-runtime.ts
│   ├── join-attempt.ts
│   ├── group-chat-input.ts
│   ├── tavern-speak-tool.ts
│   └── character-reload-handoff.ts
├── protocol/
│   ├── messages.ts
│   └── codec.ts
├── persistence/
│   ├── entries.ts
│   └── group-chat-session.ts
├── discovery/
│   ├── active-descriptor.ts
│   └── discover-group-chats.ts
├── config/
│   ├── load-config.ts
│   └── character-card.ts
└── ui/
    ├── tavern-presenter.ts
    └── renderers.ts

test/
├── protocol/
├── persistence/
├── discovery/
├── creator/
└── character/
```

本节固定首版目录和文件边界。文件内部的函数、类和辅助类型继续按照已确认职责实现，不再为尚未出现的复用预先增加层级。

## 已确认

首版采用以下顶层结构：

```text
PiTavern Extension
└── TavernController
    ├── idle
    ├── CreatorRuntime
    └── CharacterRuntime
```

- `TavernController` 统一表示一个 pi 进程中当前的 PiTavern 状态。
- `CreatorRuntime` 对应当前 pi 创建群聊后的运行期。
- `CharacterRuntime` 对应当前 pi 领取 Character 并加入群聊后的运行期。
- `joining` 是短暂状态，不是第三种稳定 Runtime。
- `CreatorRuntime` 和 `CharacterRuntime` 不会同时存在。

### `TavernController` 职责

`TavernController` 保持为轻量的状态入口，只负责：

- 持有当前 PiTavern 状态；
- 串行执行状态转换；
- 根据当前状态将命令转交给对应 Runtime。

状态结构采用可辨识联合表达：

```ts
type TavernState =
  | { type: "idle" }
  | { type: "joining"; attempt: JoinAttempt }
  | { type: "creator"; runtime: CreatorRuntime }
  | { type: "character"; runtime: CharacterRuntime };
```

`TavernController` 不负责 WebSocket 收发、群聊记录持久化、Character 提示词、消息防抖或 TUI 展示细节：WebSocket 收发归各 Runtime 的连接管理（`CharacterRuntime` / 创建者连接处理），群聊记录持久化归 `group-chat-sessions.ts`（见 reference/persistence.md），Character 提示词与群聊环境事件聚合归 `character-runtime.ts` / `group-chat-input.ts`，TUI 展示归 `src/ui/`（见本文「TUI 投影设计」节）。

### `JoinAttempt`

`joining` 是临时业务状态，其加入过程资源由专门的 `JoinAttempt` 对象管理。

`JoinAttempt` 负责：

- 持有加入期间已经建立的 WebSocket；
- 持有服务端返回的可领取 Character 列表；
- 发送 `claim_character` 请求并接收结果；
- 读取并验证预留 Character 的 Markdown；
- 构造尚未激活的 `CharacterRuntime`；
- 发送 `character_ready` 并接收结果；
- 处理用户取消、连接断开和加入失败后的清理。

领取 Character 发生业务冲突时，保留 `JoinAttempt` 并继续处于 `joining`。用户取消、连接断开或放弃加入时，释放 `JoinAttempt` 并回到 `idle`。

`claim_character` 成功只表示 Character 已由当前连接预留，Controller 仍处于 `joining`。`JoinAttempt` 使用返回的本机路径读取角色卡，并准备 `CharacterRuntime`，但此时不启用 Character prompt、群聊输入模块或 `tavern_speak`。

本地准备成功后，`JoinAttempt` 发送 `character_ready`。服务端确认正式加入后，复用当前 WebSocket，不重新连接；`JoinAttempt` 将连接所有权一次性转交给已经准备好的 `CharacterRuntime`，转交后不再读取、写入或关闭该连接，Controller 随后进入 `character`。

`JoinAttempt` 不注入 Character prompt、不向 Agent 提交群聊输入、不启用 `tavern_speak`，也不负责加入群聊后的消息防抖和状态同步。

### `CreatorRuntime`

首版由 `CreatorRuntime` 直接持有：

- WebSocket Server；
- 用于群聊记录持久化的独立 pi `SessionManager`。
- 一个独立定义的 `GroupChatState`。

群聊 `SessionManager` 与群聊创建者当前的私有 pi session 分开。首版不为 WebSocket Server 或群聊持久化预先拆分独立服务对象，后续只有在职责或测试复杂度确实需要时再考虑拆分。

在线 Character、当前 Round、消息额度和举手状态等群聊状态统一放在 `GroupChatState` 中，不作为互不关联的字段散落在 `CreatorRuntime` 上。

`GroupChatState` 是群聊创建者侧唯一的权威内存状态。WebSocket 协议响应、群聊广播和创建者 TUI 都从该状态生成，不各自维护可变的群聊状态副本。

`GroupChatState` 只表示群聊状态，不持有 WebSocket Server、`SessionManager`、计时器或文件句柄等运行资源：

```ts
interface GroupChatState {
  groupChat: GroupChatInfo;
  round: RoundState | null;
  characterReservations: Map<string, string>;
  onlineCharacters: Map<string, OnlineCharacterState>;
}

interface GroupChatInfo {
  groupChatId: string;
  name: string | null;
  createdAt: string;
  groupMaxMessages: number;
}

interface RoundState {
  roundMaxMessages: number;
  usedMessages: number;
}

interface OnlineCharacterState {
  sessionId: string;
  character: CharacterSummary;
  isStreaming: boolean;
  handRaised: boolean;
}

interface CharacterSummary {
  characterId: string;
  name: string;
  description: string;
}
```

内部 TypeScript 字段沿用 pi-coding-agent 风格使用 `camelCase`。只有转换为 PiTavern 自定义 JSON 时才使用 `snake_case`。

`onlineCharacters` 使用当前 pi `sessionId` 作为 Map key。`sessionId` 是创建者运行期用于识别成员连接的私有字段，不进入公开的在线 Character 摘要。

`characterReservations` 使用 `characterId` 作为 Map key、预留连接的当前 pi `sessionId` 作为 value。预留只存在于当前活动实例，不持久化、不进入 `get_group_chat_state`，恢复群聊时从空 Map 开始。可领取 Character 列表排除已经预留或已经在线的 Character。

`get_group_chat_state` 是从 `GroupChatState` 生成的请求方相关快照：

- `is_self` 不存入状态，根据请求连接对应的 `sessionId` 动态计算；
- `remaining_messages` 不存入状态，由 `roundMaxMessages - usedMessages` 计算，最小为 `0`；
- `round` 为 `null` 表示群聊还没有第一条 User Persona 消息；
- 输出协议时将内部字段转换为 `snake_case`。

首版不因其他尚未讨论的用途提前加入历史消息计数等字段。

### 在线连接与 Character 绑定

完成 `character_ready` 的在线成员使用当前 pi `sessionId` 同时索引连接资源和群聊状态：

```ts
class CreatorRuntime {
  connections: Map<string, WebSocket>;
  state: GroupChatState;
}
```

```text
sessionId
├── connections → WebSocket
└── onlineCharacters → OnlineCharacterState → CharacterSummary
```

对已经完成加入的在线成员，必须保持以下约束：

```text
connections.keys() == state.onlineCharacters.keys()
```

连接对象不重复保存 Character。收到某个在线连接的请求时，`CreatorRuntime` 先确定该连接绑定的 `sessionId`，再从 `onlineCharacters` 取得对应 Character。

因此 `tavern_speak`、运行状态上报和离开请求不接受客户端重复提交的 `character_id`，发送者身份以创建者保存的连接绑定为准。

尚未完成 `character_ready` 的连接不进入 `connections` 或 `onlineCharacters`。它只由 WebSocket connection handler 的闭包暂存：

```ts
webSocketServer.on("connection", (socket) => {
  let sessionId: string | undefined;
  let reservedCharacterId: string | undefined;
  let online = false;

  // join_group_chat、claim_character 和 character_ready
  // 共用该连接闭包。
});
```

`sessionId` 和 `reservedCharacterId` 不能定义在单次消息处理函数中，因为三阶段加入发生在同一连接上的多条独立消息。

`claim_character` 成功时只向 `characterReservations` 写入预留，不进入 `connections` 或 `onlineCharacters`。`character_ready` 成功时原子删除预留（原子：删除预留与写入连接、在线状态作为一个整体一次完成，不出现中间可见态），并将连接和 Character 写入 `connections` 与 `onlineCharacters`。

连接在正式加入前关闭时，从 `characterReservations` 释放对应预留，不广播 `character_left`。首版仍不为连接定义 `PendingConnection`、临时连接 Map 或额外 Runtime 状态。

每次成功预留都立即启动 5 秒 `character_ready` 超时计时。超时前仍未正式加入时，创建者先从 `characterReservations` 释放预留，再关闭对应 WebSocket。计时器属于对应 WebSocket connection handler 的闭包资源，不放入 `GroupChatState`。

加入方因该连接关闭而释放 `JoinAttempt` 并直接回到 `idle`，不增加超时后的中间状态。

### 创建与恢复入口

创建新群聊和恢复已有群聊使用两个明确的公开入口：

```ts
class CreatorRuntime {
  static async startNew(/* ... */): Promise<CreatorRuntime>;
  static async resume(/* ... */): Promise<CreatorRuntime>;

  private constructor(/* 已准备完成的状态和资源 */) {}
}
```

`startNew` 负责：

- 生成新的 `groupChatId` 和 `createdAt`；
- 将当前 `configMaxMessages` 复制为初始 `groupMaxMessages`；
- 创建 `round: null`、空 `characterReservations`、空 `onlineCharacters` 的 `GroupChatState`；
- 创建尚未写入群聊记录文件的内存 pi `SessionManager`。

`resume` 负责：

- 打开已有群聊 session JSONL；
- 从记录重建群聊基础信息、`groupMaxMessages` 和当前 Round；
- 使用空 `characterReservations` 和空 `onlineCharacters` 启动新的活动实例。

两条路径可以在各自完成初始化后调用同一个私有构造函数，但不合并为带创建/恢复条件分支的公开初始化入口。

pi 原生 `SessionManager.create()` 可以在不立即创建 session 文件的情况下先建立内存 session 和预定文件路径，因此新群聊从创建时即可持有 `SessionManager`，同时保持第一条 User Persona 消息前没有群聊记录文件。

第一条 User Persona 消息立即触发群聊专用 session 的首次落盘，不等待 Character 或任何 LLM 回复。首次落盘按照 [persistence.md](../reference/persistence.md) 已经确定的 `empty → started` 流程执行。

### 创建者 TUI 消息投影

群聊消息完整写入群聊专用 session，该 session 仍是群聊记录的唯一权威来源。

为了复用 pi 的主 TUI 对话区域，创建者侧同时将群聊消息以 pi 原生 `custom` entry 投影到创建者当前的私有 pi session，并为该 entry 注册对应的 TUI renderer。

该投影：

- 会保存在创建者私有 session JSONL；
- 只用于创建者 TUI 展示；
- 不参与 pi 的 LLM context 构建；
- 不触发创建者 LLM；
- 不是群聊记录的权威来源；
- 不用于恢复群聊状态或补齐群聊历史。

首版接受这份展示投影与群聊权威记录之间的数据重复，以换取 pi 原生 TUI 展示和更简单的实现。

群聊专用 session 的持久化成功是消息成立点。创建者侧处理消息时遵循：

```text
持久化群聊权威记录
  ↓ 成功
更新 GroupChatState
  ↓
写入创建者 TUI 展示投影
```

第一条 User Persona 消息只有在持久化成功后，才能将 `GroupChatState.round` 从 `null` 更新为当前 Round。因而 `round !== null` 表示群聊已经至少成功持久化一条 User Persona 消息。

完成权威记录持久化和 `GroupChatState` 更新后，本地 TUI 投影与 WebSocket 广播作为两个相互独立的后续动作执行：

```text
持久化成功
  ↓
更新 GroupChatState
  ├── 本地 TUI 投影
  └── WebSocket 广播
```

二者互不作为对方成功的前提，也不因一方失败而取消另一方。TUI 投影失败时不撤销已经提交的群聊消息，创建者界面应显示投影失败提示。WebSocket 发送失败也不撤销消息，并按照已经确认的连接断开规则清理对应 Character。

具体 `customType`、entry 数据结构和 renderer 见本文的 TUI 投影设计。

### `CharacterRuntime`

`CharacterRuntime` 是当前 pi Extension Runtime 内的组件，不是独立客户端进程、子 Agent 或第二个 session。它接入并使用当前 pi 的 Agent、session 和原生消息队列。

首版直接持有：

```ts
interface CharacterRuntime {
  groupChatId: string;
  sessionId: string;

  socket: WebSocket;
  character: LoadedCharacter;

  pendingEvents: GroupChatEnvironmentEvent[];
  debounceTimer: NodeJS.Timeout | null;
  heartbeatTimer: NodeJS.Timeout;

  disposed: boolean;
}

interface LoadedCharacter {
  characterId: string;
  name: string;
  description: string;
  path: string;
  prompt: string;
}
```

- `socket` 在 `character_ready` 成功后从 `JoinAttempt` 接收所有权；
- `character` 是领取后读取一次并缓存在内存中的 Character Markdown 结果；
- `pendingEvents` 和 `debounceTimer` 管理群聊环境事件聚合（#64：闲态固定 1s 窗口并入不重置，忙态排隐藏令牌 settle 后触发；非 update 批次 1s 合并）；
- `heartbeatTimer` 检测群聊创建者心跳超时；
- `disposed` 供异步回调确认当前 Runtime 是否已经失效。

`CharacterRuntime` 不持有独立 Agent、独立 pi session、`SessionManager`、自行实现的 follow-up queue、群聊权威状态或自动重连状态。

防抖完成的群聊输入使用当前 pi 原生消息接口提交：

```ts
pi.sendMessage(message, {
  triggerTurn: true,
  deliverAs: "followUp",
});
```

Character system prompt、Agent 生命周期和工具由 Extension 入口接线。`CharacterRuntime` 只提供缓存的 prompt、当前连接和相应运行状态，不自行注册生命周期 hook。

### `tavern_speak` 启停

Extension Factory 在加载 PiTavern 时注册一次 `tavern_speak` tool，但该工具在 `idle`、`joining` 和 `creator` 状态下不属于 active tools。

`character_ready` 成功并准备提交到 `character` 状态时，使用 pi 原生 `getActiveTools()` 和 `setActiveTools()` 将 `tavern_speak` 增量加入当前 active tools：

```ts
const activeTools = new Set(pi.getActiveTools());
activeTools.add("tavern_speak");
pi.setActiveTools([...activeTools]);
```

主动离开、WebSocket 断开、心跳超时、群聊关闭、pi session 切换或非 reload 的 Extension Runtime 清理时，只从当时的 active tools 中移除 `tavern_speak`：

```ts
pi.setActiveTools(
  pi.getActiveTools().filter((toolName) => toolName !== "tavern_speak"),
);
```

PiTavern 不保存并恢复一份加入前的完整 active tools 快照，避免覆盖加入期间由用户、pi 或其他扩展作出的工具变更。

`tavern_speak` 的执行函数仍必须再次校验 Controller 当前处于 `character`、当前 `CharacterRuntime` 尚未失效且 WebSocket 仍然连接。active tools 只控制工具对 Agent 的可见性，不作为连接有效性的唯一判断。

### pi session 操作

Extension 通过 `session_before_switch` 处理 `/new` 和 `/resume`，通过 `session_before_fork` 处理 `/fork` 和 `/clone`。pi 的 `/clone` 复用 fork 流程，不需要 PiTavern 增加单独的 clone 生命周期 hook。

当前状态为 `idle` 时直接允许操作。当前状态为 `joining`、`creator` 或 `character` 时，先通过当前有效的 pi UI context 请求用户确认是否退出群聊并继续：

- 取消确认：返回 `cancel: true`，保持当前 PiTavern 状态；
- 确认继续：先完成对应退出并提交到 `idle`，再返回 `cancel: false`。

退出语义：

- `joining`：关闭连接，释放可能存在的 Character 预留并释放 `JoinAttempt`；
- `character`：执行正常离开并清理 `CharacterRuntime`；
- `creator`：关闭整个群聊并清理 `CreatorRuntime`。

退出与后续 pi session 操作互不绑定，退出一旦完成即不回退。PiTavern 提交到 `idle` 后，即使后续 `/new`、`/resume`、`/fork` 或 `/clone` 失败、被取消或没有实际完成，也不恢复之前的 Runtime、不重新创建群聊、不重新加入群聊。

### pi Runtime bindings

每次 Extension Factory 加载时创建一份只属于当前 Extension Runtime 的 `PiRuntimeBindings`。WebSocket handler、计时器和其他后台回调不得直接捕获 `ExtensionAPI`，也不得长期保存并直接调用 command/event context。

```ts
class PiRuntimeBindings {
  private lifecycle: "unbound" | "active" | "invalid" = "unbound";
  private piSessionId: string | null = null;
  private ui: ExtensionUIContext | null = null;

  constructor(readonly pi: ExtensionAPI) {}

  bindSession(
    piSessionId: string,
    ui: ExtensionUIContext,
  ): void {
    if (this.lifecycle !== "unbound") {
      throw new Error("Pi runtime bindings have already been bound");
    }

    this.piSessionId = piSessionId;
    this.ui = ui;
    this.lifecycle = "active";
  }

  assertActive(): void {
    if (this.lifecycle !== "active") {
      throw new Error("Pi runtime bindings are no longer active");
    }
  }

  invalidate(): void {
    this.lifecycle = "invalid";
    this.piSessionId = null;
    this.ui = null;
  }
}
```

Factory 创建 bindings 时只保存本次 Extension Runtime 的 `ExtensionAPI`。收到 `session_start` 后，使用 `ctx.sessionManager.getSessionId()` 取得当前 pi session ID，并把该 ID 与当前 UI context 一次性绑定；在此之前后台 Runtime 尚未启动，不能调用 session-bound pi API。

Runtime 中所有面向 pi 的操作通过当前 bindings 执行，包括：

- `pi.sendMessage()`；
- `getActiveTools()` 和 `setActiveTools()`；
- TUI notify、status 和 widget 更新；
- 其他依赖当前 Extension Runtime 的 pi API。

`ReloadHandoff` 不保存旧 bindings。只有 handoff 中的 `piSessionId` 与当前 pi session 一致时，新 Runtime 才能使用新 Extension Factory 创建的 bindings 接管底层资源。`/new`、`/resume`、`/fork` 或 `/clone` 后的旧 Runtime 永远不能重新绑定到新 session。

### Runtime 内部生命周期

CreatorRuntime 和 CharacterRuntime 使用内部生命周期保护后台回调：

```ts
type RuntimeLifecycle = "active" | "detaching" | "disposed";
```

该生命周期只是实现期资源状态，不进入 `TavernState`，也不向用户展示：

- `active`：正常处理 WebSocket、计时器和 pi 操作；
- `detaching`：正在为 reload 交接，新 frame 进入 handoff buffer，不再启动新的 pi 操作；
- `disposed`：Runtime 已经失效，后台回调立即结束。

后台异步操作在开始时和每个 `await` 恢复后都必须重新确认生命周期及 generation：

```ts
const generation = runtime.generation;
const result = await operation();

if (
  runtime.lifecycle !== "active" ||
  runtime.generation !== generation
) {
  return;
}
```

不得通过可变的进程级 `currentPi` 把旧 Runtime 回调路由给最新 pi API，因为这可能将旧群聊事件写入已经切换的新 session。

### Runtime 任务串行化

每个 Runtime 使用内部串行任务队列处理 WebSocket frame 和群聊状态修改：

```ts
socket.on("message", (frame) => {
  runtimeQueue.enqueue(() => handleFrame(frame));
});
```

Creator 的发言额度检查、权威记录持久化、`GroupChatState` 更新和广播提交必须按照 frame 到达顺序通过该队列执行。

Runtime 任务队列与 pi follow-up queue 是两套不同职责：

- Runtime 队列串行处理 WebSocket 协议和群聊状态；
- pi follow-up queue 管理当前 Character Agent 的输入。

reload detach 时，旧 Runtime 先进入 `detaching`，新 frame 转入 handoff buffer，再等待当前 Runtime 任务完成。等待最多使用 5 秒通用短期协调超时。随后停止计时器、移除旧 handler、使 bindings 失效并发布 handoff。

等待超时时，取消仍可取消的任务；已经完成权威记录持久化的公开消息不撤销。超时后的旧任务不得再调用 pi API 或继续修改已交接状态。

新 Runtime 使用新的 bindings 和代码恢复队列，将 handoff buffer 按接收顺序先入队，再开放 live frame dispatch 并进入 `active`。普通离开、quit 和 pi session 切换则进入 `disposed`，不允许交接或重新绑定。

### Runtime 统一清理接口

CreatorRuntime 和 CharacterRuntime 只暴露两个终止入口：

```ts
interface ManagedRuntime<Handoff> {
  close(reason: RuntimeCloseReason): Promise<RuntimeCloseResult>;
  detachForReload(): Promise<Handoff>;
}

interface RuntimeCloseResult {
  timedOut: boolean;
  errors: Error[];
}

type RuntimeCloseReason =
  | "user_leave"
  | "session_change"
  | "quit"
  | "socket_closed"
  | "heartbeat_timeout"
  | "group_chat_closed"
  | "reload_timeout"
  | "initialization_failed";
```

- `close()` 永久结束当前 Runtime，资源不能恢复，Controller 最终进入 `idle`；
- `detachForReload()` 只用于 reload，把资源转移到 handoff，不执行永久关闭；
- 两条路径不能同时成功。

`close()` 必须幂等。Runtime 保存第一次关闭创建的 Promise，后续关闭调用返回同一个 Promise，不重复发送离开、广播、释放 Character 或关闭资源：

```ts
close(reason: RuntimeCloseReason): Promise<RuntimeCloseResult> {
  this.closePromise ??= this.performClose(reason);
  return this.closePromise;
}
```

单个清理步骤失败时记录到 `errors` 并继续后续步骤，不把半失效 Runtime 留在原业务状态。Controller 在清理结束后无论是否超时或包含错误都提交到 `idle`；有 UI 时显示清理警告。

CharacterRuntime 的永久关闭顺序：

1. 将内部 lifecycle 置为 `disposed` 并递增 generation；
2. 禁止 Runtime 队列接收新任务；
3. 移除 `tavern_speak`，停用 Character prompt 和群聊输入模块；
4. 停止防抖和心跳计时器，取消尚未开始的后台任务；
5. 根据关闭原因尽力发送 `leave_group_chat`；
6. 关闭 WebSocket，移除 handler；
7. 丢弃尚未提交的 `pendingEvents`；
8. 使 `PiRuntimeBindings` 失效。

`user_leave`、`session_change` 和 `quit` 尽力发送 `leave_group_chat`。`socket_closed`、`heartbeat_timeout`、`group_chat_closed` 和 `reload_timeout` 不等待离开响应，直接执行本地清理。离开流程本身不 abort 当前 Agent run，已经提交给 pi session 或 follow-up queue 的内容继续由 pi 管理。

公共群消息的忙态投递遵循 ADR-0008：`GroupChatInput` 只维护未读与令牌单飞行状态，群消息正文不进入 steer；`agent-lifecycle` 的 context 钩子过滤 `pi-tavern.abort-control`，并仅在当前输入实例仍待打断时调用 `ctx.abort()`。settled 后由 `GroupChatInput` 按 Session 游标拉全，通过 followUp 重开。该依赖保持窄接口：生命周期接线只调用输入实例的令牌消费方法，不持有消息拉取或游标实现。

CreatorRuntime 的永久关闭顺序：

1. 将内部 lifecycle 置为 `disposed` 并递增 generation；
2. WebSocket Server 停止接受新连接，Runtime 队列停止接收新任务；
3. 等待当前任务完成，最多 5 秒；
4. 释放全部 Character 预留；
5. 尽力广播 `group_chat_closed`；
6. 关闭全部成员 WebSocket 和 WebSocket Server；
7. 停止心跳及其他计时器；
8. 删除活动描述；
9. 释放连接表和运行期 `GroupChatState`；
10. 使 `PiRuntimeBindings` 失效。

等待当前任务超时时，取消仍可取消的任务；已经成功持久化的公开消息不撤销，随后继续关闭群聊。群聊 session 文件保留，不追加结束 entry。

`detachForReload()` 不调用普通 `close()`。它把 lifecycle 置为 `detaching`，停止 live dispatch，等待当前任务最多 5 秒，移除旧 handler 和计时器，再把仍需保留的资源移动到 `ReloadHandoff`。WebSocket、Character、活动描述、未提交环境事件等资源按照前文 handoff 规则保留。

### 一次性资源所有权

`ReloadHandoff` 使用一次性 `take()` 模拟资源 move：

```ts
class ReloadHandoff<T> {
  private payload: T | null;

  take(): T {
    if (!this.payload) {
      throw new Error("Reload handoff has already been consumed");
    }

    const payload = this.payload;
    this.payload = null;
    return payload;
  }
}
```

- `take()` 只能成功一次；
- 旧 Runtime 交接后清空自己的资源引用；
- 新 Runtime 接管后 handoff 不再拥有资源；
- 5 秒超时只有 handoff 仍持有资源时才能执行超时清理。

`JoinAttempt` 同样提供幂等 `close(reason)` 和一次性 `takeConnection()`：

- `close()` 后不能再转交连接；
- `takeConnection()` 后，`JoinAttempt.close()` 不能关闭已经交给 CharacterRuntime 的 WebSocket；
- Character 预留最多释放一次。

Controller 不直接关闭具体 WebSocket、timer 或 listener，只通过 `runtime.close(reason)`、`runtime.detachForReload()` 和 `JoinAttempt` 的所有权接口执行顶层状态转换。transition lock 串行顶层转换，Runtime 的幂等关闭负责吸收 WebSocket、心跳等后台入口的并发清理。

### TUI 投影

TUI 不维护第二份群聊业务状态。当前 Extension Runtime 创建一个轻量 `TavernUiPresenter`，每次都从 Controller、`GroupChatState` 或 Character 最近取得的群聊状态快照生成只读 view model，再通过当前 `PiRuntimeBindings` 中的有效 UI context 渲染。

```ts
interface TavernViewModel {
  status: string | null;
  widgetLines: string[] | null;
}
```

Presenter 可以缓存上一次已经渲染的 view model 以避免重复刷新，但该缓存不具有业务权威性，不能参与协议、额度、成员或恢复判断。

UI context 在当前 Extension Runtime 的 `session_start` 中绑定到 `PiRuntimeBindings`。后台更新只调用 bindings 暴露的 UI 方法，不直接保存或调用旧 command/event context。Runtime shutdown 时先清除当前 status 和 widget，再使 bindings 失效；reload 后由新 Extension Runtime 使用新的 UI context 从交接状态重新生成界面。

#### Footer status

使用固定 key `pi-tavern` 调用 `ctx.ui.setStatus()`：

- `idle`：清除 status；
- `joining`：显示正在加入或正在准备所选 Character；
- `creator`：显示 Creator 模式及群聊名称；
- `character`：显示当前 Character 名称及群聊名称。

Footer 只显示当前模式和身份，不展开在线角色详情。

#### 底部 widget

`creator` 和 `character` 使用固定 key `pi-tavern`，通过：

```ts
ctx.ui.setWidget("pi-tavern", lines, {
  placement: "belowEditor",
});
```

widget 只显示已经确定的两类摘要：

- 当前总成员数；
- 当前 `is_streaming: true` 的 Character 名称。

总成员数包含 User Persona，因此为在线 Character 数量加一。Creator 直接从权威 `GroupChatState` 生成；Character 从最近一次 `get_group_chat_state` 快照生成。Character 尚未取得首次状态快照时显示成员数未知，不自行猜测其他在线成员。

`is_streaming` 表示对应 pi Agent 正在生成，不区分由终端私聊还是群聊输入触发。widget 不将其解释为已经产生公开发言。

`idle`、`joining` 以及 Runtime 清理时移除 widget。`/tavern-status` 负责按需展示完整群聊和在线 Character 状态，不把详细列表常驻 widget。

TUI 刷新触发点：

- Controller 状态转换；
- Creator 的 `GroupChatState` 发生已提交修改；
- Character 收到新的群聊状态快照；
- Character 本地 Agent 的 streaming 状态变化；
- reload handoff 被新 Runtime 接管；
- Runtime 清理。

UI 更新失败只产生本地展示警告，不改变群聊状态、不撤销公开消息，也不关闭 WebSocket。

#### 创建者主聊天区投影

创建者主聊天区使用 pi 原生 `custom` entry，`customType` 固定为：

```text
pi-tavern.creator-display
```

并通过 `registerEntryRenderer()` 注册 renderer。该 entry 持久化在创建者私有 pi session 中，但不进入 LLM context；群聊专用 session 仍是唯一权威记录。

entry data 是 PiTavern 自定义持久化 JSON，因此使用 `snake_case`：

```ts
interface CreatorDisplayEntryData {
  kind: "public_message";
  group_chat_id: string;
  event: PublicMessageEvent;
}
```

renderer 只读取 entry 自身的数据，不读取 live Runtime 或 `GroupChatState`，保证创建者以后恢复自己的私有 pi session 时仍能稳定展示历史投影。

公开消息必须先完成群聊权威记录持久化和 `GroupChatState` 提交，再追加创建者展示 entry。展示 entry 写入失败不撤销群聊消息。

成员加入、离开和举手只属于运行期环境，既不写入群聊专用 session，也不作为展示 entry 写入创建者私有 session。创建者通过当前 UI context 的 notify 和 widget 查看这些运行期变化。

Character 私有 session 中的 `pi-tavern.group-chat-input` 继续使用 `registerMessageRenderer()` 渲染已经提交给当前 pi session 的群聊环境批次。renderer 同样只读取该 custom message 自身的 `content` 和 `details`，不依赖 live Runtime。

## Extension 入口接线

PiTavern 使用一个 pi `ExtensionFactory` 作为组合根。Factory 创建当前 Extension Runtime 的 `PiRuntimeBindings`、`TavernUiPresenter` 和 `TavernController`，然后一次性注册命令、工具、renderer 与生命周期事件。

注册行为沿用 `references/pi` 的原生 Extension API，不在 Runtime 内建立第二套事件总线。

### 命令

Factory 注册以下已确定的命令：

| 命令 | Controller 路由 |
| --- | --- |
| `/tavern-new` | `idle → creator`，调用 `CreatorRuntime.startNew()` |
| `/tavern-resume` | `idle → creator`，选择群聊记录后调用 `CreatorRuntime.resume()` |
| `/tavern-join` | `idle → joining → character` |
| `/tavern-leave` | 取消加入、关闭群聊或离开群聊，最终进入 `idle` |
| `/tavern-status` | 按当前状态展示加入进度、创建者权威状态或 Character 拉取的状态 |
| `/tavern-set-max` | 仅在 `creator` 中设置当前群聊的 `groupMaxMessages` |
| `/tavern-name` | 仅在 `creator` 中设置或查看群聊名称 |

命令 handler 不直接操作 WebSocket、timer、`SessionManager` 或提示词，只调用 Controller 的串行转换入口。命令执行期间使用传入的当前 command context 完成交互式选择和确认；该 context 不保存到后台 Runtime。

### 工具与 renderer

Factory 在加载阶段注册：

- 一个 `tavern_speak` tool；
- `pi-tavern.creator-display` 的 `registerEntryRenderer()`；
- `pi-tavern.group-chat-input` 的 `registerMessageRenderer()`。

`tavern_speak` 始终完成注册，但只有 `character` 状态将其加入 active tools。工具 execute 通过 Controller 查找当前 `CharacterRuntime`，再次校验连接后发送 `speak` 请求。

两个 renderer 都是无状态纯渲染函数，只读取当前 entry 或 custom message 的持久化数据，不捕获 Controller、Runtime 或 UI context。

### pi 事件

Factory 只订阅首版确实需要的 pi 事件：

| pi 事件 | PiTavern 行为 |
| --- | --- |
| `session_start` | 通过 `ctx.sessionManager.getSessionId()` 绑定当前 session ID 和 UI context；接管匹配的 reload handoff 或从 `idle` 开始；重新渲染 TUI |
| `session_shutdown` | `reload` 时 detach 并发布 handoff；其他原因按既定规则永久关闭当前状态 |
| `session_before_switch` | `/new`、`/resume` 前执行退出确认与清理，可返回 `cancel: true` |
| `session_before_fork` | `/fork`、`/clone` 前执行相同的退出确认与清理，可返回 `cancel: true` |
| `input` | `creator` 状态接管 User Persona 文本，先持久化为公共消息，再返回 `action: "handled"`，不启动创建者 LLM |
| `before_agent_start` | 仅在 `character` 状态把缓存的 Character Markdown 正文追加到本次 system prompt |
| `agent_start` | 仅在 `character` 状态将本地 `is_streaming: true` 上报给创建者 |
| `agent_settled` | 仅在 `character` 状态将本地 `is_streaming: false` 上报给创建者 |

创建者 `input` handler 不处理已经被 pi 识别的 Extension 命令，因为 pi 会先执行命令并跳过 `input` 事件。`event.source === "extension"` 的输入也不作为 User Persona 消息，避免 PiTavern 自己注入的消息再次进入群聊。

生成状态的结束点使用 `agent_settled`，不使用 `agent_end`。按照 pi 的语义，`agent_end` 后仍可能自动重试、自动 compact 后重试或继续处理 follow-up；只有 `agent_settled` 表示当前 Agent 不会自动继续运行。

首版不订阅 `message_update` 或 `turn_*` 来推导生成状态，也不轮询 Agent。`is_streaming` 只在布尔值实际变化时上报；断线或 Runtime 清理不再尝试上报。

## `CreatorRuntime` 最终资源

`CreatorRuntime` 是创建者活动实例的资源所有者，最终持有：

```ts
class CreatorRuntime {
  readonly bindings: PiRuntimeBindings;
  readonly webSocketServer: WebSocketServer;
  readonly groupSessionManager: SessionManager;
  readonly state: GroupChatState;
  readonly activeDescriptor: ActiveGroupChatDescriptor;

  readonly connections: Map<string, WebSocket>;
  readonly heartbeatStates: Map<string, HeartbeatState>;
  readonly runtimeQueue: SerialTaskQueue;

  private heartbeatTimer: NodeJS.Timeout;
  private lifecycle: RuntimeLifecycle;
  private generation: number;
  private closePromise: Promise<RuntimeCloseResult> | null;
}
```

其中：

- `bindings` 是当前 Extension Runtime 提供的有效 pi 接口引用，reload 时不转移；
- `webSocketServer` 持有本次活动实例实际监听的灵活端口；
- `groupSessionManager` 是群聊记录的唯一持久化入口；
- `state` 是协议、额度、成员和 TUI 的唯一权威内存状态；
- `activeDescriptor` 表示当前 Runtime 对活动描述文件的所有权；
- `connections` 与 `state.onlineCharacters` 共同维持正式在线成员约束；
- `heartbeatStates` 和 `heartbeatTimer` 管理在线连接心跳；
- `runtimeQueue` 串行处理连接 frame、User Persona 输入和群聊状态提交；
- lifecycle、generation 与 `closePromise` 实现异步失效保护和幂等关闭。

WebSocket Server 的单个未正式加入连接仍由对应 connection handler 闭包持有 `sessionId`、`reservedCharacterId` 和 5 秒准备超时 timer。它不是正式在线资源，不进入 `connections`；正式加入或连接关闭后，该闭包必须停止准备超时 timer。

### 启动成立点

`startNew()` 和 `resume()` 在返回 `CreatorRuntime` 前完成以下共同启动步骤：

1. 准备群聊 `SessionManager` 和 `GroupChatState`；
2. 创建仅监听 `127.0.0.1`、由系统分配端口的 WebSocket Server；
3. 安装 connection handler、Runtime 队列和心跳；
4. 一次性创建活动描述文件；
5. 将全部资源交给新 `CreatorRuntime`；
6. Controller 最后提交到 `creator` 并刷新 TUI。

活动描述成功创建是外部可发现的启动成立点。在此之前 `/tavern-join` 不能发现该实例。任一步失败时按初始化逆序清理已经取得的资源，删除可能创建的活动描述，并保持 Controller 为 `idle`；新建空群聊不留下群聊 session 文件。

Controller 进入 `creator` 后，所有 User Persona 消息、WebSocket frame 和群聊状态修改都通过同一个 `runtimeQueue` 串行执行。永久关闭顺序和 reload detach 顺序使用本文已经确定的统一清理接口，不再定义第三个停止入口。

## 运行资源所有权

首版使用单一所有者和显式借用关系：

| 资源 | 稳定所有者 | 转移规则 |
| --- | --- | --- |
| 当前 `TavernState` | `TavernController` | 只能在 Controller transition lock 内替换 |
| 当前 `PiRuntimeBindings` | 当前 Extension Factory 实例 | Runtime 只借用；shutdown 后失效，不进入 handoff |
| `TavernUiPresenter` | 当前 Extension Factory 实例 | 只借用 Controller/Runtime 快照；不进入 handoff |
| 加入期 WebSocket | `JoinAttempt` | `character_ready` 成功后由 `takeConnection()` 一次性转给 `CharacterRuntime` |
| Character 预留 | 创建者 connection handler | 正式加入、关闭或 5 秒超时时释放一次 |
| 正式 Character WebSocket | 对应 `CharacterRuntime` | reload 时一次性转给 `CharacterReloadHandoff`，再转给新 Runtime |
| WebSocket Server | `CreatorRuntime` | reload 时一次性转给 `CreatorReloadHandoff`，再转给新 Runtime |
| 在线成员 WebSocket | `CreatorRuntime.connections` | 与 Server 一起 handoff；普通关闭时由 Creator 关闭 |
| 群聊 `SessionManager` | `CreatorRuntime` | reload 时转移；普通关闭后文件保留、对象释放 |
| `GroupChatState` | `CreatorRuntime` | reload 时转移；协议和 TUI 只能读取或通过 Runtime 队列修改 |
| 活动描述 | `CreatorRuntime` | reload 时保持并转移；永久关闭或启动失败时删除 |
| Runtime timer/listener/queue | 对应 Runtime | 永不转移旧 callback；reload 时停止并由新 Runtime 重建 |
| Character prompt 缓存 | `CharacterRuntime` | reload 时随 handoff 转移；离开时释放 |
| 未提交环境批次 | `CharacterRuntime` | reload 时转移；永久关闭时丢弃 |
| reload 底层资源 | 一次性 `ReloadHandoff` | `take()` 后所有权转给新 Runtime；超时且未取走时由 handoff 清理 |
| renderer 注册 | pi Extension Runtime | 无业务状态，不进入任何 Runtime 或 handoff |

任何可关闭资源在同一时刻只能有一个所有者。Controller、Presenter、renderer 和 command handler 不直接关闭底层资源；它们只能请求当前所有者执行 `close()`、`detachForReload()` 或一次性转移。

创建者 connection handler 在 `character_ready` 提交后不再拥有该 WebSocket，其后连接由 `CreatorRuntime.connections` 统一管理。`JoinAttempt` 转交成功后也不再拥有 WebSocket。以上两条所有权变化都必须先完成目标容器写入，再清空原所有者引用，避免异常路径出现无人清理或重复关闭。

## 与 pi Extension Runtime 的关系

`TavernController` 由 PiTavern 的 Extension Factory 创建，属于该次 pi Extension Runtime。

不能将其描述为由 `session_start` 创建。`session_start` 是 Extension Runtime 已经建立后收到的生命周期事件。

pi 在替换 Agent session 时会关闭旧 session、使旧 Extension Runtime 失效，并建立新的 Agent session 和 Extension Runtime。因此，首版不建立跨 pi session 的进程级全局 Controller。

### reload 资源交接

`/reload` 不替换当前 pi session。PiTavern 对 `creator` 和 `character` 使用进程内、一次性的 `ReloadHandoff` 在新旧 Extension Runtime 之间交接运行资源：

```text
旧 Extension Runtime
  ↓ session_shutdown(reason: "reload")
ReloadHandoff 暂存当前身份和运行资源
  ↓
新 Extension Runtime
  ↓ session_start(reason: "reload")
接管资源并重新绑定当前有效的 pi API
```

reload 期间：

- Creator 的 WebSocket Server、成员连接、群聊 `SessionManager` 和 `GroupChatState` 不关闭；
- Character 的 WebSocket、Character 身份、缓存提示词和未提交环境批次不释放；
- 不发送 `character_left` 或 `group_chat_closed`；
- 不重新连接、不重新领取 Character，也不产生新的 `character_joined`；
- 旧 Runtime 不再调用已经失效的 pi API；
- reload 窗口收到的 WebSocket 消息由 handoff 暂存，新 Runtime 接管后继续处理。

`ReloadHandoff` 只允许同一个 pi session 的下一次 reload Runtime 一次性取回，不是永久全局 Controller，也不用于 `/new`、`/resume`、`/fork` 或 `/clone`。

`ReloadHandoff` 不保存或交接旧的 `TavernController`、`CreatorRuntime`、`CharacterRuntime` 实例。旧实例包含 reload 前的代码和已经失效的 pi API，不能由新 Extension Runtime 继续调用。

handoff 只保存可转移的底层资源和纯状态。新 Extension Runtime 取回 handoff 后，使用 reload 后的代码重新创建 `TavernController` 及对应 Runtime，再把底层资源和状态交给新实例接管。

Creator 侧 handoff 载荷：

```ts
interface CreatorReloadHandoff {
  kind: "creator";
  piSessionId: string;

  webSocketServer: WebSocketServer;
  groupSessionManager: SessionManager;
  groupChatState: GroupChatState;

  connections: Map<string, WebSocket>;
  heartbeatStates: Map<string, HeartbeatState>;

  activeDescriptor: ActiveGroupChatDescriptor;

  bufferedFrames: Map<string, BufferedFrame[]>;
  closedSessionIds: Set<string>;

  expiresAt: number;
}
```

- `piSessionId` 限制只有相同 pi session 的新 Runtime 可以接管；
- WebSocket Server 保持原监听端口；
- 群聊 `SessionManager`、`GroupChatState` 和活动描述所有权继续使用；
- `connections` 只包含已经完成 `character_ready` 的正式在线成员；
- reload 窗口收到的在线成员 frame 先按 `sessionId` 暂存为原始 frame，新 Runtime 接管后再解析；
- reload 窗口断开的在线成员记录到 `closedSessionIds`，新 Runtime 接管后执行正常断线清理；
- 旧心跳计时器和 WebSocket handler 不交接，新 Runtime 使用保存的心跳状态重新建立。

Creator 开始 reload 时，尚未完成 `character_ready` 的连接全部释放 Character 预留并关闭，不进入 handoff。5 秒 reload 窗口内新建立的 WebSocket 也直接关闭，不启动加入流程。

handoff 不包含旧 pi API、command/event context、TUI context、renderer 或计时器。

Character 侧 handoff 载荷：

```ts
interface CharacterReloadHandoff {
  kind: "character";
  piSessionId: string;

  groupChatId: string;
  socket: WebSocket;
  character: LoadedCharacter;
  cursorStorePath?: string;

  pendingEvents: GroupChatEnvironmentEvent[];
  debounceDueAt: number | null;
  idleWindowDueAt: number | null;
  idleWindowAbortEligible: boolean;
  incrementPending: boolean;

  bufferedFrames: BufferedFrame[];
  socketClosed: boolean;

  lastPingAt: number;
  expiresAt: number;
}

interface BufferedFrame {
  receivedAt: number;
  data: WebSocket.RawData;
}
```

- `piSessionId` 限制只有相同 pi session 的新 Runtime 可以接管；
- `socket`、`groupChatId` 和 `character` 保持原连接、群聊身份及已缓存的 Character prompt；
- `cursorStorePath` 保持当前 pi session 的独立游标文件；
- `pendingEvents` 保存尚未提交给 pi 的环境事件；
- `debounceDueAt` 保存原 1 秒防抖截止时间；
- `idleWindowDueAt` 和 `idleWindowAbortEligible` 保存闲态固定窗口的原截止时间及已确认含他人消息的打断证据；
- `incrementPending` 保存旧 run 忙态期间已经收到但尚未拉取的群消息通知；
- reload 窗口收到的 frame 按 `receivedAt` 暂存；
- `socketClosed` 记录 reload 窗口内连接是否已经断开；
- `lastPingAt` 保存最后一次收到创建者心跳的时间。

以上未读标记与窗口字段都是进程内 handoff 的本地瞬态，不写入 session 游标文件，也不改变 WebSocket wire schema。

旧 CharacterRuntime 交接时：

1. 停止旧防抖和心跳计时器；
2. 保存未提交事件、防抖截止时间、闲态窗口和忙态未读标记；
3. 移除旧 WebSocket handler，安装只负责暂存 frame 和记录连接关闭的 handoff handler；
4. 清除对旧 pi API 的引用；
5. 发布一次性 handoff。

新 Extension Runtime 接管时：

1. 验证 `piSessionId`；
2. 使用 reload 后的代码构造新的 `CharacterRuntime`；
3. 安装新的 WebSocket handler；
4. 恢复 Character prompt 和 `tavern_speak`；
5. 使用保存的心跳状态重新建立心跳检测；
6. 按 `receivedAt` 顺序处理暂存 frame；
7. 恢复环境防抖和闲态窗口；若旧 run 留有忙态未读，则立即按游标拉全并以 follow-up 重开。

防抖恢复规则：

- `debounceDueAt` 仍在未来时，只等待剩余时间；
- `debounceDueAt` 已经过期时，接管完成后立即处理；
- reload 窗口收到新的环境消息时，以最后一条消息的 `receivedAt` 重新计算 1 秒截止时间。

群消息触发恢复规则：

- `idleWindowDueAt` 仍在未来时，只等待原固定窗口的剩余时间；已经过期时在接管后的下一个 tick 消费；
- `incrementPending` 为 `true` 时，旧 run 已随 reload 结束，新 Runtime 不再等待 settled，立即从持久化游标拉取全部未读正文；
- 跨版本 reload 取得不含上述新字段的 legacy handoff 时，保守地按持久化游标补拉一次；无未读时为空操作；
- 恢复不调用群聊状态接口推导 `latest_sequence`；该字段不属于 `get_group_chat_state` 响应。

如果 `socketClosed` 为 `true`，新 Runtime 不恢复 `character`，而是执行正常断线清理并进入 `idle`。

handoff 不保存 JS Promise、resolver、tool execution callback、已经提交给 pi session 或原生 follow-up queue 的群聊输入，也不保存当前 Agent run。这些已经由 pi 接管的内容在 reload 后继续遵循 pi 原生逻辑，PiTavern 不重复提交。

Character handoff 超过 5 秒仍未接管时，关闭 WebSocket，丢弃未提交的 `pendingEvents` 和 `bufferedFrames`，释放本地 Character 运行资源。服务端按照正常 `disconnected` 规则清理成员；之后加载的新 Runtime 从 `idle` 开始。

`joining` 不参与 reload 交接。旧 Runtime 在 reload shutdown 时关闭加入连接、释放可能存在的 Character 预留并释放 `JoinAttempt`；新 Runtime 从 `idle` 开始。

新 Runtime 必须在 handoff 创建后的 5 秒通用短期协调超时内完成接管。超时时：

- Creator handoff 关闭群聊、断开全部 Character 并释放活动描述；
- Character handoff 关闭 WebSocket 并释放本地 Character 运行资源；
- handoff 中尚未提交给 pi 的暂存消息和防抖批次丢弃；
- 之后加载的新 Runtime 从 `idle` 开始，不自动重连或恢复。

### quit 清理

能够触发 `session_shutdown` 且 `reason: "quit"` 的正常退出，必须等待 PiTavern 先完成群聊退出和本地资源清理，再允许 pi 继续退出：

- `idle`：不执行额外操作；
- `joining`：释放 Character 预留、关闭 WebSocket 并释放 `JoinAttempt`；
- `character`：尽力完成 `leave_group_chat`，再关闭 WebSocket，并移除 Character prompt、群聊输入模块和 `tavern_speak`；
- `creator`：广播 `group_chat_closed`，关闭全部 Character 连接和 WebSocket Server，删除活动描述并释放 `CreatorRuntime`。

群聊关闭不向群聊 session 追加结束 entry，已经提交的群聊记录保持不变。

quit 清理最多等待 5 秒通用短期协调超时。超时后不再等待远端确认，强制关闭本地 WebSocket 资源、完成本地清理并允许 pi 继续退出。

`session_shutdown` 不能覆盖 `kill -9`、进程崩溃、系统断电或 pi 在触发生命周期事件前异常终止。此类情况依靠既有故障机制收敛：

- Character 失效由创建者通过 WebSocket close 或心跳超时清理；
- Creator 失效由 Character 通过 WebSocket close 或心跳超时检测；
- 残留活动描述由后续发现流程通过 PID 和实际 WebSocket 身份校验清理。

具体运行状态及已经确认的产品转换规则见 [runtime-state-machine.md](../reference/runtime-state-machine.md)。
