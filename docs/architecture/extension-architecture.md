# PiTavern Extension Architecture

> 本文记录 PiTavern 首版 Extension Runtime 的当前技术结构（模块、资源所有权、生命周期、reload 与关键不变式）。行为语义以 [interaction-model.md](interaction-model.md)（行为地图）、[group-chat-input.md](group-chat-input.md)（输入聚合）与 [websocket-protocol.md](../reference/websocket-protocol.md)（契约）为单一事实源，本文不重复行为叙述。技术设计以 `references/pi` 中的当前实现为准。

## 源码顶层模块

```text
src/
├── index.ts          ExtensionFactory 入口与组合根：创建顶层对象，注册命令/事件/工具/renderer
├── commands.ts       注册七个 /tavern-* 命令
├── events.ts         注册 session、input 与 Agent 生命周期事件
├── controller/       TavernController、顶层状态转换、transition lock、reload-handoff-registry
├── creator/          CreatorRuntime、GroupChatState、创建者侧消息处理
├── character/        JoinAttempt、CharacterRuntime、Character prompt、群聊输入接入、tavern-speak-tool
├── protocol/         WebSocket wire message 定义、解析与校验（TypeBox schema，Static 推导类型）
├── persistence/      群聊 session 记录读写（基于 pi 原生 SessionManager）
├── discovery/        活动描述发布/枚举/清理与 PID + WebSocket 身份校验
├── config/           全局与项目配置合并、Character Markdown 发现与加载
└── ui/               Presenter、view model 与 pi TUI renderer
```

- `discovery/` 不并入 `persistence/`：活动描述是进程内临时发现信息，不是可恢复的群聊记录。
- 类型跟随权威模块（WebSocket JSON 归 `protocol/`、`GroupChatState` 归 `creator/`、session entry 归 `persistence/`、view model 归 `ui/`），不建立顶层 `types/`/`shared/`；不为可能的未来复用预先建层级（无 `server/`/`service/`/`repository/` 包装目录、无 `ConfigManager`、无 `GroupChatRepository`、无 `utils/`、无配置文件 watcher）。
- 跨 reload 资源载荷由原资源模块定义（`creator/` 定义 `CreatorReloadHandoff`，`character/` 定义 `CharacterReloadHandoff`），由 `controller/reload-handoff-registry.ts` 以进程内一次性槽位发布/取回。pi `/reload` 清除 Extension loader 缓存并禁用 module cache，因此 handoff 使用 `globalThis` 上 PiTavern 私有 `Symbol.for(...)` key 保存，不能使用普通模块级变量。
- 测试与源码分开：`test/` 按 `protocol/`、`persistence/`、`discovery/`、`creator/`、`character/` 分目录，不在 `src/` 旁放置 `*.test.ts`；每个测试/worker 使用独立临时 `PI_CODING_AGENT_DIR`，同一多人群聊用例的多个 pi 共享该用例自己的临时目录。

## 顶层状态结构

```text
PiTavern Extension
└── TavernController
    ├── idle
    ├── CreatorRuntime
    └── CharacterRuntime
```

- `TavernController` 统一表示一个 pi 进程中当前的 PiTavern 状态；`joining` 是短暂状态（由 `JoinAttempt` 管理），不是第三种稳定 Runtime；`CreatorRuntime` 与 `CharacterRuntime` 不会同时存在。
- 状态采用可辨识联合（`idle` / `joining` / `creator` / `character`）。

### `TavernController` 职责

`TavernController` 保持为轻量的状态入口，只负责：

- 持有当前 PiTavern 状态；
- 串行执行状态转换（transition lock）；
- 根据当前状态将命令转交给对应 Runtime。

`TavernController` 不负责 WebSocket 收发、群聊记录持久化、Character 提示词、消息聚合或 TUI 展示细节：收发归各 Runtime 连接管理，持久化归 `persistence/`（见 [persistence.md](../reference/persistence.md)），提示词与群聊环境事件聚合归 `character-runtime.ts` / `group-chat-input.ts`（见 [group-chat-input.md](group-chat-input.md)），TUI 展示归 `src/ui/`（见本文「TUI 投影」节）。

