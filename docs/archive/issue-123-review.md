# #123 方案评审（Arch，2026-08-08）

> **已归档**：评审留痕（#123 已合入，评审结论在 PR/issue 留痕，本文件全仓 0 引用）。
> 本文件不再维护，索引见 docs/README.md。

> 输入：PM 布置（分支 feat/welcome-system-message，基点 main=7fa5e2f）；QA 预研检查点 4 项；
> #132 开工前收敛第 3 条（system_message schema 与 #119 新信封统一设计）。
> 评审结论：无阻断项，可开工。本文覆盖 schema 形状、ready-pipeline 时序、hasPublicMessages
> 影响面、配置链落点四块 + 待办清单核对。

## 0. 基线核对

- main=7fa5e2f 含 #119（ed71515，vscode-jsonrpc 信封）与 #97（f6c7773，source 扩展位）——#123 前置依赖闭环；
- acceptance.md WL1–WL6 已落文（#132 收敛第 4 条 ✓）；
- 工作区干净，无 feat/welcome-system-message 分支——#123 未开工。

## 1. system_message schema（#132 收敛第 3 条）

```jsonc
{ "jsonrpc": "2.0", "method": "system_message", "params": { "content": "<string>" } }
```

1. **通知帧（无 id）**：与 character_joined / group_chat_update / board_update 同族；由 method 判别，
   不进请求/响应分支（与 #119 M2 dispatch 判别一致）。
2. **params 仅 content**（`additionalProperties:false` 严格校验）。无 sequence / round / source——
   非公共消息、不落消息流、不计轮次（WL1 语义）。
3. **与 #97 兼容（WL6）**：source 是 public_message 的字段，system_message 为独立 union 成员，
   互不引用、互不干扰；同一 ServerMessageSchema 判别域共存。
4. **METHOD_SYSTEM_MESSAGE 入 shared/messages.ts**（F 类判别常量，与 METHOD_* 同源——#119 M2 抽取惯例）。
5. **归属：send 单播给 ready 角色本人，非 broadcast**。欢迎语是个人化告知；broadcast 会让全员重复收帧。
6. **消费端 2 处小改（客户端认领，客户端核查 2026-08-08 12:42 修正 §1.6 初版「零改动」结论）**：
   - handleServerMessage 通知帧通用路径不变（push receivedMessages，帧层可达）；
   - 但下一跳 group-chat-input.start() handler 经 isEnvironmentEvent 白名单
     （:443，仅 public_message / message_history / board_update，default→return 丢弃）——
     system_message 命中 default 被丢弃，不进 pendingEvents，Agent 环境看不到欢迎文案；
   - 裁决：欢迎意图 = 替代原历史推送的可见性引导（原 message_history 会渲染进 buildContent），
     ｜仅帧层可断言不满足产品意图。消费端改 2 处：
     a) isEnvironmentEvent 加 `case METHOD_SYSTEM_MESSAGE: return true`（进 pendingEvents 批处理）；
     b) buildContent 加独立「系统消息」小节（渲染 content；不混入「新消息」小节——
        非公共消息、无 sender/sequence，WL1 语义）；
   - hasPublicMessages getter 不变：system_message 不算公共消息（不误判）。

## 2. ready-pipeline 时序

现状（重构前 = 同步 send 顺序）：ready 响应 → `setImmediate{ message_history → character_joined 广播 → onMembersChanged }`

新时序：

```
ready 响应（result: null）
  └─ setImmediate{
       send(system_message) 单播          ← 替代 message_history 推送段位置
       broadcast(character_joined)
       onMembersChanged()
     }
```

1. **setImmediate 宏任务结构保留**——ready 响应先到的保证（#119 connection 语义）不破；
2. **system_message 在 character_joined 之前单播**——新角色处理自己 join 事件时欢迎语已在其
   receivedMessages 中，消费端顺序一致；
3. **删除 JOIN_HISTORY_LIMIT 在 ready-pipeline 的引用**；常量保留但 100→10，仅剩 index.ts resume
   投影使用（#123 改动表一致），注释同步更新（不再是 join 推送窗口）；
4. ready-pipeline 头注释与 121 行「hasPublicMessages 已为 true」的前提描述随代码删除一并清理。

