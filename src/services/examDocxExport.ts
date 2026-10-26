/**
 * 试卷排版助手：docx 导出（版式对齐标准试卷参考卷）。
 * - 题号嵌在题干段首（普通字重、无悬挂缩进），自动去除 LLM 残留的重复题号
 * - 选项（有题干的题）段落缩进 2 字符；按估宽分档：一行 4 个 / 2+2 / 逐行，tab 停靠位对齐
 * - 完形填空、七选五（无题干选择题）：题号与选项同行，无缩进
 * - 词义猜测题的引号目标词在原文 passage 中下划线（对齐真实试卷，题干不加线）
 * - 应用文/读后续写不加题号；应用文 10 行答题线，读后续写每段首句后 8 行（EXACT 定距，整齐等距）
 * - 目标页数：按内容估高自动调节行距/段距，贴近便于双面打印的页数
 * 纸张：A4 纵向单栏 / 8K (260×370mm) 横向双栏 / A3 横向双栏。
 * 结构行（第Ⅰ卷/部分完整标题/节标题）按原卷渲染；同名连续段（听力按节切块）只渲染一次大题标题。
 * 页脚：试卷节「试卷第N页，共M页」（双栏卷整卷一节、试卷头放首页页眉，SECTIONPAGES 才能算对总页数），
 * 答案节独立另起且页码重启「答案第N页，共M页」，行距固定不参与凑页。
 * 命名样式（试卷 标题/题干/答题线…）供教师在 Word/WPS 样式面板全局调整；
 * 导出后 JSZip 后处理注入 Word 中文排版开关（标点压缩/kinsoku/中西文自动留空等）。
 */
import {
  Document, Packer, Paragraph, TextRun, AlignmentType, BorderStyle,
  PageOrientation, Tab, TabStopType, Footer, Header, PageNumber, LineRuleType,
} from 'docx';
import type { ISectionOptions, IParagraphStyleOptions } from 'docx';
import { saveAs } from 'file-saver';
import JSZip from 'jszip';
import type { ExamLayoutOptions, ExamPaper, ExamPaperSize, ExamQuestion, ExamOption, ExamSection } from '../types';

const FONT = { ascii: 'Times New Roman', eastAsia: '宋体', hAnsi: 'Times New Roman', cs: 'Times New Roman' } as const;
const FONT_HEI = { ascii: 'SimHei', eastAsia: '黑体', hAnsi: 'SimHei', cs: 'SimHei' } as const;

/** 页面几何：w/h 一律传「竖式」尺寸（宽=短边，高=长边）；landscape 时 docx 库自动对调输出 */
const PAPER_GEO: Record<ExamPaperSize, { w: number; h: number; landscape: boolean; columns: 1 | 2 }> = {
  a4: { w: 11906, h: 16838, landscape: false, columns: 1 },  // 210×297mm
  '8k': { w: 14742, h: 20979, landscape: true, columns: 2 }, // 260×370mm 正度8开
  a3: { w: 16838, h: 23811, landscape: true, columns: 2 },   // 297×420mm
};

/** 0.5 英寸（1.27cm）四边，对齐参考卷 */
const MARGIN = { top: 720, bottom: 720, left: 720, right: 720 };
/** 双栏栏间距 */
const COLUMN_SPACE = 400;
/** 选项文本与 tab 停靠位之间的最小间隙 */
const TAB_GAP = 150;
/** 应用文答题线行数 */
const PRACTICAL_ESSAY_LINES = 10;
/** 读后续写每段答题线行数 */
const CONTINUATION_LINES_PER_PARA = 8;

/** 凑页求解的行距/段距范围（L 为 240 的倍率） */
const FIT_LINE_MIN = 1.0, FIT_LINE_MAX = 1.7;
const FIT_GAP_MIN = 20, FIT_GAP_MAX = 140;

// ─── 宽度估算与文本清洗 ────────────────────────────

const CJK_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF01-\uFF5E\u3000-\u303F]/;

/** 估算文本宽度（twips）：ASCII ≈ 半 em、CJK ≈ 1 em；fs 为半点字号（21 = 五号） */
function textWidth(s: string, fs: number): number {
  let w = 0;
  for (const ch of s) w += CJK_RE.test(ch) ? fs * 10 : fs * 5;
  return w;
}

/** 选项标签 "A. " 的估算宽度 */
const labelW = (fs: number) => 14 * fs;

/** 单倍行距下的行高估算（twips）：字号 × 1.3 */
const baseLineH = (fs: number) => fs * 13;

/** 估算段落在给定宽度下占的行数（4% 折行损耗） */
function estLines(text: string, fs: number, width: number): number {
  if (!text.trim()) return 1;
  return Math.max(1, Math.ceil((textWidth(text, fs) * 1.04) / Math.max(width, 800)));
}

/** 去掉正文开头残留的编号（LLM 常把 "21．"/"A." 连同正文一起返回）；编号后必须跟标点或空白，避免剥掉正文首字母 */
export function stripLeadingTag(tag: string, text: string): string {
  if (!tag || !text) return text;
  const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`^\\s*${esc}(\\s*[.．、:：)]\\s*|\\s+)`), '');
}

/** 选项标签剥离：只认「标签 + 标点分隔」（A. / A）——不带 stripLeadingTag 的空白臂，
 *  否则会把选项正文首词的冠词当标签再剥一次（"A textbook…" → "textbook…"，实测丢词） */
export function stripOptionLabel(label: string, text: string): string {
  if (!label || !text) return text;
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`^\\s*${esc}\\s*[.．、:：)]\\s*`), '');
}

type Align = (typeof AlignmentType)[keyof typeof AlignmentType];

interface Ctx {
  fs: number;
  /** 当前排版宽度（twips）：双栏 = 栏宽 */
  usable: number;
  /** 行距（docx spacing.line，240 = 单倍） */
  line: number;
  /** 文本段后间距 */
  gap: number;
  /** 测量模式：累计行数/固定间距/段数，用于凑页求解 */
  meter?: { lines: number; fixed: number; paras: number };
}

/** 无直接格式的 run（字体/字号继承命名样式或文档默认值，教师改样式全局生效） */
function plain(text: string): TextRun {
  return new TextRun({ text });
}

/** 无直接格式的制表符 run（选项 / 答案组之间的间隔，字体继承命名样式） */
function plainTab(): TextRun {
  return new TextRun({ children: [new Tab()] });
}

/** 通用文本段（使用 ctx 的行距/段距；测量模式下累计高度） */
function textPara(ctx: Ctx, children: TextRun[], o: {
  lines?: number; before?: number; indent?: { left?: number; firstLine?: number };
  style?: string; align?: Align; tabStops?: { type: (typeof TabStopType)[keyof typeof TabStopType]; position: number }[];
  /** 测量模式下该段自身字号（半点）：标题 32 / 注意事项 18 等与正文 fs 不同的段按比例折算行高 */
  meterSize?: number;
} = {}): Paragraph {
  if (ctx.meter) {
    ctx.meter.lines += (o.lines ?? 1) * (o.meterSize ?? ctx.fs) / ctx.fs;
    ctx.meter.fixed += o.before ?? 0;
    ctx.meter.paras += 1;
  }
  return new Paragraph({
    ...(o.style ? { style: o.style } : {}),
    children,
    spacing: { before: o.before ?? 0, after: ctx.gap, line: ctx.line },
    ...(o.indent ? { indent: o.indent } : {}),
    ...(o.align ? { alignment: o.align } : {}),
    ...(o.tabStops ? { tabStops: o.tabStops } : {}),
  });
}

/** 作文答题横线：空段落 + 底部虚线边框，自动占满栏宽。
 *  行距 EXACT 固定步距（字号×24 twips，五号≈8.9mm），不受凑页行距伸缩影响，
 *  保证应用文 10 行 / 续写每段 8 行的答题区整齐等距。 */
const rulePitch = (fs: number) => fs * 24;
/** 相邻同样式边框段落会被 Word/WPS 合并为一个边框块（整组只剩最后一条线，其余成空白），
 *  奇偶行交替 999999/9A9A9A 两种视觉无差的灰色破坏边框同一性，确保每行答题线都独立画出。 */
