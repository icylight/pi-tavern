> **已归档**：0.1.0 发布验收基线（历史归档，被后续验收文档替代）。本文件不再维护，索引见 docs/README.md。

# 0.1.0 发布验收基线（main @ a25ecce，#93/#94 合入后）

- 日期：2026-08-03（#88 发布定型）
- 分支：main @ a25ecce0（#93 health + #94 J 系列合入后）
- 测量人：QA（#88 R4 门禁留痕同源）
- 入口：`npm run test:full`（三层串行收口；PITAVERN_TEST=1 内联）
- 留痕：命令 | 结果 | hash@层，见 #88 issue R4

## 全量门禁实测（V0：a25ecce0@docs/release-0.1.0）

| 层 | 文件 | 用例 | 墙钟 | 判定 |
| --- | --- | --- | --- | --- |
| unit | 20/20 | 209/209 | 5.73s | 通过 |
| integration | 13/13 | 110/110 | 8.37s | 通过 |
| acceptance | 11/11 | 19/19 | 88.76s | 通过 |
| **三层合计** | 44 | 338 | ≈102.9s | exit 0 |

check（biome + tsc）：0 error + 8 warnings（`characters[N]!` fixture 必要断言，Arch 豁免评审留痕 #89）+ tsc 0。

## 基线演进口径

| 版本 | 入口 | 三层合计 | 说明 |
| --- | --- | --- | --- |
| #34 时代（2026-08-02） | acceptance 10 文件 | ~66s（仅 acceptance） | 旧基线，见 acceptance-baseline-34.md（已废弃标注） |
| #45 时代（2026-08-02） | 全量 | ~152s（W2 maxWorkers=2 139s） | 旧基线，见 acceptance-baseline-45.md（已废弃标注） |
| #73 后（#92 立项口径） | 全量 | 83.6s | 提速试点立项基线 |
| **0.1.0（本次，a25ecce）** | 全量 | ≈102.9s | acceptance 11 文件含 J 系列（J2 15s + w1c 24s 等新钉测负载） |

83.6s → 102.9s 差异来源：J 系列合入后 acceptance 文件数 9→11（J2 降级钉测 + W1-c 端到端点亮钉），负载方差 + 机器状态；非性能回归（#92 提速试点以此为对照基线）。

## J2 双绿结论注记（#85 定案，2026-08-03）

- RPC 面：0.82.1 vs 0.83.0 双版本实测 abort 均不清已入队 steer（pending 1/1/2/2/2 序列一致）；clearQueue 仅 interactive 模式存在、两版本触发面同构；176 commits 零 abort/queue 变更 → **双绿，上游 issue 路径关闭**
- 方向②不实施（Arch 评审定案：RPC 面无盲区、interactive 面结构性不可演练、触发概率极低）；BC-20 独立落库为已知边界（docs/architecture/boundary-conditions.md）
- 降级钉测：acceptance/j2-rpc-abort-no-loss.test.ts（0→1→abort→1→2 完整序列，防 abort 清队 + 队列锁死双回归）

## 废弃标注

- acceptance-baseline-34.md（#34 复核，2026-08-02）：已废弃（0.1.0 基线取代），留档不删
- acceptance-baseline-45.md（#45 套件基线，2026-08-02）：已废弃（0.1.0 基线取代），留档不删
