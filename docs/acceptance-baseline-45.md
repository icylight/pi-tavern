# #45 验收套件基线（两场景 + Pareto 面）

- 日期：2026-08-02
- 分支：main @cb6174f（#49 合并后）
- 测量人：QA
- 入口：`npm run test:acceptance`（PITAVERN_TEST=1 已内联，裸跑等价）
- 复现脚本：`tmp/idle-cpu.test.ts`（场景一空载采样）

## 场景一：空载基线（群聊在线、无活动）

| 指标 | 实测 | 判定 |
| --- | --- | --- |
| 空载 CPU（30s 采样，单核占比） | 0.00% | Dev 静态判断成立：src 无轮询热点，无深挖必要 |
| spawn→tavernReady | 4.6s | 进程启动开销基线 |

## 场景二：负载基线（全量 13 文件 / 21 用例）

### Pareto 面（墙钟 vs worker 数，多次实测）

| maxWorkers | 墙钟 | 峰值 CPU（200ms 粒度全机） |
| --- | --- | --- |
| 2 | 139-181s | ~1.0 核（>2 核采样点 0%） |
| 4 | 139s | 未采样 |
| 6 | 80-101s | ~1.0 核（>2 核采样点 0%，两次复测） |

门禁基线（W2）：unit 5.9s + integration 7.2s + acceptance 139.2s ≈ 152s 全门禁。

### 每文件耗时（串行合计 ~340-365s，与 worker 数无关）

| 文件 | 用例 | 串行耗时 | 说明 |
| --- | --- | --- | --- |
| live-delivery.test.ts | 1 | **54-139s（2.6× 波动）** | 等待主导、极端负载敏感（#43 实锤） |
| streaming-truth.test.ts | 3 | 70-80s | 次大头 |
| crash-convergence.test.ts | 2 | 28-53s | |
| reload.test.ts | 2 | 22-38s | |
| resume-history.test.ts | 1 | 18-20s | |
| headless.test.ts | 1 | 19-27s | |
| 其余 7 文件 | 11 | 各 5-12s | |

top4 合计 ≈ 串行 75%；spawn 占比 ≈ 13×4.6s/350s ≈ **17%**（15-25% 灰色区）。

## 结论与建议

1. **等待主导型套件**：8 核机器全程 ≤1.0 核，加 worker 不涨 CPU、显著降墙钟（W2→W6 省 40-60s）——与 #34"8 核峰值"结论存在方法/用例构成差异，建议 Dev 核查口径后统一采样方法
2. **方差即 flaky 温床**：live-delivery 单用例 54↔139s 波动是墙钟方差与超时风险的共同来源，等待收紧（与 #43 同批回归）是根治方向
3. **定标建议**：
   - 方案 A（零代码）：maxWorkers=6，实测 80-101s + CPU 未破 2 核预算 → 90s 目标边缘可达
   - 方案 B（根治）：等待收紧（live-delivery/streaming-truth 优先）+ W4 → 稳定 <90s
4. 归一化分桶：重流程（进程级多阶段）与轻流程分桶后基线待等待收紧后重测

## 补记（2026-08-02 晚，B 实现阶段）

### 假 key 注入（B 实现，QA 属主测试基建）

- 变更：`test/acceptance/pi-process.ts` spawn env 注入 ANTHROPIC/OPENAI/GEMINI 假 key（显式 env 优先覆盖）
- 证据：A/B 对照——无 key streaming→settled >150s 超时未到 vs 假 key 12.4s；T4 定向 2 文件/4 用例 73s 绿（原 124-219s）；全链 21/21 绿（W2 144s / W4 137s / W6 125s，均含负载方差）；断言语义不变（widget 正在发言 + agent_settled 正常触发，T4 注入节奏在 12.4s 窗口内满足）
- **环境依赖（Arch 记入要求）**：假 key 模式前提 = API 端点可达（401 需成功 HTTP 往返）。离线/不可达 → 连接错误落入 RETRYABLE → 静默退回 130s 级。兜底：V0 门禁留痕注明「假 key 模式需外网可达」+ 每 5 PR 全量校准发现时长漂移。B-2（本地 401 stub 经 base URL env）**不可行**：pi 子模块 5bc1c2c0 无 BASE_URL env 支持（静态核查）
- 影响面：acceptance 全链（注入影响所有跑法）；定向回归 live-delivery/streaming-truth 已过 + 全链已过

