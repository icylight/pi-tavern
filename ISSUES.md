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
