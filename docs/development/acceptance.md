# M6 进程级验收

M6 验证只有真实进程边界才能观察的行为：多个真实 pi 进程发现并加入同一群聊、并发发言顺序与全局额度、退出与异常收敛、reload 保持连接、残留描述清理、平台一致性。

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

### 身份一致性（ISSUE-003 修复验收）
通讯错位根因：群聊广播无收件人标记，session 会把发给别人的指令当成自己的；且存在注入 persona 与注册身份不一致的 session。修复后必须满足：

1. **身份行注入**：`group-chat-input` 注入内容必须包含显式身份行，**最终格式（三方终裁）**：「你的当前角色：{persona 名}（character_id={characterId}，注册名={name}）」——persona 名与注册名当前同源（均取 `runtime.character.name`），但契约保留显式三字段，验收用例（edd30c3）按此格式解析；使 session 能区分「发给我的」与「广播」；
2. **注册/注入一致**：端到端断言注入 persona 名 == creator 在线注册名；不一致时 join 流程必须失败或明确提示，不得静默错配；
3. **speaker 一致**：speak-order 断言每条消息的 sender 与消息来源 session 的注入 persona 一致（内容作者一致性）；
4. **并发不串**：两个 character 同时 join（现有 ecd7e6a 并发场景）时注册身份互不串扰，群聊中每个注册名只对应一个注入 persona。

验收方式：`npm run test:acceptance -- --all` 全绿 + 上述断言存在且非空（不接受仅靠人工检查）。

### 身份可查询状态（ISSUE-007，PM 设计）

模型对自身身份必须有确定性查证通道，不依赖提示文本是否被读到：

1. **tavern_whoami 工具**：character 状态下可调用，返回 `{ 当前角色: name, character_id, 描述: description }`，数据源为 `runtime.character`（join 时注册的单一事实源），与 creator 在线成员表注册记录一致；
2. **可用范围**：仅 character 状态可用；creator/idle 状态返回明确错误（与 tavern_speak 同模式），不泄露其他角色信息；
3. **确定性验收**：单测直接调用 handler 断言返回值 == runtime.character（三态：character 正常返回 / creator、idle 明确错误 / 逐字段一致）；验收层经 PITAVERN_TEST 观察通道（同 ISSUE-003 模式：测试命令直接触发 handler 或 notify 工具清单，RPC 模式无 LLM 无法真实调工具）断言工具存在且响应与注册记录一致——不依赖 LLM 是否读了提示；返回字段命名与身份行契约共用（name / character_id），避免两套解析；
4. **被动层保留**：群聊输入身份行（三字段）不变，继续每轮告知（兜底）；
5. **ISSUE-006 统一裁决（User「统一」）**：006 并入本需求，不独立实施；frontmatter `identity` 字段与 system prompt 每轮注入取消，身份感知由身份行（被动告知）+ whoami（主动查证）统一承担。

### reload 角色卡刷新（ISSUE-005，派工）

character session 已 join 后修改角色卡文件，reload 后注入内容必须反映新卡：

1. **重读卡**：`takeHandoff` 按 handoff 中卡的 path/configPath 重新 `loadCharacterCard`，reload 后的 turn 注入（身份行/完整 persona）为新卡内容；
2. **失败兜底**：重读失败时保留旧卡继续运行，并经 notify 告警，不崩溃、不断连；
3. **可观察**：改动后经现有观察通道验证（身份行注入 notify / tavern-whoami 返回新 description）；
4. **回归**：现有 reload 行为不变——成员连接、身份、端口保持（reload.test.ts 不破坏）。

验收方式：`npm run test:acceptance -- --all` 全绿 + 新增 reload 身份刷新用例。

### TUI 发言次数显示（ISSUE-001

TUI widget（`src/ui/tavern-ui-presenter.ts`）在活跃讨论轮次存在时，必须显示当前角色的发言额度使用情况：

1. **轮次开启时**：creator 与 character 视图均显示 `used / max` 与剩余次数（如「发言：2/10 · 剩余 8」），与群聊输入注入的 Round 计数一致；
2. **发言后更新**：每次 `tavern_speak` 成功后计数递增，widget 刷新；达到上限时显示举手状态（不再显示剩余次数，或明确「已举手」）；
3. **无活跃轮次**：不显示该行，widget 保持现有「N 人在线」「正在发言」内容；
4. **不破坏现有内容**：在线人数与「正在发言」行保留，新增行为附加行。

验收方式：`npm run check` 零告警 + 手动验收（真实群聊中开启轮次观察 widget 三态：轮次中/发言后递增/无轮次）。纯 UI 呈现层，不改协议/持久化/schema。

### 群聊历史可查（ISSUE-008，验收，修复分支 fix/issue-008-group-chat-history）

