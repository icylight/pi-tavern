# 架构优化待办清单（Architecture Optimization Backlog）

> 属主：Arch。维护纪律（docs/development/workflow.md §7.8）：发现即登、设计方案时扫描内嵌、落地勾销、不单独开 issue。
> 本清单登记**小粒度架构优化点**（非契约变更、非独立交付物、不达 issue 规模）；契约变更/独立交付物/跨里程碑规划仍走正常 issue 流程。

## 登记格式

| 优化点 | 发现背景 | 建议方案 | 状态 |
| --- | --- | --- | --- |
| （一句话） | （何处发现 / 何时） | （方向性建议） | 待内嵌 / 随 <commit/里程碑> 落地 / 不采纳（理由） |

## 待内嵌

| 优化点 | 发现背景 | 建议方案 | 状态 |
| --- | --- | --- | --- |
| character 域单体拆分（character-runtime 953 行 / group-chat-input 850 行） | 2026-08-06 静态分析：两单体各为单 class 774-858 行，M3 接线后仍将增长 | 按职责拆：连接生命周期 / 请求协调 / stale 恢复 / 消息消费回调；先纯移动后微调，行为零变化 + 红绿锚定（refactor 批次，后端主导 + Arch 评审） | 待内嵌 |
| broadcast(message: unknown) 签名收窄为 ServerMessage | 2026-08-06 M3：4 处旧信封构造因宽类型逃过 tsc，wire 形状错误编译期不可见 | 签名改 ServerMessage（或联合类型），tsc 直接捕获 wire 形状漂移；codec 层钉测兜底保持 | 待内嵌 |
| dispatch 注册表 handler 样板收敛 | 2026-08-06 M2 评审 B 级：12 处 key-mismatch 双保险检查重复 | handler 工厂函数生成（key + method 断言单点），注册表声明式 | 待内嵌 |
| commands.ts 5 个 UI 格式化函数下沉 ui/ 域 | 2026-08-06 静态分析：adapter 层混入展示格式化 | 纯移动（formatSessionLabel/formatCreatorStatus/formatCharacterStatus 等），低风险 | 待内嵌 |
| saveCursor 内存先行 vs 磁盘失败不一致窗口 | 2026-08-06 QA 静态分析：语义幂等可接受 | 留注释说明窗口语义即可 | 待内嵌 |
| refreshGroupChatState catch{} 副作用重评注记 | 2026-08-06 QA 静态分析：当前纯展示安全 | 未来引入副作用时重评；补注释 | 待内嵌 |
| ~~usage-scenarios/interaction-model 等大文档内容过时核对~~ | 2026-08-06 docs 重组遗留注记（PM）：本次只归类未重写 | 内容核对另排，过期章节更新或归档 | 已随 2026-08-11 docs 清理（分支 docs/cleanup-historical-docs）完成：interaction-model 11 处旧口径由后端收敛（#123/#60/#62/#64/#144）；usage-scenarios 核验无旧口径；boundary-conditions/group-chat-input/extension-architecture/headless-character 同步修订 |
| ~~character-runtime finishDisconnected 清 pendingRequests~~ | 2026-08-06 W3 对抗验证坐实（QA）：断开后 pending 请求悬挂至超时；join-attempt rejectPending 有先例 | 一行循环参照 rejectPending；非阻断（超时兜底） | 已内嵌完成（#119 ed71515 + #123 06e41f2：clearTimeout + reject 断线原因 + clear()，character-runtime.ts:1235-1240；2026-08-09 后端溯源核实，Arch 确认关闭） |
| speak 断言宽收窄（W1） | 2026-08-06 W1 对抗验证（QA）：当前 3 种 result 形状全覆盖，未来新增 reason 分支会静默误分类 | 新增 reason 时同步 character 侧断言 | 待内嵌 |
| claim 错误文案测试覆盖缺口（W6） | 2026-08-06 W6 对抗验证（QA）：acceptance 仅覆盖 claim 1 条，error.message 10 码映射同源有保障 | 补覆盖非 1 条 claim 错误路径的断言 | 待内嵌 |
| preview 条目字段级断言不全 | 2026-08-06 Arch 弱点 3 对抗验证（QA）：content 只断一条，字段形状有 codec schema 兜底 | 低优先：对 round/sender/event_id 补字段级断言 | 待内嵌 |
| ~~注入文案集中化~~ | 2026-08-08 #97 交付弱点自曝（后端）：buildContent 硬编码文案与 identity 既有惯例一致，未来文案集中管理时一并抽取 | 随 #144 B2 落地：src/character/injection-text.ts 单一来源（PM 裁决方案 b，C 类红线留消费端） | 随 #144 落地 |
| 去重路径压力测试 | 2026-08-06 Arch 弱点 4 对抗验证（QA）：message_history 展开 vs preview 交叉去重主路径已覆盖（T2/T3+paging） | 增强项：压力化覆盖交叉去重 | 待内嵌 |
| writer.onRequestWritten 登记先于 OPEN 检查 | 2026-08-06 QA 独立抽查观察项：非 OPEN 场景登记未发出请求（pendingMethodById 残留），靠 failConnection/attachJsonRpc 清空兜底 | 低风险：可改登记顺序或补注释确认；无数据面危害 | 待内嵌 |
| handler 异常端到端故障注入测试（-32603 路径） | 2026-08-06 二轮阻断④ 收敛（后端论证：error 帧不过 gate 结构性闭合；A5 钉 schema 接受） | 测试强度项：creator 侧故障注入普通 Error → 端到端验证 -32603 收敛 | 待内嵌 |
| ~~存量 lint 欠账清理~~（9 文件：codec.ts/broadcast-hub.ts 等，biome 2.3.5 新报） | 2026-08-08 #123 code review 扫描（Arch 建议登记，PM 代登） | 随 #144 B-4（ba0603c）清零 src 12 处 + test 6 处；main 验证 biome lint src test 全绿（118 files, 0 error） | 随 #144 落地 |
| 欢迎语动态化（群名/在线成员/轮次状态入 system_message） | 2026-08-08 #123 第一性原理复盘（PM 提出，Arch 待复核） | 当前固定文本定位足够（群聊输入每轮注入状态不重复）；增强候选：welcome 内容模板化，含群名/在线成员数/轮次摘要 | 待内嵌 |
| 协议文档生成化（typebox schema → JSON Schema → 文档渲染） | 2026-08-08 #144 P1-2 手写同步暴露（Arch 调研：vscode-jsonrpc 无注释生成功能；TypeBox ToJsonSchema 可输出 schema） | 结构化字段节改生成产物（schema 单一事实源），时序/语义/边界节保留手写——混合模式防文档漂移（P1-2 同类问题的根因级方案） | 待内嵌 |
| BufferedWsClient.waitFor 超时基建缺陷（已修复，留痕） | 2026-08-08 #123 it1 定位（QA）：无新帧到达时 waiter 永不 resolve、deadline 永不检查——测试挂起而非报错 | 已修：独立 timer + 帧到达清除（ws-helper.ts）；后续新增 waiter 类基建照此模式 | 随 af19d8c 落地 |
| group-chat-state.round 字段半死数据（3 操作函数删除后无写入方，恒 null） | 2026-08-08 dead-exports 评审（Arch）：startNewRound/advanceSequence/consumeRoundMessage 删除后 round 无写入方，ui 层只读展示（tavern-ui-presenter.ts:62） | 评估 ui 展示语义后移除 round 字段或补写入方；低优先 | 待内嵌 |
| whisper 回执可选提示目标离线 | 2026-08-09 #152 WH7 评审（Arch，苍蓝星问「测试/开发哪种更对」）：静默成功回执语义 = 已记录非已送达；可选附「目标当前离线，消息已记录，恢复后送达」提示，知情不改变语义 | 窄窗口（校验-投递毫秒级）现实概率低，暂不实现；若实现走回执 result 加可选字段（需契约修订） | 待内嵌 |
| docs/api/ 生成物 README.en.md「中文文档」链接指向缺失 README.md | 2026-08-11 docs 清理断链门禁预检（客户端定性：typedoc 生成目录，.gitignore:16 忽略、git 未跟踪，豁免于活文档门禁） | 修 typedoc 生成源/模板（改链接或删行），不在文档仓内修（会被再生成覆盖） | 待内嵌 |
| 历史注释/不可达分支清理（5 处） | 2026-08-11 docs 清理行为审计（客户端/后端/PM 二次扫描）：① group-chat-input.ts L1173-1185 成员变化渲染段不可达（isEnvironmentEvent 无 joined/left 分支，ADR-0008 口径）；② src/commands.ts L234 注释「旧群聊级单文件由 loadCursor 兼容回退」与实现相反（不采用）；③ test/acceptance/streaming-truth.test.ts L151 注释称 join 批次含 character_joined（旧口径）；④ group-chat-input.ts L646 注释「system_message 与 character_joined 同批注入」误导（joined 不注入，实际为帧序描述）；⑤ test/integration/creator/paging-and-speak-order.test.ts L245 注释「join 期 message_history」（旧口径） | 随下次 src 重构清理：删不可达段、修正四处注释；同类同扫（成员/流式渲染残留、v1 游标旧注释、join 历史旧注释） | 待内嵌 |

