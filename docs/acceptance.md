# M6 进程级验收

M6 验证只有真实进程边界才能观察的行为：多个真实 pi 进程发现并加入同一群聊、并发发言顺序与全局额度、退出与异常收敛、reload 保持连接、残留描述清理、平台一致性。

## 自动化验收套件

```bash
npm run test:acceptance
```

套件位于 `test/acceptance/`，通过 `vitest.acceptance.config.ts` 独立配置，**不纳入日常 `npm test`**（真实 pi 进程启动慢，完整跑约 2 分钟）。

> ⚠️ 真实 pi 进程共享端口与临时目录：`npm run test:acceptance` **必须与 `npm test` / `npm run check` 串行执行**，不能并行，否则进程互相干扰导致假失败。

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

验收方式：`npm run test:acceptance` 全绿 + 上述断言存在且非空（不接受仅靠人工检查）。

### 身份可查询状态（ISSUE-007，2026-08-01 PM 设计）

模型对自身身份必须有确定性查证通道，不依赖提示文本是否被读到：

1. **tavern_whoami 工具**：character 状态下可调用，返回 `{ 当前角色: name, character_id, 描述: description }`，数据源为 `runtime.character`（join 时注册的单一事实源），与 creator 在线成员表注册记录一致；
2. **可用范围**：仅 character 状态可用；creator/idle 状态返回明确错误（与 tavern_speak 同模式），不泄露其他角色信息；
3. **确定性验收**：单测直接调用 handler 断言返回值 == runtime.character；验收层（PITAVERN_TEST）断言工具存在且响应与注册记录一致——不依赖 LLM 是否读了提示；
4. **被动层保留**：群聊输入身份行（三字段）不变，继续每轮告知（兜底）；
5. **ISSUE-006 裁决**：007 落地后由 User 裁决 006 是否仍独立实施（007 已覆盖「查证」，006 为「每轮提示」增强）。

### 每轮身份提示（ISSUE-006，2026-08-01 User 访谈确认）

每个群聊消息触发的 turn，模型在开口前必须知道自己的角色身份：

1. **identity 字段**：角色卡 frontmatter 支持可选 `identity` 字段；存在时每轮注入其内容，未配置时回退为 `name` + `description` 拼接的身份句；
2. **触发范围**：仅群聊消息触发的 turn（`group-chat-input` followUp）注入；私聊/普通输入不注入；
3. **分层**：完整角色卡仍 join 时注入一次，每轮仅追加简短身份提示（system prompt 层），不替代 ISSUE-003 的消息层身份行（收到消息侧 vs 发出消息侧）；
4. **可观察**：每轮注入的身份提示经 `[tavern-test-injection]` notify 通道暴露（与 ISSUE-003/005 同一观察通道），验收断言提示内容与卡片 `identity` 一致。

验收方式：`npm run test:acceptance` 相关用例绿（身份行 + 身份提示共用观察通道）。

### TUI 发言次数显示（ISSUE-001，2026-08-01 User 指示）

TUI widget（`src/ui/tavern-ui-presenter.ts`）在活跃讨论轮次存在时，必须显示当前角色的发言额度使用情况：

1. **轮次开启时**：creator 与 character 视图均显示 `used / max` 与剩余次数（如「发言：2/10 · 剩余 8」），与群聊输入注入的 Round 计数一致；
2. **发言后更新**：每次 `tavern_speak` 成功后计数递增，widget 刷新；达到上限时显示举手状态（不再显示剩余次数，或明确「已举手」）；
3. **无活跃轮次**：不显示该行，widget 保持现有「N 人在线」「正在发言」内容；
4. **不破坏现有内容**：在线人数与「正在发言」行保留，新增行为附加行。

验收方式：`npm run check` 零告警 + 手动验收（真实群聊中开启轮次观察 widget 三态：轮次中/发言后递增/无轮次）。纯 UI 呈现层，不改协议/持久化/schema。

### 测试门控命令

RPC 模式没有输入通道、也无法调用扩展工具，因此 `PITAVERN_TEST=1`（`npm run test:acceptance` 自动设置）时额外注册：

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

如条件允许，将 `npm run test:acceptance` 原样在 macOS 上运行即为平台一致性自动化验证。
