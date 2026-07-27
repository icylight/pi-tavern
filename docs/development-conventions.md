# PiTavern Development Conventions

本文记录 PiTavern 的通用开发约定。具体通信协议及其消息结构由对应的技术设计文档另行定义。

## 自定义 JSON

PiTavern 自己定义的 JSON 对象字段名统一使用 `snake_case`：

```json
{
  "event_id": "evt-42",
  "character_id": "developer",
  "group_chat_id": "group-1"
}
```

用于区分对象类型的字符串值也使用 `snake_case`：

```json
{
  "type": "character_message"
}
```

不得在 PiTavern 自定义 JSON 中混用 `camelCase`、`PascalCase` 或 `kebab-case`：

```json
{
  "eventId": "evt-42",
  "CharacterId": "developer",
  "group-chat-id": "group-1"
}
```

本约定只规定 PiTavern 自定义 JSON 的命名风格，不规定任何具体协议的消息类型、字段或封装结构。

复用上游格式时必须保持上游字段原样，不为满足本约定转换字段名称。例如，pi-coding-agent session JSONL 中的 `parentId`、`customType` 和 `parentSession` 继续使用上游定义的 camelCase。

## 通用短期协调超时

PiTavern 的短期协调操作使用固定的 5 秒通用超时。首版不提供配置项。

当前适用场景：

- `claim_character` 后等待 `character_ready`；
- reload 期间等待新 Extension Runtime 接管 `ReloadHandoff`。

该通用超时不适用于 WebSocket 心跳。心跳仍使用独立确定的 30 秒 ping 间隔和 120 秒失效阈值。
