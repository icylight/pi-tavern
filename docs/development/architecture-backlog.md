# 架构优化待办清单（Architecture Optimization Backlog）

> 属主：Arch。只登记**仍有效待办**，不保存讨论、评审流水或已落地历史；发现即登、随所在分支同批合入。

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
| claim 错误文案测试覆盖缺口（W6） | 补覆盖非 1 条 claim 错误路径的断言 | 待内嵌 |
| preview 条目字段级断言不全 | 低优先：对 round/sender/event_id 补字段级断言 | 待内嵌 |
| 去重路径压力测试 | 压力化覆盖交叉去重（message_history 拉取 vs preview） | 待内嵌 |
| writer.onRequestWritten 登记先于 OPEN 检查 | 低风险：改登记顺序或补注释；无数据面危害 | 待内嵌 |
| handler 异常端到端故障注入测试（-32603 路径） | creator 侧故障注入普通 Error → 端到端验证 -32603 收敛 | 待内嵌 |
| 欢迎语动态化（群名/在线成员/轮次状态入 system_message） | 增强候选：welcome 内容模板化，含群名/成员数/轮次摘要 | 待内嵌 |
| 协议文档生成化（typebox schema → JSON Schema → 文档渲染） | 结构化字段节改生成产物（schema 单一事实源），时序/语义/边界节保留手写 | 待内嵌 |
| group-chat-state.round 字段半死数据 | 评估 ui 展示语义后移除 round 字段或补写入方；低优先 | 待内嵌 |
| whisper 回执可选提示目标离线 | 窄窗口现实概率低，暂不实现；若实现走回执 result 加可选字段（需契约修订） | 待内嵌 |
| docs/api/ 生成物 README.en.md「中文文档」链接指向缺失 README.md | 修 typedoc 生成源/模板，不在文档仓内修（gitignored 生成物） | 待内嵌 |
| 历史注释/不可达分支清理（5 处） | 随下次 src 重构：删 group-chat-input.ts L1173-1185 不可达渲染段；修 commands.ts L234「兼容回退」旧注释、group-chat-input.ts L646「同批」误导注释、streaming-truth.test.ts L151 与 paging-and-speak-order.test.ts L245 join 历史旧注释 | 待内嵌 |
