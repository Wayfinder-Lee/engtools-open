import type { ClassFeedbackReport, ClassStats, EssayType, HandwritingWorksheetResult } from '../types';
import { bandIndexOf, getCohesionLabel } from '../types';

// ─── 班级讲评报告：客户端确定性统计与证据摘要 ──────────
// 全部为纯函数（无 React）。输入用最小结构 StatsStudent，StudentSheet 与
// StudentSnapshot 天然满足，统计/摘要/名册在屏显、LLM 输入、导出间共用同一真源。

/** 统计输入的最小学生结构（id 仅指纹用） */
export interface StatsStudent {
  id: string;
  studentName: string;
  ocrText: string;
  result: HandwritingWorksheetResult | null;
  genError?: string;
}

const BAND_NAMES = ['一', '二', '三', '四', '五'] as const;
const round1 = (n: number) => Math.round(n * 10) / 10;
/** UTF-16 码元安全的截断：末尾落在代理对高低半区时回退一位，避免截出半个 emoji */
const clip = (s: string, n: number) => {
  if (s.length <= n) return s;
  let cut = s.slice(0, n);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut + '…';
};
const arrLen = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

/** 参与统计的学生：已生成学案且未失败（genError 者排除，人数计入 excludedCount） */
function eligibleOf(students: StatsStudent[]): StatsStudent[] {
  return students.filter(s => s.result && !s.genError);
}

/** 短档名（如「三档」）；仅 15/25 分制有档——该分制下越界分数（如 0 分）归入最低档，其余分制返回 null */
export function bandShortOf(maxScore: number | undefined, score: number): string | null {
  if (maxScore !== 15 && maxScore !== 25) return null;
  const idx = bandIndexOf(maxScore, score) ?? 4;
  return `${BAND_NAMES[4 - idx]}档`;
}

/** 班级客观统计：永远对当前学生数据现算（老师改分后数字即时跟随），不持久化 */
export function computeClassStats(students: StatsStudent[]): ClassStats {
  const eligible = eligibleOf(students);
  const failed = students.filter(s => s.genError);
  const pending = students.length - eligible.length - failed.length;
  const scored = eligible.filter(s => s.result!.score != null);

  // 混合分制防护：均分/最高/最低只在主分制（首个非空 maxScore）内统计，
  // 老师给个别学生自改满分制（如 100 分制）时不与 15/25 分制混算
  const scoreScale = eligible.map(s => s.result!.maxScore).find(m => m != null) ?? null;
  const scores = scored.filter(s => s.result!.maxScore == null || s.result!.maxScore === scoreScale)
    .map(s => s.result!.score!);
  const sum = scores.reduce((a, b) => a + b, 0);

  // 五档分布（低→高，下标 0=一档 … 4=五档）；只统计主分制（15/25）学生，
  // 越界分数（如 0 分）归入最低档保证分布合计 = 主分制内有分数人数；
  // 老师自改满分制的学生不入档
  let bandDistribution: number[] | null = null;
  if (scoreScale === 15 || scoreScale === 25) {
    bandDistribution = [0, 0, 0, 0, 0];
    for (const s of scored) {
      if (s.result!.maxScore != null && s.result!.maxScore !== scoreScale) continue;
      const idx = bandIndexOf(s.result!.maxScore, s.result!.score!) ?? 4;
      bandDistribution[4 - idx]++;
    }
  }

  // 分项均分：只统计老师没有改掉 scoreBreakdown 的学生
  const withBd = eligible.filter(s => s.result!.scoreBreakdown);
  const avg = (pick: (b: NonNullable<HandwritingWorksheetResult['scoreBreakdown']>) => number) =>
    withBd.length ? round1(withBd.reduce((a, s) => a + pick(s.result!.scoreBreakdown!), 0) / withBd.length) : null;

  const errorCounts = { grammar: 0, vocabulary: 0, sentence: 0, logic: 0 };
  let missedPointCount = 0;
  let offTopicCount = 0;
  for (const s of eligible) {
    const r = s.result!;
    errorCounts.grammar += arrLen(r.errorDiagnosis?.grammar);
    errorCounts.vocabulary += arrLen(r.errorDiagnosis?.vocabulary);
    errorCounts.sentence += arrLen(r.errorDiagnosis?.sentence);
    errorCounts.logic += arrLen(r.errorDiagnosis?.logic);
    missedPointCount += arrLen(r.promptAnalysis?.missedPoints);
    if (r.promptAnalysis?.isOffTopic === true) offTopicCount++;
  }

  return {
    studentCount: eligible.length,
    excludedCount: failed.length,
    pendingCount: pending,
    scoredCount: scored.length,
    avgScore: scores.length ? round1(sum / scores.length) : null,
    maxScore: scores.length ? Math.max(...scores) : null,
    minScore: scores.length ? Math.min(...scores) : null,
    scoreScale,
    bandDistribution,
    avgBreakdown: { content: avg(b => b.content), language: avg(b => b.language), cohesion: avg(b => b.cohesion) },
    errorCounts,
    missedPointCount,
    offTopicCount,
  };
}

