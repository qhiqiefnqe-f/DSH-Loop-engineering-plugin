明白。上一版的问题确实是把“模块列表”写成了“PRD 信息架构”，导致看起来像技术设计文档的目录，而不是围绕产品核心能力展开。

我建议这版固定为 **5 个一级标题**，严格总—分—总：

1. 产品定义与总体架构  
2. 基于 LLM Wiki 的团队知识库：输入触发、编译与维护链路  
3. Agent 知识检索：触发条件、检索链路与上下文组装  
4. Token 开销控制：低成本知识闭环  
5. 产品范围、技术架构与验收标准  

下面给出重构后的完整 PRD。

---

# 1. 产品定义与总体架构

## 1.1 产品名称

**Loop Engineering for DeepSeek Harness**

建议插件名称：

```text
dsh-loop-engineering
```

产品定位：

> 基于 LLM Wiki，为 DeepSeek Harness 构建一个能够持续沉淀、复用和迭代团队工程知识的研发知识闭环插件。

Loop Engineering 不试图替代 DeepSeek Harness 自身的 Agent Loop，也不是简单增加一个 Memory Tool。它关注的是 Agent 跨任务工作的长期信息损失问题：一个 Agent 今天花大量步骤定位出的业务规则、架构约束和 Bug 根因，如果 Session 结束后没有被有效抽象和沉淀，那么未来 Agent 遇到相似问题时仍然需要重新探索。

因此产品目标是把：

```text
单次研发经验
```

转化为：

```text
团队长期可复用知识
```

再让这些知识在未来任务中：

```text
在正确时机
以正确粒度
用尽可能低的 Token 成本
重新进入 Agent Context
```

最终形成：

```text
研发
 ↓
产生经验
 ↓
编译知识
 ↓
团队 Wiki
 ↓
未来 Agent 检索
 ↓
辅助研发
 ↓
产生新证据
 ↓
反向更新 Wiki
```

即真正意义上的 **Engineering Learning Loop**。

---

## 1.2 产品核心问题

Loop Engineering 聚焦解决三个问题。

第一，**什么信息值得成为团队知识，以及如何长期维护这些知识？**

不是把 Session 做摘要，而是从研发过程中识别真正具有复用价值的信息，通过 LLM Wiki 将多个原始事件编译成稳定的 Business Rule、Problem Pattern 和 Architecture Decision。

第二，**Agent 什么时候应该查询知识，以及如何找到真正相关的信息？**

不能把整个 Wiki 长期塞入 Prompt，也不能完全依赖 Agent “想起来才搜”。插件需要根据任务开始、新错误出现、重复失败等事件主动触发检索，同时允许 Agent 自主导航 Wiki。

第三，**如何让知识闭环本身足够便宜？**

如果每轮都进行 RAG、每个 Session 都让强模型重新总结几十万 Token，那么知识系统本身就会成为成本瓶颈。因此整个系统需要围绕结构化 Trace、Candidate Gate、Progressive Disclosure、Patch 更新和 Working Set 设计。

---

## 1.3 整体系统架构

整个插件由 Write Path 和 Read Path 两条主链路组成。

```text
                  DeepSeek Harness
                         │
             Session Event / Agent Event
                         │
            ┌────────────┴────────────┐
            │                         │
            ▼                         ▼
       WRITE PATH                READ PATH
            │                         │
 Engineering Observer            Task Context
            │                         │
 Engineering Trace           Retrieval Trigger
            │                         │
 Candidate Detection        Knowledge Navigator
            │                         │
 Knowledge Distillation      Knowledge Cards L0
            │                         │
 Search Existing Wiki         Agent Selection
            │                         │
 Knowledge Compiler          Wiki Detail L1
            │                         │
 Knowledge Patch          Evidence L2 if needed
            │                         │
 Evidence Verification      Context Assembly
            │                         │
 Review / Lint                Agent Context
            │                         │
            ▼                         │
     Engineering LLM Wiki ◄───────────┘
            │
            ▼
     Usage / Outcome Feedback
            │
            └──────► Knowledge Revalidation
```

系统的数据分为四层。

**Raw Evidence 层**保存 Session、测试结果、Diff、Issue、Commit 等事实数据，是不可变证据。

**Canonical Knowledge 层**保存 LLM Wiki，是团队真正长期维护的知识资产。

**Retrieval Index 层**保存 FTS、Embedding、Graph、Knowledge Card 等派生数据，可以随时重建。

**Schema 层**规定知识类型、Frontmatter、生命周期、Lint 和 Review Policy。

核心约束是：

> Raw 是事实源，Wiki 是知识源，Index 只是访问知识的手段。

---

# 2. 基于 LLM Wiki 的团队知识库：输入触发、编译与维护链路

## 2.1 链路整体架构

团队知识库的 Write Path 不采用：

```text
Session
 ↓
LLM 总结
 ↓
Markdown
```

