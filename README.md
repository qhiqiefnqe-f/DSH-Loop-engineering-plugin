# DeepSeek Harness Loop Engineering 插件

本目录是 Loop Engineering MVP 的可运行实现。它把 Harness 中持续产生的会话事件压缩成结构化工程轨迹，再把值得复用的经验整理为候选知识；候选知识必须经过检查后，才会以可被 Git 审查的 Markdown 文件进入团队 Wiki。

插件解决的核心问题是：保留“问题为什么发生、如何定位、怎样修复、用什么证据验证”，同时避免把冗长的完整会话直接塞进后续任务的上下文。

## 工作流程概览

```text
Harness 会话事件
    │
    ▼
EngineeringTrace（压缩后的工程轨迹）
    │  确定性证据门 → deepseek-v4-flash 复用价值判断
    ▼
KnowledgeCandidate（待审查知识候选）
    │
    ├─ Search Before Create：先检索已有知识
    │      ├─ 没有相似知识 → CREATE
    │      └─ 已有相似知识 → UPDATE
    │
    ▼
KnowledgePatch（确定性的 JSON 变更方案）
    │  证据检查 + 结构 lint + 人工 publish/dismiss
    ▼
wiki/**/*.md（规范知识，适合 Git diff 和代码审查）
    │
    └─ 后续任务按 L0 卡片 → L1 正文/章节 → L2 证据渐进读取
```

读取链同样采用两级门控：短文本、翻译等明显无关任务先由本地规则跳过；其余工程任务在第一步交给 `deepseek-v4-flash` 判断历史知识是否真的有帮助并改写检索词。检索内部并行计算精确字段、BM25 和元数据覆盖三路排名，用 RRF 融合；非精确命中且头部候选分差较小时，再由 Flash 对 L0 候选做条件式重排。工具产生明确错误后的第二次检索直接使用错误片段。轻量模型不可用时回退到 RRF 顺序，不阻塞主任务。

## 详细目录树

右侧注释说明每个目录或文件的职责；标有“运行时生成”的内容不会作为规范知识提交。