### `JoinAttempt`

`joining` 是临时业务状态，其加入过程资源由专门的 `JoinAttempt` 对象管理：

- 持有加入期间已建立的 WebSocket、服务端返回的可领取 Character 列表；
- 发送 `claim_character` 并接收结果，读取并验证预留 Character 的 Markdown，构造尚未激活的 `CharacterRuntime`，发送 `character_ready` 并接收结果；
- 处理用户取消、连接断开和加入失败后的清理。

`claim_character` 成功只表示预留成功，Controller 仍处于 `joining`，不启用 Character prompt、群聊输入模块或 `tavern_speak`。`character_ready` 成功后复用当前 WebSocket 不重连，`JoinAttempt` 通过一次性 `takeConnection()` 将连接所有权转交 `CharacterRuntime`（转交后不再读取、写入或关闭该连接），Controller 进入 `character`。业务冲突保留 `JoinAttempt` 继续 `joining`；取消/断开/放弃加入则释放并回到 `idle`。

`JoinAttempt` 提供幂等 `close(reason)`（关闭后不能转交连接）和一次性 `takeConnection()`（转交后 `close()` 不能关闭已移交的 WebSocket；Character 预留最多释放一次）。

### `CreatorRuntime`

首版由 `CreatorRuntime` 直接持有：WebSocket Server、用于群聊记录持久化的独立 pi `SessionManager`、一个独立定义的 `GroupChatState`。不为 WebSocket Server 或持久化拆独立服务对象。

`GroupChatState` 是创建者侧唯一权威内存状态：协议响应、群聊广播和创建者 TUI 都从该状态生成。它只表示群聊状态（groupChat 信息、Round、characterReservations、onlineCharacters），不持有 WebSocket Server、`SessionManager`、计时器或文件句柄等运行资源。内部字段 `camelCase`，输出协议时转 `snake_case`。

- `onlineCharacters` 以当前 pi `sessionId` 为 key（私有字段，不进公开摘要）；
- `characterReservations` 以 `characterId` 为 key、预留连接的 `sessionId` 为 value；预留只存在于当前活动实例，恢复群聊时从空 Map 开始；
- `get_group_chat_state` 从状态生成请求方相关快照：`is_self` 按连接动态计算、`remaining_messages` 由额度计算（最小 0）、`round: null` 表示尚无第一条 User Persona 消息。

**在线连接与 Character 绑定不变式**：完成 `character_ready` 的在线成员以 `sessionId` 同时索引连接与群聊状态，且必须保持 `connections.keys() == state.onlineCharacters.keys()`。连接对象不重复保存 Character；`tavern_speak`、状态上报和离开请求不接受客户端重复提交的 `character_id`，发送者身份以创建者保存的连接绑定为准。

尚未完成 `character_ready` 的连接不进入 `connections`/`onlineCharacters`，只由 WebSocket connection handler 闭包暂存（`sessionId`、`reservedCharacterId`、在线标志——三阶段加入共用该闭包）。`character_ready` 成功时原子完成「删除预留 + 写入连接与在线状态」；连接在正式加入前关闭时释放预留、不广播 `character_left`。每次成功预留启动 5 秒 `character_ready` 超时，超时先释放预留再关闭 WebSocket；加入方回到 `idle`，不增加中间状态。

**创建与恢复入口**：`CreatorRuntime.startNew()`（生成 groupChatId/createdAt、复制额度、空状态、内存 SessionManager）与 `resume()`（打开 JSONL、重建基础信息与 Round、空预留/空在线）两个静态入口，共用私有构造函数，不合并为带条件分支的公开入口。第一条 User Persona 消息触发群聊专用 session 首次落盘（`empty → started`），`round !== null` 表示已至少成功持久化一条 User Persona 消息。

## 资源所有权

**单一所有者和显式借用关系**：

