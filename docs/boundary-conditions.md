# PiTavern Boundary Conditions

本文记录从设计文档交叉审查中发现的边界条件、失败模式和不变约束。每一条记录发生条件、涉及组件和预期行为。

新增边界条件来自审查或线上发现时更新本文；已修复的条件不删除，而是更新状态和检测结果。

状态统一使用（未完成项可追加“阻塞 Mx”限定）：

- `待修复`
- `部分修复`
- `已满足，待补测试`
- `已满足`
- `已修复，待补测试`
- `已修复`
- `计划于 Mx`
- `需确认`
- `设计已接受`

---

## 入口约定

- 本节记录不需要按单条测试的入口条件，如"第一条 User Persona 消息落盘成功才进入 started"——该约束由各规范文档定义，不重复记录。
- 本文只记录：经过多份文档交叉审查后仍存在实现缺口，或单一设计文档无法充分表达的跨组件边界。

---

## BC-1: SessionManager 内存 leaf 污染

**状态：** 已修复

**关联审查条目：** M3 第 2 条、第 4 条

**发生条件：**

SessionManager._appendEntry() 的内部顺序是：

1. 将 entry 推入 fileEntries
2. 更新 byId
3. 更新 leafId
4. 执行磁盘 appendFileSync

当第 4 步真实磁盘写入失败时，内存 leaf、entries、byId 已指向该失败 entry。

**预期行为：**

- 失败 entry 不在 JSONL 中，内存 leaf 不应引用它。
- 后续成功 entry 的 parentId 应指向磁盘上实际存在的最后一条 entry，不出现 orphan 分支。
- 公共消息 append 失败不应推进 state.round.usedMessages 和 sequence。

**当前实现：**

- User Persona 后续公共消息 append 失败后，用 `SessionManager.setSessionFile(sessionPath)` 从磁盘重新加载。
- Character `speak` append 失败后，同样重新加载 SessionManager，再返回 `success: false`。
- `setName()` 的 `appendSessionInfo()` 和 `setMaxMessages()` 的 `appendCustomEntry()` 失败后也会重新加载 SessionManager。
- append 失败不会推进 `persistedCount`，业务 state 只在 append 成功后提交。
- `setSessionFile()` 恢复失败时，Runtime 设置 `persistenceFatal = true`，后续 `submitUserPersonaMessage`、`setName`、`setMaxMessages` 和 `speak` 全部通过 `assertWritable()` 拒绝，不再落盘、更新 state 或广播。
- ESM 限制下无法 spy `node:fs.appendFileSync`，因此 leaf 污染测试通过 mock `appendCustomMessageEntry`/`appendSessionInfo`/`appendCustomEntry` 在 `_appendEntry` 执行前抛错来覆盖恢复路径。恢复后的 parentId 正确性通过 JSONL 断言验证。

**剩余要求：**

- 无。——BC-1 恢复路径、fatal 隔离、speak 拒绝、setName/setMaxMessages 恢复及 parentId 正确性均已通过测试验证。

**涉及组件：**

- `CreatorRuntime`（`appendCustomMessageEntry`、`appendSessionInfo` 和 `appendCustomEntry` 的全部调用路径）
- `SessionManager` (上游 _appendEntry 内部行为)

**当前检测：** `test/creator/creator-runtime.test.ts` 已覆盖公共消息、`setName()` 和 `setMaxMessages()` append 失败后的 SessionManager 恢复、恢复后 parentId 链回真实磁盘 leaf（JSONL 断言）、`setSessionFile()` 恢复失败进入 fatal 隔离，以及 fatal 后 speak 拒绝且不改变状态。ESM 限制下通过 mock `appendCustomMessageEntry`/`appendSessionInfo`/`appendCustomEntry` 在 `_appendEntry` 执行前抛错触发恢复路径。

---

## BC-2: 第一条公共消息中途失败留下半初始化 JSONL

**状态：** 已修复

**关联审查条目：** M3 第 2 条（"started 由至少一条公开消息推导，无公开消息不留下 JSONL"）

**发生条件：**

首次 `submitUserPersonaMessage()` 执行顺序：

1. writeFile → 创建 JSONL header
2. append 名称 custom entry
3. append settings custom entry
4. append 第一条 public message custom entry