function essayLine(ctx: Ctx, odd = false): Paragraph {
  if (ctx.meter) {
    ctx.meter.fixed += rulePitch(ctx.fs); // EXACT 定高：计入固定间距而非行数
  }
  // 边框与 EXACT 定距固化在 ExamRule/ExamRuleAlt 命名样式（两种颜色破坏相邻边框同一性，防 Word 合并）
  return new Paragraph({ style: odd ? 'ExamRuleAlt' : 'ExamRule', children: [] });
}

/** 词义猜测题目标词提取：word/phrase/expression/underlined 后引号内的词（下划线加在原文 passage 上）。
 *  先匹配双引号，再单引号；单引号闭合后必须不是字母（避免 “don't” 被截成 don）。 */
const GUESS_DQ_RE = /\b(?:word|phrase|expression|underlined)\b[^.?!]{0,30}?["\u201c]([^"\u201d]{1,50})["\u201d]/gi;
const GUESS_SQ_RE = /\b(?:word|phrase|expression|underlined)\b[^.?!]{0,30}?['\u2018]([^'\u2019]{1,50})['\u2019](?![A-Za-z])/gi;
/** 每篇文章的目标词：目标词归其题干所属文章（题号前最近的一篇 passage），
 *  避免 A 篇题干的目标词画到 B 篇原文上 */
function guessTargetsByPassage(questions: ExamQuestion[]): Map<ExamQuestion, string[]> {
  const map = new Map<ExamQuestion, string[]>();
  let passage: ExamQuestion | null = null;
  for (const q of questions) {
    if (q.type === 'passage') { passage = q; continue; }
    if (q.type !== 'choice' || !q.stem || !passage) continue;
    const list = map.get(passage) ?? [];
    for (const re of [GUESS_DQ_RE, GUESS_SQ_RE]) {
      for (const m of q.stem.matchAll(re)) {
        const w = m[1].trim();
        if (w && !list.includes(w)) list.push(w);
      }
    }
    map.set(passage, list);
  }
  return map;
}

/** 原文段落按目标词加下划线（首个出现处；大小写敏感优先，找不到再退化为不敏感） */
function underlineTargets(text: string, targets: string[]): TextRun[] {
  if (targets.length === 0 || !text) return [];
  type Span = { start: number; end: number };
  const spans: Span[] = [];
  const used: Span[] = [];
  for (const t of targets) {
    let at = text.indexOf(t);
    if (at < 0) {
      // toLowerCase 拉长字符串的少见 Unicode 会让切片错位：长度不一致时跳过退化匹配
      const lowText = text.toLowerCase();
      const lowT = t.toLowerCase();
      if (lowText.length === text.length && lowT.length === t.length) at = lowText.indexOf(lowT);
    }
    if (at < 0) continue;
    const sp = { start: at, end: at + t.length };
    if (used.some((x) => sp.start < x.end && x.start < sp.end)) continue; // 与已选区间重叠：跳过
    used.push(sp);
    spans.push(sp);
  }
  if (spans.length === 0) return [];
  spans.sort((a, b) => a.start - b.start);
  const runs: TextRun[] = [];
  let last = 0;
  for (const sp of spans) {
    if (sp.start > last) runs.push(plain(text.slice(last, sp.start)));
    runs.push(new TextRun({ text: text.slice(sp.start, sp.end), underline: {} }));
    last = sp.end;
  }
  if (last < text.length) runs.push(plain(text.slice(last)));
  return runs;
}

// ─── 命名样式（教师在 Word/WPS 样式面板可全局改字体/字号/加粗）────

const EXAM_BASE = { basedOn: 'Normal', next: 'Normal', quickFormat: true } as const;

/** 语义样式表：字体/字号/对齐/缩进/边框按导出时的排版参数固化；
 *  行距/段距是凑页求解值（逐题变化），仍逐段直接设置。 */
function buildExamStyles(fs: number): IParagraphStyleOptions[] {
  const body = { run: { font: FONT, size: fs } };
  const ruleStyle = (color: string) => ({
    run: { font: FONT, size: fs },
    paragraph: {
      border: { bottom: { style: BorderStyle.DOTTED, size: 4, color, space: 1 } },
      spacing: { before: 0, after: 0, line: rulePitch(fs), lineRule: LineRuleType.EXACT },
    },
  });
  return [
    { id: 'ExamTitle', name: '试卷 标题', ...EXAM_BASE,
      run: { font: FONT_HEI, size: 32, bold: true }, paragraph: { alignment: AlignmentType.CENTER } },
    { id: 'ExamSubtitle', name: '试卷 副标题', ...EXAM_BASE,
      ...body, paragraph: { alignment: AlignmentType.CENTER } },
    { id: 'ExamClassline', name: '试卷 班级姓名行', ...EXAM_BASE,
      ...body, paragraph: { alignment: AlignmentType.CENTER } },
    { id: 'ExamNotice', name: '试卷 注意事项', ...EXAM_BASE,
      run: { font: FONT, size: 18 }, paragraph: { alignment: AlignmentType.LEFT } },
    { id: 'ExamVolume', name: '试卷 卷别行', ...EXAM_BASE,
      run: { font: FONT_HEI, size: 28 }, paragraph: { alignment: AlignmentType.CENTER } },
    { id: 'ExamPart', name: '试卷 大题标题', ...EXAM_BASE,
      run: { font: FONT, size: fs, bold: true } },
    { id: 'ExamSub', name: '试卷 节标题', ...EXAM_BASE,
      run: { font: FONT, size: fs, bold: true }, paragraph: { alignment: AlignmentType.JUSTIFIED } },
    { id: 'ExamInstruction', name: '试卷 大题说明', ...EXAM_BASE,
      ...body, paragraph: { alignment: AlignmentType.JUSTIFIED, indent: { firstLine: fs * 20 } } },
    { id: 'ExamStem', name: '试卷 题干', ...EXAM_BASE,
      ...body, paragraph: { alignment: AlignmentType.JUSTIFIED } },
    { id: 'ExamOptions', name: '试卷 选项', ...EXAM_BASE, ...body },
    { id: 'ExamOptionsIndent', name: '试卷 选项缩进', ...EXAM_BASE,
      ...body, paragraph: { indent: { left: fs * 20 } } },
    { id: 'ExamLabel', name: '试卷 篇章标号', ...EXAM_BASE,
      run: { font: FONT, size: fs, bold: true }, paragraph: { alignment: AlignmentType.CENTER } },
    { id: 'ExamPassage', name: '试卷 文章正文', ...EXAM_BASE,
      ...body, paragraph: { alignment: AlignmentType.JUSTIFIED, indent: { firstLine: fs * 20 } } },
    { id: 'ExamEssay', name: '试卷 作文题干', ...EXAM_BASE,
      ...body, paragraph: { alignment: AlignmentType.JUSTIFIED } },
    { id: 'ExamRule', name: '试卷 答题线', ...EXAM_BASE, ...ruleStyle('999999') },
    { id: 'ExamRuleAlt', name: '试卷 答题线(交替)', ...EXAM_BASE, ...ruleStyle('9A9A9A') },
    { id: 'ExamHr', name: '试卷 分隔线', ...EXAM_BASE, run: { font: FONT, size: fs },
      paragraph: { border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000', space: 1 } },
        spacing: { before: 80, after: 120 } } },
    { id: 'ExamAnswerTitle', name: '答案 标题', ...EXAM_BASE,
      run: { font: FONT_HEI, size: 28, bold: true },
      paragraph: { alignment: AlignmentType.CENTER, spacing: { before: 0, after: 120 } } },
    { id: 'ExamAnswerSection', name: '答案 大题', ...EXAM_BASE,
      run: { font: FONT, size: fs, bold: true } },
    { id: 'ExamAnswer', name: '答案 条目', ...EXAM_BASE, ...body },
  ];
}

// ─── 试卷头 ────────────────────────────────────────

function renderHeader(paper: ExamPaper, ctx: Ctx): Paragraph[] {
  const { meta } = paper;
  const paras: Paragraph[] = [
    textPara(ctx, [plain(meta.title || '英语试卷')], { style: 'ExamTitle', before: 0, meterSize: 32 }),
  ];
  if (meta.subTitle) {
    paras.push(textPara(ctx, [plain(meta.subTitle)], { style: 'ExamSubtitle' }));
  }
  paras.push(textPara(ctx, [plain('班级 ____________　　姓名 ____________　　考号 ____________')],
    { style: 'ExamClassline' }));
  for (const n of meta.notices) {
    if (!n.trim()) continue;
    paras.push(textPara(ctx, [plain(n)], { style: 'ExamNotice', meterSize: 18 }));
  }
  // 底部分隔线（边框/间距固化在 ExamHr 样式）
  if (ctx.meter) { ctx.meter.lines += 1; ctx.meter.fixed += 200; }
  paras.push(new Paragraph({ style: 'ExamHr', children: [] }));
  return paras;
}

// ─── 题目渲染 ──────────────────────────────────────

/** 题干段：题号嵌在段首，普通字重、无缩进（对齐参考卷 "21．What..."） */
function stemPara(ctx: Ctx, number: string, stem: string): Paragraph {
  const children: TextRun[] = [];
  if (number) children.push(plain(`${number}. `));
  children.push(plain(stem));
  return textPara(ctx, children, {
    style: 'ExamStem',
    lines: estLines(`${number}. ${stem}`, ctx.fs, ctx.usable),
  });
}

/** 选项文本：去掉残留标签后拼 "A. text" */
function optionText(o: ExamOption): string {
  return `${o.label}. ${stripOptionLabel(o.label, o.text ?? '')}`;
}

/**
 * 选项行数分档（可用宽度按栏宽自适应）：
 * 4 个选项 → 尝试 4/行、2/行、1/行；3 个选项（听力）→ 3/行 或 1/行；
 * 其余数量 → min(n,4)/行、2/行、1/行。
 * indentW 为每行首项的段落缩进；leadNumber（完形填空题号）只加宽第一行首段。
 */
function optionsPerLine(opts: ExamOption[], leadNumber: string, indentW: number, ctx: Ctx): number {
  const n = opts.length;
  const candidates = n === 3 ? [3, 1] : [...new Set([Math.min(n, 4), 2, 1])];
  const leadW = leadNumber ? textWidth(`${leadNumber}. `, ctx.fs) : 0;
  for (const per of candidates) {
    const seg = ctx.usable / per - TAB_GAP;
    const fits = opts.every((o, i) => {
      let extra = i % per === 0 ? indentW : 0;
      if (i === 0) extra += leadW;
      return extra + labelW(ctx.fs) + textWidth(stripOptionLabel(o.label, o.text ?? ''), ctx.fs) <= seg;
    });
    if (fits) return per;
  }
  return 1;
}

/** 选项渲染：同一行内的选项用 tab 分隔，tab 停靠位按 per 均分栏宽；indent = 每行首项缩进 2 字符 */
function renderOptions(ctx: Ctx, opts: ExamOption[], leadNumber = '', indent = false): Paragraph[] {
  if (opts.length === 0) return [];
  const indentW = indent ? ctx.fs * 20 : 0;
  const per = optionsPerLine(opts, leadNumber, indentW, ctx);
  const paras: Paragraph[] = [];
  for (let i = 0; i < opts.length; i += per) {
    const line = opts.slice(i, i + per);
    const children: TextRun[] = [];
    if (i === 0 && leadNumber) children.push(plain(`${leadNumber}. `));
    line.forEach((o, j) => {
      if (j > 0) children.push(plainTab());
      children.push(plain(optionText(o)));
    });
    const lead = i === 0 && leadNumber ? `${leadNumber}. ` : '';
    // per=1（长选项逐行）时选项可能折行：按估宽计入行数，凑页求解与预览不再低估
    const avail = ctx.usable - TAB_GAP - indentW - (lead ? textWidth(lead, ctx.fs) : 0);
    paras.push(textPara(ctx, children, {
      style: indent ? 'ExamOptionsIndent' : 'ExamOptions',
      lines: per === 1 ? estLines(`${lead}${optionText(line[0])}`, ctx.fs, avail) : 1,
      ...(per > 1
        ? { tabStops: Array.from({ length: per - 1 }, (_, k) => ({ type: TabStopType.LEFT, position: Math.round((ctx.usable * (k + 1)) / per) })) }
        : {}),
    }));
  }
  return paras;
}

/** 读后续写：行首 Paragraph 1 / Para 2 段首句标记 */
const PARA_OPEN_RE = /^\s*(?:paragraph|par?a)\s*[12]\b/i;
/** 段首句标记（非锚定：marker 可能被硬换行合并到上一行） */
const PARA_MARK_RE = /(?:paragraph|par?a)\s*([12])\b/gi;
/** 应用文题干特征（防止混入续写标题大题的应用文被误判为续写） */
const PRACTICAL_HINT_RE = /假定你是|请写一封|写一封|写一篇|发言稿|邮件|通知|倡议书|演讲稿|词数\s*100/;
/** 注意事项块行：「注意：…」「1．续写词数应为150左右；」「(2)请按如下格式…作答。」 */
const NOTE_LINE_RE = /^(注意|说明)[:：]?|^[（(]?\d{1,2}\s*[.．、）)]/;
/** 书信框架行（应用文答题区排版用）：称呼与整行结尾敬语——答题线应插在两者之间 */
const SALUTATION_RE = /^\s*(?:Dear\s+[^,，:：]{1,40}|To\s+whom\s+it\s+may\s+concern)\s*[,，]?\s*$/i;
const CLOSING_RE = /^\s*(?:Yours(?:\s+(?:truly|sincerely|faithfully|ever))?|Best\s+wishes|Warm(?:est)?\s+regards|Regards|Sincerely(?:\s+yours)?)\s*[,，]?\s*$/i;
const LATIN_COUNT_RE = /[A-Za-z]/g;
const CJK_COUNT_RE = /[\u2E80-\u9FFF\uF900-\uFAFF]/g;

/** 真段首句行：行首 marker 之后确有英文正文（≥3 连续字母），
 *  排除注意块里「Paragraph 1：________」作答格式模板行（否则答题线翻倍） */
function isOpenerLine(line: string): boolean {
  if (!PARA_OPEN_RE.test(line)) return false;
  const rest = line.replace(PARA_OPEN_RE, '').replace(/[_\s]/g, '');
  return /[A-Za-z]{3}/.test(rest);
}

/** 英文句行（无 marker 时的段首句启发式）：拉丁字母够多且明显多于 CJK
 *  （排除「微信公众号：EngHelper」之类夹带拉丁字母的水印/广告行） */
function isEnglishSentenceLine(s: string): boolean {
  const latin = (s.match(LATIN_COUNT_RE) || []).length;
  const cjk = (s.match(CJK_COUNT_RE) || []).length;
  return latin >= 12 && latin > cjk * 2;
}

/** 作文题答题线分析（导出与预览共用）：
 *  返回题干各行（index = 原行序）及每行后应跟的答题线数 ——
 *  读后续写：段首句行（Paragraph 1/2 真句，排除作答格式模板行）后 8 行，合计不足 16 行时末尾补足；
 *  应用文：末尾 10 行。 */
interface EssaySeg { text: string; index: number; ruled: number }
export function analyzeEssay(stem: string, sectionTitle: string): EssaySeg[] {
  const parts = stem.split('\n').filter((x) => x.trim());
  const markers = [...stem.matchAll(PARA_MARK_RE)];
  const hasP1 = markers.some((m) => m[1] === '1');
  const hasP2 = markers.some((m) => m[1] === '2');
  const practical = PRACTICAL_HINT_RE.test(stem);
  // 续写判定：双 marker（可被硬换行合并故非锚定）或大题标题含「续写」；应用文特征题干一律按应用文
  const isContinuation = !practical && ((hasP1 && hasP2) || /续写/.test(sectionTitle));
  // 行首真段首句行（排除「Paragraph 1：____」格式模板行），至多取前两处（P1/P2）
  let openIdxs = parts.map((p, i) => (isOpenerLine(p) ? i : -1)).filter((i) => i >= 0).slice(0, 2);
  if (openIdxs.length === 0 && isContinuation) {
    // 无行首 Paragraph 标记：题干末尾（注意/说明项之后）的最后两段英文即所给段首句
    // （英文句过滤：拉丁字母够多且明显多于 CJK，跳过「优点英语整理」「公众号：EngHelper」等水印行）
    let lastNote = -1;
    parts.forEach((p, i) => { if (NOTE_LINE_RE.test(p.trim())) lastNote = i; });
    const english = parts.map((p, i) => ({ p, i })).filter(({ p }) => isEnglishSentenceLine(p));
    const tail = english.filter(({ i }) => i > lastNote);
    if (tail.length >= 2) openIdxs = tail.slice(-2).map(({ i }) => i);
    else if (english.length >= 2) {
      // 注意块在段首句之后的卷式：退化为全文最后两段英文（即所给段首句）
      openIdxs = english.slice(-2).map(({ i }) => i);
    }
  }
  const segs: EssaySeg[] = [];
  let ruled = 0; // 已产出的续写答题线数
  parts.forEach((p, i) => {
    let after = 0;
    if (isContinuation && openIdxs.includes(i)) after = CONTINUATION_LINES_PER_PARA;
    segs.push({ text: p, index: i, ruled: after });
    ruled += after;
  });
  if (segs.length === 0) segs.push({ text: stem, index: 0, ruled: 0 });
  if (!isContinuation) {
    // 书信框架（Dear Tom, … Yours, … Li Hua）：答题线插在称呼与落款之间（对齐原卷版式），
    // 称呼取最后一个匹配（题干引用来信「Dear Li Hua,…」时不选错），且其后须存在整行结尾敬语；
    // 框架不完整（通知/演讲稿等非书信）维持末行挂线
    const salIdx = segs.reduce((acc, s, i) => (SALUTATION_RE.test(s.text) ? i : acc), -1);
    const hasClosing = salIdx >= 0 && segs.slice(salIdx + 1).some((s) => CLOSING_RE.test(s.text.trim()));
    segs[hasClosing ? salIdx : segs.length - 1].ruled += PRACTICAL_ESSAY_LINES;
  } else if (ruled < CONTINUATION_LINES_PER_PARA * 2) {
    // 段首句被合并成一行/只找到一处 marker 时，补足两段合计 16 行答题线
    segs[segs.length - 1].ruled += CONTINUATION_LINES_PER_PARA * 2 - ruled;
  }
  return segs;
}

function renderQuestion(q: ExamQuestion, ctx: Ctx, sectionTitle = '', targets: string[] = []): Paragraph[] {
  const paras: Paragraph[] = [];
  const stem = stripLeadingTag(q.number, q.stem ?? '');
  const fs = ctx.fs;
  switch (q.type) {
    case 'passage': {
      // 文章标号（阅读理解 A–D）：加粗居中（对齐参考卷）
      if (q.label) {
        paras.push(textPara(ctx, [plain(q.label)], { style: 'ExamLabel', before: 60 }));
      }
      const remaining = new Set(targets); // 每个目标词只在其首次出现的段落下划线
      for (const p of stem.split('\n').filter((x) => x.trim())) {
        const active = [...remaining];
        const runs = active.length > 0 ? underlineTargets(p, active) : [];
        for (const t of active) {
          const lowP = p.toLowerCase(), lowT = t.toLowerCase();
          if (p.includes(t) || (lowP.length === p.length && lowT.length === t.length && lowP.includes(lowT))) {
            remaining.delete(t);
          }
        }
        paras.push(textPara(ctx, runs.length > 0 ? runs : [plain(p)], {
          style: 'ExamPassage',
          lines: estLines(p, fs, ctx.usable - fs * 20),
        }));
      }
      break;
    }
    case 'choice': {
      if (stem.trim()) {
        paras.push(stemPara(ctx, q.number, stem));
        paras.push(...renderOptions(ctx, q.options ?? [], '', true));
      } else {
        // 完形填空 / 七选五选项块：无题干，题号与选项同行、无缩进
        paras.push(...renderOptions(ctx, q.options ?? [], q.number, false));
      }
      break;
    }
    case 'essay': {
      // 应用文 / 读后续写不加题号；答题线分布由 analyzeEssay 统一分析（预览共用）
      for (const seg of analyzeEssay(stem, sectionTitle)) {
        paras.push(textPara(ctx, [plain(seg.text)], {
          style: 'ExamEssay',
          ...(seg.index > 0 ? { indent: { firstLine: fs * 20 } } : {}),
          lines: estLines(seg.text, fs, seg.index > 0 ? ctx.usable - fs * 20 : ctx.usable),
        }));
        for (let k = 0; k < seg.ruled; k++) paras.push(essayLine(ctx, k % 2 === 1));
      }
      break;
    }
    case 'blank': {
      const parts = stem.split('\n').filter((x) => x.trim());
      if (parts.length <= 1) {
        // 单句填空：题号 + 整句
        if (stem.trim() || q.number) paras.push(stemPara(ctx, q.number, stem));
        break;
      }
      // 语篇型语法填空：整篇按文章段落排版（首行缩进、无题号前缀）
      for (const p of parts) {
        paras.push(textPara(ctx, [plain(p)], {
          style: 'ExamPassage',
          lines: estLines(p, fs, ctx.usable - fs * 20),
        }));
      }
      break;
    }
    default:  // other
      if (stem.trim() || q.number) paras.push(stemPara(ctx, q.number, stem));
      break;
  }
  return paras;
}

/** essay 题干首行逐字复述大题说明（读后续写被劈块/解析污染形态）：剥掉该行避免说明渲染
 *  两遍；其后内容与答题区不受影响（stem 全空时 analyzeEssay 兜底仍产出答题线） */
function stripEssayInstructionDup(stem: string, instruction?: string): string {
  const instr = (instruction ?? '').trim();
  if (!instr) return stem;
  const norm = (s: string) => s.replace(/\s+/g, '');
  const lines = stem.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (i < lines.length && norm(lines[i]) === norm(instr)) {
    lines.splice(i, 1);
    return lines.join('\n');
  }
  return stem;
}

/**
 * 大题渲染。结构行顺序对齐参考卷：卷别（居中黑体）→ 部分完整标题（加粗，
 * 优先于短名）→ 节标题行（加粗）→ 大题说明（首行缩进）→ 题目。
 * prevTitle：同名连续段（听力按节切块 / 超大块二次切分）只渲染一次大题标题。
 */
function renderSection(sec: ExamSection, ctx: Ctx, prevTitle = ''): Paragraph[] {
  const fs = ctx.fs;
  const paras: Paragraph[] = [];
  const continues = sec.title === prevTitle; // 同名续段：不再重复标题与结构头
  if (sec.volumeDivider && !continues) {
    paras.push(textPara(ctx, [plain(sec.volumeDivider)], { style: 'ExamVolume', before: 240, lines: 1 }));
  }
  // 节级大题（有节标题行、无部分标题）不渲染题型名大标题：原卷此位置只有「第X节（…）」行，
  // 用 outline 题型名顶上的孤立 ExamPart 行会破坏原卷节标题体系（编辑器列表中仍可见大题名）
  const hasSub = (sec.subHeaders ?? []).some((h) => h.trim());
  const header = sec.partTitle || sec.title || '未命名大题';
  if (!continues && (sec.partTitle || !hasSub)) {
    paras.push(textPara(ctx, [plain(header)],
      { style: 'ExamPart', before: 120, lines: estLines(header, fs, ctx.usable) }));
  }
  for (const h of sec.subHeaders ?? []) {
    if (!h.trim()) continue;
    paras.push(textPara(ctx, [plain(h)], {
      style: 'ExamSub',
      before: 60,
      lines: estLines(h, fs, ctx.usable),
    }));
  }
  if (sec.instruction) {
    paras.push(textPara(ctx, [plain(sec.instruction)], {
      style: 'ExamInstruction',
      lines: estLines(sec.instruction, fs, ctx.usable - fs * 20),
    }));
  }
  // 词义猜测题的目标词下划线加在其题号所属的 passage 原文上
  const targetsByPassage = guessTargetsByPassage(sec.questions);
  for (const q of sec.questions) {
    const q1 = q.type === 'essay' ? { ...q, stem: stripEssayInstructionDup(q.stem ?? '', sec.instruction) } : q;
    paras.push(...renderQuestion(q1, ctx, sec.title, targetsByPassage.get(q) ?? []));
  }
  return paras;
}

// ─── 答案页 ────────────────────────────────────────

/** 答案页：选择题 5 题一组（1-5 BACCD）、3 组一行 tab 对齐；填空/长答案流式排列 */
function renderAnswerPage(paper: ExamPaper, fs: number, usable: number): Paragraph[] {
  const ctx: Ctx = { fs, usable, line: 276, gap: 30 };
  const paras: Paragraph[] = [
    new Paragraph({ style: 'ExamAnswerTitle', children: [plain('参考答案')] }),
  ];
  const tabStops = [
    { type: TabStopType.LEFT, position: Math.round(usable / 3) },
    { type: TabStopType.LEFT, position: Math.round((usable * 2) / 3) },
  ];
  let prevTitle = '';
  for (const sec of paper.sections) {
    const answerable = sec.questions.filter((q) =>
      q.type !== 'passage' && ((q.number || '').trim() !== '' || (q.answer || '').trim() !== ''));
    if (answerable.length === 0) continue; // 无可答题的大题不动 prevTitle：后续同名节标题不被误抑制
    if (sec.title !== prevTitle) {
      paras.push(textPara(ctx, [plain(sec.title || '未命名大题')], { style: 'ExamAnswerSection', before: 100 }));
    }
    prevTitle = sec.title;

    // 选择题：连续短答案 5 题一组
    const packs: string[] = [];
    let pack: ExamQuestion[] = [];
    const flushPack = () => {
      if (pack.length === 0) return;
      const a = pack[0].number;
      const b = pack[pack.length - 1].number;
      const label = a !== b ? `${a}-${b}` : `${a}`;
      packs.push(`${label} ${pack.map((q) => (q.answer || '_').trim()).join('')}`);
      pack = [];
    };
    const others: ExamQuestion[] = [];
    for (const q of answerable) {
      const ans = (q.answer || '').trim();
      if (q.type === 'choice' && q.number && ans.length <= 2) {
        pack.push(q);
        if (pack.length >= 5) flushPack();
      } else {
        flushPack();
        others.push(q);
      }
    }
    flushPack();

    for (let i = 0; i < packs.length; i += 3) {
      const line = packs.slice(i, i + 3);
      paras.push(textPara(ctx, line.flatMap((p, j) => (j > 0 ? [plainTab(), plain(p)] : [plain(p)])),
        { style: 'ExamAnswer', tabStops }));
    }

    // 填空 / 作文等：按宽度流式排列，自动换行
    if (others.length > 0) {
      let runs: TextRun[] = [];
      let width = 0;
      const flushFlow = () => {
        if (runs.length > 0) paras.push(textPara(ctx, runs, { style: 'ExamAnswer' }));
        runs = [];
        width = 0;
      };
      for (const q of others) {
        const item = `${q.number ? `${q.number}. ` : ''}${(q.answer || '').trim() || '_____'}`;
        if (runs.length > 0 && width + textWidth(item, fs) > usable - 300) flushFlow();
        runs.push(plain(runs.length > 0 ? `   ${item}` : item));
        width += textWidth(item, fs) + 300;
      }
      flushFlow();
    }
  }
  return paras;
}

// ─── 凑页求解 ──────────────────────────────────────

interface Meter { lines: number; fixed: number; paras: number }

function measureBody(paper: ExamPaper, fs: number, usable: number): Meter {
  const ctx: Ctx = { fs, usable, line: 240, gap: 0, meter: { lines: 0, fixed: 0, paras: 0 } };
  let prev = '';
  for (const s of paper.sections) { renderSection(s, ctx, prev); prev = s.title; }
  return ctx.meter!;
}

function measureHeader(paper: ExamPaper, fs: number, usable: number): Meter {
  const ctx: Ctx = { fs, usable, line: 240, gap: 0, meter: { lines: 0, fixed: 0, paras: 0 } };
  renderHeader(paper, ctx);
  return ctx.meter!;
}

/**
 * 求解行距倍率 L 与段距 G，使正文估高贴近 targetPages 页：
 * 高度模型 H(L,G) = lines×baseH×L + fixed + paras×G（twips，按栏高计）。
 */
/** 凑页求解入口（导出与预览共用）：试卷头占用按解出的行距/段距二次逼近 ——
 *  头段与正文同节渲染（A4 首页正文 / 双栏首页页眉），行高随 L 伸缩、段距为 G，
 *  按单倍行距预留会把差值 1:1 转成页溢出。 */
function solveExamFit(
  paper: ExamPaper, layout: ExamLayoutOptions, geo: { columns: 1 | 2 }, fs: number,
  contentW: number, bodyUsable: number, colH: number,
): { line: number; gap: number } {
  if (layout.targetPages <= 0) return { line: 276, gap: 30 };
  const capacity = layout.targetPages * (geo.columns === 1 ? colH : colH * 2);
  const headerM = layout.withHeader ? measureHeader(paper, fs, contentW) : null;
  const bodyM = measureBody(paper, fs, bodyUsable);
  const reserved = (L: number, G: number) => headerM
    ? headerM.lines * baseLineH(fs) * L + headerM.fixed + headerM.paras * G
    : 0;
  const need = (r: number) => capacity - (geo.columns === 1 ? r : r * 2);
  let { line, gap } = solveFit(bodyM, need(reserved(1, 30)), fs);
  ({ line, gap } = solveFit(bodyM, need(reserved(line / 240, gap)), fs));
  return { line, gap };
}

function solveFit(m: Meter, needHeight: number, fs: number): { line: number; gap: number } {
  const base = baseLineH(fs);
  const textH = m.lines * base;
  const H = (L: number, G: number) => textH * L + m.fixed + m.paras * G;
  let L: number, G: number;
  if (H(FIT_LINE_MIN, FIT_GAP_MIN) >= needHeight) {
    L = FIT_LINE_MIN; G = FIT_GAP_MIN;                 // 内容超出：压到最紧
  } else if (H(FIT_LINE_MAX, FIT_GAP_MAX) <= needHeight) {
    L = FIT_LINE_MAX; G = FIT_GAP_MAX;                 // 内容不足：放到最松
  } else {
    G = 60;
    L = (needHeight - m.fixed - m.paras * G) / textH;
    if (L < FIT_LINE_MIN || L > FIT_LINE_MAX) {
      L = Math.min(FIT_LINE_MAX, Math.max(FIT_LINE_MIN, L));
      G = (needHeight - m.fixed - textH * L) / m.paras;
      G = Math.min(FIT_GAP_MAX, Math.max(FIT_GAP_MIN, G));
    }
  }
  return { line: Math.round(240 * L), gap: Math.round(G) };
}

// ─── OOXML 后处理（模仿 docx skill 的 unpack→patch→repack，浏览器内 JSZip 完成）───

/** Word 中文文档的标准 CJK 兼容开关（对齐参考卷 compat 块，useFELayout 东亚版式等） */
const COMPAT_CJK_FLAGS = '<w:spaceForUL/><w:balanceSingleByteDoubleByteWidth/><w:doNotLeaveBackslashAlone/>'
  + '<w:ulTrailSpace/><w:doNotExpandShiftReturn/><w:adjustLineHeightInTable/>'
  + '<w:doNotWrapTextWithPunct/><w:doNotUseEastAsianBreakRules/><w:useFELayout/>';

/** docx 库 API 不暴露的中文排版开关补进包里：
 *  settings.xml —— 标点压缩 compressPunctuation、CJK 兼容开关、themeFontLang 东亚语言
 *                 （元素顺序对齐 ECMA-376 CT_Settings：characterSpacingControl 在 compat 前，themeFontLang 在 compat 后）；
 *  styles.xml docDefaults —— kinsoku（东亚行首行尾禁则）、autoSpaceDE/DN（中西文/中文数字间自动留空）
 *                 （docx 库输出的 pPrDefault 为空标签；三个 pPr 子元素按 CT_PPrBase 顺序排列）。 */
async function patchCjkTypography(blob: Blob): Promise<Blob> {
  const zip = await JSZip.loadAsync(blob);
  const settingsFile = zip.file('word/settings.xml');
  if (settingsFile) {
    let xml = await settingsFile.async('string');
    if (!xml.includes('characterSpacingControl')) {
      xml = xml.replace('<w:compat>', '<w:characterSpacingControl w:val="compressPunctuation"/><w:compat>');
    }
    if (!xml.includes('useFELayout')) {
      xml = xml.replace('<w:compat>', `<w:compat>${COMPAT_CJK_FLAGS}`);
    }
    if (!xml.includes('themeFontLang')) {
      xml = xml.replace('</w:compat>', '</w:compat><w:themeFontLang w:val="en-US" w:eastAsia="zh-CN"/>');
    }
    zip.file('word/settings.xml', xml);
  }
  const stylesFile = zip.file('word/styles.xml');
  if (stylesFile) {
    let xml = await stylesFile.async('string');
    if (!xml.includes('autoSpaceDE') && xml.includes('<w:pPrDefault/>')) {
      xml = xml.replace('<w:pPrDefault/>',
        '<w:pPrDefault><w:pPr><w:kinsoku/><w:autoSpaceDE/><w:autoSpaceDN/></w:pPr></w:pPrDefault>');
    }
    zip.file('word/styles.xml', xml);
  }
  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    compression: 'DEFLATE', // docx 库打包用 DEFLATE；JSZip 重打包默认 STORE 会让体积膨胀数倍
  });
}

