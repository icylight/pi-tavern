# 安装与更新场景（三场景操作口径文档 · 草案）

> 状态：**草案**（P2 提前量，2026-08-06 客户端按可平移清单⑦产出；本地 dev 场景待补，经 PM 审后随 P2 排期转正式）
> 目的：用户遇到安装/更新问题时有一张可查的对照表。每场景给一条可复现验证命令，故障对照表行 = 症状 → 一条检查命令 → 幂等恢复动作。
> 关联红线：`docs/development-conventions.md`（prepare 红线 + 依赖归属红线）。

## 0. 场景判定（按你执行过的命令，不按机制）

| 你执行过 | 属于 | 走哪节 |
| --- | --- | --- |
| `pi install git:github.com/icylight/pi-tavern` | git 钉装（开发版） | §1 |
| `pi install npm:pi-tavern` | npm 安装（正式版） | §2 |
| `git clone` 后本地开发 | 本地 dev 场景 | §3（占位） |

## 1. git 钉装（开发版）

- 安装命令：`pi install git:github.com/icylight/pi-tavern`
- 机制要点：pi 按 commit 钉版本拉取并执行 `npm install --omit=dev`（devDependencies 不安装）；扩展入口 = package.json 的 `pi.extensions` 字段（`./src/index.ts`），files 白名单含 `src`，无构建产物
- **验证命令**（一条可复现）：启动 pi 后检查工具列表是否出现 `tavern_speak` / `tavern_board` / `tavern_whoami`（工具注册成功 = 扩展加载 + 依赖 import 完整）
- 更新纪律：**钉 commit + 运行期禁改 pin**（2026-08-06 四方收敛：prepare 修复只消除安装崩溃面，不与 pin 纪律正交松绑）；改 pin 需苍蓝星批准、PM 执行

## 2. npm 安装（正式版）

- 安装命令：`pi install npm:pi-tavern`（当前正式版 0.2.1，2026-08-06）
- 机制要点：npm 包发布物 = files 白名单（src + README + CHANGELOG + LICENSE），无构建产物；入口 = package.json `pi.extensions` 字段，不依赖 main/exports（直接 `import "pi-tavern"` 属非支持用法）
- **验证命令**：`npm view pi-tavern version` 核对版本 + 启动 pi 检查上述三个工具是否出现
- 更新：正式版更新走发布链路（#124 相关，P3 排期）；npm 场景不受「钉 commit」纪律约束，但升级后同样执行工具出现验证

## 3. 本地 dev 场景（占位，待补）

> 非客户端切片，P2 排期时由对应方补齐：git clone + `npm install` 后本地加载方式、`npm run check` / `npm run health` 自检、与钉装场景的差异。

## 4. 故障对照表（客户端行；症状为常见用户表述）

| 症状（用户原话） | 检查（一条命令） | 恢复（幂等） |
| --- | --- | --- |
| 装完启动就崩 / 扩展加载报错 | 看 pi 启动日志的 import 报错：缺 `typebox` / `vscode-jsonrpc` / `ws` → 依赖缺失 | 重跑 `pi install <同源同版>`（幂等重装）；若仍缺依赖，检查依赖归属红线是否被破坏（`npm ls --omit=dev` 于扩展安装目录） |
| 工具不出现（无报错） | 确认角色卡已建 + PiTavern 配置已导入（README「安装与首次使用」） | 补齐角色卡/配置后重载 pi |
| 提示 node 版本不符 | `node -v` vs `engines: >=22.19.0` | 升级 node ≥22.19.0 后重装 |
| 工具行为异常/静默漂移 | 核对 pi 版本与扩展编译 API（@earendil-works/pi-coding-agent）一致性 | 对齐 pi 与扩展版本；扩展入口 load-time 自检（若已落地）会给出显式报错 |

## 5. 红线引用（不随本文档漂移）

- prepare 红线 + 依赖归属红线：见 `docs/development-conventions.md`
- 更新纪律：git 钉装 = 钉 commit + 运行期禁改；发布链路（npm publish / pin 变更 / git 推送）= PM 归口
