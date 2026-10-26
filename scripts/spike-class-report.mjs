// 本地讲评报告（class_report）复现：直连 LLM 上游（不经后端，不扣网站额度）。
//
// 用法：
//   node scripts/spike-class-report.mjs <备份json路径> [记录序号=最新一条] [--max-tokens=N]
//
// - 从 engtools-backup-*.json 取 handwriting 记录，按 ClassReportPanel.handleGenerate
//   的同一套参数构造 prompt（classStats + handwritingPrompts 经 vite ssrLoadModule 单一真源）
// - 与线上一致：model=PAID_MODELS.class_report、temperature 0.4、json_object、max_tokens 8000
// - 判定要点：finish_reason 是否 'length'、content 是否截断、repairJson 是否救不回
// - ⚠️ PII：digest 匿名但 highlight 摘句是学生原文——输出只打印到终端，禁止落盘进仓库
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const seqArg = args.find(a => /^\d+$/.test(a));
const maxTokens = args.find(a => a.startsWith('--max-tokens='))?.slice('--max-tokens='.length);
if (!file) {
  console.error('用法: node scripts/spike-class-report.mjs <备份json路径> [记录序号=最新一条] [--max-tokens=N]');
  process.exit(1);
}

// ── .env ──
const env = {};
for (const line of fs.readFileSync(path.join(root, 'server/.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)\s*$/);
  if (m) env[m[1]] = m[2];
}
if (!env.LLM_ENDPOINT || !env.LLM_API_KEY) {
  console.error('server/.env 缺 LLM_ENDPOINT / LLM_API_KEY');
  process.exit(1);
}

// ── 单一真源：classStats / prompts / 模型表 ──
const vite = await createServer({ root, server: { middlewareMode: true }, logLevel: 'silent', optimizeDeps: { noDiscovery: true } });
const { computeClassStats, buildStudentDigests, pickHighlightTexts } = await vite.ssrLoadModule('/src/utils/classStats.ts');
const { buildClassReportSystemPrompt, buildClassReportUserContent } = await vite.ssrLoadModule('/src/prompts/handwritingPrompts.ts');
const { escapeRawControlChars } = await vite.ssrLoadModule('/src/services/llm.ts');
await vite.close();

// ── 备份 → 记录 ──
const data = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
const recs = data.modules?.handwriting ?? [];
if (!recs.length) { console.error('备份里没有 handwriting 记录'); process.exit(1); }
const idx = seqArg != null ? Number(seqArg) - 1 : recs.length - 1;
const rec = recs[idx];
const d = rec.data ?? rec;
const stage = d.stage ?? 'senior';
const model = 'gemini-3.5-flash'; // 真源 src/utils/model.ts PAID_MODELS.class_report（未导出，改模型记得同步这里）
const mt = maxTokens != null ? Number(maxTokens) : 8000;

const params = {
  stage,
  essayType: d.essayType,
  gradeLevel: d.gradeLevel,
  essayPrompt: d.essayPrompt,
  promptSummary: d.promptSummary?.summary,
  opening1: d.promptSummary?.opening1,
  opening2: d.promptSummary?.opening2,
  stats: computeClassStats(d.students),
  digests: buildStudentDigests(d.students, d.essayType),
  highlightTexts: pickHighlightTexts(d.students),
};
const systemPrompt = buildClassReportSystemPrompt(params);
const userContent = buildClassReportUserContent(params);
console.log(`记录[${idx + 1}/${recs.length}] ${rec.id} savedAt=${rec.savedAt}`);
console.log(`学生 ${d.students.length} 人 | 统计内 ${params.stats.studentCount} | 模型 ${model} | max_tokens ${mt}`);
console.log(`prompt 尺寸：system ${systemPrompt.length} + user ${userContent.length} 字符；digests ${params.digests.length} 行`);

// ── 直连上游（同 callLLM 请求体）──
const t0 = Date.now();
const resp = await fetch(env.LLM_ENDPOINT, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LLM_API_KEY}` },
  body: JSON.stringify({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature: 0.4,
    response_format: { type: 'json_object' },
    max_tokens: mt,
  }),
});
if (!resp.ok) {
  console.log(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 500)}`);
  process.exit(1);
}
const data2 = await resp.json();
const ch = data2.choices?.[0];
const content = ch?.message?.content || '';
console.log(`--- ${((Date.now() - t0) / 1000).toFixed(1)}s | finish_reason=${JSON.stringify(ch?.finish_reason)} | usage=${JSON.stringify(data2.usage)} ---`);
console.log(`content ${content.length} 字符`);

// ── 判定：strict / repair 与线上 tryParseJson 同语义 ──
const cleaned = content.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
let strictOk = true;
try { JSON.parse(cleaned); } catch { strictOk = false; }
console.log(`strict JSON.parse: ${strictOk ? 'OK' : 'FAIL'}`);
if (!strictOk) {
  // repairJson 同款修复链（真源 escapeRawControlChars + 围栏/首尾杂文/尾逗号）
  let t = cleaned;
  const start = t.search(/[{[]/);
  if (start > 0) t = t.slice(start);
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (end >= 0 && end < t.length - 1) t = t.slice(0, end + 1);
  t = t.replace(/,(\s*[}\]])/g, '$1');
  t = escapeRawControlChars(t);
  let repairOk = true;
  try { JSON.parse(t); } catch { repairOk = false; }
  console.log(`repairJson 后: ${repairOk ? 'OK' : 'FAIL（→ 线上即抛「JSON 解析失败（已重试）」）'}`);
  console.log(`--- content 头 300 字 ---\n${content.slice(0, 300)}`);
  console.log(`--- content 尾 300 字（截断形态看这里）---\n${content.slice(-300)}`);
}
