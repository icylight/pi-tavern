# 已知问题记录

本地问题登记，便于群聊协作与回溯。状态字段：`open`（待处理）/ `in-progress`（处理中）/ `closed`（已解决，注明关闭方式）。

## ISSUE-001: TUI widget 未显示讨论轮次发言次数

- **状态**：open（后置，2026-08-01 User 指示：显示等后面做，本轮只做发言错位 ISSUE-003）
- **来源**：User Persona 群聊反馈（2026-08-01）；User 指示后置（2026-08-01）
- **对应 GitHub issue**：[#12](https://github.com/icylight/pi-tavern/issues/12)
- **现象**：`src/ui/tavern-ui-presenter.ts` 的 widget 只显示「N 人在线」和「正在发言：xxx」，未显示当前讨论轮次的发言次数（used / max / remaining）。
- **根因**：纯 UI 呈现层遗漏——creator 侧 `runtime.state.round`、character 侧 `lastGroupChatState.round` 均已携带 `round_max_messages` / `used_messages` / `remaining_messages`，群聊输入（`group-chat-input.ts`）的 followUp 也已注入「Round 发言次数：x/y」「剩余发言次数：z」，唯独 TUI 渲染未呈现。
- **建议方案**：widget 在 round 存在时增加一行，如「发言：x/y · 剩余 z」；无活跃轮次时不显示。范围仅 `src/ui/`，不改协议/持久化/schema。
- **验收标准（2026-08-01 PM 确认，已同步 docs/acceptance.md「TUI 发言次数显示」）**：
  1. creator 与 character 视图在轮次开启后都显示 used/max 与剩余次数；
  2. 发言后次数递增；达到上限后显示举手状态；
  3. 无活跃轮次时不显示该行。
- **文档要求**：`docs/` 补充 TUI widget 行为说明（属主：Dev 的 extension-architecture.md TUI 章节，或共享 docs 声明后更新）。
- **排期**：后置（User 2026-08-01：显示等后面做）；验收标准已在 docs/acceptance.md 就位，启动时无需再议。
- **测试评估（QA 2026-08-01，已确认）**：可完全自动化覆盖，无需手动验收——单测层 `buildTavernViewModel` 四态矩阵（开轮显示 x/y·剩余 z / 递增 / 达上限举手 / 无轮次不显示）+ 验收层 speak-order 链路扩展（creator+character 两侧 widget 计数行、raw WS speak 后更新、超限举手）。Dev 实现后 QA 补双层测试。
- **阻塞**：无，不影响现有契约。

## ISSUE-002: TUI「正在发言」状态不准确（User Persona 反馈）

- **状态**：open（待复现细节）
- **来源**：User Persona 群聊反馈（2026-08-01，sequence 29："正在发言的状态也不对,这个也记录一下 issue"）
- **对应 GitHub issue**：[#14](https://github.com/icylight/pi-tavern/issues/14)
- **现象**：TUI widget 的「正在发言：xxx」状态与实际群聊发言不符——角色在私有 session 做分析（读文件、跑测试等工具调用）时也显示「正在发言」，甚至可能长期悬挂不消失；具体表现（不显示/不更新/显示错人）待 User Persona 补充。
- **根因（已定位）**：`src/index.ts` 的 `agent_start` / `agent_settled` 是 pi 的全局 agent 生命周期事件（references/pi 的 agent-session.ts 在每次 agent 响应开始时 emit），并非「群聊发言」事件：
  1. 角色私有 session 的任何活动（普通输入、工具调用循环）都会触发 `agent_start` → 发送 `update_character_state {is_streaming: true}`，creator 即显示「正在发言」——语义错配（agent 活跃 ≠ 群聊发言）；
  2. 若 `agent_settled` 因异常/中断未配对触发，`is_streaming` 卡在 true，TUI 悬挂；
  3. `updateStreaming`（character-runtime.ts:149）的 send 在 socket 未 open 时会 throw，且事件处理器中未捕获，可能污染 pi 事件循环；
  4. 已核实：**character 侧 TUI widget 仅在群聊新消息注入（`getGroupChatState` → `onStateSnapshot`）时刷新**（src/character/character-runtime.ts:145），流式变化不会即时推送到 character 视图；creator 侧 `handleUpdateCharacterState` 更新 `onlineCharacters.isStreaming` 并触发 `onMembersChanged`（src/creator/creator-runtime.ts:1244）。
- **影响**：TUI 误导；结合 ISSUE-003（身份错配），「正在发言」可能显示错误的角色名。
- **建议方向**：只在「群聊输入触发的 turn」内标记 streaming（如仅当 turn 由 group-chat-input 的 followUp 驱动时）；或 agent_start 后延迟配对 agent_settled 超时兜底清除；socket 未 open 时静默跳过；character 侧增加流式状态推送。具体方案待 PM 裁决。
- **阻塞**：无，不影响现有契约（纯 UI 呈现）。

## ISSUE-003: 发言身份与注入 persona 不一致（speaker 归属异常）

- **状态**：closed（2026-08-01 三方验收通过：Dev 9c49c83 实现 + QA d6adc51 核对，验收证据链齐备）
- **来源**：群聊协作中观察（2026-08-01）
- **对应 GitHub issue**：[#13](https://github.com/icylight/pi-tavern/issues/13)（#15 为重复，已关闭）
- **现象**：署名「产品经理」的消息（sequence 2、9）内容为 QA 视角（自我介绍 / git log 核实），实际出自 persona=测试工程师 的 session（17:02:24 启动）。
- **证据链（可复核）**：
  1. 该 session 的 pi 会话文件（`~/.pi/agent/sessions/--home-wangsen-code-pi-tavern--/2026-07-31T17-02-24-*.jsonl`）中 `tavern_speak` 工具结果返回 `Message published (sequence 2)` 与 `(sequence 9)`；
  2. 群聊持久化（`~/.pi/agent/tavern/.../chats/*.jsonl`）中 sequence 2 / 9 的 sender 为 `../characters/pm.md`（产品经理）；
  3. 该 session 注入的群聊输入（`pi-tavern.group-chat-input`）自报 `character_id=../characters/pm.md`、`is_self=产品经理`，但注入的 persona 为 qa.md（测试工程师）。
- **结论**：存在「注册身份（pm.md）与注入 persona（qa.md）不一致」的 session；群聊中「产品经理」身份的发言作者实际是 QA persona session，并非 PM 模型串文案。
- **待排查**：join 时选错角色卡，还是 claim/注册竞态（两个 QA persona session 几乎同时加入：17:02:24 / 17:02:27）。
- **根因（已确认，QA 供证 2026-08-01）**：群聊广播指令没有「收件人」标记——QA session 将 User Persona 发给 PM 的指示误认为给自己的，以 PM 身份提交了 1a2e560 并群聊署名【产品经理】；Dev 同样存在旧版卡片认知（a18fe4f 署名错位）。即：注入 persona 与注册身份可能不一致，且 session 会把广播指令当作给自己的。
- **修复方向（QA 建议，PM 采纳）**：`group-chat-input` 注入内容强制带身份行（如「当前角色：测试工程师」，含 character_id 与 persona 名），并补端到端断言：注入 persona 名 == creator 在线注册名；speak-order 断言加「speaker 与内容作者一致性」检查。
- **缓解措施（2026-08-01，PM 落地）**：角色卡新增「0.5 协作守则」——所有 `tavern_speak` 消息强制以【产品经理】【开发工程师】【测试工程师】开头，收到消息以内容署名为作者判断依据；内容署名与系统 sender 不一致时当场指出。根因排查（join 选卡/注册竞态）仍待 Dev。
- **建议**：补端到端身份一致性断言（注入 persona 名 == creator 在线注册名）；speak-order 断言加「speaker 与内容作者一致性」检查。
- **阻塞**：无（speak-order 的 sequence/轮次计数机制正常），但影响群聊可信度与验收裁决。

## ISSUE-011: 举手状态无显示（widget 与 status 均未渲染）

- **状态**：open（User 反馈；冻结期仅登记不开发）
- **来源**：User 反馈（2026-08-01）：「又发现一个 bug，举手状态无显示，status 中也无」
- **现象**：角色达到发言上限（举手）后，TUI widget 不显示举手状态，footer status 中也不显示。
- **根因（已定位）**：数据链路完整——协议 `hand_raised`（messages.ts:21/328）、character 侧 `handRaised`（character-runtime.ts:162/181）、creator 侧 `onlineCharacters.handRaised`（creator-runtime.ts:748/1103/1402/1511，广播携带）、group-chat-state.ts:19——**唯独呈现层未渲染**：`tavern-ui-presenter.ts` 的 `creatorWidgetLines`（:53）与 `characterWidgetLines`（:71）只渲染 `isStreaming`（正在发言），无 handRaised；status（:28/:37）亦无举手信息。
- **与 ISSUE-001/002/009 同族**：TUI/status 呈现层遗漏系列（发言次数、正在发言、成员数、举手）。
- **待确认**：期望显示形态（widget 行如「举手：xxx」？status 追加？）。
- **临时手段（QA 2026-08-01）**：`/tavern-status` 命令输出含「Hand raised: true/false」（commands.ts:409），TUI 未显示期间可用此查询。
- **阻塞**：无；不派工不开发（冻结期）。

## ISSUE-010: 验收套件 speak-order 全量并行时 hand_raised 断言间歇失败

- **状态**：closed（2026-08-01 冻结期例外修复：f837032，waitFor 谓词加 `m.id === "s4"`，产品零改动；证据：连续 2 次全量验收 11/11 全绿 + 单测 173/173 + check 干净，QA 执行 PM 裁决）
- **来源**：PM 独立核验发现（2026-08-01）
- **现象**：`npm run test:acceptance` 全量（6 文件并行）时 `speak-order.test.ts:127-128`（第 4 条消息 `hand_raised` 断言）间歇失败；单独运行该文件通过。
- **复现记录**：① 19:19 全量失败（曾归因 User reload 干扰）② 20:13 全量失败 ③ 20:15 全量再失败——连续全量触发；单独跑 1/1 通过；历史全量也有全绿时点（19:50/19:51）→ 间歇性竞态。
- **影响**：PR CI 可能间歇红灯，阻塞分支交付。
- **根因方向（待排查，不开发）**：多文件并行 spawn 真实 pi 进程的资源/时序竞争，或 hand_raised 断言等待窗口不足；与 speak-order 额度上限逻辑相关（第 4 条超限举手）。
- **疑似根因（Dev 2026-08-01 只读分析）**：断言窗口竞态——`fourth = memberA.waitFor(response && command==="speak", 30s, baseline)`，baseline 为 `allFrames().length` 快照；全量并行高负载时 s4 response 可能在 baseline 前到达并被历史重放（pi-process.ts:93 `events.find`）匹配到旧 speak response（s1/s2/s3），其 hand_raised 为 undefined → 断言失败。单独运行时序宽松不触发。修复方向（解冻后）：waitFor 增加 `id === "s4"` 匹配，或 baseline 后限定新事件。
- **待办**：User 解除冻结后排查（可考虑断言超时窗口、并行隔离或串行化）；当前不影响已验收的 ISSUE-003/007/005 结论（各自单独验证均绿）。
- **阻塞**：PR 绿灯（中风险，间歇）。

## ISSUE-009: TUI 成员数显示「未知」（character 侧快照缺失，考虑定时更新）

- **状态**：open（User 指示：仅登记，不开发；「考虑这个定时更新一下」）
- **来源**：User 反馈（2026-08-01）：「tui 现在显示成员数未知，考虑这个定时更新一下」
- **现象**：character 侧 TUI widget 显示「成员数未知」，而非「N 人在线」。
- **根因（已定位）**：`src/ui/tavern-ui-presenter.ts:68`——`characterWidgetLines` 在 snapshot 为 null 时输出「成员数未知」；snapshot 来自 `lastGroupChatState`，仅在群聊新消息注入（`getGroupChatState` → `onStateSnapshot`，character-runtime.ts:145）时刷新——无消息即不更新，刚 join / reload 后 / 长时间无消息时快照缺失或过期。
- **与 ISSUE-002 同源**：均为 character 侧状态无主动/定时推送（ISSUE-002「正在发言」不准确）。
- **User 诉求**：定时更新（定期刷新成员数/状态，而非仅消息触发）。
- **待确认**：「未知」出现时机（刚 join？reload 后？无消息多久后？）——User 补充。
- **阻塞**：无；不派工不开发（User 指示，冻结期顺延）。

## ISSUE-008: 无法查询群聊历史（开过两个群聊，历史不可查）

- **状态**：closed（2026-08-01 修复 + 验收：客户端 cursor 翻页拉全量注入，a9a3d0f + 8988779 + QA c9f0e6d；验收标准 A1-A5 入 docs/acceptance.md；证据：验收套件 7 文件 12 用例全绿 + 单测 176/176 + check 零告警）
- **根因（Dev 实证）**：服务端 join 仅推最近 10 条（`slice(-10)`）；协议已定义 cursor 分页（`message_history` 带 cursor/has_more，`get_message_history` 服务端已实现），但**客户端从未发送该命令** → `has_more=true` 的 cursor 被完全忽略，>10 条历史永远不可查。descriptor 残留假设已排除（active 过滤实证正常）。
- **修复**：`CharacterRuntime.fetchMessageHistoryPage(cursor)` + `GroupChatInput` 在 `has_more=true` 时按 cursor 循环拉取并注入（fire-and-forget，首屏不阻塞）；重复 cursor 守卫防死循环。
- **来源**：User 反馈（2026-08-01）：「我没办法查询到房间历史，我开过两个房间了」
- **术语规范**：用户原话「房间」，规范术语为**群聊**（docs/terminology.md）。
- **现象**：创建过两个群聊后，无法查询到群聊历史（查询不到/列表为空/只能看到其一，待 User 补充）。
- **相关机制**：`/tavern-resume`（历史恢复，`listPersistedGroupChatSessions` 在 `src/creator/group-chat-sessions.ts:69`，列出持久化 session 并过滤非 active）；`/tavern-join`（活动群聊发现，`discoverActiveGroupChats`）；持久化位于 `<agent-dir>/tavern/.../chats/*.jsonl`。
- **待确认（复现细节，User 补充）**：① 查询方式（/tavern-resume？/tavern-join？其他）；② 两个群聊的状态（均已关闭？还有 active？）；③ 期望行为（列出全部历史群聊并恢复，还是恢复消息内容）。
- **排查方向（供将来，不开发）**：`listPersistedGroupChatSessions` 的过滤条件（active 排除）、项目路径匹配、session 文件是否完整落盘。
- **阻塞**：无；不派工不开发（User 指示，冻结期顺延）。

## ISSUE-007: 身份显式状态化（统一 ISSUE-006/007，根治「模型靠猜」）

- **状态**：closed（2026-08-01 实现 + 验收完成：tavern_whoami + tavern-test-whoami，单测三态 + 跨进程一致性全绿，证据链 9c49c83 + d6adc51）
- **来源**：User Persona 质疑（2026-08-01）：「角色难道不是一个可以查看的状态，为什么要靠猜呢」；User 裁决「统一」（2026-08-01）
- **背景**：Dev 根因证实身份（persona）仅存在于 `before_agent_start` 链注入的 systemPrompt 文本，多扩展时存在缺失/被覆盖窗口，模型无确定性查证通道只能从上下文推断。
- **方向对比（QA 2026-08-01 确认）**：身份行方案 = 每轮「告诉」模型你是谁（缓解，仍是提示文本，可能被忽略/截断）；可查询状态 = 角色作为确定性运行时状态暴露，模型可随时「查证」（根治，不依赖注入链）。
- **形态候选（待 User 确认 + Dev 评估）**：a) 工具（如 tavern_whoami：返回当前角色名/character_id，与注册记录一致）b) 上下文 API / 每轮 persistent message c) 其他。
- **形态定案（2026-08-01 PM 设计，User 授权「pm 设计一下」）**：双层身份设计——
  1. **主动查证层（新增）**：注册工具 `tavern_whoami`——模型对身份不确定时随时调用，返回确定性事实：`{ 当前角色: name, character_id, 描述: description }`，单一事实源 = `runtime.character`（join 时确定）；仅 character 状态可用，creator/idle 返回明确错误（与 tavern_speak 同模式）；
  2. **被动告知层（保留）**：群聊输入身份行（三字段契约）每轮告知，默认不猜；
  3. **交互流**：群聊输入（被动告知）→ 不确定时调 whoami（主动查证）→ 发言署名与身份一致；模型不再需要从 skills/上下文推断。