| 资源 | 稳定所有者 | 转移规则 |
| --- | --- | --- |
| 当前 `TavernState` | `TavernController` | 只能在 transition lock 内替换 |
| 当前 `PiRuntimeBindings` | 当前 Extension Factory 实例 | Runtime 只借用；shutdown 后失效，不进入 handoff |
| `TavernUiPresenter` | 当前 Extension Factory 实例 | 只借用 Controller/Runtime 快照；不进入 handoff |
| 加入期 WebSocket | `JoinAttempt` | `character_ready` 成功后 `takeConnection()` 一次性转给 `CharacterRuntime` |
| Character 预留 | 创建者 connection handler | 正式加入、关闭或 5 秒超时时释放一次 |
| 正式 Character WebSocket | 对应 `CharacterRuntime` | reload 时经 `CharacterReloadHandoff` 转给新 Runtime |
| WebSocket Server | `CreatorRuntime` | reload 时经 `CreatorReloadHandoff` 转给新 Runtime |
| 在线成员 WebSocket | `CreatorRuntime.connections` | 与 Server 一起 handoff；普通关闭时由 Creator 关闭 |
| 群聊 `SessionManager` | `CreatorRuntime` | reload 时转移；普通关闭后文件保留、对象释放 |
| `GroupChatState` | `CreatorRuntime` | reload 时转移；协议和 TUI 只能读取或经 Runtime 队列修改 |
| 活动描述 | `CreatorRuntime` | reload 时保持并转移；永久关闭或启动失败时删除 |
| Runtime timer/listener/queue | 对应 Runtime | 永不转移旧 callback；reload 时停止并由新 Runtime 重建 |
| Character prompt 缓存 | `CharacterRuntime` | reload 时随 handoff 转移；离开时释放 |
| 未提交环境批次 | `CharacterRuntime` | reload 时转移；永久关闭时丢弃 |
| reload 底层资源 | 一次性 `ReloadHandoff` | `take()` 后所有权转给新 Runtime；超时未取走由 handoff 清理 |
| renderer 注册 | pi Extension Runtime | 无业务状态，不进入任何 Runtime 或 handoff |

任何可关闭资源在同一时刻只能有一个所有者。Controller、Presenter、renderer 和 command handler 不直接关闭底层资源，只请求当前所有者执行 `close()` / `detachForReload()` / 一次性转移。所有权转移必须先完成目标容器写入、再清空原所有者引用，避免异常路径出现无人清理或重复关闭。

`ReloadHandoff` 使用一次性 `take()` 模拟资源 move：`take()` 只能成功一次；旧 Runtime 交接后清空自己的资源引用；5 秒超时只有 handoff 仍持有资源时才能执行超时清理。

**启动成立点**：`startNew()`/`resume()` 返回前完成——准备 SessionManager 与 GroupChatState、创建仅监听 `127.0.0.1` 的 WebSocket Server（系统分配端口）、安装 connection handler / Runtime 队列 / 心跳、一次性创建活动描述文件、交付资源、Controller 提交 `creator`。活动描述创建成功是外部可发现的成立点（此前 `/tavern-join` 无法发现）；任一步失败按初始化逆序清理并保持 `idle`，新建空群聊不留下 session 文件。

## 生命周期

### Runtime 内部生命周期

CreatorRuntime 与 CharacterRuntime 使用内部生命周期保护后台回调：`active`（正常处理）/ `detaching`（reload 交接中，新 frame 入 handoff buffer，不再启动 pi 操作）/ `disposed`（已失效，后台回调立即结束）。该生命周期只是实现期资源状态，不进入 `TavernState`。

后台异步操作在开始时和每个 `await` 恢复后都必须重新确认生命周期及 generation，防止旧 Runtime 回调把群聊事件写入已切换的新 session（不得通过进程级 `currentPi` 路由）。

### Runtime 任务串行化

每个 Runtime 使用内部串行任务队列处理 WebSocket frame 和群聊状态修改（Creator 的额度检查、权威记录持久化、`GroupChatState` 更新、广播按 frame 到达顺序执行）。Runtime 队列与 pi follow-up queue 职责不同：前者串行处理协议与群聊状态，后者管理 Character Agent 输入。

