/**
 * PiTavern 字符串常量域（#109：字符串常量集中管理）。
 * 与 constants.ts（数值常量）分离，单一职责。
 * 分组导出：
 * - ERROR_*：协议错误 / 业务拒绝消息（A 类）
 * - UI_* / TOOL_*：用户可见文案——工具 label/description、命令 description/提示、UI 文本（B 类）
 * 红线：不进协议 schema 字面量（E 类）、环境注入模板格式串（C 类，留消费端）、测试断言串、用户消息 content。
 * F 类（协议判别常量）挂 #119 M1 后抽取（type→method 重写后同源引用）。
 */

// ─── A 类：错误 / 业务消息 ────────────────────────────────────────────────

/** 成员资格校验失败（sendFailure 通用文案；query/leave 同源）。 */
export const ERROR_NOT_IN_GROUP_CHAT = "Character is not in the group chat";
/** 成员资格校验失败（speak/board 同源）。 */
export const ERROR_NOT_GROUP_MEMBER = "Character is not a group member";
/** 已在群聊中（join/ready 同源）。 */
export const ERROR_ALREADY_IN_GROUP_CHAT = "This pi session is already in the group chat";
/** 已在群聊中（controller 绑定校验）。 */
export const ERROR_ALREADY_BOUND_TO_GROUP_CHAT = "This pi session is already bound to a group chat; leave it first";
/** 不在加入流程中（controller 状态校验）。 */
export const ERROR_NOT_JOINING_GROUP_CHAT = "This pi session is not joining a group chat";
/** character_ready 预留失效。 */
export const ERROR_RESERVATION_INVALID = "Character reservation is no longer valid";
/** claim_character 角色已被占用。 */
export const ERROR_CHARACTER_UNAVAILABLE = "Character is no longer available";
/** 群聊尚无聊天历史文件。 */
export const ERROR_NO_CHAT_HISTORY_FILE = "Group chat has no chat history file yet";
/** speak 消息超过 64 KiB 上限。 */
export const ERROR_MESSAGE_TOO_LARGE = "Message exceeds 64 KiB";
/** User Persona 消息超过 64 KiB 上限（character-runtime 侧）。 */
export const ERROR_USER_PERSONA_MESSAGE_TOO_LARGE = "User Persona message exceeds 64 KiB";
/** 当前无讨论轮次（speak 拒绝）。 */
export const ERROR_NO_ACTIVE_ROUND = "No active round";
/** board_write note.id 为空（协议级拒绝）。 */
export const ERROR_NOTE_ID_EMPTY = "note.id must not be empty";
/** 校验后的 remove 请求缺 note.id（内部断言）。 */
export const ERROR_REMOVE_MISSING_NOTE_ID = "validated remove request is missing note.id";
/** session 文件未设置。 */
export const ERROR_SESSION_FILE_NOT_SET = "Session file not set";
/** 活动群聊描述符不再归本实例所有。 */
export const ERROR_ACTIVE_DESCRIPTOR_NOT_OWNED = "Active group chat descriptor is no longer owned by this instance";
/** 群聊持久化损坏，后续写入被阻断。 */
export const ERROR_PERSISTENCE_BROKEN = "Group chat persistence is broken — further writes are blocked";
/** 群聊会话文件缺 id 头。 */
export const ERROR_SESSION_FILE_NO_ID_HEADER = "Group chat session file has no id header";
/** 未知错误兜底文案。 */
export const ERROR_UNKNOWN = "Unknown error";
/** 群聊已关闭（close reason / 状态文案）。 */
export const ERROR_GROUP_CHAT_CLOSED = "Group chat closed";
/** 已离开群聊（close reason / 状态文案）。 */
export const ERROR_LEFT_GROUP_CHAT = "Left group chat";
/** 不支持二进制帧（close reason）。 */
export const ERROR_BINARY_FRAMES_NOT_SUPPORTED = "Binary frames are not supported";
/** 协议错误（close reason）。 */
export const ERROR_PROTOCOL = "Protocol error";
/** 当前项目无活动群聊（命令提示）。 */
export const ERROR_NO_ACTIVE_GROUP_CHAT = "No active group chat";
/** 当前项目无活动群聊（命令提示，带项目限定）。 */
export const ERROR_NO_ACTIVE_GROUP_CHAT_FOR_PROJECT = "No active group chat found for this project";
/** 组合根契约违反：listGroupChatSessions 未注入。 */
export const ERROR_INJECTION_LIST_SESSIONS = "listGroupChatSessions 未注入（组合根契约违反）";
/** 组合根契约违反：deleteGroupChatSession 未注入。 */
export const ERROR_INJECTION_DELETE_SESSION = "deleteGroupChatSession 未注入（组合根契约违反）";
/** 组合根契约违反：discoverGroupChats 未注入。 */
export const ERROR_INJECTION_DISCOVER = "discoverGroupChats 未注入（组合根契约违反）";
/** reload 期间角色连接关闭。 */
export const ERROR_CONNECTION_CLOSED_DURING_RELOAD = "Character connection closed during reload";
/** character_ready 超时。 */
export const ERROR_READY_TIMEOUT = "Character ready timeout";
/** 仅群聊创建者可用（命令权限）。 */
export const ERROR_CREATOR_ONLY = "This command is only available to the group chat creator";
/** CharacterRuntime 已激活或已释放（重复激活断言）。 */
export const ERROR_RUNTIME_ALREADY_ACTIVATED_OR_DISPOSED = "CharacterRuntime has already been activated or disposed";
/** CreatorRuntime 未激活。 */
export const ERROR_CREATOR_RUNTIME_NOT_ACTIVE = "CreatorRuntime is not active";
/** CreatorRuntime 已移交 reload 不可关闭。 */
export const ERROR_CREATOR_RUNTIME_DETACHED = "CreatorRuntime has been detached for reload and cannot be closed";
/** CharacterRuntime 未激活。 */
export const ERROR_CHARACTER_RUNTIME_NOT_ACTIVE = "CharacterRuntime is not active";
/** CharacterRuntime 已移交 reload 不可关闭。 */
export const ERROR_CHARACTER_RUNTIME_DETACHED = "CharacterRuntime has been detached for reload and cannot be closed";
/** /tavern-resume 需要交互 UI。 */
export const ERROR_RESUME_REQUIRES_UI = "/tavern-resume requires an interactive UI";
/** /tavern-join 需要交互 UI。 */
export const ERROR_JOIN_REQUIRES_UI = "/tavern-join requires an interactive UI";
/** 帧超过 1 MiB 上限（character-runtime 侧）。 */
export const ERROR_FRAME_TOO_LARGE = "PiTavern frame exceeds 1 MiB";
/** WebSocket 帧超过 1 MiB 上限（codec 侧）。 */
export const ERROR_WS_FRAME_TOO_LARGE = "PiTavern WebSocket frame exceeds 1 MiB";
/** 连接未打开。 */
export const ERROR_CONNECTION_NOT_OPEN = "PiTavern connection is not open";
/** maxMessages 非法（配置校验）。 */
export const ERROR_MAX_MESSAGES_INVALID = "maxMessages must be a non-negative safe integer";
/** JoinAttempt 连接已移交或已关闭。 */
export const ERROR_JOIN_ATTEMPT_TRANSFERRED = "JoinAttempt connection has already transferred or closed";
/** autoJoinCharacter 组合根注入契约违反。 */
export const ERROR_INJECTION_AUTO_JOIN_DISCOVER =
	"autoJoinCharacter: discoverGroupChats must be injected by the composition root";

