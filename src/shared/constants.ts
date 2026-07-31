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
