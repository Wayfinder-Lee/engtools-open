/**
 * LLM 大纲切块定位：把大纲返回的 {name, startMark} 锚点逐字定位回全文，
 * 相邻锚点之间的文本即为各大题块。定位失败的锚点跳过（宁缺勿错）；
 * 定位质量不足（数量/覆盖率不达标）时整份大纲弃用，由调用方回退正则切块。
 */
import type { ExamOutlineAppendix, ExamOutlineSection, Stage } from '../types';
import type { Section } from './sectionParser';
import { canonicalSectionName } from './sectionParser';
import { scanStructuralLines } from './examStructure';

/** 去-空白模糊定位：原文与锚点都忽略空白逐字符比对（PDF 复制常把空格变换行） */
function fuzzyIndex(text: string, mark: string, from: number): number {
  const m = mark.replace(/\s+/g, '');
  if (m.length < 4) return -1;
  for (let i = from; i < text.length; i++) {
    if (/\s/.test(text[i])) continue;
    let ti = i;
    let mi = 0;
    while (ti < text.length && mi < m.length) {
      if (/\s/.test(text[ti])) { ti++; continue; }
      if (text[ti] !== m[mi]) break;
      ti++;
      mi++;
    }
    if (mi === m.length) return i;
  }
  return -1;
}

/** mark 的全部出现位置（精确匹配，升序；上限 12 个防病态重复文本拖垮扫描） */
function allOccurrences(text: string, mark: string): number[] {
  const out: number[] = [];
  let from = 0;
  while (out.length < 12) {
    const idx = text.indexOf(mark, from);
    if (idx < 0) break;
    out.push(idx);
    from = idx + 1;
  }
  return out;
}

/** 泛指令行开头（「阅读下面的材料…」「根据短文内容…」「听下面…」）：这些行属于
 *  其后的大题，回退/劈块守卫据此把它们随正文块走 */
const GENERIC_INSTR_RE = /^(?:阅读下[面列]|听下[面列]|根据[所其]?[给下]|从下[面列])/;

// ─── 附录定位（常量/正则从 ExamPaper.tsx 迁来，单一来源；正则 findAppendix 与 LLM locateAppendices 共用守卫） ───

/** 附录至少要出现在全文后 40%（卷首「参考答案见文末」等提及行不触发），且截断后必须还留有正文 */
export const APPENDIX_MIN_POS = 0.4;
export const APPENDIX_MIN_KEEP = 200;
/** 附录标题行长度上限：标题行基本整行就是标题；学案类每题后整行「答案与解析：…」是正文解释，不截 */
export const APPENDIX_MAX_LINE = 50;

/** 文档末尾常附「参考答案/答案详解/听力材料」等非试题部分；从首个此类标题行（行首短前缀 + 标题词，允许「听力材料（Text 1-10）」等尾缀）截断 */
const APPENDIX_RE = /^.{0,20}?\s*[（(]?\s*(参考答案|答案速查|答案详解|答案与解析|答案及解析|听力材料|听力原文)/gm;
/** 行尾「答案」标题（「南高高二期中英语答案」）：仅当答案为行末词（可带括号/冒号尾缀）才命中，正文「答案是C。」不误伤 */
const ANSWER_TITLE_RE = /^.{0,12}?答案(?:[（(][^）)\n]{1,10}[）)])?[：:]?\s*$/gm;

/** 正则附录检测结果 */
export interface FoundAppendix { index: number; label: string; }

/** 取 pos 所在行（trim）：按标题词在文内的实际字符位取行。不能按 m.index 取——
 *  APPENDIX_RE 的 `^.{0,20}?\s*` 会跨行桥接（命中词在下一行时 m.index 落在上一行行首），
 *  m.index 取行会被前一行短内容（「Yours, Li Hua」/页脚/注意事项）劫持 */
function lineOfChar(text: string, pos: number): string {
  const ls = text.lastIndexOf('\n', pos - 1) + 1;
  const nl = text.indexOf('\n', pos);
  return text.slice(ls, nl < 0 ? text.length : nl).trim();
}