```text
loop-engineering-plugin/
├─ README.md                              # 当前文档：架构、目录、运行方法、工具和测试说明
├─ loop-engineering-plugin-PRD.md          # 本地资料（默认忽略）：产品需求、知识模型和验收条件
├─ 插件底层架构与链路分析.md               # 本地资料（默认忽略）：生命周期、领域概念和链路源码导读
├─ 简历内容.md                            # 本地资料（默认忽略）：按 STAR 法则整理的项目简历描述
├─ package.json                           # 插件包信息、Harness 工作区依赖、测试/评测/类型检查脚本
├─ tsconfig.json                          # TypeScript 编译与类型检查配置
├─ vitest.config.ts                       # Vitest 测试根目录和测试文件匹配规则
├─ cordis.yml                             # 将本地插件插入 Harness Web profile 的 Cordis patch 配置
├─ .gitignore                             # 忽略运行状态、日志等不应进入 Git 的派生文件
│
├─ src/                                   # 插件全部运行时代码
│  ├─ index.ts                            # Cordis 入口：配置、事件钩子、4 个模型工具、3 组斜杠命令
│  ├─ types.ts                            # 领域类型：知识页、轨迹、候选、Patch、会话工作集
│  ├─ text.ts                             # 文本基础能力：分词、哈希版本、内容提取、截断、ID slug
│  ├─ trace-builder.ts                    # 把追加式 Session Events 投影成紧凑 EngineeringTrace
│  ├─ decision-gate.ts                    # 低成本前置过滤、模型提示、JSON 校验和候选格式转换
│  ├─ flash-judge.ts                      # 通过 Harness LLM 服务调用 deepseek-v4-flash 并记录判断
│  ├─ retrieval.ts                        # BM25F、类型软路由、RRF 融合与条件重排
│  ├─ evaluation.ts                       # 合并 Wiki/JSONL 解析与 Recall@K 等离线指标
│  └─ wiki-store.ts                       # Wiki 核心：Markdown 解析、搜索、蒸馏、校验、发布和原子写入
│
├─ scripts/
│  ├─ demo-retrieval.ts                   # 对仓库 Wiki 执行 L0→L1→L2 的确定性端到端演示
│  └─ evaluate-retrieval.ts               # 用 wiki/temp 数据构建临时索引并输出检索指标
│
├─ tests/                                 # 不依赖真实 Web UI 的快速自动化测试
│  ├─ trace-builder.spec.ts               # 验证事件压缩、解决置信度和低价值任务过滤
│  ├─ decision-gate.spec.ts               # 验证轻量判断的前置过滤、JSON 校验和学习格式转换
│  ├─ retrieval.spec.ts                   # 验证 BM25F、类型路由、RRF 和条件重排
│  ├─ evaluation.spec.ts                  # 验证合并数据导入和 Recall@K 计算
│  └─ wiki-store.spec.ts                  # 验证检索、发布、驳回、Search Before Create 和重复合并
│
├─ wiki/                                  # 规范知识库；这里的 Markdown 才是团队可审查的知识真源
│  ├─ problem-pattern/                    # 问题模式：症状、触发条件、根因、诊断、方案和验证证据
│  │  ├─ problem.persisted-state-hydration-race.md
│  │  │                                    # 示例：持久化状态尚未 hydrate 就被读取的竞态
│  │  └─ problem.hmr-stale-plugin-config.md
│  │                                       # 示例：HMR 后派生资源仍保留旧配置
│  ├─ business-rule/                      # 业务规则：规则正文、例外、原因和审查证据
│  │  └─ rule.session-refresh-single-flight.md
│  │                                       # 示例：同一会话的并发刷新必须合并为一次请求
│  └─ architecture-decision/              # 架构决策：决策、背景、否决方案、权衡和证据
│     └─ decision.client-state-readiness-boundary.md
│                                          # 示例：异步客户端状态暴露显式就绪边界
│
├─ .loop-engineering/                     # 运行时生成；可重建的轨迹、候选、Patch 和反馈状态
│  ├─ traces/                             # 每个已完成 turn 的紧凑 EngineeringTrace JSON
│  ├─ candidates/                         # 待审、已发布或已驳回的 KnowledgeCandidate JSON
│  ├─ patches/                            # 针对 Wiki 的确定性 KnowledgePatch JSON
│  ├─ decisions/                          # deepseek-v4-flash 检索/学习判断的 JSONL 审计记录
│  └─ feedback/                           # knowledge_feedback 追加写入的 JSONL 反馈
│
├─ node_modules/                          # pnpm 工作区依赖链接；安装依赖时生成
├─ tsconfig.tsbuildinfo                   # TypeScript 增量检查缓存；类型检查时生成
├─ dsh-loop.stdout.log                    # 后台 Web 服务标准输出；运行时生成
└─ dsh-loop.stderr.log                    # 后台 Web 服务错误输出；运行时生成
```

根目录 Markdown 说明资料默认由 `.gitignore` 排除，远程仓库只保留 `README.md`；`wiki/**/*.md` 是插件运行所需的规范知识数据，仍正常纳入版本控制。

## 核心模块如何协作

### `index.ts`：把插件接入 Harness

这是 Cordis 加载的唯一入口。它负责解析配置、初始化 `WikiStore`、注册系统提示词、注册知识工具与审查命令，并监听两个关键事件：

- `session/event`：持续把会话事件交给 `TraceBuilder`；turn 完成后写入轨迹，并为高价值任务自动生成候选知识。
- `agent/pre-step`：在任务第一步或工具出现强错误证据后执行低成本检索，把 L0 卡片作为插件来源的会话消息注入当前任务。

两个钩子都先执行便宜、可解释的硬门禁，再只对语义判断调用 `deepseek-v4-flash`。模型只拥有“建议检索”和“建议生成候选”的权限；它不能发布或驳回知识。

### `decision-gate.ts` 与 `flash-judge.ts`：轻量语义判断