而采用完整的知识编译链路：

```text
Engineering Activity
        ↓
Trigger Detection
        ↓
Engineering Observer
        ↓
Engineering Trace
        ↓
Candidate Gate
        ↓
Knowledge Candidate
        ↓
Search Existing Wiki
        ↓
Knowledge Compiler
        ↓
CREATE / UPDATE / MERGE / LINK / CONFLICT / IGNORE
        ↓
Knowledge Patch
        ↓
Evidence Verification
        ↓
Structural / Semantic Lint
        ↓
Risk-based Review
        ↓
Publish
        ↓
Engineering LLM Wiki
```

关键思想是：

> **一次研发任务只是 Source，而不是 Wiki Page。**

比如三个 Bug：

```text
AuthProvider cold reload 白屏

SubscriptionProvider 刷新 undefined

UserStore 刷新状态丢失
```

不应该形成三篇 Bug 日志。

知识编译器应该识别它们背后的共同模式，并逐渐维护成：

```text
Persisted State Hydration Race
```

其中不断增加：

```text
Symptoms
Trigger Conditions
Root Cause
Diagnosis
Solution Pattern
Known Occurrences
Verification
```

这正是 LLM Wiki 与传统“Session Memory”的本质区别。

---

## 2.2 知识库保存哪些内容

MVP 只维护三种一级知识类型。

### Business Rule

回答：

> 业务到底应该如何运行？

重点记录代码本身无法充分表达的信息：

```text
业务语义
状态转换
业务约束
例外情况
Invariant
规则背后的原因
```

例如：

```text
Subscription Cancellation

Rule

用户取消自动续费后，
当前已经支付的计费周期仍然保留权益。

Exception

风控退款立即终止权益。

Reason

取消订阅代表“不再续费”，
并不代表撤销已经完成的购买。
```

真正有价值的是 `Why + Exception`，而不是简单复制代码行为。

### Problem Pattern

回答：

> 这一类问题为什么发生，以及未来应该如何诊断和解决？

标准结构：

```text
Problem
Symptoms
Trigger Conditions
Root Cause
Diagnosis Path
Solution Pattern
Verification
Known Occurrences
```

例如：

```text
Persisted State Hydration Race

Symptoms
- cold reload 白屏
- persisted value 为 undefined
- SPA navigation 正常

Root Cause
组件初始化早于 persisted store hydration。

Diagnosis
1. 比较 cold reload 与 SPA navigation
2. 检查 hydration lifecycle
3. 检查消费组件初始化时机

Solution Pattern
建立 hydration readiness gate。
```

重点不是保存某次：

```text
AuthProvider.tsx 改了第 73 行
```

而是抽象为未来其它组件、其它状态管理框架仍然可以复用的问题模式。

### Architecture Decision

回答：

> 为什么代码或系统必须这样设计？

记录：

```text
模块边界
数据 ownership
依赖关系
架构 invariant
技术选型理由
Trade-off
Rejected Alternative
```

例如：

```text
Authentication State Ownership

Decision

UserStore 是用户登录状态的唯一事实来源。

Payment 页面不能直接修改会员状态。

Reason

支付状态只是过程状态，
最终权益必须以后端 User 状态为准。
```

---

## 2.3 明确禁止自动沉淀的内容

以下内容默认不进入 Wiki：

```text
完整 Session
Agent 思考过程
所有 Tool Call
完整 Git Diff
一次性调试日志
普通 React/Vue 通识
通过代码搜索即可快速得到的事实
未验证猜测
简单 typo
临时机器环境问题
纯格式调整
```

判断知识是否值得沉淀，需要满足三个核心条件：

```text
未来重复出现概率较高
+
重新发现成本较高
+
当前代码无法完整表达
```

同时：

```text
必须存在可追溯 Evidence
```

---

## 2.4 知识输入触发条件

知识编译不是每个 `turn/end` 都执行，而由明确事件触发。

### 任务被可靠判定为解决

这是 Problem Pattern 最主要来源。

插件通过 Resolution Detector 综合判断：

```text
代码修改
测试变化
Build 结果
Regression Test
Agent 最终状态
用户确认
```

例如：

```text
以前失败的测试现在通过     强正信号
Build 成功                 正信号
用户确认“已经好了”         强正信号

仍有测试失败               强负信号
用户明确说“还是不行”       否决信号
```

得到：

```text
resolutionConfidence
```

高置信度才进入 Candidate Detection。

这里必须明确：

```text
turn/end ≠ task solved
```

### 对话中出现新的业务约束

例如用户告诉 Agent：

```text
取消订阅只影响下一计费周期，
当前周期权益不能立即关闭。
```

插件识别成：

```text
Business Rule Candidate
```

即使当前任务不是 Bug，也可以进入知识编译。

### 出现明确架构决策

例如：

```text
支付模块以后只能通过 BFF，
不能直接访问 payment-service。
```

