// 学案 Word 导出 —— 严格镜像 worksheetPdf.ts 的打印版式（结构与样式一一对应）：
//   .doc-title/.doc-subtitle/.doc-sep → 居中标题/灰色副标题/分隔线
//   h3.sec-title（左侧黑条）→ 黑体加粗 + 左边框粗线
//   table.hline（仅横线+表头灰底+隔行灰）→ 底边框表格 + 单元格底纹
//   .pe-table 35/65、.split-table 50/50（中缝细线）→ 无框表格 + 中缝右边框
//   .stu-err（红色波浪线）→ Word 原生波浪下划线
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  BorderStyle, AlignmentType, WidthType, UnderlineType, ShadingType, TableLayoutType, LineRuleType,
} from 'docx';
import { saveAs } from 'file-saver';
import JSZip from 'jszip';
import type { EssayType, HandwritingWorksheetResult, ModelEssaySentence, PrintSettings } from '../types';
import { formatScoreBreakdown, isModelEssayTable } from '../types';

// ─── Page layout ────────────────────────────────────
// A4 = 210mm = 11906 DXA. Margins: 700 DXA each side (500 + 200 extra).
// Available: 11906 - 700*2 = 10506 DXA ≈ 10500
const FULL = 10500;  // usable page width in DXA
const HALF = 5250;   // 50% split
const FONT_SONG = { ascii: 'Times New Roman', eastAsia: '宋体', hAnsi: 'Times New Roman', cs: 'Times New Roman' } as const;
const FONT_HEI = { ascii: 'SimHei', eastAsia: 'SimHei', hAnsi: 'SimHei', cs: 'SimHei' } as const;

/** 老数据/异常 LLM 输出的数组字段可能缺失，统一按空数组处理（与 worksheetPdf 的 arr 一致） */
function arr<T>(x: T[] | null | undefined): T[] { return Array.isArray(x) ? x : []; }

// ─── Run / paragraph helpers ────────────────────────

function run(text: string, opts: {
  bold?: boolean; italics?: boolean; size?: number; color?: string;
  hei?: boolean; wave?: boolean;   // hei = 黑体（标题/表头）；wave = 红色波浪线（学生错误词）
} = {}): TextRun {
  return new TextRun({
    text: String(text ?? ''),
    font: opts.hei ? FONT_HEI : FONT_SONG,
    size: opts.size ?? 21,                    // 默认五号 10.5pt（PDF body 10.5pt）
    bold: opts.bold, italics: opts.italics, color: opts.color,
    underline: opts.wave ? { type: UnderlineType.WAVE, color: 'CC0000' } : undefined,
  });
}

function para(runs: TextRun[], opts: {
  align?: 'left' | 'right' | 'center';
  indentFirst?: boolean;                     // text-indent: 2em（PDF .pe-indent）
  before?: number; after?: number; line?: number; lineRule?: 'auto' | 'atLeast' | 'exact';
  borderLeft?: { size: number; color: string };  // PDF 左侧竖条（sec-title / grammar-box）
  borderBottom?: { size: number; color: string }; // PDF .doc-sep / .dict-line
  indentLeft?: number;
} = {}): Paragraph {
  return new Paragraph({
    children: runs,
    alignment: opts.align === 'right' ? AlignmentType.RIGHT : opts.align === 'center' ? AlignmentType.CENTER : undefined,
    indent: {
      firstLine: opts.indentFirst ? 420 : undefined,
      left: opts.indentLeft ?? (opts.borderLeft ? 100 : undefined),
    },
    spacing: {
      before: opts.before ?? 0, after: opts.after ?? 40,
      ...(opts.line ? { line: opts.line, lineRule: opts.lineRule ?? LineRuleType.AUTO } : {}),
    },
    border: {
      ...(opts.borderLeft ? { left: { style: BorderStyle.SINGLE, size: opts.borderLeft.size, color: opts.borderLeft.color, space: 2 } } : {}),
      ...(opts.borderBottom ? { bottom: { style: BorderStyle.SINGLE, size: opts.borderBottom.size, color: opts.borderBottom.color, space: 1 } } : {}),
    },
  });
}