/** 意外 join 响应（客户端断言）。 */
export const ERROR_UNEXPECTED_JOIN_RESPONSE = "Unexpected PiTavern join response";
/** 意外 state 响应（客户端断言）。 */
export const ERROR_UNEXPECTED_STATE_RESPONSE = "Unexpected PiTavern state response";
/** 意外 speak 响应（客户端断言）。 */
export const ERROR_UNEXPECTED_SPEAK_RESPONSE = "Unexpected PiTavern speak response";
/** 意外 history 响应（客户端断言）。 */
export const ERROR_UNEXPECTED_HISTORY_RESPONSE = "Unexpected PiTavern history response";
/** 意外 fetch_messages_since 响应（客户端断言）。 */
export const ERROR_UNEXPECTED_FETCH_RESPONSE = "Unexpected PiTavern fetch_messages_since response";
/** 意外 character_ready 响应（客户端断言）。 */
export const ERROR_UNEXPECTED_READY_RESPONSE = "Unexpected PiTavern Character ready response";
/** 意外 claim_character 响应（客户端断言）。 */
export const ERROR_UNEXPECTED_CLAIM_RESPONSE = "Unexpected PiTavern Character claim response";
/** 意外 board_write 响应（客户端断言）。 */
export const ERROR_UNEXPECTED_BOARD_WRITE_RESPONSE = "Unexpected PiTavern board_write response";
/** 意外 board_query 响应（客户端断言）。 */
export const ERROR_UNEXPECTED_BOARD_QUERY_RESPONSE = "Unexpected PiTavern board_query response";

/** 连接已关闭（character-runtime 侧断开）。 */
export const ERROR_CONNECTION_CLOSED = "PiTavern connection closed";
/** 连接已被关闭（character-runtime 侧断开，完成时态）。 */
export const ERROR_CONNECTION_HAS_BEEN_CLOSED = "PiTavern connection has been closed";

