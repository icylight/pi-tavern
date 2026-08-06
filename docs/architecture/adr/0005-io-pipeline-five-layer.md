# ADR-0005：五层架构——IO 管线范式（adapter / application / skills / runtime / shared）

- 状态：**Accepted**（2026-08-02 Phase 5 收口，四方确认 + User 批准开工后转正；实施后差异核对见文末「实施后差异核注」段，配套依赖图 = docs/architecture/architecture.md）
- 决策者：User（层模型、IO 管线范式与 skill/mcp 概念映射）、Arch（落地映射与迁移）、Dev/QA（实施与验收）
- 关联：User 2026-08-02 重构指示；动机 = 可维护 / 可读 / 规范

## 背景

> 状态注记（2026-08-02，Phase 3 达成后补）：正文为决策记录时的基线（1881 行单体）；Phase 3 已达成目标结构（creator-runtime 1193→429 行骨架，ADR 目标结构映射见下，与现状一致）。
> 状态注记（2026-08-02，Phase 5 收口补）：五阶段实施完成；creator-runtime 现 427 行骨架（QA 收口核对③）。「目标结构」段中 character-pipelines/ 与 character-runtime 瘦身为**挂起后续项**（本期范围 = creator 侧），差异与豁免面明细见文末核注段 + docs/architecture/architecture.md。

`src/creator/creator-runtime.ts`（1881 行）单体：WS 传输（handleConnection/心跳）、业务编排（submitUserPersonaMessage/join/claim/ready/leave）、持久化（游标/FIRST_PERSIST_*/session 文件恢复）全部混在一个类；依赖方向靠约定不靠结构；目录与命名无统一规范（22 文件 6415 行，按既有目录分布）。

设计范式 = **IO 模型**：application 层是请求级 IO 管线——输入与中间状态收于管线实例、阶段为私有处理函数（Method）、读写顺序由主管线安排；其下为能力单元层（skills），进程级共享能力由 runtime 单例持有（MCP 同构）。PiTavern 没有数据库，落盘就是「追加写文件 + 游标只前进」，不引入事务概念。

## 决策

### 1. 五层定义（IO 管线语义）

| 层 | 定义 | PiTavern 落点 |
| --- | --- | --- |
| **adapter** | 薄入口：显式展开管线顺序与分支；处理结果 → 协议响应 / notify / steer | commands / tools / headless / ui（presenter·renderers）/ WS handler 壳 |
| **application** | **请求级 IO 管线**：一次协议消息 / 内部事件 = 一个管线实例；输入与中间 IO 收于实例字段；阶段 = 私有处理函数（Method）；读写顺序与落盘时机由主管线安排；子管线只给有独立步骤/状态/复用边界的流程 | SubmitMessage / Join / Claim / Ready / Leave / 查询 管线；`tavern-controller.ts` 的 transitionTail 一次只处理一个轮次（排队执行），已是管线雏形 |
| **skills** | 能力单元（原 data）：单一用途、一次明确读写；按业务能力组织；不把多步串在一起、不自行决定读写时机；显式接收管线传入的输入；纯计算不隐藏 IO；出错时返回明确原因，由入口层决定如何回应 | session-store / cursor-store / descriptor-store / resume-projection / discovery 原语 |
| **runtime** | 进程单例（**MCP 同构**）：WS server + 连接表 + 心跳 + 能力实例装配；不保存单次任务中间状态 | 瘦身后的 CreatorRuntime / CharacterRuntime；join-attempt（WS 客户端传输）；reload-handoff（进程级交接） |
| **shared** | 跨进程通用契约（双进程共同遵守的消息格式约定） | protocol（messages·codec）/ config / constants / runtime-close |

### 2. 依赖规则（硬约束）

- **依赖单向**：adapter → application → runtime → skills → shared；允许跨层依赖任意下层，禁止上行
- **文件 IO 仅限 skills**：application 不直接读写文件；adapter 可直查 skills（纯读）；skills 不编排流程
- runtime 是唯一单例持有者（连接 + 能力实例装配点），application 需要时从 runtime 拿，不自建
- skills 无 pi 依赖、可单测（resume-projection 先例推广）
- **skills 不 import pi 包（含类型）**：宿主对象（如 pi 的 SessionManager）经 runtime 注入，skills 以本地结构类型接口接收（TS 结构类型天然满足，单测注入假件——先例：creator-runtime.test.ts 的 vi.fn 替换）
- 纯计算 skill 不隐藏 IO：计算输入由管线显式组装后传入

