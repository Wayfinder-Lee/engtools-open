import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType,
  BorderStyle, AlignmentType, HeadingLevel, SectionType, TableLayoutType,
} from 'docx';
import { saveAs } from 'file-saver';
import type { ContinuationWritingResult, DocxExportOptions, FieldSelection, PracticalWritingResult, Stage, VocabItem, ClozeItem } from '../types';
import { getSectionOrder } from '../types';

const FONT_SIZE = 21;
const NARROW_MARGIN = 567;
/**
 * M2 紧凑模式：统一字号缩放 + 收紧页边距。
 * 模块级开关（导出为一次性异步动作，串行使用），避免把 scale 穿透进全部 builder。
 */
let compactScale = 1;
function applyCompact(on: boolean) { compactScale = on ? 0.86 : 1; }
const sz = (base: number) => Math.round(base * compactScale);
const BULLET = '▪';
const FONT = { ascii: 'Times New Roman', eastAsia: '宋体', hAnsi: 'Times New Roman', cs: 'Times New Roman' } as const;
const FONT_HEI = { ascii: 'SimHei', eastAsia: '黑体', hAnsi: 'SimHei', cs: 'SimHei' } as const;

// ─── parse **bold** → TextRun[] ────────────────────
function parseBold(text: string, opts: { size?: number; underline?: boolean; color?: string } = {}): TextRun[] {
  const runs: TextRun[] = [];
  const size = sz(opts.size ?? FONT_SIZE);
  const regex = /\*\*(.+?)\*\*/g;
  let last = 0; let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) runs.push(new TextRun({ text: text.slice(last, m.index), font: FONT, size, color: opts.color }));
    runs.push(new TextRun({ text: m[1], font: FONT, size, bold: true, underline: opts.underline ? { type: 'single' } : undefined, color: opts.color }));
    last = regex.lastIndex;
  }
  if (last < text.length) runs.push(new TextRun({ text: text.slice(last), font: FONT, size, color: opts.color }));
  if (runs.length === 0) runs.push(new TextRun({ text, font: FONT, size, color: opts.color }));
  return runs;
}

function rn(text: string, opts: { bold?: boolean; italics?: boolean; size?: number; color?: string; underline?: boolean; hei?: boolean } = {}): TextRun {
  return new TextRun({ text, font: opts.hei ? FONT_HEI : FONT, size: sz(opts.size ?? FONT_SIZE), bold: opts.bold, italics: opts.italics, color: opts.color, underline: opts.underline ? { type: 'single' } : undefined });
}
function sg(text: string): TextRun { return rn(text, { size: 18, color: '999999', italics: true }); }
function sepp(): Paragraph {
  return new Paragraph({ children: [], border: { bottom: { style: BorderStyle.DOTTED, size: 1, color: 'bbbbbb', space: 1 } }, spacing: { before: 80, after: 80 } });
}
function tit(text: string, before = 120): Paragraph {
  return new Paragraph({ children: [rn(text, { bold: true, size: 26 })], heading: HeadingLevel.HEADING_2, alignment: AlignmentType.CENTER, spacing: { before, after: 100 } });
}
function sub(text: string): Paragraph {
  return new Paragraph({ children: [rn(text, { italics: true, size: 20, color: '666666' })], alignment: AlignmentType.CENTER, spacing: { after: 120 } });
}

// ─── 板块一：原句理解自测 ──────────────────────────
function buildSelfTest(list: VocabItem[], fields: FieldSelection): Paragraph[] {
  const paras: Paragraph[] = [tit('原句理解自测'), sub('自读句子，注意加粗下划线的重点词，标记不熟悉的词。')];
  if (!fields.originalSentence) {
    paras.push(new Paragraph({ children: [rn('（未选择"文中原句"字段，已跳过。）', { italics: true, color: '999999' })], alignment: AlignmentType.CENTER }));
    return paras;
  }
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const children: TextRun[] = [rn(`${i + 1}. `, { bold: true })];
    children.push(...parseBold(item.originalSentence, { underline: true }));
    // 来源在句末同行
    if (item.sourceLabel) children.push(sg(`  ➤ ${item.sourceLabel}`));
    paras.push(new Paragraph({ children, spacing: { before: 0, after: 60, line: 320 }, indent: { left: 120, hanging: 120 } }));
  }
  return paras;
}

// ─── 板块二：重点词汇表 ────────────────────────────
function lbl(label: string, content: string, indent = 240): Paragraph {
  return new Paragraph({ children: [rn(label, { bold: true }), ...parseBold(content)], spacing: { before: 0, after: 40, line: 276 }, indent: { left: indent, hanging: indent } });
}

function buildEntry(item: VocabItem, fields: FieldSelection, index: number): Paragraph[] {
  const paras: Paragraph[] = [];
  const line1: TextRun[] = [rn(`${index + 1}. `, { bold: true }), rn(item.word, { bold: true, size: 24 })];
  if (fields.phonetic && item.phonetic) line1.push(rn(`  ${item.phonetic}`, { size: 22 }));
  if (fields.examFrequency && item.examFrequency) line1.push(rn(`  ${item.examFrequency}`));
  if (item.sourceLabel) line1.push(sg(`  ➤ ${item.sourceLabel}`));
  paras.push(new Paragraph({ children: line1, spacing: { before: 0, after: 20 } }));

  if (fields.originalSentence && item.originalSentence) {
    paras.push(new Paragraph({ children: [rn(`${BULLET} 原句：`, { bold: true }), ...parseBold(item.originalSentence)], spacing: { before: 0, after: 40 }, indent: { left: 120 } }));
  }
  if (fields.definition && item.definition) paras.push(lbl(`${BULLET} 释义：`, item.definition));
  if (fields.collocations && item.collocations) paras.push(lbl(`${BULLET} 搭配：`, item.collocations));
  if (fields.memoryAid && item.memoryAid) paras.push(lbl(`${BULLET} 记忆：`, item.memoryAid));
  if (fields.extraExample && item.extraExample) {
    paras.push(new Paragraph({ children: [rn(`${BULLET} 例句：`, { bold: true }), ...parseBold(item.extraExample)], spacing: { before: 0, after: 20 }, indent: { left: 120 } }));
  }
  return paras;
}

