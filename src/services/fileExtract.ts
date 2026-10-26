/**
 * 试卷排版助手：上传文档文本提取（.docx / .pdf / .txt），结果直接灌入原文输入框走既有解析管线。
 * - docx：JSZip 解包 word/document.xml，按段落顺序拼文本（w:tab→制表符、w:br→换行、表格按嵌套深度配对线性化），
 *   忽略段落属性（制表位定义等）与文本框/图形，只读正文不读页眉页脚
 * - pdf：pdfjs-dist 逐页读取文字层（hasEOL 分行、页间空行）；扫描件无文字层时明确报错
 * - 统一清理纯页码、「第X页（共X页）」页眉页脚、整行分隔线等噪音行（整行形态匹配，不误删正文）
 */
import JSZip from 'jszip';

const MAX_FILE_SIZE = 50 * 1024 * 1024;

// ─── XML 实体解码 ─────────────────────────────────

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** w:p 段落 XML → 纯文本：先剔除段落属性（w:pPr 里的 tab 是制表位定义不是制表符），w:t 按顺序拼接，w:tab→\t，w:br→\n */
function paraText(pXml: string): string {
  const body = pXml.replace(/<w:pPr>[\s\S]*?<\/w:pPr>/, '');
  let out = '';
  for (const m of body.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/?>|<w:br\b[^>]*\/?>/g)) {
    if (m[1] !== undefined) out += decodeXmlEntities(m[1]);
    else if (m[0].startsWith('<w:tab')) out += '\t';
    else out += '\n';
  }
  return out;
}

/** 段落两种形态：带体 / 自闭合（段落内不会再嵌段落，非贪婪安全；文本框已整体删除） */
const PARA_RE = /<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;

/**
 * 按嵌套深度配对切出指定标签的完整块（单元格内嵌表格时非贪婪正则会提前收口，必须计数配对）。
 * 开标签用 \b 边界匹配，排除 <w:tblPr>/<w:tblGrid>/<w:trPr>/<w:tcPr> 等同名前缀属性标签。
 */
function* matchBlocks(xml: string, tag: string): Generator<{ start: number; text: string }> {
  const closeTag = `</w:${tag}>`;
  const openRe = new RegExp(`<w:${tag}\\b[^>]*?(/?)>`, 'g');
  const opens: { at: number; end: number; self: boolean }[] = [];
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(xml))) opens.push({ at: m.index, end: openRe.lastIndex, self: m[1] === '/' });
  const closes: number[] = [];
  for (let i = xml.indexOf(closeTag); i >= 0; i = xml.indexOf(closeTag, i + closeTag.length)) closes.push(i);

  let oi = 0, cj = 0;
  while (oi < opens.length) {
    const o = opens[oi];
    if (o.self) { yield { start: o.at, text: xml.slice(o.at, o.end) }; oi++; continue; }
    // 事件流深度配对：依次消费比自身更靠后的开/闭标签
    let depth = 1;
    let endPos: number;
    let k = oi + 1;
    for (;;) {
      const nextOpenAt = k < opens.length ? opens[k].at : Infinity;
      const nextCloseAt = cj < closes.length ? closes[cj] : Infinity;
      if (nextOpenAt === Infinity && nextCloseAt === Infinity) return; // 残缺文档：放弃剩余块
      if (nextOpenAt < nextCloseAt) {
        if (!opens[k].self) depth++;
        k++;
      } else {
        depth--;
        const closeEnd = closes[cj] + closeTag.length;
        cj++;
        if (depth === 0) { endPos = closeEnd; break; }
      }
    }
    yield { start: o.at, text: xml.slice(o.at, endPos) };
    oi = k; // 块内嵌套的开标签已随本块一并产出
  }
}

/** 段落与表格按出现顺序转文本（表格内单元格递归处理段落与嵌套表） */
function blocksText(xml: string): string {
  const parts: string[] = [];
  let pos = 0;
  for (const tbl of matchBlocks(xml, 'tbl')) {
    for (const p of xml.slice(pos, tbl.start).matchAll(PARA_RE)) parts.push(paraText(p[0]));
    parts.push(tableText(tbl.text));
    pos = tbl.start + tbl.text.length;
  }
  for (const p of xml.slice(pos).matchAll(PARA_RE)) parts.push(paraText(p[0]));
  return parts.join('\n');
}

