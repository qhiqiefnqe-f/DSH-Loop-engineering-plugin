import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { evaluateRetrieval, parseCombinedWiki, parseRetrievalEvaluation } from '../src/evaluation.ts'
import { WikiStore } from '../src/wiki-store.ts'

/**
 * 离线检索质量评测入口。
 *
 * 输入一组“合并 Wiki Markdown”和 JSON/JSONL 查询标注，脚本会把知识页展开到隔离的临时目录，
 * 使用生产 `WikiStore` 建索引并计算 Recall@K、主相关召回率、HitRate 与无答案误召回率。
 * 临时目录始终在 finally 中删除，评测不会污染仓库内的规范 Wiki 或运行状态。
 */

/** 读取最后一次出现的单值 CLI 参数，例如 `--split test`。 */
const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

/** 收集可重复参数，例如多个 `--wiki file.md` 会按给定顺序合并。 */
const argumentsOf = (name: string): string[] => process.argv.flatMap((value, index) => (
  value === name && process.argv[index + 1] !== undefined ? [process.argv[index + 1] as string] : []
))

const requestedWikiPaths = argumentsOf('--wiki')
const wikiSourcePaths = (requestedWikiPaths.length > 0 ? requestedWikiPaths : ['wiki/temp/wikis.md']).map(path => resolve(path))
const evaluationPath = resolve(argument('--eval') ?? 'wiki/temp/evaluate.md')
const requestedSplit = argument('--split')
const requestedK = Number(argument('--k') ?? 5)
if (!Number.isInteger(requestedK) || requestedK < 1) throw new Error('--k 必须是正整数')

const [wikiSources, evaluationSource] = await Promise.all([
  Promise.all(wikiSourcePaths.map(path => readFile(path, 'utf8'))),
  readFile(evaluationPath, 'utf8'),
])
const documents = wikiSources.flatMap(source => parseCombinedWiki(source))
const duplicateIds = documents.map(document => document.id).filter((id, index, all) => all.indexOf(id) !== index)
if (duplicateIds.length > 0) throw new Error(`多个 Wiki 输入文件存在重复 id: ${[...new Set(duplicateIds)].join(', ')}`)
const allCases = parseRetrievalEvaluation(evaluationSource)
// 默认遵循 test split；显式传 `--split all` 时评测整个文件，便于观察加厚数据集的总体分布。
const inferredSplit = requestedSplit === 'all' ? undefined : requestedSplit ?? (allCases.some(item => item.split === 'test') ? 'test' : undefined)
const cases = inferredSplit === undefined ? allCases : allCases.filter(item => item.split === inferredSplit)
if (cases.length === 0) throw new Error(`评测集中没有 split=${inferredSplit ?? 'all'} 的样本`)

const temporaryRoot = await mkdtemp(join(tmpdir(), 'loop-retrieval-eval-'))
try {
  const wikiDir = join(temporaryRoot, 'wiki')
  for (const document of documents) {
    const path = join(wikiDir, document.type, `${document.id}.md`)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, document.source, 'utf8')
  }
  const store = new WikiStore({
    wikiDir,
    stateDir: join(temporaryRoot, 'state'),
    duplicateThreshold: 0.58,
    rrfK: 60,
    exactRrfWeight: 2,
    bm25RrfWeight: 1,
    metadataRrfWeight: 0.8,
  })
  const result = await evaluateRetrieval(store, cases, requestedK)
  process.stdout.write(`${JSON.stringify({
    wikiDocuments: documents.length,
    evaluationSplit: inferredSplit ?? 'all',
    ...result,
    misses: result.misses.slice(0, 20),
  }, null, 2)}\n`)
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
