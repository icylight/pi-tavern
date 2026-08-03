# ADR-0006：轻量「当前决定」状态机制——决策状态声明与版本替代（#107）

- 状态：**Accepted**（契约四方确认后落盘；待实现与验收闭环）
- 决策者：架构师（契约设计/评审）、开发工程师（实现）、产品经理（范围与 Task Brief）、测试工程师（验收矩阵）
- 关联：GitHub #107（B 方案：轻量「当前决定」状态）、#104（环境文本时间注入先例）、ADR-0004（投递时机，不受影响）、docs/workflow.md（四方协作纪律）

## 背景

四方协作中多次出现「角色反复误判当前裁决」：README 位置议题 8+ 轮摇摆，角色基于旧裁决表态、对「当前决定是什么」产生冲突。根因 = 缺「当前有效状态」唯一事实源——sequence/时间只答「先后」不答「有效」；裁决是状态非消息，各角色自行归约 → 冲突。

探索结论（#107）：问题值得进入产品设计，推荐 B = 轻量「当前决定」状态（版本 + 替代关系 + 最终结果），不实现投票（C 二期可选）；A（工作流约定）已实证失败（约定依赖角色纪律，纪律不可靠是本 session 事实前提）。

## 关键事实（四方讨论收敛，含反例集）

- 反例集：R1（旧裁决仍被引用）、R2（并入 R1：旧版本正式裁决不被引用）、R4（转述失真/声明与事实不符）、R5（离线回归丢状态）；C1-C4（乱序拼装/reload 丢历史/离线回归/悬空 supersedes）；C5（已决定提案可否被替代——裁决：可，但仅限 User 关闭的新提案）；C7-C10（撞名/并发版本冲突/配额语义/注入截断）；M1/M2（声明泛滥/活跃当决定）、F1-F3（裁决声明不同步/不读注入/已决定项继续辩论）。
- 验收锚点：三层齐备后重放「README 位置议题」场景 ≤ 1 轮摇摆。
- 契约零漂移：本机制全部为**新增**（新消息类型/新状态存储/新注入节），不修改既有 schema 与语义。

## 决策

1. **状态模型**：`DecisionRecord { id, version, content, status: proposed|superseded|closed, supersedes: string[], decided_by, created_at, updated_at }`——Creator 侧 JSONL 持久化（独立命名空间，与 public_message 零耦合）；版本不可变（id@version → content 一对一）；角色不自行归约（Creator 机械归约）。
2. **状态机**：proposed → superseded（被任何提案替代）；proposed → closed（提案人/User）；closed → superseded（**仅被 User 关闭的新提案替代**——「谁决定谁推翻」权限对等）；superseded 终态不可再被引用为 supersedes 目标（防循环）。
3. **校验五项（Creator 机械，非 LLM）**：① 目标存在；② 未被活跃替代（superseded 终态不可引用）；③ 版本单调；④ DAG 无环；⑤ 权限对等（supersedes 含 closed ⇒ 声明须 status=closed 且 decided_by=user_persona）。
4. **工具**：`tavern_decision_declare`（独立消息类型 request/response；成功 = 状态链快照，业务拒绝 = 错误码：target_missing / target_closed_denied / cycle_rejected / version_not_monotonic / permission_denied / quota_exceeded，同 stale/round_limit 风格）。
5. **配额与并发**：declare 不计 round 配额；每角色每轮成功上限 3（成功才计次，失败不消耗）；单写者串行（先到先得、撞名拒绝）；校验+写入原子。
6. **注入节**：环境文本「当前有效裁决」段（活跃提案集 + 当前决定标注；超 5 条机械截断 + 「+M 更早」显式标注；无有效裁决时省略整段）——与 #104 时间节并列，复用 group_chat_update + 拉取路径，零新推送类型。
7. **唯一入口**：工具声明 = 状态唯一入口；文字裁决永不进入状态（绕过工具 = 状态不可见 = 自然激励）。
8. **工作流融入**：引用锚点从约定（PM 播报）换为机制（注入段）；PM 裁决必须 declare 后才生效（约定管行为、机制管事实）；适用场景 = 裁决类 + 阶段收口类（按需粒度，默认零噪音）；验收留痕从引用 seq 升级为决定 id@version + 命令 + hash 三重锚定。
9. **兼容性**：新消息类型可选演进（旧客户端不带该类型 = 旧行为不变 = 回到现状）。

## 不变式（全部维持）