/** 两类附录标题的所有命中中，取通过位置守卫的最靠前者（早处误命中不应掩盖文末真附录） */
export function findAppendix(text: string): FoundAppendix | null {
  const hits: FoundAppendix[] = [];
  for (const re of [APPENDIX_RE, ANSWER_TITLE_RE]) {
    for (const m of text.matchAll(re)) {
      if (m.index === undefined) continue;
      // 标题词的精确字符位：APPENDIX_RE 的捕获组在 match 末尾；ANSWER_TITLE_RE 无捕获组，
      // 取 match 内最后一个「答案」。label 取词所在行完整内容而非只取词本身——组合标题
      // 「参考答案及听力原文」里的「听力」字样必须在 label 里可见；
      // index 对齐到该行行首（跨行桥接时 m.index 落在前一行，直接用会把前一行切进正文/附录）
      const rel = m[1] ? m[0].length - m[1].length : m[0].lastIndexOf('答案');
      const wordPos = m.index + (rel >= 0 ? rel : 0);
      const line = lineOfChar(text, wordPos);
      hits.push({ index: text.lastIndexOf('\n', wordPos - 1) + 1, label: line || m[1] || '答案' });
    }
  }
  const valid = hits.filter((h) => {
    if (h.index < text.length * APPENDIX_MIN_POS) return false;
    if (text.slice(0, h.index).trim().length < APPENDIX_MIN_KEEP) return false;
    // 标题行必须短（独立标题行），排除正文里的「答案与解析：…」解释行
    return h.label.length > 0 && h.label.length <= APPENDIX_MAX_LINE;
  });
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => (a.index <= b.index ? a : b));
}

export function stripAnswerAppendix(text: string): string {
  const hit = findAppendix(text);
  return hit ? text.slice(0, hit.index).trimEnd() : text;
}

/** LLM appendices 锚点定位回全文的结果 */
export interface LocatedAppendix {
  index: number;
  label: string;
}

/**
 * LLM 大纲识别出的文末附加部分锚点定位回全文：每条 mark 精确（空则模糊）定位，
 * 候选逐个过与正则 findAppendix 同一套守卫（≥40% 位置 / 截断前 ≥200 字 / 命中行 ≤50 字），
 * 取最靠前通过者；幻觉锚点（定位不到或全部被守卫拒绝）该条丢弃。
 * 条目按 index 升序去重（差 <4 视同处）。返回 [] = 未检出，调用方维持正则行为。
 */
export function locateAppendices(text: string, appendices: readonly ExamOutlineAppendix[]): LocatedAppendix[] {
  const hits: LocatedAppendix[] = [];
  for (const ap of appendices) {
    const mark = (ap?.startMark ?? '').trim();
    const label = String(ap?.label ?? '').trim() || mark;
    if (mark.length < 2) continue;
    let occ = allOccurrences(text, mark);
    if (occ.length === 0) {
      const fz = fuzzyIndex(text, mark, 0);
      if (fz < 0) continue; // 幻觉锚点：条目丢弃
      occ = [fz];
    }
    let chosen: number | null = null;
    for (const idx of occ) {
      if (idx < text.length * APPENDIX_MIN_POS) continue;
      if (text.slice(0, idx).trim().length < APPENDIX_MIN_KEEP) continue;
      const ls = text.lastIndexOf('\n', idx - 1) + 1;
      const nl = text.indexOf('\n', idx);
      const line = text.slice(ls, nl < 0 ? text.length : nl).trim();
      if (line.length === 0 || line.length > APPENDIX_MAX_LINE) continue;
      chosen = idx;
      break;
    }
    if (chosen !== null) hits.push({ index: chosen, label });
  }
  hits.sort((a, b) => a.index - b.index);
  const out: LocatedAppendix[] = [];
  for (const h of hits) {
    const prev = out[out.length - 1];
    if (prev && h.index - prev.index < 4) continue; // 同一附录块的多条锚点
    out.push(h);
  }
  return out;
}

