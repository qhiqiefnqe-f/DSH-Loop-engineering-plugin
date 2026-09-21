import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { WikiStore } from '../src/wiki-store.ts'

/**
 * 可复制运行的端到端检索演示。
 *
 * 这不是伪造输出的样例：脚本会读取仓库 `wiki/` 中的规范 Markdown，走与插件相同的
 * `WikiStore.search()` 多路检索，打印 L0 卡片；随后对第一名继续调用 `read()`，展示
 * L1 Diagnosis 和 L2 Evidence。这样不启动 Web UI、不调用外部模型，也能验证从用户输入
 * 到渐进式知识读取的整条确定性链路。
 */

/** 读取形如 `--query "..."` 的单值参数；未提供时返回 undefined。 */
function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

// 默认输入刻意不用知识页标题，而使用真实故障表述，以验证近似召回而非精确 ID 命中。
const query = argument('--query') ?? '浏览器冷启动或刷新后，登录状态变成 undefined，认证信息丢失'
const limit = Number(argument('--limit') ?? 3)
if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('--limit 必须是正整数')

// Wiki 只读；WikiStore 要求 stateDir，因此放到系统临时目录，并在结束时彻底清理。
const temporaryState = await mkdtemp(join(tmpdir(), 'loop-engineering-demo-'))
try {
  const store = new WikiStore({
    wikiDir: resolve('wiki'),
    stateDir: temporaryState,
    duplicateThreshold: 0.58,
    rrfK: 60,
    exactRrfWeight: 2,
    bm25RrfWeight: 1,
    metadataRrfWeight: 0.8,
  })

  const cards = await store.search(query, { limit })
  process.stdout.write(`输入：${query}\n\n`)
  process.stdout.write('L0 检索卡片：\n')
  if (cards.length === 0) {
    process.stdout.write('  未找到相关知识。\n')
    process.exitCode = 2
  } else {
    cards.forEach((card, index) => {
      process.stdout.write([
        `  ${index + 1}. [${card.id}] ${card.title}`,
        `     类型=${card.type} 生命周期=${card.lifecycle} 相关度=${card.relevance}`,
        `     通道=${card.retrievalChannels?.join('+') ?? 'none'}`,
        `     摘要=${card.summary}`,
      ].join('\n') + '\n')
    })

    // 渐进读取只展开第一名，模拟模型先看 L0、确认相关后才支付更高上下文成本。
    // 三类知识的核心章节名不同，按 schema 选择，保证替换查询后演示仍可运行。
    const top = cards[0]
    if (top !== undefined) {
      const detailSection = top.type === 'problem-pattern' ? 'Diagnosis'
        : top.type === 'business-rule' ? 'Rule'
          : 'Decision'
      const [detail, evidence] = await Promise.all([
        store.read(top.id, detailSection),
        store.read(top.id, undefined, 'evidence'),
      ])
      process.stdout.write(`\nL1 ${detailSection}（${top.id}）：\n${detail}\n`)
      process.stdout.write(`\nL2 Evidence（${top.id}）：\n${evidence}\n`)
    }
  }
} finally {
  await rm(temporaryState, { recursive: true, force: true })
}
