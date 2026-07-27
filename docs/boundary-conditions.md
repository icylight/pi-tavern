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
