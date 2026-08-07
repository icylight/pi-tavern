# ADR-0006：协议层迁移 vscode-jsonrpc——标准信封与 connection 接线

- 状态：**Accepted**（2026-08-06 协议层迁移 M1-M3 全闭环后补记；#119 issue 关闭前记录，QA 复核）
- 决策者：User（豁免零漂移拍板）、Arch（选型与落地映射）、后端/客户端（实施）、QA（验收锚定）
- 关联：issue #119（协议层迁移 vscode-jsonrpc）；PR #137（M1-M3 全闭环，ed71515 合入 main/9eada9b）；ADR-0005（五层架构：protocol 属 shared 层）；docs/architecture/websocket-protocol.md
- 契约影响：wire schema **一次性豁免零漂移**（User 拍板特例，仅此一次）——判别字段 type → method、载荷进 params、响应 {command,success,data} → {result}/{error}；此后恢复零改动纪律

## 背景

自研 wire 信封（判别字段 `type` + 扁平载荷 + 响应包 `{command, success, data}`）在五层架构确立后暴露三类问题：

1. **判别与载荷结构漂移不可见**：`broadcast(message: unknown)` 宽类型参数使 4 处旧信封构造逃过 tsc，wire 形状错误编译期不可见（对抗模式库②实证）。
2. **响应关联/错误处理自研成本高**：pending 按 id 手写关联，无统一失败收敛——handler 抛普通 Error 时的响应形状、无 handler 时的响应、参数无效等场景各自为政，schema 难以完整覆盖。
3. **生态兼容性**：pi 集成域（extension/headless）与外部工具对接时，JSON-RPC 2.0 是事实标准信封；自研信封阻碍互通与复用。

## 决策

### 1. 信封迁移 JSON-RPC 2.0 标准（M1）

- 判别字段 `type` → `method`；载荷统一进 `params`；请求/响应/通知统一 `{jsonrpc:"2.0"}`。
- 响应 `{command, success, data}` → `{result}` / `{error: {code, message}}`；错误码 = 业务 10 码 + JSON-RPC 标准码（-32700/-32600/-32601/-32602/-32603）。
- **id 收紧**：请求/响应**必带 id**（string | number，JSON-RPC 2.0 标准；vscode-jsonrpc 库 sendRequest 自增数字 id、手写握手用 string，双兼容）。唯一例外 = `update_character_state` 为无 id notification；服务端通知同样无 id。无 id 的 request/response 一律 fail-close——前者服务端无法关联响应，后者客户端命不中 pendingRequests（PR #137 评审阻断修复，对抗模式库⑩ schema 三态区分度）。
- TypeBox 判别结构保留为**最终守门**：method 判别 + params 形状 + 10 码业务枚举收窄，未知 code fail-close；信封骨架校验（jsonrpc"2.0" 必带 + method 或 id/result/error 判别形状）先行。

### 2. connection 接线（M2）：vscode-jsonrpc createMessageConnection

- creator 侧与 character 侧（character-runtime / join-attempt）均以 `createMessageConnection(reader, writer)` 接线，`RequestType`/`RequestType0` 类型化请求定义。
- 收益兑现部分：
  - **pending 生命周期**：库管理 request/response 关联、close 编排（pending 拒绝）、`ResponseError` 统一错误对象——删除了自研 pending 表与错误收敛样板。
  - **库产错误码合法化**：connection 模式下 handler 抛普通 Error → -32603、无 handler → -32601、参数无效 → -32602、解析失败 → -32700、无效请求 → -32600 均为库在**本端**生成的合法响应，必须纳入 schema，否则 decodeServerMessage 拒帧 → 客户端把库产响应当协议破坏断线。
- **未兑现（选型收益部分兑现，留待后续）**：
  - **codec 未接流式**：WS 单帧 JSON 语义与 vscode-jsonrpc 内置 StreamMessageReader 的 LSP Content-Length 分帧不匹配，故自写薄适配（`WebSocketMessageReader`/`WebSocketMessageWriter`，无新依赖）。reader 为**哑 reader**：消息不经理 reader 监听——creator 侧由 connection-manager 的 handleFrame（codec 校验 + 串行 enqueue + reload 缓冲兼容）接收后手动喂 `connection.handleMessage`；reader 仅提供接口形状 + close 事件（socket 关闭时 owner 调用 notifyClose，触发库内 pending 拒绝/连接关闭编排）。
  - **传输层类型安全**：`broadcast(message: unknown)` 签名收窄为 ServerMessage（或联合类型）仍在架构优化待办（architecture-optimization-backlog.md 已登记）——让 tsc 直接捕获 wire 形状漂移，codec 层钉测兜底保持。

## 实施后差异核注

- 迁移盘点四维清单（对抗模式库⑨）为本迁移的验收方法论：method 判别、结果判别（id+result/error）、条目内容层（preview/messages/events 嵌套字段）、类型标注（mock/断言收窄）——M3 收口门禁 6 失败即为四维中「断言判别字段残留」的实证（⑧ waitFor 判别永不匹配 = 假绿断言）。
- 测试面：unit 285 + integration 129 + acceptance 27 全绿（test:full，引用 ea7c990 提交态）；check exit 0；lint:layers OK。
- 响应关联校验（对抗模式库⑪）：pending 按 id resolve 后须按预期 method/结果校验器验证，不符 fail-close——该模式为本迁移评审阻断②的收敛，已固化至对抗模式库。

## 验证锚点

- unit：codec 编解码（三态 schema 区分、id 必带 fail-close、标准错误码纳入）；ws-message-io 适配层（哑 reader 喂入、notifyClose 触发 pending 拒绝）。
- integration：connection 模式下请求/响应/通知全链路；库产错误码 -32603/-32601 等作为合法响应；reload 缓冲兼容。
- acceptance：reload（迁移后判别字段残留回归）、identity-consistency、paging-and-speak-order 等主路径；ws-helper 适配。

## 结果与取舍

- 收益：标准信封提升生态互通性；pending/错误收敛交给库；三态 schema 区分使 wire 形状编译期可见性大幅提升（仍需签名收窄补最后一块）。
- 代价：一次性的 wire 契约变更（User 拍板豁免零漂移，特例仅此一次）——旧版客户端与服务端不兼容，随 0.3.0 收口统一发布。
- 保留：TypeBox 判别结构仍为解码守门（库只提供 Message 骨架，业务形状校验不外包）。
