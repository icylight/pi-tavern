/**
 * PiTavern 通用常量。
 * 除心跳等独立配置外，所有短期协调操作使用统一超时。
 * 首版不提供配置项。
 */

/** 通用短期协调超时（毫秒）。适用场景：WebSocket request/response、claim→ready、reload 接管等待。 */
export const SHORT_COORDINATION_TIMEOUT_MS = 5_000;

/** WebSocket 心跳 ping 发送间隔（毫秒），独立于通用协调超时。 */
export const HEARTBEAT_PING_INTERVAL_MS = 30_000;

/** 心跳失效阈值（毫秒）：超时后统一执行 disconnected 清理，不自动重连。 */
export const HEARTBEAT_TIMEOUT_MS = 120_000;

/** #83：角色清单懒刷新的竞速超时——join/claim/query 热路径不被挂起重扫阻塞（QA 红绿钉死）。 */
export const CHARACTER_REFRESH_TIMEOUT_MS = 1_000;

/**
 * join/ready 时推送的最近公开消息条数（User 2026-08-01 指示：默认 10 → 100）。
 * 仅限 join 推送窗口；增量分页粒度（get_message_history 每页）保持 10。
 */
export const JOIN_HISTORY_LIMIT = 100;

/** #107：每角色每轮 tavern_decision_declare 成功声明上限（成功才计次，失败不消耗）。 */
export const DECLARE_PER_ROUND_LIMIT = 3;

/** #107：环境文本「当前有效裁决」节注入的活跃提案显示上限（超限截断 + 「+M 更早」标注）。 */
export const DECISION_INJECTION_LIMIT = 5;

/**
 * #107（G2，审查②）：活跃提案（非 superseded）总上限——防超大快照
 * 毒死群聊连接（1 MiB 出站帧预算 / 64 KiB content ≈ 16；决策场景足够）。
 */
export const DECISION_ACTIVE_LIMIT = 16;

/** #107（G2，审查②）：决策 content 入站限长 + 快照渲染截断上限（64KiB 与出站帧预算同规）。 */
export const DECISION_CONTENT_MAX_LENGTH = 64 * 1024;
