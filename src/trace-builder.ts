import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { EngineeringTrace } from './types.ts'
import { contentText } from './text.ts'

/**
 * Session Event → EngineeringTrace 的增量投影器。
 *
 * Harness 的会话是追加式事件日志。这里不等 turn 结束后重新扫描整个会话，而是每收到一个事件
 * 就把其中有用的工程事实折叠进 `MutableTrace`。这样运行成本与新事件大小相关，也不会把完整对话
 * 复制到知识系统。只有 `turn/end` 到来时，临时对象才会冻结为对外的 `EngineeringTrace`。
 */

/** 一个 turn 尚未结束时使用的可变累加器；Set/Map 天然负责去重。 */
interface MutableTrace {
  turn: number
  task: string
  errors: Set<string>
  filesRead: Set<string>
  filesChanged: Set<string>
  commands: Array<{ command: string; outcome?: string }>
  tests: Map<string, 'pass' | 'fail' | 'unknown'>
  userConfirmations: Set<string>
  finalOutcome?: string
  changed: boolean
}

// 从工具参数或输出中识别常见源码/配置/测试文件路径。它是启发式提取，不尝试替代真正的文件系统解析。
const PATH = /(?:[A-Za-z]:)?[\w@.-]+(?:[\\/][\w@.() -]+)+\.[A-Za-z0-9]{1,8}/gu
// 同时覆盖中英文常见错误信号；最多保留后续 240 字符，避免把整段日志写进 trace。
const ERROR = /(?:error|exception|failed|failure|cannot|undefined|null reference|错误|异常|失败)[^\n]{0,240}/giu
// PASS/FAIL 用于把命令输出归一成简单的测试结论，失败优先级高于通过。
const PASS = /(?:\bpass(?:ed)?\b|tests?\s+passed|build\s+success|✓|测试通过|构建成功)/iu
const FAIL = /(?:\bfail(?:ed|ure)?\b|tests?\s+failed|✗|测试失败|构建失败)/iu
// 这些工具的调用本身就能作为“发生过文件修改”的明确信号。
const CHANGE_TOOLS = new Set(['apply_patch', 'str_replace_editor', 'write_file', 'edit_file'])

/** 增量地把持久 Session Events 投影为紧凑工程轨迹。 */
export class TraceBuilder {
  /** key 为 `sessionId:turn`，保存仍在进行中的 turn。 */
  private readonly traces = new Map<string, MutableTrace>()
  /** 每个 session 最近一次完成的轨迹，供 `/save-knowledge` 复用。 */
  private readonly completed = new Map<string, EngineeringTrace>()
  /** 某些事件没有直接携带 turn，因此缓存 session 当前 turn 作为回退。 */
  private readonly currentTurn = new Map<string, number>()

  /**
   * 折叠一个事件；普通事件只更新累加器并返回 `undefined`，只有 `turn/end` 才返回完整轨迹。
   * 这种接口让调用方能直接用“是否返回结果”判断何时持久化或蒸馏。
   */
  observe(session: Session, event: SessionEvent): EngineeringTrace | undefined {
    const sessionId = String(session.id)
    if (event.type === 'turn/start') this.currentTurn.set(sessionId, event.data.turn)
    // 优先使用事件自带 turn；没有时退回当前 session 的缓存，最后才使用 0。
    const turn = event.type === 'turn/start' || event.type === 'turn/end' || event.type === 'step/start' || event.type === 'step/end'
      ? event.data.turn
      : 'turn' in event.data && typeof event.data.turn === 'number' ? event.data.turn : (this.currentTurn.get(sessionId) ?? 0)
    const key = `${sessionId}:${turn}`
    const trace = this.traces.get(key) ?? freshTrace(turn)
    this.traces.set(key, trace)

    switch (event.type) {
      case 'user/message': {
        const text = contentText(event.data.content)
        // 插件注入消息也属于 user/message，但任务描述必须来自真正用户，且只取第一条。
        if (event.data.source.kind === 'user' && trace.task.length === 0) trace.task = text
        // 用户明确表示“已经好了”是很强的解决证据，因此单独保存。
        if (/已解决|可以了|好了|works now|fixed|resolved/iu.test(text)) trace.userConfirmations.add(text.slice(0, 500))
        collectText(trace, text)
        break
      }
      case 'assistant/message': {
        const text = contentText(event.data.message.content)
        // 助手最后的总结往往包含根因和方案；只保留尾部 2400 字符控制体积。
        if (text.trim()) trace.finalOutcome = text.slice(-2400)
        collectText(trace, text)
        break
      }
      case 'tool/call': {
        // 保存工具名和参数，便于后续 Diagnosis 章节还原实际排查动作。
        trace.commands.push({ command: `${event.data.name} ${event.data.arguments}`.slice(0, 1400) })
        if (CHANGE_TOOLS.has(event.data.name)) trace.changed = true
        collectPaths(trace.filesRead, event.data.arguments)
        if (CHANGE_TOOLS.has(event.data.name)) collectPaths(trace.filesChanged, event.data.arguments)
        if (event.data.name === 'bash' || event.data.name === 'pwsh') {
          // Shell 工具名字本身不能说明是否修改文件，所以再检查常见写入命令。
          if (/\b(?:git apply|sed -i|tee|write|move|copy)\b/iu.test(event.data.arguments)) trace.changed = true
        }
        break
      }
      case 'tool/result': {
        const text = contentText(event.data.message.content)
        const command = trace.commands.at(-1)
        // Session Events 用 callId 关联最准确；MVP 使用“最近命令”做低成本近似并限制长度。
        if (command !== undefined && command.outcome === undefined) command.outcome = text.slice(0, 800)
        collectText(trace, text)
        detectTest(trace, text)
        break
      }
      case 'turn/end': {
        // turn 结束时才把可变 Set/Map 展开为可序列化数组，并计算最终解决状态。
        const resolutionConfidence = resolutionScore(trace, event.data.reason.kind)
        const result: EngineeringTrace = {
          sessionId,
          turn: event.data.turn,
          task: trace.task,
          errors: [...trace.errors],
          filesRead: [...trace.filesRead],
          filesChanged: [...trace.filesChanged],
          commands: trace.commands,
          tests: [...trace.tests].map(([name, outcome]) => ({ name, outcome })),
          userConfirmations: [...trace.userConfirmations],
          ...(trace.finalOutcome === undefined ? {} : { finalOutcome: trace.finalOutcome }),
          resolutionConfidence,
          resolved: event.data.reason.kind === 'completed' && resolutionConfidence >= 0.65,
        }
        this.completed.set(sessionId, result)
        // 完成后及时删除进行中状态，避免长时间运行的 Web 进程持续增长内存。
        this.traces.delete(key)
        this.currentTurn.delete(sessionId)
        return result
      }
      default:
        break
    }
    return undefined
  }

