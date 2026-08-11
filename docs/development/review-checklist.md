# 交付对抗检查清单

> 属主：Arch。用于方案评审、代码评审与交付收口；只保留可执行检查，不记录讨论过程或历史案例。

1. **依赖归属**：运行期 import 必须来自 `dependencies`；核对 lockfile 的 `dev` 标记。
2. **Wire 类型边界**：检查通知/广播构造点是否以 `unknown` / `any` 逃逸，不能只以 `tsc` 通过判定 wire 正确。
3. **声明逐路径核对**：文档或汇报中的文件数、路径数和分支数逐项对照实际树。
4. **证据可复现**：交付引用的命令、数据与冒烟结果必须可重跑。
5. **嵌套信封访问**：迁移协议时同时核对 method、result/error、preview/messages/events 内容层和类型标注。
6. **Acceptance 串行**：共享端口、临时目录或进程组的 acceptance 不与其他 acceptance/check 并行。
7. **断言有效性**：`waitFor` 等判别必须先证明命中过真实帧；否定断言不得因判别恒假而假绿。
8. **请求/通知/响应三态**：schema 必须区分 id 的必带性与载荷形状。
9. **响应关联**：响应除 id 外还须符合 pending 请求预期的 method/结果校验器，否则 fail-close。
10. **丢弃决策精确关联**：数据面丢弃使用 id 等精确键；集合近似只用于展示或提示。
11. **资源移交**：跨 Runtime 移交时显式取消或转移 in-flight 请求、timer 与所有权元数据。
12. **消费链完整**：新增帧/工具逐层核对 schema → codec → dispatch → consumer → behavior assertion。
13. **测试桩契约**：stub 语义必须等同生产依赖契约，由依赖属主复评。
