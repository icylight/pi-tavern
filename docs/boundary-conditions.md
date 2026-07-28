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

**状态：** 部分修复（阻塞 M3 — setName/setMaxMessages 路径）

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

- User Persona 后续公共消息 append 失败后，会用 `SessionManager.setSessionFile(sessionPath)` 从磁盘重新加载。
- Character `speak` append 失败后，同样会重新加载 SessionManager，再返回 `success: false`。
- **`setName()` L180** 的 `appendSessionInfo()` 失败后没有恢复——写盘失败但 leaf 已污染。
- **`setMaxMessages()` L207** 的 `appendCustomEntry()` 失败后同样没有恢复。
- 下一条成功消息可能把 parentId 指向磁盘上不存在的 entry，形成断链。

**剩余要求：**

- `setName` 和 `setMaxMessages` 的 append 失败后必须执行与公共消息路径相同的 SessionManager 恢复。
- 恢复后重新计算 `persistedCount`，或移除该派生计数，避免它与磁盘状态分离。

**涉及组件：**

- `CreatorRuntime`（`appendCustomMessageEntry`、`appendSessionInfo` 和 `appendCustomEntry` 的全部调用路径）
- `SessionManager` (上游 _appendEntry 内部行为)

**当前检测：** 公共消息路径的 spy 测试验证了业务 state 不提交。名称和设置路径无失败恢复测试。

---

## BC-2: 第一条公共消息中途失败留下半初始化 JSONL

**状态：** 待修复（阻塞 M3）

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

**当前问题：**

- 首次初始化使用 bit flags 记录 header、SessionManager 打开、名称、设置和公共消息的完成状态。
- 失败后在 catch 块调用 `this.rollbackFirstPersist(sessionPath)`，**但没有 `await`（L276）**。
- 回滚内部的 `rm()` 是异步操作；当前 queue task 已通过 `throw error` 失败退出，下一个 queue task 可以开始。
- 未 await 的 rollback 可能与下一个任务产生竞态：删除新任务刚写入的 JSONL、在新任务运行期间替换 `groupSessionManager`、产生内存状态、`persistedCount` 与磁盘文件不一致。

**剩余要求：**

1. 必须 `await this.rollbackFirstPersist(sessionPath)`。
2. 补充"部分初始化失败后重试"的测试，覆盖 rollback 未完成时下一次提交的场景。

**涉及组件：**

- `CreatorRuntime.submitUserPersonaMessage()`
- `GroupSessionManager`
- 空群聊 JSONL 生命周期（persistence.md, interaction-model.md）

**当前检测：** 无测试覆盖 header/名称/settings 成功后 public message 失败，也无测试覆盖异步 rollback 的竞态时序。

---

## BC-3: WebSocket 广播 timestamp 与 JSONL entry timestamp 不一致

**状态：** 部分修复（阻塞 M3 — broadcast 仍用旧值）

**关联审查条目：** M3 第 2 条、第 6 条

**发生条件：**

代码在调用 SessionManager 前用 `new Date()` 生成候选 `timestamp`。append 成功后通过 `getEntry(entryId)` 读取原生 `entryTimestamp`。

**当前问题：**

- `publicMessages` 缓存使用 `entryTimestamp` ✅
- TUI 投影使用 `entryTimestamp` ✅
- **broadcast 仍传入候选 `timestamp`，而非 `entryTimestamp`（L713）** ❌

两个时间戳相差 ≥1ms 时，实时广播与以后从群聊记录恢复的同一条消息 timestamp 不一致。

**预期行为：**

- 同一条公共消息的 timestamp 在广播、JSONL 和 publicMessages 中完全一致。

**剩余要求：**

- 广播字段应直接使用 `entryTimestamp`。
- 增加精确相等断言：同一条消息的 JSONL envelope.timestamp === 广播 timestamp === TUI projection timestamp。

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

**状态：** 计划于 M5

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

**状态：** 计划于 M5

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

**状态：** 计划于 M5

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

**状态：** 计划于 M5

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

**状态：** 已满足，待补测试

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
