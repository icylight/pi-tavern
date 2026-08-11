# 进程级验收

> 本文档只收录**当前可验证行为**与测试锚，是功能"完成"的判据。已完成需求的详细过程记录（派工/分支/验收批次/发布定型）已随 2026-08-11 文档清理退役，历史见 Git 提交与 CHANGELOG。
>
> 基础验收方式（各条目只列特殊要求）：`npm run test:acceptance -- --all` 全绿 + 断言存在且非空 + 单测/check 全绿 + 协议文档无语义分歧。

## 自动化验收套件

```bash
# 测试默认不跑（门卫机制）：显式指定目标——只跑改动到的文件
npm run test:acceptance -- headless.test.ts # 单文件/目录
npm run test:acceptance -- --all # acceptance 全量（日常复核）
npm run test:full # 三层串行全量（收口验收证据）
```

套件位于 `test/acceptance/`，通过 `vitest.acceptance.config.ts` 独立配置，**不纳入日常默认测试**（真实 pi 进程启动慢，完整跑约 1-2 分钟；门卫机制下所有测试层均须显式指定目标才执行）。

> ⚠️ 真实 pi 进程共享端口与临时目录：acceptance 全量（`npm run test:acceptance -- --all`）**必须与 `npm run check` 串行执行**，不能并行，否则进程互相干扰导致假失败。

所有测试：

| 场景 | 测试 | 覆盖 |
| --- | --- | --- |
| 真实多 pi 发现与加入 | `multi-process.test.ts` | 3 个真实 pi（1 creator + 2 character）经共享 agent dir 发现、加入、离开 |
| 并发发言顺序与额度 | `speak-order.test.ts` | 真实 pi creator + 2 个直连 WebSocket 客户端并发 speak：所有成员收到相同严格递增 sequence；第 4 条超出 round 额度不发布、举手 |
| 退出不污染日常 pi | `isolation.test.ts` | 显式 agent dir 的开发 pi 跑完整流程后：日常 HOME 无 tavern 痕迹、项目目录无修改 |
| 异常终止收敛 | `crash-convergence.test.ts` | kill -9 Character → creator 收敛成员；kill -9 Creator → character 回 idle；残留 descriptor 被后续发现流程清理 |
| reload 保持连接 | `reload.test.ts` | 真实 `/reload`（经测试命令触发 `ctx.reload()`）：成员连接、身份、端口保持，reload 后消息仍可达 |

### 身份一致性（ISSUE-003）

通讯错位根因：群聊广播无收件人标记，session 会把发给别人的指令当成自己的；且存在注入 persona 与注册身份不一致的 session。修复后必须满足：

1. **身份行注入**：`group-chat-input` 注入内容必须包含显式身份行，最终格式：「你的当前角色：{persona 名}（character_id={characterId}，注册名={name}）」——persona 名与注册名当前同源（均取 `runtime.character.name`），但契约保留显式三字段，验收用例（edd30c3）按此格式解析；使 session 能区分「发给我的」与「广播」；
2. **注册/注入一致**：端到端断言注入 persona 名 == creator 在线注册名；不一致时 join 流程必须失败或明确提示，不得静默错配；
3. **speaker 一致**：speak-order 断言每条消息的 sender 与消息来源 session 的注入 persona 一致（内容作者一致性）；
4. **并发不串**：两个 character 同时 join（现有 ecd7e6a 并发场景）时注册身份互不串扰，群聊中每个注册名只对应一个注入 persona。

### 身份可查询状态（ISSUE-007）

模型对自身身份必须有确定性查证通道，不依赖提示文本是否被读到：