`decision-gate.ts` 负责过滤明显无关输入、构造最短必要提示，并严格校验模型返回的 JSON。`flash-judge.ts` 通过 Harness 已注册的 `llm` 服务调用 `deepseek-official/deepseek-v4-flash`，限制输出 token 和超时时间，并把决定写入 `.loop-engineering/decisions/flash-judgements.jsonl`。学习判断只接收已经完成且有证据的紧凑轨迹，不发送整段聊天历史。

### `retrieval.ts`：BM25F、多路融合与条件式重排

搜索同时产生精确字段排名、BM25F 排名和元数据 token 覆盖排名，再使用 Reciprocal Rank Fusion 合并不同量纲的名次。BM25F 对 ID、标题、别名、触发条件、摘要、scope、类型核心章节和普通正文分别统计词频与长度；问题模式优先投影症状/根因/诊断，业务规则优先投影规则/例外，架构决策优先投影决策/上下文。查询中的故障、约束或架构信号会对相应文档类型做小幅软提升，但不会硬过滤其他类型。精确命中的第一名直接返回；否则只有前两名分差不超过配置阈值时才把最多若干张 L0 卡片交给 Flash 重排。

当前 Harness 没有通用 Embedding 服务，因此本版本没有把向量检索伪装成 Dense 通道。Dense 指将查询和知识片段编码成浮点向量后按余弦相似度召回，可在后续有正式 Embedding provider 时作为第四路加入 RRF。

### `trace-builder.ts`：只保留工程上有用的信息

它不会复制整段对话，而是从事件流中提取任务描述、错误、读写文件、命令、测试结果、用户确认和最终结果。turn 结束时根据“是否修改、测试是否通过、用户是否确认、最终结果是否明确”等信号计算解决置信度。

### `wiki-store.ts`：知识库和发布门禁

它直接读取 `wiki/**/*.md`，解析 YAML front matter，并对正文必需章节做结构检查；`wiki/temp` 是离线评测输入目录，不参加正式知识扫描。搜索采用可离线、可解释的 BM25F，再叠加类型路由、生命周期和置信度权重。写入时始终先生成候选与 Patch，只有通过证据和结构门禁的 Patch 才能发布。

### `text.ts`：统一文本处理

这里集中处理中英文分词、中文二元词切分、稳定短哈希、Harness 内容块文本提取、上下文长度限制和文件安全 ID。集中实现可以避免搜索、轨迹和发布各自使用不同规则。

### `types.ts`：领域数据约定

该文件定义模块之间传递的数据结构。阅读代码时建议先从这里理解 `EngineeringTrace → KnowledgeCandidate → KnowledgePatch → KnowledgeUnit` 的变化过程。

## 完整演示：从编译到检索

下面是一条不依赖 Web UI、API Key 或外部模型的可复现链路。前提是本插件目录位于 DeepSeek Harness 工作区根目录下的 `loop-engineering-plugin/`；工作区使用 Node.js 22 与 pnpm，并已完成依赖安装。

### 1. 安装、编译检查和测试

在 Harness 仓库根目录依次执行：

```powershell
Set-Location D:\code\deepseek-harness
pnpm install
pnpm --dir .\loop-engineering-plugin run build
pnpm --dir .\loop-engineering-plugin test
```

本项目直接通过 `tsx` 运行 TypeScript，所以 `build` 执行的是严格的 TypeScript 编译期检查，不生成重复的 JavaScript 产物。成功标志是 `build` 退出码为 0，随后看到全部测试通过。

### 2. 输入一条真实问题并检索

继续在 Harness 根目录执行：

```powershell
pnpm --dir .\loop-engineering-plugin run demo:retrieval -- `
  --query "浏览器冷启动或刷新后，登录状态变成 undefined，认证信息丢失" `
  --limit 3
```

这条命令的输入就是 `--query` 后的自然语言。内部实际链路为：

```text
自然语言输入
  → 中英文分词与类型软路由
  → exact / BM25F / metadata 三路排名
  → RRF 融合与生命周期、置信度加权
  → L0 卡片（最多 3 条）
  → 展开第一名的 L1 核心章节（Diagnosis / Rule / Decision）
  → 展开第一名的 L2 Evidence
```

