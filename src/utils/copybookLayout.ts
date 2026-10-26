import type { CopybookConfig, CopybookLineType } from '../types';

// ─── 页面几何（A4 @ 96dpi，逻辑像素）───────────────────────
// 渲染时以该逻辑坐标系绘制，再整体放大到打印分辨率。

export const PAGE_W = 794; // 210mm
export const PAGE_H = 1123; // 297mm

/** 内容区边距 */
export const MARGIN_X = 72; // 左右 ≈19mm
export const CONTENT_TOP = 118; // 标题 + 头部字段下方
export const CONTENT_BOTTOM = PAGE_H - 64; // 页码上方

// ─── 线格几何（字号为基准，常量集中便于「看效果」微调）──────
// baseline = 文字基线相对行顶的偏移；guides = 各参考线（y 相对行顶，dashed 是否虚线）

export interface GuideLine {
  y: number;
  dashed: boolean;
}

export interface LineGeometry {
  /** 单行线格高度（不含行距） */
  rowHeight: number;
  /** 文字基线（相对行顶） */
  baseline: number;
  /** 参考线列表 */
  guides: GuideLine[];
}

/** 字体实测度量（单位 px，相对字母基线 alphabetic） */
export interface FontMetrics {
  /** x 高度：小写主体字母（a/c/e/o/u/n/r/s/w/x/z）顶到基线的距离 */
  xHeight: number;
  /** 升部高度：b/d/f/h/l 及大写字母顶到基线的距离 */
  ascender: number;
  /** 降部深度：g/j/p/q/y 底部到基线的距离 */
  descender: number;
}

const PAD = (fs: number) => Math.max(2, Math.round(fs * 0.1));

// 线格几何：以字体实测度量（x 高度 / 升部 / 降部）为基准，保证格子与字形精确对齐。
const LINE_GEOMETRY: Record<CopybookLineType, (fs: number, m: FontMetrics) => LineGeometry> = {
  // 四线三格：中格恰好容纳 x 高度字母（a/c/e/o/u/n/r/s/w/x/z），
  // 升部（b/d/f/h/l）超出中格顶线进入上格，降部（g/j/p/q/y）进入下格。
  fourLine: (fs, m) => {
    const pad = PAD(fs);
    const baseline = m.ascender + pad;
    return {
      rowHeight: baseline + m.descender + pad,
      baseline,
      guides: [
        { y: pad, dashed: false },                    // 上格顶线（升部/大写顶）
        { y: baseline - m.xHeight, dashed: false },   // 中格顶线（x 高度顶）
        { y: baseline, dashed: false },               // 基线
        { y: baseline + m.descender, dashed: false }, // 下格底线（降部底）
      ],
    };
  },
  // 两线：上虚线标 x 高度顶（与基线间距恰好 = x 高度），下实线为基线；升部超出虚线。
  doubleLine: (fs, m) => {
    const pad = PAD(fs);
    const baseline = m.ascender + pad;
    return {
      rowHeight: baseline + m.descender + pad,
      baseline,
      guides: [
        { y: baseline - m.xHeight, dashed: true },    // x 高度线（虚线）
        { y: baseline, dashed: false },               // 基线（实线）
      ],
    };
  },
  // 单线：单条基线，上下留足升部/降部空间，模拟考试卷面
  singleLine: (fs, m) => {
    const pad = PAD(fs);
    const baseline = m.ascender + pad;
    return {
      rowHeight: baseline + m.descender + pad,
      baseline,
      guides: [{ y: baseline, dashed: false }],
    };
  },
};

export function lineGeometry(lineType: CopybookLineType, fontSize: number, metrics: FontMetrics): LineGeometry {
  return LINE_GEOMETRY[lineType](fontSize, metrics);
}

// ─── 测量器 ───────────────────────────────────────────
// 用离屏 canvas 精确测宽，逐字符缓存；布局与绘制共用同一测量口径，保证位置一致。

export interface Measurer {
  letterSpacing: number;
  charWidth(ch: string): number;
  wordWidth(word: string): number;
  spaceWidth(): number;
  /** 字体实测度量，供线格几何对齐 */
  metrics: FontMetrics;
}

export function createMeasurer(fontFamily: string, fontSize: number, letterSpacing: number, wordSpacing: number): Measurer {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) throw new Error('当前浏览器不支持 Canvas');
  ctx.font = `${fontSize}px "${fontFamily}"`;
  const cache = new Map<string, number>();
  const charWidth = (ch: string): number => {
    const hit = cache.get(ch);
    if (hit !== undefined) return hit;
    const w = ctx.measureText(ch).width;
    cache.set(ch, w);
    return w;
  };

  // 实测度量：actualBoundingBox 相对字母基线，单位 px；字体未就绪/不支持时回退到经验比值
  const ascent = (s: string): number => {
    const v = ctx.measureText(s).actualBoundingBoxAscent;
    return typeof v === 'number' && v > 0 ? v : 0;
  };
  const descent = (s: string): number => {
    const v = ctx.measureText(s).actualBoundingBoxDescent;
    return typeof v === 'number' && v > 0 ? v : 0;
  };
  const metrics: FontMetrics = {
    xHeight: ascent('acemnorsuvwxz') || fontSize * 0.5,
    ascender: Math.max(ascent('bdfhklt'), ascent('ABCDEFGHIJKLMNOPQRSTUVWXYZ')) || fontSize * 0.72,
    descender: descent('gjpqy') || fontSize * 0.22,
  };

  // 词间距参考宽度：一个 o（或 a）的宽度
  const oWidth = charWidth('o') || charWidth('a') || fontSize * 0.5;

  return {
    letterSpacing,
    charWidth,
    wordWidth: (word) => {
      const chars = Array.from(word);
      if (!chars.length) return 0;
      return chars.reduce((s, c) => s + charWidth(c) + letterSpacing, -letterSpacing);
    },
    spaceWidth: () => wordSpacing * oWidth,
    metrics,
  };
}

