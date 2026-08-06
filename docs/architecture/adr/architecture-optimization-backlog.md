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
| usage-scenarios/interaction-model 等大文档内容过时核对 | 2026-08-06 docs 重组遗留注记（PM）：本次只归类未重写 | 内容核对另排，过期章节更新或归档 | 待内嵌 |

## 已落地

<!-- Arch 勾销：注明随哪个 commit/里程碑落地 -->

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