服务端 join 时仅推送最近 10 条公开消息（`slice(-10)`）；协议已定义 cursor 分页（`message_history` 带 `cursor`/`has_more`，`get_message_history` 服务端已实现），但客户端从未发送该命令 → 历史 >10 条时更早消息不可查。修复：客户端收到 `has_more=true` 时按 cursor 循环拉取剩余历史并注入群聊输入。

1. **A1 循环翻页**：join/恢复收到 `has_more=true` 时按 cursor 循环发送 `get_message_history` 直至 `has_more=false`；重复 cursor 守卫（已见集合，服务端不前进即终止）杜绝无限循环；
2. **A2 全量注入**：所有页 `public_message` 进入群聊输入 `details.events`（与首屏同批），最早消息可检索；
3. **A3 单测**：mock 分页响应（2 页 20 条）→ 断言循环拉取次数与注入消息数（无重复/遗漏）；
4. **A4 验收**：真实流程 12 条消息 → 新 character join → 快照契约恰 10 条 + `has_more=true` + `cursor` 非空 + `total_messages=12`；端到端烟雾（join 后进程稳定、在线数正常）；
5. **A5 边界**：`has_more=false` 不发起分页请求（单测断言零调用）；断连/异常优雅降级（保留已收集历史，重连重新同步）。

实现：`CharacterRuntime.fetchMessageHistoryPage(cursor)` + `GroupChatInput` has_more 循环（fire-and-forget，首屏不阻塞）。验收证据：验收套件 7 文件 12 用例全绿（含 history-paging）、单测 176/176、check 零告警。已知边界：RPC 模式输入不可直接观察，全量注入断言由单测 A3 + 恢复场景兜底。

### 新消息获取推拉混合（ISSUE-012 / GitHub #24，需求，方案已冻结，分支 feat/new-message-fetch）

需求与冻结方案（原 `docs/archive/new-message-fetch.md`，已随 2026-08-08 清理分支删除，git 历史可追溯）见下。交互由「服务端推送 + 固定 1 秒防抖」改为推送+拉取混合（微信模型）：广播通知化 + 角色主动增量拉取 + 游标本地持久化 + 缺口检测，不打断当前 run。

1. **A1 增量拉取（闲态窗口 / 忙态 settle 触发，契约修订 #64）**：**闲态**（无 run）收到 `group_chat_update` → 首条标记启动 ≤1s 固定窗口聚合，窗口内 N 条并入（不重置）→ 到期恰好 1 次拉全未读 + 1 次投递（单测 fake timers 精确控时断言）；**忙态**（run 活跃）→ 零中间注入，settle 后立即触发 1 次拉全（N→1，无串行风暴）；窗口仅存于无 run 态，run 开始即取消窗口；
2. **A2 游标持久化**：收消息 → 游标落盘 → 重启角色进程 → 游标保留、增量从游标后开始（reload.test.ts 先例复用）；投递失败游标不动；
3. **A3 不重不漏/顺序一致**：固定序列场景断言拉取内容 = 游标后全部、无重复、严格递增；
4. **A4 缺口天然补齐**：消费点拉全未读（sequence > 游标 全量），控制广播（跳过序号/丢帧模拟）→ 拉取天然补齐，不永久丢失；
5. **A5 run 状态信号（可测性契约，QA 二评降级口径已裁定）**：**单测层（主验证）**：注入 run 状态信号，断言 `isAgentActive` 活跃时拉取完成→排队、`onAgentSettled` → 立即投递（≤5s）；**验收层**：RPC 无真实 run（已知边界）→ 降级为「收到通知后投递发生 + 进程稳定」烟雾；**isAgentActive 无 run 时视为空闲（false）→ 立即投递**（否则 RPC 模式永远排队，Dev 必须明确该语义）；
6. **A6 统一逻辑（可测性契约，QA 二评补充已采纳）**：投递时经 `PITAVERN_TEST=1` testNotify 注入 `latest_sequence` + 投递消息数，验收断言与 TUI 预览同源（同一消息数据）；
7. **A7 边界**：无游标 join 走现有全量分页；单飞行锁防并发竞态；自己的 echo 仍过滤；`message_history`/`get_message_history` 回归不破坏。
8. **A8 游标 Session 隔离**：同群聊多 Session 游标文件互异（`cursors/<groupId>/<sessionId>.json`）；A 推进游标不影响 B；旧群聊级文件保守回退为起点（只读不写不删）、save 只写新路径；reload 后同 session 游标接续（QA integration 四项：隔离/旧兼容/并发写/重启恢复）。
9. **A9 steer 安全边界打断（修正）**：忙态通知只排一个隐藏空令牌，正文不入 steer、通知到达时不 abort；当前工具批完成、令牌在下一模型调用前消费时才 abort。密集通知 N→1；settled 后一次拉全并 followUp 重开；历史令牌不进模型上下文；成员/流式变化不产生 Agent 输入，白板投递保持。

