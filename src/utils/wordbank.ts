import type { VocabItem } from '../types';

/**
 * 共享词库（M3 词表二次生命）：localStorage 里的跨工具资产。
 * 词汇提取的 VocabItem 是全站最高质量的结构化数据——词库让应用文（话题词）、
 * 字帖（练写内容）、配套材料（默写卷/闪卡/Anki）都能复用它。
 */

const KEY = 'vb_wordbank';

export interface WordBankEntry {
  word: string;
  phonetic: string;
  definition: string;
  collocations: string;
  memoryAid: string;
  examFrequency: string;
  originalSentence: string;
  extraExample: string;
  /** 来源题型（如「阅读理解 B」），仅作展示 */
  sectionName?: string;
  /** 加入时间 ISO */
  addedAt: string;
}

export function listWords(): WordBankEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveAll(entries: WordBankEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    // 存储满：静默失败（词库是锦上添花，不阻塞主流程）
  }
}

/** 批量存入（按 word 去重，后存覆盖先存的同词条目）。返回 [新增数, 词库总数]。 */
export function addWords(items: Array<Partial<VocabItem> & { word: string }>): [number, number] {
  const entries = listWords();
  const byWord = new Map(entries.map((e) => [e.word.toLowerCase(), e]));
  let added = 0;
  for (const item of items) {
    const w = item.word?.trim();
    if (!w) continue;
    const existed = byWord.get(w.toLowerCase());
    if (!existed) added += 1;
    byWord.set(w.toLowerCase(), {
      word: w,
      phonetic: item.phonetic ?? '',
      definition: item.definition ?? '',
      collocations: item.collocations ?? '',
      memoryAid: item.memoryAid ?? '',
      examFrequency: item.examFrequency ?? '',
      originalSentence: item.originalSentence ?? '',
      extraExample: item.extraExample ?? '',
      sectionName: item.sectionName,
      addedAt: existed?.addedAt ?? new Date().toISOString(),
    });
  }
  const next = Array.from(byWord.values());
  saveAll(next);
  return [added, next.length];
}

export function removeWord(word: string): void {
  saveAll(listWords().filter((e) => e.word.toLowerCase() !== word.toLowerCase()));
}

export function clearWords(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

/** 取英文练写行（字帖用）：优先例句（去掉 ** 加粗与尾部中文），无例句用词条本身，cap 限量。 */
export function copybookLines(limit = 30): string[] {
  const lines: string[] = [];
  for (const e of listWords()) {
    if (lines.length >= limit) break;
    const sentence = e.originalSentence?.replace(/\*\*/g, '').replace(/（[^）]*）\s*$/g, '').trim();
    const extra = e.extraExample?.replace(/\*\*/g, '').replace(/（[^）]*）\s*$/g, '').trim();
    const line = sentence || extra || e.word;
    if (line && !lines.includes(line)) lines.push(line);
  }
  return lines;
}

/** 编辑词条（按 word 定位，打补丁）。返回是否存在。 */
export function updateWord(word: string, patch: Partial<WordBankEntry>): boolean {
  const entries = listWords();
  let found = false;
  const next = entries.map((e) => {
    if (e.word.toLowerCase() !== word.toLowerCase()) return e;
    found = true;
    return { ...e, ...patch, word: patch.word ?? e.word };
  });
  if (found) saveAll(next);
  return found;
}

/** 删除多个词条。 */
export function removeWords(words: string[]): void {
  const lower = new Set(words.map((w) => w.toLowerCase()));
  saveAll(listWords().filter((e) => !lower.has(e.word.toLowerCase())));
}

/** 单个词条 → 英文练写行（字帖用）：优先例句（去加粗与尾部中文），无例句用词条本身。 */
export function entryToCopybookLine(e: WordBankEntry): string {
  const sentence = e.originalSentence?.replace(/\*\*/g, '').replace(/（[^）]*）\s*$/g, '').trim();
  const extra = e.extraExample?.replace(/\*\*/g, '').replace(/（[^）]*）\s*$/g, '').trim();
  return sentence || extra || e.word;
}

// ─── 跨 tab 交接：词库 → 字帖（多选练写词）────────────

let pendingCopybookText: string | null = null;

/** 词库 tab 把选好的练写内容交给字帖 tab（App 切 tab 后由 Copybook 取走）。 */
export function handOffToCopybook(text: string): void {
  pendingCopybookText = text;
}

/** Copybook 挂载时取走交接内容（取一次即清空）。 */
export function takeCopybookHandoff(): string | null {
  const t = pendingCopybookText;
  pendingCopybookText = null;
  return t;
}