reload detach：旧 Runtime 进入 `detaching` → 新 frame 转入 handoff buffer → 等待当前任务完成（最多 5 秒）→ 停止计时器、移除 handler、使 bindings 失效、发布 handoff。等待超时取消仍可取消的任务；已成功持久化的公开消息不撤销；超时后的旧任务不得再调用 pi API。新 Runtime 用新 bindings/代码恢复队列，按接收顺序先入队 handoff buffer 再开放 live dispatch。普通离开、quit、session 切换进入 `disposed`，不允许交接或重新绑定。

### Runtime 统一清理接口

两个终止入口：`close(reason)`（永久结束，资源不可恢复，Controller 最终进入 `idle`）与 `detachForReload()`（仅 reload 转移资源，不永久关闭），两条路径不能同时成功。`close()` 必须幂等（保存第一次关闭创建的 Promise，后续调用返回同一 Promise，不重复发送离开/广播/释放/关闭）。单个清理步骤失败记录到 `errors` 并继续，不把半失效 Runtime 留在原业务状态；Controller 清理结束后无论超时/错误都提交 `idle`。

CharacterRuntime 永久关闭顺序：置 `disposed` 并递增 generation → 禁止队列新任务 → 移除 `tavern_speak`、停用 prompt 与输入模块 → 停止防抖/心跳计时器、取消未开始任务 → 尽力发送 `leave_group_chat` → 关闭 WebSocket 移除 handler → 丢弃未提交 `pendingEvents` → 使 bindings 失效。`user_leave`/`session_change`/`quit` 尽力发送离开；`socket_closed`/`heartbeat_timeout`/`group_chat_closed`/`reload_timeout` 不等待响应直接本地清理。离开流程不 abort 当前 Agent run。

CreatorRuntime 永久关闭顺序：置 `disposed` → Server 停止接受新连接、队列停止新任务 → 等待当前任务（≤5s）→ 释放全部预留 → 尽力广播 `group_chat_closed` → 关闭全部成员连接与 Server → 停止心跳 → 删除活动描述 → 释放连接表与状态 → 使 bindings 失效。群聊 session 文件保留、不追加结束 entry。

`detachForReload()` 不调用普通 `close()`：置 `detaching`、停止 live dispatch、等待任务（≤5s）、移除 handler 与计时器、把可转移资源移入 handoff。

### `PiRuntimeBindings`

每次 Extension Factory 加载创建一份只属于当前 Extension Runtime 的 bindings；WebSocket handler、计时器、后台回调不得直接捕获 `ExtensionAPI` 或长期保存 command/event context。生命周期：`unbound` →（`session_start` 时绑定 session ID + UI context）→ `active` →（shutdown）`invalid`；`assertActive()` 校验，重复绑定抛错。`ReloadHandoff` 不保存旧 bindings：只有 handoff 中 `piSessionId` 与当前 pi session 一致时，新 Runtime 才能用新 Factory 的 bindings 接管；`/new`、`/resume`、`/fork`、`/clone` 后的旧 Runtime 永远不能重新绑定新 session。

### `tavern_speak` 启停

Factory 加载时注册一次 `tavern_speak` tool，但 idle/joining/creator 状态不属于 active tools。`character_ready` 提交时经 `getActiveTools()`/`setActiveTools()` 增量加入；主动离开/断开/心跳超时/群聊关闭/session 切换/非 reload 清理时仅移除该工具，**不保存并恢复加入前完整 active tools 快照**（避免覆盖用户/pi/其他扩展的工具变更）。execute 仍须再次校验 Controller 为 `character`、Runtime 未失效、WebSocket 仍连接——active tools 只控制可见性，不作为连接有效性的唯一判断。

### pi session 操作

`session_before_switch` 处理 `/new`、`/resume`，`session_before_fork` 处理 `/fork`、`/clone`（pi 的 `/clone` 复用 fork 流程）。idle 直接允许；joining/creator/character 先请求用户确认：取消返回 `cancel: true` 保持状态；确认先完成对应退出（joining 关连接释放预留；character 正常离开；creator 关闭群聊）提交 `idle` 再返回 `cancel: false`。退出与后续 session 操作互不绑定，完成后不回退——即使后续操作失败/取消，也不恢复 Runtime、不重建群聊、不重新加入。