function buildVocabTable(list: VocabItem[], fields: FieldSelection): Paragraph[] {
  const paras: Paragraph[] = [tit('重点词汇表')];
  const blocks = list.map((item, i) => buildEntry(item, fields, i));
  for (let i = 0; i < blocks.length; i++) { paras.push(...blocks[i]); if (i < blocks.length - 1) paras.push(sepp()); }
  return paras;
}

// ─── 板块三：语法填空 ──────────────────────────────
function buildCloze(items: ClozeItem[], includeAnswers = true): Paragraph[] {
  const paras: Paragraph[] = [tit('语法填空 · 词汇检测', 200), sub('用括号中所给词的正确形式填空。（提示词与答案词形不同，需分析句子结构）')];
  const answers: { num: number; answer: string }[] = [];
  for (let i = 0; i < items.length; i++) {
    // 将句末 "(hint)" 替换为横线后的 "(hint)" 格式：_____ (hint)
    let sentence = items[i].sentence;
    // 移除句末的 (hint)，改为在横线后直接跟 (hint)
    sentence = sentence.replace(/\s*\([^)]+\)\s*$/, '');
    const display = sentence.includes('__________') ? sentence : `${sentence} __________`;
    paras.push(new Paragraph({
      children: [rn(`${i + 1}. `, { bold: true }), rn(display), rn(` (${items[i].hint})`)],
      spacing: { before: 0, after: 16, line: 320 },
      indent: { left: 120, hanging: 120 },
    }));
    answers.push({ num: i + 1, answer: items[i].answer });
  }
  if (includeAnswers) {
    paras.push(new Paragraph({ children: [], spacing: { before: 200 } }));
    paras.push(tit('参考答案', 200));
    paras.push(new Paragraph({
      children: [rn(answers.map((a) => `${a.num}. ${a.answer}`).join('    '), { size: 18, color: '666666' })],
      spacing: { before: 0, after: 60 }, indent: { left: 120 },
    }));
  }
  return paras;
}

// ─── 板块四：词汇清单（精简一行版，按来源段落分组）───

/** 段落显示顺序（按学段取用，与 VocabTable 共用 getSectionOrder） */
function sectionOrder(name: string, order: string[]): number {
  const idx = order.indexOf(name);
  return idx >= 0 ? idx : order.length;
}

/** 按 sectionName 分组，每组内保持原顺序，组间按学段题型顺序排序 */
function groupBySection(list: VocabItem[], stage: Stage): { name: string; items: VocabItem[] }[] {
  const order = getSectionOrder(stage);
  const groups = new Map<string, VocabItem[]>();
  for (const item of list) {
    const name = item.sectionName || '其他';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name)!.push(item);
  }
  return Array.from(groups.entries())
    .sort((a, b) => sectionOrder(a[0], order) - sectionOrder(b[0], order))
    .map(([name, items]) => ({ name, items }));
}

function sectionHeader(text: string, before = 120): Paragraph {
  return new Paragraph({
    children: [rn(text, { bold: true, size: 24 })],
    spacing: { before, after: 60 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'cccccc', space: 1 } },
  });
}

function buildWordList(list: VocabItem[], stage: Stage): Paragraph[] {
  const paras: Paragraph[] = [tit('词汇清单', 200)];
  const groups = groupBySection(list, stage);

  let globalIndex = 0;
  for (const group of groups) {
    paras.push(sectionHeader(group.name));
    for (const item of group.items) {
      globalIndex++;
      const pos = item.definition?.match(/^([a-z]+\.(?:\s*\/\s*[a-z]+\.)*)/i)?.[0] || '';
      const cn = item.definition?.split('｜')[0]?.replace(/^[a-z]+\.(?:\s*\/\s*[a-z]+\.)*/i, '').replace(/[①②③]/g, '').trim() || '';
      const spellMark = item.spellingRequired ? '*' : '';
      paras.push(new Paragraph({
        children: [
          rn(`${globalIndex}.${spellMark}`, { bold: true }),
          rn(item.word, { bold: true }),
          rn(`  \t${pos ? pos + '  ' : ''}${cn}`, { color: '555555' }),
        ],
        spacing: { before: 0, after: 16 },
        indent: { left: 120 },
      }));
    }
  }
  return paras;
}

// ─── 板块五：默写清单（按来源段落分组）──────────────

function buildDictation(list: VocabItem[], stage: Stage): Paragraph[] {
  const paras: Paragraph[] = [tit('默写清单', 200)];
  const groups = groupBySection(list, stage);

  let globalIndex = 0;
  for (const group of groups) {
    paras.push(sectionHeader(group.name));
    for (const item of group.items) {
      globalIndex++;
      const pos = item.definition?.match(/^([a-z]+\.(?:\s*\/\s*[a-z]+\.)*)/i)?.[0] || '';
      const cn = item.definition?.split('｜')[0]?.replace(/^[a-z]+\.(?:\s*\/\s*[a-z]+\.)*/i, '').replace(/[①②③]/g, '').trim() || '';

      if (item.spellingRequired === false) {
        // 仅需认读：给出英文，空白填中文
        paras.push(new Paragraph({
          children: [rn(`${globalIndex}. `, { bold: true }), rn(item.word, { bold: true }), rn(`  ${pos}`, { color: '888888' }), rn(`  __________`, { color: 'cccccc' })],
          spacing: { before: 0, after: 16 },
          indent: { left: 120 },
        }));
      } else {
        // 需拼写：空白填英文
        paras.push(new Paragraph({
          children: [rn(`${globalIndex}. `, { bold: true }), rn(`__________`, { color: 'cccccc' }), rn(`  ${pos}  ${cn}`)],
          spacing: { before: 0, after: 16 },
          indent: { left: 120 },
        }));
      }
    }
  }
  return paras;
}