/** 客户端消息无效（codec 协议错误）。 */
export const ERROR_INVALID_CLIENT_MESSAGE = "Invalid PiTavern client message";
/** 服务端消息无效（codec 协议错误）。 */
export const ERROR_INVALID_SERVER_MESSAGE = "Invalid PiTavern server message";
/** 编码失败（codec 协议错误）。 */
export const ERROR_ENCODE_FAILED = "Failed to encode PiTavern message";
/** JSON 解析失败（codec 协议错误）。 */
export const ERROR_PARSE_JSON_FAILED = "Failed to parse PiTavern JSON";
/** 收到二进制帧（客户端拒绝）。 */
export const ERROR_BINARY_FRAME_RECEIVED = "Binary PiTavern frame received";
/** 角色刷新超时。 */
export const ERROR_CHARACTER_REFRESH_TIMED_OUT = "PiTavern character refresh timed out";
/** 心跳超时。 */
export const ERROR_HEARTBEAT_TIMEOUT = "PiTavern heartbeat timeout";
/** 请求超时。 */
export const ERROR_REQUEST_TIMED_OUT = "PiTavern request timed out";
/** 连接群聊失败。 */
export const ERROR_CONNECT_FAILED = "Failed to connect to PiTavern group chat";
/** join 尝试已关闭。 */
export const ERROR_JOIN_ATTEMPT_CLOSED = "PiTavern join attempt closed";
/** join 连接已关闭。 */
export const ERROR_JOIN_CONNECTION_CLOSED = "PiTavern join connection closed";
/** join 连接未打开。 */
export const ERROR_JOIN_CONNECTION_NOT_OPEN = "PiTavern join connection is not open";
/** 连接超时（join-attempt 侧）。 */
export const ERROR_CONNECTION_TIMED_OUT = "PiTavern connection timed out";
/** 意外 leave 响应（客户端断言）。 */
export const ERROR_UNEXPECTED_LEAVE_RESPONSE = "Unexpected PiTavern leave response";

// ─── A 类：动态消息模板（前缀 / 格式串；参数拼接保留在消费端）─────────────

/** persist 失败前缀（speak 动态拼接）。 */
export const ERROR_PERSIST_FAILED_PREFIX = "Failed to persist message: ";
/** TUI 投影失败前缀（index/submit 动态拼接）。 */
export const ERROR_TUI_PROJECTION_FAILED_PREFIX = "TUI projection failed: ";
/** 配置无效前缀（config 读取校验）。 */
export const ERROR_INVALID_CONFIG_PREFIX = "Invalid PiTavern config: ";
/** 会话文件不存在或为空（含路径参数）。 */
export const ERROR_SESSION_FILE_MISSING_PREFIX = "Group chat session file does not exist or is empty: ";
/** 群聊已活动（resume 前置校验，含 id 参数——前缀）。 */
export const ERROR_GROUP_CHAT_ALREADY_ACTIVE_PREFIX = "Group chat ";
/** 群聊已活动后缀。 */
export const ERROR_GROUP_CHAT_ALREADY_ACTIVE_SUFFIX = " is already active; leave the active group chat before resuming";
/** 配置读取失败前缀。 */
export const ERROR_READ_CONFIG_PREFIX = "Failed to read PiTavern config: ";
/** 角色 Markdown 读取失败前缀。 */
export const ERROR_READ_CHARACTER_MD_PREFIX = "Failed to read Character Markdown: ";
/** 角色目录读取失败前缀。 */
export const ERROR_READ_CHARACTER_DIR_PREFIX = "Failed to read Character directory: ";
/** 配置解析失败前缀。 */
export const ERROR_PARSE_CONFIG_PREFIX = "Failed to parse PiTavern config: ";
/** 角色 Markdown 解析失败前缀。 */
export const ERROR_PARSE_CHARACTER_MD_PREFIX = "Failed to parse Character Markdown: ";
/** 活动群聊发现失败前缀。 */
export const ERROR_DISCOVER_ACTIVE_PREFIX = "Failed to discover active PiTavern group chats: ";
/** 角色导入访问失败前缀。 */
export const ERROR_ACCESS_CHARACTER_IMPORT_PREFIX = "Failed to access Character import: ";
/** 角色名重复（含路径参数）。 */
export const ERROR_DUPLICATE_CHARACTER_NAME_PREFIX = 'Duplicate Character name "'; // 与后缀 ERROR_DUPLICATE_SUFFIX 拼接
/** 角色 ID 重复（含路径参数）。 */
export const ERROR_DUPLICATE_CHARACTER_ID_PREFIX = 'Duplicate Character ID "';
/** 重复错误后缀（in ... and ...）。 */
export const ERROR_DUPLICATE_SUFFIX = '" in ';
/** 重复错误尾部（两个路径）。 */
export const ERROR_DUPLICATE_AND = " and ";
/** claim 后角色与公开摘要不一致（含路径参数）。 */
export const ERROR_CLAIMED_SUMMARY_MISMATCH_PREFIX = "Claimed Character no longer matches its public summary: ";
/** 角色 Markdown 缺必填字段（含路径与字段名）。 */
export const ERROR_MD_MISSING_FIELD_PREFIX = "Character Markdown "; // 与 ERROR_MD_MISSING_FIELD_SUFFIX 拼接
export const ERROR_MD_MISSING_FIELD_SUFFIX = ' requires a non-empty "';
export const ERROR_MD_MISSING_FIELD_FIELD_SUFFIX = '" field';
/** 角色导入不是文件或目录。 */
export const ERROR_IMPORT_NOT_FILE_OR_DIR_PREFIX = "Character import is not a file or directory: ";
/** 角色文件必须使用 .md 扩展名。 */
export const ERROR_MD_EXTENSION_PREFIX = "Character file must use the .md extension: ";