验收方式：`npm run test:acceptance -- --all` 全绿 + 上述断言存在且非空 + 单测/check 全绿 + 协议与持久化文档无语义分歧。

### 仓库健康度检查（#87，PM 布置，分支 feat/health-check）

`npm run health` 纯本地手动命令，聚合三项检查：依赖漏洞（npm audit）/ 凭据扫描（gitleaks，承接 #53）/ 卫生自查（自制零依赖脚本，复用 lint-layers.mjs 先例）。不做 CI 集成与 pre-commit 钩子（拍板：CI 花钱不做；项目无 .github/workflows）。

1. **H1 一键可跑与退出码**：`npm run health` 无参数可跑；退出码 0 = 全绿、非 0 = 有发现；子检查失败不吞错（输出明确标注失败项）；
2. **H2 输出留痕稳定**：三项检查输出为可断言文本格式（固定前缀 + 汇总行），重复运行输出结构稳定（供对比留痕）；
3. **H3 凭据检出**：人造测试密钥样本（gitleaks 规则可识别格式）→ 检出且退出码非 0；真实仓库扫描复核无真实凭据（Arch 审查结论）；
4. **H4 卫生检出**：人造样本（未提交改动 / 超大文件）→ 卫生脚本列出检出项。
### TUI 工作状态指示（#90，PM 布置，分支 fix/issue-90-working-indicator）

根因：5s 显示 watchdog 与 #81「run 活跃即亮」语义冲突——agent_end 布防后毫秒级 continue → agent_start 再亮但不清除定时器，5s 到强制 updateStreaming(false) 误灭灯。修复：① agent_start 时 clearStreamingResetWatchdog（续命）② watchdog 回调加 isAgentActive 守卫（双保险）。

1. **W1 长 run 续命**：agent_end → continue → agent_start 后，注入定时器加速 5s 窗口——run 活跃期间 watchdog 不灭灯（updateStreaming(false) 不被触发）；
2. **W2 真悬挂复位保留**：agent_end 后无 agent_start、无 settle → 5s 后仍灭灯（#14 防悬挂语义回归）；
3. **W3 正常单轮回归**：单轮 run settle 正常到达 → 灯亮至收敛后灭（既有 streaming 测试回归）；
4. **W4 空闲不误亮**：无 run 时灯不亮（初值 false；重连/心跳路径不回归）。

### 消息来源显式化（#97，PM 布置，P1 下一主线，验收条目 QA 提供场景文本）

公开消息流与群聊输入注入的来源判定显式化，不再依赖隐式文本模式：

1. **S1 协议来源字段**：`public_message` schema 显式 `source` 字段，群聊=group；旧消息无字段默认视为 group（向后兼容）；`additionalProperties:false` 严格校验下未知取值 fail-close；`message_history` 条目与 public_message 同 schema，同字段语义（历史消息同样缺省=group），钉测一并覆盖；
2. **S2 注入显式声明**：群聊输入注入（steer 包装）含显式来源声明（「来源:群聊」），与身份行同批；「PiTavern 群聊环境更新」前缀不再作为唯一判据（显式字段优先）；
3. **S3 私聊无协议标识**：私聊消息无 `source` 字段/无群聊协议标记，角色侧可判定非群聊；私聊不进入公共消息流与持久化（回归 isolation 系）；
4. **S4 判定确定性**：同输入重复解析来源判定一致；群聊判定不依赖隐式文本模式；
5. **S5 处理规则落文档**：角色卡/workflow 私聊处理规则（不广播、需群知时显式发布并注明来源）；terminology.md 收录「私聊」；
6. **S6 文档同步**：websocket-protocol.md 记录 source 字段与默认语义（契约变更团队已确认后生效）。

验收方式：acceptance 断言存在且非空 + 单测 + check 全绿 + 协议文档无语义分歧。

> 注：注入变化影响 identity-consistency.test.ts:188 增量断言（welcome/来源声明后 speaker 一致，后端钉测扩展）与 abort-steer 注入解析；客户端集成层仅透传零代码变更。协议变更仍须遵守契约零漂移流程（团队确认后落 schema）。

### 欢迎消息与历史行为（#123，PM 布置，P2 后置，验收条目 QA 提供场景文本）

