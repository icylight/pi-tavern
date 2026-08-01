# ADR-0002：TUI 渲染成本分析——终端能力判定、驱动源证伪与启动选项

- 状态：**Draft**（2026-08-02，等 #31 收尾后 Accepted）
- 决策者：架构师（查证/评审）、开发工程师（实测）、产品经理（#31 立项与口径）
- 关联：ISSUE-014（#29）、ISSUE-013（#28）后续、#31（tui-lite 立项）

## 背景

ISSUE-014 记录「空闲 TUI 渲染热点」：每个群聊角色 pi 进程空闲 35-42% CPU，profile 显示热点在 pi TUI 渲染管线（parseKittyImageHeader ~75 次/秒、normalizeTerminalOutput、truncateToWidth、box 渲染，约 60fps）。PR #30 以 headless RPC 模式根治（角色空闲 ≤1%），但 User 要求保留 TUI 界面，headless 不被接受 → 需要「TUI 保留 + CPU 可控」的路径。

## 平台源码查证（references/pi，只读）

### 1. 渲染循环结构

- 渲染是**事件驱动 + 16ms 限频**（`MIN_RENDER_INTERVAL_MS = 16`，60fps 上限），非定时轮询：`requestRender()` → `scheduleRender()` → `doRender()` 全量 diff；
- `doRender()` 对每帧可见行执行：行构建、`normalizeTerminalOutput`、`isImageLine` 检测（fast path startsWith / slow path includes）、与上帧 diff，输出变化部分；
- 空闲时持续渲染的驱动源候选：loader/spinner 定时器（agent 活跃时有）、终端协议交互响应（kitty 键盘协商、OSC 11 颜色通知、cell size 查询 → `invalidate`+`requestRender`）、真实终端反馈环。

### 2. 终端能力判定（`detectCapabilities`）

- **触发 Kitty 图像协议**（`images: "kitty"`）：`KITTY_WINDOW_ID` 存在，或 `TERM_PROGRAM=kitty|ghostty|wezterm|warp`；
- **images: null（纯文本渲染）**：tmux（`TMUX` env）、screen、vscode、alacritty、WT_SESSION、iterm2（iterm2 协议）、及**所有未识别终端（默认分支）**；
- `images: null` 时 `renderImage()` 直接 `return null`（图像编码全跳过），但逐行 `isImageLine` 检测仍执行（fast path 廉价）。

### 3. Tabby 环境判定（2026-08-02 实测 env）

User 终端为 Tabby：`TERM=xterm-256color`、`TERM_PROGRAM=Tabby`、无 `KITTY_WINDOW_ID`、无 `TMUX` → **默认分支 `images: null`**——图像解析热点在 User 环境本就不存在。

## 关键实证（Dev，2026-08-02，真实 Tabby 环境）

- 三个真实 Tabby 会话（creator/架构师/PM）空闲 0.09-0.11%，与 script pty 探针 0.10% 一致；
- A/B 二分实验：真实窗口前台（A）vs stdout 无真实消费者（B）均 ≈0.1%，无差异；
- **结论：「空闲 60fps 自持渲染」在当前构建 + 当前环境被证伪**；ISSUE-014 的 35-42% 原测不可复现（现场已清理，归档历史值）；
- User 感知的高 CPU = 活跃并发负载（LLM/工具处理实测 8-906%）+ 验收套件瞬时 + Tabby 自身 7-22%，与渲染无关。

## 决策

1. **#31 以「当前环境达标（空闲 0.1% ≪ 目标 2-3%）」收尾**；不引入任何平台侧改动（User 指示：不修改上游包）；
2. **tui-lite（env 覆盖）降级为可选启动选项**：对 kitty 系终端（TERM_PROGRAM=kitty/ghostty/wezterm/warp）仍有通用防护价值，在 User 的 Tabby 环境无增量收益；
3. **tmux 包装保留为可选启动选项**（低优先）：切终端反馈 + 附赠任意终端 attach 查看角色 TUI 的体验收益；
4. **CPU 判别口径**：空闲基线 ≈0.1%；活跃负载（多角色并发 LLM/工具）下 CPU 高是正常现象，非缺陷；若需活跃态降载，方向是「并发 run 节流」（扩展侧策略），与渲染无关，作为后续可选优化。

## 否决的替代方案

| 方案 | 否决理由 |
| --- | --- |
| 平台侧渲染 gate（images: null 跳过图像路径） | User 指示不修改上游包（2026-08-02）；且实测已证伪热点存在 |
| 上游 PR + 本地 patch 组合 | 同上，User 否决 |
| headless RPC 作为主方案 | User 要求保留 TUI |

## 影响面与后续

- 无协议/schema/扩展代码变更；仅启动方式选项（scripts/）；
- 后续若 User 反馈「活跃态 CPU 高」：评估并发 run 节流（独立小项，非渲染）；
- 历史值 35-42% 在 #29/#31 中标注失效，防误引用。
