/**
 * 附录答案回填：LLM 大纲识别出的文末答案附录单独解析成 {number, answer} 清单后，
 * 按题号回填正文各题（绝不覆盖正文已有答案）。与切块/组卷管线完全解耦——
 * 回填只动 q.answer，hasAnyAnswer 自动点亮导出的参考答案页。
 */
import type { ExamQuestion, ExamSection } from '../types';

/** 附录标题是否为「答案类」（可结构化提取回填）；听力材料/听力原文类不算（无可回填答案，维持粘卷尾） */
export function isAnswerAppendix(label: string): boolean {
  return /答案|解析/.test(label) && !/听力/.test(label);
}

/** 语法填空正文里的空位编号两种版式：___56___ / __35__（数字在横线内，横线 2 条起——
 *  OCR 文本常是两条下划线，`__{2,}` 的语义是 3 条起会漏）与行首 "56. ______"（题号在横线外） */
const STEM_BLANK_NUM_INLINE_RE = /_{2,}\s*(\d{1,3})\s*_{2,}/g;
const STEM_BLANK_NUM_LEAD_RE = /(?:^|\n)\s*(\d{1,3})\s*[.、]?\s*_{2,}/g;

/** 答案清单条目（buildExamAnswerKeyPrompt 输出的 questions，answer 填入 number 对应题） */
export type AnswerKeyEntry = Omit<ExamQuestion, 'id'>;

export interface AnswerMergeOptions {
  /** 试卷大题块是否完整（无解析失败块）。同号重复的按序消耗依赖完整卷面——不完整时
   *  同号题跳过自动回填（防前一同号大题缺位后整体左移串块），留待失败块重试补齐后整卷重放 */
  complete?: boolean;
}

/** 题号归一：抽取数字（"56"、"56." → "56"）。LLM 偶发输出裸数字 JSON，先 String 防抛错 */
function normNumber(n: unknown): string {
  return String(n ?? '').replace(/\D/g, '');
}

/** 未展开的区间题号（"1-5 BACCA" 整条漏展开）：归一会变 "15" 冒充真 15 题，直接丢弃。
 *  连字符放字符类首位作字面量（放中间会与 U+2010/U+2013 组成范围，ASCII '-' 反而不在内） */
const RANGE_DASH_RE = /[-‐‑–—~～]/;