识别为：

```text
Architecture Decision Candidate
```

### 用户主动保存

支持：

```text
/save-knowledge
```

或者：

```text
把刚才这个结论加入团队知识库。
```

显式触发可以绕过“是否值得”的自动判断，但不能绕过 Evidence、Conflict 和 Review。

后续版本可继续支持 PR、Issue、Incident、RFC 等外部 Source。

---

## 2.5 Engineering Observer：从 Session 提取事实

DeepSeek Harness 已有 durable Session Event，因此插件通过监听 Session，而不是侵入 Agent Loop。

Observer 关注：

```text
user/message
assistant/message
tool/call
tool/result
step/*
turn/*
```

但不会把这些事件原样交给 LLM。

程序先生成：

```ts
interface EngineeringTrace {
  task: TaskSummary

  errors: EvidenceRef[]

  filesRead: string[]

  filesChanged: string[]

  commands: CommandResult[]

  tests: TestResult[]

  finalDiffs: EvidenceRef[]

  userConfirmations: string[]

  finalOutcome?: string
}
```

例如一个 50K Token Session 最终可能压缩成：

```text
Task
登录页 cold reload 白屏

Error
AuthProvider.tsx:73
currentUser undefined

Files
AuthProvider.tsx
userStore.ts

Change
增加 hydration readiness check

Verification
login.spec.ts
FAIL → PASS
```

这既是知识编译输入，也是后续 Evidence 索引。

---

## 2.6 Candidate Gate：先判断值不值得调用 LLM

Trace 生成后先经过低成本 Gate。

判断：

```text
是否产生新 Root Cause
是否产生业务约束
是否产生架构决策
是否有复用价值
是否已有强 Evidence
是否只是一次性问题
```

输出：

```ts
{
  worthDistilling: true,
  types: ["problem-pattern"],
  confidence: 0.91
}
```

只有 `worthDistilling = true` 才调用 Knowledge Distiller。

这样大量：

```text
改文案
改 CSS
格式化代码
普通功能实现
```

不会产生额外知识编译成本。

---

## 2.7 Knowledge Distiller：从 Trace 到 Candidate

Distiller 的职责不是生成最终 Wiki，而是提出一个**待验证的知识 Claim**。

输出：

```ts
interface KnowledgeCandidate {
  type: KnowledgeType

  title: string

  summary: string

  structuredContent: unknown

  aliases: string[]

  triggers: string[]

  scope: KnowledgeScope

  evidence: EvidenceRef[]

  confidence: number
}
```

Problem Pattern Candidate 例如：

```text
Title
Persisted State Hydration Race

Symptoms
cold reload state missing

Root Cause
consumer initialization occurs before hydration

Solution Pattern
hydration readiness gate

Evidence
session:192
test:login.spec.ts
diff:AuthProvider.tsx
```

Candidate 只是：

> “系统认为可能存在这样一条知识。”

不是最终事实。

---

## 2.8 Search Before Create：禁止知识膨胀

Candidate 创建后必须先检索现有 Wiki。

```text
Candidate
 ↓
Wiki Search
 ↓
Top Related Knowledge
```

由 Compiler 决定：

```text
CREATE
UPDATE
MERGE
LINK
CONFLICT
IGNORE
```

例如新的 Pinia Hydration Bug，与 Wiki 中：

```text
problem.persisted-state-hydration-race
```

高度相关。

正确结果是：

```text
UPDATE
```

新增：

```text
Known Occurrence
Framework-specific Notes
Evidence
```

而不是创建：

```text
pinia-hydration-bug.md
```

这是保证 Wiki 长期质量最关键的机制之一。

---

## 2.9 Knowledge Patch：LLM 不直接覆盖 Wiki

Compiler 输出结构化 Patch。

```ts
interface KnowledgePatch {
  operation:
    | "create"
    | "update"
    | "merge"
    | "link"
    | "conflict"
    | "archive"

  targets: string[]

  changes: KnowledgeChange[]

  evidence: EvidenceRef[]

  confidence: number
}
```

例如：

```text
UPDATE
problem.persisted-state-hydration-race

+ Trigger:
  Vue Router cold reload

+ Known Occurrence:
  AuthProvider

+ Evidence:
  session:192

Confidence:
0.87 → 0.94
```

最终文件修改由确定性的 Patch Engine 完成，而不是 LLM 重新生成整个 Markdown。

这样更：

```text
可审查
可回滚
可 Diff
低 Token
不容易破坏历史内容
```

---

## 2.10 Evidence Verification 与知识发布

Compiler 生成 Claim 后采用：

```text
Claim First
 ↓
Evidence On Demand
```

Verifier 只读取支持该 Claim 所需要的：

```text
相关 Diff
相关 Error
相关 Test
相关 User Statement
```

输出：

```text
SUPPORTED
PARTIALLY_SUPPORTED
UNSUPPORTED
CONFLICTING
```

