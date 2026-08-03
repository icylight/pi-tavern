# M6 进程级验收

M6 验证只有真实进程边界才能观察的行为：多个真实 pi 进程发现并加入同一群聊、并发发言顺序与全局额度、退出与异常收敛、reload 保持连接、残留描述清理、平台一致性。

## 自动化验收套件

```bash
# 测试默认不跑（门卫机制）：显式指定目标——只跑改动到的文件
npm run test:acceptance -- headless.test.ts      # 单文件/目录
npm run test:acceptance -- --all                 # acceptance 全量（日常复核）
npm run test:full                                # 三层串行全量（收口验收证据）
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

1. **身份行注入**：`group-chat-input` 注入内容必须包含显式身份行，**最终格式（2026-08-01 三方终裁）**：「你的当前角色：{persona 名}（character_id={characterId}，注册名={name}）」——persona 名与注册名当前同源（均取 `runtime.character.name`），但契约保留显式三字段，验收用例（edd30c3）按此格式解析；使 session 能区分「发给我的」与「广播」；
2. **注册/注入一致**：端到端断言注入 persona 名 == creator 在线注册名；不一致时 join 流程必须失败或明确提示，不得静默错配；
3. **speaker 一致**：speak-order 断言每条消息的 sender 与消息来源 session 的注入 persona 一致（内容作者一致性）；
4. **并发不串**：两个 character 同时 join（现有 ecd7e6a 并发场景）时注册身份互不串扰，群聊中每个注册名只对应一个注入 persona。

验收方式：`npm run test:acceptance -- --all` 全绿 + 上述断言存在且非空（不接受仅靠人工检查）。

### 身份可查询状态（ISSUE-007，2026-08-01 PM 设计）

模型对自身身份必须有确定性查证通道，不依赖提示文本是否被读到：

1. **tavern_whoami 工具**：character 状态下可调用，返回 `{ 当前角色: name, character_id, 描述: description }`，数据源为 `runtime.character`（join 时注册的单一事实源），与 creator 在线成员表注册记录一致；
2. **可用范围**：仅 character 状态可用；creator/idle 状态返回明确错误（与 tavern_speak 同模式），不泄露其他角色信息；
3. **确定性验收**：单测直接调用 handler 断言返回值 == runtime.character（三态：character 正常返回 / creator、idle 明确错误 / 逐字段一致）；验收层经 PITAVERN_TEST 观察通道（同 ISSUE-003 模式：测试命令直接触发 handler 或 notify 工具清单，RPC 模式无 LLM 无法真实调工具）断言工具存在且响应与注册记录一致——不依赖 LLM 是否读了提示；返回字段命名与身份行契约共用（name / character_id），避免两套解析；
4. **被动层保留**：群聊输入身份行（三字段）不变，继续每轮告知（兜底）；
5. **ISSUE-006 统一裁决（User 2026-08-01「统一」）**：006 并入本需求，不独立实施；frontmatter `identity` 字段与 system prompt 每轮注入取消，身份感知由身份行（被动告知）+ whoami（主动查证）统一承担。

### reload 角色卡刷新（ISSUE-005，2026-08-01 派工）

character session 已 join 后修改角色卡文件，reload 后注入内容必须反映新卡：

1. **重读卡**：`takeHandoff` 按 handoff 中卡的 path/configPath 重新 `loadCharacterCard`，reload 后的 turn 注入（身份行/完整 persona）为新卡内容；
2. **失败兜底**：重读失败时保留旧卡继续运行，并经 notify 告警，不崩溃、不断连；
3. **可观察**：改动后经现有观察通道验证（身份行注入 notify / tavern-whoami 返回新 description）；
4. **回归**：现有 reload 行为不变——成员连接、身份、端口保持（reload.test.ts 不破坏）。

验收方式：`npm run test:acceptance -- --all` 全绿 + 新增 reload 身份刷新用例。

### TUI 发言次数显示（ISSUE-001，2026-08-01 User 指示）

TUI widget（`src/ui/tavern-ui-presenter.ts`）在活跃讨论轮次存在时，必须显示当前角色的发言额度使用情况：

1. **轮次开启时**：creator 与 character 视图均显示 `used / max` 与剩余次数（如「发言：2/10 · 剩余 8」），与群聊输入注入的 Round 计数一致；
2. **发言后更新**：每次 `tavern_speak` 成功后计数递增，widget 刷新；达到上限时显示举手状态（不再显示剩余次数，或明确「已举手」）；
3. **无活跃轮次**：不显示该行，widget 保持现有「N 人在线」「正在发言」内容；
4. **不破坏现有内容**：在线人数与「正在发言」行保留，新增行为附加行。

验收方式：`npm run check` 零告警 + 手动验收（真实群聊中开启轮次观察 widget 三态：轮次中/发言后递增/无轮次）。纯 UI 呈现层，不改协议/持久化/schema。

### 群聊历史可查（ISSUE-008，2026-08-01 验收，修复分支 fix/issue-008-group-chat-history）

服务端 join 时仅推送最近 10 条公开消息（`slice(-10)`）；协议已定义 cursor 分页（`message_history` 带 `cursor`/`has_more`，`get_message_history` 服务端已实现），但客户端从未发送该命令 → 历史 >10 条时更早消息不可查。修复：客户端收到 `has_more=true` 时按 cursor 循环拉取剩余历史并注入群聊输入。

1. **A1 循环翻页**：join/恢复收到 `has_more=true` 时按 cursor 循环发送 `get_message_history` 直至 `has_more=false`；重复 cursor 守卫（已见集合，服务端不前进即终止）杜绝无限循环；
2. **A2 全量注入**：所有页 `public_message` 进入群聊输入 `details.events`（与首屏同批），最早消息可检索；
3. **A3 单测**：mock 分页响应（2 页 20 条）→ 断言循环拉取次数与注入消息数（无重复/遗漏）；
4. **A4 验收**：真实流程 12 条消息 → 新 character join → 快照契约恰 10 条 + `has_more=true` + `cursor` 非空 + `total_messages=12`；端到端烟雾（join 后进程稳定、在线数正常）；
5. **A5 边界**：`has_more=false` 不发起分页请求（单测断言零调用）；断连/异常优雅降级（保留已收集历史，重连重新同步）。

实现：`CharacterRuntime.fetchMessageHistoryPage(cursor)` + `GroupChatInput` has_more 循环（fire-and-forget，首屏不阻塞）。验收证据：验收套件 7 文件 12 用例全绿（含 history-paging）、单测 176/176、check 零告警。已知边界：RPC 模式输入不可直接观察，全量注入断言由单测 A3 + 恢复场景兜底。

### 新消息获取推拉混合（ISSUE-012 / GitHub #24，2026-08-01 需求，方案已冻结，分支 feat/new-message-fetch）

需求与冻结方案见 `docs/new-message-fetch.md`。交互由「服务端推送 + 固定 1 秒防抖」改为推送+拉取混合（微信模型）：广播通知化 + 角色主动增量拉取 + 游标本地持久化 + 缺口检测，不打断当前 run。

1. **A1 增量拉取（闲态窗口 / 忙态 settle 触发，契约修订 #64，2026-08-02）**：**闲态**（无 run）收到 `group_chat_update` → 首条标记启动 ≤1s 固定窗口聚合，窗口内 N 条并入（不重置）→ 到期恰好 1 次拉全未读 + 1 次投递（单测 fake timers 精确控时断言）；**忙态**（run 活跃）→ 零中间注入，settle 后立即触发 1 次拉全（N→1，无串行风暴）；窗口仅存于无 run 态，run 开始即取消窗口；
2. **A2 游标持久化**：收消息 → 游标落盘 → 重启角色进程 → 游标保留、增量从游标后开始（reload.test.ts 先例复用）；投递失败游标不动；
3. **A3 不重不漏/顺序一致**：固定序列场景断言拉取内容 = 游标后全部、无重复、严格递增；
4. **A4 缺口天然补齐**：消费点拉全未读（sequence > 游标 全量），控制广播（跳过序号/丢帧模拟）→ 拉取天然补齐，不永久丢失；
5. **A5 run 状态信号（可测性契约，QA 二评降级口径已裁定）**：**单测层（主验证）**：注入 run 状态信号，断言 `isAgentActive` 活跃时拉取完成→排队、`onAgentSettled` → 立即投递（≤5s）；**验收层**：RPC 无真实 run（已知边界）→ 降级为「收到通知后投递发生 + 进程稳定」烟雾；**isAgentActive 无 run 时视为空闲（false）→ 立即投递**（否则 RPC 模式永远排队，Dev 必须明确该语义）；
6. **A6 统一逻辑（可测性契约，QA 二评补充已采纳）**：投递时经 `PITAVERN_TEST=1` testNotify 注入 `latest_sequence` + 投递消息数，验收断言与 TUI 预览同源（同一消息数据）；
7. **A7 边界**：无游标 join 走现有全量分页；单飞行锁防并发竞态；自己的 echo 仍过滤；`message_history`/`get_message_history` 回归不破坏。
8. **A8 游标 Session 隔离（2026-08-02 User 指示）**：同群聊多 Session 游标文件互异（`cursors/<groupId>/<sessionId>.json`）；A 推进游标不影响 B；旧群聊级文件保守回退为起点（只读不写不删）、save 只写新路径；reload 后同 session 游标接续（QA integration 四项：隔离/旧兼容/并发写/重启恢复）。

验收方式：`npm run test:acceptance -- --all` 全绿 + 上述断言存在且非空 + 单测/check 全绿 + 协议与持久化文档无语义分歧。

### 仓库健康度检查（#87，2026-08-03 PM 布置，分支 feat/health-check）

`npm run health` 纯本地手动命令，聚合三项检查：依赖漏洞（npm audit）/ 凭据扫描（gitleaks，承接 #53）/ 卫生自查（自制零依赖脚本，复用 lint-layers.mjs 先例）。不做 CI 集成与 pre-commit 钩子（User 拍板：CI 花钱不做；项目无 .github/workflows）。

1. **H1 一键可跑与退出码**：`npm run health` 无参数可跑；退出码 0 = 全绿、非 0 = 有发现；子检查失败不吞错（输出明确标注失败项）；
2. **H2 输出留痕稳定**：三项检查输出为可断言文本格式（固定前缀 + 汇总行），重复运行输出结构稳定（供对比留痕）；
3. **H3 凭据检出**：人造测试密钥样本（gitleaks 规则可识别格式）→ 检出且退出码非 0；真实仓库扫描复核无真实凭据（Arch 2026-08-02 审查结论）；
4. **H4 卫生检出**：人造样本（未提交改动 / 超大文件）→ 卫生脚本列出检出项。

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

平台一致性要求 macOS 与 Linux 使用相同发现与进程校验逻辑（`docs/discovery.md`）。当前自动化套件在 Linux 上运行；macOS 上的手动验收步骤：

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