预期第一名是 `problem.persisted-state-hydration-race`。输出中的 `通道` 表示该知识由哪些召回路径命中；L1 会按知识类型展开 `Diagnosis`、`Rule` 或 `Decision` 核心章节，L2 则给出测试或会话证据。脚本只读 `wiki/`，临时状态写到系统临时目录并在结束时删除，因此不会修改仓库。

可以换一条输入验证不同知识类型，例如：

```powershell
pnpm --dir .\loop-engineering-plugin run demo:retrieval -- `
  --query "refresh token single flight" `
  --limit 2
```

这条输入精确命中业务规则的别名，预期第一名会变为 `rule.session-refresh-single-flight`，并显示 `exact+bm25+metadata` 三个通道。若结果为空，命令以退出码 2 结束；参数缺失或 `--limit` 非正整数则直接报错，以便 CI 识别失败。

### 3. 接入 Harness Web UI 验证自动检索

确定本地演示通过后，把 [`cordis.yml`](./cordis.yml) 中三个 `D:/code/deepseek-harness` 路径改成实际 Harness 绝对路径，再执行“启动插件”一节的命令。在 Web UI 新会话中输入：

```text
浏览器冷启动后 AuthProvider 读取到 undefined，刷新后登录状态丢失，请帮我排查。
```

第一步会先经过本地前置过滤，再由 Flash 判断是否需要历史知识；通过后插件把 L0 卡片注入当前任务。模型只有确认相关时才调用 `knowledge_read` 展开章节或证据。即使 Flash 超时，主任务仍会回退到确定性的检索结果而不是失败。

## 知识类型与生命周期

MVP 支持三类知识：

- `problem-pattern`：可复用的问题模式；有完成的修复与通过测试时可成为 `verified`。
- `business-rule`：业务规则；必须由人审查，发布后通常为 `reviewed`。
- `architecture-decision`：架构决策；必须由人审查，发布后通常为 `reviewed`。

规范知识支持以下生命周期：

- `draft`：草稿，尚未完成审查。
- `reviewed`：已人工审查，但没有达到问题模式的强验证条件。
- `verified`：有较强工程证据支持的已验证知识。
- `stale`：可能陈旧，只能作为线索。
- `superseded`：已经被其他知识替代，不参与普通搜索。
- `archived`：已归档，不参与普通搜索。

## 启动插件

在 DeepSeek Harness 仓库根目录执行：

```powershell
Set-Location D:\code\deepseek-harness
pnpm dsh web --patch ./loop-engineering-plugin/cordis.yml
```

如果不希望 `pnpm` 再次整理整个工作区，可以直接使用源码 CLI 入口：

```powershell
node --import tsx/esm apps/cli/src/bin.ts web --patch ./loop-engineering-plugin/cordis.yml
```

