# 重构实施计划:五层架构(IO 管线范式)

- 状态:**Draft**(规划分支产出,随 ADR-0005 一起四方评审;批准后另立实施分支)
- 关联:ADR-0005(五层定义与映射)、QA 行为等价验收基准承诺(2026-08-02)
- 原则:契约零改动、行为零变化、每阶段独立绿、试点优先「测试覆盖最厚」模块

## 总则

1. **行为等价基准（QA 承诺 + characterize-first）**：迁移 PR 内先写行为钉测（旧代码上绿）→ 迁移 → 断言零改动仍绿 = 行为零变化成立；每拆一层补一层钉测（裸奔文件随迁移逐个补钉）
2. **试点排序（QA 覆盖现状表定序）**：resume-projection（小+纯计算）→ active-descriptor（acceptance 覆盖最厚，兜底最强）→ session/cursor；discover-group-chats 裸奔，**先补钉测再迁**
3. **阶段门禁**：每阶段末 unit 全量 + 定向 acceptance；Phase 3/5 全链门禁
4. **粒度约束（Arch 判据 + QA 细化）**：管线 iff ≥3 顺序阶段 + 共享中间状态 +（≥2 入口复用 或 显式一致性边界）；短流程留用例门面；Phase 1 按 skills 模块拆 2-3 个 PR，各带定向验证
5. **契约不动**：protocol/messages.ts wire schema 零改动；每阶段 git diff 核对 messages/codec 零 diff；「拆 schema 与行为」挂 Phase 4 可选

## 模块覆盖现状（QA 实测，2026-08-02）

- unit 钉住（9）：creator-runtime / character-runtime / commands / index / join-attempt / tavern-controller / character-card / reload-handoff / group-chat-state
- acceptance 钉住（1）：active-descriptor（8 测试文件引用，全仓最厚）
- 裸奔（12）：group-chat-input / messages / tavern-ui-presenter / discover-group-chats / group-chat-sessions / headless / load-config / resume-projection / codec / renderers / constants / runtime-close

→ 试点优先级 = 覆盖厚 + 依赖面小（resume-projection → active-descriptor → session/cursor）；裸奔模块迁前必补钉

## 阶段明细

### Phase 1:skills 提取(先试点)

- 内容：data/(session-store·cursor-store·descriptor-store) 从 creator-runtime 抽出；discovery/ 迁入（归属已定案：整体 skills）；group-chat-sessions/group-chat-state 归位；resume-projection 确认归属（先例）
- 试点顺序（QA 定序）：resume-projection（先例+纯计算）→ active-descriptor（覆盖最厚）→ session/cursor；discover-group-chats 先补钉测再迁
- PR 切分：按 skills 模块拆 2-3 个 PR，各带定向验证（防单 PR 过大）
- 验证:unit 全量 + 定向(message-sync / persistence / discovery)
- 出口：data/ 全部无 pi 依赖、可单测；**全仓文件 IO 调用点 grep 审计 = 非 skills 层 0 调用点**（adapter/shared 直读直写清零；契约面 messages/codec 只编解码，实测触盘则一并收敛）；runtime 不再直接写文件

### Phase 2:application 提取(管线化)

- 内容:协议消息 → 请求级管线实例(submit-message / join / claim / ready / leave / query);tavern-controller 的 transitionTail 串行化保留为管线雏形基座;store 改注入
- 验证:unit + 定向(round / speak-order / join-resume)
- 出口:每个协议消息有对应管线;一致性边界归管线 Method 持有

### Phase 3:runtime 瘦身 + 组合根(里程碑)

- 内容:CreatorRuntime/CharacterRuntime 收敛为骨架(WS + 心跳 + 连接表 + 装配);index.ts 成为唯一组合根;join-attempt/reload-handoff 归位
- 验证:**全链门禁**(unit + integration + acceptance,V0 留痕)
- 出口:creator-runtime 1881 行 → ~400 行骨架 + 已拆模块

### Phase 4:规范统一(可选挂靠)

- 内容:目录/命名/依赖方向 lint(biome 加固);「拆纯 schema 与行为」若批准在此期执行
- 验证:unit + 定向
- 出口:依赖方向可由 lint 强制(adapter 不得触 skills、application 不碰文件)

### Phase 5:收口

- 内容:全链门禁 + 五层依赖图(架构文档)+ ADR-0005 转 Accepted
- 验证:全链门禁,V0 留痕
- 出口:重构完成,基线更新

## 风险与对策

| 风险 | 对策 |
| --- | --- |
| 迁移期 import/测试路径 churn | 五阶段切分消化；每阶段独立 commit、独立验证 |
| **IO 收敛面超出预期（Dev 实测：16/22 文件直触 IO，含 adapter 侧 commands/tavern-ui-presenter/headless 与 shared 侧 messages/config）** | Phase 1 以「读写点唯一化」为原则覆盖全仓：runtime 内 IO + adapter 直读点 + shared 侧 IO 全部收进 skills；协议侧 IO 若属契约无关工具则一并迁出；按 1.5× 规模预留 Phase 1 |
| 管线化初期样板感 | 评审约束阶段粒度;仅「有独立步骤/状态/复用边界」的流程建管线 |
| 试点模块回退 | 先迁移覆盖最厚模块(QA 覆盖现状表);回退 = 单文件 revert + 定向回归 |
| 门禁波动(环境) | 白名单零 LLM 环境已确定性化(#52);配对 A/B 铁律(§7)适用一切对照 |
| 规划与实施漂移 | 分支只规划;批准后另立实施分支,按阶段逐个开 commit/PR |

## 遗留项清单

1. ~~ADR-0005 §3「一致性边界（无 DB 的事务对应物）」表述~~（User 评论 r3698822940「这部分太奇怪了」）——**已解决**：User 裁定「这个 pr 上改」，§3 重写（标题改「一致性（文件原子写 + 游标单调推进）」、删事务类比、跨消息裁决归决策 7）+ §2 依赖规则简化已随 PR #55 一并入库（2026-08-02）

## 待四方确认项（评审收敛进度）

1. ~~22 文件映射归属~~ 已收敛：discovery 整体 skills（QA 无编排判断）；余映射无争议
2. ~~试点顺序~~ 已收敛：QA 覆盖现状表定序（resume-projection → active-descriptor → session/cursor；裸奔先补钉）
3. Phase 4「拆 schema 与行为」是否纳入本期（默认挂起）——待 User/PM 拍板
4. 每阶段 PR 粒度：已定每阶段一 PR，Phase 1 内按模块拆 2-3 个 PR
5. characterize-first 方法纳入行为等价基准——已写入总则 1