1. **tavern_whoami 工具**：character 状态下可调用，返回 `{ 当前角色: name, character_id, 描述: description }`，数据源为 `runtime.character`（join 时注册的单一事实源），与 creator 在线成员表注册记录一致；
2. **可用范围**：仅 character 状态可用；creator/idle 状态返回明确错误（与 tavern_speak 同模式），不泄露其他角色信息；
3. **确定性验收**：单测直接调用 handler 断言返回值 == runtime.character（三态：character 正常返回 / creator、idle 明确错误 / 逐字段一致）；验收层经 PITAVERN_TEST 观察通道（同 ISSUE-003 模式：测试命令直接触发 handler 或 notify 工具清单，RPC 模式无 LLM 无法真实调工具）断言工具存在且响应与注册记录一致；返回字段命名与身份行契约共用（name / character_id），避免两套解析；
4. **被动层保留**：群聊输入身份行（三字段）不变，继续每轮告知（兜底）；
5. **ISSUE-006 统一裁决**：006 并入本需求，不独立实施；frontmatter `identity` 字段与 system prompt 每轮注入取消，身份感知由身份行（被动告知）+ whoami（主动查证）统一承担。

### reload 角色卡刷新（ISSUE-005）

character session 已 join 后修改角色卡文件，reload 后注入内容必须反映新卡：

1. **重读卡**：`takeHandoff` 按 handoff 中卡的 path/configPath 重新 `loadCharacterCard`，reload 后的 turn 注入（身份行/完整 persona）为新卡内容；
2. **失败兜底**：重读失败时保留旧卡继续运行，并经 notify 告警，不崩溃、不断连；
3. **可观察**：改动后经现有观察通道验证（身份行注入 notify / tavern-whoami 返回新 description）；
4. **回归**：现有 reload 行为不变——成员连接、身份、端口保持（reload.test.ts 不破坏）。

### TUI 发言次数显示（ISSUE-001）

TUI widget（`src/ui/tavern-ui-presenter.ts`）在活跃讨论轮次存在时，必须显示当前角色的发言额度使用情况：

1. **轮次开启时**：creator 与 character 视图均显示 `used / max` 与剩余次数（如「发言：2/10 · 剩余 8」），与群聊输入注入的 Round 计数一致；
2. **发言后更新**：每次 `tavern_speak` 成功后计数递增，widget 刷新；达到上限时显示举手状态（不再显示剩余次数，或明确「已举手」）；
3. **无活跃轮次**：不显示该行，widget 保持现有「N 人在线」「正在发言」内容；
4. **不破坏现有内容**：在线人数与「正在发言」行保留，新增行为附加行。

验收方式：`npm run check` 零告警 + 手动验收（真实群聊中开启轮次观察 widget 三态：轮次中/发言后递增/无轮次）。纯 UI 呈现层，不改协议/持久化/schema。

### 新消息获取推拉混合（ISSUE-012 / #24）

交互由「服务端推送 + 固定防抖」模型改为推送+拉取混合（微信模型）：广播通知化 + 角色主动增量拉取 + 游标本地持久化 + 缺口检测，不打断当前 run。（原方案文档已删，git 历史可追溯。）

