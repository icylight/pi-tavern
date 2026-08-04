# ADR-0007：白板模型——头脑风暴状态收敛机制（替代 #107 决策状态机方案）

- 状态：**Accepted**（2026-08-04 User 三项拍板后转正）
- 决策者：User（产品模型采访定稿）、Arch（架构定案）、Dev（实现核实）、QA（验收锚点）
- 关联：issue #114（白板模型立项）；问题源头 #105（README 位置议题 8+ 轮摇摆）；错误实践 #107（B 方案，实现 #110 已被 #111 revert）；理解文档 docs/brainstorm-convergence.md

## 背景

头脑风暴/讨论轮次中，多个角色异步处理消息时**状态无法收敛**：各角色基于自己看到的旧消息反复改变立场，多个不同 sequence 的裁决被不同角色同时引用为「当前」。sequence/时间戳只解决消息先后，不回答「哪条当前有效」。

#107 的 B 方案把问题建模为「**裁决是状态**」（决策存储 + declare 命令 + 环境注入「当前有效裁决」节），实现 #110 上线后被 #111 revert 实证否决。根因：把「人随手记 + 共见」建模成「状态机 + 流程」，可靠性依赖流程纪律，而纪律恰恰最不可靠；机制越重维护成本越高。

## 决策

### 1. 白板模型（产品定稿，User 采访 2026-08）

每角色一块自己的白板：自由贴条/撕条（内容、时机 AI 自决）；全群可见（含 User，User 只看不写、口头收敛）；独立于消息流，但更新发增量摘要通知（「喊一声」）；限制可配置（默认 5 条 / 140 中文字符）；生命周期 = 群聊内跨轮次保留、随群聊删除同步清理（关闭保留、供恢复读取）。

**朴素原则**：不做版本号、declare 仪式、替代关系、注入段分类——「贴条即更新，撕条即撤销，天然只有当前」。

### 2. 可见机制：通知 + 查询工具（否决环境注入）

- 通知 = 事件驱动唤醒（角色被喊一声），增量摘要（仅变化的条）随唤醒上下文到达
- 查询工具 = 按需拉全量（board_query）
- 否决环境注入：与 #107 注入段同构已被证伪；快照必陈旧（白板「最新覆盖旧」语义与快照冲突）；全量注入多角色×5条×每轮上下文膨胀
- 复用现有「通知 + 增量拉取」原语，零新机制；忙态角色不查可接受（白板是事后可查的状态锚，非实时同步）

### 3. 协议（契约变更①）：board_write / board_query / board_update

- **board_write**（客户端）= { action: "set"|"remove"|"clear", note?: { id?, content? } }：set 无 id = 贴新条（store 分配稳定条 id）；set 带 id = 改条（edit）；remove 带 id；clear 无参。**不带 actor 字段**——服务端从 session 推导，操作仅作用发送者本人白板；跨角色条 id = 本人板上不存在 = no-op。**edit 语义**：edit 不新增条数（5 条上限只约束新贴）但**仍受单条长度上限**（note_length_exceeded 适用 edit）
- **board_query**（客户端）无参（session 隐含 groupId），响应 = 全量 per-character 条目
- **board_update**（服务器通知，复用 broadcast() 通道）= { actor, action: "add"|"update"|"remove"|"clear", note: { id, content } }：remove 携带被撕条内容（角色据此知道对方立场变了、不再引用）；clear 无 note。**无 sequence 字段**——不在消息流里、无消息流水位语义；字符侧不得视为水位
- 响应**三态、success 恒 true**（speak 先例：业务拒绝 = success:true + reason，非协议错误）：
  - 成功 = { success:true, changed:true, note:{ id, content } }（set 新贴回带分配 id；edit 带新内容；remove/clear 不带）
  - no-op = { success:true, changed:false, reason_code（**告知码**）}——**群聊静默（不广播）+ 接口层告知**（User 拍板③，2026-08-04）
  - 拒绝 = { success:true, changed:false, reason_code（**拒绝码**）}——不广播
  - 判别：reason_code **取值**区分告知（幂等成立：目标不存在/已一致）与拒绝（资源约束：未执行）——取代「存在性区分」
  - success:false 仅协议级错误（走现有 sendFailure / FailureResponseSchema，不动其形状；FailureCommand union 加 board_write/board_query 成员 = 新消息的失败通道，属合法 union 增量，speak 先例）
