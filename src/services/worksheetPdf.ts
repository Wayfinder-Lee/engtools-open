import type { ClassFeedbackReport, ClassStats, EssayType, HandwritingWorksheetResult, ModelEssaySentence, ModelEssayTable, PrintSettings } from '../types';
import { formatScoreBreakdown, getCohesionLabel, isModelEssayTable } from '../types';

function esc(text: string): string {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function arr<T>(x: T[] | null | undefined): T[] { return Array.isArray(x) ? x : []; }

// ─── CSS ───────────────────────────────────────────

const CSS = `
* { margin: 0; padding: 0; box-sizing: border-box; }

:root { --s: 1; --fs: 1; }

@page { size: A4; margin: 0.8cm 1.5cm 0.8cm 1.5cm; }

body {
  font-family: "Times New Roman", "SimSun", "宋体", serif;
  font-size: calc(10.5pt * var(--fs)); line-height: calc(1.35 * var(--s)); color: #000;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}

/* ── Header ── */
.student-header { text-align: right; font-size: calc(10pt * var(--fs)); color: #000; margin-bottom: calc(6pt * var(--s)); }

/* ── Title ── */
.doc-title { text-align: center; font-family: "SimHei","黑体","Heiti SC",sans-serif; font-size: calc(14pt * var(--fs)); font-weight: 700; margin-bottom: calc(1pt * var(--s)); }
.doc-subtitle { text-align: center; font-family: "SimSun","Times New Roman",serif; font-size: calc(10.5pt * var(--fs)); color: #666; margin-bottom: calc(3pt * var(--s)); }
.doc-sep { border: none; border-top: 0.5pt solid #999; margin: calc(2pt * var(--s)) 0 calc(4pt * var(--s)); }

/* ── Section headings (left bar) ── */
h3.sec-title { font-family: "SimHei","黑体","Heiti SC",sans-serif; font-size: calc(12pt * var(--fs)); font-weight: 700; border-left: 5pt solid #333; padding-left: calc(5pt * var(--s)); margin: calc(5pt * var(--s)) 0 calc(2pt * var(--s)); line-height: calc(1.25 * var(--s)); }
h4.sub-title { font-family: "SimHei","黑体","Heiti SC",sans-serif; font-size: calc(10.5pt * var(--fs)); font-weight: 700; color: #2d2d2d; margin: calc(2pt * var(--s)) 0 calc(1pt * var(--s)); }

/* ── Body text ── */
p, li { font-size: calc(10.5pt * var(--fs)); line-height: calc(1.4 * var(--s)); margin-bottom: calc(2pt * var(--s)); }
.small { font-size: calc(10pt * var(--fs)); color: #555; }
.bold { font-weight: 700; }
.i { font-style: italic; }
.right { text-align: right; }
.indent { text-indent: 2em; }
.gray { color: #666; }
.label-hei { font-family: "SimHei","黑体","Heiti SC",sans-serif; font-weight: 700; font-size: calc(10.5pt * var(--fs)); }
.check-hei { font-family: "SimHei","黑体","Heiti SC",sans-serif; font-size: calc(10pt * var(--fs)); }

/* ── Tables (horizontal lines only) ── */
table.hline { width: 100%; border-collapse: collapse; margin: calc(2pt * var(--s)) 0 calc(3pt * var(--s)); font-size: calc(10pt * var(--fs)); }
table.hline th { font-family: "SimHei","黑体","Heiti SC",sans-serif; font-size: calc(10pt * var(--fs)); font-weight: 700; background: #e0e0e0; padding: calc(1.5pt * var(--s)) calc(3pt * var(--s)); border: none; border-bottom: 1pt solid #bbb; text-align: left; vertical-align: top; }
table.hline td { font-size: calc(10pt * var(--fs)); padding: calc(1.5pt * var(--s)) calc(3pt * var(--s)); border: none; border-bottom: 0.5pt solid #d0d0d0; vertical-align: top; }
table.hline tr:nth-child(even) td { background: #f5f5f5; }
td.corr { font-weight: 700; color: #1a5c1a; }
td.err { color: #8b1a1a; }
th.me-num, td.me-num { width: 8%; text-align: center; }
th.me-func, td.me-func { width: 30%; }

/* ── Grammar box ── */
.grammar-box { border-left: 4pt solid #666; padding: calc(2pt * var(--s)) calc(6pt * var(--s)); margin: calc(3pt * var(--s)) 0; }
.grammar-box .grammar-title { font-family: "SimHei","黑体","Heiti SC",sans-serif; font-weight: 700; font-size: calc(10.5pt * var(--fs)); margin-bottom: calc(1pt * var(--s)); }
.grammar-box p { font-size: calc(10pt * var(--fs)); line-height: calc(1.35 * var(--s)); margin-bottom: calc(2pt * var(--s)); }

/* ── Checklist ── */
.checklist-hei { margin: calc(1pt * var(--s)) 0; padding: 0; list-style: none; }
.checklist-hei li { font-family: "SimHei","黑体","Heiti SC",sans-serif; font-size: calc(10pt * var(--fs)); margin-bottom: calc(1pt * var(--s)); line-height: calc(1.2 * var(--s)); }

/* ── Dictation ── */
.dict-item { margin-bottom: calc(6pt * var(--s)); }
.dict-cn { font-size: calc(10.5pt * var(--fs)); }
.dict-pattern { font-size: calc(8.5pt * var(--fs)); color: #999; font-style: italic; }
.dict-line { border-bottom: 0.5pt solid #b0b0b0; height: calc(13pt * var(--s)); margin-bottom: calc(1pt * var(--s)); }

/* ── Batch page breaks ── */
.student-page { break-after: page; page-break-after: always; }
.student-page:last-child { break-after: auto; page-break-after: auto; }

/* ── On-screen guidance bar (screen only, never printed) ── */
.print-hint {
  background: #fff8e1; border-bottom: 0.5pt solid #e0c06c; color: #6b5410;
  font-size: 10pt; text-align: center; padding: 3pt 6pt; margin: 0 0 6pt 0;
}
@media print { .print-hint { display: none; } }

/* ── Prompt+Essay layout ── */
.pe-table { width: 100%; border-collapse: collapse; margin: calc(1pt * var(--s)) 0 calc(3pt * var(--s)); }
.pe-table td { vertical-align: top; border: none; padding: 0; }
.pe-left { width: 35%; padding-right: calc(6pt * var(--s)); }
.pe-right { width: 65%; padding-left: calc(6pt * var(--s)); border-left: 0.5pt solid #999; }
.pe-heading { font-family: "SimHei","黑体","Heiti SC",sans-serif; font-size: calc(10.5pt * var(--fs)); font-weight: 700; margin-bottom: calc(2pt * var(--s)); }
.pe-text { font-size: calc(10pt * var(--fs)); line-height: calc(1.35 * var(--s)); margin-bottom: calc(2pt * var(--s)); }
.pe-indent { text-indent: 2em; font-size: calc(10pt * var(--fs)); line-height: calc(1.35 * var(--s)); margin-bottom: calc(2pt * var(--s)); }
.stu-err { color: #c00; text-decoration: underline wavy #c00; }

/* ── 50/50 and 70/30 split tables ── */
.split-table { width: 100%; border-collapse: collapse; margin: calc(1pt * var(--s)) 0 calc(2pt * var(--s)); }
.split-table td { vertical-align: top; border: none; padding: 0; }
.s50-left { width: 50%; padding-right: calc(6pt * var(--s)); }
.s50-right { width: 50%; padding-left: calc(6pt * var(--s)); border-left: 0.5pt solid #999; }
.s70-left { width: 70%; padding-right: calc(6pt * var(--s)); }
.s30-right { width: 30%; padding-left: calc(6pt * var(--s)); border-left: 0.5pt solid #999; }

@media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
@media screen { body { width: 18cm; margin: 0 auto; } }
`;

// ─── HTML builders ─────────────────────────────────

/** For continuation writing: italicize first sentence of a body paragraph */
function italicFirstSentence(text: string, isContinuation: boolean, paraIndex: number): string {
  if (!isContinuation) return esc(text);
  // Only italicize first sentence of body paragraphs (para 0 and para 1)
  if (paraIndex > 1) return esc(text);
  const m = text.match(/^([^.!?]*[.!?])\s*(.*)/s);
  if (!m) return esc(text);
  return `<i>${esc(m[1])}</i> ${esc(m[2] || '')}`;
}

/** Highlight error words in red */
function highlightErrors(text: string, errors: string[]): string {
  let result = esc(text);
  // Sort errors by length descending to prevent partial matches
  const sorted = [...new Set(errors.filter(e => e.length >= 2))].sort((a, b) => b.length - a.length);
  for (const err of sorted) {
    const escaped = err.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'gi');
    result = result.replace(re, `<span class="stu-err">$&</span>`);
  }
  return result;
}

