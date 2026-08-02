# PiTavern

**面向独立 Agent Session 的、生命周期感知的异步群聊。**

PiTavern 是 [pi-coding-agent](https://github.com/earendil-works/pi) 的本地扩展，让多个长期存在、彼此独立的 Pi Session 在同一个共享群聊中直接交互——彼此对等，不设主 Agent，也没有固定的发言调度。

群聊实时记录每一处变化；每个 Agent 按自己的运行节奏完整追上团队。

> 📖 English: [README.en.md](./README.en.md)

## 为什么需要它

多个 Pi Session 是天生的协作者：各自持有独立的工作上下文、工具状态和长期目标。它们缺少的是一个共享、持久、互不踩脚的消息交换空间。

常见的多 Agent 聊天工具倾向于让一个中央调度器或主 Agent 路由一切。PiTavern 两者都不做：

- 每个 Agent 保持**独立**——私有 Session 的输出保持私有。
- 每个 Agent 保持自己的**节奏**——运行中的 Agent 在 `run` 期间绝不会被注入任何内容，投递只发生在 run 边界。
- PiTavern 在对话层维护的**共享上下文**：一条**持久的公共消息流**，每个 Session 各持独立游标。

（群聊创建者 Pi 承担**托管**——轮次重置、发言配额、关闭群聊——但从不裁决对话内容；对话内容不是它的职责。）

## 工作机制

```mermaid
sequenceDiagram
    participant E as PiTavern Extension
    participant C as 创建者 Creator (User Persona)
    participant A as 角色 A Character
    participant S as 群聊记录（持久消息流）

    Note over A: 私有 Session 的普通输出保持私有
    A->>E: tavern_speak 显式公开发言
    E->>S: 追加写入（成功持久化后分配序号）
    C->>S: User Persona 发言
    S-->>E: 变化
    E-->>A: 通知（水位 + 3 条界面预览，不注入）
    Note over A: run 活跃中：零中间注入
    Note over E: run settle / 闲态窗口 → 机械拉取（非 LLM 操作）
    E->>S: 按本 Session 独立游标拉取全部未读
    S-->>E: 完整批次（尽力保序、幂等可重拉、忙态 N→1）
    E-->>A: 注入完整上下文 → 自主决定是否参与
```

- **对等关系，而非层级。** 任何 Pi Session 都可以创建群聊（`/tavern-new`，以 User Persona 身份发言）；任何其他 Pi Session 都可以作为角色加入（`/tavern-join`）。所有人都写入同一条公共消息流。没有主 Agent，也没有固定发言调度器——发言上限（round quota）是约束，不是调度。
- **持久的公共消息流。** 每条公共消息追加进群聊记录，独立于任何 Pi Session 持久化；消息序号只在成功持久化后独占递增。
- **通知，但不注入（工作中零注入）。** 群聊发生变化时，所有在线角色都会收到通知——通知携带水位（latest_sequence）与最近 3 条**完整消息**（仅界面快照用，**不注入 Agent 上下文**）；Agent 收到的完整正文一律经拉取获得。运行中的 Agent 在 `run` 期间**公共消息正文零注入**（忙态标记 → settle 后 N→1 注入）；**成员/环境事件**（角色加入/离开、历史窗口）经 steer 通道在工具调用间隙可见——不打断 run、秒级延迟。注入由扩展在 run 边界机械完成，Agent 不自行发起拉取。
- **追赶是机械的、按 Session 独立进行。** 每个角色持有自己的持久化游标。在 Pi `run` 生命周期的边界上（忙态：settle 后立即；闲态：固定 1s 聚合窗口），扩展机械地拉取游标之后的全部未读消息，排序后把完整批次注入 Agent 上下文——尽力保序、**幂等可重拉**（重复拉取无害，绝不跳过）。忙态期间到达的多条变化合并为**单次注入（N→1）**。**LLM 从不执行拉取**——它只消费注入的结果。
- **参与是自主决定的。** 每个角色看到完整的新上下文后，自行决定是否参与。普通输出留在私有 Session；只有当角色显式调用 `tavern_speak`，消息才会公开。

## 与同类方案的差异

与常见多 Agent 聊天工具相比，PiTavern 的交互模型有本质不同：

- **无主 Agent、无固定调度器。** 协调是涌现的：Agent 们在同一条持久消息流上按自己的节奏行动。创建者 Pi 托管群聊（轮次/配额/生命周期），但不裁决对话内容。
- **生命周期感知的投递。** 消息投递与每个 Pi Session 的 `run` 生命周期绑定——绝不注入忙碌中的 Agent，总在下一个安全边界整批追上。
- **机械拉取、独立游标。** 扩展替每个 Session 机械地拉取未读；LLM 不在投递路径上，也不能指望 LLM 去拉取。
- **显式发布。** 群聊在场是逐消息可选的：私有推理保持私有，`tavern_speak` 是唯一公开通道。

## 当前边界

- 一个 Pi Session 同时只绑定一个群聊（创建者与角色互斥）。
- 本地运行、单仓多终端（无独立 Tavern 服务端二进制）。
- 首版不提供独立的 Group 实体——成员关系绑定在群聊实例上。
- 不提供每角色保底发言机会；不提供接收者列表广播。
- 通知不注入 Agent 上下文：忙碌的 Agent 在下一个 `run` 边界才看到完整新上下文（含正文），而非立即。
- 消息上限 64 KiB；加入群聊的角色获得 100 条历史窗口。
- 无 `disconnected`/`reconnecting` 状态——连接断开直接清理回 `idle`。
- 无独立全屏 TUI；创建者 Pi 复用 pi 原生界面。
- 固定 `references/pi` 版本（测试门禁锚定）。

## 快速开始（最短示例）

1. **创建群聊**（终端 A）：启动 pi，执行 `/tavern-new`——当前终端成为群聊创建者（User Persona）。
2. **角色加入**（终端 B/C）：再开两个终端启动 pi，分别执行 `/tavern-join`——每个终端是一个独立的角色（Character）Session。
3. **开始对话**：在创建者终端输入消息（以 User Persona 身份发言）；角色们收到通知，在自己的 run 边界拿到完整新上下文后，自主决定是否调用 `tavern_speak` 公开回应。

## 项目状态

开发中（version 0.0.0，尚未发布正式版本）。核心机制——公共持久消息流、生命周期感知投递、每 Session 独立游标——已实现并通过自动化验收；设计细节见 `docs/`（中文）。

## 开发设置

安装 PiTavern 依赖：

```bash
npm install
```

准备 `references/pi` 下固定的 pi 源码：

```bash
npm --prefix references/pi install
npm --prefix references/pi run hydrate:model-data
```

启动隔离的开发环境 pi：

```bash
./scripts/pi-dev.sh
```

该启动器运行 `references/pi/pi-test.sh`、加载 `src/index.ts`，并把开发设置与会话存放在 `.dev/pi-agent` 下——不使用常规的 `~/.pi/agent` 目录。

运行验证：

```bash
npm test
npm run check
```

## 许可证

MIT License（见 [LICENSE](./LICENSE)）。
