// 班级讲评报告 Word 导出 —— 严格镜像 worksheetPdf.ts 的 printClassReportPdf 版式
// （helper 集与 handwritingExport.ts 同源复制：那边刻意不导出内部 helper）：
//   .doc-title/.doc-subtitle/.doc-sep → 居中标题/灰色副标题/分隔线
//   h3.sec-title（左侧黑条）→ 黑体加粗 + 左边框粗线
//   table.hline（仅横线+表头灰底+隔行灰）→ 底边框表格 + 单元格底纹
//   td.err/td.corr → 红字 / 绿字加粗
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  BorderStyle, AlignmentType, WidthType, ShadingType, TableLayoutType, LineRuleType,
} from 'docx';
import { saveAs } from 'file-saver';
import type { ClassFeedbackReport, ClassStats, EssayType } from '../types';
import { getCohesionLabel } from '../types';

// ─── Page layout（同 handwritingExport.ts）───────────
const FONT_SONG = { ascii: 'Times New Roman', eastAsia: '宋体', hAnsi: 'Times New Roman', cs: 'Times New Roman' } as const;
const FONT_HEI = { ascii: 'SimHei', eastAsia: 'SimHei', hAnsi: 'SimHei', cs: 'SimHei' } as const;

// ─── Run / paragraph helpers（与 handwritingExport.ts 同名同参）───

function run(text: string, opts: { bold?: boolean; italics?: boolean; size?: number; color?: string; hei?: boolean } = {}): TextRun {
  return new TextRun({
    text: String(text ?? ''),
    font: opts.hei ? FONT_HEI : FONT_SONG,
    size: opts.size ?? 21,
    bold: opts.bold, italics: opts.italics, color: opts.color,
  });
}