## TUI 投影

TUI 不维护第二份群聊业务状态：`TavernUiPresenter` 每次从 Controller / `GroupChatState` / Character 最近快照生成只读 view model（status + widget），经 bindings 渲染；缓存仅避免重复刷新，无业务权威性。后台更新只调用 bindings 暴露的 UI 方法；shutdown 先清 status/widget 再使 bindings 失效。

- **Footer status**：固定 key `pi-tavern`；idle 清除，joining 显示加入进度，creator 显示群聊名，character 显示角色与群聊名。只显示模式与身份，不展开在线角色。
- **底部 widget**：固定 key `pi-tavern`、`placement: "belowEditor"`；只显示总成员数（在线 Character + User Persona）与 `is_streaming: true` 的角色名。Character 未取首次快照时成员数未知；`is_streaming` 不解释为已公开发言。
- **刷新触发点**：Controller 状态转换、`GroupChatState` 已提交修改、Character 收到新状态快照、本地 streaming 变化、handoff 接管、Runtime 清理。
- **创建者主聊天区投影**：`pi-tavern.creator-display` entry（`registerEntryRenderer()`），`snake_case` 持久化 JSON。该投影保存在创建者私有 session、只用于 TUI 展示、不进入 LLM context、不触发 LLM、不是群聊记录的权威来源、不用于恢复。renderer 只读 entry 自身数据（恢复私有 session 后仍稳定展示）。公开消息先完成权威持久化和状态提交，再追加展示 entry；entry 写入失败不撤销群聊消息。成员加入/离开/举手只属运行期环境，不写 session、不作展示 entry（经 notify/widget 查看）。
- **Character 输入渲染**：`pi-tavern.group-chat-input` 用 `registerMessageRenderer()` 渲染已提交的群聊环境批次，renderer 只读 custom message 自身 `content`/`details`。
- UI 更新失败只产生本地展示警告，不改变群聊状态、不撤销消息、不关闭 WebSocket。

## Extension 入口接线

PiTavern 使用一个 pi `ExtensionFactory` 作为组合根：创建 `PiRuntimeBindings`、`TavernUiPresenter`、`TavernController`，一次性注册命令、工具、renderer 与生命周期事件。注册沿用 `references/pi` 原生 API，不在 Runtime 内建立第二套事件总线。

### 命令

| 命令 | Controller 路由 |
| --- | --- |
| `/tavern-new` | `idle → creator`，调用 `CreatorRuntime.startNew()` |
| `/tavern-resume` | `idle → creator`，选择群聊记录后调用 `CreatorRuntime.resume()` |
| `/tavern-join` | `idle → joining → character` |
| `/tavern-leave` | 取消加入、关闭群聊或离开群聊，最终进入 `idle` |
| `/tavern-status` | 按当前状态展示加入进度、创建者权威状态或 Character 拉取的状态 |
| `/tavern-set-max` | 仅在 `creator` 中设置当前群聊的 `groupMaxMessages` |
| `/tavern-name` | 仅在 `creator` 中设置或查看群聊名称 |

命令 handler 不直接操作 WebSocket、timer、`SessionManager` 或提示词，只调用 Controller 串行转换入口；命令 context 不保存到后台 Runtime。

### 工具与 renderer

Factory 加载阶段注册：一个 `tavern_speak` tool（始终注册，仅 `character` 状态加入 active tools；execute 经 Controller 查找 `CharacterRuntime` 并再次校验连接）、`pi-tavern.creator-display` entry renderer、`pi-tavern.group-chat-input` message renderer。两个 renderer 都是无状态纯渲染函数，只读 entry/custom message 的持久化数据，不捕获 Controller、Runtime 或 UI context。

### pi 事件