1. **A1 增量拉取（闲态窗口 / 忙态 settle 触发，契约修订 #64）**：**闲态**（无 run）收到 `group_chat_update` → 首条标记启动 ≤1s 固定窗口聚合，窗口内 N 条并入（不重置）→ 到期恰好 1 次拉全未读 + 1 次投递（单测 fake timers 精确控时断言）；**忙态**（run 活跃）→ 零中间注入，settle 后立即触发 1 次拉全（N→1，无串行风暴）；窗口仅存于无 run 态，run 开始即取消窗口；
2. **A2 游标持久化**：收消息 → 游标落盘 → 重启角色进程 → 游标保留、增量从游标后开始（reload.test.ts 先例复用）；投递失败游标不动；
3. **A3 不重不漏/顺序一致**：固定序列场景断言拉取内容 = 游标后全部、无重复、严格递增；
4. **A4 缺口天然补齐**：消费点拉全未读（sequence > 游标 全量），控制广播（跳过序号/丢帧模拟）→ 拉取天然补齐，不永久丢失；
5. **A5 run 状态信号（可测性契约，按现行忙态语义收敛，见 websocket-protocol.md「公开消息广播与增量拉取」）**：**单测层（主验证）**：注入 run 状态信号——`isAgentActive` 活跃时收到通知 → 零拉取（只置未读标记/排隐藏令牌）；`onAgentSettled` → 立即拉全未读并投递（≤5s）；**验收层**：RPC 无真实 run（已知边界）→ 降级为「收到通知后投递发生 + 进程稳定」烟雾；**isAgentActive 无 run 时视为空闲（false）→ 立即投递**（否则 RPC 模式永远排队）；
6. **A6 统一逻辑（可测性契约）**：投递时经 `PITAVERN_TEST=1` testNotify 注入 `latest_sequence` + 投递消息数，验收断言与 TUI 预览同源（同一消息数据）；
7. **A7 边界**：join 游标预置 = 进入时刻水位（WL7 三分路径：①已有游标直接返回；②新帧 `latest_sequence` 预置 = 进入时刻水位；③旧帧回退查询水位 CAS 写）；仅预置失败时游标保持 null 回退全量分页兜底（残余无游标态唯一来源）；单飞行锁防并发竞态；自己的 echo 仍过滤；`message_history`/`get_message_history` 回归不破坏。
8. **A8 游标 Session 隔离**：同群聊多 Session 游标文件互异（`cursors/<groupId>/<sessionId>.json`）；A 推进游标不影响 B；**旧群聊级共享游标不采用（不读不写不删、物理遗留）**——v1 文件无 Session 身份、可能由其他角色推进，回退采用其值会跳过本 Session 从未看过的消息（User 2026-08-02 裁决：新 Session 无独立游标 = 从完整历史重新拉取，最多重复、绝不跳过）；本 Session 游标文件不存在仅出现于预置失败时（正常 join 先预置并创建 Session 游标，#144 方案 a）——游标保持 null → 完整历史分页兜底（2026-08-02 旧裁决只覆盖「不采用共享游标、失败时最多重复不跳过」，不覆盖 #144 主路径）；save 只写新路径；reload 后同 session 游标接续（integration 钉测：does not adopt the v1 group-chat cursor / 隔离 / 并发写 / 重启恢复）。
9. **A9 steer 安全边界打断**：忙态通知只排一个隐藏空令牌，正文不入 steer、通知到达时不 abort；当前工具批完成、令牌在下一模型调用前消费时才 abort。密集通知 N→1；settled 后一次拉全并 followUp 重开；历史令牌不进模型上下文；成员/流式变化不产生 Agent 输入，白板投递保持。

### 仓库健康度检查（#87）

`npm run health` 纯本地手动命令，聚合三项检查：依赖漏洞（npm audit）/ 凭据扫描（gitleaks）/ 卫生自查（自制零依赖脚本，复用 lint-layers.mjs 先例）。不做 CI 集成与 pre-commit 钩子（决策留痕：CI 花钱不做；项目无 .github/workflows）。

1. **H1 一键可跑与退出码**：`npm run health` 无参数可跑；退出码 0 = 全绿、非 0 = 有发现；子检查失败不吞错（输出明确标注失败项）；
2. **H2 输出留痕稳定**：三项检查输出为可断言文本格式（固定前缀 + 汇总行），重复运行输出结构稳定（供对比留痕）；
3. **H3 凭据检出**：人造测试密钥样本（gitleaks 规则可识别格式）→ 检出且退出码非 0；真实仓库扫描复核无真实凭据（Arch 审查结论）；
4. **H4 卫生检出**：人造样本（未提交改动 / 超大文件）→ 卫生脚本列出检出项。

### TUI 工作状态指示（#90）

根因：5s 显示 watchdog 与「run 活跃即亮」语义冲突——agent_end 布防后毫秒级 continue → agent_start 再亮但不清除定时器，5s 到强制 updateStreaming(false) 误灭灯。修复：① agent_start 时 clearStreamingResetWatchdog（续命）② watchdog 回调加 isAgentActive 守卫（双保险）。

