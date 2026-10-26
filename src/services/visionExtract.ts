/**
 * 试卷视觉转写管线（M2）：照片文件识别 + 转写文本的确定性清理。
 * LLM 侧 prompt 已尽量约束（examTranscribePrompt），但视觉模型有几个顽固行为
 * prompt 压不住，由这里兜底（全部在「页」边界内做，调用方知道每页的起止）：
 *  - 中文标点半角化（，→, 等）→ 按邻接汉字确定性复原（括号配对/对称回填）
 *  - 页码行（◄ 1 ► / • 6 • / ● 6 ● / 2-）→ 页首/页尾整行剥离（中途不剥：听力秃号行
 *    形态相近；页首须带装饰符，裸数字只在页尾剥——页首裸号可能是七选五空格编号）
 *  - 页尾透印残片（D.Our families' stories.）→ 前一行无英文题干/选项时丢弃；但完整
 *    选项组（A、B、C 按序）永不丢（听音选图题「(图N) + 选项行」的规范形态）
 */
import { compressImage } from './llm';

/** 照片扩展名（input accept 同步用） */
export const PHOTO_ACCEPT = '.jpg,.jpeg,.png,.webp';

export function isPhotoFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return file.type.startsWith('image/') || ['.jpg', '.jpeg', '.png', '.webp'].some((e) => name.endsWith(e));
}

/** 照片 File → 2048px JPEG dataUrl（实测 2048 长边比 1600 少一档小字误读） */
export async function photoToDataUrl(file: File): Promise<string> {
  return compressImage(file, 2048, 0.8);
}

/** 汉字（含扩展 A）——标点复原的邻接判据 */
const HAN_RE = /[㐀-䶿一-鿿]/;
/** 半角 → 全角映射（仅当与汉字相邻时启用） */
const WIDTH_MAP: Record<string, string> = {
  ',': '，', ';': '；', ':': '：', '?': '？', '!': '！', '(': '（', ')': '）',
};

/** 页码装饰符（箭头/夹线/中点/实心大圆点○/下划线/连字符；•U+2022 与 ●U+25CF 形近易漏） */
const PAGE_DECOR = '◄◀▶►\\-－—–·•●○・_';
/** 页码整行形态：可选装饰符夹一组 1–3 位数字。「1．」「1.」带分隔符的题号行不在其列
 *  （分隔符不在装饰符集），听力秃号行安全 */
const PAGE_NUM_RE = new RegExp(`^[${PAGE_DECOR}\\s]*\\d{1,3}[${PAGE_DECOR}\\s]*$`);
/** 页首页码收紧判据：必须带至少一个装饰符。完全裸数字仅页尾剥——七选五/任务型阅读的
 *  裸空格编号（「36」独行）分页恰落页首时会被光数字规则误当页码剥掉；页首漏剥只是
 *  留一行可见垃圾（用户可删），误剥是静默丢题号（宁冗勿丢） */
const PAGE_DECOR_RE = new RegExp(`[${PAGE_DECOR}]`);
/** 图片占位行（与 examGuard.ts 的 IMG_PLACEHOLDER_RE 同判据，避免循环依赖各持一份） */
const IMG_LINE_RE = /^[（([【]?\s*[图照]\s*片?\s*\d{0,2}\s*[）)\]】]?$/;
/** 页尾选项残片：A–E 标号开头的短行，且整行只有这一个标号（「D.Our families' stories.」
 *  形态）。带 B/C/D 多标号的整行是真实选项排（「A. one B. two」），不是残片 */
const isOptionFragment = (l: string): boolean =>
  /^\s*[A-E][.．、].{0,80}$/.test(l) && !/[B-E][.．、]\s*\S/.test(l.replace(/^[A-E][.．、]/, ''));

/** 半角标点复原：与汉字相邻（前后任一侧）才转全角。英文上下文（£ 19.15、17th.、
 *  7:00、food, B.Mexican）两侧均非汉字，不受影响。
 *  括号补三条：① 已复原的（在同一行内把下一个 ) 配对成 ），且句末标点/超距失效
 *  （未闭合的（不得把同行后方纯英文括号的 ) 强制复原）；② 近距扫描——括号后/前
 *  8 字符内（只跨数字/字母/百分号，遇其他括号或 CJK 标点即止）有汉字也复原，覆盖
 *  「(图1)」这类内含数字的中文括号；③ 对称回填——) 经汉字邻接复原但配对的 ( 未
 *  复原（「(2%)的」：( 的前向扫描被自身 ) 拦截）时，回填行内最近的半角 ( 成（，
 *  避免「(xxx）」半开对 */
