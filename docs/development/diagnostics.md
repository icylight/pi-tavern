# 诊断面：通知 → 投递链（#202）

> 属主：Dev。开关默认关，只在排查「广播零消费 / 投放静默」类问题时打开。
> 结论面（静态审计）与判别矩阵同页；钉位实现在 `src/shared/diagnostic.ts` + 各域模块。

## 开关与输出

- `PITAVERN_DIAG=1` 打开（每次调用读 env；未设 = 一次属性比较后返回，不构造字段、不写 sink）。
- 输出行：`[tavern-diag] <tag> k=v …`（值单行化 + 120 字符截断）。
- sink：组合根绑定 `ctx.ui.notify`（RPC 模式呈现为 notify 事件流，可落盘）；未绑时回落 stderr（stderr 不进 RPC JSONL 协议流）。
- 关时**零输出**，且批 `details` 不写 `diag_batch_id`（生产 wire/持久化形状不变）。

## 钉位清单

| tag | 落点 | 关键字段 | 判什么 |
| --- | --- | --- | --- |
| `recv` | runtime 收到非响应帧 | method / seq / handler（订阅是否挂） | 帧是否进入本进程、接线是否在 |
| `hub.send` | creator 发送侧（每连接每帧） | sessionId / method / **seq（`params.sequence ?? params.latest_sequence`）** / socketOpen / dropped | 「已发出未到达」的发出侧证据 |
| `route` | GroupChatInput 各分支出口 | decision（history / update-self-only / update-busy-flag / update-idle-armed / placeholder / whisper-dedup-drop / whisper-self-silent / whisper-gap-pull / whisper-pending / realtime-pending / ignored-nonenv） | 帧被哪个分支吞掉 |
| `timer` | 三窗口 arm / fire | name / dueMs / pending / agentActive / incrementPending | 调度是否在走、是否被反复 rearm |
| `flush` | 单飞链 | phase（enqueue / enter / merged / empty / exit）depth / cursor / agentActive / channel / watermark / coverageFrom | 排队、早退与投递通道 |
| `state` | `getGroupChatState` 起止 | phase / **caller（flush / refresh / other）** / durMs / ok | 状态请求悬挂候选；caller 用于把链内请求与 route 期 `refreshGroupChatState` 区分开 |
| `fetch` | `fetchMessagesSince` 起止 | phase / since / count / latest / durMs | 拉取悬挂候选 |
| `inject` | 投递链入队 / 消费 / 游标写 | phase（call / error / consumed / consumed-noop / cursor-write）batch / events / latest / coverageFrom / channel / reason | **入队时点钉**：入队 ≠ 消费；同步入队失败；游标写入理由 |
| `agent` | settle / abort 令牌 | event（settled / token-queued / token-consumed） | run 状态是否卡住 |
| `ws` | 连接面 | event（fail-close / heartbeat-timeout / suspend-suspected）cause | 半开/断线（与「广播死而 RPC 活」互斥） |
| `watch` | 周期探针（30s，`unref`） | tick / stage / stageMs / flushQueuedMs / pendingEvents / agentActive / cursor；超阈附 `stuck` 行 | 「链在飞」vs「链空闲」 |

`diag_batch_id`：开关期在批 `details` 写入的单调序号——把 `inject phase=call` ↔ 会话 jsonl 的 `custom_message` 条目 ↔ `inject phase=consumed` ↔ `cursor-write` 用同一 id 关联（事后区分「入队未消费」与「未入队」）。

## 判别矩阵（观测签名 → 唯一结论）

| 态 | 观测签名 | 结论 |
| --- | --- | --- |
| ① 通知未入 handler | `hub.send` 有、客户端 `recv` 无且 `ws` 无断线 | 传输/订阅面（含服务端发送缓冲静默） |
| ② 通知达但 flushOnce 未进 | `recv` + `route`(pending/armed) 有、`timer fire` 或 `flush enter` 无 | 调度面（定时器未触发/被反复 rearm） |
| ③ flushOnce 进但状态未回 | **`flush enter` 之后**无 `state(caller=flush) start`（调用未发起）或该对无 `end`（在飞） | 该 await 悬挂；判据只取 `caller=flush` 的 state 对（`caller=refresh` 是 route 期 `refreshGroupChatState` 的噪声） |
| ④ 闸门早退 | `flush enter` 有、`flush empty` 或 `exit` 且无 `inject call` | 过滤/闸门（游标已过、窗口去重、`stopped`、无可递送未读） |
| ⑤ 入队错误回调（同步） | `inject phase=call` 有、`inject phase=error` | pi 同步入队失败（入 retryBatch 重投）；**异步失败不出此行**（见下） |
| ⑤′ 入队未消费 | `inject call` 有、`consumed` 无、`agent` run 活跃/无 settle | pi 队列侧（长 run / steer 滞留 / 清队）；与「通知链悬挂」互斥 |
| ⑥ 消费事件不可用 | `inject call` 有、`consumed` 无、`agent` 空闲 | 订阅/事件面丢失（#201 兜底路径的可判别形态） |