// ─── A 类：协议业务错误码（#119 M1，JSON-RPC error.code 10 码枚举）──────
// 取值 = -32100 起，避开 JSON-RPC 标准码（-32700~-32000）与 vscode-jsonrpc 已用码
// （-32001/-32002/-32098/-32099/-32800 系列）；code→message 映射表 = 单一数据源。
// 未知 code 由 codec schema 收窄 fail-close（#119 M1 定案：code 必须 ∈ 10 码枚举）。

/** 成员资格校验失败（query/leave/speak/board 业务拒绝）。 */
export const ERROR_CODE_NOT_IN_GROUP = -32100;
/** 已在群聊中（join/ready/controller 绑定校验）。 */
export const ERROR_CODE_ALREADY_IN_GROUP = -32101;
/** character_ready 预留失效。 */
export const ERROR_CODE_RESERVATION_INVALID = -32102;
/** claim_character 角色已被占用。 */
export const ERROR_CODE_CHARACTER_UNAVAILABLE = -32103;
/** 群聊尚无聊天历史文件。 */
export const ERROR_CODE_NO_CHAT_HISTORY = -32104;
/** speak 消息超过 64 KiB 上限。 */
export const ERROR_CODE_MESSAGE_TOO_LARGE = -32105;
/** 当前无讨论轮次（speak 拒绝）。 */
export const ERROR_CODE_NO_ACTIVE_ROUND = -32106;
/** board_write note.id 为空（协议级拒绝）。 */
export const ERROR_CODE_INVALID_NOTE_ID = -32107;
/** 未知错误兜底。 */
export const ERROR_CODE_INTERNAL_ERROR = -32108;
/** 消息持久化失败。 */
export const ERROR_CODE_PERSIST_FAILED = -32109;

/** 10 码业务枚举（codec schema 收窄用：未知 code fail-close）。 */
export const PROTOCOL_ERROR_CODES = [
	ERROR_CODE_NOT_IN_GROUP,
	ERROR_CODE_ALREADY_IN_GROUP,
	ERROR_CODE_RESERVATION_INVALID,
	ERROR_CODE_CHARACTER_UNAVAILABLE,
	ERROR_CODE_NO_CHAT_HISTORY,
	ERROR_CODE_MESSAGE_TOO_LARGE,
	ERROR_CODE_NO_ACTIVE_ROUND,
	ERROR_CODE_INVALID_NOTE_ID,
	ERROR_CODE_INTERNAL_ERROR,
	ERROR_CODE_PERSIST_FAILED,
] as const;

/** 10 码业务错误码类型（sendFailure/error 构造签名用）。 */
export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];

/** code→message 映射表（单一数据源；文案复用 A 类常量，message 原样保留 = 现有
 * failure 断言零语义漂移，#119 comment 5180067418 口径）。 */
export const PROTOCOL_ERROR_CODE_MESSAGES: Readonly<Record<number, string>> = {
	[ERROR_CODE_NOT_IN_GROUP]: ERROR_NOT_IN_GROUP_CHAT,
	[ERROR_CODE_ALREADY_IN_GROUP]: ERROR_ALREADY_IN_GROUP_CHAT,
	[ERROR_CODE_RESERVATION_INVALID]: ERROR_RESERVATION_INVALID,
	[ERROR_CODE_CHARACTER_UNAVAILABLE]: ERROR_CHARACTER_UNAVAILABLE,
	[ERROR_CODE_NO_CHAT_HISTORY]: ERROR_NO_CHAT_HISTORY_FILE,
	[ERROR_CODE_MESSAGE_TOO_LARGE]: ERROR_MESSAGE_TOO_LARGE,
	[ERROR_CODE_NO_ACTIVE_ROUND]: ERROR_NO_ACTIVE_ROUND,
	[ERROR_CODE_INVALID_NOTE_ID]: ERROR_NOTE_ID_EMPTY,
	[ERROR_CODE_INTERNAL_ERROR]: ERROR_UNKNOWN,
	[ERROR_CODE_PERSIST_FAILED]: ERROR_PERSIST_FAILED_PREFIX,
};