如果步骤 1–3 全部成功，但步骤 4 的 public message append 失败：

- JSONL 文件已存在且包含 header + 名称 + settings
- round 仍为 null
- persistedCount > 0
- 关闭群聊时不会删除该文件

**预期行为：**

- 首次 public message append 失败时，删除该 JSONL 文件，恢复到写入前的空状态。

**当前实现：**

- 首次初始化使用 bit flags 记录 header、SessionManager 打开、名称、设置和公共消息的完成状态。
- Bit flags 在操作前设置（HEADER_WRITTEN 在 writeFile 前、SESSION_OPENED 在 setSessionFile 前），确保即使操作部分失败也会触发对应清理。
- rollback 删除文件失败时不再静默忽略，而是设置 `persistenceFatal = true` 并抛错，阻止后续写操作。
- rollback 本身失败时，原始持久化错误作为 `cause` 保留在抛出的错误中。
- 失败路径会 await `rollbackFirstPersist()` 完成后再让当前 queue task rejected，下一任务不会与正常 rollback 并发。
- 已有测试覆盖部分初始化失败后重试。

**剩余问题：**

- 无。——BC-2 三个实现问题均已修复，剩余要求 1-5 均已满足。

**涉及组件：**

- `CreatorRuntime.submitUserPersonaMessage()`
- `SessionManager`
- 空群聊 JSONL 生命周期（persistence.md, interaction-model.md）

**当前检测：** 已覆盖 `writeFile()` rejected（首次持久化失败不提交状态）、public message append 失败后 rollback 不留下 JSONL、正常 rollback 后重试只产生一个 JSONL、`setSessionFile()` 恢复失败进入 fatal 隔离（后续写操作全部拒绝）、`rm()` 失败进入 fatal（`deps.rm` 注入验证）、首次持久化失败后直接 close 不留下半初始化 JSONL。

---

## BC-3: WebSocket 广播 timestamp 与 JSONL entry timestamp 不一致

**状态：** 已修复

**关联审查条目：** M3 第 2 条、第 6 条

**发生条件：**

代码在调用 SessionManager 前用 `new Date()` 生成候选 `timestamp`。append 成功后通过 `getEntry(entryId)` 读取原生 `entryTimestamp`。

**当前实现：**

- User Persona 和 Character append 成功后均通过 `getEntry(entryId)` 取得原生 `entryTimestamp`。
- `publicMessages`、TUI 投影和 WebSocket broadcast 均使用该原生 timestamp。
- 两条路径均有广播 timestamp 与 JSONL envelope timestamp 的精确相等断言。

**预期行为：**

- 同一条公共消息的 timestamp 在广播、JSONL 和 publicMessages 中完全一致。

**测试要求：**

- User Persona 路径已补 JSONL 与广播 timestamp 精确相等断言（`test/creator/creator-runtime.test.ts` 广播测试中 `publicMessage.timestamp === entry.timestamp`、`event_id === entry.id`）。
- `details.timestamp` 是另一项独立的持久化契约偏差，见 BC-19。

**涉及组件：**

- `CreatorRuntime.handleSpeak()` 和 `submitUserPersonaMessage()`
- `SessionManager._appendEntry()`
- `renderers.ts`

---

## BC-4: tavern_speak active-tools 启停缺少测试断言

**状态：** 已修复

**关联审查条目：** M3 第 11 条

**已验证行为：**

- 进入 Character 状态后增量添加 `tavern_speak`。
- 离开 Character 状态后只移除 `tavern_speak`。
- 已有其他 active tools 保持不变。
- 工具已经处于目标状态时不重复调用 `setActiveTools()`。

**预期行为：**

- `tavern_speak` 的生命周期与 Character 正式在线状态严格绑定。
- 增量添加和移除，不覆盖其他工具的活跃状态。

**涉及组件：**

- `index.ts` 中的 `syncActiveTools()`
- `TavernController` 状态机
- `ExtensionAPI.getActiveTools()` / `setActiveTools()`

**当前检测：** `test/extension.test.ts` 已覆盖增量添加、增量移除、保留其他工具以及无变更时不调用 `setActiveTools()`。

---

## BC-5: session_shutdown(quit) 未实现优雅退出

**状态：** 已修复（M5）

**关联设计文档：**

