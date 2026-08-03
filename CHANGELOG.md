# Changelog

此项目的所有显著变更都将记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/2.0.0/)，
本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> 此 changelog 从项目初始化（2026-07-24）开始记录。首次正式发布 0.1.0（2026-08-03），此前全部变更汇集于此版本；后续变更记入 `[未发布]`。

## [0.1.0] - 2026-08-03

### 新增

- PiTavern 扩展运行时（M0）：本地群聊扩展的 pi-coding-agent 宿主集成骨架。
- creator 进程生命周期（M1）：群聊创建、持久化、round 讨论轮次与发言配额（#37）。
- character 进程加入生命周期（M2）：角色以独立 pi session 身份加入群聊、群聊状态同步。
- 公开对话循环（M3）：角色间通过群聊公开发言协作、round 轮转。
- 历史恢复（M4）：会话文件追加写入 + 游标只前进 + 写中断恢复（FIRST_PERSIST 机制）。
- pi 生命周期对齐（M5）：扩展随 pi 启动/退出，reload 交接与崩溃收敛。
- 进程级验收（M6）：多进程端到端验收套件。
- 角色卡系统：角色卡驱动角色身份与协作守则，reload 热刷新角色清单（#18）；架构师角色卡加入，四方（PM/Dev/QA/Arch）协作化（#27）。
- 群聊历史分页拉取（ISSUE-008）：join 后全量历史可查（#19）。
- 新消息获取推拉混合（M7/ISSUE-012）：join 拉取 + 活跃期推送（#26）。
- resume 历史投影（#42）：崩溃/重启后按游标扫描锚定恢复对话历史，不重不漏。
- TUI 增强组：渲染精度、终端尺寸自适应等（#12/#14/#20/#21，#40）。
- ADR 决策记录体系：ADR-0001/0002 契约与 CPU 结论固化（#36）。
- 游标按 Session 隔离：同群聊多角色各持独立游标文件（`cursors/<groupId>/<sessionId>.json`），互不踩踏（#71）。
- run wedged watchdog（#66）：角色 run 卡死超时（默认 180s，可注入）自动强制收敛——排队消息不再无限滞留，迟到真实 settle 不会双重冲刷。
- 五层架构重构（ADR-0005）Phase 2+3 完成：application 层六管线门面化 + runtime 瘦身（creator-runtime 1881→429 行骨架，拆出十模块）+ index.ts 唯一装配点（#58/#69/#72）。
- AGENTS.md：面向 AI agent 的项目指令（核心原则 + 必须加载的上下文索引）。
- 角色卡清单按需刷新（#25/#79）：join/claim/query 前懒重扫角色清单，扫描失败回退旧快照——新角色与 name/description 变更无需重建群聊。

### 变更