// ─── 主导出 ────────────────────────────────────────

export async function exportToDocx(
  vocabList: VocabItem[], clozeItems: ClozeItem[] | null | undefined,
  fields: FieldSelection | undefined, options: DocxExportOptions, stage: Stage = 'senior',
): Promise<void> {
  const f = fields ?? { phonetic: true, definition: true, collocations: true, memoryAid: true, examFrequency: true, originalSentence: true, extraExample: true };
  const compact = !!options.compact;
  applyCompact(compact);
  const margin = compact ? 454 : NARROW_MARGIN; // 紧凑：1.5cm→0.8cm 边距
  const student = options.variant === 'student';
  const allParas: Paragraph[] = [];

  // 版本标注（学生卷不含语法填空参考答案）
  allParas.push(new Paragraph({
    children: [rn(student ? '学生卷（不含答案）' : '教师卷（含答案）', { size: 18, color: '999999', italics: true })],
    alignment: AlignmentType.RIGHT, spacing: { after: 40 },
  }));

  if (options.selfTest) allParas.push(...buildSelfTest(vocabList, f));
  if (options.vocabTable) allParas.push(...buildVocabTable(vocabList, f));
  if (options.cloze && clozeItems?.length) allParas.push(...buildCloze(clozeItems, !student));
  if (options.wordList) allParas.push(...buildWordList(vocabList, stage));
  if (options.dictation) allParas.push(...buildDictation(vocabList, stage));

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: sz(FONT_SIZE) } } } },
    sections: [{
      properties: { page: { margin: { top: margin, bottom: margin, left: margin, right: margin } }, column: { count: 2, space: 400, equalWidth: true } },
      children: allParas,
    }],
  });

  applyCompact(false);
  saveAs(await Packer.toBlob(doc), student ? 'vocabulary-student.docx' : 'vocabulary.docx');
}

// ─── 应用文学案导出 ────────────────────────────────

function sectionTit(text: string): Paragraph {
  return new Paragraph({
    children: [rn(text, { bold: true, size: 24, hei: true })],
    border: { left: { style: BorderStyle.SINGLE, size: 10, color: '333333', space: 5 } },
    spacing: { before: 160, after: 60 },
    indent: { left: 120 },
  });
}
/** Build a horizontal-line-only table (SimHei header, zebra rows). */
function hlineTable(headers: string[], rows: string[][], colWidths?: number[], widthType: 'auto' | 'dxa' | 'pct' = 'pct'): Table {
  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map((h, i) => new TableCell({
      children: [new Paragraph({ children: [rn(h, { bold: true, size: 20, hei: true })] })],
      width: colWidths ? { size: colWidths[i], type: widthType } : undefined,
      shading: { fill: 'e0e0e0' },
    })),
  });
  const dataRows = rows.map((row, ri) => new TableRow({
    children: row.map((cell, ci) => new TableCell({
      children: [new Paragraph({ children: [rn(cell, { size: 20 })] })],
      width: colWidths ? { size: colWidths[ci], type: widthType } : undefined,
      shading: ri % 2 === 1 ? { fill: 'f5f5f5' } : undefined,
    })),
  }));
  return new Table({
    rows: [headerRow, ...dataRows],
    width: { size: 100, type: WidthType.PERCENTAGE },
  });
}

/** Clean given text for 前文回顾: split paragraphs, remove 注意事项, simplify continuation openings. */
function cleanGivenText(text: string): string[] {
  // Split into paragraphs by blank lines or single newlines
  const raw = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // First try splitting by double newlines
  let paragraphs = raw.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  // If only one paragraph, try splitting by single newlines
  if (paragraphs.length <= 1) {
    paragraphs = raw.split(/\n/).map(p => p.trim()).filter(Boolean);
  }

  return paragraphs
    // Remove 注意事项 paragraphs
    .filter(p => !/^注意[：:]\s*\d/.test(p) && !/^[注意]{2}/.test(p) && !/续写词数|答题卡|相应位置/.test(p))
    // Simplify long underlines → short marker
    .map(p => p.replace(/_+/g, '_____'));
}

/** Page-content-aware underline line for dictation blanks. */
const DICT_LINE = '_____________________________________________________________________________________________';

// ─── 应用文学案导出（参考版式：A4 双页、黑白打印友好）──────

const PW_MARGIN = { top: 780, bottom: 700, left: 950, right: 950 };
const PW_CONTENT_W = 10006; // A4 11906 − 2×950

/** 主标题：应用文写作学案 · 体裁（初中为「书面表达学案」） */
function pwTitle(genre: string, stage: Stage = 'senior'): Paragraph {
  const title = stage === 'junior' ? `书面表达学案 · ${genre}` : `应用文写作学案 · ${genre}`;
  return new Paragraph({
    children: [rn(title, { bold: true, size: 32, hei: true })],
    heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, spacing: { after: 40 },
  });
}