/**
 * 生成时指纹：学生成绩/学案被编辑后与报告内的快照指纹不一致 → UI 提示「报告已过期」。
 * 覆盖报告会逐字引用的内容：分数/满分、总评长度、错误条数与错例文本长度、学生姓名
 * （亮点具名）、题干概括长度；promptSummary 单列（重新生成概括同样使报告过期）。
 * 故意不含 ocrText（报告引用的是错例而非原文全文，核对阶段修 OCR 噪声不算过期）。
 */
export function classReportFingerprint(
  students: StatsStudent[], essayType: string, essayPrompt: string, promptSummary?: string | null,
): string {
  const parts = eligibleOf(students).map(s => {
    const r = s.result!;
    const ed = r.errorDiagnosis;
    const errCount = arrLen(ed?.grammar) + arrLen(ed?.vocabulary) + arrLen(ed?.sentence) + arrLen(ed?.logic);
    // 错例文本长度和：老师改写错例原文/改正（报告逐字引用的证据）也触发过期
    const errTextLen = [...(ed?.grammar ?? []).flatMap(e => [e.original, e.corrected]),
      ...(ed?.vocabulary ?? []).flatMap(e => [e.original, e.suggestion]),
      ...(ed?.sentence ?? []).flatMap(e => [e.original, e.improvement])]
      .reduce((a, t) => a + (t?.length ?? 0), 0);
    return `${s.id}:${s.studentName}:${r.score ?? '-'}:${r.maxScore ?? '-'}:${(r.overallComment ?? '').length}:${errCount}:${errTextLen}`;
  });
  return `${essayType}|${essayPrompt.length}|${promptSummary?.length ?? 0}|${parts.join(';')}`;
}

/** 每生匿名摘要行（LLM 输入用）：学生N 为统计内录入顺序，不含姓名 */
export function buildStudentDigests(students: StatsStudent[], essayType: EssayType): string[] {
  const cohesionLabel = getCohesionLabel(essayType);
  return eligibleOf(students).map((s, i) => {
    const r = s.result!;
    const score = r.score != null ? `${r.score}/${r.maxScore ?? '?'}分` : '未评分';
    const band = r.score != null ? (bandShortOf(r.maxScore, r.score) ?? '未定档') : '未评分';
    const b = r.scoreBreakdown;
    const breakdown = b ? `｜分项 内容${b.content} 语言${b.language} ${cohesionLabel}${b.cohesion}` : '';
    const off = r.promptAnalysis?.isOffTopic === true ? '偏题' : '未偏题';
    const ed = r.errorDiagnosis;
    const counts = `语法×${arrLen(ed?.grammar)} 词汇×${arrLen(ed?.vocabulary)} 句式×${arrLen(ed?.sentence)} 逻辑×${arrLen(ed?.logic)}`;
    // 错例证据 ≤3 条：语法优先，其次词汇、句式；每侧截 80 字符防 prompt 膨胀
    const snippets: string[] = [];
    for (const e of ed?.grammar ?? []) snippets.push(`${e.original}→${e.corrected}`);
    for (const e of ed?.vocabulary ?? []) snippets.push(`${e.original}→${e.suggestion}`);
    for (const e of ed?.sentence ?? []) snippets.push(`${e.original}→${e.improvement}`);
    const examples = snippets.length
      ? `｜错例：${snippets.slice(0, 3).map(t => clip(t, 160)).join('；')}`
      : '';
    const missed = r.promptAnalysis?.missedPoints?.length
      ? `｜未覆盖要点：${r.promptAnalysis.missedPoints.slice(0, 3).map(p => clip(String(p), 60)).join('；')}`
      : '';
    return `学生${i + 1}｜${score}｜${band}${breakdown}｜${off}｜${counts}${examples}${missed}`;
  });
}

