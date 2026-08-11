# Headless Character 模式（ISSUE-014，CPU 根治）

## 背景

pi 平台 TUI 包含持续渲染管线，但 Character 本质是自主 Agent——群聊输入即全部交互，不依赖终端界面，因此可使用 RPC 模式省去不必要的 UI。历史 TUI 高占用数字已判不可复现，不作为现行基准；RPC 模式实测空闲约 1%。

## 启动

```bash
scripts/pi-char-dev.sh [--character <name|character_id>] [--group <id|name>] [--] [extra pi args...]
```

等价环境变量：

| 变量 | 作用 |
| --- | --- |
| `PITAVERN_AUTO_JOIN=1` | 启用启动自动 join（脚本自动设置） |
| `PITAVERN_CHARACTER` | 指定角色卡（name 或 character_id）；缺省取第一个可用角色 |
| `PITAVERN_GROUP_CHAT` | 指定群聊（id 或 name 包含匹配）；缺省取唯一活动群聊，多个时取第一个 |

示例：

```bash
# 以「Dev」角色自动加入唯一活动群聊
scripts/pi-char-dev.sh --character Dev

# 指定群聊
PITAVERN_GROUP_CHAT=xxx scripts/pi-char-dev.sh --character qa
```

## 行为

1. 进程以 `--mode rpc` 启动（无 TUI，消除渲染热点），加载 PiTavern 扩展；
2. `session_start` 时检测 `PITAVERN_AUTO_JOIN=1` → 自动发现活动群聊 →
   程序化选择（环境变量匹配 → 唯一候选 → 第一个）→ 走既有三阶段 join
   （discover → claim → ready），无任何对话框；
3. join 后与交互式角色完全一致：身份行注入、`tavern_speak` / `tavern_whoami`
   可用、群聊输入（通知广播 + 增量拉取、Session 级游标持久化）正常；
4. 群聊输入触发 LLM run 并发言——角色完全通过群聊交互。

## 验收口径（对应 GitHub #29）

- RPC 模式空闲 CPU ≤ 2%
- 自动 join 链路完整：creator 在线列表可见、身份行注入、whoami 一致
- 群聊输入可用：creator 发言 → headless 角色收到 → 可调用 tavern_speak 回复
- M6 既有验收不破坏（RPC 模式本就是验收套件底座）

## TUI 保留 + 降载（可选启动选项）

当前脚本不提供 TUI 降载选项。后续如需保留 TUI 界面，可评估 `tui-lite`（env 覆盖，仅对 kitty 系终端 `TERM_PROGRAM=kitty/ghostty/wezterm/warp` 有通用防护价值）；tmux 包装为低优先候选。CPU 判别口径：空闲基线 ≈0.1% 达标；活跃并发负载（LLM/工具）下 CPU 高是正常现象，非缺陷；活跃态降载方向 = 并发 run 节流（扩展侧策略），与渲染无关。

## 已知边界

- reload 语义：RPC 模式无 TUI 命令入口，headless 角色不执行 `/reload`；
  `session_start` 的 reload 分支跳过自动 join（连接与身份已在 handoff 中保留）；
- 无终端交互：角色不可接收自由输入（群聊即全部输入源）；
- 多个 headless 角色启动时，`PITAVERN_GROUP_CHAT` 建议显式指定，避免群聊歧义。
