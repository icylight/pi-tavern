# 重构实施计划:五层架构(IO 管线范式)

- 状态:**Draft**(规划分支产出,随 ADR-0005 一起四方评审;批准后另立实施分支)
- 关联:ADR-0005(五层定义与映射)、QA 行为等价验收基准承诺(2026-08-02)
- 原则:契约零改动、行为零变化、每阶段独立绿、试点优先「测试覆盖最厚」模块

## 总则

1. **行为等价基准（QA 承诺 + characterize-first）**：迁移 PR 内先写行为钉测（旧代码上绿）→ 迁移 → 断言零改动仍绿 = 行为零变化成立；每拆一层补一层钉测（裸奔文件随迁移逐个补钉）
2. **试点排序（QA 覆盖现状表 v2 定序）**：resume-projection（12 钉测，先例）→ active-descriptor（覆盖最厚，兜底最强）→ session/cursor；discover-group-chats 有 integration 专测，**无需先补钉再迁**（v1 判断作废）
3. **阶段门禁**：每阶段末 unit 全量 + 定向 acceptance；Phase 3/5 全链门禁
4. **粒度约束（Arch 判据 + QA 细化）**：管线 iff ≥3 顺序阶段 + 共享中间状态 +（≥2 入口复用 或 需要显式安排读写顺序）；短流程留用例门面；Phase 1 按 skills 模块拆 2-3 个 PR，各带定向验证
5. **契约不动**：protocol/messages.ts 的消息格式定义（wire schema）零改动；每阶段 git diff 核对 messages/codec 零 diff；「拆 schema 与行为」挂 Phase 4 可选
6. **新增原语同 PR 必带钉（2026-08-02 Arch 建议 + PM 定夺）**：新增/扩展 skills 原语（如文件层 read/write/原子写）必须与实现同 PR 带直接钉测（unit 层断言原语语义：抛错/原子性/mkdir/损坏容错；编排层语义如吞错归 integration/runtime 层）——不允许仅依赖间接覆盖；先钉后迁纪律的补全（PR-B 缺口教训：行为全绿但钉测层缺失，QA 把关拦截）；QA 验收按此清单复核，豁免须 PM 明示留痕。**执行形态（QA 定）**：验收时自动对照「git diff 中 src/data/（skills 层）新增 export 函数名 ↔ 全 test/ 引用计数 ≥1」，grep 一条命令可验，无匹配即钉测缺口；与「契约零 diff」并列进验收证据模板

## 模块覆盖现状（QA 实测 v2，2026-08-02）

- **裸奔仅 4 薄壳**：headless / renderers / runtime-close / constants（无大文件裸奔）
- group-chat-input：19 用例专测（非裸奔；三重风险降级为「大文件 + 迁移面广」）
- discover-group-chats：integration 专测（迁移无需先补钉）
- **codec：9 用例钉测已存在**（验收口径「可先行」项已完成）
- resume-projection：12 用例钉测（#42 契约固化，characterize-first 模板现成）
- active-descriptor：13 引用（5 acceptance），仍最厚

→ 试点优先级 = 覆盖厚 + 依赖面小（resume-projection → active-descriptor → session/cursor）

## 阶段明细

### Phase 1:skills 提取(先试点)

- 内容：data/(session-store·cursor-store·descriptor-store) 从 creator-runtime 抽出；discovery/ 迁入（归属已定案：整体 skills）；group-chat-sessions/group-chat-state 归位；resume-projection 归位（裁决定案：skills）
- 试点顺序（QA v2 定序）：resume-projection（12 钉测先例）→ active-descriptor（覆盖最厚）→ session/cursor；discover-group-chats 有 integration 专测，无需先补钉
- PR 切分：按 skills 模块拆 2-3 个 PR，各带定向验证（防单 PR 过大）
- 验证:unit 全量 + 定向(message-sync / persistence / discovery)
- 出口：data/ 全部无 pi 依赖、可单测；**全仓文件 IO 调用点 grep 审计 = 非 skills 层 0 调用点**（adapter/shared 直读直写清零；契约面 messages/codec 只编解码，实测触盘则一并收敛）；runtime 不再直接写文件