function para(runs: TextRun[], opts: {
  align?: 'left' | 'right' | 'center';
  before?: number; after?: number; line?: number; lineRule?: 'auto' | 'atLeast' | 'exact';
  borderLeft?: { size: number; color: string };
  borderBottom?: { size: number; color: string };
} = {}): Paragraph {
  return new Paragraph({
    children: runs,
    alignment: opts.align === 'right' ? AlignmentType.RIGHT : opts.align === 'center' ? AlignmentType.CENTER : undefined,
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

function sep(): Paragraph {
  return para([], { borderBottom: { size: 4, color: '999999' }, before: 30, after: 50, line: 40, lineRule: LineRuleType.EXACT });
}

function secTitle(text: string): Paragraph {
  return para([run(text, { hei: true, bold: true, size: 24 })], { borderLeft: { size: 40, color: '333333' }, before: 100, after: 40 });
}

function subTitle(text: string): Paragraph {
  return para([run(`▸ ${text}`, { hei: true, bold: true, size: 21 })], { before: 40, after: 20 });
}

function small(text: string, opts: { gray?: boolean } = {}): Paragraph {
  return para([run(text, { size: 20, color: opts.gray ? '666666' : '555555' })]);
}

function spacer(after = 20): Paragraph {
  return para([], { after, line: 40, lineRule: LineRuleType.EXACT });
}

// ─── Table helpers（table.hline 同款）────────────────

const NO_B = { style: BorderStyle.NONE, size: 0, color: 'auto' } as const;
const NO_BORDERS = { top: NO_B, bottom: NO_B, left: NO_B, right: NO_B } as const;

interface CellSpec { text: string; cls?: 'err' | 'corr'; align?: 'center'; hei?: boolean }

function hlineTable(headers: string[], rows: CellSpec[][], widths: number[], zebra = true): Table {
  const cellMargins = { top: 30, bottom: 30, left: 60, right: 60 };
  const styled = (spec: CellSpec, w: number, shade?: string): TableCell => new TableCell({
    children: [para([run(spec.text, {
      size: 20,
      color: spec.cls === 'err' ? '8B1A1A' : spec.cls === 'corr' ? '1A5C1A' : undefined,
      bold: spec.cls === 'corr',
      hei: spec.hei,
    })], { after: 0, align: spec.align })],
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
    // 斑马纹相位对齐打印 PDF 的 tr:nth-child(even)（表头为第 1 行）→ 数据第 0、2…行着灰
    children: cells.map((c, ci) => styled(c, widths[ci], zebra && ri % 2 === 0 ? 'F5F5F5' : undefined)),
  }));

  return new Table({
    rows: [headerRow, ...dataRows],
    columnWidths: widths,
    width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    borders: { ...NO_BORDERS, insideHorizontal: NO_B, insideVertical: NO_B },
  });
}

// ─── 文档构建（与 printClassReportPdf 逐节对应）──────

export interface ClassReportDocxParams {
  stats: ClassStats;
  report: ClassFeedbackReport;
  /** 成绩名册（录入顺序，无名次列；老师私有材料） */
  roster: { name: string; score: number | null; band: string | null }[];
  essayType: EssayType;
  essayTypeLabel: string;
  gradeLevel: string;
  essayPromptDigest: string;
}

const SEV_COLOR = { high: '8B1A1A', medium: '9A6B00', low: '1A5C1A' } as const;
const SEV_LABEL = { high: '高', medium: '中', low: '低' } as const;

function buildClassReportChildren(p: ClassReportDocxParams): (Paragraph | Table)[] {
  const { stats, report, roster, essayType, essayTypeLabel, gradeLevel, essayPromptDigest } = p;
  const children: (Paragraph | Table)[] = [];

  // 页头
  children.push(
    para([run(`${essayTypeLabel}  |  ${gradeLevel}`, { size: 20 })], { align: 'right', after: 120 }),
    para([run('班级讲评报告', { hei: true, bold: true, size: 28 })], { align: 'center', after: 20 }),
    para([run(`———  ${essayPromptDigest}  ———`, { size: 21, color: '666666' })], { align: 'center', after: 60 }),
    sep(),
  );

  // 一、客观统计
  children.push(secTitle('一、客观统计'));
  const excludedNote = stats.excludedCount > 0 ? `（另有 ${stats.excludedCount} 份生成失败，未计入）` : '';
  const pendingNote = stats.pendingCount > 0 ? `（另有 ${stats.pendingCount} 份尚未生成，未计入）` : '';
  children.push(para([
    run('整体：', { hei: true, bold: true }),
    run(`参与统计 ${stats.studentCount} 人${excludedNote}${pendingNote}${stats.avgScore != null ? ` · 平均分 ${stats.avgScore}（最高 ${stats.maxScore} / 最低 ${stats.minScore}${stats.scoreScale ? `，满分 ${stats.scoreScale}` : ''}）` : ''}`),
  ]));
  if (stats.bandDistribution) {
    const names = ['一档', '二档', '三档', '四档', '五档'];
    const total = stats.scoredCount || 1;
    children.push(hlineTable(
      ['档位（一档最低）', ...names],
      [
        [{ text: '人数', hei: true }, ...stats.bandDistribution.map(n => ({ text: String(n), align: 'center' as const }))],
        [{ text: '占比', hei: true }, ...stats.bandDistribution.map(n => ({ text: `${Math.round((n / total) * 100)}%`, align: 'center' as const }))],
      ],
      [2700, 1560, 1560, 1560, 1560, 1560],
    ));
    children.push(spacer());
  }
  const bd = stats.avgBreakdown;
  if (bd.content != null || bd.language != null || bd.cohesion != null) {
    children.push(small(`分项均分：内容 ${bd.content ?? '—'} · 语言 ${bd.language ?? '—'} · ${getCohesionLabel(essayType)} ${bd.cohesion ?? '—'}`));
  }
  children.push(small(`错误频次：语法 ${stats.errorCounts.grammar} · 词汇 ${stats.errorCounts.vocabulary} · 句式 ${stats.errorCounts.sentence} · 逻辑 ${stats.errorCounts.logic}  |  偏题 ${stats.offTopicCount} 人 · 遗漏要点共 ${stats.missedPointCount} 处`));
  if (roster.length > 0) {
    children.push(subTitle('成绩名册（录入顺序）'));
    children.push(hlineTable(
      ['序号', '姓名', '分数', '档位'],
      roster.map((r, i) => [
        { text: String(i + 1), align: 'center' as const },
        { text: r.name },
        { text: r.score != null ? String(r.score) : '—' },
        { text: r.band ?? '—' },
      ]),
      [1200, 4200, 2550, 2550],
    ));
    children.push(spacer());
  }
  children.push(sep());

  // 二、共性问题
  children.push(secTitle('二、共性问题'));
  if (report.commonProblems.length === 0) {
    children.push(small('（本次未提炼出共性问题）', { gray: true }));
  }
  for (const prob of report.commonProblems) {
    children.push(para([
      run(`[${SEV_LABEL[prob.severity]}] `, { bold: true, color: SEV_COLOR[prob.severity] }),
      run(prob.title, { hei: true, bold: true }),
    ], { before: 40, after: 20 }));
    children.push(para([run(prob.description)]));
    if (prob.examples.length > 0) {
      children.push(hlineTable(
        ['有同学写道（原文）', '改正', '点评'],
        prob.examples.map(e => [{ text: e.quote, cls: 'err' as const }, { text: e.corrected, cls: 'corr' as const }, { text: e.note }]),
        [3900, 3600, 3000],
      ));
      children.push(spacer());
    }
  }
  children.push(sep());

  // 三、建设性意见
  children.push(secTitle('三、建设性意见'));
  if (report.suggestions.length === 0) children.push(small('（无）', { gray: true }));
  report.suggestions.forEach((s, i) => children.push(para([run(`${i + 1}. ${s}`)])));
  children.push(sep());

  // 四、亮点展示
  children.push(secTitle('四、亮点展示（具名表扬）'));
  if (report.highlights.length === 0) children.push(small('（无）', { gray: true }));
  for (const h of report.highlights) {
    children.push(para([
      run(`“${h.sentence}”`, { italics: true }),
      run(`  —— ${h.studentName}：`, { bold: true }),
      run(h.comment),
    ]));
  }
  children.push(sep());

  // 五、评讲课建议
  children.push(secTitle('五、评讲课建议'));
  if (report.lessonPlan.length === 0) children.push(small('（无）', { gray: true }));
  report.lessonPlan.forEach((s, i) => children.push(para([run(`${i + 1}. ${s}`)])));

  return children;
}

/** 导出班级讲评报告 Word 文档（版式与打印 PDF 一致） */
export async function exportClassReportDocx(p: ClassReportDocxParams): Promise<void> {
  const doc = new Document({
    styles: { default: { document: { run: { font: FONT_SONG, size: 21 } } } },
    sections: [{
      properties: { page: { margin: { top: 700, bottom: 700, left: 700, right: 700 } } },
      children: buildClassReportChildren(p),
    }],
  });
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  saveAs(await Packer.toBlob(doc), `班级讲评报告-${p.essayTypeLabel}-${date}.docx`);
}