1. **WL1 ready 后恰收 1 条 system_message**：join/ready 成功后新角色恰好收到 1 条，内容=当前生效欢迎文案（非公共消息、无 sequence 计入轮次）；
2. **WL2 不再自动推送历史**：character_ready 后零 message_history 自动推送（旧 100 条行为取消）；
3. **WL3 主动历史可查**：`get_message_history` / `fetch_messages_since` 仍可用，>10 条可完整分页拉取；
4. **WL4 配置优先级链三档**：welcome_message 项目 `.pi/tavern.json` > 全局 `~/.pi/tavern.json` > 代码默认值；项目覆盖全局、全局覆盖默认、均缺省用默认，三档各验；
5. **WL5 resume 投影窗口（已被 #155 修订作废，见 RH1）**：resume 场景历史投影恰 10 条（JOIN_HISTORY_LIMIT 100→10）——#155 起移除截断改完整投影，本条不再作为验收依据；
6. **WL6 信封一致**：system_message 走 #119 新信封（method/params），与 #97 source 扩展位兼容；websocket-protocol.md 同步。
7. **WL7 ready 响应携带进入时刻水位（方案 a，User 拍板）**：
   - WL7-1：character_ready 成功响应 result 含 `latest_sequence`（整数 ≥0 = 进入时刻水位）；旧帧（result: null）兼容——客户端回退查询预置路径，行为不降级；
   - WL7-2：join 游标预置 = 进入时刻水位——无游标态消除；join 后新消息（>进入时刻）增量不重不漏到达，严格区间 = 预置完成后（业务场景：进场即知「聊到第几条」，之后一条不漏）；进入前历史属 WL8 主动查询域，不自动注入。
8. **WL8 tavern_history 历史主动查询（P1-4）**：
   - WL8-1：工具可用（角色状态）——分页 10 条/页、cursor 续页向更早、返回 has_more/total 元数据供 AI 自主决策；
   - WL8-2：非 character 状态调用被拒绝（TOOL_NOT_JOINED_AS_CHARACTER 语义）；
   - WL8-3：业务场景——新角色入场已有 12 条历史、随后无人发言：历史不自动注入，经 tavern_history 可分页拉取（首页 10 条 + 元数据 has_more/total 供 AI 决策是否续页）；连续翻页（携 cursor 向更早）为独立逻辑，不在本条验收范围（2026-08-08 苍蓝星裁决）。

### 拉取附加上下文窗口（#138，PM 布置，2026-08-08 开工，方案 A 零协议变更）

1. **WL-A 上下文窗口注入**：进入后首拉（无游标）全量历史零改动；消费若干条后（游标=C）增量拉取注入 = 起点退 N 返回集——窗口含**游标自身最近已读**（sequence=C，重复出现属预期）+ 未读全量（>C 升序），无缺失无重复（2026-08-08 语义实证：服务端 `> since` 排他过滤，since'=max(0,C-N)）；
2. **WL-B 游标隔离**：上述拉取后游标存储值不变（断言锚 = loadCursor() 存储值，非注入文本）；再次增量拉取窗口滑移——旧窗口消息移出、新窗口重复注入（跨 run 重复注入 = 预期设计，非缺陷）；
3. **WL-C 历史翻页不叠加**：pageOlderHistory 翻页路径不受窗口影响（窗口仅作用增量拉取 pullIncrement）；
4. **WL-D 默认 0 行为不变**：回调窗口=0（或无注入）时增量拉取只取未读，与现状逐字等价（既有测试零影响）；
5. **WL-E reload 窗口延续**：reload 移交后上下文窗口仍生效（与 join 一致，对抗模式⑬：跨移交依赖显式转移）；reload 无 getter 时兜底窗口 0 行为不变；
6. **WL-F 自身回显不唤醒（Copilot P1 修复目标）**：拉取窗口含旧他人消息 + 新增全为自身回显 → 不投递不唤醒 Agent（仅消费水位）——上下文与未读可区分，仅未读区间存在可投递事件时才携带上下文投递。

验收方式：acceptance 断言存在且非空 + 单测 + check 全绿 + 协议文档无语义分歧。

### createMessageConnection 收尾（#139，PM 布置，2026-08-08 开工，方案 B 零协议变更）

1. **WL-A fail-close 保留**：同 id 错 result（board_query 冒充 speak 等）仍显式 reject ERROR_UNEXPECTED_* + 断链（#137 阻断② 红线，对抗模式⑪）；
2. **WL-B 错误帧断线**：二进制帧 / 非法 JSON / 协议拒帧 → failConnection 断线（不悬挂不静默）；
3. **WL-C reload 不绕过校验**：reload 延续连接（adopt 路径）上错形状响应仍 fail-close；正确响应正常 resolve；
4. **WL-D 发送 id 库语义**：发送路径 id 恒为 number（v9 库数字自增）且逐请求递增；codec 三态强制保留为防御纵深；
5. **WL-E 行为零变化**：三层全量对比——实现前后除新增钉外零失败（基线 81fc403 vs 实现后树）；10 码 ResponseError 映射、手工超时、-32097→disconnectError 文案均不变。

验收方式：acceptance 断言存在且非空 + 单测 + check 全绿 + 协议文档无语义分歧。

