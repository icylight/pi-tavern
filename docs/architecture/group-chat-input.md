# PiTavern Group Chat Input

本文定义角色 pi 如何将 WebSocket 群聊环境转换为当前 pi Agent 的一次输入。

## 输入模型

角色 pi 不创建第二个 Agent 或 session。PiTavern 的群聊输入模块是当前 pi Agent 的另一种输入来源：

```text
group_chat_update 通知（广播唤醒：水位 + 最近 3 条预览，不注入）
        ↓
run 边界：闲态 ≤1s 聚合窗口（N→1）/ 忙态启动投递窗口（默认 5s，N→1），
         先到者触发；同时排一个隐藏令牌，在 steer 安全边界 abort
        ↓
fetch_messages_since(本 Session 持久化游标)（扩展机械拉取，sequence 过滤天然补洞）
        ↓
完整未读批注入（消息元素按 sequence 去重排序；幂等可重拉；统一 steer + triggerTurn）
        ↓
生成一条 pi 原生 custom_message（不打断 run，工具批后可见）
        ↓
当前 pi Agent / pi session
```

- 公开消息走「通知 + 增量拉取」：广播只携带最新序号与最近 3 条预览，完整增量由角色主动拉取；忙态正文不入队，但启动**投递窗口**（默认 5s，`PITAVERN_DELIVERY_WINDOW_MS` 可注入）——窗口到期仍未 settle 即主动拉取投递（投递延迟上界 = 窗口 + 一个工具间隙，不依赖 run 结束；连续工具链数十分钟不 settle 的长 run 不再零投递）。隐藏令牌仍会排（让当轮尽早结束），但投递不再依赖它。settle 先到则窗口空转、由 settle 路径投递，两者以同一待投递标记为闸门、不重复。
- `group_chat_update` 只由公开消息触发；白板走独立 `board_update`；成员与流式状态变化不再唤醒 Agent，也不进入 Agent 输入。加入时的历史不自动注入：进入前历史仅经 `tavern_history` 工具直回 Agent 上下文（不经本模块）；本模块 `fetch_messages_since` 只消费预置水位（进入时刻）之后的增量（ready 后仅单播 `system_message` 欢迎语）。
- 游标（**已消费的最后一条 message sequence**，即消费确认水位）本地持久化（`<agent-dir>/tavern/<project-key>/cursors/<group_chat_id>/<session_id>.json`，**游标跟随 Session**），**消费确认后更新**（#201：pi 把注入批推入 agent 上下文时 emit `message_start`；批次入队与 whisper 发布均不推进），重启不丢；同群聊多角色互不共用游标文件。**旧版群聊级单文件（`cursors/<group_chat_id>.json`）废弃不读**（值无 Session 身份，回退采用会跳过消息）；新 Session 无独立游标时预置游标 = 进入时刻水位（方案 a：ready 响应 `latest_sequence`；旧服务端缺省回退预置查询路径——join 后一次 `fetchMessageHistoryPage(null)` 取水位 CAS 写），进入后增量拉取不重不漏（严格区间 = 预置完成后）。
- 一个防抖批次只生成一条输入。单个 WebSocket 消息不直接追加到 pi session。

## pi custom message

群聊输入使用 pi 原生 `sendMessage()`。**#196 起两条路径统一 `deliverAs: "steer"`**（pi 只在真实 streaming 时区分 steer/followUp，idle 时忽略 deliverAs 直接开 run；统一 steer 避免本地状态与 pi 真实状态不一致时误入 followUp 滞留队列）：

```ts
pi.sendMessage(
  {
    customType: "pi-tavern.group-chat-input",
    content,
    display: true,
    details: {
      group_chat_id,
      character_id,
      events,
      group_chat_state,
    },
  },
  {
    triggerTurn: true,
    deliverAs: "steer",
  },
);
```

约定：