// ─── 主导出 ────────────────────────────────────────

function sanitizeFilename(s: string): string {
  const cleaned = (s || '').replace(/[\\/:*?"<>|]/g, '').trim();
  return cleaned || 'exam-paper';
}

/** 全卷是否任一题已填答案：原卷无答案且 LLM 被禁止作答时，答案页只是整页「_____」空占位
 *  （还缺语法填空/写作板块），凭空生成的答案页不如不出——教师填入任一真实答案后自动恢复 */
function hasAnyAnswer(paper: ExamPaper): boolean {
  return paper.sections.some((s) => s.questions.some((q) => (q.answer ?? '').trim() !== ''));
}

export async function exportExamPaperDocx(paper: ExamPaper, layout: ExamLayoutOptions): Promise<void> {
  const geo = PAPER_GEO[layout.paper];
  const fs = layout.fontSize;
  const size = geo.landscape
    ? { width: geo.w, height: geo.h, orientation: PageOrientation.LANDSCAPE }
    : { width: geo.w, height: geo.h };
  const page = { size, margin: MARGIN };
  const contentW = (geo.landscape ? geo.h : geo.w) - MARGIN.left - MARGIN.right;
  const bodyUsable = geo.columns === 2 ? Math.floor((contentW - COLUMN_SPACE) / 2) : contentW;

  // 默认排版参数；设置目标页数时按估高求解（试卷头占用随解出行距二次逼近，见 solveExamFit）
  let line = 276, gap = 30;
  if (layout.targetPages > 0) {
    const colH = (geo.columns === 1 ? geo.h : geo.w) - MARGIN.top - MARGIN.bottom;
    ({ line, gap } = solveExamFit(paper, layout, geo, fs, contentW, bodyUsable, colH));
  }
  const ctx: Ctx = { fs, usable: bodyUsable, line, gap };
  const body: Paragraph[] = [];
  let prevTitle = '';
  for (const s of paper.sections) { body.push(...renderSection(s, ctx, prevTitle)); prevTitle = s.title; }

  // 页脚（居中）：「试卷第N页，共M页」/「答案第N页，共M页」（PAGE + SECTIONPAGES 域，Word/WPS 求值）
  const pageFooter = (prefix: string) => new Footer({
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({ text: `${prefix}第`, font: FONT, size: 18 }),
        new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 18 }),
        new TextRun({ text: '页，共', font: FONT, size: 18 }),
        new TextRun({ children: [PageNumber.TOTAL_PAGES_IN_SECTION], font: FONT, size: 18 }),
        new TextRun({ text: '页', font: FONT, size: 18 }),
      ],
    })],
  });
  const examFooter = () => pageFooter('试卷');
  const answerPage = { ...page, pageNumbers: { start: 1 } }; // 答案节独立计数

  let sections: ISectionOptions[];
  const wantAnswerPage = layout.withAnswerPage && hasAnyAnswer(paper);
  if (geo.columns === 1) {
    // A4：试卷节 + 答案节（独立页码重启）；无答案页时单节
    const examChildren: Paragraph[] = [
      ...(layout.withHeader ? renderHeader(paper, ctx) : []),
      ...body,
    ];
    if (wantAnswerPage) {
      sections = [
        { properties: { page }, footers: { default: examFooter() }, children: examChildren },
        { properties: { page: answerPage }, footers: { default: pageFooter('答案') }, children: renderAnswerPage(paper, fs, contentW) },
      ];
    } else {
      sections = [{ properties: { page }, footers: { default: examFooter() }, children: examChildren }];
    }
  } else {
    // 双栏：整卷一个节（PAGE/SECTIONPAGES 域按节求值，拆节会让首页「共M页」算错），
    // 试卷头放「首页页眉」（titlePage 首页不同页眉，天然跨栏全宽）→ 答案节另起新页、页码重启
    sections = [{
      properties: {
        page,
        column: { count: 2, space: COLUMN_SPACE, equalWidth: true },
        ...(layout.withHeader ? { titlePage: true } : {}),
      },
      ...(layout.withHeader ? {
        headers: {
          first: new Header({ children: renderHeader(paper, ctx) }),
          // EXACT 定高 14tw（≈0.7pt）：页眉区 708+14 < 上边距 720，空页眉不把第 2 页起的正文顶下移
          default: new Header({ children: [new Paragraph({
            children: [], spacing: { before: 0, after: 0, line: 14, lineRule: LineRuleType.EXACT },
          })] }),
        },
        footers: { first: pageFooter('试卷'), default: examFooter() },
      } : {
        footers: { default: examFooter() },
      }),
      children: body,
    }];
    if (wantAnswerPage) {
      sections.push({
        properties: { page: answerPage },
        footers: { default: pageFooter('答案') },
        children: renderAnswerPage(paper, fs, contentW),
      });
    }
  }

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: fs } } }, paragraphStyles: buildExamStyles(fs) },
    sections,
  });
  const blob = await Packer.toBlob(doc);
  saveAs(await patchCjkTypography(blob), `${sanitizeFilename(paper.meta.title)}.docx`);
}
// ─── 版式预览模型（与导出同一套估宽/凑页/答题线分析，供网页端分页预览）───