## 3. hasPublicMessages 语义影响

核查结论（character-runtime.ts:900 getter）：检查 receivedMessages 中 public_message /
message_history 非空 / group_chat_update preview 非空。

- **生产代码无活跃调用方**（仅 getter 定义 + ready-pipeline 注释 + 测试 mock 夹具）；
- 行为变化：新角色 ready 后不再因 message_history 立即为 true，在收到第一条公共消息前为 false——
  这是 #123 的预期行为（V4 入群行为变化），非意外回归；受影响注释随代码删除；
- **历史获取兜底成立**（#64 pull 模型）：新角色无游标 → `fetchMessagesSince(0)` 拉全量，
  由 group_chat_update 水位 / settle 触发；删除自动历史推送不破坏「重复可接受、跳过不可接受」。

## 4. 配置链落点

1. `TavernConfigFileSchema` 增 `welcome_message: Type.Optional(Type.String())`——
   `additionalProperties:false` 下旧配置兼容（Optional 缺省不报错）；
2. `TavernConfig` 增 `welcomeMessage?: string`；
3. **三档合并沿用 board_max_notes 先例**：`projectConfig?.welcome_message ?? globalConfig?.welcome_message
   ?? DEFAULT_WELCOME_MESSAGE`（项目 > 全局 > 默认）；
4. `DEFAULT_WELCOME_MESSAGE` 入 constants.ts（#123 指定文案）；
5. 装配路径：loadTavernConfig → creator-factory → ready-pipeline deps.welcomeMessage——
   **值传递允许**（配置为纯快照语义，非可重赋值字段，AGENTS.md 值拷贝注入例外条款成立）；
6. ready-pipeline 缺省处理：deps.welcomeMessage 可 undefined，pipeline 内回落 DEFAULT_WELCOME_MESSAGE
   （或装配侧给默认值——实现选一，语义等价）。

## 5. 文件影响面与属主

| 文件 | 改动 | 属主 |
|------|------|------|
| src/shared/constants.ts | JOIN_HISTORY_LIMIT 100→10（注释更新）；+DEFAULT_WELCOME_MESSAGE | 后端 |
| src/shared/messages.ts | +METHOD_SYSTEM_MESSAGE | 后端 |
| src/config/load-config.ts | schema + welcome_message；TavernConfig.welcomeMessage；三档合并 | 后端 |
| src/protocol/messages.ts | +SystemMessageSchema；ServerMessageSchema union 注册 | 后端 |
| src/creator/creator-pipelines/ready-pipeline.ts | 删 message_history 推送 → send(system_message) 单播；deps.welcomeMessage | 后端 |
| 装配侧（creator-factory） | welcomeMessage 注入 ready-pipeline | 后端 |
| src/character/group-chat-input.ts | isEnvironmentEvent 白名单 + SYSTEM_MESSAGE；buildContent 独立「系统消息」小节 | 客户端 |
| docs/reference/websocket-protocol.md | system_message 文档（WL6） | PM 归口落盘 |
| test/unit/protocol/codec.test.ts | system_message 编解码 + 判别（红钉先行） | Arch |
| test/integration/creator/creator-join-lifecycle.test.ts | ready 后恰 1 条 system_message、零 message_history（红钉先行） | Arch |
| test/acceptance/* | WL1–WL6 钉测 | QA |

## 6. #132 开工前收敛 4 条核对

1. #119 混用策略与错误文案 —— #119 已关闭 ✓
2. #97 source 落点 —— 已完成 ✓
3. system_message schema 与新信封统一 —— 本文第 1 节，**待四方确认**（本轮评审发布即提交确认）
4. 验收条目入 acceptance.md —— WL1–WL6 已落文 ✓

## 7. 结论

- 无阻断项；两个实现注意点：
  a) system_message 必须 **send 单播**而非 broadcast（欢迎语个人化）；
  b) ready-pipeline 注释中 hasPublicMessages 前提随代码删除。
- Arch 属主产出：unit codec 钉 + integration join-lifecycle 钉（红先行），与实现并行，不抢 src 属主。
- 待办：后端认领实现 → Arch review → QA 门禁 → PM review → PR。