/** 英文体裁副标题 */
function pwSubtitle(genreEn: string): Paragraph {
  return new Paragraph({
    children: [rn(genreEn, { size: 20, color: '555555' })],
    alignment: AlignmentType.CENTER, spacing: { after: 40 },
  });
}

/** 节标题（一、~六、）：黑体加粗 + 下边框线 */
function pwHeading(text: string): Paragraph {
  return new Paragraph({
    children: [rn(text, { bold: true, size: 24, hei: true })],
    border: { bottom: { style: BorderStyle.SINGLE, size: 10, color: '404040', space: 3 } },
    keepNext: true, spacing: { before: 60, after: 25, line: 250 },
  });
}

/** 分区小节标题：加粗 + 左侧竖条（引用块样式） */
function pwGroupHeading(n: number, title: string, desc: string): Paragraph {
  return new Paragraph({
    children: [rn(`${n}. ${title}　——　${desc}`, { bold: true, size: 20 })],
    border: { left: { style: BorderStyle.SINGLE, size: 18, color: '404040', space: 6 } },
    keepNext: true, spacing: { before: 70, after: 20, line: 250 },
  });
}

/** 【单词】/【短语】/【句式】标签 */
function pwLabel(text: string): Paragraph {
  return new Paragraph({
    children: [rn(text, { bold: true, size: 21 })],
    keepNext: true, spacing: { before: 25, after: 8 }, indent: { left: 60 },
  });
}

/** 浅灰网格线（分析表 + 四列词表共用） */
function pwGridBorders() {
  const e = { style: BorderStyle.SINGLE, size: 4, color: 'C0C0C0' };
  return { top: e, bottom: { ...e }, left: { ...e }, right: { ...e }, insideHorizontal: { ...e }, insideVertical: { ...e } };
}

/** 1×1 全宽边框盒（题干回顾/参考范文） */
function pwBoxed(paras: Paragraph[], fill?: string): Table {
  const e = { style: BorderStyle.SINGLE, size: 6, color: 'A6A6A6' };
  return new Table({
    width: { size: PW_CONTENT_W, type: WidthType.DXA }, columnWidths: [PW_CONTENT_W], layout: TableLayoutType.FIXED,
    indent: { size: 0, type: WidthType.DXA },
    borders: { top: e, bottom: { ...e }, left: { ...e }, right: { ...e } },
    rows: [new TableRow({
      children: [new TableCell({
        children: paras,
        width: { size: PW_CONTENT_W, type: WidthType.DXA },
        shading: fill ? { fill } : undefined,
        margins: { top: 32, bottom: 32, left: 120, right: 120 },
      })],
    })],
  });
}

/** 三、文章分析表：标签列灰底 + 信息点覆盖逐行 ①②③ */
function pwAnalysisTable(a: PracticalWritingResult['analysis']): Table {
  const circled = '①②③④⑤⑥⑦⑧⑨⑩';
  const mk = (label: string, content: Paragraph[]): TableRow => new TableRow({
    children: [
      new TableCell({ children: [new Paragraph({ children: [rn(label, { bold: true, size: 20 })], spacing: { line: 240 } })], width: { size: 1500, type: WidthType.DXA }, shading: { fill: 'F0F0F0' }, margins: { top: 18, bottom: 18, left: 100, right: 100 } }),
      new TableCell({ children: content, width: { size: PW_CONTENT_W - 1500, type: WidthType.DXA }, margins: { top: 18, bottom: 18, left: 100, right: 100 } }),
    ],
  });
  const txt = (t: string): Paragraph[] => [new Paragraph({ children: [rn(t, { size: 20 })], spacing: { line: 240 } })];
  const kpParas = a.keyPoints.map((kp, i) => new Paragraph({
    children: [rn(`${circled[i] ?? `${i + 1}.`} ${kp}`, { size: 20 })],
    spacing: { after: i === a.keyPoints.length - 1 ? 0 : 10, line: 240 },
  }));
  return new Table({
    width: { size: PW_CONTENT_W, type: WidthType.DXA }, columnWidths: [1500, PW_CONTENT_W - 1500], layout: TableLayoutType.FIXED,
    indent: { size: 0, type: WidthType.DXA },
    borders: pwGridBorders(),
    rows: [
      mk('体裁', txt(a.genre)),
      mk('语气', txt(a.tone)),
      mk('结构', txt(a.structure)),
      mk('信息点覆盖', kpParas.length ? kpParas : txt('')),
    ],
  });
}

/** 四列词表 en|cn|en|cn，条目两两一行（列宽 3000+2000+3000+2006 = 10006 恰满版心） */
function pwPairTable(items: { en: string; cn: string }[]): Table {
  const widths = [3000, 2000, 3000, PW_CONTENT_W - 8000];
  const cell = (text: string, w: number): TableCell => new TableCell({
    children: [new Paragraph({ children: [rn(text, { size: 20 })], spacing: { line: 240 } })],
    width: { size: w, type: WidthType.DXA },
    margins: { top: 6, bottom: 6, left: 80, right: 80 },
  });
  const rows: TableRow[] = [];
  for (let i = 0; i < items.length; i += 2) {
    const a = items[i], b = items[i + 1];
    rows.push(new TableRow({ children: [cell(a.en, widths[0]), cell(a.cn, widths[1]), cell(b?.en ?? '', widths[2]), cell(b?.cn ?? '', widths[3])] }));
  }
  return new Table({
    width: { size: PW_CONTENT_W, type: WidthType.DXA }, columnWidths: widths, layout: TableLayoutType.FIXED,
    indent: { size: 0, type: WidthType.DXA },
    borders: pwGridBorders(),
    rows,
  });
}