启动后打开 [http://127.0.0.1:3080](http://127.0.0.1:3080)。

## 模型可用工具

插件向模型注册 4 个工具：

- `knowledge_search`：按自然语言或标识符搜索知识，只返回紧凑 L0 卡片。
- `knowledge_read`：显式读取一个知识页、一个章节（L1）或 Evidence（L2）。
- `knowledge_related`：沿 `related` 元数据导航，只返回关联知识的 L0 卡片。
- `knowledge_feedback`：记录 `helpful`、`partially-helpful`、`irrelevant` 或 `misleading` 反馈。

自动检索不会直接注入全文；模型必须先看到 L0 卡片，再按需要读取相关章节或证据。

## Web UI 审查命令

Web UI 命令面板提供受控写入路径：

```text
/save-knowledge [type | title | summary | aliases | triggers]
/knowledge-candidates
/knowledge-review publish <candidate-id>
/knowledge-review dismiss <candidate-id>
/knowledge-review 发布 <candidate-id>
/knowledge-review 驳回 <candidate-id>
```

其中 `type` 可以是：

```text
problem-pattern
business-rule
architecture-decision
```

模型生成的文字不会直接覆盖规范 Markdown。`/save-knowledge` 只生成候选和 Patch；`publish` 才会应用已经检查过的确定性变更，`dismiss` 则只改变候选状态而不修改 Wiki。

人工审查建议先运行 `/knowledge-candidates` 获取 ID，再打开 `.loop-engineering/candidates/<ID>.json` 和对应 Patch 检查标题、摘要、证据、目标文件和 `verification`。发布后应看到 `wiki/` 新增或更新 Markdown，候选状态变为 `published`；驳回后 Wiki 必须保持不变，候选状态变为 `dismissed`。

## 配置说明

默认配置位于 [`cordis.yml`](./cordis.yml)：

- `wikiDir`：规范 Markdown Wiki 的路径。
- `stateDir`：轨迹、候选、Patch 和反馈的派生状态路径。
- `automaticRetrieval`：是否启用任务开始/强错误证据后的自动检索。
- `maxAutomaticRetrievalsPerTask`：单个会话最多自动检索次数。
- `maxSearchResults`：一次检索最多返回的知识卡片数。
- `duplicateThreshold`：Search Before Create 判断相似知识的相关度门槛。
- `autoCandidateThreshold`：自动生成候选所需的最低解决置信度。
- `maxCardChars`：单张 L0 卡片的字符上限。
- `maxContextChars`：一次自动注入的总字符上限。
- `lightweightJudge`：是否启用轻量模型语义判断；关闭后使用纯确定性策略。
- `judgeProvider` / `judgeModel`：判断模型路由，默认 `deepseek-official/deepseek-v4-flash`。
- `judgeMaxTokens`：单次判断最大输出 token，默认 320。
- `judgeTimeoutMs`：单次判断最长等待时间，默认 12000 毫秒。
- `rrfK`：RRF 排名平滑常数，默认 60。
- `exactRrfWeight` / `bm25RrfWeight` / `metadataRrfWeight`：三路召回的融合权重。
- `conditionalRerank`：是否启用条件式 Flash 重排序。
- `rerankCandidateLimit`：重排序最多读取的 L0 候选数，默认 6。
- `rerankMarginThreshold`：前两名展示相关度差小于该值时触发重排，默认 0.12。

`duplicateThreshold` 现在只作用于独立的候选字段相似度，不再使用每次结果集内部归一化的展示分数，避免“任何弱命中第一名都等于 1”导致错误 UPDATE。

## 批量验证与检索评测

从仓库根目录执行：

```powershell
pnpm --dir .\loop-engineering-plugin run build
pnpm --dir .\loop-engineering-plugin test
```

当前测试预期为：

```text
Test Files  5 passed (5)
Tests       19 passed (19)
```

自动化测试覆盖轨迹压缩、两级判断门、模型 JSON 校验、BM25F、类型软路由、多路 RRF 融合、条件式重排、合并评测数据导入、弱词法重叠不误判重复、L0/L1/L2 渐进检索、人工发布/驳回、证据生命周期和 Search Before Create。

把合并 Wiki 放在 `wiki/temp/wikis.md`、JSONL 评测集放在 `wiki/temp/evaluate.md` 后执行：

```powershell
node --import tsx/esm scripts/evaluate-retrieval.ts `
  --wiki wiki/temp/wikis.md `
  --wiki wiki/temp/wikis2.md `
  --eval wiki/temp/evaluate.md `
  --split test `
  --k 5
```

`--wiki` 可以重复传入，脚本会在内存合并并检查跨文件重复 ID。如果数据包含 `test` split，未指定 `--split` 时默认只评测 test；传 `--split all` 可评测整个文件。脚本输出宏平均 `Recall@5`、主要相关知识召回率、HitRate、无答案误召回率和前 20 个漏召回样本。

当前 30 篇合成 Wiki、320 条查询的结果如下：test split 共 160 条，其中 138 条有答案、22 条无答案，`Recall@5=0.9082`、`Primary Recall@5=0.9118`、`HitRate@5=0.9348`；全量 320 条中 280 条有答案、40 条无答案，`Recall@5=0.8899`、`Primary Recall@5=0.8935`、`HitRate@5=0.9214`。两组无答案误召回率均为 `1.0`，说明下一阶段需要增加校准后的拒答阈值。
