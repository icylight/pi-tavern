# 重构实施计划:五层架构(IO 管线范式)

- 状态:**Draft**(规划分支产出,随 ADR-0005 一起四方评审;批准后另立实施分支)
- 关联:ADR-0005(五层定义与映射)、QA 行为等价验收基准承诺(2026-08-02)
- 原则:契约零改动、行为零变化、每阶段独立绿、试点优先「测试覆盖最厚」模块

## 总则

1. **行为等价基准(QA 承诺)**:每阶段迁移后跑受影响层(契约零改动 → 回归面按 src 模块 → acceptance 映射表界定);阶段内不留红
2. **试点排序(QA 建议)**:迁移顺序优先选测试覆盖最厚的模块试点,回退安全;QA 补 22 模块覆盖现状表作为排序输入
3. **阶段门禁**:每阶段末 unit 全量 + 定向 acceptance;Phase 3/5 全链门禁
4. **粒度约束**:管线/技能按「是否有独立步骤、状态与复用边界」判定,防过度拆分(ADR-0005 后果负项)
5. **契约不动**:protocol/messages.ts wire schema 零改动;「拆 schema 与行为」挂 Phase 4 可选

## 阶段明细

### Phase 1:skills 提取(先试点)

- 内容:data/(session-store·cursor-store·descriptor-store) 从 creator-runtime 抽出;discovery/ 迁入;group-chat-sessions/group-chat-state 归位;resume-projection 确认归属(先例)
- 试点顺序:resume-projection(有单测先例)→ discovery(独立 308 行)→ session/cursor 持久化块
- 验证:unit 全量 + 定向(message-sync / persistence / discovery)
- 出口:data/ 全部无 pi 依赖、可单测;runtime 不再直接写文件

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
| 迁移期 import/测试路径 churn | 五阶段切分消化;每阶段独立 commit、独立验证 |
| 管线化初期样板感 | 评审约束阶段粒度;仅「有独立步骤/状态/复用边界」的流程建管线 |
| 试点模块回退 | 先迁移覆盖最厚模块(QA 覆盖现状表);回退 = 单文件 revert + 定向回归 |
| 门禁波动(环境) | 白名单零 LLM 环境已确定性化(#52);配对 A/B 铁律(§7)适用一切对照 |
| 规划与实施漂移 | 分支只规划;批准后另立实施分支,按阶段逐个开 commit/PR |

## 待四方确认项

1. 22 文件映射表是否有归属争议(尤其 discovery 归属:skills vs application)
2. 试点顺序(以 QA 覆盖现状表为准)
3. Phase 4「拆 schema 与行为」是否纳入本期(默认挂起)
4. 每阶段 PR 粒度(一阶段一 PR 还是合并小步)