/** 句式条目：◆ 英句加粗 + 中文 + （语法标注）同一行内联 */
function pwSentence(s: { en: string; cn: string; note?: string }): Paragraph {
  return new Paragraph({
    children: [
      rn('◆ ', { bold: true, size: 20 }),
      rn(s.en, { bold: true, size: 20 }),
      rn(`　${s.cn}`, { size: 20 }),
      ...(s.note ? [rn(`（${s.note}）`, { size: 18, color: '555555', italics: true })] : []),
    ],
    spacing: { before: 0, after: 16, line: 250 }, indent: { left: 60 },
  });
}

/**
 * 从范文中提取信件格式：称呼 Dear xxx,（第一段开头）与落款（最后一段结尾），
 * 供导出时各自提行。非信件体裁（无称呼/落款）原样返回。
 * 称呼前可能带 ①②③ 序号——拆分后序号归还给剩余正文，保持句序号连续。
 */
function pwSplitEssay(essay: string[]): { salutation?: string; paras: string[]; closing: string[] } {
  const paras = essay.map((p) => p.trim()).filter(Boolean);
  let salutation: string | undefined;
  if (paras.length > 0) {
    const m = paras[0].match(/^([①-⑳])?\s*(Dear\s+[^,;:，；：]{1,50},)[\s]*/);
    if (m) {
      salutation = m[2];
      const rest = paras[0].slice(m[0].length).trim();
      if (rest) paras[0] = (m[1] ? `${m[1]} ` : '') + rest;
      else paras.shift();
    }
  }
  const closing: string[] = [];
  if (paras.length > 0) {
    const m = paras[paras.length - 1].match(
      /\s*(?:[①-⑳]\s*)?((?:Yours\s+(?:sincerely|truly|faithfully)|Best\s+regards|Warm\s+regards|Kind\s+regards|Regards|Yours)\s*,?)\s*(?:\r?\n\s*)?([A-Z][A-Za-z.'’]{0,24}(?:\s+[A-Z][A-Za-z.'’]{0,24})?)?\s*[.!]?\s*$/,
    );
    if (m) {
      const rest = paras[paras.length - 1].slice(0, m.index).trim();
      if (rest) paras[paras.length - 1] = rest;
      else paras.pop();
      if (m[1]) closing.push(m[1].trim());
      if (m[2]) closing.push(m[2].trim());
    }
  }
  return { salutation, paras, closing };
}

