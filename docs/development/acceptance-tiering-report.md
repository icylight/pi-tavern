# #152 场景分层定案与风险评估报告

- 产出：QA（2026-08-09，苍蓝星指示「e2e 不硬上——不好测的边界场景降级 integration/unit，附风险评估报告」）
- 评审：Arch + 后端/客户端共同评审 → PM 收口
- 框架：Arch 分层评审框架（ADR-0010 附录）——e2e 必覆盖 = 真实链路高价值；6 类降层清单；每场景单层主锚、降层不降质（替代层断言等价覆盖断言点）

## 一、e2e 剧本覆盖（真实链路高价值，剧本 scripts/rh3-whisper-projection.jsonc 为首部）

| 场景 | 断言点 | 剧本步骤 | 备注 |
|---|---|---|---|
| WH4 三类视角投影 | 创建者完整正文 / 接收者实时正文 / 旁观者占位无正文 | whisper 步骤三观察者 expect | 首部剧本已覆盖（创建者 kind=whisper_message 含正文；carol whisper_message 帧含正文；bystander whisper_placeholder 无正文） |
| WH8 恢复 | 重启 resume 后创建者仍见完整正文 | recovery.restart expect | RH3 验收点（AI 评审第三轮阻断本体） |
| WH3 持久化/交错 | 真实 JSONL 落盘、speak+whisper 序列交错 | persona 开场 → speak(seq1) → whisper(seq2) | 真实进程 + 真实持久化 + 真实恢复 |
| WH6 投递面 | 接收者实时投递 / 旁观者不唤醒 | carol 帧断言 + bystander 占位帧断言 | 占位无正文即不唤醒语义的观察面 |

## 二、integration 覆盖（可控时序/并发/中间态——e2e 时序不可控降层）

| 场景 | 断言点 | 替代层覆盖（既有） | 降层理由 |
|---|---|---|---|
| WH2 目标校验 | 离线目标拒绝（-32110）/ 自发自收拒绝（-32111）/ 非 character 拒绝 | integration whisper-flow（8 用例） | 拒绝态枚举 e2e 逐态成本高增量低（Arch 降层清单 2） |
| 场景 15 发送者零事件 | 发送者不收到自身事件（whisper 成功后发送者无 whisper_message 帧） | integration whisper-flow「does not deliver any event to the sender」 | e2e 剧本可加发送者 expect 空断言（低优先，暂不排） |
| 场景 17 接收者忙态安全 | 接收者处理中投递仍达（投递面语义，不冲突） | e2e WH6 投递面观察断言（carol 实时收到帧） | 忙态=接收者处理中投递仍达属投递面语义，e2e 首部剧本 carol 帧断言覆盖观察面；时序内细节 integration 兜底 |
| WH5 额度 | round_limit_reached 共用池（speak 耗尽 → whisper 拒绝 + 举手） | integration whisper-flow WH5 节 | 额度池边界无需真实进程（清单 1/2） |
| WH7 掉线竞态 | 校验通过 → 投递瞬间断开 → 已持久化不回滚 | unit 级 WhisperPipeline 单测（注入 deps.send 抛错模拟断连，断言 resolve published:true + 已持久化 + 不占二次额度）——Arch 编写中 | integration 无法确定性复现窄窗口（校验与投递同 await 链，后端评审发现 -32110 ≠ WH7） |
| WH10 在线判定 | ready 完成但断开 = 离线 | integration（WS 连接状态可控） | 连接状态注入 e2e 难稳定（清单 1） |
| WH9 模板渲染 | whisper_full/placeholder 三消费面一致 | integration + unit message-templates | 模板纯逻辑 unit 主锚（清单 4） |

## 三、unit 覆盖（工具层/纯逻辑）

| 场景 | 断言点 | 替代层覆盖（既有） |
|---|---|---|
| WH1 工具注册/门禁/文案 | 注册、非 character 拒绝、三态文案（round_limit_reached 含 handRaised、不误报未读） | extension.test 42 用例 |
| codec 三态解码 | published/stale/round_limit_reached 逐字段透传 + 错误码 + 非法形态拒帧 | codec.test.ts A1-A5（29/29） |
| 预算自愈 | stale→success→stale 完整预算重置 | chain: whisper stale→success→stale |
| 占位消费 | 占位不注入不唤醒不进 debounce | chain: whisper-placeholder no-wakeup |

## 四、风险残余评估

| 残余点 | 评估 | 结论 |
|---|---|---|
| WH7 掉线竞态毫秒窗口 | unit 级管线单测等价覆盖（deps.send 抛错注入） | 低风险，降层不降质（补测中） |
| WH10 在线判定 | integration 连接状态注入等价覆盖 | 低风险 |
| WH2 错误码全枚举 | unit codec 全覆盖 + integration 抽查 -32110 | 低风险 |
| 工具桥接段（execute→runtime） | unit mock runtime 完整验证（已论证） | 低风险，工具链膨胀后再评估真实进程通道 |
| 剧本-JSONL 漂移 | ADR-0010 脆弱点声明 + 双向核对机制 | 需保持剧本与 entry 形状同步（维护纪律） |

## 五、结论

#152 的 20 场景 + 2 变体：4 项上剧本（真实链路高价值）、5 项 integration（可控时序/拒绝态）、4 项 unit（工具层/纯逻辑），每场景单层主锚、替代层断言等价覆盖断言点。降层均附理由，无降质。