// ─── F 类：协议判别常量（#109 欠账消解，M2 同批抽取：method 判别值同源引用）──
// 红线：wire method 判别一律引用本组常量；消费方剩余字面量引用随 M3 接线同步替换。

// 请求/通知 method（客户端→服务端）
/** 加入群聊（三阶段握手第一段）。 */
export const METHOD_JOIN_GROUP_CHAT = "join_group_chat";
/** 领取 Character（三阶段握手第二段）。 */
export const METHOD_CLAIM_CHARACTER = "claim_character";
/** Character 准备完成（三阶段握手第三段）。 */
export const METHOD_CHARACTER_READY = "character_ready";
/** 离开群聊。 */
export const METHOD_LEAVE_GROUP_CHAT = "leave_group_chat";
/** 获取群聊状态。 */
export const METHOD_GET_GROUP_CHAT_STATE = "get_group_chat_state";
/** 获取消息历史（分页）。 */
export const METHOD_GET_MESSAGE_HISTORY = "get_message_history";
/** 增量拉取（游标之后的消息）。 */
export const METHOD_FETCH_MESSAGES_SINCE = "fetch_messages_since";
/** 获取群聊记录文件路径。 */
export const METHOD_GET_CHAT_HISTORY_FILE = "get_chat_history_file";
/** 更新 Character 状态（通知，无响应）。 */
export const METHOD_UPDATE_CHARACTER_STATE = "update_character_state";
/** 白板写入（贴/改/撕/清，action 判别）。 */
export const METHOD_BOARD_WRITE = "board_write";
/** 白板查询（全量）。 */
export const METHOD_BOARD_QUERY = "board_query";
/** 公开发言。 */
export const METHOD_SPEAK = "speak";

// 服务端通知 method（服务端→客户端）
/** Character 加入广播。 */
export const METHOD_CHARACTER_JOINED = "character_joined";
/** Character 离开广播。 */
export const METHOD_CHARACTER_LEFT = "character_left";
/** 群聊关闭广播。 */
export const METHOD_GROUP_CHAT_CLOSED = "group_chat_closed";
/** 公开消息（历史/拉取/广播消息形态）。 */
export const METHOD_PUBLIC_MESSAGE = "public_message";
/** 消息历史（加入推送形态）。 */
export const METHOD_MESSAGE_HISTORY = "message_history";
/** 群聊更新广播（增量拉取唤醒）。 */
export const METHOD_GROUP_CHAT_UPDATE = "group_chat_update";
/** 白板更新广播。 */
export const METHOD_BOARD_UPDATE = "board_update";

// ─── B 类：用户可见文案 ──────────────────────────────────────────────────

/** 白板 reason_code 文案：已达条数上限。 */
export const TOOL_BOARD_REASON_MAX_NOTES = "已达白板条数上限（默认 5 条）——先撕一条再贴";
/** 白板 reason_code 文案：超过单条长度上限。 */
export const TOOL_BOARD_REASON_LENGTH_EXCEEDED = "超过单条长度上限（默认 140 码点）";
/** 白板 reason_code 文案：条不存在。 */
export const TOOL_BOARD_REASON_NOTE_NOT_FOUND = "条不存在（已被撕、非本人条或 id 无效）";
/** 白板 reason_code 文案：白板为空。 */
export const TOOL_BOARD_REASON_BOARD_EMPTY = "白板为空";
/** 白板 reason_code 文案：内容无变化（幂等）。 */
export const TOOL_BOARD_REASON_NOTE_UNCHANGED = "内容无变化（幂等）";
/** 白板操作生效提示。 */
export const TOOL_BOARD_CHANGED = "已生效（白板已更新）";
/** 白板写入记录前缀（含 id 回显，工具返回模板）。 */
export const TOOL_BOARD_RECORDED_PREFIX = "已记录（";
/** 白板无变化前缀（含 reason_code，工具返回模板）。 */
export const TOOL_BOARD_UNCHANGED_PREFIX = "未变化（";
/** 全员白板均为空（查询展示兜底）。 */
export const TOOL_BOARD_ALL_EMPTY = "（全员白板均为空）";
/** tavern_board 参数必须是对象。 */
export const TOOL_BOARD_ARGS_INVALID = "Error: tavern_board 参数必须是对象（action: set|remove|clear|query）";
/** tavern_board action 非法。 */
export const TOOL_BOARD_ACTION_INVALID = "Error: tavern_board action 必须是 set|remove|clear|query 之一";
/** remove 必须携带 note.id。 */
export const TOOL_BOARD_REMOVE_NEEDS_ID = "Error: remove 必须携带 note.id";
/** remove 不得携带 content。 */
export const TOOL_BOARD_REMOVE_NO_CONTENT = "Error: remove 不得携带 content（被撕条内容由服务端广播回带）";
/** note.id 必须是字符串。 */
export const TOOL_BOARD_ID_NOT_STRING = "Error: note.id 必须是字符串";
/** note.content 必须是字符串。 */
export const TOOL_BOARD_CONTENT_NOT_STRING = "Error: note.content 必须是字符串";
/** 白板实时提示行前缀（纯展示）。 */
export const UI_BOARD_PREFIX = "[白板]";
/** UI 状态行：举手前缀。 */
export const UI_HAND_RAISED_PREFIX = "举手：";
/** 白板动作动词：贴条。 */
export const UI_BOARD_VERB_ADD = "贴条";
/** 白板动作动词：改条。 */
export const UI_BOARD_VERB_UPDATE = "改条";
/** 白板动作动词：撕条。 */
export const UI_BOARD_VERB_REMOVE = "撕条";
/** 白板动作动词：清空白板。 */
export const UI_BOARD_VERB_CLEAR = "清空白板";