/** 大纲锚点数下限：少于 2 个不构成"切块" */
const MIN_SECTIONS = 2;
/** 锚点切出的内容总长须占全文 2/3 以上（防 LLM 只标了头部几个大题） */
const MIN_COVERAGE = 0.66;
/** 单块内容最短长度（太短的块多为误锚点） */
const MIN_BODY = 30;

/** 短块并入前块前剥掉其中的结构行（卷/部分/节标题）：被并入的大题已不复存在，
 *  其结构行随正文进宿主块会污染头部归属（宿主 partTitle 被更长标题覆盖、
 *  节行把宿主 content 切成两个宿主名段） */
function stripStructural(body: string): string {
  const drop = new Set(scanStructuralLines(body).map((h) => h.line));
  if (drop.size === 0) return body;
  return body.split('\n').filter((l) => !drop.has(l.trim())).join('\n').trim();
}

/** 切片尾部的卷/部分/节结构行属于下一大题的头部（下一锚定在其正文首句时，其标题行
 *  会落在本切片尾部）：从尾部剥掉，enrichSections 的前隙归属会把它们挂给下一块，
 *  避免错挂本块 partTitle */
function trimTrailingStructural(body: string): string {
  const lines = body.split('\n');
  let end = lines.length;
  while (end > 0) {
    const t = lines[end - 1].trim();
    if (t === '' || scanStructuralLines(t).some((h) => h.line === t)) { end -= 1; continue; }
    break;
  }
  return lines.slice(0, end).join('\n');
}

