import { addWords, listWords } from '../utils/wordbank';
import { exportDictationSheetDocx, exportFlashcardsDocx, exportAnkiTsv } from '../services/docxExport';

/**
 * VocabTable 的词库/配套材料/频次筛选辅助（M3/M4）。
 * 单独成文件：避免 VocabTable ↔ docxExport / wordbank 的职责纠缠，
 * 也让筛选逻辑可以独立测试。
 */

export { addWords, listWords, exportDictationSheetDocx, exportFlashcardsDocx, exportAnkiTsv };

// ─── M4：考试频次筛选 ───────────────────────────────
// examFrequency 取值：★★★★☆ 等星级串，或 ⚪（潜在考点）/空（未标注）

export type FreqFilter = 'all' | 'high' | 'mid' | 'low' | 'potential';

export const FREQ_FILTERS: { key: FreqFilter; label: string; title: string }[] = [
  { key: 'all', label: '全部', title: '不过滤' },
  { key: 'high', label: '★★★★+', title: '高频词' },
  { key: 'mid', label: '★★★', title: '中频词' },
  { key: 'low', label: '★★-', title: '低频词' },
  { key: 'potential', label: '⚪ 潜在', title: '潜在考点 / 未标注' },
];

export function starCount(freq: string | undefined): number {
  if (!freq) return -1;
  return (freq.match(/★/g) ?? []).length;
}

export function isPotential(freq: string | undefined): boolean {
  return !freq || !/★/.test(freq);
}

/** 按频次过滤；'all' 原样返回。（泛型：词库条目与 VocabItem 共用） */
export function filterByFreq<T extends { examFrequency?: string }>(list: T[], filter: FreqFilter): T[] {
  if (filter === 'all') return list;
  return list.filter((item) => {
    const stars = starCount(item.examFrequency);
    switch (filter) {
      case 'high': return stars >= 4;
      case 'mid': return stars === 3;
      case 'low': return stars >= 0 && stars <= 2 && !isPotential(item.examFrequency);
      case 'potential': return isPotential(item.examFrequency);
      default: return true;
    }
  });
}

/** 频次徽标的语义类名（表格标签列着色用）。 */
export function freqClass(freq: string | undefined): string {
  if (isPotential(freq)) return 'freq-potential';
  const stars = starCount(freq);
  if (stars >= 4) return 'freq-high';
  if (stars === 3) return 'freq-mid';
  return 'freq-low';
}