/** .doc-sep：0.5pt 灰色横贯分隔线（空段落压到 2pt 精确行高，不留空行） */
function sep(): Paragraph {
  return para([], { borderBottom: { size: 4, color: '999999' }, before: 30, after: 50, line: 40, lineRule: LineRuleType.EXACT });
}

/** h3.sec-title：黑体 12pt 加粗 + 左侧 5pt 黑条 */
function secTitle(text: string): Paragraph {
  return para([run(text, { hei: true, bold: true, size: 24 })], { borderLeft: { size: 40, color: '333333' }, before: 100, after: 40 });
}

/** h4.sub-title：▸ 前缀，黑体 10.5pt 加粗 */
function subTitle(text: string): Paragraph {
  return para([run(`▸ ${text}`, { hei: true, bold: true, size: 21 })], { before: 40, after: 20 });
}

/** p.small：10pt 深灰 */
function small(text: string, opts: { gray?: boolean; indentFirst?: boolean } = {}): Paragraph {
  return para([run(text, { size: 20, color: opts.gray ? '666666' : '555555' })], { indentFirst: opts.indentFirst });
}

/** 表格后小间距（对应 table.hline 的 margin-bottom；空段落压到 2pt，不留空行） */
function spacer(after = 20): Paragraph {
  return para([], { after, line: 40, lineRule: LineRuleType.EXACT });
}

// ─── Table helpers（table.hline / split-table / pe-table）──

const NO_B = { style: BorderStyle.NONE, size: 0, color: 'auto' } as const;
const NO_BORDERS = { top: NO_B, bottom: NO_B, left: NO_B, right: NO_B } as const;

interface CellSpec { text: string; cls?: 'err' | 'corr' }

/**
 * table.hline：仅横线表格 —— 表头黑体灰底+1pt 下边框，数据行 0.5pt 下边框，隔行灰底。
 * cls: err = 红字（原文），corr = 绿字加粗（修正/改进版）。
 */
function hlineTable(headers: string[], rows: CellSpec[][], widths: number[], zebra = true): Table {
  const cellMargins = { top: 30, bottom: 30, left: 60, right: 60 };
  const styled = (spec: CellSpec, w: number, shade?: string): TableCell => new TableCell({
    children: [para([run(spec.text, {
      size: 20,
      color: spec.cls === 'err' ? '8B1A1A' : spec.cls === 'corr' ? '1A5C1A' : undefined,
      bold: spec.cls === 'corr',
    })], { after: 0 })],
    width: { size: w, type: WidthType.DXA },
    margins: cellMargins,
    borders: { ...NO_BORDERS, bottom: { style: BorderStyle.SINGLE, size: 4, color: 'D0D0D0' } },
    ...(shade ? { shading: { type: ShadingType.CLEAR, fill: shade } } : {}),
  });

  const headerRow = new TableRow({
    children: headers.map((h, i) => new TableCell({
      children: [para([run(h, { hei: true, bold: true, size: 20 })], { after: 0 })],
      width: { size: widths[i], type: WidthType.DXA },
      margins: cellMargins,
      borders: { ...NO_BORDERS, bottom: { style: BorderStyle.SINGLE, size: 8, color: 'BBBBBB' } },
      shading: { type: ShadingType.CLEAR, fill: 'E0E0E0' },
    })),
  });

  const dataRows = rows.map((cells, ri) => new TableRow({
    children: cells.map((c, ci) => styled(c, widths[ci], zebra && ri % 2 === 1 ? 'F5F5F5' : undefined)),
  }));

  return new Table({
    rows: [headerRow, ...dataRows],
    columnWidths: widths,                     // tblGrid 必须显式给列宽，否则 docx 库生成 100tw 最小网格 → fixed 布局下整表塌缩
    width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    borders: { ...NO_BORDERS, insideHorizontal: NO_B, insideVertical: NO_B },
  });
}

