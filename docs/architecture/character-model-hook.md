# Character Model Hook（角色模型/思考强度临时覆盖）

> 状态：定稿（Issue #180，2026-08-17 五方收敛；含 thinking 扩围，PM 定案）
> 属主：Arch（docs/architecture/）
> 本文记录角色卡 model/thinking 配置的运行时切换机制：加入时 best-effort 切换到角色卡声明 profile，离开（含断线回 idle）时 best-effort 恢复加入前基线；失败不阻塞主流程、只提示。行为入口语义见 [interaction-model](interaction-model.md)；实现约束见 [architecture](architecture.md) 五层依赖。

## 1. 需求边界（定稿）

- 角色卡 frontmatter 新增两个独立可选字段：`model: "provider/id"` 与 `thinking: <level>`；未配置行为完全不变。
- thinking 合法 7 值：`off|minimal|low|medium|high|xhigh|max`（与 pi 配置面 `ModelThinkingLevel` 一致，runtime 层 ThinkingLevel 不含 off）；off = 显式关闭思考，两类模型下语义自洽（reasoning 默认支持 off；非 reasoning 仅 off）。
- 加入后 best-effort 切换到角色卡 profile；正常离开 best-effort 恢复加入前基线；失败只提示、不阻塞主流程。
- 加入期间允许手动换模型/强度；离开仅恢复「本轮配置过且合法」的维度（restore mask），未配置维度不额外回滚中途手动值。
- 强杀不保证恢复，作为已知限制。
- 明确不做：自动降级、候选列表、动态路由、运行中热改角色卡、wire/persistence 变更、事件总线/插件框架。

## 2. 关键决策：运行时切换而非启动期参数

model/thinking 是 pi 会话的**运行时状态**——扩展 API 可读写（`pi.setModel` / `pi.setThinkingLevel` / `ctx.model` / getter），setModel 会把新模型持久化为 settings 默认值（副作用契约见 §9）。因此本功能选择运行时 hook 而非启动器透传，理由：

- 需求语义是「临时覆盖」（加入切、离开回），启动器固定参数无法表达"离开恢复"；
- pi 扩展 API 已提供运行时切换能力，无需新增 pi 能力；
- 复用现有 join/leave 串行状态机保证提交顺序，仅新增一条轻量异步队列保证执行顺序。

## 3. 生效路径一览

| 生命周期事件 | 行为 |
| --- | --- |
| claim 成功进入 Character | 拍基线（capture）→ 提交切换（switch，目标 = 角色卡 profile；未配置维度跳过） |
| leave（主动退出 / 群聊结束回滚） | 提交恢复（restore，目标 = 本轮槽位 profile，仅已配置维度） |
| 断线 handleConnectionClosed 回 idle | 视为离开：提交 restore（定案：断线回 idle = 离开） |
| detachForReload（Character→Character 保持） | 不触发 restore；队列快照随 handoff 交接 |
| takeReloadHandoff | 重建队列 + 恢复槽位/lastModel/lastThinking + 执行 inFlight remaining（见 §8）；不重跑已执行任务 |
| 进程强杀 | 不承诺恢复；settings 残留为已知限制 |

恢复触发条件统一定义为「离开 Character 态（任何路径）」，与状态迁移一一对应，挂点枚举无例外。

## 4. 队列模型与任务

`src/character/model-transition-queue.ts`（纯逻辑，不依赖 pi SDK、不依赖 node:fs）：

- **单飞串行队列**：全部 profile 操作（capture/switch/restore）进同一条 promise 链 FIFO 执行，同一时刻最多一个 setModel 在途（setThinkingLevel 同步、无在途窗口）。串行状态机保证任务提交序（restore 提交先于下一轮 capture 提交），队列保证执行序与最终一致。
- 三类任务（任务本纯数据，可随快照交接）：
  - **capture** {kind, epoch, mask: {model, thinking}}：执行时按 mask 拍槽位——仅 mask 开启的维度写入 baselines[epoch]；
  - **switch** {kind, epoch, target: {model?, thinking?}}：至少一维；执行序 model → thinking；
  - **restore** {kind, epoch}：执行时读槽位，按槽位 mask 逐维恢复（显式双维 mask，不用「属性是否存在」隐式代替——getter 不可用与未配置不是一回事）；
- **profile 执行语义**：
  - model 维：getter 校正后 lastModel 已 == target.model → 达标短路；否则 setModel，settle 后按实际 getter 校正（回执仅决定告警）；
  - thinking 维（switch）：model 维达标后才 setThinking(target.thinking)；model 缺席（thinking-only）直接 setThinking；model 已提供但 invalid/不可用/未到目标 → 跳过 thinking + warning；thinking throw → 不回滚 model，getter 校正 + warning；
  - restore：槽位 model 维存在 → 恢复 model（undefined = 无模型环境跳过）；槽位 thinking 维存在 → model 恢复达标后 setThinking(槽位.thinking)，model 未达标则跳过 thinking + warning（避免套到错误模型）；model-only mask 不显式回滚 thinking，thinking-only mask 不触碰 model；顺序 model → thinking。