随后依次执行：

```text
Structural Lint
↓
Semantic Lint
↓
Risk Policy
↓
Review / Auto Publish
```

其中 Structural Lint 不调用模型，检查：

```text
Schema
Knowledge ID
Source
Link
Lifecycle
Required Section
Duplicate ID
```

Semantic Lint 才处理：

```text
重复知识
语义冲突
Evidence 不足
Summary 与正文不一致
知识是否过宽
```

---

## 2.11 Wiki 页面规范与生命周期

Canonical Wiki 采用 Markdown + YAML Frontmatter。

例如：

```yaml
---
id: problem.persisted-state-hydration-race
type: problem-pattern
title: Persisted State Hydration Race

summary: >
  Cold reload 时组件可能在 persisted state
  hydration 完成前读取状态。

aliases:
  - hydration race
  - persisted state race

scope:
  repos:
    - frontend-web
  domains:
    - authentication

confidence: 0.94
lifecycle: verified

sources:
  - session:192
  - test:login.spec.ts

created_at: 2026-08-16
updated_at: 2026-08-16
last_verified_at: 2026-08-16
---
```

正文按知识类型固定模板。

Problem Pattern：

```text
Problem
Symptoms
Trigger Conditions
Root Cause
Diagnosis
Solution Pattern
Verification
Known Exceptions
Related Knowledge
Evidence
```

生命周期：

```text
draft
 ↓
reviewed
 ↓
verified
 ↓
stale
 ↓
superseded / archived
```

并且：

```text
updated_at
```

与：

```text
last_verified_at
```

必须分开。

知识可以刚被重新排版，但实际正确性已经一年没有重新验证。

---

## 2.12 风险级别与人工审核

不同知识采用不同自动化策略。

| 类型 | Auto Draft | Auto Publish |
|---|---:|---:|
| Bug occurrence | 是 | 可以 |
| Problem Pattern | 是 | 强证据情况下可以 |
| Business Rule | 是 | 否 |
| Architecture Decision | 是 | 否 |

例如：

```text
Regression Test 明确证明的 Bug Pattern
```

可以高度自动化。

但：

```text
退款规则
权限规则
架构边界
```

必须经过团队成员 Review。

因此团队版 LLM Wiki 的原则应当是：

> **LLM owns Draft，Governance owns Publish。**

---

# 3. Agent 知识检索：触发条件、检索链路与上下文组装

## 3.1 链路整体架构

Read Path 的核心不是传统：

```text
User Query
 ↓
Vector Search
 ↓
Raw Chunks
 ↓
Prompt
```

因为 LLM Wiki 已经提前完成知识编译。

Agent 搜索的是：

```text
Compiled Knowledge
```

而不是历史 Session Fragment。

完整链路：

```text
Current Agent Task
       ↓
Retrieval Trigger Detector
       ↓
Task Context Extraction
       ↓
Query Planner
       ↓
┌──────────┬───────────┬─────────────┐
│ FTS/BM25 │ Semantic  │ Metadata    │
└──────────┴─────┬─────┴─────────────┘
                 ↓
            Candidate Merge
                 ↓
          Lightweight Rerank
                 ↓
    Scope / Lifecycle / Permission Filter
                 ↓
        Top 3~5 Knowledge Cards
                 ↓
          Knowledge Working Set
                 ↓
          Agent decides to expand
                 ↓
             Wiki Page / Section
                 ↓
            Context Assembler
                 ↓
             Agent Context
```

核心原则：

> **自动系统负责让 Agent 不忘记查知识，Agent 自己负责决定需要深入读哪条知识。**

---

## 3.2 检索触发条件一：Task Start

用户开始新的研发任务时，插件先做轻量 Task 分类。

例如：

```text
刷新页面之后用户状态偶尔消失，
帮我查一下。
```

提取：

```text
intent: debug

domain:
authentication

symptoms:
state disappears after reload

entities:
user state
reload

concept hints:
persistence
initialization
```

高价值任务自动检索：

```text
Debug
已有业务功能修改
已有模块 Feature
架构调整
线上故障
复杂业务逻辑
```

低价值任务不检索：

```text
格式化 JSON
改按钮颜色
解释 JS API
简单文案调整
```

---

## 3.3 检索触发条件二：Strong New Evidence

很多 Bug 初始描述信息量很低。

例如：

```text
登录页白屏。
```

此时自动检索可能没有结果。

但 Agent 调试后出现：

```text
Cannot read properties of undefined

AuthProvider.tsx:73

cold reload only
```

检索价值突然大幅提高。

因此以下事件触发二次检索：

```text
新的 Error Code
新的 Stack Trace
新的关键文件
新的 Runtime Symptom
新的模块
新的 Root Cause Hypothesis
```

这种方式比“每一步重新搜索”精确得多。

---

## 3.4 检索触发条件三：Repeated Failure