1. **W1 长 run 续命**：agent_end → continue → agent_start 后，注入定时器加速 5s 窗口——run 活跃期间 watchdog 不灭灯（updateStreaming(false) 不被触发）；
2. **W2 真悬挂复位保留**：agent_end 后无 agent_start、无 settle → 5s 后仍灭灯（防悬挂语义回归）；
3. **W3 正常单轮回归**：单轮 run settle 正常到达 → 灯亮至收敛后灭（既有 streaming 测试回归）；
4. **W4 空闲不误亮**：无 run 时灯不亮（初值 false；重连/心跳路径不回归）。

### 消息来源显式化（#97）

公开消息流与群聊输入注入的来源判定显式化，不再依赖隐式文本模式：

1. **S1 协议来源字段**：`public_message` schema 显式 `source` 字段，群聊=group；旧消息无字段默认视为 group（向后兼容）；`additionalProperties:false` 严格校验下未知取值 fail-close；`message_history` 条目与 public_message 同 schema，同字段语义（历史消息同样缺省=group），钉测一并覆盖；
2. **S2 注入显式声明**：群聊输入注入（steer 包装）含显式来源声明（「来源:群聊」），与身份行同批；「PiTavern 群聊环境更新」前缀不再作为唯一判据（显式字段优先）；
3. **S3 私聊无协议标识**：私聊消息无 `source` 字段/无群聊协议标记，角色侧可判定非群聊；私聊不进入公共消息流与持久化（回归 isolation 系）；
4. **S4 判定确定性**：同输入重复解析来源判定一致；群聊判定不依赖隐式文本模式；
5. **S5 处理规则落文档**：角色卡/workflow 私聊处理规则（不广播、需群知时显式发布并注明来源）；terminology.md 收录「私聊」；
6. **S6 文档同步**：websocket-protocol.md 记录 source 字段与默认语义。

> 注：注入变化影响 identity-consistency.test.ts:188 增量断言（welcome/来源声明后 speaker 一致，后端钉测扩展）与 abort-steer 注入解析；客户端集成层仅透传零代码变更。

### 欢迎消息与历史行为（#123）

1. **WL1 ready 后恰收 1 条 system_message**：join/ready 成功后新角色恰好收到 1 条，内容=当前生效欢迎文案（非公共消息、无 sequence 计入轮次）；
2. **WL2 不再自动推送历史**：character_ready 后零 message_history 自动推送（旧 100 条行为取消）；
3. **WL3 主动历史可查**：`get_message_history` / `fetch_messages_since` 仍可用，>10 条可完整分页拉取；
4. **WL4 配置优先级链三档**：welcome_message 项目 `.pi/tavern.json` > 全局 `~/.pi/tavern.json` > 代码默认值；项目覆盖全局、全局覆盖默认、均缺省用默认，三档各验；
5. **WL6 信封一致**：system_message 走 #119 新信封（method/params），与 #97 source 扩展位兼容；websocket-protocol.md 同步。
6. **WL7 ready 响应携带进入时刻水位**：
   - WL7-1：character_ready 成功响应 result 含 `latest_sequence`（整数 ≥0 = 进入时刻水位）；旧帧（result: null）兼容——客户端回退查询预置路径，行为不降级；
   - WL7-2：join 游标预置 = 进入时刻水位——无游标态消除；join 后新消息（>进入时刻）增量不重不漏到达，严格区间 = 预置完成后；进入前历史属 WL8 主动查询域，不自动注入。
7. **WL8 tavern_history 历史主动查询**：
   - WL8-1：工具可用（角色状态）——分页 10 条/页、cursor 续页向更早、返回 has_more/total 元数据供 AI 自主决策；
   - WL8-2：非 character 状态调用被拒绝（TOOL_NOT_JOINED_AS_CHARACTER 语义）；
   - WL8-3：业务场景——新角色入场已有 12 条历史、随后无人发言：历史不自动注入，经 tavern_history 可分页拉取（首页 10 条 + 元数据 has_more/total 供 AI 决策是否续页）。

### 拉取附加上下文窗口（#138）