- `customType` 固定为 `pi-tavern.group-chat-input`。
- `display` 为 `true`，TUI 可以注册专用 renderer。
- 统一 `deliverAs: "steer"` + `triggerTurn: true`：pi 侧 streaming → steering 队列（工具批后、下一 LLM 调用前注入，秒级可见，不打断 run）；idle → 忽略 deliverAs 直接开新一轮 run。
- 不 `await` `sendMessage` 全量完成：pi SDK 的 `sendMessage` 在当前 run 结束后才 resolve，await 会锁死单飞行锁整个 run 时长——统一投递只做「交给 pi 队列」这一同步步骤，不等待 run 结束；游标推进与之解耦（消费确认，见下）。
- **游标推进 = 消费确认（#201）**：批次随 `details` 携带覆盖元数据（`coverage_from` / `latest_sequence`）；pi 把批推入 agent 上下文时 emit `message_start`，据此推进。含可投递他人消息的批次只有在覆盖区间下界 ≤ 当前游标（区间已被本批完整消费）时才推进其连续覆盖区间；缺口未补或无覆盖元数据（旧格式 / 无 `on` 降级面）不推进——未确认区间保持未读，后续真实投递机会重拉（重复可接受、跳过不可接受）。纯自身回显或无可投递未读的拉取批不生成 Agent 输入，仍可按拉取覆盖证明直接推进 `page.latestSequence`。
- **投递失败语义**：同步抛错（入队拒绝 / 会话未就绪）不推进并整批入 `retryBatch` 重投；pi `sendMessage` 异步失败对扩展不可观测（fire-and-forget），其后果同「未确认」——重拉重投。结构化消息序列化只处理已解码的 JSON 值（`decodeServerMessage` 产物），本轮不新增序列化失败状态机。
- 当前 pi Agent 空闲时立即触发 Agent run。
- 当前 pi Agent 正在 streaming 时：文本经 steering 队列注入（不打断 run）；忙态投递窗口与 settle 先到者触发拉取（见上），公共消息通知（`group_chat_update`）本身零正文。

该 `custom_message` 及随后产生的 assistant 回复、工具调用和工具结果按照 pi 原生逻辑写入角色当前的 pi session。已写入旧 session 的条目不回写，也不新增会话标题（标题与未读投影属 #216）；本变更只影响此后新投递的输入。它不写入群聊记录；只有成功的 `tavern_speak` 内容才进入群聊记录。

## details

`details` 保存输入对应的结构化环境：

```json
{
  "group_chat_id": "group-chat-uuid",
  "character_id": "developer",
  "events": [],
  "group_chat_state": {}
}
```

- `details` 是 PiTavern 自定义 JSON，字段使用 `snake_case`。
- `events` 保存当前聚合批次，保持聚合顺序（待处理实时事件在前，拉取结果追加在后），批内按 sequence 去重并过滤已消费帧；`group_chat_update` 预览只触发拉取、不进入 `events`。兼容的旧 `message_history` 容器只取其 `params.messages[]` 内层元素，外层分页字段不进入消息元素。`details.events` 顺序不是 LLM 输入顺序——按 sequence 排序只作用于 `content` 消息区。
- `group_chat_state` 是提交前通过 `get_group_chat_state` 取得的最新快照。
- `details` 用于 TUI 渲染、检查和问题排查，不发送给 LLM；LLM 只看到 `content` 的文本投影。
- `details` 不是群聊历史的事实来源。

## content

`content` 是从 `details` 生成的 Agent 可见文本。消息区使用查询接口同形的 JSON 消息元素数组，其他环境信息继续使用独立文本分区：