如果 Agent：

```text
方案 A
↓
失败

方案 B
↓
仍然失败
```

说明当前 Context 不足。

触发：

```text
Alternative Knowledge Retrieval
```

优先检索：

```text
Known Failure Modes
Exceptions
Alternative Patterns
Historical Similar Bugs
Architecture Constraints
```

自动检索次数应设置上限，例如：

```text
maxAutomaticRetrievalsPerTask = 3
```

避免 Agent 进入检索循环。

---

## 3.5 检索触发条件四：Agent 主动调用

模型始终可使用：

```text
knowledge_search
knowledge_read
knowledge_related
```

例如 Agent 判断：

```text
这里看起来可能有团队业务规则。
```

即可：

```text
knowledge_search({
  query: "subscription cancellation entitlement"
})
```

自动 Retrieval 和 Agent Retrieval 并存。

---

## 3.6 Retrieval Gate：哪些情况下明确不检索

满足以下情况直接 Skip：

```text
没有团队项目上下文

问题属于通用编程知识

刚完成等价查询

没有任何新 Evidence

相关 Knowledge 已经进入 Working Set

任务已经进入最终收尾

自动 Retrieval 达到预算上限
```

检索本身也必须是一个受控能力，而不是背景常驻操作。

---

## 3.7 Task Context Extraction

搜索不直接使用整段 Conversation。

先得到：

```ts
interface TaskContext {
  intent: TaskIntent

  semanticQuery: string

  entities: string[]

  errorCodes: string[]

  files: string[]

  modules: string[]

  domains: string[]

  symptoms: string[]
}
```

一部分通过程序提取：

```text
文件路径
函数名
错误码
模块名
Stack Trace
```

只有：

```text
semanticQuery
concept expansion
```

等真正需要理解语义的部分才考虑使用小模型。

---

## 3.8 Hybrid Retrieval

Engineering Wiki 不适合只做 Embedding。

因为：

```text
ERR_PNPM_OUTDATED_LOCKFILE
AuthProvider
useOrderStore
payment-service
```

这种精确标识符的关键词检索非常重要。

因此 MVP 检索组合：

```text
FTS / BM25
+
Metadata Filter
```

V1 增加：

```text
Semantic Search
+
Graph Navigation
```

FTS 负责：

```text
错误码
业务术语
函数名
组件名
路径
API
```

Semantic Search 负责：

```text
“刷新之后登录状态没了”
```

匹配：

```text
“Persisted State Hydration Race”
```

Metadata 负责约束：

```text
repo
module
domain
knowledge type
lifecycle
```

---

## 3.9 Rerank 与知识可信度

相关性不能只看语义分数。

最终排序应综合：

```text
Query Relevance

Scope Match

Lifecycle

Confidence

Recency / Verification

Historical Helpfulness
```

例如两篇知识同样相似：

```text
K1
scope = 当前 repo
verified
confidence = 0.95

K2
scope = 旧 repo
stale
confidence = 0.61
```

显然 K1 应优先。

---

## 3.10 Knowledge Card：第一层检索结果

Search 只返回 L0。

```ts
interface KnowledgeCard {
  id: string

  title: string

  type: KnowledgeType

  summary: string

  scope: KnowledgeScope

  lifecycle: Lifecycle

  confidence: number

  relevance: number
}
```

例如：

```text
Relevant Team Knowledge

K102
Persisted State Hydration Race
Problem Pattern

Cold reload may access persisted state
before hydration completes.

Confidence: 94%
Relevance: High


K31
Authentication Initialization Lifecycle
Architecture Decision

Auth initialization depends on UserStore readiness.

Confidence: 97%
Relevance: Medium
```

Top 3~5 即可。

---

## 3.11 L0 / L1 / L2 Progressive Disclosure

知识分三层暴露。

### L0 — Knowledge Card

用于：

```text
“有哪些知识可能相关？”
```

约：

```text
50~150 tokens
```

### L1 — Wiki Page / Section

只有 Agent 判断相关时：

```text
knowledge_read(K102)
```

读取完整内容。

或：

```text
knowledge_read(
  K102,
  section = "Diagnosis"
)
```

只读取对应 Section。

### L2 — Evidence

例如：

```text
Session
Commit
Diff
Test Log
Issue
```

默认不进入 Context。

只有 Agent 或 Verifier 怀疑知识时才读。

形成：

```text
Search
 ↓
L0

Understand
 ↓
L1

Verify
 ↓
L2
```

---

## 3.12 Knowledge Working Set

每个任务维护：

```ts
interface KnowledgeWorkingSet {
  searches: SearchRecord[]

  candidates: string[]

  loaded: string[]

  used: string[]

  dismissed: string[]

  summaries: Record<string, string>
}
```

例如 K102 已经读取过。

后续 Prompt 不再重复塞入 K102 全文，而只记录：

```text
Active team knowledge:

K102 Persisted State Hydration Race
```