1. **WL-A 上下文窗口注入**：进入后首拉（无游标）全量历史零改动；消费若干条后（游标=C）增量拉取注入 = 起点退 N 返回集——窗口含**游标自身最近已读**（sequence=C，重复出现属预期）+ 未读全量（>C 升序），无缺失无重复（服务端 `> since` 排他过滤，since'=max(0,C-N)）；
2. **WL-B 游标隔离**：上述拉取后游标存储值不变（断言锚 = loadCursor() 存储值，非注入文本）；再次增量拉取窗口滑移——旧窗口消息移出、新窗口重复注入（跨 run 重复注入 = 预期设计，非缺陷）；
3. **WL-C 历史翻页不叠加**：pageOlderHistory 翻页路径不受窗口影响（窗口仅作用增量拉取 pullIncrement）；
4. **WL-D 默认 0 行为不变**：回调窗口=0（或无注入）时增量拉取只取未读，与现状逐字等价（既有测试零影响）；
5. **WL-E reload 窗口延续**：reload 移交后上下文窗口仍生效（与 join 一致，跨移交依赖显式转移）；reload 无 getter 时兜底窗口 0 行为不变；
6. **WL-F 自身回显不唤醒**：拉取窗口含旧他人消息 + 新增全为自身回显 → 不投递不唤醒 Agent（仅消费水位）——上下文与未读可区分，仅未读区间存在可投递事件时才携带上下文投递。

### createMessageConnection 收尾（#139）

1. **WL-A fail-close 保留**：同 id 错 result（board_query 冒充 speak 等）仍显式 reject ERROR_UNEXPECTED_* + 断链（#137 阻断② 红线）；
2. **WL-B 错误帧断线**：二进制帧 / 非法 JSON / 协议拒帧 → failConnection 断线（不悬挂不静默）；
3. **WL-C reload 不绕过校验**：reload 延续连接（adopt 路径）上错形状响应仍 fail-close；正确响应正常 resolve；
4. **WL-D 发送 id 库语义**：发送路径 id 恒为 number（v9 库数字自增）且逐请求递增；codec 三态强制保留为防御纵深；
5. **WL-E 行为零变化**：三层全量对比——实现前后除新增钉外零失败；10 码 ResponseError 映射、手工超时、-32097→disconnectError 文案均不变。

### 文档生成化（#145）

docs-first 定稿：TypeDoc + 协议定义文件双轨。