export type PreviewBlockKind =
  | 'title' | 'subtitle' | 'classline' | 'notice' | 'hr'
  | 'volume' | 'part' | 'sub' | 'instruction' | 'stem' | 'options' | 'passage' | 'essayText' | 'rule'
  | 'answerTitle' | 'answerSection' | 'answerPack' | 'answerFlow';

export interface PreviewRun { t: string; u?: boolean; b?: boolean; hei?: boolean }

export interface PreviewBlock {
  kind: PreviewBlockKind;
  runs: PreviewRun[];
  /** 估行数（rule 块为 0） */
  lines: number;
  /** 段前间距（twips） */
  before: number;
  /** 是否计段后间距（textPara 类段落） */
  gapAfter: boolean;
  /** 首行缩进 2 字符 */
  firstLine?: boolean;
  center?: boolean;
  /** kind === 'rule'：横线根数 */
  ruleCount?: number;
  /** 左缩进 2 字符（选项段） */
  indentLeft?: boolean;
  /** 字号（半点） */
  fs: number;
}

export interface PreviewPageModel {
  /** 显示方向尺寸（landscape 已对调） */
  w: number; h: number;
  columns: 1 | 2;
  colBlocks: PreviewBlock[][];
  kind: 'exam' | 'answer';
  /** 首页试卷头（跨栏横带，仅首页有） */
  headerBlocks?: PreviewBlock[];
  /** 本节内页码（1 起，对应页脚 PAGE 域） */
  pageNo?: number;
  /** 本页行距/段距（答案页固定 276/30 不随凑页伸缩，正文页用求解值） */
  line?: number;
  gap?: number;
}

