# PiTavern Development Conventions

本文记录 PiTavern 的通用开发约定。具体通信协议及其消息结构由对应的技术设计文档另行定义。

## 自定义 JSON

PiTavern 自己定义的 JSON 对象字段名统一使用 `snake_case`：

```json
{
  "event_id": "evt-42",
  "character_id": "developer",
  "group_chat_id": "group-1"
}
```

用于区分对象类型的字符串值也使用 `snake_case`：

```json
{
  "type": "character_message"
}
```

不得在 PiTavern 自定义 JSON 中混用 `camelCase`、`PascalCase` 或 `kebab-case`：

```json
{
  "eventId": "evt-42",
  "CharacterId": "developer",
  "group-chat-id": "group-1"
}
```

本约定只规定 PiTavern 自定义 JSON 的命名风格，不规定任何具体协议的消息类型、字段或封装结构。

复用上游格式时必须保持上游字段原样，不为满足本约定转换字段名称。例如，pi-coding-agent session JSONL 中的 `parentId`、`customType` 和 `parentSession` 继续使用上游定义的 camelCase。

## 通用短期协调超时

PiTavern 的短期协调操作使用固定的 5 秒通用超时。首版不提供配置项。

当前适用场景：

- `claim_character` 后等待 `character_ready`；
- reload 期间等待新 Extension Runtime 接管 `ReloadHandoff`。
- 所有 PiTavern WebSocket request/response，包括加入、状态、历史、离开和 `speak`。

该通用超时不适用于 WebSocket 心跳。心跳仍使用独立确定的 30 秒 ping 间隔和 120 秒失效阈值。

加入期间的请求超时后关闭加入连接并回到 `idle`。正式在线后的普通请求超时视为连接状态已经不可靠，关闭 WebSocket 并进入既定断线清理；不保留状态不明的连接继续处理后续请求。

## 错误展示与日志

首版不创建 PiTavern 独立日志文件。

- 用户可处理的错误通过当前 pi TUI notify、命令结果或 tool result 展示；
- 内部错误保留原始 `cause`，供测试、调试和上层错误归一化使用；
- 用户错误信息应包含发生问题的操作和可安全展示的文件路径；
- 群聊正文、Character prompt、auth、环境变量和完整 pi session 不写入额外日志。

只有实际出现需要跨进程长期诊断且 pi 现有调试能力无法覆盖的问题后，才重新讨论日志文件、轮转、脱敏和清理生命周期。

## 本机与开发 pi 隔离

PiTavern 开发不能直接复用用户日常使用的 pi 可执行入口和 `~/.pi/agent`。开发环境同时隔离：

- pi 可执行入口；
- agent 配置目录；
- session；
- auth、models、settings、trust 和用户级资源；
- PiTavern 的群聊记录、活动描述及其他运行数据。

本机日常 pi 保持：

```text
命令：pi
agent 目录：~/.pi/agent
```

PiTavern 交互开发使用 `references/pi` 中的源码启动器，并设置独立的 agent 目录：

```text
命令：references/pi/pi-test.sh
扩展入口：<repo>/src/index.ts
agent 目录：<repo>/.dev/pi-agent
```

等价启动形式：

```bash
PI_CODING_AGENT_DIR="$PWD/.dev/pi-agent" \
  ./references/pi/pi-test.sh \
  -e "$PWD/src/index.ts"
```

同一次多人群聊开发中的终端 A、B、C 必须使用相同的开发启动形式和同一个 `.dev/pi-agent`，使多个开发 pi 共享 PiTavern 的群聊发现及记录，同时与本机日常 pi 完全隔离。

`.dev/` 是本机运行数据目录，必须加入 `.gitignore`，不能提交其中的凭据、配置、session 或群聊数据。

自动化测试不能共享 `.dev/pi-agent`。每个测试或测试 worker 创建独立的临时 `PI_CODING_AGENT_DIR`，测试结束后释放，避免测试之间发现彼此的群聊、复用 session 或污染状态。

只设置 `--session-dir` 不满足开发隔离要求，因为 settings、auth、extensions 和其他用户级资源仍可能来自 `~/.pi/agent`。只更换 pi 可执行文件同样不够，因为未设置环境变量时仍会使用默认 agent 目录。

## 包与运行环境

PiTavern 使用 npm 管理依赖并提交 `package-lock.json`，与 `references/pi` 保持一致。

扩展以 TypeScript 源码形式由 pi 直接加载：

```json
{
  "type": "module",
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

首版不要求用户预先编译 `dist/`，也不设置没有实际产物的占位 `build` 脚本。只有未来确实需要独立构建或发布产物时才重新讨论 `dist/`。

Node.js 版本跟随当前 pi fork：

```json
{
  "engines": {
    "node": ">=22.19.0"
  }
}
```

不为更旧 Node.js 增加兼容分支。

### 依赖边界

PiTavern 自己安装的首版运行依赖：

```text
ws
```

pi 提供并供扩展导入的核心包按照 pi package 约定声明为 `"*"` peer dependency，不重复打包：

```text
@earendil-works/pi-coding-agent
@earendil-works/pi-tui
typebox
```

- `ws` 提供 WebSocket Server 和客户端；
- `@earendil-works/pi-coding-agent` 提供 Extension API、`SessionManager` 和 frontmatter 能力；
- `@earendil-works/pi-tui` 提供 renderer 组件；
- `typebox` 同时用于 WebSocket JSON schema 和 pi tool 参数 schema。

首版开发依赖：

```text
typescript
vitest
@biomejs/biome
@types/node
@types/ws
```

创建 `package.json` 时选择与 `references/pi` 兼容的版本并固定到 lockfile。

## 质量命令

首版 npm scripts：

```text
npm test       → 运行 vitest 非交互测试
npm run check  → 运行 Biome 检查和 TypeScript noEmit
npm run format → 使用 Biome 自动格式化
```

`npm test` 必须使用单次运行模式，不能默认进入 watch。

## 测试层级

PiTavern 使用三层测试：

1. 单元测试：协议 schema 与 codec、状态转换、配置合并和持久化 entry 转换；
2. 组件测试：使用内存状态或本机 WebSocket 测试 `CreatorRuntime`、`JoinAttempt` 和 `CharacterRuntime`；
3. 少量端到端测试：从 `references/pi` 启动多个开发 pi，验证真实 Extension Runtime 接线。

端到端测试的每个用例使用独立临时 `PI_CODING_AGENT_DIR`。同一个多人群聊用例中的多个 pi 共享该用例的临时目录，不同用例和 worker 之间不能共享。

首版自动化测试不调用真实 LLM。Agent 行为使用可控输入、测试替身或 pi 的非 LLM 路径验证，避免费用、外部网络和不可重复输出。