function renderPromptEssayLines(text: string, isContinuation: boolean, errors?: string[]): string {
  const paragraphs = (text || '').split(/\n\n+/).filter(Boolean);
  let bodyParaIdx = 0;
  const result: string[] = [];

  for (const para of paragraphs) {
    const lines = para.split(/\n+/).filter(Boolean);
    for (let li = 0; li < lines.length; li++) {
      const t = lines[li].trim();
      if (/^_{10,}/.test(t)) { result.push(`<p class="pe-text">______</p>`); continue; }
      if (/^(Yours|Sincerely|Best|Regards|Love|Cheers)/i.test(t) || /^(Li Hua|Li Ming|Wang Wei|Zhang Wei)$/i.test(t)) {
        result.push(`<p class="right pe-text">${errors ? highlightErrors(t, errors) : esc(t)}</p>`); continue;
      }
      if (/^Dear\b/i.test(t)) {
        result.push(`<p class="pe-text">${errors ? highlightErrors(t, errors) : esc(t)}</p>`); continue;
      }
      // Apply error highlights first (on raw text), then italic
      const raw = errors ? highlightErrors(t, errors) : esc(t);
      let content: string;
      if (li === 0) {
        // raw is already escaped + highlighted; extract first sentence for italic
        const m = t.match(/^([^.!?]*[.!?])\s*(.*)/s);
        if (m && isContinuation && bodyParaIdx <= 1) {
          const hiFirst = errors ? highlightErrors(m[1], errors) : esc(m[1]);
          const hiRest = errors ? highlightErrors(m[2] || '', errors) : esc(m[2] || '');
          content = `<i>${hiFirst}</i> ${hiRest}`;
        } else {
          content = raw;
        }
        bodyParaIdx++;
      } else {
        content = raw;
      }
      result.push(`<p class="pe-indent">${content}</p>`);
    }
  }
  return result.join('');
}