export interface PreviewModel {
  pages: PreviewPageModel[];
  /** 求解后的行距（240 基准）/ 段距（twips） */
  line: number; gap: number;
  withAnswer: boolean;
}

/** 块高度（twips）：rule 块 = 根数×定距；文本块 = 段前 + 行数×基准行高×L + 段后 */
function blockH(b: PreviewBlock, L: number, gap: number): number {
  if (b.kind === 'rule') return (b.ruleCount ?? 0) * rulePitch(b.fs);
  if (b.kind === 'hr') return b.before + baseLineH(b.fs) * L;
  return b.before + b.lines * baseLineH(b.fs) * L + (b.gapAfter ? gap : 0);
}

/** 正文 → 预览块序列（镜像 renderSection/renderQuestion，含同名续段抑制与 passage 下划线） */
function previewBodyBlocks(paper: ExamPaper, fs: number, usable: number): PreviewBlock[] {
  const blocks: PreviewBlock[] = [];
  const push = (kind: PreviewBlockKind, runs: PreviewRun[], o: Partial<PreviewBlock> & { lines?: number } = {}) => {
    blocks.push({
      kind, runs, lines: o.lines ?? 1, before: o.before ?? 0,
      gapAfter: o.gapAfter ?? true, firstLine: o.firstLine, center: o.center, ruleCount: o.ruleCount,
      indentLeft: o.indentLeft, fs,
    });
  };
  let prevTitle = '';
  for (const sec of paper.sections) {
    const continues = sec.title === prevTitle;
    if (sec.volumeDivider && !continues) {
      push('volume', [{ t: sec.volumeDivider, hei: true }], { before: 240, center: true, lines: 1 });
    }
    // 与导出 renderSection 同步：节级大题（有节标题行、无部分标题）不渲染题型名大标题
    const hasSub = (sec.subHeaders ?? []).some((h) => h.trim());
    const header = sec.partTitle || sec.title || '未命名大题';
    if (!continues && (sec.partTitle || !hasSub)) push('part', [{ t: header, b: true }], { before: 120, lines: estLines(header, fs, usable) });
    for (const h of sec.subHeaders ?? []) {
      if (!h.trim()) continue;
      push('sub', [{ t: h, b: true }], { before: 60, lines: estLines(h, fs, usable) });
    }
    if (sec.instruction) {
      push('instruction', [{ t: sec.instruction }], {
        firstLine: true, lines: estLines(sec.instruction, fs, usable - fs * 20),
      });
    }
    const targetsByPassage = guessTargetsByPassage(sec.questions);
    for (const q of sec.questions) {
      const stem = stripLeadingTag(q.number, q.type === 'essay' ? stripEssayInstructionDup(q.stem ?? '', sec.instruction) : (q.stem ?? ''));
      switch (q.type) {
        case 'passage': {
          if (q.label) push('passage', [{ t: q.label, b: true }], { before: 60, center: true, lines: 1 });
          const remaining = new Set(targetsByPassage.get(q) ?? []);
          for (const para of stem.split('\n').filter((x) => x.trim())) {
            const active = [...remaining];
            const us = active.length > 0 ? underlineSpans(para, active) : [{ text: para, underline: false }];
            for (const t of active) {
              const lowP = para.toLowerCase(), lowT = t.toLowerCase();
              if (para.includes(t) || (lowP.length === para.length && lowT.length === t.length && lowP.includes(lowT))) {
                remaining.delete(t);
              }
            }
            push('passage', us.map((u) => ({ t: u.text, u: u.underline ? true : undefined })),
              { firstLine: true, lines: estLines(para, fs, usable - fs * 20) });
          }
          break;
        }
        case 'choice': {
          const opts = q.options ?? [];
          if (stem.trim()) {
            push('stem', [{ t: `${q.number ? `${q.number}. ` : ''}${stem}` }],
              { lines: estLines(`${q.number}. ${stem}`, fs, usable) });
            previewOptionBlocks(opts, '', true, fs, usable, push);
          } else {
            previewOptionBlocks(opts, q.number, false, fs, usable, push);
          }
          break;
        }
        case 'essay': {
          for (const seg of analyzeEssay(stem, sec.title)) {
            push('essayText', [{ t: seg.text }], {
              firstLine: seg.index > 0,
              lines: estLines(seg.text, fs, seg.index > 0 ? usable - fs * 20 : usable),
            });
            if (seg.ruled > 0) push('rule', [], { ruleCount: seg.ruled, lines: 0, gapAfter: false });
          }
          break;
        }
        case 'blank': {
          const parts = stem.split('\n').filter((x) => x.trim());
          if (parts.length <= 1) {
            if (stem.trim() || q.number) {
              push('stem', [{ t: `${q.number ? `${q.number}. ` : ''}${stem}` }],
                { lines: estLines(`${q.number}. ${stem}`, fs, usable) });
            }
            break;
          }
          for (const para of parts) {
            push('passage', [{ t: para }], { firstLine: true, lines: estLines(para, fs, usable - fs * 20) });
          }
          break;
        }
        default:
          if (stem.trim() || q.number) {
            push('stem', [{ t: `${q.number ? `${q.number}. ` : ''}${stem}` }],
              { lines: estLines(`${q.number}. ${stem}`, fs, usable) });
          }
          break;
      }
    }
    prevTitle = sec.title;
  }
  return blocks;
}

