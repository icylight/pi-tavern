# PiTavern Boundary Conditions

本文记录从设计文档交叉审查中发现的边界条件、失败模式和不变约束。每一条记录发生条件、涉及组件和预期行为。

新增边界条件来自审查或线上发现时更新本文；已修复的条件不删除，追加"已修复"状态。

---

## 入口约定

- 本节记录不需要按单条测试的入口条件，如"第一条 User Persona 消息落盘成功才进入 started"——该约束由各规范文档定义，不重复记录。
- 本文只记录：经过多份文档交叉审查后仍存在实现缺口，或单一设计文档无法充分表达的跨组件边界。

---

## BC-1: SessionManager 内存 leaf 污染

**状态：** 待修复

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

**实现要求：**

- append 失败后，用 SessionManager.setSessionFile(sessionPath) 从磁盘重新加载，恢复内存 entries、索引和 leaf。
- 重新计算 persistedCount 以与磁盘保持一致。

**涉及组件：**

- `CreatorRuntime` (所有调用 appendCustomMessageEntry 的路径)
- `SessionManager` (上游 _appendEntry 内部行为)

**当前检测：** 现有测试通过 spy 在 _appendEntry 执行前抛错，未覆盖磁盘写入失败的真实顺序。

---

## BC-2: 第一条公共消息中途失败留下半初始化 JSONL

**状态：** 待修复

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
- 该文件违反"空群聊（无公开消息）不产生 JSONL"的设计约定

**预期行为：**

- 首次 public message append 失败时，删除该 JSONL 文件，或回滚到写入前的状态。
- 上一次成功的 SessionManager 应能从磁盘恢复。

**实现要求：**

- 首次初始化失败路径需要：
  1. 恢复到上一次成功状态的 SessionManager；
  2. 删除或回滚尚无公开消息的 JSONL 文件。

**涉及组件：**

- `CreatorRuntime.submitUserPersonaMessage()`
- `GroupSessionManager`
- 空群聊 JSONL 生命周期（persistence.md, interaction-model.md）

**当前检测：** 测试只覆盖了 `writeFile` 失败（header 创建失败），未覆盖 header/名称/settings 成功后 public message 失败。

---

## BC-3: WebSocket 广播 timestamp 与 JSONL entry timestamp 不一致

**状态：** 待修复

**关联审查条目：** M3 第 2 条、第 6 条

**发生条件：**

- 代码在调用 SessionManager 前用 `new Date()` 生成 timestamp。
- SessionManager._appendEntry() 创建 entry 时再次调用 `new Date()`。
- 广播和 publicMessages 缓存使用前者，JSONL envelope 使用后者。

两个时间戳相差 ≥1ms 时，实时广播中的 timestamp 与以后从群聊记录恢复的同一条消息 timestamp 不一致。

**预期行为：**

- 同一条公共消息的 timestamp 在广播、JSONL 和 publicMessages 中完全一致。

**实现要求：**

- append 成功后通过 `getEntry(entryId)` 读取原生 entry 的 timestamp。
- 使用该 timestamp 进行广播、TUI 投影和 publicMessages 追加。

**涉及组件：**

- `CreatorRuntime.handleSpeak()` 和 `submitUserPersonaMessage()`
- `SessionManager._appendEntry()`
- `renderers.ts`（TUI 投影使用时间戳）

**当前检测：** 无测试区分"广播 timestamp"与"JSONL timestamp"是否为同一值。

---

## BC-4: tavern_speak active-tools 启停缺少测试断言

**状态：** 待修复

**关联审查条目：** M3 第 11 条

**发生条件：**

`syncActiveTools()` 的实现路径存在，但测试中未验证：

- 进入 Character 状态后 active tools 包含 `tavern_speak`
- idle、joining、creator 状态下 active tools 不包含 `tavern_speak`
- 主动离开和 WebSocket 断线后 active tools 移除了 `tavern_speak`
- 操作不覆盖其他扩展或用户启用的工具

**预期行为：**

- `tavern_speak` 的生命周期与 Character 正式在线状态严格绑定。
- 增量添加和移除，不覆盖其他工具的活跃状态。

**实现要求：**

- 组件测试覆盖四种状态下的 `getActiveTools()` 快照。
- 验证其他工具在启停操作前后保持不变。

**涉及组件：**

- `index.ts` 中的 `syncActiveTools()`
- `TavernController` 状态机
- `ExtensionAPI.getActiveTools()` / `setActiveTools()`

**当前检测：** 测试 mock 提供了 `getActiveTools` / `setActiveTools`，但未对启停行为做断言。

---

## BC-5: session_shutdown(quit) 未实现优雅退出

**状态：** 待实现

**关联设计文档：** `interaction-model.md` L66、`extension-architecture.md` L740-745

**文档要求：**

> pi 正常退出并触发 `session_shutdown(reason: "quit")` 时，PiTavern 先退出或关闭群聊，再允许 pi 继续退出。清理最多等待 5 秒；超时后停止等待远端确认并强制完成本地 WebSocket 清理。

**当前状态：**

在 `src/index.ts` 和 `src/controller/tavern-controller.ts` 中搜索 `session_shutdown` 无任何结果。该事件未被注册处理。

**缺失行为：**

1. 无 `pi.on("session_shutdown", ...)` 监听器
2. 无法在 pi 退出前执行 `ctrl.leave()`（Character）或 `runtime.close()`（Creator）
3. 缺少 5 秒超时后强制清理的定时逻辑