/** 答案字符串里的学科网水印串（可能与答案粘连在同一行，PDF 文字层逐 item 拼接所致） */
const ANSWER_WATERMARK_RE = /\{#[^#]*#\}/g;

export interface AnswerMergeResult {
  /** 回填后的 sections（不可变更新；未命中的 section 原引用返回） */
  merged: ExamSection[];
  /** 回填成功的题数 */
  filled: number;
  /** key 中未能回填的条目数（含与正文答案冲突的：冲突保正文） */
  unmatched: number;
}

/** 从语篇正文收集空位号（两种版式并集，升序去重） */
function collectBlankNums(stem: string): string[] {
  const nums = new Set<string>();
  for (const m of stem.matchAll(STEM_BLANK_NUM_INLINE_RE)) nums.add(m[1]);
  for (const m of stem.matchAll(STEM_BLANK_NUM_LEAD_RE)) nums.add(m[1]);
  return [...nums].sort((a, b) => Number(a) - Number(b));
}

/**
 * 按题号把答案清单回填进试卷各题：
 * - 选择/单句填空/写作等有题号的题：number 归一后精确匹配，命中且答案为空才回填
 *   （正文已有答案 = 冲突，保正文，计入 unmatched）。同号重复按 key 顺序逐条消耗——
 *   各大题重新编号的卷子（单选 1-10 + 完形 1-10，附录按大题分块重复 1-10）不会把
 *   单选答案串进同号完形：试卷顺序消耗第 1 块，第 2 块留给下一个大题。
 * - 语法填空（type=blank、number=""）：从 stem 收集空位号，key 中号能对上的条目
 *   按号升序拼成 "56. exploring  57. was carried"（与解析 prompt 的 answer 格式一致）。
 * - 七选五：空位号只存在于前一 passage 正文（___35___），选项块（choice、number=""、
 *   stem=""、options≥5）承接 key 条目拼成 "35. F 36. B …"，答案页流式行渲染。
 * 不可变更新：未变的 section / question 保持原引用。
 */
export function mergeAnswerKey(
  sections: readonly ExamSection[],
  key: readonly AnswerKeyEntry[],
  opts: AnswerMergeOptions = {},
): AnswerMergeResult {
  // key 条目按出现顺序建索引（同号 → 索引数组）；空号/空答案/未展开区间条目无法回填，不入索引。
  // answer 里的水印串先剥掉（prompt 允许删水印，这里兜底保证不进卷面）。
  // 前提声明：同号分块消耗假设附录块序 = 卷面大题序（学科网附录均按卷序排，实测成立）
  const entries = key
    .map((e) => {
      const raw = String(e?.number ?? '');
      if (RANGE_DASH_RE.test(raw)) return null;
      return { n: normNumber(raw), answer: String(e?.answer ?? '').replace(ANSWER_WATERMARK_RE, '').trim() };
    })
    .filter((e): e is { n: string; answer: string } => !!e && !!e.n && !!e.answer);
  const byNumber = new Map<string, number[]>();
  entries.forEach((e, i) => {
    const arr = byNumber.get(e.n);
    if (arr) arr.push(i); else byNumber.set(e.n, [i]);
  });
  // 不完整卷面（有解析失败块）：同号题的按序消耗会因缺位整体左移串块——这些号跳过自动回填
  const ambiguous = new Set<string>();
  if (opts.complete === false) {
    for (const [n, arr] of byNumber) if (arr.length > 1) ambiguous.add(n);
    const paperCount = new Map<string, number>();
    for (const sec of sections) {
      for (const q of sec.questions) {
        const n = normNumber(q.number);
        if (n) paperCount.set(n, (paperCount.get(n) ?? 0) + 1);
      }
    }
    for (const [n, c] of paperCount) if (c > 1) ambiguous.add(n);
  }
  const consumed = new Set<number>(); // 已消耗的条目索引（命中回填或冲突占位）
  let landed = 0; // 真正写进题里的条目数（冲突占位不算 landed，计 unmatched）
  let filled = 0;
  /** 取该号第一个未消耗条目（同号按 key 顺序逐个消耗），无则 null */
  const take = (n: string): { answer: string } | null => {
    if (ambiguous.has(n)) return null;
    const idxs = byNumber.get(n);
    if (!idxs) return null;
    const idx = idxs.find((i) => !consumed.has(i));
    if (idx === undefined) return null;
    consumed.add(idx);
    return entries[idx];
  };
  /** 冲突占位：把该组号对应的条目消耗掉但不回填（保持后续同号块的消耗对齐） */
  const consumeOnly = (nums: readonly string[]) => {
    for (const n of nums) take(n);
  };

  const mergedSections = sections.map((sec) => {
    let sectionChanged = false;
    const questions = sec.questions.map((q, qi) => {
      const qn = normNumber(q.number);
      if (q.type === 'blank' && !qn && q.stem) {
        // 语法填空：stem 空位号收集（升序去重）；正文已有答案 = 冲突保正文（占位维持对齐）
        const nums = collectBlankNums(q.stem);
        if ((q.answer ?? '').trim()) { consumeOnly(nums); return q; }
        const parts: string[] = [];
        for (const n of nums) {
          const e = take(n);
          if (!e) continue;
          parts.push(`${n}. ${e.answer}`);
          landed += 1;
        }
        if (parts.length === 0) return q;
        sectionChanged = true;
        filled += 1;
        return { ...q, answer: parts.join('  ') };
      }
      // 七选五选项块：空位号在前一 passage 正文里，key 条目拼进本块 answer
      if (q.type === 'choice' && !qn && (q.stem ?? '').trim() === '' && (q.options?.length ?? 0) >= 5) {
        const prev = sec.questions[qi - 1];
        const nums = prev?.type === 'passage' ? collectBlankNums(prev.stem ?? '') : [];
        if ((q.answer ?? '').trim()) { consumeOnly(nums); return q; }
        const parts: string[] = [];
        for (const n of nums) {
          const e = take(n);
          if (!e) continue;
          parts.push(`${n}. ${e.answer}`);
          landed += 1;
        }
        if (parts.length === 0) return q;
        sectionChanged = true;
        filled += 1;
        return { ...q, answer: parts.join('  ') };
      }
      if (!qn) return q;
      const e = take(qn);
      if (!e) return q;
      if ((q.answer ?? '').trim()) return q; // 冲突：保正文（条目已消耗占位，计 unmatched）
      sectionChanged = true;
      filled += 1;
      landed += 1;
      return { ...q, answer: e.answer };
    });
    return sectionChanged ? { ...sec, questions } : sec;
  });

  return { merged: mergedSections, filled, unmatched: entries.length - landed };
}