/** 表格线性化：单元格内段落换行、同行单元格制表符分隔、行间换行（试卷中偶见答案表） */
function tableText(tblXml: string): string {
  const rows: string[] = [];
  for (const r of matchBlocks(tblXml, 'tr')) {
    const cells: string[] = [];
    for (const c of matchBlocks(r.text, 'tc')) cells.push(blocksText(c.text));
    rows.push(cells.join('\t'));
  }
  return rows.join('\n');
}

async function extractDocxText(buf: ArrayBuffer): Promise<string> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    throw new Error('无法读取 Word 文档（文件可能已损坏、设有密码，或实为 .doc 老格式——请解除保护或另存为 .docx 后重试）');
  }
  const xmlFile = zip.file('word/document.xml');
  if (!xmlFile) throw new Error('无法读取 Word 文档内容（文件可能已损坏，或实为 .doc 老格式——请先另存为 .docx）');
  const xml = await xmlFile.async('string');
  const bodyMatch = xml.match(/<w:body>([\s\S]*)<\/w:body>/);
  const cleaned = (bodyMatch ? bodyMatch[1] : xml)
    // 图形/图片/文本框整体移除（内部含嵌套段落，不删会错位；试卷中的密封线竖排文字即在此类）
    .replace(/<w:drawing>[\s\S]*?<\/w:drawing>/g, '')
    .replace(/<w:pict>[\s\S]*?<\/w:pict>/g, '');
  const text = blocksText(cleaned);
  if (!text.trim() && /<w:drawing\b|<w:pict\b/.test(xml) && !/<w:t\b/.test(xml)) {
    throw new Error('该 Word 文档正文中没有文字（内容似为图片/扫描页）。请上传文字版文档，或将文字复制后粘贴');
  }
  return text;
}

// ─── PDF 文字层提取 ───────────────────────────────

type PdfjsModule = typeof import('pdfjs-dist');

let pdfjsReady: Promise<PdfjsModule> | null = null;

/** 懒加载 pdfjs（动态 import 自动分包）；失败不缓存，下次上传可重试 */
function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsReady) {
    pdfjsReady = (async () => {
      const pdfjs = await import('pdfjs-dist');
      if (!pdfjs.GlobalWorkerOptions.workerPort && typeof Worker !== 'undefined') {
        const { default: PdfWorker } = await import('pdfjs-dist/build/pdf.worker.min.mjs?worker');
        pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();
      }
      return pdfjs;
    })().catch((e: unknown) => {
      pdfjsReady = null; // 网络抖动等瞬时失败：允许下次重试
      throw e;
    });
  }
  return pdfjsReady;
}

/** 文字层条目 → 文本：同条目拼接，hasEOL 处换行 */
export function itemsToText(items: unknown[]): string {
  let text = '';
  for (const it of items) {
    const item = it as { str?: string; hasEOL?: boolean };
    if (typeof item.str !== 'string') continue;
    text += item.str;
    if (item.hasEOL) text += '\n';
  }
  return text;
}

/** 站点文字层水印整行形态（学科网等在扫描件 PDF 上盖的 {#{QQ…}#}）：这类 PDF 非空字符不少但全是水印，须按"无文字层"分流视觉识别 */
const PDF_WATERMARK_RE = /^\s*\{#[^#]*#\}\s*$/;

async function extractPdfText(buf: ArrayBuffer): Promise<string> {
  const pdfjs = await loadPdfjs();
  let doc: Awaited<ReturnType<PdfjsModule['getDocument']>['promise']>;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  } catch {
    throw new Error('无法打开该 PDF（文件可能已损坏或设有密码保护）');
  }
  const pages: string[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      try {
        const content = await page.getTextContent();
        pages.push(itemsToText(content.items));
      } finally {
        page.cleanup();
      }
    }
  } catch {
    throw new Error('PDF 解析中断（文件可能部分损坏）。请尝试重新导出 PDF，或改用 Word 版上传');
  } finally {
    await doc.destroy(); // 任何失败都释放 worker 侧资源（文件字节已 transfer 进共享 worker）
  }
  // 水印整行剥掉后统计有效字符：全水印文字层（732 字符也可能全是 {#…#}）不再骗过
  // <30 阈值灌垃圾进原文框；有效字符占比过低（<20%）同样视为扫描件转视觉识别
  const raw = pages.join('\n\n');
  const meaningful = raw.split(/\r\n?|\n/).filter((l) => !PDF_WATERMARK_RE.test(l)).join('\n');
  const rawNonspace = raw.replace(/\s/g, '').length;
  const meaningfulNonspace = meaningful.replace(/\s/g, '').length;
  if (meaningfulNonspace < 30 || (rawNonspace > 0 && meaningfulNonspace < rawNonspace * 0.2)) {
    throw new Error('该 PDF 未检测到文字层（可能是扫描件/图片版 PDF）。请上传文字版 PDF，或将文字复制后粘贴');
  }
  return meaningful;
}

