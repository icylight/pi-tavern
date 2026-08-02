# ADR-0005：五层架构——IO 管线范式（adapter / application / skills / runtime / shared）

- 状态：**Draft**（待四方评审收敛 + User 批准 + 立项；本 ADR 规划于 `feat/arch-refactor-planning` 分支，不进入实施）
- 决策者：User（层模型、IO 管线范式与 skill/mcp 概念映射）、Arch（落地映射与迁移）、Dev/QA（实施与验收）
- 关联：User 2026-08-02 重构指示；动机 = 可维护 / 可读 / 规范

## 背景

`src/creator/creator-runtime.ts`（1881 行）单体：WS 传输（handleConnection/心跳）、业务编排（submitUserPersonaMessage/join/claim/ready/leave）、持久化（游标/FIRST_PERSIST_*/session 文件恢复）全部混在一个类；依赖方向靠约定不靠结构；目录与命名无统一规范（22 文件 6415 行，按既有目录分布）。

设计范式 = **IO 模型**：application 层是请求级 IO 管线——输入与中间状态收于管线实例、阶段为私有 Method、一致性边界由主管线持有；其下为原子能力层（skills），进程级共享能力由 runtime 单例持有（MCP 同构）。PiTavern 无 DB，「事务」对应物为文件原子写与游标单调推进。

## 决策

### 1. 五层定义（IO 管线语义）

| 层 | 定义 | PiTavern 落点 |
| --- | --- | --- |
| **adapter** | 薄入口：显式展开管线顺序与分支；领域结果 → 协议响应 / notify / steer | commands / tools / headless / ui（presenter·renderers·resume-projection）/ WS handler 壳 |
| **application** | **请求级 IO 管线**：一次协议消息 / 内部事件 = 一个管线实例；输入与中间 IO 收于实例字段；阶段 = 私有 Method；一致性边界由主管线 Method 持有；子管线只给有独立步骤/状态/复用边界的流程 | SubmitMessage / Join / Claim / Ready / Leave / 查询 管线；`tavern-controller.ts` 的 transitionTail 串行化 = 已存在的管线雏形 |
| **skills** | 原子能力（原 data）：单一用途、一次明确读写；按业务能力组织；不开启一致性边界、不编排；显式接收管线传入的上下文；纯计算不隐藏 IO；返回领域错误由 adapter 映射 | session-store / cursor-store / descriptor-store / resume-projection / discovery 原语 |
| **runtime** | 进程单例（**MCP 同构**）：WS server + 连接表 + 心跳 + 能力实例装配；不保存单次任务中间状态 | 瘦身后的 CreatorRuntime / CharacterRuntime；join-attempt（WS 客户端传输）；reload-handoff（进程级交接） |
| **shared** | 跨进程通用契约 | protocol（messages·codec）/ config / constants / runtime-close |

### 2. 依赖规则（硬约束）

- **依赖单向**：adapter → application → runtime → skills → shared；允许跨层依赖任意下层，禁止上行
- **文件 IO 仅限 skills**：application 不直接读写文件；adapter 可直查 skills（纯读）；skills 不编排流程
- runtime 是唯一单例持有者（连接 + 能力实例装配点），application 经注入取接口
- skills 无 pi 依赖、可单测（resume-projection 先例推广）
- 纯计算 skill 不隐藏 IO：计算上下文由管线显式组装后传入

### 3. 一致性（文件原子写 + 游标单调推进）

- PiTavern 无数据库：写入保证 = 会话文件原子 append + 游标单调推进 + 失败恢复（FIRST_PERSIST_*/recoverSessionManagerFromFailedAppend）——以代码事实为准，不借用事务概念
- 持久化边界归管线 Method 持有；skills 只接收显式传入的上下文，不自开自合
- 不引入事务/Outbox 抽象（无 DB，无对应物）
- 跨消息异步状态的归属见决策 7

### 4. 双进程

- creator 进程与每个 character 进程各实例化一套（adapter/application/skills/runtime）；只有 shared 跨进程
- 组合根 = `src/index.ts`，与 pi 扩展生命周期对齐

### 5. 契约不动 + 行为零变化

- protocol/messages.ts 的 wire schema 本轮零改动（动它触发全量门禁）
- 纯结构重构：任何可观察行为（协议/持久化格式/时序）不变
- 每阶段独立验证（unit + 定向 acceptance），沿验证工作流 V 阶梯

### 6. 层名

- **skills**：取 agent-skill 语义（原子能力单元）；与 pi 宿主 SKILL.md 系统区分（我们不加载宿主技能）；等价 MCP 术语 capabilities

### 7. 跨消息异步状态归属（预演裁决，2026-08-02）

跨消息异步长流程（如 #38 steer：消息 B 读取「消息 A 触发的 run 状态」决策投递）按以下切分：

- **run 生命周期状态机**（active/streaming/settled + watchdog）= 进程级会话状态，留在 runtime——跨消息状态的唯一居所
- **steer 决策策略**（读 run 状态 → 判 idle/steer/queue）= application/character-pipelines，纯策略无状态
- **投递通道**（notify/WS）= transport（runtime 下）

管线/门面只显式读写 runtime 会话状态，**不自行缓存跨消息状态**——请求级管线不背长流程状态（防迁移时把长流程状态塞进管线实例）

## 目标结构（22 文件映射）

```
adapter:      index.ts(组合根) / commands.ts / headless.ts / ui/(tavern-ui-presenter·renderers·resume-projection)
application:  controller/tavern-controller.ts(管线雏形) / 新拆:creator-pipelines/(submit-message·join·claim·ready·leave·query) / character-pipelines/(发言策略·steer 策略,自 character/group-chat-input.ts 拆出,#38 契约面)
skills:       新拆:data/(session-store·cursor-store·descriptor-store) + discovery/(active-descriptor·discover-group-chats) + creator/group-chat-sessions.ts + creator/group-chat-state.ts
runtime:      creator-runtime.ts(瘦身:WS+心跳+装配) / character-runtime.ts(瘦身) / character/join-attempt.ts / controller/reload-handoff-registry.ts
shared:       protocol/(messages·codec) / config/(character-card·load-config) / shared/(constants·runtime-close)
```

拆解重心：

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

## 否决的替代方案

| 方案 | 否决理由 |
| --- | --- |
| 大爆炸式一次重构 | 单体一次性拆 = 高风险，无法逐层验证 |
| 保持现状 | 违背动机，单体只会随新能力继续膨胀 |
| 按领域包（不按层） | 群聊/角色/协议域内仍混传输与持久化，依赖方向不可循 |
| 引入 DI 容器 | 项目规模不需要，组合根手动装配即可，零新依赖 |
| 引入事务/Outbox 抽象（跨层框架化） | PiTavern 无 DB，一致性单元只是文件原子写，不引入事务框架 |

## 后果

正：可读性（小文件单职责）、可测性（skills 无 pi 依赖可单测）、依赖方向可循（lint 可强制）、与 pi 生态词汇同构（新成员低心智负担）、范式统一（管线 + 原子能力 + 单例的职责划分清晰）。

负：迁移期文件移动的 import/测试路径 churn（机械性，五阶段消化）；管线化初期有样板感（每协议一管线），阶段粒度靠评审约束防过度拆分；规划分支本身不产出可运行增量。