/** 选项块（镜像 renderOptions 的分档逻辑） */
function previewOptionBlocks(
  opts: ExamOption[], leadNumber: string, indent: boolean,
  fs: number, usable: number,
  push: (kind: PreviewBlockKind, runs: PreviewRun[], o?: Partial<PreviewBlock> & { lines?: number }) => void,
): void {
  if (opts.length === 0) return;
  const indentW = indent ? fs * 20 : 0;
  const per = optionsPerLine(opts, leadNumber, indentW, { fs, usable, line: 240, gap: 0 });
  for (let i = 0; i < opts.length; i += per) {
    const line = opts.slice(i, i + per);
    const runs: PreviewRun[] = [];
    const lead = i === 0 && leadNumber ? `${leadNumber}. ` : '';
    if (lead) runs.push({ t: lead });
    const avail = usable - TAB_GAP - indentW - (lead ? textWidth(lead, fs) : 0);
    line.forEach((o, j) => {
      if (j > 0) runs.push({ t: '\t' });
      runs.push({ t: optionText(o) });
    });
    push('options', runs, {
      lines: per === 1 ? estLines(`${lead}${optionText(line[0])}`, fs, avail) : 1,
      ...(indent ? { indentLeft: true } : {}),
    });
  }
}

/** 试卷头 → 预览块 */
function previewHeaderBlocks(paper: ExamPaper, fs: number): PreviewBlock[] {
  const blocks: PreviewBlock[] = [];
  const push = (kind: PreviewBlockKind, runs: PreviewRun[], o: Partial<PreviewBlock> = {}) => {
    blocks.push({ kind, runs, lines: 1, before: 0, gapAfter: true, fs, ...o });
  };
  push('title', [{ t: paper.meta.title || '英语试卷', b: true, hei: true }], { center: true, fs: 32 });
  if (paper.meta.subTitle) push('subtitle', [{ t: paper.meta.subTitle }], { center: true });
  push('classline', [{ t: '班级 ____________\u3000\u3000姓名 ____________\u3000\u3000考号 ____________' }], { center: true });
  for (const n of paper.meta.notices) {
    if (!n.trim()) continue;
    blocks.push({ kind: 'notice', runs: [{ t: n }], lines: 1, before: 0, gapAfter: true, fs: 18 });
  }
  blocks.push({ kind: 'hr', runs: [], lines: 1, before: 80, gapAfter: false, fs });
  return blocks;
}