| pi 事件 | PiTavern 行为 |
| --- | --- |
| `session_start` | 绑定 session ID 与 UI context；接管匹配的 reload handoff 或从 `idle` 开始；重新渲染 TUI |
| `session_shutdown` | `reload` 时 detach 并发布 handoff；其他原因按既定规则永久关闭当前状态 |
| `session_before_switch` | `/new`、`/resume` 前执行退出确认与清理，可返回 `cancel: true` |
| `session_before_fork` | `/fork`、`/clone` 前执行相同退出确认与清理，可返回 `cancel: true` |
| `input` | `creator` 状态接管 User Persona 文本，先持久化为公共消息，再返回 `action: "handled"`，不启动创建者 LLM |
| `before_agent_start` | 仅在 `character` 状态把缓存的 Character Markdown 追加到本次 system prompt |
| `agent_start` | 仅在 `character` 状态将本地 `is_streaming: true` 上报给创建者 |
| `agent_settled` | 仅在 `character` 状态将本地 `is_streaming: false` 上报给创建者 |

- 创建者 `input` handler 不处理已被 pi 识别的 Extension 命令（pi 先执行命令并跳过 `input`）；`event.source === "extension"` 的输入不作为 User Persona 消息。
- 生成状态结束点用 `agent_settled` 不用 `agent_end`（`agent_end` 后仍可能重试/compact/处理 follow-up）。
- `is_streaming` 悬挂兜底（watchdog）：`agent_end` 布防 5s 定时器、`agent_settled` 清除、`agent_start` 也清除旧 timer；回调以 `isAgentActive` 守卫，超时且 run 已不活跃时强制补发 `is_streaming: false`。reload 时旧 timer 随 Extension Runtime 销毁，`activateFromHandoff` 显式补发一次 `update_character_state(false)`；`close()` 清理 timer，幂等。不订阅 `message_update`/`turn_*`、不轮询 Agent；`is_streaming` 只在布尔值实际变化时上报。

## 与 pi Extension Runtime 的关系

`TavernController` 由 PiTavern 的 Extension Factory 创建，属于该次 pi Extension Runtime；**不是**由 `session_start` 创建（`session_start` 是 Runtime 已建立后收到的生命周期事件）。pi 替换 Agent session 时关闭旧 session、使旧 Extension Runtime 失效并建立新 Runtime，因此首版不建立跨 pi session 的进程级全局 Controller。

### reload 资源交接

`/reload` 不替换当前 pi session。对 `creator` 和 `character` 使用进程内、一次性的 `ReloadHandoff` 交接：

```text
旧 Extension Runtime
  ↓ session_shutdown(reason: "reload")
ReloadHandoff 暂存当前身份和运行资源
  ↓
新 Extension Runtime
  ↓ session_start(reason: "reload")
接管资源并重新绑定当前有效的 pi API
```

reload 期间：Creator 的 WebSocket Server、成员连接、SessionManager、GroupChatState 不关闭；Character 的 WebSocket、身份、缓存提示词、未提交环境批次不释放；不发送 `character_left`/`group_chat_closed`；不重连、不重新领取、不产生新 `character_joined`；旧 Runtime 不再调用已失效 pi API；窗口内收到的 WebSocket 消息由 handoff 暂存，新 Runtime 接管后继续处理。

`ReloadHandoff` 只允许同一个 pi session 的下一次 reload Runtime 一次性取回，不用于 `/new`/`/resume`/`/fork`/`/clone`；不保存旧 `TavernController`/Runtime 实例（含旧代码与已失效 API），只保存可转移的底层资源与纯状态——新 Runtime 用 reload 后代码重建 Controller 与 Runtime，再接管资源。

- **Creator 侧 handoff**：`piSessionId` + WebSocket Server（保持原端口）+ SessionManager + GroupChatState + `connections`（仅正式在线成员）+ 心跳状态 + 活动描述 + `bufferedFrames`（按 sessionId 暂存原始 frame）+ `closedSessionIds`（窗口内断开成员，接管后执行断线清理）+ `expiresAt`。旧心跳计时器与 handler 不交接，新 Runtime 按保存状态重建。开始 reload 时未完成 `character_ready` 的连接释放预留并关闭、不进入 handoff；5 秒窗口内新建立的 WebSocket 直接关闭。
- **Character 侧 handoff**：`piSessionId` + 连接/群聊身份/缓存 prompt + `cursorStorePath`（Session 独立游标文件）+ 未提交环境事件 + 防抖/闲态窗口截止时间与忙态未读标记（`debounceDueAt`/`idleWindowDueAt`/`idleWindowAbortEligible`/`incrementPending`）+ `bufferedFrames`（按 receivedAt）+ `socketClosed` + `lastPingAt` + `expiresAt`。未读标记与窗口字段是进程内本地瞬态，不写入游标文件、不改 wire schema。