/** renderPdfPageImages 的单页结果：dataUrl 成功 / error 该页失败原因（可部分成功） */
export interface RenderedPdfPage {
  dataUrl?: string;
  error?: string;
}

/**
 * 扫描件 PDF 视觉转写用：逐页渲染为 JPEG dataUrl（与照片走同一条视觉识别管线）。
 * pdfjs 画布默认透明底，先铺白再渲染，避免 JPEG 黑底。页数上限只防呆（60 页扫描件
 * 逐页识别既慢又贵，提示拆分比硬扛友好）；scale 上限 2.5 防止超大页画布爆内存。
 * 单页损坏/渲染失败只记该页 error（与照片路径逐张容错一致），不废掉已渲染的前序页。
 */
export async function renderPdfPageImages(buf: ArrayBuffer, maxPx = 2048): Promise<RenderedPdfPage[]> {
  const pdfjs = await loadPdfjs();
  let doc: Awaited<ReturnType<PdfjsModule['getDocument']>['promise']>;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  } catch {
    throw new Error('无法打开该 PDF（文件可能已损坏或设有密码保护）');
  }
  if (doc.numPages > 60) {
    await doc.destroy();
    throw new Error(`该 PDF 共 ${doc.numPages} 页，超出视觉识别上限（60 页），请拆分后再上传`);
  }
  const pages: RenderedPdfPage[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      try {
        const page = await doc.getPage(i);
        try {
          const vp1 = page.getViewport({ scale: 1 });
          const scale = Math.min(maxPx / Math.max(vp1.width, vp1.height), 2.5);
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(viewport.width);
          canvas.height = Math.round(viewport.height);
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('Canvas not supported');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvas, viewport }).promise;
          pages.push({ dataUrl: canvas.toDataURL('image/jpeg', 0.8) });
        } finally {
          page.cleanup();
        }
      } catch {
        pages.push({ error: '页面渲染失败' });
      }
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}

// ─── 噪音行清理与入口 ─────────────────────────────

/** 整行形态的页眉页脚/页码/分隔线；卷首说明（「本试卷…共10页，满分150分…」）等正文行不会命中 */
function isJunkLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/^[-—–_.\s]{3,}$/.test(t)) return true;            // 整行分隔线 / 原卷答题横线
  if (/^[-—–_.\s]*\d{1,3}[-—–_.\s]*$/.test(t)) return true; // 纯页码（含 "- 1 -"、"_ 2 _" 形态；仅一组数字，正文不误伤）
  if (/^.{0,10}?\s*(第\s*\d+\s*页\s*(?:[（(]\s*共\s*\d+\s*页\s*[）)])?|共\s*\d+\s*页)\s*[。，,\s]*$/.test(t)) return true;
  if (/^\{#[^#]*#\}$/.test(t)) return true;               // 站点水印整行（{#{QQ…}#}）：文字版 PDF/docx 混入的水印行同样剥掉
  return false;
}

export function cleanExtractedText(text: string): string {
  const kept = text.split(/\r\n?|\n/).filter((l) => !isJunkLine(l));
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export async function extractTextFromFile(file: File): Promise<string> {
  if (file.size > MAX_FILE_SIZE) throw new Error('文件过大（超过 50MB），请拆分后再上传');
  const name = file.name.toLowerCase();
  let raw: string;
  if (name.endsWith('.docx')) {
    raw = await extractDocxText(await file.arrayBuffer());
  } else if (name.endsWith('.pdf')) {
    raw = await extractPdfText(await file.arrayBuffer());
  } else if (name.endsWith('.txt') || file.type.startsWith('text/')) {
    raw = await file.text();
  } else if (name.endsWith('.doc')) {
    throw new Error('暂不支持 .doc 老格式：请先用 Word/WPS 打开并另存为 .docx 再上传');
  } else {
    throw new Error('暂不支持该文件类型（支持 .docx / .pdf / .txt）');
  }
  const cleaned = cleanExtractedText(raw);
  if (!cleaned) throw new Error('未从文件中提取到文字内容');
  return cleaned;
}