### src → acceptance 受影响文件映射（QA 定向判定工具，随影响面声明更新）

| src 模块 | 受影响 acceptance 文件 |
| --- | --- |
| creator/（群聊创建/恢复/命名/配额） | resume-history, history-paging, isolation, multi-process |
| character/（run/steer/光标/流式） | live-delivery, streaming-truth, speak-order, message-sync, message-fetch, headless |
| discovery/（descriptor/光标目录） | live-delivery, resume-history, isolation |
| protocol/（WS/事件契约） | streaming-truth, message-sync, headless |
| config/（tavern.json/配额） | resume-history, identity-consistency |
| 测试基建（pi-process.ts/configs） | 全链（按 v0.6 触发条件③ QA 判定） |

## 补记二（2026-08-02，#52 收口：归因纠错 + 零 LLM 定案）

### DeepSeek 泄漏归因（Dev 破案，QA 实证）

- **根因**：开发机 `PI_PROVIDER=deepseek` + `PI_MODEL=deepseek-v4-flash` + `DEEPSEEK_API_KEY` 经旧 spawn `{...process.env}` 全量透传进入测试 pi 进程；pi-test.sh --no-env 的 unset 名单（35 条）**不含**这三者 → 每次 run 都是**真实 DeepSeek API 调用**（User 的 key，计费）
- 23-26s 常态 = DeepSeek API 真实延迟；>150s 异常 = DeepSeek 慢/限流；早期 A/B「12.4s vs >150s」= API 方差（非 key 效应，QA 异时对照伪差——配对铁律 f9cd5b9 教训）
- **归因连带修正**：#32/#43「负载敏感型 flaky」主源实为外部 API 方差（白名单落地后消失）；#50 A2 语义 2（测试零 LLM）达成

### 白名单零 LLM 定案（#52，PM 裁决 + QA 实证）

- spawn 改白名单 env：PATH/HOME/TERM/LANG/LC_ALL/TMPDIR + PI_CODING_AGENT_DIR + PITAVERN_TEST + 闸门过滤后的测试显式 env（仅 PITAVERN_*、HOME 与基础名）
- 去 --no-env（白名单语义比 unset 严格：未列名一律不进，含未来新增 key 变量）
- **缺席形态**：不含任何 key 变量（PM 定案；配对实测空串/缺席均 ms 级无差异）
- options.env 闸门（PM 安全审查补强）：堵死测试显式传真实凭据通道

### 配对 A/B 结论（同时刻交替 3 轮，f9cd5b9 铁律）

| 形态 | settle（streaming→settled） |
| --- | --- |
| 白名单 + 缺席 key 变量 | 11-37ms（毫秒级） |
| 白名单 + 空串 key | 7-37ms（与缺席等价） |
| 白名单 + 假 key | ~700ms（一次真实 401 往返，无意义） |
| 旧模式（--no-env + 泄漏） | 23-26s（真实 DeepSeek 调用） |

### T4 重基线记录（User 批准）

- `run 活跃期 steer` 在 no-key 自动化下不可演练（run 毫秒级结束）→ 退出自动化覆盖，归真实环境验证 + #50 受控窗口补测（A5 范畴）
- T4 断言改为可观测语义：消息有界送达（光标 30s 内达 2）+ widget 状态机一致（streaming 点亮→熄灭，不悬挂）+ settle 幂等（光标稳定）
- streaming-truth A2 时序缺陷修复：join 完成（2 人在线广播）确认前移 baseline（原实现依赖慢 run 掩盖时序，白名单暴露；非产品回归）
- 扩展代码零改动，#38 产品语义不变（真实环境 run 秒级-分钟级）
