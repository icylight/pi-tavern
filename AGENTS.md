# PiTavern 开发指南

这份文件解释项目为什么这样构建。当某个变更与这些原则冲突时，原则优先。
操作指南（五方协作全流程、分支纪律、验证留痕）在 `docs/development/workflow.md`；本文只讲原则与必须加载的上下文。

## 需要加载的上下文

- @README.md — 项目定位、机制、安装
- @docs/development/workflow.md — 五方协作规范（权威：默认不跑测试）
- @docs/reference/terminology.md — 规范术语（群聊/角色卡/讨论轮次/发言上限/举手）
- @docs/development/acceptance.md — 现行验收标准（功能"完成"的唯一判据）
- @docs/architecture/architecture.md — 当前五层架构与结构演进状态

## 项目是什么

PiTavern 是 pi-coding-agent 的本地扩展：多个独立 pi session 以 Character（角色卡）身份加入同一个群聊，通过 `tavern_speak` 公开发言，围绕 User Persona 开启的讨论轮次协作。核心机制 = 独立 Session + Character 身份 + 公共持久消息流 + 生命周期感知投递 + 每 Session 独立游标。首版无独立 Group 实体、无独立 TUI、无每角色保底发言。

## 核心原则

1. **五方角色协作**：PM（做什么/验收标准）、后端/客户端（实现）、Arch（架构评审 + code review）、QA（测试与验收）。文件所有权表与 git 纪律见 `docs/development/workflow.md`——改文件前先查属主，非属主默认只读；git 写操作（commit/push/PR/merge/分支）统一由 PM 执行，push 须 User 审批，任何人不得自行 merge。
2. **验收驱动**：功能声称"完成"必须以 `docs/development/acceptance.md` 中的现行可验证标准为准；当前版本需求以对应 GitHub Issue 为准，不以口头承诺或代码现状代替。
3. **契约零漂移**：`src/protocol/` 的 wire schema 默认零改动；任何协议/持久化/schema 变更必须先声明影响面、五方确认后再改。
4. **验证默认不跑**（门卫机制）：测试命令无参 = exit 1 拒绝（提示"这是拒绝不是失败"）。日常验证必须显式指定目标：`npm run test:unit -- <pattern>`（unit/integration/acceptance 同规，pattern = 文件或目录）；层内全量用 `-- --all`；收口门禁用 `npm run test:full`（三层串行）。跑测试前 `git status` + `git rev-parse HEAD` 确认分支与工作区。
5. **五层依赖方向**（`npm run lint:layers` 强制，不得破坏）：adapter（index.ts 组合根 / commands / headless / extension / ui）禁 import skills 行为面；application（controller / 各 pipelines）禁 node:fs；runtime 禁直连 node:fs（creator-factory 与组合根豁免）。纯类型与纯路径函数豁免。
6. **术语纪律**：使用 `docs/reference/terminology.md` 规范术语，不使用"房间"等非规范表达。

## 技术原则

- TypeScript + biome（`npm run check` = biome + tsc，CI 门禁）+ vitest 三层：`test/unit/`（进程内，快）、`test/integration/`（进程内 WS，秒级）、`test/acceptance/`（真实 pi 进程 e2e，慢——共享端口与临时目录，须与 check 串行）。
- 测试门禁锚定 `references/pi` 子模块版本（升级即触发受影响层重跑）；acceptance 由 run-tests 自动注入 `PITAVERTEST=1`；`PITAVERN_AUTO_JOIN_DELAY_MS` 可注入 auto-join 延迟（默认 3000，测试用短值 ≥50ms）。
- 游标按 Session 隔离：`cursors/<groupId>/<sessionId>.json`；旧群聊级单文件不读不写不删；join 消费路径预置游标 = 进入时刻水位（ready 响应 `latest_sequence`，方案 a；旧帧缺字段回退查询 CAS 写）；进入前历史不自动注入，经 `tavern_history` 工具 AI 主动分页拉取（欢迎语指引；重复可接受、跳过不可接受，严格区间 = 预置完成后）。
- 重构行为零变化：声明"测试零改动"时公开 API 与断言必须真的不动；**值拷贝注入是已知陷阱**——可重赋值字段/回调必须用 getter 闭包或实例引用传递（纯快照语义如配置/常量才允许值传）。
- 依赖注入窄接口化：模块不 import 所属 runtime 类型，回调/getter 注入，防循环依赖。

## AI agent 使用规范

- 允许：读代码与文档；跑显式定向测试；在属主文件内做工作区产出；用 `tavern_whoami` 查证身份（不猜测）。
- 不允许：自行 git add/commit/push/merge/迁分支（PM 归口）；无参跑测试或隐式全量；改动非属主文件（先群聊声明等属主确认）；在 GitHub PR/issue 直接评论留痕（评论内容可提供，发布由 PM 归口）；回复同议题已被回答的内容（事实增量原则——纯复读/重复确认一律不发）。

## 写作与规范

- Commit：Conventional Commits（feat/fix/refactor/docs/test + scope），一个逻辑一个 commit，中文描述，附关键证据（命令 + 结果摘要）。
- 分支命名：`<type>/<slug>`（refactor/ fix/ feat/ docs/），基点 main，PM 指定。
- 宣布完成/通过必须附证据（V0 留痕：命令 | 结果 | hash@层 | 环境），留痕即证据、引用不重跑。