```text
PiTavern 群聊环境更新

当前时间：2026-09-30 14:00:00
你的当前角色：Developer（character_id=developer，注册名=Developer）
来源：群聊
群聊：技术讨论

新消息：
[
  {
    "jsonrpc": "2.0",
    "method": "public_message",
    "params": {
      "event_id": "event-uuid",
      "sequence": 12,
      "timestamp": "2026-09-30T06:00:00.000Z",
      "sender": {
        "type": "character",
        "character_id": "tester",
        "name": "Tester"
      },
      "content": "我建议从消息类型开始。",
      "round": {
        "round_max_messages": 10,
        "used_messages": 2,
        "remaining_messages": 8
      }
    }
  }
]

当前状态：
- 在线 Character：Developer、Tester
- Round 发言次数：2 / 10
- 剩余发言次数：8

请根据这些群聊变化继续当前工作。
如果需要公开回复，请调用 tavern_speak；
普通回复不会自动进入群聊。
公开回复应简洁，通常不超过 4000 个字符；
较长的完整分析应保留在当前私有 pi session，
只向群聊发布结论、关键理由和需要其他成员知道的信息。
```

其中软上限数值来自 `tavern.json` 的 `speak_soft_limit_chars`（项目 > 全局；缺省 4000，示例为缺省形态）。示例即同视角查询投影的实际字段：公开消息投影不产出可选 `source`；生成消息区前已过滤自产回显，因此不会出现当前角色自己的公开消息。

投影规则：

- 「新消息」数组的元素来自增量拉取（`fetch_messages_since` 的 `result.messages[]`）与旧容器兼容路径（旧 `message_history` 的 `params.messages[]` 内层元素及其续页）；角色主动 `tavern_history` 调用的查询结果直回工具结果，不经本投影。元素与同一查询者的 `fetch_messages_since` / `get_message_history` 的 `result.messages[]` 同形同源，保留完整的 `jsonrpc`、`method`、`params`，不带响应 `id`、`result`、分页 `cursor`、`has_more` 或 `total_messages`。
- 生成消息数组前先应用自产回显过滤、上下文窗口边界和服务端私信投影，再按 `sequence` 稳定排序并去重。注入批次不要求等于一次查询返回的全集，但对齐元素必须全字段一致且不含额外字段。
- `public_message` 保留发送者和完整正文；接收者的 `whisper_message` 保留正文；旁观者的 `whisper_placeholder` 不含 `content`、`round` 或标题字段。发送者查询可见自己的完整私信，但自产私信不触发实时输入。
- 消息正文、身份、来源、状态、操作指引、`system_message` 和 `board_update` 使用明确分区；system/board 不伪装成消息元素，也不占消息 sequence。
- 实时 LLM 消息不再使用 `message_templates` 渲染。`tavern_history`、创建者 TUI 和私信落盘继续使用既有模板；`seconds_ago` / `minutes_ago` 不再有实时消费点。显式有效的受影响模板配置通过配置加载入口向用户提示，不把提示写入 LLM 消息区。
- `content` 只服务 Agent 上下文，不作为公共群聊历史或协议数据；它不 dump JSON-RPC 请求/响应外壳。
- Character Markdown 不进入 `content`；它在领取时加载一次，并作为加入期间稳定的 system prompt 扩展。
- Character 自己公开消息的广播回显不进入防抖批次：preview 完整覆盖的纯自身窗口在拉取前过滤；preview 不完整且含自身消息时不排打断令牌，只在后续真实拉取机会补拉；拉取结果继续过滤 `isOwnEcho`，纯自身窗口只按覆盖证明推进水位、不生成输入。
- 普通请求响应和手动状态请求不生成群聊输入。

reload 使用 handoff 保留尚未提交的 pending 事件和交接窗口内的缓冲帧，接管后按到达顺序重放；这不等同于真实断线恢复。真实 WebSocket 断开时，角色 pi 立即停止群聊输入模块并丢弃尚未提交的防抖批次，首版不自动重连。用户手动重新加入并领取 Character 后，沿同一 pi Session 的持久化游标补拉有 sequence 的公开消息和私信投影；重复可接受，跳过不可接受。非 sequence 的旧 `system_message` 不由游标重放，重 join 只发送新的欢迎语；`board_query` 只能取得白板当前快照，不重播断线期间的旧 `board_update`。