- `interaction-model.md` → 退出、异常和恢复
- `extension-architecture.md` → Runtime 统一清理接口
- `implementation-plan.md` → M5：pi 生命周期完整对齐

**文档要求：**

> pi 正常退出并触发 `session_shutdown(reason: "quit")` 时，PiTavern 先退出或关闭群聊，再允许 pi 继续退出。清理最多等待 5 秒；超时后停止等待远端确认并强制完成本地 WebSocket 清理。

**当前状态：**

在 `src/index.ts` 和 `src/controller/tavern-controller.ts` 中搜索 `session_shutdown` 无任何结果。该事件未被注册处理。

**缺失行为：**

1. 无 `pi.on("session_shutdown", ...)` 监听器
2. 无法在 pi 退出前对所有非 idle 状态执行统一清理
3. 缺少 5 秒超时后强制清理的定时逻辑

**预期实现：**

- 在 `src/index.ts` 注册 `session_shutdown` handler。
- `creator`、`character` 和 `joining` 都通过 Controller 的统一清理入口；只有 `idle` 可以直接放行。
- 超时不仅停止等待，还必须显式强制完成本地 WebSocket、reservation 和活动描述清理。单独使用 `Promise.race()` 不等于强制清理。

**涉及组件：**

- `src/index.ts`（事件注册）
- `TavernController`（leave/close 入口）
- `CreatorRuntime`、`CharacterRuntime`（远程通知和清理）

**当前检测：** 无测试。本项按 M5 的组件测试和真实进程验收计划实现，不阻塞 M3。

---

## BC-6: WebSocket send 失败静默吞下、不触发断线清理

**状态：** 已修复（M5）

**关联设计文档：**

- `websocket-protocol.md` → 广播
- `implementation-plan.md` → M5 的全部异常清理

**文档要求：**

> 广播发生时，每个拥有活动 WebSocket 连接的 Character 都必须收到该消息。
> 向某个连接发送失败时，该 Character 转入断线处理流程；不能静默跳过并继续将其视为在线。

**当前实现：**

`src/creator/creator-runtime.ts` 的 `send()`：

```typescript
private send(socket: WebSocket, message: unknown): void {
    try {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(encodeMessage(message));
        }
    } catch {
        // Per-socket failure must not affect other sockets or the caller
    }
}
```

catch 块为空——不触发断开清理、不移除 `onlineCharacters`、不广播 `character_left`。

**预期行为：**

- send 失败时，通过 connection context 找到对应 sessionId。
- 将失败连接的清理排入 runtime queue，调用统一断线清理并广播 `character_left`。
- 清理期间从连接集合移除失败 socket，避免 `character_left` 广播再次命中同一连接并递归失败。

**涉及组件：**

- `CreatorRuntime.send()`
- `CreatorRuntime.removeOnlineCharacter()`

**当前检测：** 无测试。测试需要同时覆盖：

- `socket.send()` 同步抛错；
- send callback 异步返回错误；
- 发送前 socket 已不再是 `OPEN`；
- 清理广播不会递归命中同一失败连接。

---

## BC-7: closePermanently 不在 enqueue 队列中

**状态：** 已修复（M5）

**关联设计文档：**

- `extension-architecture.md` → Runtime 任务串行化、Runtime 统一清理接口
- `implementation-plan.md` → M5：pi 生命周期完整对齐

**发生条件：**

`CreatorRuntime.closePermanently()` 在调用处未经过 `enqueue()`。它的执行顺序是：

1. `disposed = true`
2. broadcast `group_chat_closed`
3. 逐一 `socket.close()`
4. `closeWebSocketServer()`
5. 清理 Map 和活动描述

上述全部操作未排入串行队列。如果存在正在处理的 pending frame（如 `handleSpeak` 正在 append 到 SessionManager），close 操作会与之交错执行。

**可能的交错场景：**

1. `handleSpeak` 已通过额度检查、正在 `appendCustomMessageEntry`
2. `closePermanently` 设置 `disposed = true` 并广播 `group_chat_closed`
3. `handleSpeak` 的 append 完成、更新 state、广播——但服务器正在关闭
4. 消息已持久化但广播可能部分到达或未到达

**预期行为：**