// ─── B 类：命令描述 ──────────────────────────────────────────────────────

/** tavern-new 命令描述。 */
export const CMD_DESC_NEW = "Create a new PiTavern group chat";
/** tavern-resume 命令描述。 */
export const CMD_DESC_RESUME = "Resume a PiTavern group chat from its history";
/** tavern-join 命令描述。 */
export const CMD_DESC_JOIN = "Join an active PiTavern group chat as a Character";
/** tavern-status 命令描述。 */
export const CMD_DESC_STATUS = "Show the current PiTavern group chat status";
/** tavern-name 命令描述。 */
export const CMD_DESC_NAME = "Set the current group chat name";
/** tavern-set-max 命令描述。 */
export const CMD_DESC_SET_MAX = "Set the maximum Character messages for future rounds";
/** tavern-test-message 命令描述（测试）。 */
export const CMD_DESC_TEST_MESSAGE = "[test] Publish a User Persona message as the creator";
/** tavern-test-reload 命令描述（测试）。 */
export const CMD_DESC_TEST_RELOAD = "[test] Trigger a real pi reload to exercise the handoff";
/** tavern-test-whoami 命令描述（测试）。 */
export const CMD_DESC_TEST_WHOAMI = "[test] Report the registered character identity (ISSUE-007 observation channel)";
/** tavern-test-busy 命令描述（测试，v0.5 abort-interrupt-delivery）。 */
export const CMD_DESC_TEST_BUSY = "[test] Hold the agent busy state for N ms (simulate busy run without LLM)";
/** tavern-test-busy 用法提示（测试）。 */
export const NOTIFY_USAGE_TEST_BUSY = "Usage: /tavern-test-busy <ms>";
/** tavern-leave 命令描述。 */
export const CMD_DESC_LEAVE = "Close or leave the current PiTavern group chat";

// ─── B 类：工具 label 与描述 ─────────────────────────────────────────────

/** tavern_speak 工具 label。 */
export const TOOL_SPEAK_LABEL = "Tavern Speak";
/** tavern_board 工具 label。 */
export const TOOL_BOARD_LABEL = "Tavern Board";
/** tavern_whoami 工具 label。 */
export const TOOL_WHOAMI_LABEL = "Tavern Whoami";

/** tavern_whoami 输出：当前角色前缀。 */
export const TOOL_WHOAMI_ROLE_PREFIX = "当前角色：";
/** tavern_whoami 输出：character_id 前缀。 */
export const TOOL_WHOAMI_ID_PREFIX = "character_id：";
/** tavern_whoami 输出：描述前缀。 */
export const TOOL_WHOAMI_DESC_PREFIX = "描述：";
/** 未以 Character 身份加入群聊（工具错误提示）。 */
export const TOOL_NOT_JOINED_AS_CHARACTER = "Error: You are not currently joined to a group chat as a Character.";

// ─── B 类：命令提示（notify 用户文案）─────────────────────────────────────