当前 pi 切换到不同 `sessionId` 前，PiTavern 按正常离开流程停止群聊输入模块。群聊输入状态和 Character system prompt 不继承到新 session；已经提交给旧 session 的消息和 follow-up 仍归旧 session 管理。

已经通过 `sendMessage()` 提交给 pi 的群聊输入由 pi 原生 session 和 follow-up queue 接管：

- WebSocket 断开时不删除已经写入 pi session 的 `pi-tavern.group-chat-input`。
- 不移除已经进入原生 follow-up queue 的群聊输入。
- 不打断当前正在进行的 Agent run。
- 尚未触发的新 Agent run 不再获得已经移除的 Character system prompt。
- `tavern_speak` 已经停用，因此这些输入后续产生的普通回复只能保留在当前 pi session，不能进入群聊。

PiTavern 只管理提交前的防抖缓冲区，不实现 pi 原生队列的撤销或清理。

## 模板消费面与迁移告知（#215）

实时 LLM 消息区改为结构化消息元素后，五个 `message_templates` key 的消费面变化：

| key | 实时 LLM 消息区 | 其余消费面 |
| --- | --- | --- |
| `public_message` | 不再应用 | `tavern_history`、创建者 TUI |
| `whisper_full` | 不再应用 | `tavern_history`、TUI、私信落盘 |
| `whisper_placeholder` | 不再应用 | `tavern_history`、TUI |
| `seconds_ago` / `minutes_ago` | 不再应用 | 无（失去唯一消费面） |

- 受影响 key = 上表五个 key；触发条件 = 「项目/全局来源文件中显式声明、通过占位符规则校验、且合并后仍生效」的受影响 key 至少一个。
- 每次配置加载（`/tavern-new`、`/tavern-resume`、`/tavern-join`）或 reload 在用户可见通道恰一条聚合提示；重复 reload 各自至多一条；无此类 key 零条；只有未知 key、非法值或被回退项时零条（既有逐项 warning 与回退规则不变）。
- 可见通道按运行模式：交互 = `ctx.ui.notify`；RPC = notify 事件；headless 自动加入 = `[pi-tavern:auto-join:*]` 前缀诊断输出；reload = 接管通知通道。原始 `console.warn`（stderr）不构成用户可见告知证据。
- 提示只说明模板消费面变化，不写入 LLM 消息区，不改变 `message_templates` 的文件格式与合并规则。

## 已知边界与残余风险（#201 消费水位落地后）

- **区间跳过（已修）**：可投递批次入队**不再推进游标**（纯自身回显走拉取覆盖证明）——interactive abort / Esc 的 `clearAllQueues` 静默丢弃（扩展 custom message 无返还、无事件）后，游标保持未确认，后续投递机会拉取同一窗口重投（重复可接受、跳过不可接受）。原「入队即推进 + 清队静默丢弃 = 永久跳过」盲区由消费确认水位关闭。
- **残余：重复投递**。未确认区间在消费确认前会被重拉重投（实时帧与拉取帧并存时同帧可投两次）；失守方向 = 重复，非跳过。
- **残余：消费事件缺失**（扩展 API 无 `on` 的降级面、pi 版本无对应事件）→ 水位不推进 → 反复重拉（同属重复方向）；该形态不静默跳过。
- **入队时点无痕**：triggerTurn 的 custom message 在**消费时**才落 session / emit——入队未消费的批在 session 日志中无迹，排障依赖投递链日志钉（#202）。
- **验证**：`skip-hole.test.ts`（R2 清队丢弃 / R7 异步失败不可见 / R5 消费确认对照绿）+ acceptance A1 无洞不变量；RPC 模式 abort 不清队列由 `j2-rpc-abort-no-loss.test.ts` 固化。
- **影响面**：interactive 模式 + 忙态 run + 用户 abort 三条件同时成立时曾可丢失；RPC/headless 模式无此路径。