- 先关闭新任务入口并标记 lifecycle，避免新的 frame 入队。
- drain 当前 runtime queue，最多等待统一短期协调超时。
- 超时后强制清理本地资源；已经持久化的消息不回滚。
- 不应简单地在任意上下文中把 `closePermanently()` 再次 enqueue，以免从队列任务内部调用关闭时产生自等待。

**涉及组件：**

- `CreatorRuntime.closePermanently()`
- `CreatorRuntime.enqueue()`

**当前检测：** 无测试覆盖 close 与 speak 的交错时序。本项不阻塞 M3。

---

## BC-8: reload handoff 未实现

**状态：** 已修复（M5）

**关联设计文档：**

- `interaction-model.md` → reload 与 session 生命周期
- `extension-architecture.md` → reload handoff
- `implementation-plan.md` → M5：pi 生命周期完整对齐

**文档要求：**

> reload handoff 必须在 5 秒内由新 Extension Runtime 接管；超时后释放全部 handoff 资源，随后加载的 Runtime 从 idle 开始，不自动恢复。

> registry 使用 globalThis 上的 PiTavern 私有 Symbol.for(...) key 保存一次性槽位，使重新加载后的扩展代码可以取得旧 Runtime 发布的底层资源。

**当前状态：**

搜索 `handoff`、`reload`、`Symbol.for`、`globalThis` 在所有源文件中零匹配。

- 无 `ReloadHandoffRegistry`
- 无 `CreatorReloadHandoff` / `CharacterReloadHandoff`
- 无全局槽位保存机制
- 无 5 秒超时和超时后清理逻辑

**预期实现：**

1. 创建 `src/controller/reload-handoff-registry.ts`
2. 定义 `Symbol.for("pi-tavern.reload-handoff")`
3. 旧 Extension Runtime 仅在收到 reload shutdown/detach 信号时 publish handoff
4. 新 Extension Runtime activate 时尝试 take handoff
5. 5 秒超时后自动清理

**涉及组件：**

- `src/controller/reload-handoff-registry.ts`（新建）
- `src/index.ts`（activate 时 take）
- `CreatorRuntime`、`CharacterRuntime`（publish 接管资源）

**当前检测：** 无。按 M5 增加组件测试，并在 M6 使用真实 reload 进程场景验收；不阻塞 M3。

---

## BC-9: 1 MiB WebSocket frame 上限——客户端侧检查

**状态：** 已满足

**关联设计文档：** `websocket-protocol.md` → 消息大小

**文档要求：**

> 1 MiB frame 上限同时配置在 WebSocket Server 和 Character 客户端；发送前的 codec 也必须检查编码结果，不能只依赖接收方断开。

**当前实现：**

- Creator 的 `WebSocketServer` 使用 `maxPayload: MAX_WEBSOCKET_FRAME_BYTES`。
- Character 的 `JoinAttempt` 使用客户端选项 `maxPayload: MAX_WEBSOCKET_FRAME_BYTES`；转交给 `CharacterRuntime` 后沿用同一 socket。
- 群聊发现使用的临时 WebSocket 同样配置 1 MiB `maxPayload`。
- `encodeMessage()` 在发送前检查 UTF-8 编码结果不超过 1 MiB。
- `ws` 8.x 的客户端 `new WebSocket(address, options)` 支持 `ClientOptions.maxPayload`，该选项不是服务端专属。

**涉及组件：**

- `src/protocol/codec.ts`（encode 检查）
- `src/creator/creator-runtime.ts`（server maxPayload）
- `src/character/character-runtime.ts`（客户端接收）

---

## BC-10: speak 持久化成功但响应发送超时——消息不回滚

**状态：** 已满足，测试已覆盖（M6 补测）

**关联设计文档：**

- `websocket-protocol.md` → 超时与发言响应
- `persistence.md` → 公开消息提交顺序

**文档要求：**

> 服务端对已经完成持久化提交的公开消息不因响应发送超时而回滚。Character 如果没有取得成功响应，只能以后从公开广播或历史中观察该消息是否已经提交，首版不自动重试同一 speak，避免重复公开。

**当前实现：**

`handleSpeak` 的执行顺序是：
1. appendCustomMessageEntry（持久化）
2. 更新 GroupChatState（usedMessages++）
3. broadcast（广播给所有 Character）
4. send response（返回给发送者）