**预期实现：**

- 在 `src/index.ts` 注册 `session_shutdown` handler
- 区分当前状态：creator → close 群聊、character → leave 群聊、idle/joining → 直接放行
- 包装 `Promise.race([cleanup, timeout(5000)])` 保护 pi 退出不被阻塞

**涉及组件：**

- `src/index.ts`（事件注册）
- `TavernController`（leave/close 入口）
- `CreatorRuntime`、`CharacterRuntime`（远程通知和清理）

**当前检测：** 无测试。端到端测试可通过启动真实 pi 进程然后发送 quit 信号验证。

---

## BC-6: WebSocket send 失败静默吞下、不触发断线清理

**状态：** 待修复

**关联设计文档：** `websocket-protocol.md` L93-97

**文档要求：**

> 广播发生时，每个拥有活动 WebSocket 连接的 Character 都必须收到该消息。
> 向某个连接发送失败时，该 Character 转入断线处理流程；不能静默跳过并继续将其视为在线。

**当前实现：**

`src/creator/creator-runtime.ts` L881-887：

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

- send 失败时，通过 connectionContext 找到对应 sessionId
- 调用 `removeOnlineCharacter(connection, "disconnected")` 触发清理
- 广播 `character_left` 给剩余在线 Character

**涉及组件：**

- `CreatorRuntime.send()`
- `CreatorRuntime.removeOnlineCharacter()`

**当前检测：** 无测试。需要用 mock WebSocket 让 `socket.send` 抛错。

---

## BC-7: closePermanently 不在 enqueue 队列中

**状态：** 待修复

**关联设计文档：** `extension-architecture.md` L676-684（串行任务队列）

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

- `closePermanently` 的核心逻辑应通过 `enqueue` 执行
- 确保所有 pending frame 完成后才关闭
- 或者在关闭前 drain 队列

**涉及组件：**

- `CreatorRuntime.closePermanently()`
- `CreatorRuntime.enqueue()`

**当前检测：** 无测试覆盖 close 与 speak 的交错时序。

---

## BC-8: reload handoff 未实现

**状态：** 待实现

**关联设计文档：** `interaction-model.md` L65、`extension-architecture.md` L50-54

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
3. 在 `CreatorRuntime` / `CharacterRuntime` 初始化时 publish handoff
4. 在 `index.ts` extension activate 时尝试 take handoff
5. 5 秒超时后自动清理

**涉及组件：**

- `src/controller/reload-handoff-registry.ts`（新建）
- `src/index.ts`（activate 时 take）
- `CreatorRuntime`、`CharacterRuntime`（publish 接管资源）

**当前检测：** 无。需要 reload 场景的端到端测试。

---

## BC-9: 1 MiB WebSocket frame 上限——客户端侧检查

**状态：** 需确认

**关联设计文档：** `websocket-protocol.md` L77

**文档要求：**

> 1 MiB frame 上限同时配置在 WebSocket Server 和 Character 客户端；发送前的 codec 也必须检查编码结果，不能只依赖接收方断开。

**当前实现：**

- `creator-runtime.ts` L49：`MAX_WEBSOCKET_FRAME = 1_048_576` 用于 `WebSocketServer({ maxPayload: ... })`
- `character-runtime.ts`：`MAX_WEBSOCKET_FRAME` 在 WebSocket 客户端构造中使用
- `codec.ts` L91：`encodeMessage` 断言 `result.byteLength <= MAX_WEBSOCKET_FRAME`

**需确认：**

- Character 客户端 WebSocket 构造是否传入了 `maxPayload`？ws 库的 `new WebSocket(url)` 不支持 maxPayload——该选项仅服务端可用
- 代码中的 `codec.ts` encode 断言 + 服务端 server 配置已形成两层防护，但客户端侧如果接收超大 broadcast 消息，是否有保护？

**涉及组件：**

- `src/protocol/codec.ts`（encode 检查）
- `src/creator/creator-runtime.ts`（server maxPayload）
- `src/character/character-runtime.ts`（客户端接收）

---

## BC-10: speak 持久化成功但响应发送超时——消息不回滚

**状态：** 需确认测试

**关联设计文档：** `websocket-protocol.md` L68、`persistence.md` L264

**文档要求：**

> 服务端对已经完成持久化提交的公开消息不因响应发送超时而回滚。Character 如果没有取得成功响应，只能以后从公开广播或历史中观察该消息是否已经提交，首版不自动重试同一 speak，避免重复公开。

**当前实现：**

`handleSpeak` 的执行顺序是：
1. appendCustomMessageEntry（持久化）
2. 更新 GroupChatState（usedMessages++）
3. broadcast（广播给所有 Character）
4. send response（返回给发送者）

如果步骤 4 的 send 失败，步骤 1–3 已完成，不会回滚。这与文档一致。

**需确认：**

- 是否有测试验证"speak 持久化后 send 响应失败，消息仍然广播给其他 Character"？
- CharacterRuntime 在请求超时时是否正确处理"未收到响应但消息可能已生效"的情况？

**涉及组件：**

- `CreatorRuntime.handleSpeak()`
- `CharacterRuntime`（请求超时处理）

---

## BC-11: Creator 异常退出——无 group_chat_closed 广播

**状态：** 设计已接受

**关联设计文档：** `websocket-protocol.md` L428、`interaction-model.md` L67、L85-87

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