- **reason_code 五码**（User 拍板①③，2026-08-04）：拒绝码 max_notes_exceeded / note_length_exceeded；告知码 note_not_found（remove/set 不存在 id、跨角色条 id——本人板上即不存在）/ board_empty（clear 空板）/ note_unchanged（update 同内容）
- 「变化」定义 = 板内容实际改变（新条/内容差异/移除/清空），与 action 语义正交；update 同内容 = changed:false 不通知
- 码点计数校验放 pipeline 层（[...str].length，Array.from 语义），不放 TypeBox schema（String minLength 按 UTF-16 units）
- 新消息类型为 union 增量：不修改现有 schema、不改既有消息字段；旧客户端不识别 = fail-close（见兼容性政策）

### 4. 持久化（契约变更③④）：creator 侧 board store

- 新 src/data/board-store.ts（**skills 层**，落 data/ 目录——层级命名见 ADR-0005；node:fs 合法）：内存态（随 GroupChatState 体系）+ 文件 boards/<groupId>.json
- 生命周期与群聊 JSONL 同生共死：关闭（/tavern-leave）保留、恢复时按 groupChatId 读回（creator-factory 组合根初始化，不碰 resume-projection.ts）；删除（deleteGroupChatSession）同步清理（deleteBoard 注入，复用 trash 优先/unlink 回退；删不存在文件幂等）
- 设计约束：① 单写者串行化（board 写操作与 WS 消息处理同队列；write×deleteBoard 竞态 = 同队列串行或删后从内存摘除实例，无复活路径）② 原子写 = tmp + rename（cursor-store 先例）③ 读损坏 = 降级空板 + 警告，不崩溃 ④ 操作返回变更结果（changed），data 层不依赖协议类型
- 条 id = 稳定 id（set 无 id 时 store 分配）——remove 定向的最小机制（index 并发位移、content 重复歧义），非版本号仪式

### 5. 额度与 User 入口

- 贴条/撕条/通知**不占发言额度**（额度管公开发言、白板管状态表达；5条/140字上限天然防滥用）
- User 入口 = 双形态：/tavern-status 白板小节（现有命令扩展）+ creator 实时提示（board pipeline 完成处 ui.notify）——纯 creator 侧展示，不新增协议消息

### 6. 字符侧投递：四处接线（B4）

① 路由：character-runtime handleServerMessage 非 response 全量推 onEnvironmentMessage——天然可达，无需改；② **isEnvironmentEvent 门闸（最靠前）**：group-chat-input.ts:125 catch-all 在进 pendingEvents 前过滤，必须新增 board_update case（346-358 行 switch 现仅四 case、default false）；③ buildContent 新增「白板更新」桶（过滤桶现 567/583 行两处）——否则 agent 看不到通知也不会去查；④ 不挂 incrementPending（仅 group_chat_update 分支置位，catch-all 路径天然满足；负例断言：收到 board_update 不产生消息流拉取）

唤醒机制 = catch-all 路径（125 行 push + resetJoinDebounce），与成员变化同机制；增量摘要随唤醒上下文 = 白板桶渲染；**无需另设脏标记**（那是接线缺失时的退化补丁）。

### 7. 兼容性政策（契约零漂移 + 锁步升级）

- **双向严格校验、两端 fail-close**：decodeServerMessage 失败 → failConnection 断连（character-runtime.ts:161-166）；decodeClientMessage 失败 → socket.close(1002)（connection-manager.ts:130-134）——两侧 schema 均为严格 union 无兜底变体，新增任何消息类型都会让旧端断连，非「忽略」
- 兼容性**不是选型因素**；选独立消息类型的理由是**语义隔离**（响应与通知解耦、不混入消息流语义）
- ISSUE-013 平滑演进先例**仅适用 client→server 方向**（based_on_sequence 为 speak 可选字段，缺省 = 服务端跳过）；server→client 新类型 = fail-close
- 佐证：ISSUE-013 B6 的 server→client 响应新增 required 字段 latest_sequence（messages.ts:353）当年靠**同仓同版锁步**上线，非平滑演进
- **不加容忍逻辑**：同仓同包锁步升级；现有 fail-safe 是既有行为，为容忍改 codec 反而扩大本次契约面。代价事实：朴素 catch-all 会吞畸形已知消息（fail-fast 丢失）；正确实现需两阶段解码（协议层手术）；dispatch/isEnvironmentEvent/handleServerMessage 三处穷尽 switch 均需 default（行为三处同变）；收益场景（混合版本）当前不存在

