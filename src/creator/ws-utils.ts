import type WebSocket from "ws";
import { WebSocketServer } from "ws";

import { MAX_WEBSOCKET_FRAME_BYTES } from "../protocol/codec.js";

/** 本地回环 WS 服务器（组合根装配用；PR-B 拆自 CreatorRuntime）。 */
export async function listenOnLocalhost(path: string): Promise<WebSocketServer> {
	const server = new WebSocketServer({
		host: "127.0.0.1",
		port: 0,
		path,
		maxPayload: MAX_WEBSOCKET_FRAME_BYTES,
	});

	try {
		await new Promise<void>((resolveListening, rejectListening) => {
			const onListening = (): void => {
				server.off("error", onError);
				resolveListening();
			};
			const onError = (error: Error): void => {
				server.off("listening", onListening);
				rejectListening(error);
			};

			server.once("listening", onListening);
			server.once("error", onError);
		});
		return server;
	} catch (error) {
		await closeWebSocketServer(server);
		throw error;
	}
}

/** 关闭 WS 服务器（幂等：未监听时直接返回）。 */
export async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
	if (server.address() === null) {
		return;
	}

	await new Promise<void>((resolveClose, rejectClose) => {
		server.close((error) => {
			if (error) {
				rejectClose(error);
			} else {
				resolveClose();
			}
		});
	});
}