function restoreCjkPunctuation(text: string): string {
  const nearHan = (from: number, dir: 1 | -1): boolean => {
    for (let k = 1; k <= 8; k++) {
      const idx = from + dir * k;
      if (idx < 0 || idx >= text.length || text[idx] === '\n') return false;
      const c = text[idx];
      if (HAN_RE.test(c)) return true;
      if (/[（）():：，。；、！？"'「」]/.test(c)) return false;
    }
    return false;
  };
  let out = '';
  let pendingParen = false;
  let pendingParenAt = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') { pendingParen = false; out += ch; continue; }
    // 未闭合（的失效界限：句末标点或相距过远（真括号内容不会隔一句才闭合）
    if (pendingParen && (/[。．.!！?？;；:：]/.test(ch) || i - pendingParenAt > 32)) pendingParen = false;
    const full = WIDTH_MAP[ch];
    if (!full) { out += ch; continue; }
    const prev = i > 0 ? text[i - 1] : '';
    const next = i + 1 < text.length ? text[i + 1] : '';
    const cjkAdj = HAN_RE.test(prev) || HAN_RE.test(next);
    if (ch === '(') {
      if (cjkAdj || nearHan(i, 1)) { pendingParen = true; pendingParenAt = i; out += '（'; }
      else out += ch;
      continue;
    }
    if (ch === ')') {
      if (cjkAdj || pendingParen || nearHan(i, -1)) {
        if (!pendingParen) {
          const openAt = out.lastIndexOf('(');
          if (openAt >= 0 && openAt > Math.max(out.lastIndexOf('（'), out.lastIndexOf('）'))) {
            out = out.slice(0, openAt) + '（' + out.slice(openAt + 1);
          }
        }
        pendingParen = false;
        out += '）';
      } else out += ch;
      continue;
    }
    out += cjkAdj ? full : ch;
  }
  return out;
}

/** 行是否像「能与页尾选项行构成一组的上下文」：含英文的题干/选项/正文行，或行首裸题号
 *  （听力秃号形态「3.」后跟单个选项行是真实排版）。透印残片的前一行通常是纯中文指令
 *  （听下面一段对话，回答…）或空行；题号与选项之间的「(图N)」占位行由调用方按透明跳过 */
const EN_CONTEXT_RE = /[A-Za-z]/;
const BARE_QNUM_RE = /^\d{1,2}\s*[.．、]?\s*$/;
const prevSupportsOption = (prev: string): boolean => EN_CONTEXT_RE.test(prev) || BARE_QNUM_RE.test(prev);

/** 单页转写文本清理。只动页首/页尾的页码行与选项残片，页中间一行不删（宁冗勿丢） */
export function cleanTranscribedPage(text: string): string {
  const lines = text.split(/\r\n?|\n/).map((l) => l.replace(/\s+$/, ''));
  // 页首/页尾页码行剥离（页首须带装饰符，见 PAGE_DECOR_RE 注释）
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start].trim() === '' || (PAGE_NUM_RE.test(lines[start].trim()) && PAGE_DECOR_RE.test(lines[start].trim())))) start++;
  while (end > start && (lines[end - 1].trim() === '' || PAGE_NUM_RE.test(lines[end - 1].trim()))) end--;
  let kept = lines.slice(start, end);
  // 页尾透印选项残片：回溯跳过连续的残片/空行/图片占位行，找到的首个实质行不含英文
  // 也不是裸题号（纯中文指令/空行）才丢；一行一行弹，每弹一行重新评估（残片堆可整体退净）
  while (kept.length > 0) {
    const last = kept[kept.length - 1].trim();
    if (last === '' || !isOptionFragment(last)) break;
    // 完整选项组护栏：堆内标号按 A 起序且 ≥2 个（A、B、C…）必是真题选项——听音选图/
    // 带图小题的规范转写就是「题号 + (图N) + A/B/C 各一行」，前邻占位行/纯中文指令时
    // 也绝不当残片弹（透印残片按观测是孤立单行/缺 A 的断尾；宁冗勿丢）
    const labels: string[] = [];
    let k = kept.length - 1;
    while (k >= 0) {
      const t = kept[k].trim();
      if (t === '' || IMG_LINE_RE.test(t)) { k--; continue; }
      if (!isOptionFragment(t)) break;
      labels.push(t[0]);
      k--;
    }
    const uniq = [...new Set(labels)].reverse().join('');
    if (uniq.length >= 2 && uniq.startsWith('A')) break;
    const prev = k >= 0 ? kept[k].trim() : '';
    if (prevSupportsOption(prev)) break;
    kept = kept.slice(0, kept.length - 1);
  }
  return restoreCjkPunctuation(kept.join('\n'))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 多页转写合并：过滤空页，页间空行分隔 */
export function joinTranscribedPages(pages: readonly string[]): string {
  return pages.filter((p) => p && p.trim()).map((p) => p.trim()).join('\n\n');
}
