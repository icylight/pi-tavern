# PiTavern Active Group Chat Discovery

本文记录同一项目中多个 pi 进程发现活动群聊的本地机制。

## 设计边界

PiTavern 不实现常驻注册服务，也不依赖纯进程扫描：

- 群聊是在 pi 进程启动后通过 `/tavern-new` 或 `/tavern-resume` 创建，不能从原始进程参数取得群聊 ID 和端口。
- macOS 没有 Linux 的 `/proc`。
- `lsof` 等外部命令不是所有 Linux 环境都保证安装的运行依赖。
- `process.title` 可能被截断，也不适合承载一个运行期注册协议。
- 扫描本地端口不能可靠判断端口所属的项目和群聊。

普通 pi-coding-agent CLI 没有可复用的进程注册表。`references/pi/packages/server` 虽然使用 `server.sock` 和 `instances.json`，但它是独立的实验性服务，不是普通 pi CLI 的运行机制。PiTavern 扩展不依赖该服务。

## 状态目录

PiTavern 复用 pi 的 agent 根目录解析规则，包括 `PI_CODING_AGENT_DIR` 覆盖。活动描述保存在：

```text
<pi-agent-dir>/tavern/<project-key>/active/<group_chat_id>.json
```

默认形式为：

```text
~/.pi/agent/tavern/<project-key>/active/<group_chat_id>.json
```

`project-key` 按照 pi session 相同的 canonical cwd 项目隔离思路生成。活动描述同时保存 canonical cwd，发现时必须再次校验，不能只相信目录名称。

群聊运行状态不写入项目内的 `.pi/`。项目内的 `.pi/tavern.json` 只保存项目配置。

## 活动描述

每个活动群聊使用独立文件，避免多个群聊创建者并发改写同一个注册表：

```json
{
  "instance_id": "runtime-uuid",
  "group_chat_id": "group-chat-uuid",
  "name": "技术讨论",
  "cwd": "/absolute/project/path",
  "pid": 12345,
  "host": "127.0.0.1",
  "port": 53142,
  "started_at": "2026-07-26T12:00:00.000Z"
}
```

`instance_id` 与 `group_chat_id` 使用 pi server 中运行实例 ID 与持久 session ID 分离的相同语义：

- `group_chat_id` 是持久群聊身份，来自 pi session header `id`，恢复后保持不变。
- `instance_id` 是当前活动实例身份，每次 `/tavern-new` 或 `/tavern-resume` 使用 `randomUUID()` 重新生成。
- `instance_id` 只存在于运行期，不写入群聊 session。
- PiTavern 只参考该身份分层，不依赖实验性的 pi server 包。

活动描述是临时的候选地址，不是群聊状态的事实来源：

- WebSocket 成功监听后才尝试以排他方式原子创建描述文件。
- 群聊改名后同步更新 `name`。
- 正常关闭群聊时删除描述文件。
- 异常退出可能留下失效描述，由后续发现流程清理。
- `/tavern-resume` 创建新的活动实例、重新分配端口并写入新的描述。
- 更新或删除活动描述前，进程必须确认文件中的 `instance_id` 仍属于自己。

## 单一活动创建者

同一个 `group_chat_id` 同时只能由一个 pi 恢复并成为活动群聊创建者：

- `/tavern-resume` 选择器将存在有效活动描述的群聊标记为“活动中”，不允许再次恢复。
- 选择前的活动状态检查只用于界面提示，不能作为并发控制。
- 确定恢复时必须排他创建 `active/<group_chat_id>.json`，以此作为最终的原子占用。
- 两个 pi 同时尝试恢复时，只有成功创建活动描述的一方完成恢复；另一方关闭刚监听的 WebSocket 服务并提示群聊已经活动。
- 描述文件失效时，先完成失效确认和清理，再重新尝试排他创建。

群聊创建者只有在成功占用活动描述后才进入活动状态并显示恢复成功。PiTavern 不允许同一群聊出现两个创建者，也不允许两个进程同时向同一个群聊 session 追加记录。

## 发现流程

`/tavern-join`：

1. 取得并规范化当前 pi 的 cwd。
2. 定位当前项目对应的 `active/` 目录。
3. 读取其中的全部活动描述。
4. 丢弃无法解析或 `cwd` 不匹配的描述。
5. 使用 `process.kill(pid, 0)` 检查同用户进程是否仍然存在。
6. 清理 PID 已不存在的失效描述。
7. 一个候选时直接连接；多个候选时显示群聊选择界面。
8. 通过实际 WebSocket 连接确认候选是否仍然有效。
9. 连接失败时清理该失效描述并提示用户。

PID 检查只用于快速排除退出进程。PID 存在不代表群聊有效，最终结果始终以 WebSocket 连接和群聊身份校验为准。

## WebSocket 身份确认

连接地址包含目标群聊 ID：

```text
ws://127.0.0.1:<port>/<group_chat_id>/<instance_id>
```

群聊创建者在 WebSocket upgrade 阶段检查路径中的 `group_chat_id` 和 `instance_id`：

- 两者都与当前活动实例一致时接受连接。
- 不一致时拒绝连接，不进入 `join_group_chat` 流程。

因此即使描述文件陈旧、PID 被复用或端口被其他进程重新占用，也不能仅凭描述文件成为有效群聊连接。

## 角色清单按需刷新（#25，2026-08-03）

宿主（creator）的角色清单默认是启动快照：`/tavern-new` 或 `/tavern-resume` 时扫描一次角色卡目录，此后固定。这带来两个缺陷（#25）：

- 新增角色卡后，已运行的群聊 join 不可见新卡。
- 已有卡 name/description 变更后，leave→join 时 claim 返回旧摘要，与客户端磁盘重读的新卡不一致，`loadClaimedCharacter` 校验抛错导致 join 失败。

### 懒刷新机制

宿主在以下协议消息处理前按需重扫磁盘（懒刷新）：

- `join_group_chat`（available_characters 列表需含新卡）
- `claim_character`（claim 校验与响应摘要需用最新卡）
- `get_group_chat_state`（群聊状态查询前同步）

刷新来源（`CreatorRuntimeDependencies.loadCharacters`）按优先级注入：

1. `StartNewCreatorRuntimeOptions` / `ResumeCreatorRuntimeOptions.loadCharacters`（组合根显式注入，测试可 mock）
2. `CreatorRuntimeDependencies.loadCharacters`（依赖覆盖）
3. 默认实现 = 重新执行 `loadTavernConfig` 读磁盘（组合根语义）

未注入 = 启动快照语义（行为零变化）。

### 刷新语义

- 刷新成功且结果非空 = **原地更新** characters Map（`clear` + `set`，保持 Map 实例引用——member-bookkeeping 与各 pipeline 持有的同一引用自动可见）。
- 刷新失败或结果为空 = **回退旧快照**（不动 Map），join/claim 按旧清单继续工作。
- reload 路径（`createFromHandoff`）不注入刷新来源 = 保持 handoff 快照，不破坏 ISSUE-005 的 reload 语义。
- 协议/持久化契约零改动；刷新只影响宿主内存中的角色清单。
