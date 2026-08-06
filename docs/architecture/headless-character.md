# Headless Character 模式（ISSUE-014，CPU 根治）

## 背景

真实终端下，pi 平台 TUI 渲染管线（60fps 全量 diff + 逐行 Kitty 图像检测 + box 渲染）
使每个空闲 Character 进程占用 35-42% CPU（实测，2026-08-01）。RPC 模式（无 TUI）
实测 ~1%。Character 本质是自主 agent——群聊输入即全部交互，不需要终端界面。

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
   可用、群聊输入（推送+拉取混合、游标持久化）正常；
4. 群聊输入触发 LLM run 并发言——角色完全通过群聊交互。

## 验收口径（对应 GitHub #29）

- 空闲 CPU ≤ 2%（对照 TUI 模式 35-42%）
- 自动 join 链路完整：creator 在线列表可见、身份行注入、whoami 一致
- 群聊输入可用：creator 发言 → headless 角色收到 → 可调用 tavern_speak 回复
- M6 既有验收不破坏（RPC 模式本就是验收套件底座）

## 已知边界

- reload 语义：RPC 模式无 TUI 命令入口，headless 角色不执行 `/reload`；
  `session_start` 的 reload 分支跳过自动 join（连接与身份已在 handoff 中保留）；
- 无终端交互：角色不可接收自由输入（群聊即全部输入源）；
- 多个 headless 角色启动时，`PITAVERN_GROUP_CHAT` 建议显式指定，避免群聊歧义。