export async function exportPracticalWritingDocx(prompt: string, r: PracticalWritingResult, stage: Stage = 'senior'): Promise<void> {
  // 勾选筛选：undefined = 选中；selected === false 的条目不导出
  const keep = <T extends { selected?: boolean }>(list?: T[]): T[] => (list ?? []).filter((it) => it.selected !== false);
  // 分区过滤后为空则整分区跳过（保留原始分区编号）；全部分区为空则连节标题一起跳过
  const groups = r.vocabSections
    .map((sec, si) => ({ si, sec, words: keep(sec.words), phrases: keep(sec.phrases), sentences: keep(sec.sentences) }))
    .filter((g) => g.words.length + g.phrases.length + g.sentences.length > 0);

  const children: (Paragraph | Table)[] = [
    pwTitle(r.analysis.genre, stage),
    ...(r.analysis.genreEn ? [pwSubtitle(r.analysis.genreEn)] : []),

    pwHeading('一、题干回顾'),
    pwBoxed(
      prompt.split(/\n+/).filter(Boolean).map((line, i, arr) =>
        new Paragraph({ children: [rn(line, { bold: true, size: 20 })], spacing: { after: i === arr.length - 1 ? 0 : 20, line: 250 } })),
      'F7F7F7'),

    pwHeading('二、参考范文'),
    pwBoxed((() => {
      // 信件体裁：称呼 Dear xxx, 单独提行顶格；落款 Yours sincerely, / Li Hua 单独提行右对齐
      const { salutation, paras, closing } = pwSplitEssay(r.essay);
      const body: Paragraph[] = [];
      if (salutation) body.push(new Paragraph({ children: [rn(salutation, { size: 21 })], spacing: { after: 0, line: 250 } }));
      paras.forEach((p, i) => body.push(new Paragraph({
        children: [rn(p, { size: 21 })], alignment: AlignmentType.JUSTIFIED,
        spacing: { before: i > 0 || salutation ? 25 : 0, after: 0, line: 250 }, indent: { firstLine: 240 },
      })));
      closing.forEach((c, ci) => body.push(new Paragraph({
        children: [rn(c, { size: 21 })], alignment: AlignmentType.RIGHT,
        spacing: { before: ci === 0 ? 25 : 0, after: 0, line: 250 },
      })));
      return body;
    })()),

    pwHeading('三、文章分析'),
    pwAnalysisTable(r.analysis),

    ...(groups.length > 0 ? [pwHeading('四、话题词汇与句式')] : []),
    ...groups.flatMap((g) => [
      pwGroupHeading(g.si + 1, g.sec.title, g.sec.description),
      ...(g.words.length ? [pwLabel('【单词】'), pwPairTable(g.words)] : []),
      ...(g.phrases.length ? [pwLabel('【短语】'), pwPairTable(g.phrases)] : []),
      ...(g.sentences.length ? [pwLabel('【句式】')] : []),
      ...g.sentences.map(pwSentence),
    ]),

    pwHeading('五、写作模板'),
    ...r.template.flatMap((para) => para.split(/\n+/).map((l) => l.trim()).filter(Boolean).map((line, li) => {
      if (/^Dear\b/i.test(line)) {
        return new Paragraph({ children: [rn(line, { size: 20 })], spacing: { before: li > 0 ? 20 : 0, after: 20, line: 250 } });
      }
      if (/^(Yours|Sincerely|Li Hua|Regards|Best|Cheers|Love|Faithfully)/i.test(line)) {
        return new Paragraph({ children: [rn(line, { size: 20 })], alignment: AlignmentType.RIGHT, spacing: { before: 10, after: 20, line: 250 } });
      }
      return new Paragraph({ children: [rn(line, { size: 20 })], spacing: { before: li > 0 ? 8 : 0, after: 20, line: 250 }, indent: { left: 240, firstLine: 240 } });
    })),

    pwHeading('六、分句默写翻译'),
    ...r.dictationSentences.flatMap((ds, i) => {
      // 按英文句长动态给横线：长句（≈14 词以上）两行，短句一行
      const blanks = ds.en.trim().length >= 80 ? 2 : 1;
      return [
        new Paragraph({
          children: [rn(`${i + 1}. ${ds.cn}`, { size: 20 }), ...(ds.pattern ? [rn(` [${ds.pattern}]`, { size: 18, color: '555555' })] : [])],
          spacing: { after: 16, line: 240 }, indent: { left: 120 },
        }),
        ...Array.from({ length: blanks }, (_, k) => new Paragraph({
          children: [rn(DICT_LINE, { size: 20, color: 'CCCCCC' })],
          spacing: { before: 30, after: k === blanks - 1 ? 60 : 20 },
        })),
      ];
    }),

    new Paragraph({ children: [rn('')], spacing: { before: 160 }, pageBreakBefore: true }),
    pwHeading('默写答案'),
    ...r.dictationSentences.map((ds, i) =>
      new Paragraph({ children: [rn(`${i + 1}. ${ds.en}`)], spacing: { before: 0, after: 40, line: 320 }, indent: { left: 240 } })),
  ];

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: FONT_SIZE } } } },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: PW_MARGIN } },
      children,
    }],
  });
  const genreTag = r.analysis.genre.replace(/[\\/:*?"<>|\s]+/g, '');
  const fileBase = stage === 'junior' ? '书面表达学案' : '应用文学案';
  saveAs(await Packer.toBlob(doc), genreTag ? `${fileBase}-${genreTag}.docx` : `${fileBase}.docx`);
}

// ─── 读后续写学案导出 ──────────────────────────────

export async function exportContinuationWritingDocx(givenText: string, r: ContinuationWritingResult): Promise<void> {
  const bi = 240;
  const b = (text: string, indent = bi) => new Paragraph({ children: [rn(text)], spacing: { before: 0, after: 40, line: 320 }, indent: { left: indent } });
  const st = sectionTit;

  const givenParagraphs = cleanGivenText(givenText);
  const pageMargin = { top: NARROW_MARGIN, bottom: NARROW_MARGIN, left: NARROW_MARGIN + 400, right: NARROW_MARGIN + 400 };

  // ── Section 1: 标题 → 十句五定法 (单栏) ──
  const sec1: (Paragraph | Table)[] = [
    new Paragraph({ children: [rn('读后续写学案', { bold: true, size: 28 })], heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, spacing: { after: 60 } }),

    st('一、前文回顾'),
    ...givenParagraphs.map((p, i) =>
      new Paragraph({ children: [rn(p)], spacing: { before: i > 0 ? 20 : 0, after: i === givenParagraphs.length - 1 ? 60 : 20, line: 320 }, indent: { left: 120, firstLine: 240 } })),

    st('二、参考续写范文'),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({
          tableHeader: true,
          children: [
            new TableCell({
              children: [new Paragraph({ children: [rn('Paragraph 1', { bold: true, size: 22 })] })],
              width: { size: 50, type: WidthType.PERCENTAGE },
              shading: { fill: 'e0e0e0' },
              margins: { left: 113, right: 113 },
            }),
            new TableCell({
              children: [new Paragraph({ children: [rn('Paragraph 2', { bold: true, size: 22 })] })],
              width: { size: 50, type: WidthType.PERCENTAGE },
              shading: { fill: 'e0e0e0' },
              borders: { left: { style: BorderStyle.SINGLE, size: 2, color: '999999' } },
              margins: { left: 113, right: 113 },
            }),
          ],
        }),
        new TableRow({
          children: [
            new TableCell({
              children: [new Paragraph({ children: [rn(r.continuation.paragraph1)], spacing: { line: 360 }, indent: { firstLine: 240 } })],
              width: { size: 50, type: WidthType.PERCENTAGE },
              margins: { left: 113, right: 113 },
            }),
            new TableCell({
              children: [new Paragraph({ children: [rn(r.continuation.paragraph2)], spacing: { line: 360 }, indent: { firstLine: 240 } })],
              width: { size: 50, type: WidthType.PERCENTAGE },
              borders: { left: { style: BorderStyle.SINGLE, size: 2, color: '999999' } },
              margins: { left: 113, right: 113 },
            }),
          ],
        }),
      ],
    }),

    st('三、人物分析'),
    hlineTable(
      ['人物', '性格', '角色'],
      r.characterAnalysis.characters.map(c => [c.name, c.traits.join('、'), c.role]),
      [20, 50, 30],
    ),
    new Paragraph({ children: [rn('')], spacing: { before: 40 } }),
    b(`人物关系：${r.characterAnalysis.relationships}`),

    st('四、剧情矛盾分析'),
    new Paragraph({ children: [rn('主要矛盾：', { bold: true }), rn(r.conflictAnalysis.mainConflict)], spacing: { before: 0, after: 40, line: 320 }, indent: { left: bi } }),
    new Paragraph({ children: [rn('情感弧线：', { bold: true }), rn(r.conflictAnalysis.emotionalArc)], spacing: { before: 0, after: 40, line: 320 }, indent: { left: bi } }),
    new Paragraph({ children: [rn('转折点：', { bold: true }), rn(r.conflictAnalysis.turningPoint)], spacing: { before: 0, after: 40, line: 320 }, indent: { left: bi } }),

    st('五、十句五定法分析'),
    b(r.tenSentenceMethod.overview),
    new Paragraph({ children: [rn('第一段（句 1-5）', { bold: true, size: 22 })], spacing: { before: 40, after: 20 }, indent: { left: bi } }),
    hlineTable(
      ['句', '英文', '功能'],
      Object.entries(r.tenSentenceMethod.paragraph1).map(([k, v]) => [k.replace('sentence', ''), v.en, v.function]),
      [283, 7087, 2608], 'dxa',
    ),
    new Paragraph({ children: [rn('第二段（句 6-10）', { bold: true, size: 22 })], spacing: { before: 40, after: 20 }, indent: { left: bi } }),
    hlineTable(
      ['句', '英文', '功能'],
      Object.entries(r.tenSentenceMethod.paragraph2).map(([k, v]) => [k.replace('sentence', ''), v.en, v.function]),
      [283, 7087, 2608], 'dxa',
    ),
  ];

  // ── Section 2: 常用句式 (Word 原生双栏) ──
  const sec2: Paragraph[] = [
    st('六、读后续写常用句式'),
    ...r.commonPatterns.flatMap((cat) => [
      new Paragraph({ children: [rn(cat.category, { bold: true, size: 22, hei: true })], spacing: { before: 80, after: 20 }, indent: { left: 60 } }),
      ...cat.patterns.flatMap((p) => [
        new Paragraph({ children: [rn(`▸ ${p.formula}`, { bold: true, size: 20 })], spacing: { before: 30, after: 10 } }),
        new Paragraph({ children: [rn(p.cn, { size: 18, color: '555555' }), ...(p.note ? [rn(`（${p.note}）`, { size: 16, color: '999999', italics: true })] : [])], spacing: { after: 30 }, indent: { left: 120 } }),
      ]),
    ]),
  ];

  // ── Section 3: 默写 + 答案 (单栏) ──
  const sec3: (Paragraph | Table)[] = [
    st('七、句式默写翻译练习'),
    ...r.dictationSentences.map((ds, i) => [
      new Paragraph({ children: [rn(`${i + 1}. ${ds.cn}`)], spacing: { before: 0, after: 40 }, indent: { left: bi } }),
      new Paragraph({ children: [rn(DICT_LINE, { color: 'cccccc' })], spacing: { before: 224, after: 20 } }),
      new Paragraph({ children: [rn(DICT_LINE, { color: 'cccccc' })], spacing: { before: 224, after: 120 } }),
    ]).flat(),

    new Paragraph({ children: [rn('')], spacing: { before: 160 }, pageBreakBefore: true }),
    st('默写答案'),
    ...r.dictationSentences.map((ds, i) => b(`${i + 1}. ${ds.en}`)),
  ];

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: FONT_SIZE } } } },
    sections: [
      { properties: { page: { margin: pageMargin } }, children: sec1 },
      { properties: { type: SectionType.CONTINUOUS, page: { margin: pageMargin }, column: { count: 2, space: 400, equalWidth: true } }, children: sec2 },
      { properties: { type: SectionType.CONTINUOUS, page: { margin: pageMargin } }, children: sec3 },
    ],
  });
  saveAs(await Packer.toBlob(doc), 'continuation-writing.docx');
}

