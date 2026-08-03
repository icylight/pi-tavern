# PiTavern Implementation Plan

本文记录 PiTavern 首版的实施顺序。产品行为以对应设计文档为准；本文只定义如何把已经确认的设计逐步实现和验证。

## 测试先行

每个里程碑都采用测试先行，不允许先完成实现再集中补测试。

每项可观察行为遵循：

```text
Red
先写测试，确认测试因缺少当前行为而失败
  ↓
Green
实现让该测试通过的最小代码
  ↓
Refactor
在测试保持通过的前提下整理结构
```

具体约束：

- 测试必须先失败，并且失败原因与本次准备实现的行为一致；
- 不以编译错误长期代替行为测试的 Red 阶段；
- Green 阶段只实现当前测试要求的行为，不顺带实现后续里程碑；
- 重构不能改变已经确认的产品语义；
- 每个里程碑结束时运行该里程碑测试、全部既有测试、类型检查和 Biome 检查；
- 修复缺陷时先增加能够稳定复现缺陷的失败测试，再修改实现；
- 需要真实进程才能验证的行为，先在可控组件边界建立测试，再增加最小数量的进程级验收测试。

测试先行是本地开发顺序，不要求把 Red 阶段单独提交。每项行为的测试和对应最小实现进入同一个可运行 commit：

```text
本地：编写并运行失败测试
本地：实现最小代码并确认全部检查通过
提交：test + implementation
refactor: simplify <area>   # 仅在确实需要时
```

测试应在同一变更中保持清晰、能够被单独审查，但不能向设计分支提交一个故意失败的中间状态。每个可检出的 commit 都必须通过当时已有的全部测试和检查。

## M0：工程骨架

先行测试：

- Extension Factory 可以由 pi loader 加载；
- `/tavern-status` 在初始状态返回 `idle`；
- 开发启动入口使用独立 `PI_CODING_AGENT_DIR`。

最小实现：

- npm、TypeScript、Biome 和 Vitest 配置；
- 独立开发 pi 启动脚本；
- 空 Extension Factory；
- `TavernController` 初始状态；
- `/tavern-status` 的 idle 输出。

完成标准：

- `references/pi` 能加载扩展；
- `/reload` 后扩展仍能加载；
- 本机日常 pi 数据未被读取或写入；
- test、typecheck 和 Biome 全部通过。

## M1：创建者基本生命周期

先行测试：

- `/tavern-new` 从 `idle` 创建 CreatorRuntime；
- WebSocket Server 只监听本机地址并取得可用端口；
- 活动描述只在启动提交后可发现；
- 创建失败会逆序清理且 Controller 保持 `idle`；
- 空群聊关闭后没有群聊 session 文件；
- `/tavern-name` 和 `/tavern-set-max` 只修改当前创建者状态；
- `/tavern-leave` 幂等关闭资源并回到 `idle`。

最小实现：

- CreatorRuntime 启动与关闭；
- `GroupChatState` 的空群聊状态；
- 活动描述发布和删除；
- 创建者状态、命名和群聊消息上限命令。

## M2：Character 加入与离开

先行测试：

- 全局与项目配置按照既定优先级合并；
- Character Markdown 能发现、解析和校验；
- 活动群聊发现先检查描述，再验证实际实例身份；
- 三阶段加入在 `character_ready` 前不成为在线成员；
- 同一个 Character 不能同时预留或在线；
- 预留 5 秒超时后先释放再关闭；
- 正式加入后连接所有权只转移一次；
- 主动离开、断线和重复清理都能释放 Character；
- 一个 pi session 同时只能加入一个群聊。

最小实现：

- 配置与 Character card；
- 活动群聊发现；
- `JoinAttempt`；
- Creator 连接闭包和 Character 预留；
- CharacterRuntime 的基础连接、状态拉取和关闭；
- 加入、离开及在线列表协议。

本里程碑暂不触发 Agent run。

## M3：公共对话闭环

先行测试：

- 创建者输入由 Extension 处理且不启动创建者 LLM；
- 第一条 User Persona 消息先落盘，再进入状态、TUI 和广播；
- 新 User Persona 消息继承 `groupMaxMessages` 创建新 Round；
- Character 发言按照 frame 到达顺序原子占用额度（原子 = 不可分割地占用，无中间可见态）；
- 达到 `roundMaxMessages` 后内容不公开并设置举手；
- 成功发言广播给包括发送者在内的全部 Character；
- Character 自己的广播回显不再次触发群聊输入；
- 1 秒 trailing-edge debounce 合并环境消息；
- 防抖结束先拉取最新状态，再提交一条 pi follow-up；
- Character prompt 在每次 Agent run 使用缓存正文；
- `tavern_speak` 只在 Character 正式在线时启用。

最小实现：

- 群聊 session 首次持久化和公开消息 entry；
- 创建者 input 接管；
- Round、额度、广播和举手；
- `group-chat-input`；
- Character prompt；
- `tavern_speak`；
- 创建者展示投影和 Character message renderer 的基础版本。

完成后形成第一个可用的多人群聊闭环。

## M4：历史与恢复

先行测试：

- 新加入 Character 自动收到最近最多 10 条公开消息；
- cursor 可以原样请求更早历史；
- `total_messages`、`has_more` 和空历史结果正确；
- 群聊记录文件请求只返回当前群聊文件；
- session 可以重建名称、`groupMaxMessages`、当前 Round 和下一 sequence；
- `/tavern-resume` 不允许恢复已经活动的群聊；
- 历史删除沿用 pi 的选择与删除语义；
- 恢复后使用新端口和新 `instance_id`，不恢复成员连接。