function buildErrorDiagnosis(r: HandwritingWorksheetResult): string {
  const ed = r.errorDiagnosis;
  let html = '';
  const tables: [string, string[], any[]][] = [
    ['语法错误', ['原文', '修正', '讲解'], arr(ed.grammar).map(e => [e.original, e.corrected, e.explanation])],
    ['词汇不当', ['原文', '建议替换', '讲解'], arr(ed.vocabulary).map(e => [e.original, e.suggestion, e.explanation])],
    ['句式问题', ['原文', '改进方向', '讲解'], arr(ed.sentence).map(e => [e.original, e.improvement, e.explanation])],
    ['逻辑/连贯问题', ['问题', '说明'], arr(ed.logic).map(e => [e.issue, e.explanation])],
  ];
  for (const [label, headers, rows] of tables) {
    if (!rows.length) continue;
    html += `<h4 class="sub-title">▸ ${label}</h4><table class="hline"><tr>`;
    for (const h of headers) html += `<th>${esc(h)}</th>`;
    html += '</tr>';
    for (const row of rows) {
      html += '<tr>';
      row.forEach((c: string, ci: number) => {
        html += `<td class="${ci === 1 ? 'corr' : ci === 0 ? 'err' : ''}">${esc(c)}</td>`;
      });
      html += '</tr>';
    }
    html += '</table>';
  }
  return html;
}