export function locateOutline(text: string, outline: readonly ExamOutlineSection[], stage: Stage): Section[] | null {
  if (!Array.isArray(outline) || outline.length < MIN_SECTIONS) return null;
  const trimmedText = text.trim();

  // 1) 收集各锚点 startMark 的全部出现位置（精确优先；全无精确命中再退化到首个模糊命中）。
  //    重复文本（如每个阅读篇前都重复的选篇指令句）靠多次出现区分先后篇目
  const raw: { name: string; mark: string; occ: number[] }[] = [];
  for (const sec of outline) {
    const mark = (sec?.startMark ?? '').trim();
    if (mark.length < 4) continue;
    let occ = allOccurrences(text, mark);
    if (occ.length === 0) {
      const fz = fuzzyIndex(text, mark, 0);
      if (fz < 0) continue; // 定位失败：跳过该大题，其余锚点继续
      occ = [fz];
    }
    raw.push({ name: String(sec.name ?? '').trim(), mark, occ });
  }
  if (raw.length < MIN_SECTIONS) return null;

  // 2) 按大纲顺序分配出现位置：重复文本（每个阅读篇前重复的选篇指令句）靠「位置递增 +
  //    位置认领制」区分先后篇目。靠前出现若未被任何前序锚点认领（前序锚点因大纲把相邻
  //    两题顺序写反而越过了它），优先取靠前出现——靠后出现多为页眉整行重复的部分标题，
  //    追它会吞掉本大题正文；第 5 步按卷面位置排序自然校正顺序。
  //    认领按「位置是否已被占」判定，而非「是否被同 mark 占」：孪生 mark（一字符之差的
  //    指令句变体，各自都能命中两处出现）若按 mark 身份判定会把彼此的占位当空位，双双
  //    抢到同一处出现，另一篇正文被静默吞掉。
  //    页眉守卫：earlier 候选若落在卷/部分结构行且非本 mark 首处出现 = 页眉整行重复的
  //    部分标题（真起点 occ[0] 已被孪生/同 mark 前序锚认领时才会轮到靠后出现）——追它
  //    会把块界切到页顶、拦腰切开上一题组；此时回到已认领的本 mark 出现位（同位，交
  //    第 3 步去重合并），无认领宿主则改走 forward
  const assigned: { name: string; start: number }[] = [];
  const claimed = new Set<number>(); // 已被认领的出现位置
  let lastPos = -1;
  const isPartLineAt = (p: number): boolean => {
    const nl = text.indexOf('\n', p);
    const line = text.slice(p, nl < 0 ? text.length : nl).trim();
    return scanStructuralLines(line).some((h) => h.type === 'volume' || h.type === 'part');
  };
  for (const a of raw) {
    const forward = a.occ.find((p) => p > lastPos);
    let earlier = a.occ.find((p) => p <= lastPos && !claimed.has(p));
    const isHeaderRepeat = (p: number) => p !== a.occ[0] && isPartLineAt(p);
    if (earlier !== undefined && isHeaderRepeat(earlier)) {
      const host = [...claimed].find((p) => a.occ.includes(p));
      if (host !== undefined) earlier = host;
      else if (forward !== undefined && !isHeaderRepeat(forward)) earlier = undefined;
    }
    let start: number;
    if (earlier !== undefined) start = earlier;
    else start = forward ?? a.occ[a.occ.length - 1];
    claimed.add(start);
    assigned.push({ name: a.name, start });
    lastPos = Math.max(lastPos, start);
  }

  // 3) 原始位置相同的锚去重（LLM 复制粘贴出重复 startMark 时只留一个）；
  //    去重优先权只授予 canonicalSectionName 会保留字母的名字（[A-D]）：带篇目
  //    标号比泛称「阅读理解」更具体；E 在 canonical 中会降级泛称，让 E 名抢占真实
  //    题型名（如七选五）只会丢 hint 不带来精度（第 4 步字母行回退仍用全量
  //    readingLetter [A-E]，不受影响）
  const dedupLetter = (n: string): string | null => {
    const m = n.replace(/\s+/g, '').match(/^阅读理解[（([]?([A-D])[）)]?篇?$/);
    return m ? m[1] : null;
  };
  const byStart = new Map<number, { name: string; start: number }>();
  for (const a of assigned) {
    const prev = byStart.get(a.start);
    if (!prev || (dedupLetter(a.name) !== null && dedupLetter(prev.name) === null)) byStart.set(a.start, a);
  }
  const anchors = [...byStart.values()];
  if (anchors.length < MIN_SECTIONS) return null;

  // 4) 前导结构回退（原「篇目字母行回退」的泛化）：锚点落在正文首句/指令行时，其上方的
  //    部分标题、节标题、泛指令句（阅读下面的材料…）、篇目字母行仍是本大题的头部——
  //    逐行向上回退把块起点移到这些行（随本块 content 走，enrichSections 会剥离开头
  //    结构行挂回本块 partTitle/subHeaders；泛指令行随正文交给逐块 LLM 归入 instruction），
  //    避免部分标题丢失、节标题错挂上一大题或字母行残留上一块尾部。遇实内容即停；
  //    最多回退 6 行；不得越过前一锚点（按卷面序）的起点。
  //    在去重之后做：回退产生的位移不能绕过同位去重
  anchors.sort((a, b) => a.start - b.start);
  const lineStartOf = (idx: number, lines: string[]): number =>
    lines.slice(0, idx).join('\n').length + (idx > 0 ? 1 : 0);
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    const before = text.slice(0, a.start).split('\n');
    let k = before.length - 2; // 末元素是锚点行的前缀，从上一完整行找起
    let walked = 0;
    let top = -1;
    const minStart = i > 0 ? anchors[i - 1].start : 0;
    while (k >= 0 && walked < 6) {
      const t = before[k].trim();
      if (t !== '' && !(scanStructuralLines(t).some((h) => h.line === t)
        || /^[A-E][.．、]?$/.test(t)
        || GENERIC_INSTR_RE.test(t))) break;
      if (lineStartOf(k, before) <= minStart) break; // 前锚的内容一行也不能吞
      top = k;
      k -= 1;
      walked += 1;
    }
    if (top >= 0) a.start = lineStartOf(top, before);
  }

  let sections: Section[] = [];
  // 切片从锚点本身开始（含锚文本）：标题锚由 enrichSections 从 content 剥离并挂回头部字段，
  // 误锚在正文中间时锚文本不丢；超短切片（误锚碎片）剥掉结构行后并入前块而非丢弃
  let pendingPrefix = '';
  for (let i = 0; i < anchors.length; i++) {
    const contentStart = anchors[i].start;
    const contentEnd = i + 1 < anchors.length ? anchors[i + 1].start : text.length;
    const body = trimTrailingStructural(text.slice(contentStart, contentEnd).trim());
    if (body.length === 0) continue;
    if (body.length < MIN_BODY) {
      // 首行即卷/部分/节结构行 = 真实存在的大题只是内容短（如写作题干一句）：保留独立块，
      // 不并入前块——并入会让其标题行经 enrichSections 的尾隙归属错挂宿主 partTitle
      const firstLine = body.split('\n').find((l) => l.trim())?.trim() ?? '';
      const startsWithHeader = firstLine !== '' && scanStructuralLines(firstLine).some((h) => h.line === firstLine);
      if (!startsWithHeader) {
        if (sections.length > 0) {
          const merged = stripStructural(body);
          if (merged) {
            const last = sections[sections.length - 1];
            sections[sections.length - 1] = { ...last, content: `${last.content}\n\n${merged}` };
          }
        } else {
          // 首锚之前的卷首区域原样并入首块（其中的卷/部分行由 enrichSections 正确挂回首块头部）
          pendingPrefix = pendingPrefix ? `${pendingPrefix}\n\n${body}` : body;
        }
        continue;
      }
      // 结构行开头：按正常块保留（落到下方 push）
    }
    const name = canonicalSectionName(anchors[i].name, stage) || '大题';
    sections.push({ name, content: pendingPrefix ? `${pendingPrefix}\n\n${body}` : body });
    pendingPrefix = '';
  }
  if (pendingPrefix && sections.length > 0) {
    const first = sections[0];
    sections[0] = { ...first, content: `${pendingPrefix}\n\n${first.content}` };
  }
  // 合法性检查在合并守卫之前：合并可能把两块并成一块，不应让整份大纲跌破下限被弃用
  if (sections.length < MIN_SECTIONS) return null;

  // 6) 劈块合并守卫：LLM 偶尔把同一大题拆成两个锚（节标题行 + 材料/故事首句），前一块
  //    只剩结构行与泛指令句的空壳 preamble——并入后块恢复单块（结构行经 enrichSections
  //    挂后块头部字段、指令行随后块正文走逐块 LLM，内容不丢）。判定从紧：非结构余行 ≤2、
  //    每行 ≤80 字符、不含 6 连拉丁字母（英文正文必含）且均为泛指令行开头——真实大题
  //    的题干/材料不会全部由泛指令短句构成。
  const isGhostPreamble = (content: string): boolean => {
    const drop = new Set(scanStructuralLines(content).map((h) => h.line));
    const rest = content.split('\n').map((l) => l.trim()).filter((l) => l && !drop.has(l));
    return rest.length > 0 && rest.length <= 2
      && rest.every((l) => l.length <= 80 && !/[A-Za-z]{6}/.test(l) && GENERIC_INSTR_RE.test(l));
  };
  const merged: Section[] = [];
  for (const sec of sections) {
    const prev = merged[merged.length - 1];
    if (prev && isGhostPreamble(prev.content)) {
      merged[merged.length - 1] = {
        name: sec.name === '大题' ? prev.name : sec.name,
        content: `${prev.content}\n\n${sec.content}`,
      };
    } else {
      merged.push(sec);
    }
  }
  sections = merged;

  const covered = sections.reduce((acc, s) => acc + s.content.length, 0);
  if (covered < trimmedText.length * MIN_COVERAGE) return null;
  return sections;
}
