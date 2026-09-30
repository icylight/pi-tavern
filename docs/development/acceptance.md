# 验收标准

> 只收录**当前可验证行为**与测试锚。已完成需求的详细验收断言与过程记录已压缩（行为细节以测试与 `docs/reference/*` 契约为准，历史见 Git/CHANGELOG/issue）。
>
> 基础验收方式：`npm run test:acceptance -- --all` 全绿 + 断言存在且非空 + 单测/check 全绿 + 协议文档无语义分歧。

## 自动化验收套件

```bash
# 测试默认不跑（门卫机制）：显式指定目标——只跑改动到的文件
npm run test:acceptance -- headless.test.ts # 单文件/目录
npm run test:acceptance -- --all # acceptance 全量（发版前复核；日常不跑）
npm run test:full # 三层串行全量（发版前收口验收证据）
```

套件位于 `test/acceptance/`，通过 `vitest.acceptance.config.ts` 独立配置，**不纳入日常默认测试**（真实 pi 进程启动慢，完整跑约 1-2 分钟；门卫机制下所有测试层均须显式指定目标才执行）。

> ⚠️ 真实 pi 进程共享端口与临时目录：acceptance 全量（`npm run test:acceptance -- --all`）**必须与 `npm run check` 串行执行**，不能并行，否则进程互相干扰导致假失败。跨会话并发运行由运行锁互斥（已有活跃运行 fail-fast，见 #191）；跑前私信报备（错峰）。

所有测试：

| 场景 | 测试 | 覆盖 |
| --- | --- | --- |
| 真实多 pi 发现与加入 | `multi-process.test.ts` | 3 个真实 pi（1 creator + 2 character）经共享 agent dir 发现、加入、离开 |
| 并发发言顺序与额度 | 所有成员收到相同严格递增 sequence；超出 round 额度不发布、举手 | 单测/集成层覆盖（acceptance 无专用锚，原表格锚点名已漂移修正） |
| 退出不污染日常 pi | `isolation.test.ts` | 显式 agent dir 的开发 pi 跑完整流程后：日常 HOME 无 tavern 痕迹、项目目录无修改 |
| 异常终止收敛 | `crash-convergence.test.ts` | kill -9 Character → creator 收敛成员；kill -9 Creator → character 回 idle；残留 descriptor 被后续发现流程清理 |
| reload 保持连接 | `reload.test.ts` | 真实 `/reload`（经测试命令触发 `ctx.reload()`）：成员连接、身份、端口保持，reload 后消息仍可达 |

### 改动面 → 定向 acceptance 反查表

定向跑的依据是**行为面经哪条消费链**，不是 import 关系（渲染末端如 `ui/` 容易漏，而它恰是 resume/welcome 的观测面）。最小集 = 本表并集；拿不准取超集。行内测试文件省略 `.test.ts`。

| src 改动面 | 行为面 | 定向 acceptance |
| --- | --- | --- |
| `src/character/group-chat-input.ts`、`response-gate.ts`、`injection-text.ts` | 输入注入/打断/令牌/游标消费/信封 | abort-steer-visibility、j2-rpc-abort-no-loss、speak-read-first、context-window、live-delivery、identity-consistency、welcome-message、board-whiteboard |
| `src/character/join-attempt.ts` | 发现-加入握手 | multi-process、identity-consistency、headless、welcome-message、crash-convergence |
| `src/creator/**`（连接/成员/广播/心跳/流水线） | 连接收敛/广播/投影 | crash-convergence、multi-process、family-messages、live-delivery、board-whiteboard、rh3-whisper-projection、welcome-message |
| `src/creator/reload-flow.ts`、`src/controller/**` | reload 交接 | reload、resume-history |
| `src/data/discovery/**` | 描述符/发现/进程校验 | multi-process、crash-convergence、headless、welcome-message、isolation |
| `src/data/**`（游标/持久化） | 游标读写/水位/历史投影 | welcome-message、context-window、speak-read-first、resume-history、reload、isolation |
| `src/config/character-card.ts` | 角色身份/人格 | identity-consistency、board-whiteboard、isolation、multi-process |
| `src/config/load-config.ts`、`message-templates.ts` | 轮次上限/渲染文案三消费面 | welcome-message、family-messages、rh3-whisper-projection、board-whiteboard |
| `src/extension/**`（工具/生命周期/状态机） | 工具面/工作状态机 | headless、w1c-light-probe、streaming-truth、identity-consistency、board-whiteboard、speak-read-first、rh3-whisper-projection、welcome-message |
| `src/ui/**` | TUI 渲染 | board-whiteboard、resume-history、welcome-message；三轮态/状态行见手动 |
| `src/headless.ts` | 无人值守入口 | headless、multi-process、welcome-message、identity-consistency |
| `src/character/character-runtime.ts`（游标/前置门/投递/handoff/心跳）、`src/protocol/**`、`src/index.ts` | 角色侧核心 / wire 契约 / 组合根接线 | **全量**（非定向） |
| `test/acceptance/**`（基建） | 验收基建自身 | 改哪个跑哪个；`pi-process`/`global-setup` 类改后加单文件冒烟 |