/** 答案页 → 预览块（镜像 renderAnswerPage 的分组打包） */
function previewAnswerBlocks(paper: ExamPaper, fs: number, usable: number): PreviewBlock[] {
  const blocks: PreviewBlock[] = [];
  blocks.push({ kind: 'answerTitle', runs: [{ t: '参考答案', b: true, hei: true }], lines: 1, before: 0, gapAfter: true, fs });
  let prevTitle = '';
  for (const sec of paper.sections) {
    const answerable = sec.questions.filter((q) =>
      q.type !== 'passage' && ((q.number || '').trim() !== '' || (q.answer || '').trim() !== ''));
    if (answerable.length === 0) continue; // 无可答题的大题不动 prevTitle：后续同名节标题不被误抑制
    if (sec.title !== prevTitle) {
      blocks.push({ kind: 'answerSection', runs: [{ t: sec.title || '未命名大题', b: true }], lines: 1, before: 100, gapAfter: true, fs });
    }
    prevTitle = sec.title;
    const packs: string[] = [];
    let pack: ExamQuestion[] = [];
    const flushPack = () => {
      if (pack.length === 0) return;
      const a = pack[0].number;
      const b = pack[pack.length - 1].number;
      packs.push(`${a !== b ? `${a}-${b}` : `${a}`} ${pack.map((q) => (q.answer || '_').trim()).join('')}`);
      pack = [];
    };
    const others: ExamQuestion[] = [];
    for (const q of answerable) {
      const ans = (q.answer || '').trim();
      if (q.type === 'choice' && q.number && ans.length <= 2) {
        pack.push(q);
        if (pack.length >= 5) flushPack();
      } else {
        flushPack();
        others.push(q);
      }
    }
    flushPack();
    for (let i = 0; i < packs.length; i += 3) {
      blocks.push({ kind: 'answerPack', runs: [{ t: packs.slice(i, i + 3).join('\t') }], lines: 1, before: 0, gapAfter: true, fs });
    }
    if (others.length > 0) {
      let line = '';
      for (const q of others) {
        const item = `${q.number ? `${q.number}. ` : ''}${(q.answer || '').trim() || '_____'}`;
        if (line && textWidth(line + '   ' + item, fs) > usable - 300) {
          blocks.push({ kind: 'answerFlow', runs: [{ t: line }], lines: 1, before: 0, gapAfter: true, fs });
          line = item;
        } else {
          line = line ? `${line}   ${item}` : item;
        }
      }
      if (line) blocks.push({ kind: 'answerFlow', runs: [{ t: line }], lines: 1, before: 0, gapAfter: true, fs });
    }
  }
  return blocks;
}

