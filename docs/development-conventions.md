# PiTavern Development Conventions

本文记录 PiTavern 的通用开发约定。具体通信协议及其消息结构由对应的技术设计文档另行定义。

## JSON

JSON 对象的字段名统一使用 `snake_case`：

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

不得在 JSON 中混用 `camelCase`、`PascalCase` 或 `kebab-case`：

```json
{
  "eventId": "evt-42",
  "CharacterId": "developer",
  "group-chat-id": "group-1"
}
```

本约定只规定 JSON 的命名风格，不规定任何具体协议的消息类型、字段或封装结构。