如果 Agent 需要再次确认：

```text
knowledge_read(K102, "Verification")
```

再局部读取。

Working Set 是防止知识重复消耗 Token 的核心机制。

---

## 3.13 Context Assembly

搜索结果不能直接全部注入模型。

Context Assembler 根据相关度、预算和 Working Set 组装：

```text
Team Knowledge

[K102] Persisted State Hydration Race

Cold reload can access persisted state before
hydration completes.

This is prior team knowledge.
Verify it against the current code and runtime
evidence before applying the solution.
```

如果：

```text
lifecycle = stale
```

则显式加入：

```text
Warning:
This knowledge may be outdated.
```

Business Rule / Architecture Decision 也可以带不同语义：

```text
Team Constraint
```

让 Agent 明确这不是普通建议。

---

## 3.14 模型可见知识必须进入 Session Event

Harness 要求模型可见内容可以从 Session Log 重建，因此知识注入不能成为不可追踪的隐藏 Prompt。

增加：

```ts
KnowledgeContextInjected {
  knowledgeId
  knowledgeVersion
  trigger
  relevance
  projectionHash
}
```

持久化：

```text
本次 Agent
为什么获得 K102

获得的是哪一版本

通过什么 Trigger

当时相关度多少
```

这样 Resume、Fork、Replay 都保持一致。

---

## 3.15 Knowledge Feedback

任务完成后，通过行为和结果评估知识：

```text
helpful
partially-helpful
irrelevant
misleading
```

例如：

```text
K102

Used: 38
Helpful: 31
Irrelevant: 5
Misleading: 2
```

长期可以参与 Retrieval Rank。

如果连续出现：

```text
irrelevant
misleading
```

则触发：

```text
Knowledge Revalidation
```

形成真正的：

```text
Knowledge
 ↓
Use
 ↓
Outcome
 ↓
Feedback
 ↓
Knowledge Improvement
```

---

# 4. Token 开销控制：低成本知识闭环

## 4.1 链路整体架构

Token 优化不能只依赖：

```text
便宜模型
更大的 Context Window
KV Cache
```

真正有效的方案是减少进入模型的信息。

完整成本控制链路：

```text
Raw Session
  │
  │ deterministic extraction
  ▼
Compact Engineering Trace
  │
  │ candidate gate
  ▼
Only Valuable Tasks
  │
  │ search before create
  ▼
Relevant Existing Knowledge Only
  │
  │ patch-based compilation
  ▼
Small Knowledge Patch
  │
  │ claim-first verification
  ▼
Relevant Evidence Only


Runtime Retrieval

Entire Wiki
    ✕
    │
    ▼

Top 3~5 L0 Cards
    ↓
Agent selects
    ↓
L1 Section
    ↓
L2 Evidence only when necessary
```

Token 策略的核心可以概括为：

> **不读没价值的 Session，不编译没价值的任务，不加载没相关性的知识，不重复注入已经读取的内容。**

---

## 4.2 方案一：Session → Structured Trace

这是 Write Path 最大的 Token 优化。

假设一次 Session：

```text
60K tokens
```

其中包括大量：

```text
read_file
grep
bash output
失败尝试
重复解释
模型自然语言
```

Observer 通过程序转换为：

```text
EngineeringTrace
≈ 2K~5K tokens
```

LLM 只看到：

```text
Task
Relevant Errors
Files
Final Diff
Test Transition
Final Outcome
```

理论上可以直接减少一个数量级的输入。

---

## 4.3 方案二：Candidate Gate

普通研发任务根本不进入知识编译。

例如：

```text
100 次 Harness Tasks

↓ Gate

80 个：
无新增知识

15 个：
低价值

5 个：
真正进入 Distiller
```

比：

```text
100 Tasks
↓
100 次总结
```

成本低得多。

---

## 4.4 方案三：Search Before Create

编译 Candidate 时：

```text
Candidate
+
Top 3~5 Knowledge Cards
```

而不是：

```text
Candidate
+
Entire Wiki
```

只有 Compiler 判断某几篇可能需要更新：

```text
K102
K31
```

才加载其正文。

Wiki 越大，这个差异越明显。

---

## 4.5 方案四：Patch-Based Compilation

如果一个 3000 Token 页面只增加：

```text
Known Occurrence
```

无需：

```text
3000 old
+
new evidence
↓
重新生成 3200 tokens
```

而是：

```text
Relevant Section 500
+
Candidate 800
↓
Patch 200
```

程序负责应用：

```text
ADD occurrence
ADD source
UPDATE confidence
```

Patch 模型同时减少输入和输出 Token。

---

## 4.6 方案五：Claim First / Evidence On Demand

Distiller 先生成 Claim：

```text
Root Cause:
hydration race
```

Verifier 再定向读取：

```text
对应 Error
最终 Diff
Regression Test
```

