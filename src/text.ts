import { createHash } from 'node:crypto'

/**
 * 搜索、轨迹和发布流程共用的文本小工具。
 *
 * 这些函数看起来简单，却决定了“同一句话能否搜到同一知识”和“同一内容能否得到稳定 ID”。
 * 因此它们保持无状态、可重复：同样的输入永远得到同样的输出，便于测试和审查。
 */

// 停用词本身通常不能区分工程问题。去掉它们能减少 BM25 排名中的无意义噪声。
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'in', 'is', 'it', 'of', 'on', 'or',
  'that', 'the', 'this', 'to', 'was', 'what', 'when', 'where', 'why', 'with', 'after', 'before', 'can', 'could',
  '一个', '以及', '但是', '什么', '如何', '是否', '这个', '那个', '之后', '之前', '问题', '帮我', '一下',
])

/**
 * 把自然语言、文件路径或代码标识符统一拆成搜索 token。
 *
 * 处理顺序：先拆 camelCase，再把路径/标点换成空格，然后转小写并提取字母数字词。
 * 中文没有天然空格，所以长度至少 4 的连续汉字还会生成相邻二元词。例如“刷新状态失败”
 * 会额外产生“刷新”“新状”“状态”等 token，提高中文近似查询的召回率。
 */
export function tokenize(value: string): string[] {
  const expanded = value
    // `AuthProvider` 变成 `Auth Provider`，使单独搜索 auth/provider 也能命中。
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    // 同时兼容 `src/auth/file.ts`、`foo_bar`、`error-code` 等工程文本。
    .replace(/[_./\\:#-]+/gu, ' ')
    .toLocaleLowerCase()
  const raw = expanded.match(/[\p{L}\p{N}]+/gu) ?? []
  const tokens: string[] = []
  for (const term of raw) {
    if (!STOP_WORDS.has(term) && term.length > 1) tokens.push(term)
    // 只给较长的纯汉字词做二元切分，避免短词产生过多重复噪声。
    if (/^[\p{Script=Han}]{4,}$/u.test(term)) {
      for (let index = 0; index < term.length - 1; index += 1) tokens.push(term.slice(index, index + 2))
    }
  }
  return tokens
}

/**
 * 生成稳定的 12 位内容版本。
 * SHA-256 在这里不是用于密码安全，而是以极低碰撞概率把长文本压缩成适合卡片、文件名和去重键的短标识。
 */
export function contentVersion(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

/**
 * 从 Harness 的未知内容块数组中递归提取模型可见文本。
 *
 * 输入故意使用 `unknown`：事件可能包含未来新增的块类型。函数只识别文本块和嵌套 content，
 * 其他图片、音频或未知对象安全忽略，避免一次格式变化让整个事件投影崩溃。
 */
export function contentText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value.flatMap((block): string[] => {
    if (typeof block !== 'object' || block === null) return []
    const record = block as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') return [record.text]
    if (Array.isArray(record.content)) return [contentText(record.content)]
    return []
  }).filter(Boolean).join('\n')
}

/**
 * 把生成的上下文限制在字符预算内。
 * 这不是 token 精确计数，而是一个低成本保护栏；预留 14 个字符写截断标记，让模型知道后面还有内容。
 */
export function boundText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 14))}\n...[truncated]`
}

/**
 * 把标题转换成适合 URL、知识 ID 和文件名的稳定 slug。
 *
 * NFKD 先统一兼容字符，随后把标点和空白折叠为 `-`，并限制长度。
 * 如果标题完全无法形成 slug，则退回内容哈希，保证调用者始终拿到非空值。
 */
export function slugify(value: string): string {
  const slug = value.toLocaleLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 72)
  return slug || contentVersion(value)
}
