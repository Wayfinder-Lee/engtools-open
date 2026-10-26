// 班级讲评课件（PPTX）导出 —— 评讲课投影用：
//   - pptxgenjs 动态 import（qrcode/jszip 先例）：主包零增重，产物为独立 chunk
//   - 字号 ≥24pt（含图表轴/数据标签与错例点评；William 约定「新页面字体 ≥24」无例外）
//   - 内容流式排版：按中英文混排估行数堆叠，放不下自动分「（续）」页——
//     normalize 允许的极限长度（描述 400 字/建议 300 字/亮点 400 字符）都不会溢出 5.625in 页高
//   - 图表竖向柱状（barDir 'col'）
//   - PPT 是投影物：不带成绩名册（name+score 只进老师私有的 PDF/Word/屏显）；
//     定色不套主题（同 docx/打印的 print red lines 精神）
import type { ClassFeedbackReport, ClassStats, EssayType } from '../types';
import { getCohesionLabel } from '../types';

export interface ClassReportPptxParams {
  stats: ClassStats;
  report: ClassFeedbackReport;
  essayType: EssayType;
  essayTypeLabel: string;
  gradeLevel: string;
  dateLabel: string;
}

const FONT = 'Microsoft YaHei';
// PPT 定色（不随主题）：accent 赤陶橙 / 错例暗红 / 改正深绿 / 点评灰
const ACCENT = 'D97757';
const ERR_RED = 'C00000';
const CORR_GREEN = '2E7D32';
const NOTE_GRAY = '595959';
const TITLE_DARK = '262626';
const BODY_DARK = '404040';

const SLIDE_H = 5.625;
const TEXT_X = 0.5;
const TEXT_W = 9.0;
const BODY = 24;
const TOP = 1.2;          // 有标题条的页，内容起始 y
const BOTTOM_PAD = 0.22;  // 页底安全边距

const bandNames = ['一档', '二档', '三档', '四档', '五档'];

/** 中英文混排估行数：CJK 全宽 ≈ fontSize pt，ASCII ≈ 0.55 倍；可用宽 widthIn 英寸 */
function estLines(text: string, fontSize: number, widthIn = TEXT_W): number {
  let units = 0;
  for (const ch of text) units += ch.charCodeAt(0) > 0x2e80 ? 1 : 0.55;
  return Math.max(1, Math.ceil((units * fontSize) / (widthIn * 72)));
}
const lineH = (fontSize: number) => (fontSize / 72) * 1.32;
/** 投影页专用截断（normalize 钳制之外的二次保险，保证单页放得下） */
const clipText = (s: string, n: number) => {
  if (s.length <= n) return s;
  let cut = s.slice(0, n);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut + '…';
};

