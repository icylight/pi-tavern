# PiTavern Runtime State Machine

本文定义单个 pi 进程中的 PiTavern 扩展运行状态。

初步代码结构及尚待讨论的架构问题见 [extension-architecture.md](extension-architecture.md)。

## 状态

PiTavern 使用三个稳定状态和一个短暂状态：

```text
idle
├── /tavern-new、/tavern-resume → creator
└── /tavern-join               → joining
                                      │
                                      ├── claim_character → 预留 Character
                                      └── character_ready 成功 → character
```

### `idle`

- 当前 pi 没有创建或加入群聊。
- 可以创建、恢复或加入群聊。
- 不持有群聊 WebSocket 服务、Character WebSocket、活动描述所有权或 Character 运行期资源。

### `creator`

- 当前 pi 托管一个活动群聊并代表 User Persona。
- 持有 WebSocket 服务、活动描述所有权和群聊 `SessionManager`。
- `/tavern-leave` 关闭群聊并完成清理后回到 `idle`。

### `joining`

- 当前 pi 已连接目标群聊 WebSocket，但尚未正式成为群成员。
- 可以接收和刷新可领取 Character 列表。
- 可以处于尚未选择 Character，或已经预留 Character、正在准备本地 `CharacterRuntime` 的阶段。
- 尚未成为群成员，不接收群聊广播。
- `claim_character` 因角色已被领取等业务冲突失败时仍停留在 `joining`，可以刷新列表并重新选择。
- `claim_character` 成功后仍停留在 `joining`，该 Character 暂时不能被其他连接领取。
- 本地准备完成并取得 `character_ready` 成功响应后进入 `character`。
- 用户取消、准备失败后放弃或 WebSocket 断开时，关闭连接、释放预留并回到 `idle`。

### `character`

- 当前 pi 已领取 Character 并成为群成员。
- 已加载 Character system prompt。
- 已启用群聊输入模块和 `tavern_speak`。
- 主动离开、WebSocket 断开、心跳超时、群聊关闭或 pi session 切换时，完成对应清理并回到 `idle`。

## 不使用的状态

首版不定义以下扩展状态：

- `disconnected`
- `reconnecting`
- `paused`
- `closed`

WebSocket 断开即退出群聊，不进入等待重连的状态。群聊是否存在历史记录由 session 文件判断，不使用 `closed` 运行状态。

## 转换约束

- 一个 pi 同时只能处于一个 PiTavern 状态。
- `creator` 和 `character` 互斥，不能直接相互转换。
- 已绑定群聊时不能直接创建、恢复或加入另一个群聊。
- 创建、恢复、加入、领取、离开和关闭过程使用内部 transition lock 串行保护。
- transition lock 只是实现期并发保护，不是业务状态。
- 进入操作失败时，释放本次操作已经取得的资源并回到 `idle`。
- 只有完成全部必要资源初始化后，才提交到目标稳定状态。

## 主要转换

| 当前状态 | 事件 | 目标状态 |
| --- | --- | --- |
| `idle` | `/tavern-new` 成功 | `creator` |
| `idle` | `/tavern-resume` 成功 | `creator` |
| `idle` | `/tavern-join` 建立候选连接 | `joining` |
| `joining` | `claim_character` 成功并预留 | `joining` |
| `joining` | `claim_character` 业务失败 | `joining` |
| `joining` | `character_ready` 成功 | `character` |
| `joining` | `character_ready` 5 秒超时 | `idle` |
| `joining` | 取消、放弃或连接关闭 | `idle` |
| `character` | `/tavern-leave` | `idle` |
| `character` | 断线或心跳超时 | `idle` |
| `character` | `group_chat_closed` | `idle` |
| `character` | 确认退出并执行 pi session 操作 | `idle` |
| `joining` | 确认退出并执行 pi session 操作 | `idle` |
| `creator` | 确认退出并执行 pi session 操作 | `idle` |
| `character` | `/reload` 交接成功 | `character` |
| `creator` | `/reload` 交接成功 | `creator` |
| `character` | `/reload` 交接 5 秒超时 | `idle` |
| `creator` | `/reload` 交接 5 秒超时 | `idle` |
| `joining` | `/reload` | `idle` |
| `joining` | pi 正常退出 | `idle` 后退出 |
| `character` | pi 正常退出 | `idle` 后退出 |
| `creator` | pi 正常退出 | `idle` 后退出 |
| `creator` | `/tavern-leave` | `idle` |

`/new`、`/resume`、`/fork` 和 `/clone` 在非 `idle` 状态下先请求用户确认。取消时状态不变并阻止原生操作；确认时先退出群聊再允许原生操作。退出后不因原生操作失败或取消而回滚状态。

`/reload` 不创建或切换 pi session。`creator` 和 `character` 通过一次性 `ReloadHandoff` 把运行资源交给新 Extension Runtime，交接成功后保持原状态，不产生离开、关闭、重连或重新加入事件。`joining` 不参与交接；旧 Runtime 关闭连接并释放预留，新 Runtime 从 `idle` 开始。

pi 正常退出并触发 `session_shutdown(reason: "quit")` 时，先完成群聊退出和本地资源清理，再允许 pi 继续退出。清理最多等待 5 秒，超时后强制关闭本地资源。强杀、崩溃和断电不经过状态机，依靠断线、心跳和活动描述发现机制收敛。

## 命令可用性

| 命令 | `idle` | `joining` | `creator` | `character` |
| --- | --- | --- | --- | --- |
| `/tavern-new` | 可用 | 不可用 | 不可用 | 不可用 |
| `/tavern-resume` | 可用 | 不可用 | 不可用 | 不可用 |
| `/tavern-join` | 可用 | 不可重复执行 | 不可用 | 不可用 |
| `/tavern-leave` | 无当前群聊 | 通过加入界面取消 | 关闭群聊 | 离开群聊 |
| `/tavern-status` | 显示无当前群聊 | 显示正在加入 | 查看本地权威状态 | 请求并显示群聊状态 |
| `/tavern-set-max` | 不可用 | 不可用 | 可用 | 不可用 |
| `/tavern-name` | 不可用 | 不可用 | 可用 | 不可用 |

规则：

- `groupMaxMessages` 和群聊名称只能由群聊创建者修改。
- Character 只使用 `/tavern-status` 和 `/tavern-leave` 管理当前群聊。
- `joining` 期间加入命令自身持有 transition lock；用户通过当前选择界面取消，不启动第二次加入。
- 状态不允许某条命令时，显示当前状态和可执行的下一步，不静默忽略。