function buildModelEssayTableHtml(essay: ModelEssayTable): string {
  let html = '';
  let num = 1;
  const renderPara = (title: string, sentences: ModelEssaySentence[]) => {
    html += `<h4 class="sub-title">${title}</h4><table class="hline"><tr><th class="me-num">句</th><th>英文</th><th class="me-func">功能 / 技法</th></tr>`;
    for (const s of sentences) {
      html += `<tr><td class="me-num">${num++}</td><td>${esc(s.sentence)}</td><td class="me-func">${esc(s.function)}</td></tr>`;
    }
    html += '</table>';
  };
  renderPara('▸ 第一段', arr(essay.paragraph1));
  renderPara('▸ 第二段', arr(essay.paragraph2));
  return html;
}

function buildModelEssay(r: HandwritingWorksheetResult, isContinuation: boolean): string {
  // 读后续写：表格结构
  if (isContinuation && isModelEssayTable(r.modelEssay)) {
    return buildModelEssayTableHtml(r.modelEssay);
  }
  // 应用文：字符串段落
  const paragraphs = (r.modelEssay as string || '').split(/\n\n+/).filter(Boolean);
  let html = '';
  let bodyIdx = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    const text = paragraphs[i].replace(/\n/g, ' ').trim();
    if (i === 0 && /^(Dear|To)\b/i.test(text)) {
      html += `<p class="pe-text">${esc(text)}</p>`;
    } else if (i === paragraphs.length - 1 && /^(Yours|Sincerely|Best|Regards|Love|Cheers)/i.test(text)) {
      html += `<p class="right pe-text">${esc(text)}</p>`;
    } else {
      const content = italicFirstSentence(text, isContinuation, bodyIdx);
      bodyIdx++;
      html += `<p class="pe-indent">${content}</p>`;
    }
  }
  return html;
}

function buildContinuationAnalysis(r: HandwritingWorksheetResult): string {
  const ca = r.continuationAnalysis;
  if (!ca) return '';
  const dd = ca.descriptionDiversity;
  return `
<h3 class="sec-title">续写专项分析</h3>
<table class="split-table"><tr>
<td class="s50-left">
  <p><span class="bold">段首衔接：</span>${ca.p1ConnectsToOpening ? '[√] 是' : '[!] 否'}</p>
  <p><span class="bold">段间过渡：</span>${ca.p1EndConnectsToP2 ? '[√] 是' : '[!] 否'}</p>
</td>
<td class="s50-right">
  <p><span class="bold">主旨升华：</span>${ca.hasThemeHighlight ? '[√] 有' : '[!] 无'}</p>
  <p><span class="bold">未自行分段：</span>${ca.onlyTwoParagraphs ? '[√] 是' : '[!] 否'}</p>
</td>
</tr></table>
<p class="small indent">${esc(ca.detail)}</p>

${dd ? `
<h4 class="sub-title">▸ 描写多样性</h4>
<table class="hline"><tr><th>动作</th><th>语言/对话</th><th>情绪/心理</th><th>环境/场景</th><th>评价</th></tr>
<tr>
  <td>${dd.action ? '[√]' : '[—]'}</td>
  <td>${dd.dialogue ? '[√]' : '[—]'}</td>
  <td>${dd.emotion ? '[√]' : '[—]'}</td>
  <td>${dd.environment ? '[√]' : '[—]'}</td>
  <td>${esc(dd.comment || '')}</td>
</tr></table>` : ''}
<hr class="doc-sep">
`;
}