读法：先看 `recv`/`hub.send`（帧到没到），再看 `route`（被哪个分支处理），再看 `flush`/`state`（链走到哪），最后看 `inject`/`agent`（进没进 pi 队列、消没消费）。缺哪一行 = 停在哪一段。

## 复现构造（测试面，默认关）

hold 全部走**构造期选项注入**（无 env 入口，生产调用点不落）：

| 构造 | 注入点 | 产出态 |
| --- | --- | --- |
| A 长忙态基线 | 无（`/tavern-test-busy` + 持续消息） | ⑤′（call 有 / consumed 无 / run 活跃）；释放后 `consumed` 出现 |
| B-1 flush 未进 | `JoinAttemptOptions.testFlushHold("enter")` | ②（enqueue 有、enter 无） |
| B-2 状态调用前 | 同上 `"before-state"` | ③ 子态一（`flush enter` 后有、`state(caller=flush) start` 无） |
| B-3 状态返回后 | 同上 `"after-state"` | ④ 前置（`state end` 有、`inject call` 无） |
| B-4 请求在飞 | `JoinAttemptOptions.testRequestHold(method)` | ③ 子态二（`state(caller=flush)`/`fetch start` 有、`end` 无） |
| C 广播未发出 | `CreatorRuntimeDependencies.testDropBroadcast`（`startNew(options, overrides)`） | ① （`hub.send` 有、`recv` 无） |

- ④（闸门早退）的可用构造：`hold@enter` 挡批 + 期间游标被推进过批水位 → 释放后 `flush empty reason=filtered`、无 `inject call`（自回声走 `update-self-only` 分支不进 flush，不可用作④构造）。
- 释放语义：**解析 hold 的 Promise**（不是 abort）；`j2` RPC abort 只用于 A（长忙态）的释放触发。
- 判别性自证：每个 hold 必须与其「未 hold 基线」**成对跑**（证明打得进去、分得出来）。QA 构造落 `test/integration/character/diag-notification-paths.test.ts`（A/B-1..4/C + ④ + ⑤ + ⑤′/⑥，7 格逐格成对）。
- `before-send` 点位不实现：`state` 返回到 `sendMessage` 之间没有 await，同形格只靠注入自身的 stage 名区分（自证回路）。

## 本批静态审计结论（#202）

范围口径：以下结论只覆盖**客户端链**（runtime/输入端）。

- `request()` 内所有 await 均有 5s 超时 + `failConnection`（`flushOnce` 的状态快照、`pullIncrement` 的拉取、历史分页/预置三路同源）⇒ **客户端链不存在「永久静默悬挂」形态**：悬挂会以断线暴露（`ws` 钉可见）。
- 剩余静默面：`pi.sendMessage` 的**异步失败**（fire-and-forget，扩展侧拿不到 promise——见下）与「帧未挂载 / 被忽略分支」（`recv.handler` + `route.decision` 覆盖）。
- **异步失败结构性不可观测（实测核正）**：扩展 API 的 `sendMessage` 返回 `void`（`SendMessageHandler → void`），pi loader 内部 `runtime.sendMessage(...)` **丢弃**该 promise（`references/pi/.../extensions/loader.ts:351-353`）——扩展侧无句柄可挂 `.catch`，`inject phase=error` 只覆盖**同步抛错**路径。要在观测面包含异步失败，只能 pi 侧插桩或上游提请求；本批除外（与 #201「扩展侧拿不到投递确认」同一事实面）。
- **服务端发送缓冲单列**：`BroadcastHub.send` → `socket.send()` 是同步缓冲调用，ws 背压/半开可静默丢帧且不经 `failConnection`——属态 ① 的第三种来源（已发出未到达），由 `hub.send` + 客户端 `recv`/`ws` 钉共同判。
- 事故代际（clone@42c0930，pre-#196）静态对照：await 点结构相同，差异在投递通道（idle 走 `followUp`）——「零消费」在当时由 followUp 长滞留语义即可解释，不必然引入悬挂机理。

## 边界

- 本诊断面不改通知/投递/游标语义；结论若指向行为修改 → 回架构层另批（#202 零修法出口：结论为「老代码语义、#201 已覆盖」即本批成功）。
- 文件 sink（`PITAVERN_DIAG_FILE`）未实现（deferred）：pin 使能时事件量低，notify 流/stderr 捕获足够；真出现长窗生产诊断需求再单独评估。
- 机械锚（`test/unit/shared/diagnostic.test.ts`）：① 生产入口（`index.ts`/`headless.ts`/`commands.ts`）不出现测试 hook 名；② 开关未设时零输出、批 `details` 不写 `diag_batch_id`；③ 开关打开时单行格式；④ 三个 hold 各自停在预期阶段（含 `getGroupChatState` 调用数区分 `before-state`/`after-state`）；⑤ 真实 runtime + mock socket 上 `recv`/`state`/`fetch` 钉产出（`handler=false` 暴露接线态）。
