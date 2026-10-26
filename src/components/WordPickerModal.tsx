import { useMemo, useState } from 'react';
import type { WordBankEntry } from '../utils/wordbank';
import { freqClass } from './vocabTableExtras';
import './WordPickerModal.css';

/**
 * 词库多选弹窗（R3）：字帖练写 / 插话题词等入口共用。
 * 多选 + 搜索 + 全选（作用于过滤结果），确认时回调选中词条。
 */
interface Props {
  title: string;
  hint?: string;
  entries: WordBankEntry[];
  /** 确认回调（选中的词条，按词库顺序） */
  onConfirm: (selected: WordBankEntry[]) => void;
  onClose: () => void;
}

export default function WordPickerModal({ title, hint, entries, onConfirm, onClose }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) =>
      e.word.toLowerCase().includes(q) || e.definition.toLowerCase().includes(q));
  }, [entries, query]);

  const toggle = (word: string) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(word)) n.delete(word); else n.add(word);
      return n;
    });
  };

  const allFilteredSelected = filtered.length > 0 && filtered.every((e) => selected.has(e.word));

  const toggleAllFiltered = () => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (allFilteredSelected) filtered.forEach((e) => n.delete(e.word));
      else filtered.forEach((e) => n.add(e.word));
      return n;
    });
  };

  const confirm = () => {
    const picked = entries.filter((e) => selected.has(e.word));
    if (picked.length > 0) onConfirm(picked);
  };

  return (
    <div className="wp-overlay" onClick={onClose}>
      <div className="wp-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="wp-header">
          <h3>{title}</h3>
          <button className="wp-close" onClick={onClose} aria-label="关闭">✕</button>
        </div>
        {hint && <p className="wp-hint">{hint}</p>}
        <div className="wp-toolbar">
          <input
            className="wp-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索单词 / 释义…"
          />
          <button className="wp-btn" onClick={toggleAllFiltered}>
            {allFilteredSelected ? '全不选' : '全选'}
          </button>
        </div>
        <div className="wp-list">
          {filtered.length === 0 && <p className="wp-empty">词库为空——先在「试卷词汇提取」结果页点「存入词库」，或到「词汇学案」页手动添加。</p>}
          {filtered.map((e) => (
            <label key={e.word} className={`wp-row ${selected.has(e.word) ? 'checked' : ''}`}>
              <input
                type="checkbox"
                checked={selected.has(e.word)}
                onChange={() => toggle(e.word)}
              />
              <span className="wp-word">{e.word}</span>
              {e.phonetic && <span className="wp-phonetic">{e.phonetic}</span>}
              <span className="wp-def">{e.definition.split('｜')[0]?.slice(0, 40)}</span>
              {e.examFrequency && <span className={`freq-tag ${freqClass(e.examFrequency)}`}>{e.examFrequency}</span>}
            </label>
          ))}
        </div>
        <div className="wp-footer">
          <span className="wp-count">已选 {selected.size} / {entries.length}</span>
          <div className="wp-footer-actions">
            <button className="wp-btn" onClick={onClose}>取消</button>
            <button className="wp-btn primary" onClick={confirm} disabled={selected.size === 0}>
              确定（{selected.size}）
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