旧 CharacterRuntime 交接：停止防抖/心跳计时器 → 保存未提交事件、窗口与忙态标记 → 换装只暂存 frame/记录断开的 handoff handler → 清除旧 pi API 引用 → 发布 handoff。

新 Runtime 接管：验证 `piSessionId` → 重建 `CharacterRuntime` → 装新 handler → 恢复 prompt 与 `tavern_speak` → 按保存状态重建心跳 → 按 `receivedAt` 处理暂存 frame → 恢复防抖与闲态窗口。防抖恢复：`debounceDueAt` 未过期只等剩余时间，已过期立即处理，窗口内新消息以最后一条 `receivedAt` 重算截止。群消息恢复：`idleWindowDueAt` 未过期等剩余时间，已过期在接管后下一个 tick 消费；`incrementPending` 为 true 时（旧 run 已随 reload 结束）不等 settled、立即按游标拉全未读；跨版本 legacy handoff 保守按持久化游标补拉一次（无未读为空操作）；不调用状态接口推导 `latest_sequence`。`socketClosed` 为 true 时不恢复 `character`，执行正常断线清理进入 `idle`。

handoff 不保存 Promise、resolver、tool callback、已提交给 pi session 或 follow-up queue 的输入、当前 Agent run（这些已由 pi 接管，PiTavern 不重复提交）。

- `joining` 不参与 reload 交接：shutdown 时关闭加入连接、释放预留并释放 `JoinAttempt`，新 Runtime 从 `idle` 开始。
- 超时（5 秒通用短期协调超时）：Creator handoff 关闭群聊、断开全部 Character、释放活动描述；Character handoff 关闭 WebSocket 并释放本地资源；未提交的暂存消息与防抖批次丢弃；之后加载的新 Runtime 从 `idle` 开始，不自动重连。

### quit 清理

`session_shutdown(reason: "quit")` 的正常退出必须等待 PiTavern 先完成群聊退出与本地资源清理，再允许 pi 继续退出：idle 不操作；joining 释放预留、关闭 WebSocket、释放 `JoinAttempt`；character 尽力 `leave_group_chat` 再关闭 WebSocket、移除 prompt/输入模块/`tavern_speak`；creator 广播 `group_chat_closed`、关闭全部连接与 Server、删除活动描述、释放 `CreatorRuntime`。群聊关闭不追加结束 entry，已提交记录不变。quit 清理最多等待 5 秒，超时后强制关闭本地资源并允许 pi 退出。

`session_shutdown` 不能覆盖 `kill -9`、进程崩溃、系统断电或异常终止：Character 失效由创建者经 WebSocket close/心跳超时清理；Creator 失效由 Character 经 close/心跳超时检测；残留活动描述由后续发现流程经 PID + WebSocket 身份校验清理。

## 关键不变式

- 在线成员约束：`connections.keys() == state.onlineCharacters.keys()`；发送者身份以连接绑定为准，不接受客户端提交的 `character_id`。
- 单一资源所有者：任何可关闭资源同一时刻只有一个所有者；所有权转移先写目标容器、再清原引用。
- `close()` 幂等：保存第一次关闭 Promise，后续调用返回同一 Promise。
- 幂等 `take()`：handoff 资源只能被取走一次。
- 群聊记录唯一权威：创建者私有 session 中的投影不参与恢复、不补齐历史、不触发 LLM。
- 忙态零正文投递与游标语义：见 [group-chat-input.md](group-chat-input.md)（聚合、忙态隐藏令牌、settled 拉全、游标预置）；协议帧语义见 [websocket-protocol.md](../reference/websocket-protocol.md)。
- 断线 → `idle`：无 `disconnected`/`reconnecting` 中间状态；具体转换规则见 [runtime-state-machine.md](../reference/runtime-state-machine.md)。