### 3. 消息与游标怎么保存

- **消息整条追加**：每条新消息一次性追加到会话文件末尾，旧消息不会被覆盖或改写
- **游标只前进**：游标（last_sequence）记录「已送达的序号」，只增不减，是送达进度的唯一依据
- **写一半断了能恢复**：写入中断时，FIRST_PERSIST_*/recoverSessionManagerFromFailedAppend 从已落盘位置继续，不重复、不丢已确认的消息
- **谁来安排**：协议消息的处理流程（application）按步骤安排「何时读、何时写」；skills 只做单一步骤的读写，不自行串联多步
- 这里不引入数据库的「事务」「Outbox」等概念——没有数据库，用不上这些词
- 跨消息异步状态的归属见决策 7

### 4. 双进程

- creator 进程与每个 character 进程各实例化一套（adapter/application/skills/runtime）；只有 shared 跨进程
- 装配点（组合根，即程序启动时把所有零件接起来的地方）= `src/index.ts`，与 pi 扩展生命周期对齐

### 5. 契约不动 + 行为零变化

- protocol/messages.ts 的 wire schema 本轮零改动（动它触发全量门禁）
- 纯结构重构：任何可观察行为（协议/持久化格式/时序）不变
- 每阶段独立验证（unit + 定向 acceptance），沿验证工作流 V 阶梯

### 6. 层名

- **skills**：取 agent-skill 语义（能力单元：一次只做一件事的读写/计算）；与 pi 宿主 SKILL.md 系统区分（我们不加载宿主技能）；等价 MCP 术语 capabilities

### 7. 跨消息异步状态归属（预演裁决，2026-08-02）

跨消息异步长流程（如 #38 steer：消息 B 读取「消息 A 触发的 run 状态」决策投递）按以下切分：

- **run 生命周期状态机**（active/streaming/settled + watchdog）= 进程级会话状态，留在 runtime——跨消息状态的唯一居所
- **steer 决策策略**（读 run 状态 → 判 idle/steer/queue）= application/character-pipelines，纯策略无状态
- **投递通道**（notify/WS）= transport（runtime 下）

管线/门面只显式读写 runtime 会话状态，**不自行缓存跨消息状态**——请求级管线不背长流程状态（防迁移时把长流程状态塞进管线实例）

## 目标结构（22 文件映射）

```
adapter:      index.ts(组合根) / extension/(tavern-tools·agent-lifecycle,Phase 3 PR-A 拆出) / commands.ts / headless.ts / ui/(tavern-ui-presenter·renderers)
application:  controller/tavern-controller.ts(管线雏形) / 新拆:creator-pipelines/(submit-message·join·claim·ready·leave·query) / character-pipelines/(发言策略·steer 策略,自 character/group-chat-input.ts 拆出,#38 契约面)
skills:       新拆:data/(session-store·cursor-store·descriptor-store·resume-projection[裁决:skills]·discovery[active-descriptor·discover-group-chats 迁入]) + creator/group-chat-sessions.ts + creator/group-chat-state.ts
runtime:      creator-runtime.ts(瘦身:WS+心跳+装配) / character-runtime.ts(瘦身) / character/join-attempt.ts / controller/reload-handoff-registry.ts
shared:       protocol/(messages·codec) / config/(character-card·load-config) / shared/(constants·runtime-close)
```

拆解重心：

> 达成注记（2026-08-02）：creator-runtime 已达成 ~400 行骨架（现 427 行：构造/依赖/公开 API 门面/生命周期），WS 连接域、心跳域、装配域、reload 域、成员簿记已拆出；character-runtime 拆分与下两行目标同为目标结构（ADR 映射表为准，**挂起后续项**，见文末核注段）。

- `creator-runtime.ts` 1881 行 → 骨架（~400 行：WS/心跳/连接表/装配）+ 管线（join/claim/ready/speak/leave/查询 各 ~80-200 行）+ skills（session/cursor/persist ~250 行）
- `character-runtime.ts` 768 行同理拆分
- discovery 归属已定案（QA 评审）：active-descriptor / discover-group-chats 均无编排 → 整体 skills
- 契约面「拆纯 schema 与行为」挂 Phase 4 可选，另立判断

## 迁移顺序（五阶段，每阶段独立绿再走下一步）