## 5. 三条规则

1. **switch 执行前一刻双校验**（状态 = Character 且 epoch = 当前轮），失败即丢弃——丢弃的必是未执行任务，无需补偿逻辑。
2. **restore 无条件执行，不校验状态/epoch**；执行前 profile 各维「实际值 == 槽位值」则短路 no-op（幂等短路 = 「基线被后续稳定基线吸收」的跳过依据）。restore 是下一轮拍基线前的顺序屏障，不能因已进入新一轮 Character 态而丢弃。
3. **capture 靠队列顺序保证正确性**：leave 流程先提交 restore 才回 idle，join 只能在 idle 后提交 capture，capture 必然排在 restore 之后——读到的必是恢复完成后的真实 profile，瞬态角色 profile 不会被误存为基线。

竞态对照（A→B→leave/join C→leave）：capture#1(A) → switch B(B) → restore#1(A) → capture#2(A) → switch C(C) → restore#2(A)，第二轮活跃最终 C、离开最终 A，基线不被瞬态 B 污染。变体：switch 在途慢 → restore 排队兜底；switch 未执行就 leave → 状态校验丢弃；switch 迟到（epoch 过期）→ epoch 校验丢弃。

## 6. 权威记录与校正

队列维护 lastModel（{provider, id}，Model 无全局唯一单字段必须二元组）与 lastThinking 两条记录：

- 每次任务 settle 后按实际 getter 校正记录（model：getCurrentModel；thinking：getCurrentThinking——同步 API 无回执歧义）；回执仅决定告警（rejected 照常 warning）；
- 事件注入的 ctx.model 与记录不一致时以 ctx.model 校正（覆盖用户手动换模型场景——手动切换绕过队列）；thinking 同理；
- capture 读记录，不依赖随时过期的上下文快照；
- getter 不可用：保留记录 + 观测失败提示。

## 7. 基线生命周期（槽位方案）

基线以**槽位**承载：epoch → `{mask: {model, thinking}, values: {model?, thinking?}}`——mask 显式保存合法配置维度（不用「槽位是否有该属性」隐式代替 mask：getter 暂不可用/值 undefined 与未配置不是一回事）。

- capture 任务携带双维 mask；执行时按 mask 拍 values（mask 开启但 getter 无值 → 保留 mask + 观测告警）；restore 执行时读槽位——不拷贝值、不依赖提交时值已存在（快速 join→立即 leave 时 capture 尚未执行，restore 执行时 FIFO 保证 capture 已完成）；
- restore 按 mask 逐维恢复：mask.model → 恢复 values.model（undefined = 无模型环境 → no-op）；mask.thinking → model 达标后恢复 values.thinking（undefined → no-op + 观测告警）；mask 未开启维度不触碰（不额外回滚中途手动值）；
- **槽位回收**：不绑定同步状态迁移——leave 不等待 restore，进入 idle 时槽位不得删除（排队 restore 仍需读槽）；回收时机 = 该 epoch 的 restore 完成/该 epoch 无待执行任务后；再次 join 新 epoch 重拍（连续加入/离开不覆盖旧轮、不用旧轮基线）；
- **freeze 与快照**：detach 时队列 freeze（当前 in-flight 完成后不再取 pending）；snapshot = pending 纯任务（不含在途）+ lastModel + lastThinking + 槽位表 + 至多一个 inFlight（单飞保证）。

## 8. reload 交接（freeze + 单 in-flight barrier）

reload 是独立于 claim/leave 的第三条状态通路（takeReloadHandoff 绕过 claim 直接进入 Character）。基线/记录是扩展 runtime 内存态，reload 后新 runtime 队列为空——若不在 handoff 中携带，leave 时 restore 无目标，构成静默破坏。修正（与现有机制同构、零新持久化）：

- **任务纯数据化**：handoff 携带 pending 纯任务 + lastModel + lastThinking + 槽位表 + 至多一个 inFlight{task, completionPromise, phase, remaining}，与 pendingEvents 交接同构；
- **detach freeze**：交接前 freeze 旧队列——in-flight 完成后不再取 pending；旧调用不可重放（超时不取消旧 in-flight setModel，其副作用可能晚于 handoff 写入）；
- **in-flight barrier（含分阶段恢复）**：takeHandoff 立即恢复 Character 主流程（不阻塞），但新队列停在 barrier 后：await inFlight.completion settle → 经 getter 读实际 model/thinking 校正记录 → **执行 inFlight 的 remaining 部分**（单飞保证 in-flight 至多一个：setModel 在途时 thinking 未执行，remaining = {thinking?}；新队列 barrier 后若 model 达标 → setThinking(remaining.thinking) 恰一次，未达标 → 跳过 + warning；旧队列 freeze 后不再执行 task 剩余部分）→ 继续执行 pending。snapshot.inFlight 携带 {task, completion, phase, remaining}。**校正规则（统一，不仅 barrier）**：回执不可靠——setModel 先改运行时 model/session/settings 再 await emit，后置 listener 抛错时 promise rejected 但副作用已发生；故任何任务完成后（无论 fulfilled/rejected），getter 可用则以实际值为准，否则保留记录并提示观测失败；rejected 照常 warning；
- **超时与失败**：barrierTimeoutMs 默认 500ms（可注入），超时只发 warning、不得越障；永不 settle = hook 失败提示，不制造第二个并发写——model hook 可停滞，join/leave/reload 主流程不阻塞；
- takeHandoff 不重跑已执行任务——已执行的 switch 不随 handoff 携带；模型「已持久化在位」由 setModel 写 settings 副作保证（reload 后 pi session 从 settings/session 恢复）。