维护：新增 acceptance 文件 → 回填所属行；剧本化迁移（workflow §0.6）后按剧本名对应。

## 当前行为验收锚

| 行为域 | 现行行为（一句话） | 锚点测试/验证 |
| --- | --- | --- |
| 身份一致性 | 身份行三字段注入、注册=注入一致、speaker 一致、并发不串 | `identity-consistency` |
| tavern_whoami | character 可用返回 `runtime.character` 三字段；creator/idle 明确拒绝；身份行被动告知保留 | whoami 单测（三态） |
| reload 角色卡刷新 | handoff 重读新卡注入；重读失败保旧卡 + notify 告警，不断连 | `reload` |
| TUI 发言次数 | 轮次开启显示 used/max 与剩余；发言后递增；上限显举手；无轮次隐藏该行 | 手动（三轮态） |
| 消息推拉混合 | 广播通知化 + 主动增量拉取 + Session 游标持久化 + 缺口检测；闲态 ≤1s 固定窗口聚合 N→1 不重置、忙态零正文但启动投递窗口（默认 5s，`PITAVERN_DELIVERY_WINDOW_MS` 可注入；窗口与 settle 先到者触发拉取投递，投递延迟上界 = 窗口 + 一个工具间隙）；投递通道统一 steer + triggerTurn（pi 按真实 streaming 分派，不打断 run）；游标 = `cursors/<groupId>/<sessionId>.json`，join 预置 = 进入时刻水位（三分：已有游标返回 / 新帧 latest_sequence 预置 / 旧帧回退查询水位 CAS 写），旧群聊级共享游标不采用（不读不写不删），仅预置失败游标保持 null → 全量分页兜底；同 Session 文件不存在仅现于预置失败 | `live-delivery`、`context-window`、`delivery-window`（#196）、does-not-adopt-v1 钉测、游标单测 |
| 消费水位推进（#201） | 连续性游标只能由**消费确认**推进：批次入队（`sendMessage`）与 whisper 发布均不推进；水位写点收敛为消费确认（pi 注入确认）；`last_sequence` 仍是 pull 起点 / 门闸 / stale basis 的唯一水位——**格式不变、语义变更**（入队乐观水位 → 已消费水位，`persistence.md` 同批声明；旧值不追溯历史洞）。未确认形态（清队丢弃 / 异步失败不可见 / 消费事件缺失）→ 区间保持未读、后续投递机会重拉（重复可接受、跳过不可接受）；自产静默窗（whisper 无回显）不得使水位永久卡死（机制随设计） | `skip-hole.test.ts` integration（R2 清队丢弃 / R7 异步失败不可见 / R5 消费确认对照绿）；A1 acceptance 不变量（场景末注入 seq 集 ∩ 外部消息集 = 群日志外部消息集；窗口剔除 join 预置水位前、自身消息、whisper/board 帧） |
| 仓库健康度 | `npm run health` 聚合 audit/gitleaks/卫生三检查；退出码 0=全绿；输出结构稳定 | 手动（人造样本） |
| TUI 工作状态 | agent_start 续命 watchdog（clearStreamingResetWatchdog + isAgentActive 守卫）；真悬挂 5s 复位保留；空闲不误亮 | `w1c-light-probe`、`streaming-truth` |
| 消息来源显式化 | `public_message.source` 字段（缺省=group）；群聊注入含显式来源声明；终端私聊不进入公共流，Character 间私信走独立 whisper 帧 | `identity-consistency`、`abort-steer-visibility` |
| 欢迎与历史行为 | ready 后恰 1 条 system_message 欢迎语并进入首次环境批次；零自动历史推送；`tavern_history` 分页 10 条/页 + cursor/has_more/total；welcome 三档配置链；ready 响应 `latest_sequence` = 进入时刻水位（旧帧回退查询预置） | `welcome-message` |
| 上下文窗口 | 增量拉取起点退 N 含游标自身已读 + 未读全量；游标存储值不变；历史翻页不受窗口影响；窗口=0 时行为不变；reload 延续；回显不唤醒 | `context-window` |
| WS 连接收尾 | 错 result fail-close 断链；错误帧断线；reload 不绕过校验；id 恒 number 自增 | 相关单测 |
| 文档生成化 | `npm run check` = biome + tsc + generate-schema --check；schema jsonc 唯一手写处、generated 自动生成 | `npm run check` |
| resume 完整历史 | 恢复后完整投影（无 10 条截断）升序；重复 resume 幂等；创建者见私信全文；统一文案渲染 | `resume-history`、`rh3-whisper-projection` |
| 角色卡/模板编辑 skill | 两 SKILL.md 随包分发（pi manifest skills 声明）；命令已删、访谈指令迁入；template 单源引用 `tavern_template_defaults`；写入前 diff/确认/取消零写入；SKILL.md 含联动检查清单 | SK6 机械锚单测 |
| SK6-190：角色卡专属 skill 编辑（#190） | 仅在用户要求时按 `interaction-model.md` 的专属 skill 约定创建或编辑卡末声明：新卡仅一段，旧段原位修改不重复追加；先预览完整新卡或目标卡精确 diff 及配置变化，确认后仅写预览范围，取消零写入。触发条件或 skill 来源未给出时先追问；仓库相对路径已给出但 `SKILL.md` 不可读时提示未验证可用，不承诺可用且不改变角色卡加载/加入行为；机器绝对路径须请用户改为仓库相对路径，不自行猜测转换。同名优先仅是角色提示词指令，不承诺 `<available_skills>` 注册或 `/skill:name` 重定向；未要求专属 skill 的卡保持原行为 | QA 在隔离临时目录实际走新建、编辑（已有段更新、无段非 skill 编辑）与取消对话，并分别构造来源未给出、已给但目标不可读、绝对路径及同名场景；比对完整预览、确认后磁盘 diff 和取消前后文件集；`test/unit/skills-mechanical-anchor.test.ts` 仅证包内结构/安全文案。旧 join/leave/reload 证据仅在当前基线同树、同环境且有 V0 留痕时引用，不作本次编辑流程的通过证据 |
| 角色卡运行时 profile 临时覆盖（#180） | `model`/`thinking` 独立可选：配置层仅检查缺席、非 string 与空串，不校验 model 目录/provider-id 格式或 thinking 枚举/大小写；任意非空字符串原样进入运行时尝试。加入后异步 best-effort 按 model→thinking 应用，model 无法解析/不可用/未达标时跳过 thinking并提示但不阻塞；thinking 以 pi getter 钳制后的实际值为准。正常离开/存活断线按双维 mask 仅恢复基础检查通过的配置维度，允许中途手动修改且不持续纠正；reload 交接 baseline/队列并对在途任务分阶段续接、不重放；缺失字段行为不变，强杀不保证恢复 | `character-model-hook` unit/integration；`character-model-hook.test.ts` acceptance（command/headless、thinking-only、model-only、手动修改、reload、运行时失败/钳制与 settings 三键不变） |
| whisper 目标发现（#183） | `tavern_whisper` 的 `character_id` **值语义扩展**为「精确 id 或注册名」：精确 id 优先 → 注册名唯一命中；多命中拒绝并附候选（注册名（character_id））；命中自己客户端直接拒；未命中附在线成员清单；规范化仅两段（原样 → trim 一次），不做大小写/全角归一，不匹配即报错。新增只读工具 `tavern_members`（在线 only：注册名 / character_id / is_self / is_streaming / hand_raised / description ≤80；注册名在前）。解析不可用（名册获取失败）→ 回退缓存 → 再无则放行原串交服务端（不把客户端故障伪报为「目标不存在」）；解析时在线、投递瞬间掉线 → 服务端 `-32110` 原样透传。错误路径不占额度、不发帧；wire 零改动，「不存在 vs 离线」区分不做（需服务端全卡 → backlog 候选） | `whisper-target` unit（解析三态 / 规范化样本：路径形态 id、含空格名、中文、全角、大小写）；integration（双角色同名歧义 / 离线 / 不占额回归）；acceptance（`/tavern-test-members` + `/tavern-test-whisper` 缝面：按名投递全文 / 精确 id 零回归 / 未命中附在线清单；缝与工具同执行核心，test-only） |
| 文案模板 | 五 key（public/seconds/minutes/whisper_full/whisper_placeholder）按 项目>全局>内置 合并；容错逐项回退；占位符规则校验；三消费面同模板集 | 模板单测 |
| 私信 | `tavern_whisper` 仅在线 Character 间 + 活跃轮次；独立持久化共用 sequence 无空洞；三视角投影（他者只见占位）；占位不唤醒不阻塞；失败不占额度；WS 连接活跃 = 在线判定 | `whisper-placeholder-stale`、`rh3-whisper-projection` |
| SD215：LLM 新投递与查询同形（#215，待验收） | 新投递的 `pi-tavern.group-chat-input.content` 中「新消息」段是可解析的 JSON 消息元素数组：先按自产过滤和上下文窗口选出对应消息，再将每项与同一查询者的 `fetch_messages_since` / `get_message_history` 的 `result.messages[]` 作全字段深等对照（含 `jsonrpc/method/params`、无额外字段，不要求注入全集等于查询全集），含旧 `message_history.messages[]` 兼容路径及续页的内层元素；不带请求 `id`、分页外壳或旧模板副本。单批按 sequence 稳定升序且去重；身份、来源、状态、system、board 与操作指引分区，非消息事件不占消息序号。接收者私信有全文，发送者查询有全文但自产私信不触发注入，旁观者实时占位不唤醒、后续补拉只见无 `content/round/title` 的占位且整段输入不含密文；同 Session 手动重入沿既有游标补拉有 sequence 的消息，新 Session 加入前历史不自动注入。含可投递他人消息的批次入队不推进连续覆盖区间，`message_start` 消费确认后才推进；纯自产回显无输入时仍可按拉取覆盖证明推进；跨批已读重复允许、未读不可跳。失败增量仅待后续真实拉取机会，不保证空转 settle 自愈，也不承诺补回断线期间的非 sequence 通知。存在项目/全局合并后仍生效、且在来源配置文件中显式声明的有效受影响模板键时，每次加载或 reload 在用户可见通道恰一条迁移提示（重复 reload 各一条）；无此配置或只有非法/被回退键时零条；实时消息不再应用旧模板，历史工具/TUI 与私信落盘旧渲染不变，`seconds_ago/minutes_ago` 无实时消费点。旧 pi session 不回写，不新增 title；wire、持久化、查询、工具参数与轮次额度不改 | integration `chain:serialize-total` / `chain:batch-order` / `chain:legacy-history` / `chain:cursor-consume-retry`（进程内模拟 pi 消费边界，解析 content；证据标明 mock，不能替代真实 pi）；acceptance `chain:whisper-views`（真实三角色、带转义与换行的唯一密文、掉线手动重入）、`chain:template-notice`（RPC/交互通知、headless 前缀、reload）及 welcome/board 分区，核对真实 pi 已消费 content 而非只查 WS 帧或 `details.events`；unit 检查显式有效键聚合；交互 TUI 可见性手动走查，原始 `console.warn` 不作通知证据 |

> 已知边界：消费确认前未确认区间可被重拉重投（实时帧与拉取帧并存时同帧可投两次；长 run 无工具间隙时窗口最大）——失守方向 = 重复，非跳过；消费事件缺失（扩展 API 无 `on`）同属重复方向。interactive abort 丢弃已入队 steer 的语义随 #201 变更：区间保持未读、后续重拉（替代原「入队即推进 → 永久跳过」）；RPC abort 不清队列由 J2 钉测 `j2-rpc-abort-no-loss` 固化。详见 group-chat-input.md「已知边界与残余风险（#201 消费水位落地后）」节。

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