- 消息同步改为 pull 模型（#64）：广播降级为纯标记（latest_sequence 水位），消费点在 run 组装时一次拉全未读、整批聚合发 LLM，活跃 run 零中间注入（#67）。
- run 中消息投递（#38）：steer 间隙投递改为秒级延迟、不打断进行中的 run（#41）。
- 活跃期增量聚合窗口（#60）：多次打断 N 条消息 → 单次投递（N→1），固定 400ms 窗口 + settle 尾部兜底（#62）。
- 群聊消息数量上限 10 → 100（#30）。
- 五层架构重构（ADR-0005）Phase 1：resume-projection / discovery / session·cursor store 归位 `src/data/`（skills 层），行为零变化、契约零 diff（#55/#59/#61/#63）。
- 旧共享游标废弃（#71）：新 Session 无独立游标时从完整历史拉取（重复可接受、跳过不可接受），不再采用无 Session 身份的旧群聊级游标（修复升级后可能跳消息的窗口）。
- README 全面重写：定位「面向独立 Agent Session 的生命周期感知异步群聊」；团队组合示例六案例（三软件 + 三非软件、职位化、双层免责）；安装（开发版）+ 快速开始；中文主版 + 英文对等版。
- 测试机制：默认不跑用例——验证必须显式指定目标（`npm run test:unit -- <pattern>` / `-- --all` 层内全量 / `test:full` 三层串行收口），无参调用拒绝（exit 1）并打印指引。
- 验收套件提速：四场景 family 化聚合（13→10 文件）+ streaming-truth 并发化（100.9s→26.9s）+ 孤儿 pi 进程自动清理；全量 83.6s。
- 协作流程：并发协作（前置产物先行/红钉先行/阶段重叠/预跑窗口）、Arch 承担 code review（评审从严、代码洁癖）、落盘文件清单核对（workflow v1.0–v1.3）。
- 测试耗时 152s → 87s → 83.6s：假 key 注入 + tsx 预热 + worker 定档 + acceptance family 重构/并发化/孤儿清理（#45/#51）。
- 忙态消息投递恢复工具间隙可见（#68，User 拍板）：run 活跃期间新消息经 steer 通道在工具调用间隙到达（秒级可见），不再等 run 结束才批量进入；绝不打断进行中的 run；游标在投递入队成功时推进，失败由 settle 兜底重投（不丢不重）。
- 闲态触发窗口可注入：`PITAVERN_TRIGGER_DEBOUNCE_MS`（默认 1000ms 行为不变），需要更快感知的环境可设短值（idle 感知延迟降 ~750ms）。
- 依赖方向由 lint 强制：`npm run lint:layers`（adapter 禁 skills 行为面 / application 与 runtime 禁直连 node:fs，组合根与工厂豁免），与 biome 同入 CI 门禁。
- TUI 状态语义「正在发言」→「正在工作」（#77/#81）：run 活跃即亮（agent_start 无条件点亮），标记机制删除、复位三件套保留（agent_end / 5s watchdog / wedged 3min）——长 run 常亮为预期行为。
- 仓库健康度检查（#87/#93）：`npm run health` 三合一体检——npm audit 依赖漏洞 / gitleaks 凭据扫描（承接 #53）/ 卫生自查（未提交改动、残留分支、超大文件）；纯本地手动命令，不做 CI 集成。
- J 系列投递边界钉测（#85/#94）：长 run 循环输入不丢投递（unit）/ RPC 中途 abort 不清队（acceptance，0→1→abort→1→2 完整序列）/ 半开恢复断连不丢（integration）；双版本（pi 0.82.1-1 vs 0.83.0）行为一致三路实证（RPC 实测 + 源码 diff + 176 commits 检索）。

### 变更

- 本地门禁清理（#89/#91）：存量 biome/TS 欠账清零 + husky pre-push 钩子（推送自动跑全量 check，非零拒绝）——合入 main 前 check 全绿留痕为合入三件套之一。
- 协作流程 v1.4（#95）：§7.6 机制九条（状态以 git log 为准 / 分工矩阵 / 等待窗口显式化 / 钉测即验收 / PM 总收尾 / 验收两级制试点 / 测试分层下沉 / 双 worktree 声明制）+ PM 落盘职责边界（机械修复先声明、语义修改归属主）。
- 验收基线刷新（#88）：0.1.0 基线三层全量 338 用例 ≈102.9s（acceptance 11 文件含 J 系列/W1-c 新钉测负载，非性能回归）；旧 34/45 基线废弃标注留档。

### 修复

- typebox 依赖移至 dependencies，git 安装可正常加载（#10/#11）。
- 群聊历史分页拉取修复（ISSUE-008）：join 后历史全量可查（#19）。
- 消息同步修复（ISSUE-013）+ headless 模式 CPU 占用根治（ISSUE-014）（#30）。
- 验收套件 CPU 峰值 8 核 → 1.5 核（限 2 worker，#34）；负载敏感超时用例定档（#35）。
- 重构值拷贝注入陷阱修复：deps 中可重赋值字段/回调改 getter 闭包活引用（onPublicMessage/runtimeTail/lifecycle 族），消除 close/drain 竞态（Phase 3 PR-B）。
- 验收游标断言修复：headless/live-delivery 改读 Session 隔离路径（共享 cursor-helper，断耦实现路径）。
- 验收卡死修复：孤儿 pi 进程自动清理（10 个孤儿曾致全量 >600s 未完成）。
- 忙态游标推进竞态修复（#68 T2）：投递确认短承诺化（入队接受即推进游标），消除并发拉取下同一窗口重复投递。

## [未发布]

### 新增

（暂无）
- 断连后停止流式状态上报竞态（#14/#82）：updateStreaming 在连接未建立/已关闭时静默跳过（display-only 语义，绝不 throw），finishDisconnected 同步拆除 streaming reset 与 run wedged watchdog——消除定时器路径 uncaughtException 导致整个 pi 进程崩溃的问题。

### 安全

- 凭据泄漏修复（#52）：白名单 env 关闭 LLM 凭据泄漏——测试确定性零 LLM、零网络，DeepSeek 泄漏根因堵死（#54）；.gitignore 防凭据误提交。
