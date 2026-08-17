/**
 * Loop Engineering 的领域类型集中定义。
 *
 * 可以把本文件理解为模块之间共同遵守的“数据字典”：事件投影器产出
 * `EngineeringTrace`，知识提炼器把它变成 `KnowledgeCandidate`，审查流程再生成
 * `KnowledgePatch`，最终发布为 `KnowledgeUnit`。这里不放业务逻辑，只描述每一步
 * 数据应该长什么样，便于 TypeScript 在编译期发现字段遗漏或类型误用。
 */

/** MVP 支持的三种规范知识。字符串值同时用于 YAML、目录名和工具参数，不能随意改名。 */
export type KnowledgeType = 'business-rule' | 'problem-pattern' | 'architecture-decision'

/**
 * 一条规范 Wiki 知识的生命周期。
 * `reviewed` 表示经过人工审查；`verified` 表示还有较强的工程证据；
 * `superseded` 和 `archived` 不参加普通检索，`stale` 只应当作排查线索。
 */
export type KnowledgeLifecycle = 'draft' | 'reviewed' | 'verified' | 'stale' | 'superseded' | 'archived'

/** 检索范围标签。搜索可以按仓库、业务域或模块缩小候选集合。 */
export interface KnowledgeScope {
  /** 适用的代码仓库名；空数组表示不限仓库。 */
  repos: string[]
  /** 适用的业务或技术领域，例如 authentication。 */
  domains: string[]
  /** 适用的模块或目录，例如 src/auth。 */
  modules: string[]
}

/**
 * 每个规范 Markdown 页顶部 YAML front matter 的完整结构。
 * 正文保存人类可读的详细内容，元数据负责检索、生命周期判断、证据追踪和图导航。
 */
export interface KnowledgeMetadata {
  /** 稳定 ID，例如 problem.persisted-state-hydration-race。 */
  id: string
  type: KnowledgeType
  title: string
  /** 用于 L0 卡片的简短摘要，不应塞入完整正文。 */
  summary: string
  /** 同义词或历史名称，用于提高搜索召回率。 */
  aliases: string[]
  /** 常见症状、任务措辞或触发条件。 */
  triggers: string[]
  scope: KnowledgeScope
  /** 0..1 的可信度；它会参与搜索排序，但不能代替证据。 */
  confidence: number
  lifecycle: KnowledgeLifecycle
  /** session、测试、评审等证据标识。发布时要求至少有来源。 */
  sources: string[]
  /** 其他知识 ID，构成可通过 knowledge_related 导航的显式图。 */
  related: string[]
  created_at: string
  updated_at: string
  /** 只有真正验证过的知识才需要记录最后验证日期。 */
  last_verified_at?: string
}

/** 从一个 Markdown 文件解析出的内存对象。 */
export interface KnowledgeUnit {
  metadata: KnowledgeMetadata
  /** 去掉 YAML front matter 后的 Markdown 正文。 */
  body: string
  /** 原始文件绝对路径，更新已有知识时用于原地写回。 */
  filePath: string
  /** 由完整文件内容计算出的短哈希，帮助模型识别知识版本。 */
  version: string
}

/**
 * 低成本 L0 搜索卡片。
 * 它故意不包含 `body`，让自动检索只占很少上下文；确认相关后再用
 * `knowledge_read` 读取 L1 正文或 L2 证据。
 */
export interface KnowledgeCard {
  id: string
  title: string
  type: KnowledgeType
  summary: string
  scope: KnowledgeScope
  lifecycle: KnowledgeLifecycle
  confidence: number
  relevance: number
  version: string
}

/**
 * 一个工程 turn 的确定性压缩结果。
 * 这里保存能复盘“做了什么、结果如何”的结构化事实，而不是复制完整聊天记录。
 */
export interface EngineeringTrace {
  sessionId: string
  turn: number
  /** 本轮第一条真实用户消息，作为任务描述。 */
  task: string
  errors: string[]
  filesRead: string[]
  filesChanged: string[]
  /** 工具调用的紧凑表示；outcome 保存对应工具结果的截断摘要。 */
  commands: Array<{ command: string; outcome?: string }>
  tests: Array<{ name: string; outcome: 'pass' | 'fail' | 'unknown' }>
  userConfirmations: string[]
  finalOutcome?: string
  /** 0..1 的启发式解决置信度，用于低成本自动候选门控。 */
  resolutionConfidence: number
  resolved: boolean
}

/**
 * 等待人工审查的知识候选。
 * 候选可以由高价值 trace 自动生成，也可以由 `/save-knowledge` 显式创建；
 * 它还不是规范知识，因此只能写入 `.loop-engineering/candidates`。
 */
export interface KnowledgeCandidate {
  candidateId: string
  type: KnowledgeType
  title: string
  summary: string
  /** 以章节名为键的结构化正文，发布时再稳定渲染成 Markdown。 */
  structuredContent: Record<string, string | string[]>
  aliases: string[]
  triggers: string[]
  scope: KnowledgeScope
  evidence: string[]
  confidence: number
  /** 相对于 stateDir 的原始轨迹路径，方便审查者追溯。 */
  tracePath: string
  createdAt: string
  status: 'pending-review' | 'published' | 'dismissed'
}

/**
 * 针对规范 Wiki 的确定性变更计划。
 * 模型不能直接覆盖 Markdown；它只能提出候选，代码再把候选转成这种可检查的 Patch。
 */
export interface KnowledgePatch {
  patchId: string
  candidateId: string
  operation: 'create' | 'update' | 'merge' | 'link' | 'conflict' | 'archive'
  targets: string[]
  /** `set` 替换某个章节，`append` 只追加新的出现记录或证据。 */
  changes: Array<{ section: string; action: 'set' | 'append'; value: string }>
  evidence: string[]
  confidence: number
  /** 证据门禁结果；UNSUPPORTED/CONFLICTING 会阻止发布。 */
  verification: 'SUPPORTED' | 'PARTIALLY_SUPPORTED' | 'UNSUPPORTED' | 'CONFLICTING'
  /** 结构 lint 错误；非空时也会阻止发布。 */
  lintErrors: string[]
  createdAt: string
}

/**
 * 单个会话的知识工作集。
 * 这是内存态去重账本：记录搜过什么、读过什么、采用或否定了什么，避免同一知识反复注入。
 */
export interface KnowledgeWorkingSet {
  /** 已执行自动检索的 query 哈希。 */
  searches: string[]
  /** L0 搜索曾返回的知识 ID。 */
  candidates: Set<string>
  /** 已通过 knowledge_read 展开的 ID。 */
  loaded: Set<string>
  /** 收到正面反馈的 ID。 */
  used: Set<string>
  /** 收到 irrelevant/misleading 反馈的 ID。 */
  dismissed: Set<string>
  /** 卡片摘要缓存，便于后续扩展工作集展示。 */
  summaries: Map<string, string>
  automaticRetrievals: number
}

/** 全文候选生成后使用的元数据过滤条件。 */
export interface SearchOptions {
  type?: KnowledgeType
  repo?: string
  domain?: string
  module?: string
  limit?: number
}