- 既有协议 schema 零修改（纯新增）；public_message/sequence 语义零变化；
- 状态链与消息流解耦（O(1) 校验，无消息时序依赖）；
- 不做立场追踪/不做投票/不做查询工具（MVP 边界）；C（投票）为二期可选层；
- 不改变四方职责与 docs/workflow.md 流程（决策状态是「讨论收敛的机械锚点」，非工作流引擎）。

## 落点（分层纪律）

- protocol 层：decision_declare request/response wire 类型（纯新增）；
- data 层：src/data/decision-store.ts（DecisionRecord JSONL 追加/加载/归约）；
- creator 层：校验五项 + 配额计数 + 状态归约（单写者串行，组合根组装）；
- character 层：buildContent「当前有效裁决」注入节（消费端渲染）；
- extension 层：tavern_decision_declare 工具注册（tavern-tools.ts 同模式）。

## 契约修订记录（2026-08-03，User 静态审查后，实现闭环并入）

**修订 1：User 入口 = 独立命令（F2）**——declareAsUser 的真实调用路径 = 独立命令入口（`/tavern-decision '<json>'`，headless/命令层，User 在终端执行，decided_by=user_persona 由命令层固定注入）；tavern_decision_declare 工具维持 character 态守卫不变；「文字裁决永不进状态」唯一入口原则保持（命令 = 机械执行，非解析文字）。

**修订 2：决策变化 = 输入事件（F3）**——广播 group_chat_update 携带 decision_snapshot（与 getGroupChatStateMessage 同源装配）；角色侧快照变化（结构不等）即触发 deliver（零公开消息也注入），投递并入既有通道，零新推送类型。

**修订 3：持久化顺序与原子性（F1/F6）**——状态写入顺序 = 校验 → applyDeclaration（内存）→ 写盘（含替代结果的完整链，temp+rename 原子替换）；磁盘始终为「已应用替代关系」的完整快照，重启恢复不重放。

**修订 4：配额语义（F4）**——declare 计数按 character_id（非 sessionId）；新讨论轮次重置；reload handoff 传递计数（不恢复额度）。

**修订 5：注入含 content（F5）**——注入节渲染含决策内容（限长 120 截断 + 省略号），「当前有效裁决」= 内容 + 状态 + 替代链（转述失真根治闭环）。

**修订 6：截断方向（F7）**——活跃提案按最新优先取前 N（DECISION_INJECTION_LIMIT），「+M 个更早活跃提案」标注与方向一致。

**修订 7（G1）**：supersedes 为协议可选字段（缺省 = 空数组）；管线/命令入口归一 `?? []`，校验层兜底防御——省略字段的合法声明不崩溃、按无替代处理。

**修订 8（G2）**：体积三层防御——① 入站 content ≤ 64 KiB（与 public_message 同源上限，超限拒绝）；② 活跃提案总上限 16（active_limit_reached）；③ 广播/查询快照 content 渲染截断（存储保留完整）——1 MiB 出站预算永不触顶；BroadcastHub.send 区分编码失败与 socket 失败（编码失败记录并跳过，绝不清理成员）。

**修订 9（G3）**：/tavern-decision 命令入口复用 wire schema 运行时校验（Compile+Check），与管线同一校验语义——非法 status/version/supersedes/空 id 拒绝且不持久化。

**修订 10（G4，契约语义修正）**：**同 id 版本修订 = 隐式替代**——任何新版本声明成功（proposed 或 closed）即机械置同 id 低版本 superseded（同 id 仅一个活跃版本）；supersedes 字段专责跨提案替代（D2 替代 D1）。原「仅显式 supersedes 淘汰」语义废止（T14 断言随修）。

**修订 11（G5）**：关闭权限绑定**被关闭版本**——closed 声明校验 = 同 id 活跃记录中 version 最大者（将被隐式替代的最新版）的声明者或 User；禁止 find 首条活跃。

**修订 12（G6）**：删除群聊历史同步删除 decisions sidecar，路径 = 真实 {groupId}.decisions.jsonl（显式参数优先，主文件删除前读 header 推导兜底）。

## 验收（QA 矩阵锚点）

T1-T8（工具层机械校验）/ T9-T13（注入层格式与乱序）/ T14-T17（状态层恢复可追溯）/ T18-T20（工作流融合层 F 类）——覆盖 R1-R5 + C1-C10 + M1/M2/F1-F3 全锚点；兼容性回归（未注册工具时旧行为不变）。