// ─── Full page HTML ────────────────────────────────

function buildHtml(
  studentName: string, gradeLevel: string,
  essayPrompt: string, originalEssay: string,
  r: HandwritingWorksheetResult, settings: PrintSettings,
  promptSummary?: string,
): string {
  const isContinuation = !!promptSummary;
  const section = (_key: string, html: string) => html;
  // Collect student error words for red highlighting
  const studentErrors: string[] = [];
  for (const cat of ['grammar','vocabulary','sentence'] as const) {
    for (const e of arr(r.errorDiagnosis[cat] as any[])) studentErrors.push(e.original || '');
  }

  const pa = r.promptAnalysis;
  const offTopicText = pa.isOffTopic ? '[!] 偏题' : '[√] 未偏题';
  const covered = arr(pa.coveredPoints).map(p => esc(p)).join('、');
  const missed = arr(pa.missedPoints).length > 0
    ? ` | <span style="color:#8b1a1a;">遗漏：${arr(pa.missedPoints).map(p => esc(p)).join('、')}</span>` : '';

  return `
<div class="student-header">学生姓名：${esc(studentName)} &nbsp;|&nbsp; ${esc(gradeLevel)}</div>

<h1 class="doc-title">${esc(settings.title)}</h1>
<p class="doc-subtitle">${esc(settings.subtitle)}</p>
<hr class="doc-sep">

${section('promptAndEssay', `
<h3 class="sec-title">题目与原文</h3>
<table class="pe-table"><tr>
<td class="pe-left"><p class="pe-heading">▸ 作文题干</p>${renderPromptEssayLines(promptSummary || essayPrompt, isContinuation)}</td>
<td class="pe-right"><p class="pe-heading">▸ 学生原文</p>${renderPromptEssayLines(originalEssay, isContinuation, studentErrors)}</td>
</tr></table>
<hr class="doc-sep">
`)}

${section('analysis', `
<h3 class="sec-title">审题 &amp; 总评</h3>
<table class="split-table"><tr>
<td class="s50-left">
  <p class="label-hei">▸ 审题分析</p>
  <p style="margin-bottom:1pt;"><span class="bold">${offTopicText}</span></p>
  <p class="small">已覆盖：${covered}${missed}</p>
  ${pa.isOffTopic ? `<p class="small">${esc(pa.offTopicDetail)}</p>` : ''}
  <p class="small gray">${esc(pa.overallComment)}</p>
</td>
<td class="s50-right">
  <p class="label-hei">▸ 总评${(r.score != null && r.maxScore) ? ` &nbsp; <span style="font-size:calc(14pt*var(--fs));font-weight:700;">${r.score}/${r.maxScore} 分</span>` : ''}</p>
  ${formatScoreBreakdown(r) ? `<p class="small gray" style="margin-top:1pt;">${formatScoreBreakdown(r)}</p>` : ''}
  <p class="small" style="margin-top:1pt;">${esc(r.overallComment)}</p>
</td>
</tr></table>
<hr class="doc-sep">
`)}

${buildContinuationAnalysis(r)}

${section('errorDiagnosis', `
<h3 class="sec-title">错误分类诊断</h3>
${buildErrorDiagnosis(r)}
<hr class="doc-sep">
`)}

${section('grammarBreakthrough', `
<h3 class="sec-title">重点语法突破</h3>
${arr(r.grammarBreakthrough.rules).map(rule => `
<div class="grammar-box">
  <p class="grammar-title">${esc(rule.title)}</p>
  <p>${esc(rule.explanation)}</p>
  ${arr(rule.examples).map(ex => `<p class="small">· ${esc(ex.en)} &nbsp;——&nbsp; ${esc(ex.cn)}</p>`).join('')}
</div>`).join('')}
<hr class="doc-sep">
`)}

${section('vocabularyUpgrade', `
<h3 class="sec-title">词汇升级训练</h3>
<table class="hline"><tr><th>基础词汇</th><th>高级替换（使用语境）</th></tr>
${arr(r.vocabularyUpgrade.items).map(item => {
  const upgrades = arr(item.upgrades).map((u, i) => `${['①','②'][i]} ${esc(u.word)}（${esc(u.context)}）`).join(' &nbsp; ');
  return `<tr><td class="err">${esc(item.original)}</td><td>${upgrades}</td></tr>`;
}).join('')}
</table>
<hr class="doc-sep">
`)}

${section('sentenceImprovement', `
<h3 class="sec-title">句式提升工坊</h3>
<table class="hline"><tr><th>原句</th><th>问题分析</th><th>改进版</th><th>技法点拨</th></tr>
${arr(r.sentenceImprovement.items).map(item =>
  `<tr><td class="err">${esc(item.original)}</td><td>${esc(item.analysis)}</td><td class="corr">${esc(item.improved)}</td><td>${esc(item.highlights)}</td></tr>`
).join('')}
</table>
<hr class="doc-sep">
`)}

${section('modelEssay', `
<h3 class="sec-title">范文升级版</h3>
${buildModelEssay(r, isContinuation)}
<hr class="doc-sep">
`)}

${section('consolidation', `
<h3 class="sec-title">巩固练习（范文默写）</h3>
${arr(r.consolidationExercises).map((ex, i) => `
<div class="dict-item">
  <p class="dict-cn">${i + 1}. ${esc(ex.cn)} &nbsp;<span class="dict-pattern">[${esc(ex.pattern)}]</span></p>
  <div class="dict-line"></div>
  <div class="dict-line"></div>
</div>`).join('')}
`)}
`;
}