// ─── 布局产物 ─────────────────────────────────────────

export interface Glyph {
  ch: string;
  /** 相对内容区左缘的 x */
  x: number;
}

export interface Row {
  kind: 'text' | 'blank';
  glyphs: Glyph[];
  /** 行顶 y（页面绝对坐标） */
  top: number;
}

export interface CopybookPage {
  rows: Row[];
}

export interface CopybookLayout {
  pages: CopybookPage[];
  content: { left: number; top: number; width: number; bottom: number };
  /** 行高（含行距） */
  rowAdvance: number;
  geo: LineGeometry;
  pageCount: number;
}

// ─── 文本换行 ─────────────────────────────────────────
// 尊重硬换行（\n），词级贪心换行；空行保留为空白行。

function wrapText(text: string, m: Measurer, contentWidth: number): string[] {
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    const words = rawLine.split(' ').filter(Boolean);
    if (!words.length) {
      out.push('');
      continue;
    }
    let cur: string[] = [];
    let curW = 0;
    for (const w of words) {
      const ww = m.wordWidth(w);
      if (cur.length === 0) {
        cur = [w];
        curW = ww;
      } else if (curW + m.spaceWidth() + ww <= contentWidth) {
        cur.push(w);
        curW += m.spaceWidth() + ww;
      } else {
        out.push(cur.join(' '));
        cur = [w];
        curW = ww;
      }
    }
    if (cur.length) out.push(cur.join(' '));
  }
  return out;
}

/** 把一行文本展开为逐字符位置（空格只推进不落字），供渲染器直接描字。 */
function lineToGlyphs(line: string, m: Measurer): Glyph[] {
  const glyphs: Glyph[] = [];
  let x = 0;
  const words = line.split(' ');
  words.forEach((word, wi) => {
    const chars = Array.from(word);
    chars.forEach((ch, ci) => {
      glyphs.push({ ch, x });
      x += m.charWidth(ch) + (ci < chars.length - 1 ? m.letterSpacing : 0);
    });
    if (wi < words.length - 1) x += m.spaceWidth();
  });
  return glyphs;
}

// ─── 主布局函数 ───────────────────────────────────────

export function layoutCopybook(config: CopybookConfig, fontFamily = 'Hengshui'): CopybookLayout {
  const contentLeft = MARGIN_X;
  const contentWidth = PAGE_W - MARGIN_X * 2;
  const m = createMeasurer(fontFamily, config.fontSize, config.letterSpacing, config.wordSpacing);
  const geo = lineGeometry(config.lineType, config.fontSize, m.metrics);
  const rowAdvance = geo.rowHeight + config.lineSpacing;
  const content = {
    left: contentLeft,
    top: CONTENT_TOP,
    width: contentWidth,
    bottom: CONTENT_BOTTOM,
  };
  const rowsPerPage = Math.max(1, Math.floor((CONTENT_BOTTOM - CONTENT_TOP) / rowAdvance));

  // 纯空白字帖：无文本，填满一页空白行
  if (config.mode === 'blank') {
    const rows: Row[] = [];
    for (let i = 0; i < rowsPerPage; i++) {
      rows.push({ kind: 'blank', glyphs: [], top: CONTENT_TOP + i * rowAdvance });
    }
    return { pages: [{ rows }], content, rowAdvance, geo, pageCount: 1 };
  }

  // 描红 / 隔行临摹：由文本驱动
  const materialLines = wrapText(config.text, m, contentWidth);
  const flat: Omit<Row, 'top'>[] = [];
  for (const line of materialLines) {
    flat.push({ kind: 'text', glyphs: lineToGlyphs(line, m) });
    if (config.mode === 'interleaved') {
      flat.push({ kind: 'blank', glyphs: [] });
    }
  }

  const pages: CopybookPage[] = [];
  for (let s = 0; s < flat.length; s += rowsPerPage) {
    const chunk = flat.slice(s, s + rowsPerPage);
    pages.push({
      rows: chunk.map((r, i) => ({ ...r, top: CONTENT_TOP + i * rowAdvance })),
    });
  }
  if (!pages.length) pages.push({ rows: [] });

  return { pages, content, rowAdvance, geo, pageCount: pages.length };
}