/** 无可恢复群聊（tavern-resume 提示）。 */
export const NOTIFY_NO_RESUMABLE_GROUP_CHAT = "No resumable group chat found for this project";
/** 群聊中无可用角色（tavern-join 提示）。 */
export const NOTIFY_NO_CHARACTER_AVAILABLE = "No Character is currently available in this group chat";
/** /tavern-name 用法提示。 */
export const NOTIFY_USAGE_NAME = "Usage: /tavern-name <name>";
/** /tavern-set-max 用法提示。 */
export const NOTIFY_USAGE_SET_MAX = "Usage: /tavern-set-max <non-negative integer>";
/** 最大消息数非法提示。 */
export const NOTIFY_MAX_MESSAGES_INVALID = "Maximum messages must be a non-negative safe integer";
/** 仅创建者可发 User Persona 消息。 */
export const NOTIFY_CREATOR_ONLY_MESSAGE = "Only the group chat creator can send User Persona messages";
/** User Persona 消息已发布。 */
export const NOTIFY_MESSAGE_PUBLISHED = "User Persona message published";
/** 不在 Character 状态。 */
export const NOTIFY_NOT_IN_CHARACTER_STATE = "Not in character state";

/** speak 发送失败前缀（工具返回）。 */
export const ERROR_SEND_FAILED_PREFIX = "Failed to send message: ";
/** 白板访问失败前缀（工具返回）。 */
export const ERROR_ACCESS_BOARD_FAILED_PREFIX = "Failed to access the board: ";
/** 删除群聊历史失败前缀（命令提示）。 */
export const ERROR_DELETE_HISTORY_FAILED_PREFIX = "Failed to delete group chat history: ";
/** 群聊名已设置提示前缀（命令提示）。 */
export const NOTIFY_NAME_SET_PREFIX = "Group chat name set to ";
/** 群聊标签前缀（状态展示）。 */
export const UI_GROUP_CHAT_LABEL_PREFIX = "Group chat: ";

// ─── B 类：headless auto-join 提示 ───────────────────────────────────────

/** headless auto-join：无活动群聊。 */
export const HEADLESS_NO_ACTIVE_GROUP_CHAT = "Auto-join: no active group chat found for this project";
/** headless auto-join：无群聊候选。 */
export const HEADLESS_NO_GROUP_CHAT_CANDIDATE = "Auto-join: no group chat candidate";
/** headless auto-join：加入失败。 */
export const HEADLESS_JOIN_ATTEMPT_FAILED = "Auto-join: join attempt failed";
/** headless auto-join：群聊中无可用角色。 */
export const HEADLESS_NO_CHARACTER_AVAILABLE = "Auto-join: no Character is available in this group chat";
/** headless auto-join：无角色候选。 */

/** headless auto-join 跳过前缀（含状态）。 */
export const HEADLESS_SKIPPED_PREFIX = "Auto-join skipped: PiTavern is ";
/** headless auto-join 成功前缀。 */
export const HEADLESS_JOINED_PREFIX = "Auto-joined ";
/** headless auto-join 成功中缀（角色名分隔）。 */
export const HEADLESS_JOINED_MID = " as ";
/** headless auto-join 失败前缀。 */
export const HEADLESS_FAILED_PREFIX = "Auto-join failed: ";

export const HEADLESS_NO_CHARACTER_CANDIDATE = "Auto-join: no character candidate";

// ─── B 类：工具 description ──────────────────────────────────────────────

/** tavern_speak 工具描述。 */
export const TOOL_SPEAK_DESCRIPTION =
	"Publish a message to the PiTavern group chat. " +
	"Only available when joined as a Character. " +
	"Keep messages concise (under 2000 characters). " +
	"Long analysis should stay in the private session.";
/** tavern_board 工具描述。 */
export const TOOL_BOARD_DESCRIPTION =
	"Access the PiTavern whiteboard (per-character notes, visible to the whole group). " +
	"Only available when joined as a Character. " +
	"Actions: set (post a new note, or edit an existing one by id), remove (tear off a note by id), " +
	"clear (empty your own board), query (read all boards). " +
	"Each character has their own board (max 5 notes, 140 code points each by default); " +
	"you can only modify your own board. Keep note content concise (under 140 characters).";
/** tavern_whoami 工具描述。 */
export const TOOL_WHOAMI_DESCRIPTION =
	"Report this session's registered Character identity in the PiTavern group chat. " +
	"Only available when joined as a Character. " +
	"Returns the same single source of truth (runtime.character) used for identity lines.";

// ─── B 类：命令交互文案（select/confirm/notify）──────────────────────────

/** select：选择要恢复的群聊。 */
export const SELECT_RESUME_LABEL = "Resume group chat:";
/** select：选择群聊。 */
export const SELECT_CHOOSE_GROUP_CHAT = "Choose a group chat";
/** select：选择要删除的群聊历史。 */
export const SELECT_DELETE_HISTORY_LABEL = "Delete group chat history:";

