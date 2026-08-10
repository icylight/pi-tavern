# ADR-0011：角色卡/文案模板编辑命令 skill 化（命令 → 扩展自带 skill）

- 状态：草案（2026-08-10 苍蓝星指示，五方共识，待实现验证后转 Accepted）
- 背景：#172 需求变更——User 提出「新建角色卡的方式希望通过 skill 的方式，不是现在的方式」，随后点名两个命令 `/tavern-character-edit` 与 `/tavern-template-edit` 均 skill 化，随扩展分发；头脑风暴定案「工作流修改」不建独立 skill，改并入联动检查步骤

## 背景

0.4.0 的 #153（角色卡编辑）与 #154（文案模板编辑）以 prompt command 实现：`registerCommand` + `sendUserMessage` 注入访谈 prompt（CHARACTER_EDIT_PROMPT / TEMPLATE_EDIT_PROMPT），带代码级状态门禁（idle/Character 可用，creator/joining 拒绝）。User 反馈希望改为 skill 方式：别人安装扩展即自带、不改任何配置、零额外步骤。

## 决策

1. **命令 → skill 化**：删除 `/tavern-character-edit` 与 `/tavern-template-edit` 两个 prompt command（commands.ts 注册块 + messages.ts 三组文案 + tavern-tools.ts:424 引用注释同步清理）；访谈指令本体（PROMPT）**迁入**包内对应 SKILL.md（转写为 skill 流程指令，非纯删除——访谈语义不丢失）。
2. **随包分发**：包内 `skills/tavern-character-edit/SKILL.md` + `skills/tavern-template-edit/SKILL.md`；package.json `pi` 清单显式声明 `"skills": ["./skills"]`（pi-tavern 已有 `pi.extensions` manifest，约定目录自动发现不适用，必须显式声明）；npm 发布 `files` 白名单补 `skills/`；git 钉 hash 安装 clone 即得，用户零配置。
3. **命名沿用命令原名**（tavern-character-edit / tavern-template-edit）：与全局既有 create-character-card / define-persona 完全不同名 → 同名遮蔽不适用（QA 实证「同名遮蔽」仅限同名场景）。命名与 /skill: 触发、用户记忆、#153/#154 契约引用一致，零迁移成本。
4. **单源引用约束**：skill 不内嵌知识——template skill 引用「先调 tavern_template_defaults 只读工具获取默认值/合法 key/占位符规则」；角色卡 skill 引用契约文档（frontmatter name/description 必填、tavern.json characters 数组格式）而非复制。防双源漂移（代码改默认值 skill 不同步）。
5. **门禁语义降级（不对称）**：skill 无代码强制状态门禁。template 侧保留 tavern_template_defaults 工具 = 工具层代码门禁仍在（idle/Character 可用、creator/joining 拒绝，可自动化断言）；角色卡侧无对应只读工具，门禁靠 SKILL.md 内状态约束声明 + prompt 自律（仅锚文档自洽 + 人工实测）。
6. **验收降级口径**：命令侧自动化面（CE1/CE2/CE7 + T6）随命令删除；「写前 diff+确认、取消=零写入」从代码强制变提示词期望（LLM 非确定），改文档级用例 + 人工实测；机械锚保留（SKILL.md 存在/frontmatter 合法/pi.skills 声明与 files 白名单一致/关键安全条款文本存在性静态断言）；既有锚定面保留（frontmatter 契约、tavern.json 联动、claim/join 生命周期、模板合并渲染）。
7. **全局 skill 不动**（User 拍板 2026-08-10：全局不要动、只改当前项目）：全局 create-character-card 保留，与包内 skill 不同名不遮蔽；描述互斥声明**落在包内侧**（新 skill description 声明触发边界）；内容双源接受「以包内为准」口径，不做对账义务。

## 若不成立则失效（脆弱点声明）

- 若 LLM 按 description 自动触发时在 create-character-card 与 tavern-character-edit 之间稳定加载错 → 决策 7 的「包内侧描述互斥」失效；判据：人工实测中误触发率不可接受（QA 验收实测项）。
- 若 skill 内转写的访谈指令与 #153/#154 行为语义漂移（丢 diff/确认/取消条款）→ 决策 1 的「迁入不丢失」失效；判据：机械锚静态断言（关键条款文本存在性）不通过。
- 若模板默认值演进后 tavern_template_defaults 与 skill 引用不同步 → 决策 4 失效；判据：工具返回与 skill 描述规则矛盾（代码侧单源仍成立，风险可控）。

## 后果

- 正向：安装即自带（零配置）；skill 渐进式披露（description 常驻、全文按需加载）降低会话开销；命名与命令语义一致无迁移成本；全局零改动符合 User 边界。
- 负向：状态门禁从代码强制降为 prompt 自律（角色卡侧无工具兜底）；验收从自动化断言部分降为人工实测；包内 skill 与全局 create-character-card 描述面重叠残留小风险（接受）。

## 决策 8：工作流修改不建独立 skill（联动检查清单并入）

User 曾提出「加一个工作流修改的 skill」（与 tavern-character-edit 配套，编辑 docs/development/workflow.md）。头脑风暴（2026-08-10，四方共识：后端/Arch/客户端/QA 全 A，User 拍板「看来不建 skill 更好」）：

1. **不建独立 skill**：workflow.md 修改低频（全历史 6 次提交、讨论驱动）+ 编辑动作简单（markdown）+ 已有讨论前置纪律（属主声明要求变更先群聊声明影响面）——独立 skill 的访谈流程/机械锚/人工实测三份维护成本 > 低频收益；多一个自动化入口即多一个绕过讨论纪律的风险面。
2. **联动检查清单并入 tavern-character-edit SKILL.md 收尾**：写入角色卡后检查是否需要同步 workflow.md（文件所有权表新条目等）/AGENTS.md；需同步则走四步——群聊声明影响面 → 团队收敛 → 属主复核 → PM 落盘（与 #172 落盘归口契约同构，非新增机制）。引用 workflow 契约而非复制（单源约束精神）。
3. **机械锚轻断言**：character skill 文本含「联动检查」段（触发条件 + 四步流程引用），防转写漏掉。

## 变更记录

- 2026-08-10：草案（#172，五方共识：替换命令 / prompt 自律 / 单源引用 / 命名沿用 / 全局不动 / 工作流不建独立 skill 改联动检查）
- #76 裁决反转留痕：2026-08-03 曾拍板「skill 应在本地、不从项目仓库分发」（web-research + create-character-card 移至 ~/.pi/skills/）；本次 #172 反转该裁决为「PiTavern 业务 skill 随扩展包分发」，本机全局卡不动。新旧裁决对照见上，反转依据 = User 2026-08-10 指示「别人安装扩展即自带」。