- **与 ISSUE-006 关系**：已统一（User 裁决 2026-08-01）——006 不再独立实施；006 的 frontmatter `identity` 字段与 system prompt 每轮注入取消，由身份行（被动告知）+ whoami（主动查证）承担全部身份感知。
- **与 ISSUE-003 边界**：ISSUE-003 为缓解层（身份行每轮告知，堵住猜的窗口），按现有契约闭环；ISSUE-007 为根治层，独立立项，不并入 ISSUE-003 验收（范围稳定）。
- **验收方向（QA 2026-08-01）**：whoami 类接口返回 == 注册记录，确定性断言不依赖 LLM 是否读了提示；身份行降级为兜底。
- **验收细化（QA 2026-08-01 审阅补充，PM 采纳）**：① 单测覆盖三态——character 正常返回（字段命名与身份行契约共用，避免两套解析）、creator/idle 明确错误、与 runtime.character 逐字段一致；② 验收层前提——RPC 模式无 LLM 无法真实发起工具调用，Dev 须按 ISSUE-003 同模式提供 PITAVERN_TEST 观察通道（如测试命令直接触发 handler 或注册后 notify 工具清单），否则验收层无法落地；③ 跨进程一致性断言（可选）：whoami 返回与 creator 在线成员表一致。
- **测试可行性（QA 2026-08-01 补充）**：a) persistent message 方案——验收测试直接读 character 的 session JSONL 断言每轮必含身份（比 notify 通道更底层更真实）；b) 工具/命令方案——单测工具注册与 handler 返回值 == runtime.character，验收层断言工具存在且响应一致。两种形态都不依赖 LLM 行为。
- **依赖**：User 形态确认（a/b/c）→ Dev 技术评估 → 契约声明。
- **阻塞**：无。