如果步骤 4 的响应未送达，步骤 1–3 已完成，不会回滚。这与文档一致。这里的“超时”是 CharacterRuntime 等待请求响应超时，不是服务端 `socket.send()` 自身提供了响应超时。

**需确认：**

- 是否有测试验证"speak 持久化后 send 响应失败，消息仍然广播给其他 Character"？
- CharacterRuntime 在请求超时时是否正确处理"未收到响应但消息可能已生效"的情况？

**涉及组件：**

- `CreatorRuntime.handleSpeak()`
- `CharacterRuntime`（请求超时处理）

---

## BC-11: Creator 异常退出——无 group_chat_closed 广播

**状态：** 设计已接受

**关联设计文档：**

- `websocket-protocol.md` → 群聊关闭与异常退出
- `interaction-model.md` → 退出、异常和恢复

**文档要求：**

> 群聊创建者异常退出时无法发送关闭广播。加入方通过 WebSocket 断开退出当前群聊。恢复群聊时会建立新的活动实例和成员关系，不恢复旧连接。

> 强杀、崩溃和断电无法保证执行正常退出流程，依靠 WebSocket close、心跳超时和活动描述发现机制收敛。

**当前实现：**

- CharacterRuntime 通过 `socket.on("close", ...)` 检测断开
- `finishDisconnected(new Error("PiTavern connection closed"))` 触发本地清理
- CharacterRuntime 不依赖 `group_chat_closed` 广播作为退出信号

这是正确的设计权衡。不需要额外实现。

**涉及组件：**

- `CharacterRuntime`（close 事件 → finishDisconnected）
- `JoinAttempt`（close 事件 → 释放并回到 idle）

**当前检测：** 现有测试覆盖了 WebSocket close 触发 cleanup 的路径。

---

## BC-12: character_joined 事件对加入者本人因消息顺序会从首次环境批次丢失

**状态：** 已修复，测试已覆盖（M6 补测）

**关联设计文档：**

- `interaction-model.md` → Character 加入和群聊环境
- `websocket-protocol.md` → Character 加入广播

**原问题：**

协议原先要求 Creator 先广播 `character_joined`，再向新 Character 发送 `message_history`。加入者处理 `character_joined` 时尚不知道群聊已有公开消息，`hasPublicMessages` 为 false，导致自己的加入事件被过滤。

**当前实现：**

- Creator 改为先向加入者发送 `message_history`，再向全部连接广播 `character_joined`。
- 非空历史会先让 `hasPublicMessages` 变为 true，因此随后到达的加入事件能够进入同一个防抖批次。
- 空历史不会启动批次，随后加入事件仍被过滤，符合 empty 群聊不触发 Agent run 的要求。
- `websocket-protocol.md` 已正式采用 history → joined 顺序：历史是加入前的上下文，加入事件是其后的实时环境变化。

**测试要求：**

- started 群聊中，新 Character 的首次 `sendMessage()` 同时包含最近历史和自己的加入事件。
- `details.events` 中历史 `public_message` 保持历史顺序，并排在 `character_joined` 之前。
- empty 群聊中，空历史和自己的加入事件不触发 `sendMessage()`。
- 其他在线 Character 仍只收到一次 `character_joined`。

**涉及组件：**

- `CreatorRuntime`——`character_ready` 消息发送顺序
- `GroupChatInput.isEnvironmentEvent()`——`hasPublicMessages` 守卫
- `CharacterRuntime.hasPublicMessages`——通过 `message_history` 设置

**当前检测：** Creator lifecycle 测试已断言 history → joined；尚缺非空历史下首次 GroupChatInput 批次的集成测试。

---

## BC-13: JSONL header timestamp 与 created_at 不一致

**状态：** 已修复

**关联设计文档：**

- `persistence.md` → pi session header
- `websocket-protocol.md` → 获取群聊状态

**当前实现：**

- `createdAt` 在 `CreatorRuntime.startNew()` 中只生成一次，并用于 GroupChatState 和 active descriptor。
- 第一条消息落盘时，用该 canonical `createdAt` 覆盖 SessionManager 内存 header 的 timestamp。
- rollback 后即使重建 SessionManager，下一次首次落盘仍使用同一个 `state.groupChat.createdAt`。
- 测试已精确断言 JSONL header timestamp 等于 GroupChatState `createdAt`。