### 8. 契约变更四处

1. protocol：board_write + board_query（客户端消息）+ board_update（服务器通知消息，复用 broadcast() 通道）
2. 角色卡新增 tavern_board 工具（贴/撕/清/查）
3. 新持久化文件 boards/<groupId>.json
4. 删除流程新增 deleteBoard(groupId) 注入（commands.ts 注入签名 + index.ts 组合根 + 新 src/data/board-store.ts，不动 controller）

## 否决的替代方案

| 方案 | 否决理由 |
| --- | --- |
| #107 B 方案（裁决=状态机：declare/版本号/注入段） | 把「人随手记+共见」建模成「状态机+流程」，纪律依赖不可靠；实现 #110 已被 #111 revert 实证 |
| 环境注入白板全量 | 与 #107 注入段同构已被证伪；快照必陈旧；全量注入上下文膨胀不可控 |
| 给 group_chat_update 加 board 字段 | closed schema（additionalProperties:false）加字段 = 破坏性变更；且会误触发角色侧 incrementPending 拉取（语义污染） |
| 共享一块白板/分「谁有笔」 | 违背「每人一块」定稿；共享板需要仲裁机制，重回流程纪律依赖 |
| 贴条占发言额度 | 额度管公开发言、白板管状态表达，语义不同；5条/140字上限天然防滥用，无需二次约束 |
| 超限自动覆盖最旧 / 静默忽略 | 覆盖 = 静默丢立场；静默忽略 = 角色不知道没贴上——均违背「贴不上就明说」的朴素语义 |
| codec 加 union 兜底变体（本期做） | 本期零收益（旧二进制无容忍 codec 照样断连）；吞错风险（畸形已知消息被吞 = fail-fast 丢失）；违背朴素原则；演进路径不封死（见后续演进注意） |
| 白板文件写群聊 JSONL | pi session 格式变更（零漂移成本最高）；白板是临时表达渠道非档案，独立文件随群聊删除即删不污染消息流 |

## 影响面

- 里程碑：issue #114 B0-B6（B0 契约确认 + 本 ADR；B1 protocol；B2 board store；B3 消息通路；B4 角色侧；B5 User 入口；B6 测试验收），依赖序 B0→B1→B2→B3→B4 串行、B5 与 B4 并行
- 文件：src/protocol/messages.ts + codec.ts（新消息类型，零改动既有 schema）；src/data/board-store.ts（新）；dispatch/pipeline-assembly（新管线）；commands.ts（/tavern-status 扩展 + deleteBoard 注入签名）；index.ts（组合根）；extension/tavern-tools.ts（tavern_board 工具）；角色卡；group-chat-input.ts（isEnvironmentEvent case + 白板桶）
- 验收：机械断言（B1+B2）+ integration（B3+B4）+ acceptance e2e（B5+B6）；README 重放场景为方向性指标不作硬门禁；no-op 必带告知码断言（note_not_found/board_empty/note_unchanged 三码 + 不广播负例）

## 后续演进注意

- **接收端宽松化**（如未来出现混合版本场景，另立议题评估）：正确实现 = 两阶段解码（先 type 判别符：已知走严格校验、未知放行）+ 消费端三处 default（dispatch/isEnvironmentEvent/handleServerMessage）；Type.Not 排除已知类型是必要约束（否则畸形已知消息被吞）；需补「未知类型忽略、连接保持、已知类型畸形仍拒绝」双向断言——**非兜底变体一行**，是协议层手术
- 码点计数（Array.from 语义）为既定口径；grapheme 分割（ZWJ 组合按一个可见字符计）为未来可选精化，本期不做
- 收敛成果存档（最终结论/共识）走正式渠道（issue/文档/验收留痕），不靠白板文件——过程态与结果态分开
- **ADR-0006 空缺注记**：ADR-0006（#107 决策状态机方案）已随 revert #111 删除——目录空缺即否决留痕；编号不复用，本决策记录为 0007