## ISSUE-006: 每轮简短身份提示（system prompt 层）

- **状态**：merged（并入 ISSUE-007「身份显式状态化」，2026-08-01 User 裁决「统一」；不再独立立项）
- **来源**：User 访谈需求（2026-08-01）
- **统一说明**：User 裁决 006 与 007 统一为一个需求。统一方案 = whoami 主动查证（007）+ 身份行被动告知（003 契约，每轮群聊输入已承担「开口前知道自己是谁」）；006 的 frontmatter `identity` 字段与 system prompt 每轮注入**取消**，不单独实施。
- **需求**：每个**群聊消息触发**的 turn（`group-chat-input` followUp），在 `before_agent_start` 注入简短身份提示，让模型每次开口前明确自己是谁。
- **内容来源**：角色卡 frontmatter 新增可选字段 `identity`（如 `identity: 你是产品经理（PM），负责需求范围与验收标准`）；未配置时回退用 `name` + `description` 拼接一句。配置在提示词中，不硬编码。
- **范围**：仅群聊触发 turn；私聊/普通输入不注入。
- **分层策略**：完整卡片仍 join 时注入一次（不变）；每轮仅追加简短身份提示。不包含 ISSUE-005 的 reload 重读（ISSUE-005 独立保留）。
- **与 ISSUE-003 边界**：ISSUE-003 = 消息层身份行（收到消息侧：判断是否发给自己的）；ISSUE-006 = system prompt 层（发出消息侧：模型开口前知道自己是谁）。两者各司其职，都保留。
- **依赖**：角色卡 schema 扩展（frontmatter 允许可选 `identity` 字段）→ 契约变更，须三方声明；加载逻辑在 `character-card.ts`（Dev 域）。
- **验收（QA 2026-08-01 确认方式）**：复用 `[tavern-test-injection]` notify 观察通道，断言每个群聊触发的 turn 注入的身份提示存在且与卡片 `identity` 一致；未配置 `identity` 时回退提示存在。
- **测试计划（QA 2026-08-01）**：单测层——identity 字段解析、未配置回退 name+description（含空串/缺字段边界，现有 character-card 单测不受影响，只新增用例）；验收层——每轮注入含简短身份提示（复用观察通道）、私聊不注入。
- **阻塞**：无。