## 已落地

| 优化点 | 落地记录 |
| --- | --- |
| 注入文案集中化（身份行/sourceLine/前缀 → shared/messages.ts） | 随 #144 B2 落地（src/character/injection-text.ts 单一来源，PM 裁决方案 b C 类红线留消费端，2026-08-08） |
| 存量 lint 欠账清理（9 文件，biome 2.3.5 新报） | 随 #144 B-4 落地（ba0603c，src 12 处 + test 6 处；main biome lint 全绿验证，2026-08-08） |

## 不采纳（留痕理由）

<!-- Arch 显式记录不采纳理由，避免重复登记 -->

## 对抗模式库（交付红队攻击清单）

> 固化实证缺陷模式（客户端提案 2026-08-06，Arch 维护，随真实缺陷追加）。交付对抗时红队/评审按此清单逐项攻击。

| # | 模式 | 实证案例 | 攻击动作 |
| --- | --- | --- | --- |
| ① | 依赖双清单 → lockfile dev 标记 | typebox 双列教训 | 运行期 import 包查 lockfile `dev:true` |
| ② | tsc 清零 ≠ wire 正确 | 旧信封 4 处（unknown 宽类型逃逸） | 查 `broadcast`/通知构造点的宽类型参数（unknown/any）与 wire 形状 |
| ③ | 声明数字路径级核对 | 清单 6 vs 4 教训 | 播报/文档声称的件数逐路径数，不信声明 |
| ④ | 临时冒烟证据可引用 | 删测试不留痕教训 | 交付证据引用的命令/数据须能重跑复现 |
| ⑤ | 依赖归属红线 | 运行期 import 必须 dependencies 且不同列 devDeps | 逐 import 核查 package.json 归属 |
| ⑥ | 信封化嵌套条目内容访问 | reload.test.ts preview 条目旧访问（QA 漏条目内容层，2026-08-06 收口门禁） | preview/messages 条目的内容字段一律 `p.params.content`，method 判别修了不算完 |
| ⑦ | acceptance 串行纪律 | reload.test.ts 首跑 `stdin is not writable`（并行撞共享端口/临时目录，2026-08-06） | acceptance 与 check/其他 acceptance 并行 = 环境抖动假失败；串行复跑为准 |
| ⑧ | waitFor 判别永不匹配 = 假绿断言（⑥ 为其实例） | M3 收口门禁 6 失败核心模式（QA，2026-08-06）：迁移后判别字段残留（m.type vs m.method），waitFor 恒假只暴露于超时，否定断言恒真永绿 | 迁移类改动必须验证「断言确实匹配过真帧」（命中计数 > 0 / 红测先行证红）；绿 ≠ 断言在验 |
| ⑨ | 迁移盘点四维清单（QA） | M3 迁移面低估根因（2026-08-06）：按文件数盘点漏 3 文件 + 6 失败 | 迁移类任务盘点/验收必查 4 维：① method 判别 ② 结果判别（id+result/error）③ 条目内容层（preview/messages/events 嵌套字段）④ 类型标注（mock/断言收窄） |
| ⑩ | schema 三态区分度 | PR #137 阻断①（苍蓝星，2026-08-06）：同 optional id schema 共用 request/response → 无 id 帧通过 codec | 评审/迁移必查 request/notification/response 三态 schema 是否区分（id 必带性按态定） |
| ⑪ | 响应关联校验 | PR #137 阻断②（苍蓝星，2026-08-06）：pending 只按 id resolve，同 id 任意合法响应可冒充（类型校验丢失） | 响应到达须按 pending 的预期 method/结果校验器验证，不符 fail-close |
| ⑫ | 近似判别不得用于丢弃决策 | T2 livelock 根因（2026-08-06）：Set 集合近似（活跃 method）并发同 method 误丢响应 → pending 悬挂 → 断链 | 丢弃 = 数据面操作须精确关联（id 级）；近似（集合/包含）只可用于展示/提示级；feed 前丢弃无库兜底 |
| ⑬ | 跨移交资源所有权须显式取消或转移 | 三轮阻断⑨（苍蓝星，2026-08-06）：connection 跨 runtime 移交后旧 owner 仍可 dispose 共享连接 + 旧 pending 悬挂 | 资源移交时 in-flight 显式取消（reject+清 timer）或连同元数据转移；不得静默丢 |