最小实现：

- 历史读取与 cursor；
- 群聊记录文件请求；
- 群聊 session 列表、恢复、删除和状态重建；
- 活动实例排他。

## M5：pi 生命周期完整对齐

先行测试：

- 非 idle 状态执行 `/new`、`/resume`、`/fork` 或 `/clone` 时先询问；
- 取消保持当前 Runtime，确认则先退出且失败后不撤销；
- graceful quit 在 5 秒内尽力完成关闭；
- reload 只交接稳定 Creator 或 Character；
- `joining` reload 后回到 `idle`；
- handoff 只能 take 一次，session ID 不匹配不能接管；
- reload 5 秒超时后由 handoff 所有者清理；
- reload 窗口 frame 按接收顺序恢复；
- ping/pong 正常连接不产生 Agent 输入；
- 120 秒心跳失效进入统一断线清理；
- TUI status、widget 和 renderer 不成为业务权威。

最小实现：

- pi session 操作拦截；
- graceful quit；
- `globalThis` 一次性 reload handoff registry；
- Creator 与 Character detach/restore；
- 心跳与全部异常清理；
- TUI 展示完善。

## M6：进程级与平台验收

M6 不用于补齐前面遗漏的单元或组件测试，而是验证只有真实进程边界才能观察的行为。

先行验收测试：

- 多个真实开发 pi 可以发现并加入同一群聊；
- 多 Character 并发发言遵循创建者收到顺序和全局额度；
- 一个开发 pi 的退出不会污染本机日常 pi；
- Creator 或 Character 异常终止后其余进程能够收敛；
- 残留活动描述能够被后续发现流程清理；
- reload 保持已确认的连接和身份；
- macOS 与 Linux 使用相同发现及进程校验逻辑。

实现和修正仍遵循 Red、Green、Refactor：每发现一个进程级缺陷，先让对应验收测试稳定失败，再修改实现。

## M7：新消息获取推拉混合（ISSUE-012 / GitHub #24，2026-08-01 需求，方案已冻结）

需求与冻结方案：`docs/new-message-fetch.md`（**历史决策记录，触发/投递口径已按 #60/#64 修订**，见下文 A1/A4 注）。交互由「服务端推送 + 固定 1 秒防抖」改为**推送+拉取混合（微信模型）**：广播通知化（`group_chat_update`：latest_sequence + 最近 3 条完整消息预览 + total）、角色主动增量拉取（`fetch_messages_since`，sequence > since 全量）、游标本地持久化（`<agent-dir>/tavern/<project-key>/cursors/<group_id>/<session_id>.json`，**Session 级，2026-08-02 User 指示**；旧群聊级单文件 `cursors/<group_id>.json` 保守回退为起点，只读不写不删；成功投递后更新）、缺口天然补齐（拉全语义）、不打断当前 run（followUp + isAgentActive/onAgentSettled）。

先行验收测试（`docs/acceptance.md` M7 A1-A7，测试先行，不允许先实现后补测；**分工：A1-A7 测试由 QA 编写（test/** 所有权，红测暂存）→ Dev 实现 src/** 转绿 → QA 随批提交**，避免越权重演）：

- A1 去防抖增量拉取：广播到达 → 立即 fetch（fake timers 断言无 1s 延迟）；**（注：已按 #64 修订——闲态 ≤1s 固定窗口聚合触发 / 忙态 settle 后立即触发，见 acceptance.md A1 现行口径）**；
- A2 游标持久化：收消息 → 游标落盘 → 重启 → 游标保留、增量从游标后开始；投递失败游标不动；
- A3 不重不漏/顺序一致：拉取内容 = 游标后全部、无重复、严格递增；
- A4 缺口检测：跳过序号/丢帧 → 补拉补齐；**（注：已按 #64 修订——拉全未读天然补齐，无独立缺口机制，见 acceptance.md A4）**；
- A5 run 状态信号：isAgentActive 活跃时排队、settled 后立即投递（单测 ≤5s、验收 ≤10s）；
- A6 统一逻辑：testNotify 观察通道断言「预览 = 注入内容同源」；
- A7 边界：无游标全量分页、单飞行锁、echo 过滤、历史分页回归。

涉及文件：协议层（websocket-protocol.md，Dev 属主）、creator-runtime（广播改通知 + 增量查询 + handle）、character-runtime（fetch 方法 + isAgentActive 桥接）、group-chat-input（去防抖/游标/缺口检测）、persistence.md（游标载体，Dev 属主）。顺带修复 ISSUE-002 streaming 语义错配（agent_start/agent_settled 事件复用）。

实现和修正仍遵循 Red、Green、Refactor：每实现一个交互点，先让对应验收测试稳定失败，再修改实现。

## 里程碑完成条件

任一里程碑只有同时满足以下条件才算完成：

- 该里程碑列出的先行测试已经建立并通过；
- 所有更早里程碑测试保持通过；
- `npm run test:full` 通过（三层全量收口门禁；日常验证走显式定向 `npm run test:unit -- <pattern>`，见 docs/workflow.md §7 默认不跑）；
- `npm run check` 通过；
- 没有依赖真实 LLM 或外部网络的默认测试；
- 文档与最终实现没有已知语义分歧；
- 工作区中没有意外生成或提交 `.dev/` 运行数据。