而不是重新加载整个 Trace。

这同时提升：

```text
准确率
+
Token 效率
```

---

## 4.7 方案六：L0 / L1 / L2

Runtime Search：

```text
5 Knowledge Cards
```

假设平均：

```text
80 tokens × 5
≈ 400 tokens
```

Agent 最终只读一条：

```text
800 tokens
```

总计约：

```text
1200 tokens
```

而传统一次性返回 5 篇完整知识可能：

```text
5000~8000 tokens
```

---

## 4.8 方案七：Section-Level Read

固定 Wiki Schema 后支持：

```text
knowledge_read({
  id: K102,
  section: "Diagnosis"
})
```

Agent 如果只想知道：

```text
如何定位？
```

就无需读取：

```text
History
Known Occurrences
Evidence
Verification
Related
```

进一步降低 L1 成本。

---

## 4.9 方案八：Knowledge Working Set 去重

一条知识在当前 Task 中第一次读取：

```text
K102 full detail
```

后续不再自动重新注入。

Working Set 仅保留：

```text
K102
Persisted State Hydration Race
```

有需要再调用 Section Read。

避免一个 15 Step Agent Task 中重复支付同样 1000 Token 十几次。

---

## 4.10 方案九：事件驱动，而非 Step 驱动 Retrieval

只有：

```text
Task Start
Strong New Evidence
Repeated Failure
Agent Explicit Request
```

允许 Retrieval。

禁止：

```text
Every Step
→ automatically search Wiki
```

同时配置：

```text
maxAutomaticRetrievalsPerTask
```

控制调用次数。

---

## 4.11 方案十：常驻 Prompt 只声明能力

System Prompt 不包含 Wiki。

只写几十 Token：

```text
You have access to team engineering knowledge.

Use it when historical business rules,
problem patterns or architecture decisions
may affect the task.
```

真实知识通过 Tool 和 Context Injection 按需加载。

---

## 4.12 Token Budget

建议 MVP 直接设置软预算。

| 场景 | 目标 |
|---|---:|
| 常驻知识 System Prompt | ≤150 tokens |
| Task Start Knowledge Context | ≤600 |
| Knowledge Card | 50–150/条 |
| Section Read | 150–500 |
| Full Wiki Read | 500–1200 |
| 自动 Re-retrieval | ≤500 |
| Distiller 输入 Trace | 2K–5K |
| Compiler Relevant Wiki | ≤2K |
| Knowledge Patch | 300–1000 |
| Evidence Verify | 500–1500 |

同时定义：

```text
Loop Token Overhead
=
Loop Engineering Extra Tokens
/
Original Agent Tokens
```

但不简单追求一个全局固定百分比。

真正期望的是：

```text
普通任务
≈ 0 knowledge overhead

需要团队知识的任务
才产生明显开销

只有少量高价值任务
产生 Knowledge Compilation 成本
```

---

# 5. 产品形态、开发范围与最终验收

## 5.1 Harness 插件技术结构

插件遵循 DeepSeek Harness 的 Capability Seam。

```text
              KnowledgeService
                    │
         Service Definition
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
 Local Engineering Wiki     Future Provider
        │
        ▼
   Git / Markdown
```

Consumer：

```text
knowledge_search
knowledge_read
knowledge_related
knowledge_feedback
```

核心内部模块：

```text
loop-engineering
├── observer
├── trace-builder
├── resolution-detector
├── candidate-detector
├── distiller
├── compiler
├── verifier
├── retrieval-trigger
├── navigator
├── working-set
└── context-assembler
```

UI：

```text
loop-engineering-client
├── Knowledge Candidate Card
├── Knowledge Used Card
├── Patch Review
└── Wiki Explorer
```

---

## 5.2 建议的核心 Tool

Agent 对外只暴露四个知识 Tool。

```text
knowledge_search
```

搜索 L0 Card。

```text
knowledge_read
```

读取 L1 Page 或 Section。

```text
knowledge_related
```

进行 Wiki Graph Navigation。

```text
knowledge_feedback
```

报告知识是否有效或过期。

MVP 不向普通 Agent 暴露：

```text
knowledge_apply_patch
```

知识写入只能走受治理的 Write Path。

---

## 5.3 前端核心交互

任务结束发现可复用知识：

```text
┌──────────────────────────────────────┐
│ ✨ Team Knowledge Discovered         │
│                                      │
│ Persisted State Hydration Race       │
│ Problem Pattern                      │
│                                      │
│ Confidence        94%                │
│ Existing Page     K102               │
│                                      │
│ Proposed Update                      │
│ + AuthProvider occurrence            │
│ + Regression test evidence           │
│ + Confidence 87% → 94%               │
│                                      │
│ [Review Patch] [Publish] [Dismiss]   │
└──────────────────────────────────────┘
```

任务中自动使用团队知识：