1. **D1 docs:api 可生成且含 protocol 层导出**：`npm run docs:api` 0 errors，docs/api/ 产物含 ClientMessageSchema/ServerMessageSchema 等全 Schema 导出（docs/api/ 为生成物不入库，.gitignore）；
2. **D2 协议定义文件为唯一手写处**：src/protocol/schema/*.jsonc（common/client/server/board 4 文件）含全部消息格式定义与注释；程序用 schema 由翻译器（generate-schema）自动生成（src/protocol/generated/，含 "请勿手改" 声明）；改消息格式 = 只改定义文件 + 重新生成；
3. **D3 翻译器等价保真**：生成产物与定义文件等价（等价抽验 20/20 + Arch 两道关卡 + 翻译器单测 14/14 覆盖全部类型构造）；minimum/required/additionalProperties/枚举等约束全保真；
4. **D4 websocket-protocol.md 字段节引用定义文件**：信封/字段形状以 src/protocol/schema/*.jsonc 为权威（链接引用），时序/语义/边界节手写保留；字段节与定义文件抽样无语义分歧；
5. **D5 收口门禁 + 消费链**：`npm run check` = biome --error-on-warnings && tsc && generate-schema --check（只读比较，改定义忘生成即红）全绿 exit 0；**消费链** = 定义文件 JSONC（唯一手写处）→ schema-merge（**生成期**加载合并）→ generated/schema.ts（生成产物）→ **codec 运行时 Compile**（直接消费生成产物，不 import 合并器）；messages.ts = re-export + Static 类型保留（消费面零改动）；旧生成链（docs:check 判空 / docs:schema 脚本 / docs/protocol/schema 产物）已退役。

### resume 展示完整历史（#155）

修复 `/tavern-resume` 仅投影最近 10 条（JOIN_HISTORY_LIMIT）的问题：保留群聊选择/删除/startResume/SessionStore/创建者服务恢复流程，仅调整恢复完成后 TUI 投影。

1. **RH1 完整投影**：>10 条历史群聊经 `/tavern-resume` 恢复后完整投影（移除 JOIN_HISTORY_LIMIT=10 截断）、按 sequence 升序、内容逐条一致（acceptance/resume-history 新增 >10 条场景断言）；
2. **RH2 幂等投影**：同一当前 Session 重复 resume 不产生重复条目（锚点扫描跳过已投影段）；中断后重入只补缺失尾段；
3. **RH3 类型覆盖**：公开消息与创建者可见私信均完整恢复（创建者对历史私信始终见完整正文）；
4. **RH4 流程回归**：群聊选择、删除、活跃群聊排除、启动失败行为不变；不调用 `ctx.switchSession()`、不改 `/tavern-new`、不新增空群聊持久化或恢复意图机制；
5. **RH5 渲染一致**：恢复投影使用统一文案渲染（当前无模板配置时回退内置中文；与 #154 模板契约对齐，私信占位投影规则同 #152）。

### 角色卡/模板编辑命令改为扩展自带 skill（#172）

`/tavern-character-edit`（#153）与 `/tavern-template-edit`（#154）两个 prompt command 已改造为 PiTavern 扩展自带的两个 skill，随包分发，他人 `pi install` 后零配置直接可用（pi package-manager「all enabled by default」，仅显式排除才禁用；已有 pi.extensions manifest 须显式声明 `"skills": ["./skills"]`，不能只靠约定目录自动发现）。

> ⚠️ **裁决反转留痕**：#76（2026-08-03）曾拍板「skill 应在本地（~/.pi/skills/）、不从项目仓库分发」；2026-08-10 User 拍板反转——角色卡/模板编辑 skill 随 pi-tavern 包分发（决策依据存档于 Git 历史）。

1. **SK1 包结构**：包内 `skills/tavern-character-edit/SKILL.md` + `skills/tavern-template-edit/SKILL.md`；命名沿用命令名，与全局 create-character-card / define-persona 不同名（无同名遮蔽）；frontmatter 合法、description 写清触发条件与边界（如「角色卡创建/编辑请用本 skill，测试 Persona 用 define-persona」——描述面触发重叠风险接受）；
2. **SK2 分发声明**：package.json `pi` 清单加 `"skills": ["./skills"]`；npm 发布 files 白名单补 `skills/`（git 钉 hash 安装 clone 即得）；
3. **SK3 命令删除与迁入**：`/tavern-character-edit`、`/tavern-template-edit` 两命令删除（commands.ts 注册块 + messages.ts CMD_DESC/ERROR/PROMPT 文案）；**CHARACTER_EDIT_PROMPT / TEMPLATE_EDIT_PROMPT 访谈指令迁入对应 SKILL.md（转写为 skill 流程指令，非纯删除——迁移去向 = 删除清单的验收等价物）**；tavern-tools.ts:424 引用注释同步改写（客户端易漏点）；
4. **SK4 单源约束**：template skill 不内嵌模板默认值/合法 key/占位符规则——指令引用「先调 tavern_template_defaults 工具获取规则」（工具保留：LLM-only、非 slash command，idle/Character 可用、creator/joining 拒绝——代码门禁保留，可自动化断言）；角色卡 frontmatter 契约引用契约文档而非复制；
5. **SK5 门禁语义降级**：CE2/T6 状态门禁（creator/joining 拒绝）在 skill 方式下无代码强制，靠 skill 指令 prompt 约束；template 侧有工具层兜底（tavern_template_defaults 代码门禁），角色卡侧仅文档自洽 + 人工实测；
6. **SK6 机械锚单测**：两 SKILL.md 存在、frontmatter 合法、「diff 预览/明确确认/取消=零写入」关键条款文本存在性、pi.skills 声明与 files 白名单一致；
7. **SK7 既有锚定面保留**：frontmatter 契约（name/description 必填）、tavern.json 联动（characters 数组追加相对路径）、claim/join 生命周期、模板合并渲染（项目>全局>内置）沿用既有测试面；
8. **SK8 人工实测**：安装后两 skill 可见可触发（/skill: 手动 + description 自动）；skill 内「适用会话状态」声明与实际行为一致。
9. **SK9 联动检查**：tavern-character-edit SKILL.md 收尾含「联动检查清单（写入确认后必做）」段——写入角色卡后检查 workflow.md 文件所有权表/AGENTS.md 上下文清单等是否需同步；无需同步即结束，需要同步则走四步（群聊声明影响面 → 团队收敛 → 属主复核 → PM 落盘），引用契约不复制、skill 不代落盘；机械锚轻断言：character skill 文本含「联动检查」段（触发条件+四步流程），防转写漏掉。

### 可配置群聊消息文案（#154）

`tavern.json` 新增可选 `message_templates` 指向独立 JSON 文案文件，按 key 合并（项目 > 全局 > 内置中文），覆盖公开消息/完整私信/私信占位/秒前/分钟前五类渲染；实时注入、`tavern_history`、创建者 TUI 共用同一模板集。

1. **T1 配置加载与合并**：`message_templates` 可选字段，指向相对该配置文件的独立 JSON 文件；两层配置（项目/全局）按 key 逐项合并，优先级项目 > 全局 > 内置中文，允许部分覆盖；
2. **T2 容错回退**：文件缺失、JSON 无法解析或单项无效时 warning 并逐项回退（回退链内下一档或内置中文），不阻止群聊启动；
3. **T3 五类模板覆盖**：公开消息、完整私信、私信占位、秒前、分钟前五类 key 可配置；实时注入、`tavern_history` 与创建者 TUI 三个消费面渲染结果一致（同一模板集复用 + 渲染参数按消费面传值：实时注入 sender 含 when 段、history/TUI 纯 sender——传值差异不是不一致）；**TUI 统一渲染留痕**：creator-display 移除 `[label]` 前缀、label 统一 "User Persona"（为三消费面统一模板渲染所需）；**默认模板形态**：public_message=`{sender}:\n{content}`（含换行——实时注入面与现状逐字一致；history 面双行化，无测试钉死可接受）、seconds_ago=`{count} 秒前`、minutes_ago=`{count} 分钟前`、whisper 两 key 按 #152 投影规则定义契约；
4. **T4 占位符规则**：模板仅支持简单 `{placeholder}` 替换——公开消息必须保留发送者与正文；完整私信必须保留发送者、接收者与正文；私信占位必须保留发送者、接收者且禁止正文；相对时间必须保留数量；未知、缺失或禁止的占位符均判为无效（单项回退）；
5. **T5 加载生命周期**：creator 在 `/tavern-new`、`/tavern-resume`、`/reload` 加载；Character 在 claim/join/reload 加载；不做文件监听或自动热更新；
6. **T7 tavern_template_defaults**：仅 LLM 可调用的只读工具，无参数，返回完整中文默认值、合法 key（public_message/seconds_ago/minutes_ago/whisper_full/whisper_placeholder）、占位符规则与 JSON 骨架；idle 与 Character 状态可用，creator 与 joining 拒绝；不注册用户 slash command。（#172 起 T6 命令删除、skill 化，T7 保留——template skill 单源引用此工具，见 #172 SK4。）

### Character 间私信（#152）

LLM 工具 `tavern_whisper`：Character 向当前在线其他 Character 发私信，复用群聊消息写入/轮次/游标/投递机制；新持久化类型 `pi-tavern.whisper-message` 同 JSONL、sequence 共用无空洞；三类视角投影；whisper 两模板 key 随本需求引入（#154 契约注释留痕）。

1. **WH1 工具注册与参数**：`tavern_whisper` 注册为 LLM 工具，参数 `{character_id, content}`；非 character 状态调用被拒绝（TOOL_NOT_JOINED_AS_CHARACTER 语义）；
2. **WH2 目标校验**：仅 Character 向当前在线其他 Character 发送；User Persona、自发自收、离线目标均拒绝且不占额度；要求活跃讨论轮次；
3. **WH3 持久化与序列**：`pi-tavern.whisper-message` 独立持久化类型，与 `pi-tavern.public-message` 写同一群聊 JSONL；sequence 共用递增器交错分配无空洞；恢复时按 sequence 合并统一时间序；0.3.x 历史零迁移；
4. **WH4 三类视角投影**：发送者/接收者/创建者见「A 向 B 悄悄说：<正文>」；其他 Character 见「A 向 B 悄悄说了一句话」（无正文）；`tavern_history` 与实时注入按当前 character_id 执行同一投影（不泄露正文）；
5. **WH5 额度与失败**：与公开消息共用连续 sequence、轮次额度、消息大小限制、持久化失败恢复；失败发送不占额度；
6. **WH6 投递与未读**：接收者走现有实时投递与忙态安全边界；其他 Character 不被主动唤醒，但占位事件属其未读序列（供消费，不触发未读先读阻塞；服务端 stale 判定按请求者投影豁免旁观者只见占位的 whisper——#170 本地+服务端双半场）；
7. **WH7 掉线竞态**：在线校验通过后目标掉线不回滚（已持久化成功不回滚）；发送者只获得工具结果，不额外注入自身事件；
8. **WH8 兼容与隐私**：0.3.x 群聊历史可直接恢复；不增加运行时协议版本字段或兼容性校验（仅支持本地同版本实例）；原始 JSONL 明文保存（交互层隐私，无文件系统安全保证）；
9. **WH9 模板联动**：whisper_full/whisper_placeholder 两 key 经 #154 模板机制（复用定稿规则表与校验语义：full 必留 sender/receiver/content、placeholder 禁 content）；完整正文与占位均经模板渲染，三消费面一致；
10. **WH10 在线判定基准**：以 WS 连接活跃为在线判定（ready 完成但连接断开视为离线）。

## 测试门控命令

RPC 模式没有输入通道、也无法调用扩展工具，因此 `PITAVERN_TEST=1`（acceptance 门卫自动设置）时额外注册：

- `/tavern-test-message <text>`：creator 状态下以 User Persona 发布公开消息（创建 Round）；
- `/tavern-test-reload`：调用 `ctx.reload()` 触发真实 pi reload。

生产环境不设置该变量，两个命令不注册。

## 基础设施

- `PiProcess`（`test/acceptance/pi-process.ts`）：spawn 真实 pi（`references/pi/pi-test.sh` + `--mode rpc` + `--no-env`），JSON 命令走 stdin，事件与 `extension_ui_request` 对话框走 stdout，用 `extension_ui_response` 应答。
- 就绪信号是 PiTavern 的 `setStatus("pi-tavern")` UI 请求（RPC 模式不输出 `session_start`）。
- 单候选群聊/角色时扩展自动选中，不弹 select；应答 value 必须用选项完整文本。

## 前置条件

`references/pi` 子模块需要初始化并生成模型数据：

```bash
git submodule update --init references/pi
cd references/pi && npm ci && npm run generate-models --workspace packages/ai
```

## macOS 手动验收

平台一致性要求 macOS 与 Linux 使用相同发现与进程校验逻辑（`docs/architecture/discovery.md`）。当前自动化套件在 Linux 上运行；macOS 上的手动验收步骤：

1. 安装依赖与前置条件（同上）。
2. 打开两个终端，各启动一个开发 pi：
```bash
scripts/pi-dev.sh --mode rpc
```
3. 终端 A：输入 `/tavern-new`，记下输出的群聊地址。
4. 终端 B：输入 `/tavern-join`，选择群聊与 Character，确认加入成功（创建者显示在线人数增加）。
5. 终端 B：`/tavern-leave`；终端 A：`/tavern-leave`。
6. 确认 macOS 上 descriptor 文件路径（`<agent-dir>/tavern/--<project-key>--/active/`）与 Linux 一致，项目键的路径规范化对 macOS 路径同样有效。

如条件允许，将 `npm run test:acceptance -- --all` 原样在 macOS 上运行即为平台一致性自动化验证。