## 9. 副作用契约（setModel 写 settings 默认值）

pi `setModel` 内部会 `setDefaultModelAndProvider` 把新模型持久化为用户默认值；`setThinkingLevel` 仅实际变化时写 settings。两面性：

- **代价**：强杀时恢复不执行，默认 model 残留为角色模型（已知限制；headless 角色 agentDir 隔离影响小，TUI 用户日常 agentDir 影响真实）；
- **收益**：reload 后 pi session 从 settings/session 恢复模型，角色模型天然保持——reload 无需重跑 switch（§8 依赖此行为）；
- 正常 leave 恢复（再次 setModel 写回）后 settings 默认值回到原值——验收双断言（进程态 + 持久层）；thinking 的 settings 仅实际变化时写，断言锚定 get_state.thinkingLevel 生效值，settings 只断「leave 后回基线」方向。

## 10. 执行器契约（pi 集成侧）

执行器在 adapter 层装配（组合根注入队列），错误处理归一为「成败回调 + warning」，队列不感知 pi 异常形态：

1. `modelRegistry.find(provider, id)` 解析失败/不可用 → 失败；
2. `hasConfiguredAuth` 预检不过 → 失败（setModel 返回 false 层）；
3. setModel 调用后 try/catch 全包 + 返回值判断（内部二次 checkAuth 可能 throw）→ 失败；
4. setThinkingLevel 同步 void、仅 throw 层——try/catch + warning（含目标值 + 动作），不回滚 model。

分层分工：角色卡 `model`/`thinking` 字段解析失败在 runtime 层检测并统一流入失败路径（「未提交 switch + 队列无任务」行为面断言归 runtime 层）；提示（notify）由 adapter 层发出（notify 面断言归 adapter 层）——提示逻辑不落 runtime 层，避免断言错位。

提示通道：执行器只依赖**单一 notify 回调注入**（一条 warning 语义，不做双发）；入口适配归装配方——命令加入装配 `ctx.ui.notify`、headless auto-join 装配 stderr 回调。warning 消息含目标 provider/id（或 thinking 值）与失败动作。未装配模式 no-op 兜底；断言：unit 断言统一回调，acceptance 按入口分载体断言（`extension_ui_request` + `method==="notify"` 先例 / stderr）。

## 11. 层级落点与依赖方向

| 组件 | 层 | 落点 | 说明 |
| --- | --- | --- | --- |
| model-transition-queue | runtime 域 | `src/character/` | 纯逻辑；执行器以回调注入（setModel + setThinking），不 import pi SDK |
| 基线持有 + 挂点（claim / leave / handleConnectionClosed / takeReloadHandoff / detachForReload） | application | `src/controller/` | 状态权威点触发，与状态迁移同步 |
| setModel/setThinking 执行器 + 装配 | adapter | `src/extension/` + `src/index.ts` 组合根 | 错误归一 + 单一 notify 回调 |
| handoff 基线字段 | application/controller 域 | `src/controller/reload-handoff-registry.ts`（`CharacterReloadHandoff`）携带队列快照（pending + lastModel + lastThinking + 槽位表 + 至多一个 inFlight{task, completionPromise}），`CharacterRuntime.takeHandoff` 重建 | 与 pendingEvents 交接同构 |
| 角色卡 model/thinking 字段解析 | shared | `src/config/character-card.ts` | 可选字段独立三态；非法格式不导致加载失败 |

依赖方向：adapter → application → runtime → shared，无上行；队列与执行器解耦（窄接口回调注入），无循环依赖。wire schema（protocol/）与 persistence 零改动。

## 12. 验证锚点分层

- acceptance（真实 RPC，`get_state`（model/thinkingLevel）/`set_model`/`get_available_models` 原语可断言）：核心序列 A→B→leave/join C→leave（model+thinking 双断言）；reload 后离开回基线；不可用模型 false 层；手动换模型恢复基线；settings 双断言；无字段回归；强杀只验收敛不验恢复。thinking 断言锚 get_state.thinkingLevel 生效值（非配置原值），settings 只断离开最终基线；clamp 超能力场景下沉 unit/integration。
- integration（可控时序/注入）：WS 瞬断重连（handleConnectionClosed 注入）；队列竞态全场景（switch 在途 leave、epoch 过期、幂等短路、capture 屏障、thinking 随 model 达标后设置、restore mask）。
- unit（mock）：throw 层注入、notify no-op 兜底、队列规则全枚举、parseModelField/parseThinkingField 三态、clamp 语义（生效值锚定）。