**涉及组件：**

- `CreatorRuntime.startNew()`
- 首次落盘 header 投影
- 首次提交失败 + rollback 路径

**当前检测：** 已覆盖首次正常落盘的精确相等；rollback 后重试仍由同一代码路径保证，可补专门断言但不再是实现缺口。

---

## BC-14: publishDescriptor 失败后留下空 JSONL 文件

**状态：** 已满足

**误报原因：**

`SessionManager.create()` 只创建 session 目录和内存 header，不创建 JSONL 文件。文件真正落盘发生在第一条 User Persona 消息的首次持久化路径，而 `publishDescriptor()` 在此之前完成。

`test/creator/creator-runtime.test.ts` 已覆盖该场景——mock `publishDescriptor()` 失败后断言 JSONL 不存在。

最多留下空的 session 目录，不违反"空群聊不留下 JSONL"的约定。

---

## BC-15: GroupChatInput.flush() 中 sendMessage 异常处理

**状态：** 已满足

**排查结论：**

`pi.sendMessage()` 在 pi 原生 `AgentSession` runtime binding 中已内置 `.catch()` 处理器：

```javascript
sendMessage: (message, options) => {
    this.sendCustomMessage(message, options).catch((err) => {
        runner.emitError({...});
    });
},
```

- `sendMessage` 返回 `void`，调用 `sendCustomMessage` 后立即返回，不等待异步结果。
- 所有异步失败（包括 `sendCustomMessage` 内部 `_runAgentPrompt` 抛错）被 `.catch()` 吸收，通过 `runner.emitError()` 上报。
- `sendCustomMessage` 是 `async` 函数，无法同步抛错——即使内部 throw，也变成 rejected Promise 被 `.catch()` 捕获。
- 唯一同步抛错场景是 `this.sendCustomMessage` 本身不是函数，这在正常运行时不存在。

因此 `void this.flush()` 不会造成未处理的 Promise rejection：`getGroupChatState` 已被 try-catch 包住，`sendMessage` 不会同步抛错。

该结论只说明错误由 pi 原生层上报，不代表批次会自动重试。批次在调用 `sendMessage()` 前已经从 `this.batch` 移除；如果 pi 原生提交失败，本批 events 可能丢失，后续环境消息只能形成新批次，不能补回旧 events。首版接受由 pi 原生错误通道报告且不自行实现重试队列。

---

## BC-16: WebSocket 心跳未实现

**状态：** 已修复（M5）

**关联设计文档：**

- `websocket-protocol.md` → 连接心跳
- `development-conventions.md` → 超时与时间常量
- `implementation-plan.md` → M5：pi 生命周期完整对齐

**文档要求：**

> 心跳超时只用于兜底检测半开连接，不是重连窗口。心跳失败后不自动重连，统一执行 `disconnected` 清理。

> 心跳仍使用独立确定的 30 秒 ping 间隔和 120 秒失效阈值。

**当前状态：**

`src/` 和 `test/` 中搜索 `ping`、`pong`、`heartbeat`、`keepalive`、`isAlive` 全部零匹配。ws 库不自动发送 ping——必须显式实现。

**缺失行为：**

- Creator 不向已连接 Character 发送 WebSocket ping
- Character 由 ws 自动回复 pong，但不检测 120 秒未收到 Creator ping
- 半开连接（TCP 看似存活但对端已死）不会被检测到
- Creator 会继续向已死连接广播消息并认为该 Character 在线

**预期实现：**

- Creator 侧：`WebSocketServer` 定时（30s）向每个连接发送 ping；120s 未收到 pong 则主动关闭连接并触发 `disconnected` 清理
- Character 侧：ws 库自动回复 pong；PiTavern 必须记录最近一次 Creator ping，并在 120 秒未收到 ping 时主动终止连接

**涉及组件：**

- `CreatorRuntime`（ping 定时器、pong 超时检测）
- `CharacterRuntime`（Creator ping 时间记录和 120 秒超时检测）

**当前检测：** 无测试。本项由 `implementation-plan.md` 明确归入 M5，不阻塞 M3；M5 需要分别验证 Creator 未收到 pong 和 Character 未收到 ping 的清理路径。

---

## BC-17: Agent 调用 tavern_speak 时 Character 已断开