// ─── M3 配套材料：默写卷 / 闪卡纸 / Anki 词表 ────────

function groupForMaterials(
  list: Array<Partial<VocabItem> & { word: string }>, stage: Stage,
): { name: string; items: Array<Partial<VocabItem> & { word: string }> }[] {
  const order = getSectionOrder(stage);
  const groups = new Map<string, Array<Partial<VocabItem> & { word: string }>>();
  for (const item of list) {
    const name = item.sectionName || '其他';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name)!.push(item);
  }
  return Array.from(groups.entries())
    .sort((a, b) => {
      const ia = order.indexOf(a[0]); const ib = order.indexOf(b[0]);
      return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib);
    })
    .map(([name, items]) => ({ name, items }));
}

function cnMeaning(item: { definition?: string }): string {
  return item.definition?.split('｜')[0]?.replace(/^[a-z]+\.(?:\s*\/\s*[a-z]+\.)*/i, '').replace(/[①②③]/g, '').trim() || '';
}

function posOf(item: { definition?: string }): string {
  return item.definition?.match(/^([a-z]+\.(?:\s*\/\s*[a-z]+\.)*)/i)?.[0] || '';
}

/**
 * 词汇默写卷（M3）：按需拼写的词出「中文提示 + 空格作答」，仅需认读的词出「英文 + 空中文」；
 * 卷末附教师用「报词单」（全部英文词按分组排列）。
 */