```text
┌──────────────────────────────────┐
│ Team Knowledge Used              │
│                                  │
│ Persisted State Hydration Race   │
│                                  │
│ Relevance       High             │
│ Confidence      94%              │
│ Verified        2026-08-12       │
│                                  │
│ [Open] [View Evidence]           │
└──────────────────────────────────┘
```

这保证知识系统对于用户是可解释的，而不是隐藏在 Prompt 中。

---

## 5.4 MVP 范围

第一阶段不追求完整企业知识平台，只跑通最关键闭环：

```text
Bug A
↓
Agent 修复
↓
自动识别解决
↓
生成 Problem Pattern
↓
Review
↓
写入 Wiki

Bug B
↓
Task Start / Strong Evidence
↓
自动召回 Problem Pattern
↓
Agent 使用
↓
问题解决
↓
新 Evidence 反向更新原知识
```

MVP 包含：

- Git-backed Engineering LLM Wiki
- 三种 Knowledge Type
- Knowledge Schema 与 Lifecycle
- Engineering Observer
- EngineeringTrace
- Resolution Detector
- Candidate Gate
- Knowledge Distiller
- Search Before Create
- Knowledge Compiler
- KnowledgePatch
- Evidence Verification
- Structural Lint
- Review UI
- Task Start Retrieval
- Strong Evidence Retrieval
- Agent Manual Retrieval
- FTS + Metadata Search
- L0/L1/L2
- Knowledge Working Set
- Section-level Read
- Context Injection
- Token Budget

暂不强求：

```text
企业权限系统
跨团队 Wiki
GitHub PR 自动 Ingest
Incident 平台
完整 Knowledge Graph
复杂 Embedding Infrastructure
自动 Architecture Invalidator
Notion / Confluence Provider
```

---

## 5.5 V1 增强范围

MVP 跑通后增加：

```text
BM25 + Embedding Hybrid Retrieval

Wiki Graph Navigation

Repeated Failure Retrieval

Knowledge Feedback

Staleness Detection

Git PR Review Workflow

Wiki Explorer

Knowledge Quality Dashboard

Knowledge Reuse Gain
```

---

## 5.6 核心产品指标

不能用：

```text
Wiki Page 数量
```

作为核心 KPI。

真正需要衡量：

**Knowledge Candidate Precision**  
推荐沉淀的东西是不是真的值得。

**Duplicate Rate**  
Wiki 是否出现重复知识。

**Retrieval Precision@5**  
自动返回的 5 条知识是否真正相关。

**Helpful Rate**  
Agent 使用知识后是否真正帮助解决任务。

**Misleading Rate**  
错误知识误导 Agent 的比例。

**Token Overhead**  
Loop Engineering 带来的额外成本。

最终最核心的 North Star Metric：

> **Knowledge Reuse Gain**

例如：

```text
第一次解决某类 Bug

28 Agent Steps
24 min

知识沉淀后

下一次类似问题

9 Agent Steps
8 min
```

意味着团队知识真正开始产生复利。

---

## 5.7 MVP 最终验收标准

系统至少需要通过以下端到端验证：

第一，复杂 Bug 被成功解决后，能够从 Session 中自动构建 EngineeringTrace，而不是重新将完整 Session 交给 LLM。

第二，能够将 Bug 抽象为 Problem Pattern，并通过 Search Before Create 判断应该创建还是更新已有 Knowledge Unit。

第三，知识必须经过 Evidence Verification，并产生可审查 Knowledge Patch；未解决问题不能进入 `verified`。

第四，未来一个语义相似但描述不同的任务，可以在 Task Start 或 Strong Evidence 阶段自动召回之前的知识。

第五，首次检索只返回 Knowledge Card；只有 Agent 明确需要时才展开 Wiki Detail 或 Evidence。

第六，同一 Task 中已经读取的知识不会被自动重复注入。

第七，普通无知识价值任务几乎不产生额外 Loop Engineering Token。

第八，连续出现两个同类 Bug 后，Wiki 最终表现为：

```text
1 个 Problem Pattern
+
多个 Evidence / Known Occurrence
```

而不是多个重复页面。

---

最终这版 PRD 的结构实际上就围绕三个问题展开：

```text
               Loop Engineering
                       │
       ┌───────────────┼───────────────┐
       │               │               │
       ▼               ▼               ▼
   如何学习？       如何使用？       如何便宜？
       │               │               │
       ▼               ▼               ▼
   LLM Wiki       Knowledge        Token-efficient
   Write Path      Navigator          Context
       │               │               │
       └───────────────┼───────────────┘
                       ▼
                 Engineering Loop
```

因此产品的核心描述也可以最终收敛成一句：

> **Loop Engineering 将已验证的研发经验持续编译成团队 LLM Wiki，在 Agent 真正需要时通过渐进式检索重新进入上下文，并通过结构化 Trace、按需读取与 Patch 编译把整个学习闭环的 Token 成本控制在最低。**