### Phase 2:application 提取(管线化)

- 内容：协议消息 → 请求级管线实例（submit-message / join / claim / ready / leave / query）；tavern-controller 的 transitionTail 一次只处理一个轮次（排队执行）保留为管线雏形基座；store 由 runtime 交给管线（不自建）
- 验证:unit + 定向(round / speak-order / join-resume)
- 出口：每个协议消息有对应管线；读写顺序与落盘时机归管线 Method 安排

### Phase 3：runtime 瘦身 + 装配点（里程碑）

- 内容：CreatorRuntime/CharacterRuntime 收敛为骨架（WS + 心跳 + 连接表 + 装配）；index.ts 成为唯一装配点（组合根）；join-attempt/reload-handoff 归位；#66 watchdog（run 卡死超时 → 强制 settle，复用 #14 机制思路）
- 验证:**全链门禁**(unit + integration + acceptance,V0 留痕)
- 出口：**绝对行数目标**——终态 creator-runtime ≈ 400 行骨架 + 已拆模块（Phase 2 已消化 1881→1193；PR-B 剩余任务 = 1193→~400，约 800 行拆出）

**Phase 3 裁决留痕（Arch 2026-08-02）**：
- ① config 豁免成立：组合根唯一 loadTavernConfig、runtime 全收参零直读（决策 7 精神）；commands 保留注入点供测试；豁免理由：装配与行为分离
- ② 组合根成立：ADR-0005 明示 index.ts=组合根；装配区无业务逻辑只构造+注入；headless.ts 同归 adapter 注册点
- ③ 出口数字为绝对目标（见上），非按现基线增量
- ④ #66 契约四要素：**判定**（settle 超时阈值 X 未到 = wedged）、**动作**（强制 settle → 投递挂起批次）、**副作用**（与正常 settle 同路径幂等——游标只在成功投递后推进、N→1 聚合不变）、**阈值归属**（X 为产品参数，默认 180_000ms=3min 常量 + 构造注入点供测试短值，PM 定、User 可调；agent_start 布防 run watchdog、agent_end 后 #14 5s 显示 watchdog 并存）
- ⑤ PR-B 拆骨架时 watchdog/run 状态域留 runtime（决策 7），防 PR-C 返工
- ⑥ run watchdog 覆盖**双 wedged 窗口**（Arch 核实，实现注释/红钉引用）：① agent_start 后无 agent_end（完全卡死）② agent_end 已到但 agent_settled 永不到（#14 只复位 is_streaming、不碰 isAgentActive，② 同为真洞）；watchdog 在 agent_start 布防、agent_settled 清除 → v2 为 #14 超集

### Phase 4:规范统一(可选挂靠)

- 内容:目录/命名/依赖方向 lint(biome 加固);「拆纯 schema 与行为」若批准在此期执行
- 验证:unit + 定向
- 出口:依赖方向可由 lint 强制(adapter 不得触 skills、application 不碰文件)