/** .pe-table / .split-table：无框两栏，中缝 0.5pt 细线（右栏左边框实现） */
function splitTable(leftParas: Paragraph[], rightParas: Paragraph[], leftWidth: number): Table {
  const rightWidth = FULL - leftWidth - 20;
  const midBorder = { style: BorderStyle.SINGLE, size: 4, color: '999999' };
  return new Table({
    rows: [new TableRow({ children: [
      new TableCell({
        children: leftParas, width: { size: leftWidth, type: WidthType.DXA },
        borders: { ...NO_BORDERS, right: midBorder }, margins: { top: 0, bottom: 0, left: 0, right: 120 },
      }),
      new TableCell({
        children: rightParas, width: { size: rightWidth, type: WidthType.DXA },
        borders: NO_BORDERS, margins: { top: 0, bottom: 0, left: 120, right: 0 },
      }),
    ] })],
    columnWidths: [leftWidth, rightWidth],     // 同上：tblGrid 显式列宽，防止 fixed 布局塌缩
    width: { size: FULL, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    borders: { ...NO_BORDERS, insideHorizontal: NO_B, insideVertical: NO_B },
  });
}

// ─── 错误词高亮（.stu-err 红色波浪线）与段落渲染 ─────

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** 把文本按错误词切成片段（与 worksheetPdf.highlightErrors 同规则：去重、长度≥2、长词优先、词边界） */
function errorSegments(text: string, errors: string[]): { text: string; err: boolean }[] {
  const sorted = [...new Set(errors.filter(e => e && e.length >= 2))].sort((a, b) => b.length - a.length);
  if (!sorted.length) return [{ text, err: false }];
  const re = new RegExp(`\\b(${sorted.map(escapeRe).join('|')})\\b`, 'gi');
  const segs: { text: string; err: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) segs.push({ text: text.slice(last, m.index), err: false });
    segs.push({ text: m[0], err: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ text: text.slice(last), err: false });
  return segs.length ? segs : [{ text, err: false }];
}

/**
 * 行 → TextRun[]：错误词加红色波浪线；italicUpTo = 句首斜体截止下标（续写正文段首句斜体）。
 */
function makeRuns(t: string, opts: { errors?: string[]; italicUpTo?: number; size?: number } = {}): TextRun[] {
  const segs = opts.errors?.length ? errorSegments(t, opts.errors) : [{ text: t, err: false }];
  const runs: TextRun[] = [];
  let offset = 0;
  for (const seg of segs) {
    let p = offset;
    const segEnd = offset + seg.text.length;
    while (p < segEnd) {
      const italic = opts.italicUpTo != null && p < opts.italicUpTo;
      const end = italic ? Math.min(opts.italicUpTo!, segEnd) : segEnd;
      runs.push(run(t.slice(p, end), { size: opts.size ?? 20, italics: italic || undefined, wave: seg.err || undefined }));
      p = end;
    }
    offset = segEnd;
  }
  return runs;
}

/** renderPromptEssayLines 的 docx 版：题干/学生原文通用行渲染（空行段落、称呼、落款右对齐、段首缩进） */
function promptEssayParas(text: string, isContinuation: boolean, errors?: string[]): Paragraph[] {
  const paragraphs = (text || '').split(/\n\n+/).filter(Boolean);
  let bodyParaIdx = 0;
  const out: Paragraph[] = [];
  for (const pg of paragraphs) {
    const lines = pg.split(/\n+/).filter(Boolean);
    for (let li = 0; li < lines.length; li++) {
      const t = lines[li].trim();
      if (/^_{10,}/.test(t)) { out.push(para([run('______', { size: 20 })])); continue; }
      if (/^(Yours|Sincerely|Best|Regards|Love|Cheers)/i.test(t) || /^(Li Hua|Li Ming|Wang Wei|Zhang Wei)$/i.test(t)) {
        out.push(para(makeRuns(t, { errors }), { align: 'right' })); continue;
      }
      if (/^Dear\b/i.test(t)) { out.push(para(makeRuns(t, { errors }))); continue; }
      let italicUpTo: number | undefined;
      if (li === 0) {
        const m = t.match(/^([^.!?]*[.!?])\s*(.*)/s);
        if (m && isContinuation && bodyParaIdx <= 1) italicUpTo = m[1].length;
        bodyParaIdx++;
      }
      out.push(para(makeRuns(t, { errors, italicUpTo }), { indentFirst: true }));
    }
  }
  return out;
}

// ─── Sections（与 worksheetPdf.buildHtml 逐节对应）────

function buildPromptAndEssay(essayPrompt: string, originalEssay: string, isContinuation: boolean, studentErrors: string[]): (Paragraph | Table)[] {
  return [
    secTitle('题目与原文'),
    splitTable(
      [subTitle('作文题干'), ...promptEssayParas(essayPrompt, isContinuation)],
      [subTitle('学生原文'), ...promptEssayParas(originalEssay, isContinuation, studentErrors)],
      Math.round(FULL * 0.35),
    ),
    sep(),
  ];
}

function buildAnalysis(r: HandwritingWorksheetResult): (Paragraph | Table)[] {
  const pa = r.promptAnalysis;
  const covered = arr(pa.coveredPoints).join('、');
  const missedList = arr(pa.missedPoints);

  const left: Paragraph[] = [
    subTitle('审题分析'),
    para([run(pa.isOffTopic ? '[!] 偏题' : '[√] 未偏题', { bold: true, size: 20 })], { after: 20 }),
    (() => {
      const runs = [run(`已覆盖：${covered}`, { size: 20, color: '555555' })];
      if (missedList.length) runs.push(run(`  |  遗漏：${missedList.join('、')}`, { size: 20, color: '8B1A1A' }));
      return para(runs, { after: 20 });
    })(),
  ];
  if (pa.isOffTopic) left.push(small(pa.offTopicDetail || ''));
  left.push(small(pa.overallComment || '', { gray: true }));

  const right: Paragraph[] = [
    para([
      run('▸ 总评', { hei: true, bold: true, size: 21 }),
      ...(r.score != null && r.maxScore ? [run(`  ${r.score}/${r.maxScore} 分`, { bold: true, size: 28 })] : []),
    ], { before: 40, after: 20 }),
    ...(formatScoreBreakdown(r) ? [small(formatScoreBreakdown(r) as string, { gray: true })] : []),
    small(r.overallComment || ''),
  ];

  return [secTitle('审题 & 总评'), splitTable(left, right, HALF), sep()];
}

function buildContinuationAnalysis(r: HandwritingWorksheetResult): (Paragraph | Table)[] {
  const ca = r.continuationAnalysis;
  if (!ca) return [];
  const yn = (b: boolean) => b ? '[√] 是' : '[!] 否';
  const left: Paragraph[] = [
    para([run('段首衔接：', { bold: true }), run(yn(ca.p1ConnectsToOpening))], { after: 20 }),
    para([run('段间过渡：', { bold: true }), run(yn(ca.p1EndConnectsToP2))], { after: 20 }),
  ];
  const right: Paragraph[] = [
    para([run('主旨升华：', { bold: true }), run(ca.hasThemeHighlight ? '[√] 有' : '[!] 无')], { after: 20 }),
    para([run('未自行分段：', { bold: true }), run(yn(ca.onlyTwoParagraphs))], { after: 20 }),
  ];
  const items: (Paragraph | Table)[] = [
    secTitle('续写专项分析'),
    splitTable(left, right, HALF),
    small(ca.detail || '', { indentFirst: true }),
  ];
  const dd = ca.descriptionDiversity;
  if (dd) {
    items.push(subTitle('描写多样性'));
    items.push(hlineTable(
      ['动作', '语言/对话', '情绪/心理', '环境/场景', '评价'],
      [[
        { text: dd.action ? '[√]' : '[—]' }, { text: dd.dialogue ? '[√]' : '[—]' },
        { text: dd.emotion ? '[√]' : '[—]' }, { text: dd.environment ? '[√]' : '[—]' },
        { text: dd.comment || '' },
      ]],
      [1050, 1470, 1470, 1470, 5040],
    ));
    items.push(spacer());
  }
  items.push(sep());
  return items;
}

function buildErrorDiagnosis(r: HandwritingWorksheetResult): (Paragraph | Table)[] {
  const ed = r.errorDiagnosis;
  const items: (Paragraph | Table)[] = [secTitle('错误分类诊断')];
  const tables: [string, string[], CellSpec[][], number[]][] = [
    ['语法错误', ['原文', '修正', '讲解'], arr(ed.grammar).map(e => [{ text: e.original, cls: 'err' as const }, { text: e.corrected, cls: 'corr' as const }, { text: e.explanation }]), [2625, 2940, 4935]],
    ['词汇不当', ['原文', '建议替换', '讲解'], arr(ed.vocabulary).map(e => [{ text: e.original, cls: 'err' as const }, { text: e.suggestion, cls: 'corr' as const }, { text: e.explanation }]), [2310, 3675, 4515]],
    ['句式问题', ['原文', '改进方向', '讲解'], arr(ed.sentence).map(e => [{ text: e.original, cls: 'err' as const }, { text: e.improvement, cls: 'corr' as const }, { text: e.explanation }]), [2940, 3360, 4200]],
    ['逻辑/连贯问题', ['问题', '说明'], arr(ed.logic).map(e => [{ text: e.issue }, { text: e.explanation }]), [3990, 6510]],
  ];
  for (const [label, headers, rows, widths] of tables) {
    if (!rows.length) continue;
    items.push(subTitle(label));
    items.push(hlineTable(headers, rows, widths));
    items.push(spacer());
  }
  items.push(sep());
  return items;
}

function buildGrammarBreakthrough(r: HandwritingWorksheetResult): (Paragraph | Table)[] {
  const items: (Paragraph | Table)[] = [secTitle('重点语法突破')];
  for (const rule of arr(r.grammarBreakthrough.rules)) {
    items.push(para([run(rule.title || '', { hei: true, bold: true, size: 21 })], { borderLeft: { size: 32, color: '666666' }, before: 60, after: 20 }));
    items.push(para([run(rule.explanation || '', { size: 20 })], { borderLeft: { size: 32, color: '666666' }, after: 40 }));
    for (const ex of arr(rule.examples)) {
      items.push(para([run(`· ${ex.en || ''}  ——  ${ex.cn || ''}`, { size: 20, color: '555555' })], { borderLeft: { size: 32, color: '666666' }, after: 40 }));
    }
  }
  items.push(sep());
  return items;
}

function buildVocabularyUpgrade(r: HandwritingWorksheetResult): (Paragraph | Table)[] {
  const rows = arr(r.vocabularyUpgrade.items).map(item => [{
    text: item.original, cls: 'err' as const,
  }, {
    text: arr(item.upgrades).map((u, i) => `${['①', '②', '③'][i] || i + 1} ${u.word}（${u.context}）`).join('  '),
  }]);
  return [
    secTitle('词汇升级训练'),
    ...(rows.length ? [
      hlineTable(['基础词汇', '高级替换（使用语境）'], rows, [1890, 8610]),
      spacer(),
    ] : []),
    sep(),
  ];
}

function buildSentenceImprovement(r: HandwritingWorksheetResult): (Paragraph | Table)[] {
  const rows = arr(r.sentenceImprovement.items).map(item => [
    { text: item.original, cls: 'err' as const }, { text: item.analysis },
    { text: item.improved, cls: 'corr' as const }, { text: item.highlights },
  ]);
  return [
    secTitle('句式提升工坊'),
    ...(rows.length ? [
      hlineTable(['原句', '问题分析', '改进版', '技法点拨'], rows, [2415, 2100, 3150, 2835]),
      spacer(),
    ] : []),
    sep(),
  ];
}

function buildModelEssay(r: HandwritingWorksheetResult, isContinuation: boolean): (Paragraph | Table)[] {
  const items: (Paragraph | Table)[] = [secTitle('范文升级版')];

  if (isContinuation && isModelEssayTable(r.modelEssay)) {
    const widths = [840, 6510, 3150];
    let num = 1;   // 句号跨段连续（与 PDF 一致）
    const addPara = (label: string, sentences: ModelEssaySentence[]) => {
      if (!sentences.length) return;
      items.push(subTitle(label));
      items.push(hlineTable(
        ['句', '英文', '功能 / 技法'],
        sentences.map(s => [{ text: String(num++) }, { text: s.sentence }, { text: s.function }]),
        widths,
      ));
      items.push(spacer());
    };
    addPara('第一段', arr(r.modelEssay.paragraph1));
    addPara('第二段', arr(r.modelEssay.paragraph2));
  } else {
    const paragraphs = ((r.modelEssay as string) || '').split(/\n\n+/).filter(Boolean);
    for (let i = 0; i < paragraphs.length; i++) {
      const text = paragraphs[i].replace(/\n/g, ' ').trim();
      if (i === 0 && /^(Dear|To)\b/i.test(text)) {
        items.push(para([run(text, { size: 20 })], { after: 80 }));
      } else if (i === paragraphs.length - 1 && /^(Yours|Sincerely|Best|Regards|Love|Cheers)/i.test(text)) {
        items.push(para([run(text, { size: 20 })], { align: 'right', before: 80, after: 80 }));
      } else {
        items.push(para([run(text, { size: 20 })], { indentFirst: true, after: 100, line: 300 }));
      }
    }
  }
  items.push(sep());
  return items;
}

function buildConsolidation(r: HandwritingWorksheetResult): (Paragraph | Table)[] {
  const items: (Paragraph | Table)[] = [secTitle('巩固练习（范文默写）')];
  arr(r.consolidationExercises).forEach((ex, i) => {
    items.push(para([
      run(`${i + 1}. ${ex.cn || ''}`, { size: 21 }),
      run(`  [${ex.pattern || ''}]`, { size: 17, italics: true, color: '999999' }),
    ], { before: 120, after: 20 }));
    items.push(para([], { borderBottom: { size: 4, color: 'B0B0B0' }, after: 20, line: 260 }));  // .dict-line ×2
    items.push(para([], { borderBottom: { size: 4, color: 'B0B0B0' }, after: 20, line: 260 }));
  });
  return items;
}

// ─── Main export ────────────────────────────────────

export interface WorksheetDocxParams {
  studentName: string;
  gradeLevel: string;
  essayType: EssayType;
  essayPrompt: string;
  originalEssay: string;
  r: HandwritingWorksheetResult;
  printSettings: PrintSettings;
}

async function buildWorksheetDocx(p: WorksheetDocxParams): Promise<Blob> {
  const { studentName, gradeLevel, essayType, essayPrompt, originalEssay, r, printSettings } = p;
  const isContinuation = essayType === 'continuation';

  // 学生错误词（语法/词汇/句式的 original）→ 原文栏红色波浪线
  const studentErrors: string[] = [];
  for (const cat of ['grammar', 'vocabulary', 'sentence'] as const) {
    for (const e of arr(r.errorDiagnosis[cat] as any[])) studentErrors.push(e.original || '');
  }

  const children: (Paragraph | Table)[] = [
    // .student-header（右对齐）
    para([run(`学生姓名：${studentName}  |  ${gradeLevel}`, { size: 20 })], { align: 'right', after: 120 }),
    // .doc-title / .doc-subtitle
    para([run(printSettings.title, { hei: true, bold: true, size: 28 })], { align: 'center', after: 20 }),
    para([run(printSettings.subtitle, { size: 21, color: '666666' })], { align: 'center', after: 60 }),
    sep(),
    ...buildPromptAndEssay(essayPrompt, originalEssay, isContinuation, studentErrors),
    ...buildAnalysis(r),
    ...buildContinuationAnalysis(r),
    ...buildErrorDiagnosis(r),
    ...buildGrammarBreakthrough(r),
    ...buildVocabularyUpgrade(r),
    ...buildSentenceImprovement(r),
    ...buildModelEssay(r, isContinuation),
    ...buildConsolidation(r),
  ];

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT_SONG, size: 21 } } } },
    sections: [{
      properties: { page: { margin: { top: 700, bottom: 700, left: 700, right: 700 } } },
      children,
    }],
  });

  return Packer.toBlob(doc);
}

/** 导出单个学生的学案 Word 文档（版式与打印 PDF 一致） */
export async function exportHandwritingWorksheetDocx(p: WorksheetDocxParams): Promise<void> {
  saveAs(await buildWorksheetDocx(p), `学案-${p.studentName || '未命名'}.docx`);
}

/** 批量导出：逐个生成 docx 打包为一个 zip 下载（重名学生自动加序号） */
export async function exportAllHandwritingWorksheetsDocx(list: WorksheetDocxParams[]): Promise<void> {
  const zip = new JSZip();
  const used = new Set<string>();
  for (const p of list) {
    const blob = await buildWorksheetDocx(p);
    let name = `学案-${p.studentName || '未命名'}.docx`;
    let i = 2;
    while (used.has(name)) name = `学案-${p.studentName || '未命名'}(${i++}).docx`;
    used.add(name);
    zip.file(name, blob);
  }
  const zipped = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  saveAs(zipped, `学案合集-${list.length}份.zip`);
}