// ─── Public API ─────────────────────────────────────

const A4_PAGE_PX = 1062;
const PAGE_LIMIT = 2;

function fitElement(el: HTMLElement, targetPages: number) {
  const target = A4_PAGE_PX * targetPages * 0.94; // 6% safety margin for print vs screen + page-break rounding
  for (let round = 0; round < 6; round++) {
    const h = el.scrollHeight;
    if (h <= target) break; // fits within 2 pages — stop (never allow overflow)

    const ratio = target / h;
    const prevS = parseFloat(getComputedStyle(el).getPropertyValue('--s')) || 1;
    const newS = prevS * ratio;
    el.style.setProperty('--s', newS.toFixed(4));

    // If spacing compression exceeds 20%, scale font-size too (min 9pt)
    if (newS < 0.8) {
      const prevFs = parseFloat(getComputedStyle(el).getPropertyValue('--fs')) || 1;
      const newFs = Math.max(prevFs * ratio, 9 / 10.5); // 9pt floor
      el.style.setProperty('--fs', newFs.toFixed(4));
    }

    el.offsetHeight; // force reflow before next measurement
  }
}

/** 屏显操作指引（打印时隐藏）：告知如何在打印对话框中选择打印或另存为 PDF */
const PRINT_HINT = `<div class="print-hint">🖨️ 需要纸质版：直接点「打印」　|　需要 PDF 文件：目标打印机选择「另存为 PDF」（Safari 为「存储为 PDF」）</div>`;