/** 高分学生原文（具名，仅供亮点摘句）：分数降序前 topN 人，各截 1200 字符 */
export function pickHighlightTexts(students: StatsStudent[], topN = 5): { studentName: string; text: string }[] {
  return eligibleOf(students)
    .filter(s => s.result!.score != null)
    .sort((a, b) => (b.result!.score! - a.result!.score!))
    .slice(0, topN)
    .map(s => ({ studentName: s.studentName, text: clip(s.ocrText, 1200) }));
}

/** 成绩名册（录入顺序，无名次列）：老师私有的屏显/PDF/Word 用，PPT 不带 */
export function buildRoster(students: StatsStudent[]): { name: string; score: number | null; band: string | null }[] {
  return eligibleOf(students).map(s => ({
    name: s.studentName,
    score: s.result!.score ?? null,
    band: s.result!.score != null ? bandShortOf(s.result!.maxScore, s.result!.score) : null,
  }));
}

/** 报告纯文本化（复制文本按钮用）：五个板块的简易排版 */
export function classReportToPlainText(
  stats: ClassStats, report: ClassFeedbackReport,
  meta: { essayType: EssayType; essayTypeLabel: string; gradeLevel: string },
): string {
  const cohesionLabel = getCohesionLabel(meta.essayType);
  const lines: string[] = [];
  lines.push('班级讲评报告');
  lines.push(`题型：${meta.essayTypeLabel} · 年级：${meta.gradeLevel} · 参与统计：${stats.studentCount} 人`);
  lines.push(`生成于 ${new Date(report.generatedAt).toLocaleString('zh-CN')}`);
  lines.push('');

  lines.push('一、客观统计');
  if (stats.avgScore != null) {
    lines.push(`平均分 ${stats.avgScore}（最高 ${stats.maxScore} / 最低 ${stats.minScore}${stats.scoreScale ? `，满分 ${stats.scoreScale}` : ''}），有分数 ${stats.scoredCount} 人`);
  }
  if (stats.bandDistribution) {
    const names = ['一档', '二档', '三档', '四档', '五档'];
    lines.push(`五档分布：${stats.bandDistribution.map((n, i) => `${names[i]} ${n} 人`).join(' · ')}`);
  }
  const bd = stats.avgBreakdown;
  if (bd.content != null || bd.language != null || bd.cohesion != null) {
    lines.push(`分项均分：内容 ${bd.content ?? '—'} · 语言 ${bd.language ?? '—'} · ${cohesionLabel} ${bd.cohesion ?? '—'}`);
  }
  const ec = stats.errorCounts;
  lines.push(`错误频次：语法 ${ec.grammar} · 词汇 ${ec.vocabulary} · 句式 ${ec.sentence} · 逻辑 ${ec.logic}`);
  lines.push(`偏题 ${stats.offTopicCount} 人 · 遗漏要点共 ${stats.missedPointCount} 处`);
  if (stats.excludedCount > 0) lines.push(`另有 ${stats.excludedCount} 份生成失败，未计入`);
  if (stats.pendingCount > 0) lines.push(`另有 ${stats.pendingCount} 份尚未生成，未计入`);
  lines.push('');

  lines.push('二、共性问题');
  report.commonProblems.forEach((p, i) => {
    const sev = p.severity === 'high' ? '高' : p.severity === 'low' ? '低' : '中';
    lines.push(`${i + 1}. [${sev}] ${p.title}`);
    lines.push(`   ${p.description}`);
    for (const e of p.examples) {
      lines.push(`   错例：${e.quote}`);
      lines.push(`   改正：${e.corrected}`);
      lines.push(`   点评：${e.note}`);
    }
  });
  lines.push('');

  lines.push('三、建设性意见');
  if (report.suggestions.length === 0) lines.push('（无）');
  report.suggestions.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  lines.push('');

  lines.push('四、亮点展示');
  if (report.highlights.length === 0) lines.push('（无）');
  report.highlights.forEach((h, i) => lines.push(`${i + 1}. “${h.sentence}” —— ${h.studentName}：${h.comment}`));
  lines.push('');

  lines.push('五、评讲课建议');
  if (report.lessonPlan.length === 0) lines.push('（无）');
  report.lessonPlan.forEach((s, i) => lines.push(`${i + 1}. ${s}`));

  return lines.join('\n');
}
