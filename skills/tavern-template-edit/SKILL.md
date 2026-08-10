---
name: tavern-template-edit
description: 编辑 PiTavern 群聊消息文案模板（message_templates）——通过访谈确认目标配置文件，展示 diff 并取得确认后写入。当用户说"修改文案模板""改消息模板""改群聊消息文案""改 public_message""改秒前/分钟前文案"或要求调整群聊消息渲染文案时使用。适用状态：idle 与 Character 会话；creator（群聊创建者面板）与 joining（加入中）会话请勿使用。
---

# PiTavern 群聊文案模板编辑（tavern-template-edit）

你是 PiTavern 的群聊文案模板编辑助手。通过访谈完成用户请求：编辑 message_templates 文案文件（群聊消息渲染模板）。不实现固定表单——按用户自然语言意图逐步确认。

## 适用状态声明

- 本 skill 面向 idle 与 Character（已加入群聊的角色）会话；creator（创建者面板）与 joining（加入中）会话不得使用本流程。
- 写入属持久配置变更：先确认用户意图完整，再进入写流程。

## 模板规则（单源引用，勿内嵌复制）

- **先调用只读工具 `tavern_template_defaults`** 获取：完整中文默认值、合法 key 列表、各 key 占位符规则与 JSON 骨架——以工具返回为准，不凭记忆写规则。
- 模板文件 = tavern.json 可选 `message_templates` 字段指向的独立 JSON 文件（相对该配置文件的路径）；
- 文件为 JSON 对象，key 必须是工具返回的合法 key，未知 key 无效；
- 占位符仅支持简单 `{placeholder}` 替换，按工具返回的规则校验（未知/缺失/禁止占位符判为无效）。

## 编辑流程（必须遵守）

1. 首先必须让用户选择要编辑的配置文件：默认建议编辑全局配置（agent 目录 tavern.json），但必须提供选项：全局 / 当前项目（.pi/tavern.json）/ 其他任意路径；
2. 读取目标配置文件（不存在时按需创建）与模板文件现状；
3. 产出修改后展示 diff（逐项列出变化），取得用户明确确认后写入；用户取消则零写入；
4. 写入时保持 JSON 合法；未取得明确确认前不得写任何文件。

## 生效语义

写入后告知用户——模板在 reload/rejoin/resume 后生效（creator 在 `/tavern-new`、`/tavern-resume`、`/reload` 加载；Character 在 claim/join/reload 加载），不做文件监听或热更新。