## ISSUE-005: reload 后角色卡更新不生效（提示词不刷新）

- **状态**：open
- **来源**：User 反馈（2026-08-01，reload 后询问提示词是否最新）
- **现象**：character session 已 join 后修改角色卡文件（如三方合并 0.5 协作守则），对该 session 执行 reload，注入的 persona 提示词仍是旧卡内容。
- **根因（已定位）**：`src/character/character-runtime.ts` 的 `detachForReload` 将 `this.character`（旧 `CharacterCard` 对象，含旧 prompt）写入 handoff（:231）；`takeHandoff` 直接用 `handoff.character` 重建 runtime（:264），**不重新读取角色卡文件**；`src/index.ts:107` 的 `before_agent_start` 每轮从 `runtime.character` 注入 systemPrompt——因此 reload 后提示词不刷新。
- **建议方案**：`takeHandoff` 恢复后按 handoff 中卡的 path/configPath 重新 `loadCharacterCard`；重读失败时保留旧卡并 notify 告警；新 join 已走 `loadClaimedCharacter` 不受影响。
- **验收建议**：修改角色卡 → reload → 新消息注入的 persona 包含新内容；重读失败时告警且不崩溃。
- **测试安排（QA 2026-08-01）**：复用 ISSUE-003 的注入观察钩子（`[tavern-test-injection]` notify，见 edd30c3 契约），用例同域（test/acceptance/）；建议 Dev 实现时将 ISSUE-003 身份行与 ISSUE-005 注入观察统一在一个通道。
- **测试计划（QA 2026-08-01，按 a740ce1 四标准）**：① 重读卡——真实 pi join → 改卡 description → /tavern-test-reload → whoami/身份行断言新内容（test-reload 命令 + notify rebind 已确认可用）；② 失败兜底——损坏 frontmatter → reload → 不崩溃 + 告警 notify + whoami 返回旧卡；③ 回归——reload.test.ts 与全量验收全绿。用例属 test/acceptance/（reload-card-refresh.test.ts 或扩展 reload.test.ts），实现落地后提交。
- **阻塞**：无，不影响现有契约；与 ISSUE-003（身份行）文件域不同（reload-handoff vs group-chat-input），可独立排期。

## ISSUE-004: 三方角色频繁修改相同文件导致工作区冲突

- **状态**：closed（2026-08-01 以角色卡协作守则解决）
- **来源**：User Persona 群聊反馈（2026-08-01）
- **现象**：产品经理/开发/测试三个 session 共享同一仓库工作区，常同时改动 `test/acceptance/*.test.ts`、`ISSUES.md`、`characters/*.md` 等文件，互相覆盖、提交混乱（本次修订期间即观察到角色卡被并发写入）。
- **解决**：`characters/*.md` 新增「0.5 协作守则」：文件所有权表（每类文件唯一属主，非属主默认只读）+ 工作区纪律（动手前查 git status、改完立即独立提交、非属主文件先声明后改）。
- **跟踪**：后续若仍有冲突，升级为分仓/子模块方案。