export async function exportDictationSheetDocx(
  vocabList: Array<Partial<VocabItem> & { word: string }>, stage: Stage = 'senior',
): Promise<void> {
  const paras: Paragraph[] = [tit('词汇默写卷'), sub('根据中文提示写出英文单词（* 为需拼写词）。')];
  let idx = 0;
  for (const group of groupForMaterials(vocabList, stage)) {
    paras.push(sectionHeader(group.name));
    for (const item of group.items) {
      idx += 1;
      const pos = posOf(item);
      if (item.spellingRequired === false) {
        paras.push(new Paragraph({
          children: [rn(`${idx}. `, { bold: true }), rn(item.word, { bold: true }), rn(`  ${pos}`), rn('  __________', { color: 'cccccc' })],
          spacing: { before: 0, after: 60 }, indent: { left: 120 },
        }));
      } else {
        paras.push(new Paragraph({
          children: [rn(`${idx}. `, { bold: true }), rn('__________  ', { color: 'cccccc' }), rn(`${item.spellingRequired ? '*' : ''}${pos}  ${cnMeaning(item)}`)],
          spacing: { before: 0, after: 60 }, indent: { left: 120 },
        }));
      }
    }
  }

  // 报词单（教师用）
  paras.push(new Paragraph({ children: [], spacing: { before: 240 } }));
  paras.push(sectionHeader('报词单（教师用）', 200));
  paras.push(new Paragraph({
    children: [rn(vocabList.map((v) => v.word).join(' · '), { size: 18, color: '555555' })],
    spacing: { before: 0, after: 60, line: 300 }, indent: { left: 120 },
  }));

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: FONT_SIZE } } } },
    sections: [{ properties: { page: { margin: { top: NARROW_MARGIN, bottom: NARROW_MARGIN, left: NARROW_MARGIN, right: NARROW_MARGIN } }, column: { count: 2, space: 400, equalWidth: true } }, children: paras }],
  });
  saveAs(await Packer.toBlob(doc), '词汇默写卷.docx');
}

/**
 * 单词闪卡纸（M3）：两列表格——左列英文面（词 + 音标），右列中文面（释义 + 搭配），
 * 沿中线对折/剪开即成闪卡。约 4 行一页。
 */
export async function exportFlashcardsDocx(vocabList: VocabItem[]): Promise<void> {
  const rows: TableRow[] = [];
  const cellMargin = { top: 160, bottom: 160, left: 160, right: 160 };
  for (const item of vocabList) {
    rows.push(new TableRow({
      children: [
        new TableCell({
          width: { size: 50, type: WidthType.PERCENTAGE },
          margins: cellMargin,
          borders: { top: { style: BorderStyle.DOTTED, size: 1, color: '999999' }, bottom: { style: BorderStyle.DOTTED, size: 1, color: '999999' }, left: { style: BorderStyle.DOTTED, size: 1, color: '999999' }, right: { style: BorderStyle.DOTTED, size: 1, color: '999999' } },
          children: [
            new Paragraph({ children: [rn(item.word, { bold: true, size: 30 })], alignment: AlignmentType.CENTER, spacing: { before: 160, after: 40 } }),
            ...(item.phonetic ? [new Paragraph({ children: [rn(item.phonetic, { size: 20, color: '666666' })], alignment: AlignmentType.CENTER, spacing: { after: 160 } })] : [new Paragraph({ children: [], spacing: { after: 160 } })]),
          ],
        }),
        new TableCell({
          width: { size: 50, type: WidthType.PERCENTAGE },
          margins: cellMargin,
          borders: { top: { style: BorderStyle.DOTTED, size: 1, color: '999999' }, bottom: { style: BorderStyle.DOTTED, size: 1, color: '999999' }, left: { style: BorderStyle.DOTTED, size: 1, color: '999999' }, right: { style: BorderStyle.DOTTED, size: 1, color: '999999' } },
          children: [
            new Paragraph({ children: [rn(`${posOf(item)} ${cnMeaning(item)}`, { size: 20 })], spacing: { before: 160, after: 40 } }),
            new Paragraph({ children: [rn((item.collocations || '').split(';')[0] || '', { size: 16, color: '888888' })], spacing: { after: 160 } }),
          ],
        }),
      ],
    }));
  }

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: FONT_SIZE } } } },
    sections: [{
      properties: { page: { margin: { top: NARROW_MARGIN, bottom: NARROW_MARGIN, left: NARROW_MARGIN, right: NARROW_MARGIN } } },
      children: [
        tit('单词闪卡纸'),
        sub('沿虚线剪开：左列为英文面，右列为中文面，对折或粘贴成卡。'),
        new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE }, layout: TableLayoutType.FIXED }),
      ],
    }],
  });
  saveAs(await Packer.toBlob(doc), '单词闪卡纸.docx');
}

/** Anki 词表（M3）：TSV 纯文本——Anki「从文件导入」直接建牌组。 */
export async function exportAnkiTsv(vocabList: VocabItem[]): Promise<void> {
  const esc = (s: string) => (s ?? '').replace(/\t/g, ' ').replace(/\n/g, '<br>');
  const lines = [
    '#separator:tab', '#html:true',
    ...vocabList.map((v) => [
      esc(v.word),
      esc(`${v.phonetic ? `${v.phonetic}<br>` : ''}${(v.definition || '').replace(/\n/g, '<br>')}`),
      esc([v.originalSentence, v.extraExample].filter(Boolean).join('<br>')),
      esc(v.collocations || ''),
    ].join('\t')),
  ];
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/tab-separated-values;charset=utf-8;' });
  saveAs(blob, 'anki-vocabulary.txt');
}

/** R2：词汇检测卷（语法填空式，配合词库多选生成）。 */
export async function exportClozeSheetDocx(items: ClozeItem[], includeAnswers = true): Promise<void> {
  const paras = buildCloze(items, includeAnswers);
  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: sz(FONT_SIZE) } } } },
    sections: [{
      properties: { page: { margin: { top: NARROW_MARGIN, bottom: NARROW_MARGIN, left: NARROW_MARGIN, right: NARROW_MARGIN } }, column: { count: 2, space: 400, equalWidth: true } },
      children: paras,
    }],
  });
  saveAs(await Packer.toBlob(doc), includeAnswers ? '词汇检测卷.docx' : '词汇检测卷-学生版.docx');
}
