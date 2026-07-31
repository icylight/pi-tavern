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

## ISSUE-002: TUI「正在发言」状态不准确（User Persona 反馈）

- **状态**：open（待复现细节）
- **来源**：User Persona 群聊反馈（2026-08-01，sequence 29："正在发言的状态也不对,这个也记录一下 issue"）
- **对应 GitHub issue**：[#14](https://github.com/icylight/pi-tavern/issues/14)
- **现象**：TUI widget 的「正在发言：xxx」状态与实际群聊发言不符——角色在私有 session 做分析（读文件、跑测试等工具调用）时也显示「正在发言」，甚至可能长期悬挂不消失；具体表现（不显示/不更新/显示错人）待 User Persona 补充。
- **根因（已定位）**：`src/index.ts` 的 `agent_start` / `agent_settled` 是 pi 的全局 agent 生命周期事件（references/pi 的 agent-session.ts 在每次 agent 响应开始时 emit），并非「群聊发言」事件：
  1. 角色私有 session 的任何活动（普通输入、工具调用循环）都会触发 `agent_start` → 发送 `update_character_state {is_streaming: true}`，creator 即显示「正在发言」——语义错配（agent 活跃 ≠ 群聊发言）；
  2. 若 `agent_settled` 因异常/中断未配对触发，`is_streaming` 卡在 true，TUI 悬挂；
  3. `updateStreaming`（character-runtime.ts:149）的 send 在 socket 未 open 时会 throw，且事件处理器中未捕获，可能污染 pi 事件循环；
  4. 已核实：**character 侧 TUI widget 仅在群聊新消息注入（`getGroupChatState` → `onStateSnapshot`）时刷新**（src/character/character-runtime.ts:145），流式变化不会即时推送到 character 视图；creator 侧 `handleUpdateCharacterState` 更新 `onlineCharacters.isStreaming` 并触发 `onMembersChanged`（src/creator/creator-runtime.ts:1244）。
- **影响**：TUI 误导；结合 ISSUE-003（身份错配），「正在发言」可能显示错误的角色名。
- **建议方向**：只在「群聊输入触发的 turn」内标记 streaming（如仅当 turn 由 group-chat-input 的 followUp 驱动时）；或 agent_start 后延迟配对 agent_settled 超时兜底清除；socket 未 open 时静默跳过；character 侧增加流式状态推送。具体方案待 PM 裁决。
- **阻塞**：无，不影响现有契约（纯 UI 呈现）。

## ISSUE-003: 发言身份与注入 persona 不一致（speaker 归属异常）

- **状态**：open
- **来源**：群聊协作中观察（2026-08-01）
- **对应 GitHub issue**：[#15](https://github.com/icylight/pi-tavern/issues/15)
- **现象**：署名「产品经理」的消息（sequence 2、9）内容为 QA 视角（自我介绍 / git log 核实），实际出自 persona=测试工程师 的 session（17:02:24 启动）。
- **证据链（可复核）**：
  1. 该 session 的 pi 会话文件（`~/.pi/agent/sessions/--home-wangsen-code-pi-tavern--/2026-07-31T17-02-24-*.jsonl`）中 `tavern_speak` 工具结果返回 `Message published (sequence 2)` 与 `(sequence 9)`；
  2. 群聊持久化（`~/.pi/agent/tavern/.../chats/*.jsonl`）中 sequence 2 / 9 的 sender 为 `../characters/pm.md`（产品经理）；
  3. 该 session 注入的群聊输入（`pi-tavern.group-chat-input`）自报 `character_id=../characters/pm.md`、`is_self=产品经理`，但注入的 persona 为 qa.md（测试工程师）。
- **结论**：存在「注册身份（pm.md）与注入 persona（qa.md）不一致」的 session；群聊中「产品经理」身份的发言作者实际是 QA persona session，并非 PM 模型串文案。
- **待排查**：join 时选错角色卡，还是 claim/注册竞态（两个 QA persona session 几乎同时加入：17:02:24 / 17:02:27）。
- **建议**：补端到端身份一致性断言（注入 persona 名 == creator 在线注册名）；speak-order 断言加「speaker 与内容作者一致性」检查。
- **阻塞**：无（speak-order 的 sequence/轮次计数机制正常），但影响群聊可信度与验收裁决。
