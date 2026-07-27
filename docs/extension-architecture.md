# PiTavern Extension Architecture

> 状态：讨论中。本文只记录已经确认的顶层结构，以及尚未定稿的架构问题。

PiTavern 作为 pi-coding-agent 扩展实现。技术设计以 `references/pi` 中的当前实现为准。

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

`TavernController` 不负责 WebSocket 收发、群聊记录持久化、Character 提示词、消息防抖或 TUI 展示细节。这些能力的归属后续分别讨论。

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

`claim_character` 成功时只向 `characterReservations` 写入预留，不进入 `connections` 或 `onlineCharacters`。`character_ready` 成功时原子删除预留，并将连接和 Character 写入 `connections` 与 `onlineCharacters`。

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

第一条 User Persona 消息立即触发群聊专用 session 的首次落盘，不等待 Character 或任何 LLM 回复。首次落盘按照 [persistence.md](persistence.md) 已经确定的 `empty → started` 流程执行。

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

群聊专用 session 的持久化成功是消息提交点。创建者侧处理消息时遵循：

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

二者互不作为对方成功的前提，也不因一方失败而取消另一方。TUI 投影失败时不回滚已经提交的群聊消息，创建者界面应显示投影失败提示。WebSocket 发送失败也不回滚消息，并按照已经确认的连接断开规则清理对应 Character。

具体 `customType`、entry 数据结构和 renderer 样式后续单独讨论。

`CreatorRuntime` 的其他职责和资源边界仍待讨论。

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
- `pendingEvents` 和 `debounceTimer` 管理 1 秒群聊环境防抖；
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

退出与后续 pi session 操作不构成事务。PiTavern 提交到 `idle` 后，即使后续 `/new`、`/resume`、`/fork` 或 `/clone` 失败、被取消或没有实际完成，也不恢复之前的 Runtime、不重新创建群聊、不重新加入群聊。

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

`joining` 不参与 reload 交接。旧 Runtime 在 reload shutdown 时关闭加入连接、释放可能存在的 Character 预留并释放 `JoinAttempt`；新 Runtime 从 `idle` 开始。

新 Runtime 必须在 handoff 创建后的 5 秒通用短期协调超时内完成接管。超时时：

- Creator handoff 关闭群聊、断开全部 Character 并释放活动描述；
- Character handoff 关闭 WebSocket 并释放本地 Character 运行资源；
- handoff 中尚未提交给 pi 的暂存消息和防抖批次丢弃；
- 之后加载的新 Runtime 从 `idle` 开始，不自动重连或恢复。

`ReloadHandoff` 的具体资源载荷仍待讨论。

## 待讨论

以下内容尚未定稿，不能作为实现约束：

1. Extension 入口具体注册哪些命令、事件、工具和渲染器。
2. `CreatorRuntime` 持有哪些资源，如何启动与关闭。
3. quit 时的 `session_shutdown`，以及 `ReloadHandoff` 的具体交接载荷。
4. WebSocket 后台回调如何安全访问当前有效的 pi Extension API。
5. Runtime 的清理接口和异步任务终止方式。
6. TUI 状态由谁维护、如何使用当前有效的 UI context 更新。
7. 各项运行资源的最终所有权边界。

具体运行状态及已经确认的产品转换规则见 [runtime-state-machine.md](runtime-state-machine.md)。
