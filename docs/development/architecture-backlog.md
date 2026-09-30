# 架构优化待办清单（Architecture Optimization Backlog）

> 属主：Dev。只登记**仍有效待办**，不保存讨论、评审流水或已落地历史；发现即登、随所在分支同批合入。

## 待内嵌

| 优化点 | 建议方案 | 状态 |
| --- | --- | --- |
| TUI 保留场景降载选项 | 评估 `tui-lite` env 覆盖（kitty 系终端）或低优先 tmux 包装；当前脚本未提供 | 待内嵌 |
| character 域单体拆分（character-runtime / group-chat-input 单体） | 按职责拆连接生命周期/请求协调/stale 恢复/消息消费回调；先纯移动后微调，行为零变化 + 红绿锚定 | 待内嵌 |
| broadcast(message: unknown) 签名收窄为 ServerMessage | 签名改 ServerMessage，tsc 捕获 wire 形状漂移；codec 层钉测兜底 | 待内嵌 |
| dispatch 注册表 handler 样板收敛 | handler 工厂函数生成（key + method 断言单点），注册表声明式 | 待内嵌 |
| commands.ts UI 格式化函数下沉 ui/ 域 | 纯移动（formatSessionLabel 等），低风险 | 待内嵌 |
| saveCursor 内存先行 vs 磁盘失败不一致窗口 | 语义幂等可接受，留注释说明窗口语义 | 待内嵌 |
| refreshGroupChatState catch{} 副作用重评注记 | 未来引入副作用时重评；补注释 | 待内嵌 |
| speak 断言宽收窄（W1） | 新增 reason 分支时同步 character 侧断言 | 待内嵌 |
| preview 条目字段级断言不全 | 低优先：对 round/sender/event_id 补字段级断言 | 待内嵌 |
| 去重路径压力测试 | 压力化覆盖交叉去重（message_history 拉取 vs preview） | 待内嵌 |
| writer.onRequestWritten 登记先于 OPEN 检查 | 低风险：改登记顺序或补注释；无数据面危害 | 待内嵌 |
| handler 异常端到端故障注入测试（-32603 路径） | creator 侧故障注入普通 Error → 端到端验证 -32603 收敛（unit 已钉接受性） | 待内嵌 |
| 欢迎语动态化（群名/在线成员/轮次状态入 system_message） | 增强候选：welcome 内容模板化，含群名/成员数/轮次摘要 | 待内嵌 |
| whisper/members 欢迎语引导（#183 连带） | 欢迎语（`src/shared/constants.ts`）只提 speak / board / history，未引导 whisper 与 members；工具描述已可达（#183 已更新），属发现性打磨。改动含 `welcome-message` acceptance 内容断言同步 | 待内嵌 |
| 协议文档生成化（typebox schema → JSON Schema → 文档渲染） | 结构化字段节改生成产物（schema 单一事实源），时序/语义/边界节保留手写 | 待内嵌 |
| group-chat-state.round 字段半死数据 | 评估 ui 展示语义后移除 round 字段或补写入方；低优先 | 待内嵌 |
| whisper 目标解析：服务端三态区分（不存在 / 离线） | #183 客户端解析只能判「在在线名册内 / 不在」——「卡存在但离线」与「无此角色」需服务端全卡清单（`characters` map）才能分。做需改 `-32110` 文案或新增错误码（wire 面：错误码表 + 测试断言）→ 单开 wire 批声明；当前收益有限（错误已附在线清单，两者处置相同） | 待内嵌 |
| whisper 回执可选提示目标离线 | 窄窗口现实概率低，暂不实现；若实现走回执 result 加可选字段（需契约修订） | 待内嵌 |
| docs/api/ 生成物 README.en.md「中文文档」链接指向缺失 README.md | 修 typedoc 生成源/模板，不在文档仓内修（gitignored 生成物） | 待内嵌 |
| 历史注释/不可达分支清理（5 处） | 随下次 src 重构：删 group-chat-input.ts L1173-1185 不可达渲染段；修 commands.ts L234「兼容回退」旧注释、group-chat-input.ts L646「同批」误导注释、streaming-truth.test.ts L151 与 paging-and-speak-order.test.ts L245 join 历史旧注释 | 待内嵌 |
| 失败注入/竞态测试缺口（send 失败断线清理 / 持久化后响应发送失败 / 断开→idle 窗口） | send 同步抛错与回调异步错误的断线清理注入钉测未见（现有 fail-close 测试均为接收坏帧路径）；「持久化后响应发送失败」注入钉测未见；「Runtime 已断开但 Controller 未完成 idle transition」窗口测试未见 | 补齐三类注入/竞态钉测（integration 层）；interactive abort 清空已入队 steer 的处置见 group-chat-input.md「已知边界与残余风险」节（#201 后为重复方向，非区间跳过）；drain 注入已有覆盖（creator-runtime.test.ts） | 待内嵌 |
| join 历史路径未过滤自产 whisper（同源不一致） | #201 已在实时与拉取两路径静默自产 whisper 回帧（发送者零事件），`message_history` 路径（首屏快照 / `pageOlderHistory` 经 `isDeliverableProjection`）仍注入自身 whisper；自身公共回显在该路径已被 `isOwnEcho` 过滤——修法 = 同源过滤 + 该路径断言改他者发信帧（验证面涉 welcome / resume-history 两条既有链，故不并入 #201） | 待内嵌 |
| 游标语义多文档重复（单源化） | 游标/预置水位语义在 6 份文档重复描述（websocket-protocol/persistence/group-chat-input/interaction-model/architecture-backlog/acceptance） | 契约细节以 websocket-protocol/persistence 为单一事实源，其余文档改引用 | 待内嵌 |
| headless auto-join 合成 session id（重入补拉失效） | headless 自愈 join 用 `randomUUID()` 作协议 `session_id` 与游标路径（`src/index.ts:139-147`、`src/headless.ts:129/138`），与真实 pi session id 无关：进程重启永远是新身份，新 Session 语义下不进补拉，`persistence.md` 的「join/重连差分同步」在此路径不可达；协议文档「session_id = 当前 pi session ID」在此仅精神成立。修法 = 取真实 session id（`session_start` 已可拿，`src/index.ts:191`）或显式声明 auto-join 不复用游标并同步文档 | 待内嵌 |
| `startJoining` 丢弃注入窗口参数 | `TavernController.startJoining` 只转发 cursorStorePath/messageTemplates/speakSoftLimitChars/agentDir/cwd，`triggerDebounceMs`/`deliveryWindowMs` 被静默丢弃（`PITAVERN_TRIGGER_DEBOUNCE_MS`/`PITAVERN_DELIVERY_WINDOW_MS` 到不了 character 侧，注入面只对直接构造 runtime 的测试生效）；修法 = 补转发（#215 已补 agentDir/cwd 以修 reload 配置重载） | 待内嵌 |
| #180 reload 交接的时序竞态（被迁移提示的配置加载掩盖） | `session_shutdown` 里 reload 提示的 `await loadTavernConfig` 顺带提供一次事件循环让出；删除或挪到 `session_start` 后，`character-model-hook` 的 reload→leave 恢复基线失败（模型停在 reload 前值）——`TavernController.detachForReload` 的 freeze/snapshot 疑似在 model queue 任务收尾前执行；修法 = controller/queue 内显式等待队列收尾后再快照；收敛后 reload 提示与让出解耦（#215 TUI 走查 A/B 实测） | 待内嵌 |
| 产品改进候选 | ① 决策点聚合 UI：待拍板项在创建者界面汇总；② 验证留痕工具化：V0 一行式做成扩展内命令；③ reload 期间群聊状态展示：热重载接管提示；④ 发言配额预警：群聊输入状态快照带剩余次数（供 agent 省话）；⑤ 分支/PR 关联展示 | 均为产品增强候选，按需评估 | 待内嵌 |
| RPC 启动事件注释核正 | L3 探针与实测（references/pi 钉版本，RPC 模式）：① handler 层——扩展 handler 于 +13ms@factory 收到 session_start，ctx.modelRegistry/ctx.model 可用，「RPC 不触发 session_start」已证伪；② 输出层——AgentSessionEvent 无 session_start，`acceptance.md:88`「RPC 不输出」成立不动；③ headless `PITAVERN_TEST=1` 实测——`[tavern-inject]` 落 RPC notify 事件（stderr 无），headless.test.ts L16/L95「通知通道不可用」已证伪（同源 site 自 2026-08-11 由 board-whiteboard.test.ts:294 指认过时，后批不需重复调研）；④ 待核——streaming-truth.test.ts:163 的论证前提是「agent_start 在 RPC 不触发」，本批只核实了 session_start，agent_start 需实测后定措辞。待核站点：test/acceptance/headless.test.ts L16/L95、streaming-truth.test.ts L163、board-whiteboard.test.ts L294（复核）；index.ts/headless.ts 已随 L3 按实测核正 | 待内嵌 |