  /** 返回该会话最近完成的轨迹，供显式 `/save-knowledge` 使用。 */
  latest(sessionId: string): EngineeringTrace | undefined {
    return this.completed.get(sessionId)
  }
}

/** 为一个新 turn 创建完全空白的累加器。 */
function freshTrace(turn: number): MutableTrace {
  return {
    turn,
    task: '',
    errors: new Set(),
    filesRead: new Set(),
    filesChanged: new Set(),
    commands: [],
    tests: new Map(),
    userConfirmations: new Set(),
    changed: false,
  }
}

/** 从任意消息或工具输出中同时收集错误片段和文件路径。 */
function collectText(trace: MutableTrace, text: string): void {
  for (const match of text.matchAll(ERROR)) trace.errors.add((match[0] ?? '').trim().slice(0, 300))
  collectPaths(trace.filesRead, text)
}

/** 把正则识别到的路径统一为 `/` 分隔，保证 Windows 与 POSIX 结果可比较。 */
function collectPaths(target: Set<string>, text: string): void {
  for (const match of text.matchAll(PATH)) target.add((match[0] ?? '').replaceAll('\\', '/'))
}

/**
 * 从测试输出提取测试文件名和结果。
 * 如果只看到“tests passed”而没有具体文件名，就用 `test-suite` 占位，仍保留“验证通过”这一事实。
 */
function detectTest(trace: MutableTrace, text: string): void {
  const names = [...text.matchAll(/(?:[\w@.-]+[\\/])*[\w@.-]+\.(?:spec|test|e2e)\.[jt]sx?/giu)].map(match => match[0] ?? 'test-suite')
  const outcome = FAIL.test(text) ? 'fail' : PASS.test(text) ? 'pass' : 'unknown'
  if (names.length === 0 && outcome !== 'unknown') names.push('test-suite')
  for (const name of names) trace.tests.set(name, outcome)
}

/**
 * 用可解释的加减分规则估算任务是否真正解决。
 * 它不是模型判断：完成 turn 是前提，修改、通过测试、用户确认和明确总结分别加分，失败测试强力扣分。
 */
function resolutionScore(trace: MutableTrace, reason: string): number {
  if (reason !== 'completed') return 0
  let score = 0.2
  if (trace.changed || trace.filesChanged.size > 0) score += 0.2
  if ([...trace.tests.values()].includes('pass')) score += 0.3
  if (trace.userConfirmations.size > 0) score += 0.25
  if (trace.finalOutcome !== undefined && /fixed|resolved|implemented|success|修复|解决|完成|通过/iu.test(trace.finalOutcome)) score += 0.2
  if ([...trace.tests.values()].includes('fail')) score -= 0.45
  return Number(Math.max(0, Math.min(1, score)).toFixed(2))
}

/**
 * 判断一条已完成轨迹是否值得自动提炼知识。
 *
 * 三道门依次是：确实解决且达到置信度、包含错误或明确的规则/架构语义、至少有一项工程证据。
 * 因此普通解释、改文案等任务只保留紧凑 trace，不制造知识候选。
 */
export function worthDistilling(trace: EngineeringTrace, threshold: number): boolean {
  if (!trace.resolved || trace.resolutionConfidence < threshold) return false
  if (trace.errors.length === 0 && !/(必须|禁止|不能|architecture|架构|业务规则|must|never)/iu.test(trace.task)) return false
  return trace.errors.length + trace.filesChanged.length + trace.tests.length + trace.userConfirmations.length > 0
}