### 文档生成化（#145，PM 布置，2026-08-08 开工，docs-first 定稿：TypeDoc + 协议定义文件双轨）

1. **D1 docs:api 可生成且含 protocol 层导出**：`npm run docs:api` 0 errors，docs/api/ 产物含 ClientMessageSchema/ServerMessageSchema 等全 Schema 导出（docs/api/ 为生成物不入库，.gitignore）；
2. **D2 协议定义文件为唯一手写处（docs-first，2026-08-08 苍蓝星拍板）**：src/protocol/schema/*.jsonc（common/client/server/board 4 文件）含全部消息格式定义与注释；程序用 schema 由翻译器（generate-schema）自动生成（src/protocol/generated/，含 "请勿手改" 声明）；改消息格式 = 只改定义文件 + 重新生成；
3. **D3 翻译器等价保真**：生成产物与定义文件等价（等价抽验 20/20 + Arch 两道关卡 + 翻译器单测 14/14 覆盖全部类型构造）；minimum/required/additionalProperties/枚举等约束全保真；
4. **D4 websocket-protocol.md 字段节引用定义文件**：信封/字段形状以 src/protocol/schema/*.jsonc 为权威（链接引用），时序/语义/边界节手写保留；字段节与定义文件抽样无语义分歧；
5. **D5 收口门禁 + 消费链**：`npm run check` = biome --error-on-warnings && tsc && generate-schema --check（只读比较，改定义忘生成即红）全绿 exit 0；**消费链** = 定义文件 JSONC（唯一手写处）→ schema-merge（**生成期**加载合并）→ generated/schema.ts（生成产物）→ **codec 运行时 Compile**（直接消费生成产物，不 import 合并器）；messages.ts = re-export + Static 类型保留（消费面零改动）；旧生成链（docs:check 判空 / docs:schema 脚本 / docs/protocol/schema 产物）已退役。

验收方式：acceptance 断言存在且非空 + 单测 + check 全绿 + 协议文档无语义分歧。

### resume 展示完整历史（#155，PM 布置，分支 fix/resume-full-history，2026-08-09 User 拍板先行）

修复 `/tavern-resume` 仅投影最近 10 条（JOIN_HISTORY_LIMIT）的问题：保留群聊选择/删除/startResume/SessionStore/创建者服务恢复流程，仅调整恢复完成后 TUI 投影。RH 条目场景文本由 QA 提供（2026-08-09 群聊确认）。

1. **RH1 完整投影**：>10 条历史群聊经 `/tavern-resume` 恢复后完整投影（移除 JOIN_HISTORY_LIMIT=10 截断）、按 sequence 升序、内容逐条一致（acceptance/resume-history 新增 >10 条场景断言）；
2. **RH2 幂等投影**：同一当前 Session 重复 resume 不产生重复条目（锚点扫描跳过已投影段）；中断后重入只补缺失尾段（既有 A3-1/A4 语义在 >10 条下仍成立）；
3. **RH3 类型覆盖**：公开消息与创建者可见私信均完整恢复（创建者对历史私信始终见完整正文）；
4. **RH4 流程回归**：群聊选择、删除、活跃群聊排除、启动失败行为不变；不调用 `ctx.switchSession()`、不改 `/tavern-new`、不新增空群聊持久化或恢复意图机制；
5. **RH5 渲染一致**：恢复投影使用统一文案渲染（当前无模板配置时回退内置中文；与 #154 模板契约对齐，私信占位投影规则同 #152）。

验收方式：acceptance 断言存在且非空 + 单测（computeResumeProjection 签名保留，窗口参数化单测零改动）+ check 全绿。

### LLM 创建与编辑角色卡（#153，PM 布置，分支 feat/character-card-edit，2026-08-09 User 指示开工）

新增 prompt command `/tavern-character-edit`，由 LLM 访谈用户完成角色卡创建或编辑，不实现固定表单。范围：idle/Character 状态可用、创建位置可自选、写入前展示预览/diff 并取得明确确认；自动化测试只固定 prompt 存在、参数展开和状态门禁，访谈/预览/确认流程手工验收（需求基线 #156 定稿）。

1. **CE1 prompt 注册与参数展开**：`/tavern-character-edit` 注册为 prompt command，可携带自然语言参数，参数正确展开进 prompt（与既有 prompt command 同机制）；
2. **CE2 状态门禁**：idle 与 Character 状态可用；creator 与 joining 状态拒绝（明确错误响应，不泄漏内部状态细节）；
3. **CE3 预览与确认**：创建新卡前展示完整新角色卡及配置变化；编辑已有卡前展示 diff；未取得用户明确确认不得写入（取消 = 零写入，角色卡与配置均不落盘）；
4. **CE4 创建位置选择**：LLM 提问逻辑——项目已有角色卡目录时默认沿用；项目未配置但全局已配置时让用户选择；完全新用户默认当前项目；始终允许选择当前项目、全局或其他路径；
5. **CE5 配置联动**：新角色卡写入后加入相应 `tavern.json`；选择其他路径时同步确认要更新的配置文件。**frontmatter 契约（后端影响面确认）**：角色卡 `name`/`description` 为必填（character-card.ts readRequiredString），LLM 访谈产出必须含两字段，prompt 约束显式要求，否则下次加载报错；配置写入格式 = `tavern.json` characters 数组追加相对配置文件路径，与现有 schema 一致（后端 config 域零改动）；
6. **CE6 生效语义**：Character 修改自己的角色卡不增加特殊重载，沿用现有角色卡加载生命周期，并告知持久配置何时生效（reload/重新加入）；
7. **CE7 测试边界**：自动化覆盖 prompt 存在、参数展开、状态门禁三项（可复用 test/unit/commands.test.ts 范式：registerCommands mock + 四态构造）；访谈/预览/确认全流程手工验收（QA 定稿六场景清单：新建卡预览完整卡+配置变化 → 编辑已有卡 diff → 位置选择四场景（沿用/二选/默认当前/任意路径）→ 明确确认写入 → 取消=零写入（角色卡与配置均不落盘，git status 核验）→ 缺 name/description 字段产出边界（写入前校验或写入后 reload 不报错，实现侧定，后端契约）。

验收方式：acceptance 断言存在且非空 + 单测 + check 全绿 + 手工验收清单（新建/编辑/位置/确认/取消）在 PR 中留痕。

### 可配置群聊消息文案（#154，PM 布置，分支 feat/message-templates，2026-08-09 User 指示开工）

`tavern.json` 新增可选 `message_templates` 指向独立 JSON 文案文件，按 key 合并（项目 > 全局 > 内置中文），第一版只覆盖公开消息/完整私信/私信占位/秒前/分钟前五类渲染；实时注入、`tavern_history`、创建者 TUI 共用同一模板集（需求基线 #156 定稿）。

1. **T1 配置加载与合并**：`message_templates` 可选字段，指向相对该配置文件的独立 JSON 文件；两层配置（项目/全局）按 key 逐项合并，优先级项目 > 全局 > 内置中文，允许部分覆盖；
2. **T2 容错回退**：文件缺失、JSON 无法解析或单项无效时 warning 并逐项回退（回退链内下一档或内置中文），不阻止群聊启动；
3. **T3 五类模板覆盖**：公开消息、完整私信、私信占位、秒前、分钟前五类 key 可配置；实时注入、`tavern_history` 与创建者 TUI 三个消费面渲染结果一致（同一模板集复用 + 渲染参数按消费面传值：实时注入 sender 含 when 段、history/TUI 纯 sender——传值差异不是不一致，QA 断言口径 2026-08-09）；**TUI 统一渲染留痕**：creator-display 移除 `[label]` 前缀、label 统一 "User Persona"（为三消费面统一模板渲染所需，行为变化随 #154 留痕）；**私信两 key 本期不引入（苍蓝星指示：不暴露未实现功能的文案，2026-08-09）**——DEFAULT_TEMPLATES/校验规则/T7 返回均只含本期三类（public_message/seconds_ago/minutes_ago）；#152 实现时随私信一并引入 whisper 两 key 与渲染，复用本期已定稿的占位符规则表与校验语义（whisper_full 必留三占位/whisper_placeholder 禁 content），届时一次契约确认即可（Arch 留痕）；**默认模板形态（Arch 裁决留痕）**：public_message=`{sender}:\n{content}`（含换行——实时注入面与现状逐字一致零变化；history 面双行化，无测试钉死可接受）、seconds_ago=`{count} 秒前`、minutes_ago=`{count} 分钟前`、whisper 两 key 按 #152 投影规则定义契约；
4. **T4 占位符规则**：模板仅支持简单 `{placeholder}` 替换——公开消息必须保留发送者与正文；完整私信必须保留发送者、接收者与正文；私信占位必须保留发送者、接收者且禁止正文；相对时间必须保留数量；未知、缺失或禁止的占位符均判为无效（单项回退）；
5. **T5 加载生命周期**：creator 在 `/tavern-new`、`/tavern-resume`、`/reload` 加载；Character 在 claim/join/reload 加载；不做文件监听或自动热更新；
6. **T6 /tavern-template-edit**：prompt command 支持自然语言参数；默认建议编辑全局配置但必须让用户选择（全局/当前项目/其他配置）；写入前展示 diff 并取得明确确认；写入后告知需 reload/rejoin/resume 后生效；
7. **T7 tavern_template_defaults**：仅 LLM 可调用的只读工具，无参数，返回完整中文默认值、合法 key（本期三类：public_message/seconds_ago/minutes_ago）、占位符规则与 JSON 骨架；idle 与 Character 状态可用，creator 与 joining 拒绝；不注册用户 slash command。

验收方式：acceptance 断言存在且非空 + 单测 + check 全绿；手工验收（diff 确认/生效提示/位置选择）由苍蓝星实测或 QA 真实环境执行（沿用 #153 先例：PR 中留痕实际执行结果）。

### Character 间私信（#152，PM 布置，分支 feat/character-whisper，2026-08-09 User 指示开工）

新增 LLM 工具 `tavern_whisper`：Character 向当前在线其他 Character 发私信，复用群聊消息写入/轮次/游标/投递机制；新持久化类型 `pi-tavern.whisper-message` 同 JSONL、sequence 共用无空洞；三类视角投影；whisper 两模板 key 随本需求重新引入（#154 契约注释留痕）。前置：wire schema 与持久化 docs-first 定义、五方确认后实现（契约零漂移）。

1. **WH1 工具注册与参数**：`tavern_whisper` 注册为 LLM 工具，参数 `{character_id, content}`；非 character 状态调用被拒绝（TOOL_NOT_JOINED_AS_CHARACTER 语义）；
2. **WH2 目标校验**：仅 Character 向当前在线其他 Character 发送；User Persona、自发自收、离线目标均拒绝且不占额度；要求活跃讨论轮次；
3. **WH3 持久化与序列**：`pi-tavern.whisper-message` 独立持久化类型，与 `pi-tavern.public-message` 写同一群聊 JSONL；sequence 共用递增器交错分配无空洞；恢复时按 sequence 合并统一时间序；0.3.x 历史零迁移；
4. **WH4 三类视角投影**：发送者/接收者/创建者见「A 向 B 悄悄说：<正文>」；其他 Character 见「A 向 B 悄悄说了一句话」（无正文）；`tavern_history` 与实时注入按当前 character_id 执行同一投影（不泄露正文）；
5. **WH5 额度与失败**：与公开消息共用连续 sequence、轮次额度、消息大小限制、持久化失败恢复；失败发送不占额度；
6. **WH6 投递与未读**：接收者走现有实时投递与忙态安全边界；其他 Character 不被主动唤醒，但占位事件属其未读序列（复用 #128 未读先读机制），后续发言前必须消费；
7. **WH7 掉线竞态**：在线校验通过后目标掉线不回滚（已持久化成功不回滚）；发送者只获得工具结果，不额外注入自身事件；
8. **WH8 兼容与隐私**：0.3.x 群聊历史可直接恢复；不增加运行时协议版本字段或兼容性校验（代码注释说明仅支持本地同版本实例）；原始 JSONL 明文保存（交互层隐私，无文件系统安全保证）；
9. **WH9 模板联动**：whisper_full/whisper_placeholder 两 key 随本需求重新引入 #154 模板机制（复用定稿规则表与校验语义：full 必留 sender/receiver/content、placeholder 禁 content）；完整正文与占位均经模板渲染，三消费面一致；
10. **WH10 在线判定基准**：以 WS 连接活跃为在线判定（ready 完成但连接断开视为离线，QA 表态 2026-08-09）。

验收方式：acceptance 断言存在且非空 + 单测 + check 全绿；投影不泄露三视角断言 + sequence 无空洞 + 失败不占额度；挂起项补验（#155 RH3 私信投影、#154 T3 私信渲染）。

### 测试门控命令

RPC 模式没有输入通道、也无法调用扩展工具，因此 `PITAVERN_TEST=1`（acceptance 门卫自动设置）时额外注册：

- `/tavern-test-message <text>`：creator 状态下以 User Persona 发布公开消息（创建 Round）；
- `/tavern-test-reload`：调用 `ctx.reload()` 触发真实 pi reload。

生产环境不设置该变量，两个命令不注册。

### 基础设施

- `PiProcess`（`test/acceptance/pi-process.ts`）：spawn 真实 pi（`references/pi/pi-test.sh` + `--mode rpc` + `--no-env`），JSON 命令走 stdin，事件与 `extension_ui_request` 对话框走 stdout，用 `extension_ui_response` 应答。
- 就绪信号是 PiTavern 的 `setStatus("pi-tavern")` UI 请求（RPC 模式不输出 `session_start`）。
- 单候选群聊/角色时扩展自动选中，不弹 select；应答 value 必须用选项完整文本。

### 前置条件

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

## 0.1.0 发布定型（#88，PM 布置，分支 docs/release-0.1.0）

发布前收尾（M0-M7 全完成 + 五层重构 Phase 5 收口 #75；version 0.0.0 → 0.1.0）：

1. **R1 基线合成**：新验收基线文件（原 docs/archive/acceptance-baseline-0.1.0.md，已随 2026-08-08 清理分支删除，git 历史可追溯）存在，含三层全量数据（unit 20/20·209 用例·5.73s + integration 13/13·110 用例·8.37s + acceptance 11/11·19 用例·88.76s，合计 ≈102.9s）+ 演进口径表（34/45/83.6s/102.9s）+ J2 双绿注记；旧 34/45 两份标注废弃（后随 0.3.0 前清理删除，git 历史可追溯）；
2. **R2 版本与 CHANGELOG**：package.json + package-lock.json version=0.1.0（两处同步）；CHANGELOG 0.1.0 节含全部历史条目（[未发布] 汇入）+ 新增 #91/#93/#94/#95 条目；README/README.en 版本引用 0.1.0 一致（安装/项目状态各两处 + health 命令补充）；
3. **R3 归档**：refactor-plan.md 状态行更新为「已完成（Phase 1–5 收口归档）」与 ADR-0005 Accepted 一致；creator-runtime 518 行口径注记（427 → 518 = +92 功能回填 #79/#83，结构未变）；
4. **R4 门禁留痕**：发布前全量门禁 + check 全绿 V0 留痕（命令 | 结果 | hash@层，见 #88 评论区）；
5. **R5 检查单**：README/README.en 与现状核对完成（架构/命令/场景章节一致；差异 = 版本引用已修正 + health 命令补充）。

## 0.2.0 npm 发布（#124，分支 chore/issue-124-npm-publish）

1. **N1 manifest 与版本一致**：`package.json`、`package-lock.json` 根包版本均为 0.2.0；包名 `pi-tavern`；保留 `pi.extensions=["./src/index.ts"]` 与 `pi-package` keyword；repository/homepage/bugs 指向 `icylight/pi-tavern`，registry 固定为公开 npm。
2. **N2 tarball 最小化**：`npm pack --dry-run --ignore-scripts --json` 只包含运行所需的 `src/` 与 README/CHANGELOG/LICENSE；不得包含 `references/`、`test/`、内部 `docs/`、角色卡、开发脚本、Husky 或 AGENTS.md。
3. **N3 发布前门禁**：干净 release commit 上串行执行 `npm run test:full` 与 `npm run check`，按 V0 格式记录 HEAD/tree、`references/pi`、Node、命令和结果；随后 `npm publish --dry-run` 通过。
4. **N4 发布后可用**：`npm view pi-tavern@0.2.0` 的 latest/keywords/pi manifest 正确；`pi -e npm:pi-tavern@0.2.0` 加载无错误；`https://pi.dev/packages/pi-tavern` 可见后方可关闭 #124。

## 0.2.1 文档补丁发布（#135，分支 chore/issue-135-release-0.2.1）

1. **P1 版本一致**：`package.json` 与 `package-lock.json` 根包版本均为 0.2.1；包名、依赖、`pi` manifest、发布白名单与 0.2.0 保持一致。
2. **P2 文档范围**：CHANGELOG 只记录 #133/#134 的双语简介与角色卡首次使用指引；中英文 README 的当前版本均更新为 0.2.1。
3. **P3 发布包**：`npm pack --dry-run` 与 `npm publish --dry-run` 通过，tarball 包含更新后的 README，且不新增白名单外文件。
4. **P4 发布后可用**：PR 合并后由 User 发布；`npm view pi-tavern@0.2.1` 的 latest/keywords/pi manifest 正确，`pi -e npm:pi-tavern@0.2.1` 加载无错误，pi.dev 详情页显示 0.2.1。

## 0.3.0 发布

1. **V1 版本与文案一致**：`package.json` 与 `package-lock.json` 根包版本均为 0.3.0；中英文 README 的安装与项目状态均指向 0.3.0；CHANGELOG 汇总 `v0.2.1..HEAD` 的用户可见变更，并明确 JSON-RPC 2.0 与 0.2.x 不兼容。
2. **V2 发布包完整且最小**：`npm pack --dry-run --ignore-scripts --json` 通过；tarball 包含运行时代码、`src/protocol/schema/*.jsonc`、`src/protocol/generated/schema.ts` 与发布文档，不包含 `references/`、`test/`、内部 `docs/`、角色卡、开发脚本、Husky 或 AGENTS.md。
3. **V3 发布前门禁**：干净 release commit 上串行执行 `npm run test:full`、`npm run check` 与 `npm run lint:layers`，按 V0 格式记录 HEAD/tree、`references/pi`、Node、命令和结果；随后 `npm publish --dry-run` 通过。
4. **V4 发布后可用**：PR 合并后由 User 发布；`npm view pi-tavern@0.3.0` 的 latest/keywords/pi manifest 正确，`pi -e npm:pi-tavern@0.3.0` 加载无错误，pi.dev 详情页显示 0.3.0。