/** select：删除群聊历史选项（省略号变体）。 */
export const SELECT_DELETE_HISTORY_CHOICE = "Delete a group chat history…";
/** confirm：删除群聊历史标题。 */
export const CONFIRM_DELETE_HISTORY_TITLE = "Delete group chat history?";
/** confirm：删除群聊历史正文前缀（不可撤销）。 */
export const CONFIRM_DELETE_HISTORY_BODY_PREFIX = "This cannot be undone: ";
/** select：选择角色。 */
export const SELECT_CHOOSE_CHARACTER = "Choose a Character";
/** notify：群聊创建成功前缀。 */
export const NOTIFY_CREATED_PREFIX = "Created group chat ";
/** notify：群聊创建/恢复成功中缀（地址分隔）。 */
export const NOTIFY_CREATED_MID = " at ";
/** notify：群聊恢复成功前缀。 */
export const NOTIFY_RESUMED_PREFIX = "Resumed group chat ";
/** notify：已加入群聊前缀。 */
export const NOTIFY_JOINED_PREFIX = "Joined ";
/** notify：已加入群聊中缀（角色名分隔）。 */
export const NOTIFY_JOINED_AS = " as ";
/** notify：正在加入群聊前缀。 */
export const NOTIFY_JOINING_PREFIX = "Joining group chat; ";
/** notify：正在加入群聊后缀（角色数）。 */
export const NOTIFY_JOINING_SUFFIX = " Characters available";
/** notify：最大消息数已设置前缀。 */
export const NOTIFY_MAX_SET_PREFIX = "Group max messages set to ";
/** notify：历史已删除前缀。 */
export const NOTIFY_DELETED_PREFIX = "Deleted group chat history (";
/** notify：历史已删除后缀。 */
export const NOTIFY_DELETED_SUFFIX = ")";
/** notify：历史已删但白板删除失败前缀。 */
export const NOTIFY_DELETED_BOARD_FAIL_PREFIX = "Deleted group chat history, but failed to delete its board: ";
/** 未命名群聊（select 标签兜底）。 */
export const UI_UNNAMED_GROUP_CHAT = "Unnamed group chat";
/** 状态展示：ID 标签。 */
export const UI_ID_LABEL = "ID: ";
/** 状态展示：轮次未开始。 */
export const UI_ROUND_NOT_STARTED = "not started";
/** 状态展示：已用消息数单位。 */
export const UI_MESSAGES_USED = "messages used";

// ─── B 类：UI 状态模板 ──────────────────────────────────────────────────

/** 状态标题前缀（角色名）。 */
export const UI_CHARACTER_TITLE_PREFIX = "Tavern Character · ";

/** 状态标题：Tavern Creator（含群聊名变体前缀）。 */
export const UI_CREATOR_TITLE_PREFIX = "Tavern Creator · ";
/** 状态标题：Tavern Creator（无群聊名）。 */
export const UI_CREATOR_TITLE = "Tavern Creator";
/** 状态标题中缀（群聊名分隔）。 */
export const UI_CHARACTER_TITLE_MID = " · ";
/** 在线人数后缀。 */
export const UI_ONLINE_COUNT_SUFFIX = " 人在线";
/** 发言计数前缀。 */
export const UI_SPEECH_COUNT_PREFIX = "发言 ";
/** 发言计数中缀（剩余分隔）。 */
export const UI_SPEECH_COUNT_MID = " · 剩余 ";

// ─── A 类：session-store 持久化恢复 ──────────────────────────────────────

/** 回滚删除半初始化会话文件失败。 */
export const ERROR_ROLLBACK_DELETE_FAILED = "Failed to delete half-initialized session file during rollback. ";
/** 持久化已阻断（防重复会话）。 */
export const ERROR_PERSISTENCE_BLOCKED = "Persistence is now blocked to prevent duplicate sessions.";
/** 持久化恢复失败前缀。 */
export const ERROR_RECOVERY_FAILED_PREFIX = "Persistence recovery failed: ";
/** 原始错误前缀。 */
export const ERROR_ORIGINAL_ERROR_PREFIX = "Original error: ";
/** 正在加入群聊（UI 状态）。 */
export const UI_JOINING_GROUP_CHAT = "正在加入群聊…";
/** 成员数未知（UI 状态）。 */
export const UI_MEMBER_COUNT_UNKNOWN = "成员数未知";
/** 退出群聊确认标题。 */
export const UI_CONFIRM_LEAVE_TITLE = "退出群聊？";
/** 退出群聊确认正文（含不自动恢复说明）。 */
export const UI_CONFIRM_LEAVE_BODY =
	"PiTavern 当前已加入群聊。继续将先退出群聊，之后即使本次操作失败或取消也不会自动恢复。";