| 阶段 | 内容 | 验证 |
| --- | --- | --- |
| Phase 1 | **skills 提取**：data/ 出 runtime，单测钉死 | unit 全量 + 定向（message-sync/persistence） |
| Phase 2 | **application 提取**：协议消息管线化，store 改注入 | unit + 定向（round/speak-order） |
| Phase 3 | **runtime 瘦身 + 组合根**：骨架收敛、index.ts 装配 | 全链门禁（里程碑） |
| Phase 4 | **规范统一**：目录/命名/依赖 lint；schema 拆分可选 | unit + 定向 |
| Phase 5 | **收口**：全链门禁 + 五层依赖图 + 本 ADR 转 Accepted | 全链门禁 |

## 实施后差异核注（Phase 5 收口，2026-08-02 Arch 产出，四方确认口径）

转 Accepted 口径（PM 裁决）：**五层语义层 Accepted + 已落地映射如实核注 + 挂起项如实标注**——不把未拆结构写成已完成（契约零漂移）。

### 收口验证引用（QA 全链门禁，2026-08-02，预跑 V0-① 参考级，锚 b71af53 = main 头）

- unit 18 文件 204 用例全绿（12.19s）| integration 9 文件 96 用例全绿（7.33s）| acceptance 10 文件 18 用例全绿（101.95s）
- 环境：references/pi@5bc1c2c0 + node v26.4.0；src/test 树零改动（docs 在途不进入该树），PM 落盘后权威锚以 src/test 树不变为准

### 已落地（与目标结构一致）

- creator-runtime：1881 → **427 行骨架**（≈400 目标达成）；WS 连接域/心跳域/装配域/reload 域/成员簿记已拆出（creator/ 域模块 10 个）
- creator-pipelines：6 管线（submit-message/join/claim/ready/leave/query）+ dispatch 桥齐备（收口核对②）
- skills：data/ 8 文件全迁入、无 pi 依赖可单测；discovery 整体 skills（QA 评审定案）
- 组合根 = src/index.ts（决策 4 达成）；依赖方向由 lint:layers 强制（决策 2 达成，规则矩阵见 docs/architecture/architecture.md §3）
- 契约零改动达成：protocol wire schema 五阶段零 diff（收口核对）

### 挂起项（如实标注）

| 项 | 目标 | 现状 | 状态 |
| --- | --- | --- | --- |
| character-pipelines/（发言策略 + steer 策略，自 group-chat-input.ts 拆出，#38 契约面） | application 层 | 无此目录；group-chat-input.ts 612 行，steer 实现在内 | **挂起后续项**（#58 关闭时注明，User 知悉） |
| character-runtime 瘦身 | 768 行同理拆分 | 852 行未拆 | **挂起后续项** |

### 位置收敛差异（归属一致，仅落位不同）

- 目标结构 skills 行写 `creator/group-chat-sessions.ts` + `creator/group-chat-state.ts` → 实际统一收敛于 `data/` 目录；skills 层归属不变
- reload-handoff-registry 按目标结构归 runtime（进程级 reload 交接，#14）

### 豁免面（IO 审计口径，QA 预核 + Dev grep 歧义排除）

非 skills 层文件 IO 调用点 = 3 处，全部有裁决依据（非字面「0 调用点」）：config×2（Phase 3 裁决①组合根配置豁免）、creator-factory×1（lint-layers 白名单，组合根装配语义）；grep `writeFile` 另 2 处假命中（creator-runtime.ts:88 / reload-flow.ts:39 为注入接口类型签名）。明细见 docs/architecture/architecture.md §5。

## 否决的替代方案

| 方案 | 否决理由 |
| --- | --- |
| 大爆炸式一次重构 | 单体一次性拆 = 高风险，无法逐层验证 |
| 保持现状 | 违背动机，单体只会随新能力继续膨胀 |
| 按领域包（不按层） | 群聊/角色/协议域内仍混传输与持久化，依赖方向不可循 |
| 引入依赖注入框架 | PiTavern 没有数据库，落盘只是追加写文件 + 游标推进，不需要事务框架；依赖管理靠装配点手动拼接即可，零新依赖 |
| 引入事务/Outbox 抽象（跨层框架化） | PiTavern 没有数据库，落盘只是追加写文件 + 游标推进，不需要事务框架 |

## 后果

正：可读性（小文件单职责）、可测性（skills 无 pi 依赖可单测）、依赖方向可循（lint 可强制）、与 pi 生态词汇同构（新成员低心智负担）、范式统一（管线 + 能力单元 + 单例的职责划分清晰）。

负：迁移期文件移动的 import/测试路径牵动（机械性，五阶段消化）；管线化初期有样板感（每协议一管线），阶段粒度靠评审约束防过度拆分；规划分支本身不产出可运行增量。