/** underlineTargets 的文本版（返回分段，供预览 runs） */
function underlineSpans(text: string, targets: string[]): { text: string; underline: boolean }[] {
  if (targets.length === 0 || !text) return [{ text, underline: false }];
  const spans: { start: number; end: number }[] = [];
  for (const t of targets) {
    if (!t) continue;
    let at = text.indexOf(t);
    if (at < 0) {
      // toLowerCase 拉长字符串的少见 Unicode 会让切片错位：长度不一致时跳过退化匹配
      const lowText = text.toLowerCase();
      const lowT = t.toLowerCase();
      if (lowText.length === text.length && lowT.length === t.length) at = lowText.indexOf(lowT);
    }
    if (at < 0) continue;
    const sp = { start: at, end: at + t.length };
    if (spans.some((x) => sp.start < x.end && x.start < sp.end)) continue;
    spans.push(sp);
  }
  if (spans.length === 0) return [{ text, underline: false }];
  spans.sort((a, b) => a.start - b.start);
  const out: { text: string; underline: boolean }[] = [];
  let last = 0;
  for (const sp of spans) {
    if (sp.start > last) out.push({ text: text.slice(last, sp.start), underline: false });
    out.push({ text: text.slice(sp.start, sp.end), underline: true });
    last = sp.end;
  }
  if (last < text.length) out.push({ text: text.slice(last), underline: false });
  return out;
}

/** 构建分页预览模型：块按估高顺序流进各页各栏（块不跨栏拆分），
 *  试卷头渲染为首页顶部跨栏横带，答案页另起且单栏。 */
export function buildPreviewModel(paper: ExamPaper, layout: ExamLayoutOptions): PreviewModel {
  const geo = PAPER_GEO[layout.paper];
  const fs = layout.fontSize;
  const contentW = (geo.landscape ? geo.h : geo.w) - MARGIN.left - MARGIN.right;
  const bodyUsable = geo.columns === 2 ? Math.floor((contentW - COLUMN_SPACE) / 2) : contentW;
  const pageW = geo.landscape ? geo.h : geo.w;
  const pageH = geo.landscape ? geo.w : geo.h;
  const colH = pageH - MARGIN.top - MARGIN.bottom;

  // 与导出一致的凑页求解（共用 solveExamFit，含试卷头占用二次逼近）
  let line = 276, gap = 30;
  if (layout.targetPages > 0) {
    ({ line, gap } = solveExamFit(paper, layout, geo, fs, contentW, bodyUsable, colH));
  }
  const L = line / 240;

  const headerBlocks = layout.withHeader ? previewHeaderBlocks(paper, fs) : null;
  const headerH = headerBlocks ? headerBlocks.reduce((a, b) => a + blockH(b, L, gap), 0) : 0;
  const bodyBlocks = previewBodyBlocks(paper, fs, bodyUsable);
  const answerBlocks = layout.withAnswerPage && hasAnyAnswer(paper) ? previewAnswerBlocks(paper, fs, contentW) : null;

  /** 顺序流式排布：填满当前栏 → 下一栏 → 新页 */
  const flow = (blocks: PreviewBlock[], out: PreviewPageModel[], columns: 1 | 2, firstCap: number,
    lg: { line: number; gap: number }) => {
    let pi = -1, ci = 0, used = 0, cap = 0;
    const ensurePage = (capacity: number) => {
      pi += 1; ci = 0; used = 0; cap = capacity;
      out.push({ w: pageW, h: pageH, columns, colBlocks: Array.from({ length: columns }, () => []), kind: 'exam',
        line: lg.line, gap: lg.gap });
    };
    ensurePage(firstCap);
    for (const b of blocks) {
      const h = blockH(b, lg.line / 240, lg.gap);
      if (used + h > cap && used > 0) {
        // 首页试卷头横带压低整页两栏：第 2 栏同样只保留 firstCap 高度（docx 中试卷头在首页页眉）
        if (ci + 1 < columns) { ci += 1; used = 0; cap = pi === 0 ? firstCap : colH; }
        else ensurePage(colH);
      }
      out[pi].colBlocks[ci].push(b);
      used += h;
    }
  };

  const examPages: PreviewPageModel[] = [];
  flow(bodyBlocks, examPages, geo.columns, headerBlocks ? Math.max(colH - headerH, colH * 0.3) : colH, { line, gap });
  if (headerBlocks) examPages[0].headerBlocks = headerBlocks;
  examPages.forEach((pg, i) => { pg.kind = 'exam'; pg.pageNo = i + 1; });

  const answerPages: PreviewPageModel[] = [];
  if (answerBlocks && answerBlocks.length > 0) {
    flow(answerBlocks, answerPages, 1, colH, { line: 276, gap: 30 }); // 答案页固定行距（与导出 renderAnswerPage 一致）
    answerPages.forEach((pg, i) => { pg.kind = 'answer'; pg.pageNo = i + 1; });
  }
  return {
    pages: [...examPages, ...answerPages],
    line, gap,
    withAnswer: answerPages.length > 0,
  };
}