**状态：** 已满足，测试已覆盖（M6 补测）

**排查结论：**

断开时序：WebSocket close → `finishDisconnected` → 异步 `handleConnectionClosed`（transition lock）→ state 变 idle → `syncActiveTools` 移除工具。

但 active tools 只影响工具列表可见性，当前 Agent run 已加载的工具定义不受影响。真正的保护在 execute 函数：

```typescript
const state = ctrl.getState();
if (state.type !== "character") {
    return { isError: true, ... };
}
```

Controller 尚未完成 idle transition 的短暂窗口内，工具仍可能读到 `character` 状态；此时 `CharacterRuntime.request()` 会因 socket 已关闭而拒绝，工具返回发送失败。Controller 已进入 idle 后则由 execute 的 state 检查直接拒绝。

**当前检测：** 已覆盖 idle 状态拒绝；尚需覆盖 Runtime 已断开但 Controller 尚未完成 idle transition 的窗口。

---

## BC-18: started 状态下 setMaxMessages 先持久化后校验

**状态：** 已修复

**关联设计文档：**

- `persistence.md` → 群聊设置
- `extension-architecture.md` → Runtime 任务串行化

**排查结论：**

`CreatorRuntime.enqueue()` 的串行化和失败隔离行为正确：

```typescript
const task = this.runtimeTail.then(operation);
this.runtimeTail = task.then(
    () => undefined,
    () => undefined,
);
```

- 后一个任务只在前一个任务 settle 后开始。
- 前一个任务 rejected 不会永久阻塞队列。
- 队列不负责事务回滚；失败任务必须在 settle 前恢复 SessionManager、业务 state 和派生计数，使后一个任务看到一致状态。

公共消息、`setName()` 和 `setMaxMessages()` 的磁盘 append 失败路径已经恢复 SessionManager。因此问题不在 enqueue，而在 mutation 之前是否完成全部校验。

**发生条件：**

通过命令调用 `/tavern-set-max` 时，命令层会先校验非负安全整数，正常用户路径不会触发本问题。但 `CreatorRuntime.setMaxMessages()` 本身仍是可直接调用的状态修改入口。

群聊进入 started 状态后，当前执行顺序是：

1. `appendCustomEntry("pi-tavern.group-settings", ...)` 持久化新设置；
2. `persistedCount++`；
3. `setGroupMaxMessages()` 调用 `assertValidMaxMessages()`；
4. 参数无效时抛错，业务 state 不更新。

直接调用 `runtime.setMaxMessages(-1)` 时，无效设置可能已经进入 JSONL，`persistedCount` 也已推进，然后任务才 rejected。队列会正常执行下一任务，但下一任务观察到的是“内存仍为旧设置、磁盘最后一条设置为无效值”的不一致状态。

empty 状态没有该问题，因为该分支在修改 state 前直接调用 `setGroupMaxMessages()`，校验先于 mutation。

**预期行为：**

- Runtime 自身必须在 empty/started 分支和任何持久化操作之前校验 `maxMessages`。
- 无效参数不得追加 entry、推进 `persistedCount` 或修改业务 state。
- 校验失败后，下一项 runtime queue task 应观察到与失败前完全相同的内存和磁盘状态。

**实现要求：**

- 将非负安全整数校验提升到 `setMaxMessages()` queue operation 的开头，或暴露可复用的纯校验函数并在持久化前调用。
- 保留 `setGroupMaxMessages()` 内部校验作为 state helper 的防御性保护。

**涉及组件：**

- `CreatorRuntime.setMaxMessages()`
- `setGroupMaxMessages()` / `assertValidMaxMessages()`
- Runtime queue 的失败后状态不变式

**当前实现：**

- `assertValidMaxMessages` 已导出（`group-chat-state.ts`），并在 `CreatorRuntime.setMaxMessages()` queue operation 开头调用，先于 empty/started 分支和任何持久化操作。
- `setGroupMaxMessages()` 内部保留同一校验作为 state helper 的防御性保护。
- 无效参数不再追加 entry、推进 `persistedCount` 或修改业务 state；校验失败后下一项 runtime queue task 观察到与失败前完全相同的内存和磁盘状态。

