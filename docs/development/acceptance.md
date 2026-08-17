# 验收标准

> 只收录**当前可验证行为**与测试锚。已完成需求的详细验收断言与过程记录已压缩（行为细节以测试与 `docs/reference/*` 契约为准，历史见 Git/CHANGELOG/issue）。
>
> 基础验收方式：`npm run test:acceptance -- --all` 全绿 + 断言存在且非空 + 单测/check 全绿 + 协议文档无语义分歧。

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
| 并发发言顺序与额度 | 所有成员收到相同严格递增 sequence；超出 round 额度不发布、举手 | 单测/集成层覆盖（acceptance 无专用锚，原表格锚点名已漂移修正） |
| 退出不污染日常 pi | `isolation.test.ts` | 显式 agent dir 的开发 pi 跑完整流程后：日常 HOME 无 tavern 痕迹、项目目录无修改 |
| 异常终止收敛 | `crash-convergence.test.ts` | kill -9 Character → creator 收敛成员；kill -9 Creator → character 回 idle；残留 descriptor 被后续发现流程清理 |
| reload 保持连接 | `reload.test.ts` | 真实 `/reload`（经测试命令触发 `ctx.reload()`）：成员连接、身份、端口保持，reload 后消息仍可达 |

## 当前行为验收锚

| 行为域 | 现行行为（一句话） | 锚点测试/验证 |
| --- | --- | --- |
| 身份一致性 | 身份行三字段注入、注册=注入一致、speaker 一致、并发不串 | `identity-consistency` |
| tavern_whoami | character 可用返回 `runtime.character` 三字段；creator/idle 明确拒绝；身份行被动告知保留 | whoami 单测（三态） |
| reload 角色卡刷新 | handoff 重读新卡注入；重读失败保旧卡 + notify 告警，不断连 | `reload` |
| TUI 发言次数 | 轮次开启显示 used/max 与剩余；发言后递增；上限显举手；无轮次隐藏该行 | 手动（三轮态） |
| 消息推拉混合 | 广播通知化 + 主动增量拉取 + Session 游标持久化 + 缺口检测；闲态 ≤1s 固定窗口聚合 N→1 不重置、忙态零正文（仅置未读/排隐藏令牌）settled 后拉全投递（≤5s）；游标 = `cursors/<groupId>/<sessionId>.json`，join 预置 = 进入时刻水位（三分：已有游标返回 / 新帧 latest_sequence 预置 / 旧帧回退查询水位 CAS 写），旧群聊级共享游标不采用（不读不写不删），仅预置失败游标保持 null → 全量分页兜底；同 Session 文件不存在仅现于预置失败 | `live-delivery`、`context-window`、does-not-adopt-v1 钉测、游标单测 |
| 仓库健康度 | `npm run health` 聚合 audit/gitleaks/卫生三检查；退出码 0=全绿；输出结构稳定 | 手动（人造样本） |
| TUI 工作状态 | agent_start 续命 watchdog（clearStreamingResetWatchdog + isAgentActive 守卫）；真悬挂 5s 复位保留；空闲不误亮 | `w1c-light-probe`、`streaming-truth` |
| 消息来源显式化 | `public_message.source` 字段（缺省=group）；群聊注入含显式来源声明；终端私聊不进入公共流，Character 间私信走独立 whisper 帧 | `identity-consistency`、`abort-steer-visibility` |
| 欢迎与历史行为 | ready 后恰 1 条 system_message 欢迎语并进入首次环境批次；零自动历史推送；`tavern_history` 分页 10 条/页 + cursor/has_more/total；welcome 三档配置链；ready 响应 `latest_sequence` = 进入时刻水位（旧帧回退查询预置） | `welcome-message` |
| 上下文窗口 | 增量拉取起点退 N 含游标自身已读 + 未读全量；游标存储值不变；历史翻页不受窗口影响；窗口=0 时行为不变；reload 延续；回显不唤醒 | `context-window` |
| WS 连接收尾 | 错 result fail-close 断链；错误帧断线；reload 不绕过校验；id 恒 number 自增 | 相关单测 |
| 文档生成化 | `npm run check` = biome + tsc + generate-schema --check；schema jsonc 唯一手写处、generated 自动生成 | `npm run check` |
| resume 完整历史 | 恢复后完整投影（无 10 条截断）升序；重复 resume 幂等；创建者见私信全文；统一文案渲染 | `resume-history`、`rh3-whisper-projection` |
| 角色卡/模板编辑 skill | 两 SKILL.md 随包分发（pi manifest skills 声明）；命令已删、访谈指令迁入；template 单源引用 `tavern_template_defaults`；写入前 diff/确认/取消零写入；SKILL.md 含联动检查清单 | SK6 机械锚单测 |
| 角色卡运行时 profile 临时覆盖（#180） | `model`/`thinking` 独立可选：配置层仅检查缺席、非 string 与空串，不校验 model 目录/provider-id 格式或 thinking 枚举/大小写；任意非空字符串原样进入运行时尝试。加入后异步 best-effort 按 model→thinking 应用，model 无法解析/不可用/未达标时跳过 thinking并提示但不阻塞；thinking 以 pi getter 钳制后的实际值为准。正常离开/存活断线按双维 mask 仅恢复基础检查通过的配置维度，允许中途手动修改且不持续纠正；reload 交接 baseline/队列并对在途任务分阶段续接、不重放；缺失字段行为不变，强杀不保证恢复 | `character-model-hook` unit/integration；`character-model-hook.test.ts` acceptance（command/headless、thinking-only、model-only、手动修改、reload、运行时失败/钳制与 settings 基线） |
| 文案模板 | 五 key（public/seconds/minutes/whisper_full/whisper_placeholder）按 项目>全局>内置 合并；容错逐项回退；占位符规则校验；三消费面同模板集 | 模板单测 |
| 私信 | `tavern_whisper` 仅在线 Character 间 + 活跃轮次；独立持久化共用 sequence 无空洞；三视角投影（他者只见占位）；占位不唤醒不阻塞；失败不占额度；WS 连接活跃 = 在线判定 | `whisper-placeholder-stale`、`rh3-whisper-projection` |

> 已知边界：interactive 模式 abort 可能丢失已入队 steer（入队即推进游标），见 group-chat-input.md「已知边界」节（J2 钉测 `j2-rpc-abort-no-loss` 固化）。

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