export async function exportClassReportPptx(p: ClassReportPptxParams): Promise<void> {
  let PptxGenJS: typeof import('pptxgenjs').default;
  try {
    PptxGenJS = (await import('pptxgenjs')).default;
  } catch {
    throw new Error('课件组件加载失败，请检查网络后重试');
  }

  const { stats, report, essayType, essayTypeLabel, gradeLevel, dateLabel } = p;
  const cohesionLabel = getCohesionLabel(essayType);
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.author = 'engtools';

  // ── 第 1 页：封面 + 概览 ──
  {
    const slide = pptx.addSlide();
    slide.addText('班级讲评报告', { x: 0.6, y: 0.8, w: 8.8, h: 0.9, fontSize: 40, bold: true, fontFace: FONT, color: TITLE_DARK });
    slide.addText(`${essayTypeLabel} · ${gradeLevel} · ${dateLabel}`, { x: 0.6, y: 1.75, w: 8.8, h: 0.5, fontSize: 24, fontFace: FONT, color: NOTE_GRAY });
    const tiles: [string, string][] = [
      [String(stats.studentCount), '参与统计'],
      [stats.avgScore != null ? String(stats.avgScore) : '—', `平均分${stats.scoreScale ? `（满分 ${stats.scoreScale}）` : ''}`],
      [stats.maxScore != null ? String(stats.maxScore) : '—', '最高分'],
      [stats.minScore != null ? String(stats.minScore) : '—', '最低分'],
    ];
    tiles.forEach(([num, label], i) => {
      const x = 0.6 + i * 2.3;
      slide.addText(num, { x, y: 3.0, w: 2.1, h: 0.8, fontSize: 32, bold: true, fontFace: FONT, color: ACCENT, align: 'center' });
      slide.addText(label, { x, y: 3.8, w: 2.1, h: 0.8, fontSize: 24, fontFace: FONT, color: NOTE_GRAY, align: 'center' });
    });
  }

  // ── 第 2 页：成绩分布（竖向柱状图）+ 分项/错误频次 ──
  {
    const slide = pptx.addSlide();
    slide.addText('成绩分布', { x: TEXT_X, y: 0.3, w: 9.0, h: 0.7, fontSize: 28, bold: true, fontFace: FONT, color: TITLE_DARK });
    if (stats.bandDistribution) {
      slide.addChart(pptx.ChartType.bar, [
        { name: '人数', labels: bandNames, values: stats.bandDistribution },
      ], {
        x: 0.5, y: 1.2, w: 5.6, h: 3.9,
        barDir: 'col',            // 竖向柱状图
        chartColors: [ACCENT],
        showValue: true,
        dataLabelFontSize: 24, dataLabelFontFace: FONT,
        catAxisLabelFontSize: 24, catAxisLabelFontFace: FONT,
        valAxisLabelFontSize: 24, valAxisLabelFontFace: FONT,
        showLegend: false,
      });
    } else {
      slide.addText('分制非 15/25，未统计档位分布', { x: 0.5, y: 1.2, w: 5.6, h: 1.0, fontSize: 24, fontFace: FONT, color: NOTE_GRAY });
    }
    const bd = stats.avgBreakdown;
    const rightLines: string[] = [];
    if (bd.content != null || bd.language != null || bd.cohesion != null) {
      rightLines.push('分项均分', `内容 ${bd.content ?? '—'} · 语言 ${bd.language ?? '—'} · ${cohesionLabel} ${bd.cohesion ?? '—'}`, '');
    }
    rightLines.push('错误频次', `语法 ${stats.errorCounts.grammar} · 词汇 ${stats.errorCounts.vocabulary}`, `句式 ${stats.errorCounts.sentence} · 逻辑 ${stats.errorCounts.logic}`, `偏题 ${stats.offTopicCount} 人 · 遗漏要点 ${stats.missedPointCount} 处`);
    slide.addText(rightLines.map(t => ({ text: t, options: { breakLine: true, fontSize: 24, fontFace: FONT, color: BODY_DARK } })),
      { x: 6.4, y: 1.2, w: 3.1, h: 3.9, valign: 'top' });
  }

  // ── 流式排版器：内容堆叠放不下 → 自动新开「（续）」页 ──
  let cur = pptx.addSlide();
  let y = TOP;
  let contTitle = '';
  const pageTitle = (text: string) => {
    cur.addText(text, { x: TEXT_X, y: 0.3, w: 9.0, h: estLines(text, 28) * lineH(28) + 0.12, fontSize: 28, bold: true, fontFace: FONT, color: TITLE_DARK });
    y = Math.max(TOP, 0.3 + estLines(text, 28) * lineH(28) + 0.2);
  };
  const newSlide = (keepTitle: string) => {
    cur = pptx.addSlide();
    contTitle = keepTitle;
    pageTitle(keepTitle ? `${keepTitle}（续）` : '');
  };
  /** 放一段文字；放不下先翻页。返回实际占高（英寸） */
  const put = (text: string, opts: { fontSize?: number; color?: string; bold?: boolean; italic?: boolean } = {}): number => {
    const fs = opts.fontSize ?? BODY;
    const h = estLines(text, fs) * lineH(fs) + 0.06;
    if (y + h > SLIDE_H - BOTTOM_PAD) newSlide(contTitle);
    cur.addText(text, { x: TEXT_X, y, w: TEXT_W, h, fontSize: fs, bold: opts.bold, italic: opts.italic, fontFace: FONT, color: opts.color ?? BODY_DARK, valign: 'top' });
    y += h + 0.05;
    return h;
  };

  // ── 共性问题：一题从新页起，例句放不下进（续）页 ──
  for (const prob of report.commonProblems) {
    const t = clipText(prob.title, 42);
    cur = pptx.addSlide();
    contTitle = t;
    const sevLabel = prob.severity === 'high' ? '高' : prob.severity === 'low' ? '低' : '中';
    const sevColor = prob.severity === 'high' ? ERR_RED : prob.severity === 'low' ? CORR_GREEN : '9A6B00';
    const titleLines = estLines(t, 28);
    const titleH = titleLines * lineH(28) + 0.12;
    cur.addText([
      { text: `[${sevLabel}] `, options: { fontSize: 28, bold: true, fontFace: FONT, color: sevColor } },
      { text: t, options: { fontSize: 28, bold: true, fontFace: FONT, color: TITLE_DARK } },
    ], { x: TEXT_X, y: 0.3, w: 9.0, h: titleH, valign: 'top' });
    y = 0.3 + titleH + 0.18;

    put(clipText(prob.description, 110));
    for (const e of prob.examples) {
      put(`有同学写道：“${clipText(e.quote, 90)}”`, { color: ERR_RED });
      if (e.corrected) put(`改正：“${clipText(e.corrected, 90)}”`, { color: CORR_GREEN });
      if (e.note) put(`点评：${clipText(e.note, 40)}`, { color: NOTE_GRAY });
    }
  }

  // ── 建设性意见 ──
  if (report.suggestions.length > 0) {
    cur = pptx.addSlide();
    contTitle = '建设性意见';
    pageTitle('建设性意见');
    report.suggestions.forEach((s, i) => put(`${i + 1}. ${s}`));
  }

  // ── 亮点展示 ──
  if (report.highlights.length > 0) {
    cur = pptx.addSlide();
    contTitle = '亮点展示';
    pageTitle('亮点展示');
    for (const h of report.highlights) {
      put(`“${clipText(h.sentence, 200)}”`, { fontSize: 26, italic: true, color: TITLE_DARK });
      put(`—— ${h.studentName}：${clipText(h.comment, 90)}`, { color: CORR_GREEN });
    }
  }

  // ── 评讲课建议 ──
  if (report.lessonPlan.length > 0) {
    cur = pptx.addSlide();
    contTitle = '评讲课建议';
    pageTitle('评讲课建议');
    report.lessonPlan.forEach((s, i) => put(`${i + 1}. ${s}`));
  }

  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  await pptx.writeFile({ fileName: `班级讲评课件-${essayTypeLabel}-${date}.pptx` });
}