**Phase 4 定稿留痕（2026-08-02）**：
- lint 选型（Arch 裁决）：biome 2.3.5 `noRestrictedImports` **patterns 方向性方案**（group=gitignore 源匹配 + importNamePattern=regex 禁入；ADR 五层方向矩阵 ≤8 条编码；单一工具链、CI `biome check src/` 天然覆盖；importNamePattern 匹配书写形 specifier、跨目录深度用 `(\.\./)*` 前缀兼容）；表达力不足时退自定义 script（Dev 定）
- **patterns 实测证伪（2026-08-02 Dev 实验）**：group glob 匹配**被 import 模块 specifier**（无「源文件路径」维度），「adapter 文件不得 import data/」不可表达（全局禁 data/ 误杀 controller→skills 合法引用）→ 按预案退 **scripts/lint-layers.mjs**（~50 行零依赖，`npm run lint:layers` 并 CI，与 biome check 并列）；前置实验教训：选型以实测能力为准，不凭文档语义
- **规则矩阵定稿（Arch 边界裁决）**：① adapter→skills 禁行为面（纯函数/类型豁免、默认实现上移组合根 index.ts 注入——commands/headless 只留注入面，unit 注入面已存在测试零改动；getGroupChatCursorDirectory 纯路径函数豁免）② application→文件 IO 禁（controller 零 fs 已核 0 处，直接启用）③ runtime→node:fs 禁直连（creator-runtime 死导入先删零调用点；creator-factory/组合根豁免——默认依赖装配语义）
- PR 形态（PM 裁决）：1 PR（基线清零 + lint 加固 + pkill 转义并入）；「拆 schema 与行为」挂起待 User 拍板
- 测试慢分析（Arch 静态切片）：墙钟模型 = 13 文件 ÷ 8 worker = 2 批，批界 = 批内最长文件（~40-50s）→ 99.5s 吻合；spawn 27×~6s÷8 ≈ 20s 纯启动；worker 拐点 8；杠杆排序：① 进程复用试点（省 ~15-20s）② 文件合并至 ≤8（单批省 ~45s，受最长文件钳制）③ join 3s 延迟注入 ④ worker 试探——等 QA 执行层数据合流后 PM 决策

### Phase 5:收口

- 内容:全链门禁 + 五层依赖图(架构文档)+ ADR-0005 转 Accepted
- 验证:全链门禁,V0 留痕
- 出口:重构完成,基线更新

## 风险与对策

| 风险 | 对策 |
| --- | --- |
| 迁移期 import/测试路径牵动 | 五阶段切分消化；每阶段独立 commit、独立验证 |
| **IO 收敛面超出预期（Dev 实测：16/22 文件直触 IO，含 adapter 侧 commands/tavern-ui-presenter/headless 与 shared 侧 messages/config）** | Phase 1 以「读写点唯一化」为原则覆盖全仓：runtime 内 IO + adapter 直读点 + shared 侧 IO 全部收进 skills；协议侧 IO 若属契约无关工具则一并迁出；按 1.5× 规模预留 Phase 1 |
| 管线化初期样板感 | 评审约束阶段粒度;仅「有独立步骤/状态/复用边界」的流程建管线 |
| 试点模块回退 | 先迁移覆盖最厚模块(QA 覆盖现状表);回退 = 单文件 revert + 定向回归 |
| 门禁波动(环境) | 白名单零 LLM 环境已确定性化(#52);配对 A/B 铁律(§7)适用一切对照 |
| 规划与实施漂移 | 分支只规划;批准后另立实施分支,按阶段逐个开 commit/PR |

## 遗留项清单

1. ~~ADR-0005 §3「一致性边界（无 DB 的事务对应物）」表述~~（User 评论 r3698822940「这部分太奇怪了」）——**已解决**：User 裁定「这个 pr 上改」，§3 重写（标题改「消息与游标怎么保存」、删事务类比、跨消息裁决归决策 7）+ §2 依赖规则简化已随 PR #55 一并入库（2026-08-02）

## 待四方确认项（评审收敛进度）

1. ~~22 文件映射归属~~ 已收敛：discovery 整体 skills（QA 无编排判断）；余映射无争议
2. ~~试点顺序~~ 已收敛：QA 覆盖表 v2 定序（resume-projection → active-descriptor → session/cursor；discover 有 integration 专测无需先补钉）
3. Phase 4「拆 schema 与行为」是否纳入本期（默认挂起）——待 User/PM 拍板
4. 每阶段 PR 粒度：已定每阶段一 PR，Phase 1 内按模块拆 2-3 个 PR
5. characterize-first 方法纳入行为等价基准——已写入总则 1
