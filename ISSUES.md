# 已知问题记录

本地问题登记，便于群聊协作与回溯。状态字段：`open`（待处理）/ `in-progress`（处理中）/ `closed`（已解决，注明关闭方式）。

## ISSUE-001: TUI widget 未显示讨论轮次发言次数

- **状态**：open
- **来源**：User Persona 群聊反馈（2026-08-01）
- **对应 GitHub issue**：[#12](https://github.com/icylight/pi-tavern/issues/12)
- **现象**：`src/ui/tavern-ui-presenter.ts` 的 widget 只显示「N 人在线」和「正在发言：xxx」，未显示当前讨论轮次的发言次数（used / max / remaining）。
- **根因**：纯 UI 呈现层遗漏——creator 侧 `runtime.state.round`、character 侧 `lastGroupChatState.round` 均已携带 `round_max_messages` / `used_messages` / `remaining_messages`，群聊输入（`group-chat-input.ts`）的 followUp 也已注入「Round 发言次数：x/y」「剩余发言次数：z」，唯独 TUI 渲染未呈现。
- **建议方案**：widget 在 round 存在时增加一行，如「发言：x/y · 剩余 z」；无活跃轮次时不显示。范围仅 `src/ui/`，不改协议/持久化/schema。
- **验收建议（待 PM 确认）**：
  1. creator 与 character 视图在轮次开启后都显示 used/max 与剩余次数；
  2. 发言后次数递增；达到上限后显示举手状态；
  3. 无活跃轮次时不显示该行。
- **阻塞**：无，不影响现有契约。

## ISSUE-002: 「正在发言」状态显示异常（User Persona 反馈）

- **状态**：open（待复现细节）
- **来源**：User Persona 群聊反馈（2026-08-01，sequence 29："正在发言的状态也不对,这个也记录一下 issue"）
- **现象**：User Persona 观察到「正在发言」状态显示不正确，具体表现待补充（不显示 / 不更新 / 显示错人）。
- **已核实链路**：流式状态（`is_streaming`）在协议与状态机中存在：character 侧 `agent_start`/`agent_settled` 上报 `update_character_state`（src/index.ts:115/122）；creator 侧 `handleUpdateCharacterState` 更新 `onlineCharacters.isStreaming` 并触发 `onMembersChanged` → TUI 刷新（src/creator/creator-runtime.ts:1244）；**但 character 侧 TUI widget 仅在群聊新消息注入（`getGroupChatState` → `onStateSnapshot`）时刷新**（src/character/character-runtime.ts:145），流式变化不会即时推送到 character 视图。
- **待确认**：User Persona 观察到的具体异常表现；creator 视图 vs character 视图哪个不对。
- **阻塞**：无，纯 UI 呈现层。

## ISSUE-003: 发言身份与注入 persona 不一致（speaker 归属异常）

- **状态**：open
- **来源**：群聊协作中观察（2026-08-01）
- **现象**：署名「产品经理」的消息（sequence 2、9）内容为 QA 视角（自我介绍 / git log 核实），实际出自 persona=测试工程师 的 session（17:02:24 启动）。
- **证据链（可复核）**：
  1. 该 session 的 pi 会话文件（`~/.pi/agent/sessions/--home-wangsen-code-pi-tavern--/2026-07-31T17-02-24-*.jsonl`）中 `tavern_speak` 工具结果返回 `Message published (sequence 2)` 与 `(sequence 9)`；
  2. 群聊持久化（`~/.pi/agent/tavern/.../chats/*.jsonl`）中 sequence 2 / 9 的 sender 为 `../characters/pm.md`（产品经理）；
  3. 该 session 注入的群聊输入（`pi-tavern.group-chat-input`）自报 `character_id=../characters/pm.md`、`is_self=产品经理`，但注入的 persona 为 qa.md（测试工程师）。
- **结论**：存在「注册身份（pm.md）与注入 persona（qa.md）不一致」的 session；群聊中「产品经理」身份的发言作者实际是 QA persona session，并非 PM 模型串文案。
- **待排查**：join 时选错角色卡，还是 claim/注册竞态（两个 QA persona session 几乎同时加入：17:02:24 / 17:02:27）。
- **建议**：补端到端身份一致性断言（注入 persona 名 == creator 在线注册名）；speak-order 断言加「speaker 与内容作者一致性」检查。
- **阻塞**：无（speak-order 的 sequence/轮次计数机制正常），但影响群聊可信度与验收裁决。
