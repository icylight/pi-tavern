// node RAL 初始化（vscode-jsonrpc common 入口默认不装 RAL；connection 内部
// timer/immediate 依赖它。副作用 import，需在 connection 使用前加载）。
import "vscode-jsonrpc/node";
import { AbstractMessageReader, AbstractMessageWriter, type DataCallback, type Message } from "vscode-jsonrpc";
import WebSocket from "ws";
import { ERROR_CONNECTION_NOT_OPEN } from "../shared/messages.js";
import { MAX_WEBSOCKET_FRAME_BYTES } from "./codec.js";

/**
 * 单帧 JSON WS → vscode-jsonrpc MessageReader（connection 接线）。
 *
 * 分帧语义：每一条 ws 消息 = 一个完整 JSON-RPC 信封（MAX_WEBSOCKET_FRAME_BYTES
 * 单帧守卫），与 vscode-jsonrpc 内置 StreamMessageReader 的 LSP Content-Length
 * 分帧不匹配，故自写薄适配（无新依赖）。
 *
 * 哑 reader：消息**不**经本 reader 监听——creator 侧由 connection-manager 的
 * handleFrame（codec 校验 + 串行 enqueue + reload 缓冲兼容）接收后手动喂
 * connection.handleMessage；reader 仅提供接口形状 + close 事件（socket 关闭
 * 时由 owner 调用 notifyClose，触发库内 pending 拒绝/连接关闭编排）。
 */
export class WebSocketMessageReader extends AbstractMessageReader {
	private callback: DataCallback | null = null;

	listen(callback: DataCallback): { dispose: () => void } {
		this.callback = callback;
		return {
			dispose: () => {
				this.callback = null;
			},
		};
	}

	/** handleFrame 解码/校验/入队后手动喂入 connection 内部处理链。 */
	deliver(message: Message): void {
		this.callback?.(message);
	}

	/** socket 关闭时由 owner 调用：触发 connection 的 close 编排（pending 拒绝等）。 */
	notifyClose(): void {
		this.fireClose();
	}
}

/** 单帧 JSON WS → vscode-jsonrpc MessageWriter（write = 序列化 + ws.send）。 */
export class WebSocketMessageWriter extends AbstractMessageWriter {
	private readonly socket: WebSocket;
	private onRequestWritten: ((id: string | number, method: string) => void) | undefined;

	constructor(socket: WebSocket) {
		super();
		this.socket = socket;
	}

	/** 请求 id → method 登记回调（feed 前形状校验用）。可重设：connection
	 * 跨 handoff 延续时，writer 归属新 owner（JoinAttempt → CharacterRuntime
	 * → reload 后新 runtime），回调须指向当前 owner 的关联表。 */
	setRequestWrittenHandler(handler: ((id: string | number, method: string) => void) | undefined): void {
		this.onRequestWritten = handler;
	}

	write(message: Message): Promise<void> {
		// character 侧请求登记（id → method 精确关联：feed 前形状校验用）。
		if (this.onRequestWritten && "method" in message && "id" in message) {
			this.onRequestWritten(message.id as string | number, message.method as string);
		}
		if (this.socket.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error(ERROR_CONNECTION_NOT_OPEN));
		}
		try {
			const encoded = JSON.stringify(message);
			if (Buffer.byteLength(encoded, "utf8") > MAX_WEBSOCKET_FRAME_BYTES) {
				return Promise.reject(new Error(`frame too large (${Buffer.byteLength(encoded, "utf8")} bytes)`));
			}
			this.socket.send(encoded);
			return Promise.resolve();
		} catch (error) {
			return Promise.reject(error instanceof Error ? error : new Error(String(error)));
		}
	}

	end(): void {
		// 单帧语义：无半帧缓冲需要冲刷；连接关闭由 owner 管理。
	}
}