**当前检测：** `test/creator/creator-runtime.test.ts` 新增 BC-18 测试——started 状态下直接调用 `setMaxMessages(-1)`、`1.5`、`NaN`、`MAX_SAFE_INTEGER + 1` 全部拒绝，JSONL 内容、`persistedCount` 和 `groupMaxMessages` 保持不变，随后一条合法 `setMaxMessages(5)` 正常成功。

---

## BC-19: public-message details 保存了第二套 timestamp

**状态：** 已修复

**关联设计文档：** `persistence.md` → 公开消息

**发生条件：**

User Persona 和 Character 公共消息在调用 `appendCustomMessageEntry()` 前生成候选 `timestamp`，并把它写入 `details.timestamp`。SessionManager 随后独立生成 entry envelope 的原生 timestamp。

append 成功后，广播、TUI 和历史缓存已经改用原生 `entry.timestamp`，但 JSONL 内仍可能同时存在两个不同时间：

- `entry.timestamp`：协议和恢复使用的权威时间；
- `entry.details.timestamp`：append 前生成、未在持久化结构中约定的冗余时间。

**预期行为：**

- 公开消息只使用 entry envelope 的原生 timestamp。
- `details` 只保存不能从 envelope 直接取得的 sender、content、sequence 和 Round 快照。
- 同一 entry 中不保留含义重复且可能不一致的第二套 timestamp。

**实现要求：**

- 已从 User Persona 和 Character 两条 append 路径移除 `details.timestamp`，`details` 只保存 sender、content、sequence 和 Round 快照（与 `persistence.md` 的 details 结构一致）。
- 测试已改为断言 `details.timestamp` 不存在（`toBeUndefined`）。
- 恢复和 WebSocket 转换始终读取 entry envelope 的 `entry.timestamp`。

**涉及组件：**

- `CreatorRuntime.submitUserPersonaMessage()`
- `CreatorRuntime.handleSpeak()`
- `persistence.md` 的 public-message details 结构

**当前检测：** 测试断言 `details.timestamp` 不存在（`toBeUndefined`），并保留 envelope、广播和 TUI timestamp 的交叉一致性测试。

## BC-20: interactive 模式 abort 清空已入队 steer——游标已推进则消息永丢（已知边界）

**状态：** 已知边界（2026-08-03 J2 实证，无版本差异，接受处置）

**背景：**

- pi-tavern 游标语义：投递入队成功（pi 侧 steer/followUp 同步入队）即推进游标（`sendWithDeliveryAck` 乐观推进），上下文实际到达不可感知（入队成功 ≠ 上下文到达）。
- pi interactive 模式：用户 Esc/abort 触发 `restoreQueuedMessagesToEditor` → `clearQueue` 清空已入队未投递 steer（0.82.1 与 0.83.0 同构，三触发点：abortHandler / uiContext abort / Esc 键）。
- 组合盲区：忙态 run 中 steer 入队（游标已推进）→ 用户 abort → 已入队 steer 被清空 → 消息永丢且 settle 感知不到（游标已过，无兜底重投）。

**实证（2026-08-03 QA，J2 双版本对比）：**

- RPC 模式：abort 不清队列（pendingMessageCount 保留）——0.82.1/0.83.0 行为一致，acceptance 钉测 `j2-rpc-abort-no-loss.test.ts` 固化（默认锚定 references/pi）。
- `clearQueue` 清空仅存在于 interactive 模式（编辑器恢复路径），两版本触发面同构。
- 0.82.1→0.83.0 共 176 commits，无 abort/queue/steer 相关变更。
- 结论：版本差异实锤不成立；升级 pi 上游 issue 路径关闭（PM 分叉判定 2026-08-03）。

**影响面：** interactive 模式 + 忙态 run + 用户 abort 三条件同时成立时，入队未达消息可能永丢。窗口极小（abort 发生在入队后、工具间隙投递前）；RPC/headless 模式无此路径。处置 = 接受（与推进路径写失败残余风险同阶，Arch best-effort 裁决精神一致）。

**涉及组件：**

- `GroupChatInput.sendWithDeliveryAck()`（乐观游标推进）
- pi interactive 模式 `clearQueue()` / `restoreQueuedMessagesToEditor()`（外部行为，pi 侧）

**当前检测：** RPC abort 不清队列由钉测固化；interactive 盲区不可在验收环境演练（无交互 abort 路径），以本条目留痕。