function openAndPrint(bodyHtml: string, title: string, pageLimit = PAGE_LIMIT) {
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${title}</title><style>${CSS}</style></head><body>${PRINT_HINT}${bodyHtml}</body></html>`;
  const w = window.open('', '_blank', 'width=800,height=600');
  if (!w) return;
  w.document.write(html);
  w.document.close();
  w.onload = () => {
    setTimeout(() => {
      const pages = w!.document.querySelectorAll('.student-page');
      if (pages.length > 0) {
        // Batch: fit each student independently
        for (let i = 0; i < pages.length; i++) fitElement(pages[i] as HTMLElement, pageLimit);
      } else {
        // Single student
        fitElement(w!.document.body, pageLimit);
      }
      w!.print();
    }, 500);
  };
}

export function printWorksheetPdf(
  studentName: string, gradeLevel: string,
  essayPrompt: string, originalEssay: string,
  r: HandwritingWorksheetResult, settings: PrintSettings,
  promptSummary?: string,
): void {
  openAndPrint(buildHtml(studentName, gradeLevel, essayPrompt, originalEssay, r, settings, promptSummary), `学案 - ${studentName}`);
}

interface StudentData {
  studentName: string; gradeLevel: string;
  originalEssay: string; result: HandwritingWorksheetResult;
}

export function printAllWorksheetsPdf(
  essayPrompt: string, students: StudentData[], settings: PrintSettings,
  promptSummary?: string,
): void {
  const pages = students.map(s =>
    `<div class="student-page">${buildHtml(s.studentName, s.gradeLevel, essayPrompt, s.originalEssay, s.result, settings, promptSummary)}</div>`
  ).join('');
  openAndPrint(pages, '学案合集');
}

// ─── 班级讲评报告打印（④ 讲评报告；白纸黑字，severity 用印刷定色）──

export interface ClassReportPdfParams {
  stats: ClassStats;
  report: ClassFeedbackReport;
  /** 成绩名册（录入顺序，无名次列；老师私有材料） */
  roster: { name: string; score: number | null; band: string | null }[];
  essayType: EssayType;
  essayTypeLabel: string;
  gradeLevel: string;
  /** promptSummary?.summary || essayPrompt，调用方截断（≤300 字） */
  essayPromptDigest: string;
  dateLabel: string;
}

const SEV_PRINT_COLOR: Record<ClassFeedbackReport['commonProblems'][number]['severity'], string> = {
  high: '#8b1a1a', medium: '#9a6b00', low: '#1a5c1a',
};
const SEV_PRINT_LABEL = { high: '高', medium: '中', low: '低' } as const;

function buildClassReportHtml(p: ClassReportPdfParams): string {
  const { stats, report, roster, essayType, essayTypeLabel, gradeLevel, essayPromptDigest, dateLabel } = p;

  // 一、客观统计
  const statLines: string[] = [];
  const excludedNote = stats.excludedCount > 0 ? `（另有 ${stats.excludedCount} 份生成失败，未计入）` : '';
  const pendingNote = stats.pendingCount > 0 ? `（另有 ${stats.pendingCount} 份尚未生成，未计入）` : '';
  statLines.push(`<p><span class="label-hei">▸ 整体</span> &nbsp; 参与统计 ${stats.studentCount} 人${excludedNote}${pendingNote}${stats.avgScore != null ? ` &nbsp;·&nbsp; 平均分 <b>${stats.avgScore}</b>（最高 ${stats.maxScore} / 最低 ${stats.minScore}${stats.scoreScale ? `，满分 ${stats.scoreScale}` : ''}）` : ''}</p>`);
  if (stats.bandDistribution) {
    const names = ['一档', '二档', '三档', '四档', '五档'];
    const total = stats.scoredCount || 1;
    statLines.push(`<table class="hline"><tr><th>档位（一档最低）</th>${names.map(n => `<th style="text-align:center;">${n}</th>`).join('')}</tr>`);
    statLines.push(`<tr><td class="label-hei">人数</td>${stats.bandDistribution.map(n => `<td style="text-align:center;">${n}</td>`).join('')}</tr>`);
    statLines.push(`<tr><td class="label-hei">占比</td>${stats.bandDistribution.map(n => `<td style="text-align:center;">${Math.round((n / total) * 100)}%</td>`).join('')}</tr></table>`);
  }
  const bd = stats.avgBreakdown;
  if (bd.content != null || bd.language != null || bd.cohesion != null) {
    statLines.push(`<p class="small">分项均分：内容 ${bd.content ?? '—'} · 语言 ${bd.language ?? '—'} · ${esc(getCohesionLabel(essayType))} ${bd.cohesion ?? '—'}</p>`);
  }
  statLines.push(`<p class="small">错误频次：语法 ${stats.errorCounts.grammar} · 词汇 ${stats.errorCounts.vocabulary} · 句式 ${stats.errorCounts.sentence} · 逻辑 ${stats.errorCounts.logic} &nbsp;|&nbsp; 偏题 ${stats.offTopicCount} 人 · 遗漏要点共 ${stats.missedPointCount} 处</p>`);
  if (roster.length > 0) {
    statLines.push(`<h4 class="sub-title">▸ 成绩名册（录入顺序）</h4><table class="hline"><tr><th style="width:12%;">序号</th><th>姓名</th><th style="width:25%;">分数</th><th style="width:25%;">档位</th></tr>`);
    roster.forEach((r, i) => {
      statLines.push(`<tr><td class="me-num">${i + 1}</td><td>${esc(r.name)}</td><td>${r.score != null ? esc(String(r.score)) : '—'}</td><td>${r.band ? esc(r.band) : '—'}</td></tr>`);
    });
    statLines.push('</table>');
  }

  // 二、共性问题
  const problems = report.commonProblems.length ? report.commonProblems.map(prob => `
    <h4 class="sub-title"><span style="color:${SEV_PRINT_COLOR[prob.severity]};">[${SEV_PRINT_LABEL[prob.severity]}]</span> ${esc(prob.title)}</h4>
    <p>${esc(prob.description)}</p>
    ${prob.examples.length ? `<table class="hline"><tr><th style="width:38%;">有同学写道（原文）</th><th style="width:34%;">改正</th><th>点评</th></tr>
    ${prob.examples.map(e => `<tr><td class="err">${esc(e.quote)}</td><td class="corr">${esc(e.corrected)}</td><td>${esc(e.note)}</td></tr>`).join('')}</table>` : ''}`).join('') : '<p class="small gray">（本次未提炼出共性问题）</p>';

  // 四、亮点展示
  const highlights = report.highlights.length
    ? report.highlights.map(h => `<p><i>“${esc(h.sentence)}”</i> &nbsp;——&nbsp; <b>${esc(h.studentName)}</b>：${esc(h.comment)}</p>`).join('')
    : '<p class="small gray">（无）</p>';

  const list = (items: string[]) => items.length
    ? `<ol style="padding-left:1.6em;">${items.map(s => `<li>${esc(s)}</li>`).join('')}</ol>`
    : '<p class="small gray">（无）</p>';

  return `
<div class="student-header">${esc(essayTypeLabel)} &nbsp;|&nbsp; ${esc(gradeLevel)} &nbsp;|&nbsp; ${esc(dateLabel)}</div>
<h1 class="doc-title">班级讲评报告</h1>
<p class="doc-subtitle">———  ${esc(essayPromptDigest)}  ———</p>
<hr class="doc-sep">

<h3 class="sec-title">一、客观统计</h3>
${statLines.join('')}
<hr class="doc-sep">

<h3 class="sec-title">二、共性问题</h3>
${problems}
<hr class="doc-sep">

<h3 class="sec-title">三、建设性意见</h3>
${list(report.suggestions)}
<hr class="doc-sep">

<h3 class="sec-title">四、亮点展示（具名表扬）</h3>
${highlights}
<hr class="doc-sep">

<h3 class="sec-title">五、评讲课建议</h3>
${list(report.lessonPlan)}
`;
}

/** 打开打印窗口：≤3 页自动缩排适配（fitElement 收敛在 openAndPrint 内，报告无 .student-page 走整页 fit） */
export function printClassReportPdf(p: ClassReportPdfParams): void {
  openAndPrint(buildClassReportHtml(p), '班级讲评报告', 3);
}
