import { useEffect, useMemo, useState } from 'react';
import type { ApiConfig, ClozeItem, Stage } from '../types';
import { VOCAB_DEFAULT_MODEL } from '../types';
import { generateCloze } from '../services/llm';
import { buildClozePrompt } from '../prompts/vocabExtraction';
import { getEffectiveModel } from '../utils/model';
import {
  listWords, addWords, removeWord, removeWords, updateWord,
  entryToCopybookLine, handOffToCopybook, type WordBankEntry,
} from '../utils/wordbank';
import { exportDictationSheetDocx, exportClozeSheetDocx } from '../services/docxExport';
import { freqClass, type FreqFilter, FREQ_FILTERS, filterByFreq } from './vocabTableExtras';
import { useCostGate } from './CostGate';
import ErrorBar from './ErrorBar';
import { track } from '../utils/analytics';
import { Icon } from './icons';
import './WordBank.css';

/**
 * 共享词库管理页（R2）：跨工具资产的入口。
 * 增删改词条 + 多选 → 生成词汇检测（语法填空式，LLM）/ 导出默写卷 / 去字帖练写。
 */
interface Props {
  apiConfig: ApiConfig;
  stage: Stage;
  /** 登录/游客当前余额；null = 自带 Key 模式 */
  quota?: number | null;
  /** 「去字帖练写」时由 App 切到字帖 tab */
  onGoCopybook: () => void;
}

interface EditDraft { word: string; phonetic: string; definition: string }

export default function WordBank({ apiConfig, stage, quota, onGoCopybook }: Props) {
  const [entries, setEntries] = useState<WordBankEntry[]>(listWords);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [freqFilter, setFreqFilter] = useState<FreqFilter>('all');
  const [editingWord, setEditingWord] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft>({ word: '', phonetic: '', definition: '' });
  const [newWord, setNewWord] = useState('');
  const [newDefinition, setNewDefinition] = useState('');
  const [newPhonetic, setNewPhonetic] = useState('');
  const [error, setError] = useState('');
  const [checkItems, setCheckItems] = useState<ClozeItem[] | null>(null);
  const [generating, setGenerating] = useState(false);
  const [showAnswers, setShowAnswers] = useState(false);

  const { confirmSpend, costDialog } = useCostGate(quota);
  const serverMode = quota != null;

  const refresh = () => {
    setEntries(listWords());
    setSelected((prev) => {
      const alive = new Set(listWords().map((e) => e.word));
      return new Set([...prev].filter((w) => alive.has(w)));
    });
  };

  useEffect(() => { refresh(); }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? entries.filter((e) => e.word.toLowerCase().includes(q) || e.definition.toLowerCase().includes(q))
      : entries;
    return filterByFreq(base, freqFilter);
  }, [entries, query, freqFilter]);

  const selectedEntries = useMemo(() => entries.filter((e) => selected.has(e.word)), [entries, selected]);

  const toggle = (word: string) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(word)) n.delete(word); else n.add(word);
      return n;
    });
  };

  const allFilteredSelected = filtered.length > 0 && filtered.every((e) => selected.has(e.word));

  const handleAdd = () => {
    const w = newWord.trim();
    if (!w) { setError('请输入单词'); return; }
    // 重名保护：addWords 会整条覆盖，手动添加只允许新词（改旧词走「编辑」）
    if (listWords().some((e) => e.word.toLowerCase() === w.toLowerCase())) {
      setError(`「${w}」已在词库中，请直接在列表里编辑它`);
      return;
    }
    addWords([{
      word: w, phonetic: newPhonetic.trim(), definition: newDefinition.trim(),
      sourceLabel: '手动添加',
    }]);
    setNewWord(''); setNewDefinition(''); setNewPhonetic('');
    setError('');
    refresh();
  };

  const startEdit = (e: WordBankEntry) => {
    setEditingWord(e.word);
    setEditDraft({ word: e.word, phonetic: e.phonetic, definition: e.definition });
  };

  const saveEdit = () => {
    if (!editingWord) return;
    const w = editDraft.word.trim();
    if (!w) { setError('单词不能为空'); return; }
    updateWord(editingWord, { word: w, phonetic: editDraft.phonetic.trim(), definition: editDraft.definition.trim() });
    setEditingWord(null);
    setError('');
    refresh();
  };

  const handleDeleteSelected = () => {
    const n = selected.size;
    if (n === 0) return;
    if (!window.confirm(`确定删除选中的 ${n} 个词条？此操作不可恢复。`)) return;
    removeWords([...selected]);
    setSelected(new Set());
    refresh();
  };

  /** 生成词汇检测（语法填空式，LLM，20 额度） */
  const handleGenerateCheck = async () => {
    if (generating) return;
    const pick = selectedEntries.length > 0 ? selectedEntries : entries;
    if (pick.length < 3) { setError('至少需要 3 个词条才能生成检测题'); return; }
    if (!(await confirmSpend(20, `生成词汇检测（${pick.length} 词 · 语法填空式）`))) return;
    setGenerating(true); setError(''); setCheckItems(null);
    try {
      const model = getEffectiveModel('vocab', VOCAB_DEFAULT_MODEL);
      const prompt = buildClozePrompt(pick.map((v) => ({ word: v.word, definition: v.definition, originalSentence: v.originalSentence })), stage);
      const r = await generateCloze(apiConfig, model, prompt);
      if (!r || !Array.isArray(r.items) || r.items.length === 0) throw new Error('生成失败，请稍后重试');
      setCheckItems(r.items);
      setShowAnswers(false);
      track('generate_success', 'wordbank_check');
    } catch (e) {
      track('generate_error', 'wordbank_check');
      setError(e instanceof Error ? e.message : '生成失败');
    } finally { setGenerating(false); }
  };

  /** 去字帖练写：多选内容交接给字帖 tab */
  const handleGoCopybook = () => {
    const pick = selectedEntries.length > 0 ? selectedEntries : entries;
    if (pick.length === 0) { setError('词库为空'); return; }
    handOffToCopybook(pick.slice(0, 40).map(entryToCopybookLine).join('\n'));
    onGoCopybook();
  };

  const handleExportDictation = () => {
    const pick = selectedEntries.length > 0 ? selectedEntries : entries;
    if (pick.length === 0) { setError('词库为空'); return; }
    exportDictationSheetDocx(pick.map((e) => ({
      id: 0, word: e.word, phonetic: e.phonetic, definition: e.definition,
      collocations: e.collocations, memoryAid: e.memoryAid, examFrequency: e.examFrequency,
      originalSentence: e.originalSentence, extraExample: e.extraExample,
      source: 'custom' as const, sourceLabel: '词库',
      spellingRequired: true, sectionName: e.sectionName,
    })), stage);
    track('export_success', 'wordbank_dictation');
  };

  return (
    <div className="wordbank-module">
      {/* 页头 */}
      <div className="sf-header">
        <div>
          <h2><Icon name="wordbank" size={20} /> 词汇学案制作</h2>
          <p>跨工具共享的词汇资产：试卷词汇提取可「存入词库」，这里管理它们，多选后生成检测题 / 默写卷 / 字帖练写内容（记录仅存本机浏览器）</p>
        </div>
      </div>

      {error && <ErrorBar error={error} />}

      {/* 添加词条 */}
      <div className="wb-add-bar">
        <input className="wb-input wb-input-word" value={newWord} onChange={(e) => setNewWord(e.target.value)}
          placeholder="单词 *" onKeyDown={(e) => e.key === 'Enter' && handleAdd()} />
        <input className="wb-input" value={newPhonetic} onChange={(e) => setNewPhonetic(e.target.value)}
          placeholder="音标（可选）" onKeyDown={(e) => e.key === 'Enter' && handleAdd()} />
        <input className="wb-input wb-input-def" value={newDefinition} onChange={(e) => setNewDefinition(e.target.value)}
          placeholder="释义（可选），如 adj. 仔细的" onKeyDown={(e) => e.key === 'Enter' && handleAdd()} />
        <button className="wb-btn primary" onClick={handleAdd} disabled={!newWord.trim()}>＋ 添加</button>
      </div>

      {/* 筛选 + 批量工具 */}
      <div className="wb-toolbar">
        <input className="wb-input wb-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索单词 / 释义…" />
        <div className="freq-filter" role="group" aria-label="按考试频次筛选">
          {FREQ_FILTERS.map((f) => (
            <button key={f.key} className={`freq-pill ${freqFilter === f.key ? 'active' : ''}`}
              onClick={() => setFreqFilter(f.key)} title={f.title}>{f.label}</button>
          ))}
        </div>
        <button className="wb-btn" onClick={() => setSelected((prev) => {
          const n = new Set(prev);
          if (filtered.length > 0 && filtered.every((e) => n.has(e.word))) filtered.forEach((e) => n.delete(e.word));
          else filtered.forEach((e) => n.add(e.word));
          return n;
        })}>{allFilteredSelected ? '全不选' : '全选'}</button>
      </div>

      {/* 选中后的动作条 */}
      <div className="wb-actions">
        <span className="wb-count">共 {entries.length} 词 · 已选 <strong>{selected.size}</strong></span>
        <div className="wb-actions-buttons">
          <button className="wb-btn primary" onClick={handleGenerateCheck}
            disabled={generating || (selected.size === 0 && entries.length < 3)}
            title={selected.size > 0 ? '按选中的词生成语法填空式检测题' : '不选则用全部词库（至少 3 词）'}>
            {generating ? '生成中…' : (<><Icon name="sparkles" size={16} /> 生成词汇检测{serverMode ? ' · 20 额度' : ''}</>)}
          </button>
          <button className="wb-btn" onClick={handleExportDictation} disabled={entries.length === 0}
            title="导出中文提示默写卷（含报词单），不消耗额度"><Icon name="exportDoc" size={16} /> 默写卷</button>
          <button className="wb-btn" onClick={handleGoCopybook} disabled={entries.length === 0}
            title="把选中的词（例句）交接给衡水体字帖练写，不消耗额度"><Icon name="pen" size={16} /> 去字帖练写</button>
          <button className="wb-btn danger" onClick={handleDeleteSelected} disabled={selected.size === 0}>
            <Icon name="trash" size={16} /> 删除选中{selected.size > 0 ? `（${selected.size}）` : ''}
          </button>
        </div>
      </div>

      {/* 词条列表 */}
      <div className="wb-list">
        {filtered.length === 0 && (
          <p className="wb-empty">
            词库还是空的。去「试卷词汇提取」生成词汇后点「存入词库」，或在上方的添加栏手动录入。
          </p>
        )}
        {filtered.map((e) => (
          <div key={e.word} className={`wb-row ${selected.has(e.word) ? 'checked' : ''}`}>
            <input type="checkbox" checked={selected.has(e.word)} onChange={() => toggle(e.word)} />
            {editingWord === e.word ? (
              <div className="wb-edit">
                <input className="wb-input wb-input-word" value={editDraft.word}
                  onChange={(ev) => setEditDraft({ ...editDraft, word: ev.target.value })} placeholder="单词 *" />
                <input className="wb-input" value={editDraft.phonetic}
                  onChange={(ev) => setEditDraft({ ...editDraft, phonetic: ev.target.value })} placeholder="音标" />
                <input className="wb-input wb-input-def" value={editDraft.definition}
                  onChange={(ev) => setEditDraft({ ...editDraft, definition: ev.target.value })} placeholder="释义" />
                <button className="wb-btn primary" onClick={saveEdit}>保存</button>
                <button className="wb-btn" onClick={() => setEditingWord(null)}>取消</button>
              </div>
            ) : (
              <>
                <span className="wb-word">{e.word}</span>
                {e.phonetic && <span className="wb-phonetic">{e.phonetic}</span>}
                <span className="wb-def">{e.definition || <span className="wb-def-empty">（无释义）</span>}</span>
                {e.examFrequency && <span className={`freq-tag ${freqClass(e.examFrequency)}`}>{e.examFrequency}</span>}
                <button className="wb-btn wb-btn-sm" onClick={() => startEdit(e)}>编辑</button>
                <button className="wb-btn wb-btn-sm danger" onClick={() => { removeWord(e.word); refresh(); }}>删除</button>
              </>
            )}
          </div>
        ))}
      </div>

      {/* 检测题结果 */}
      {checkItems && (
        <div className="wb-check-result">
          <div className="wb-check-head">
            <h3><Icon name="worksheet" size={16} /> 词汇检测（{checkItems.length} 题）</h3>
            <div className="wb-check-actions">
              <button className="wb-btn" onClick={() => setShowAnswers((v) => !v)}>{showAnswers ? '隐藏答案' : '显示答案'}</button>
              <button className="wb-btn" onClick={() => exportClozeSheetDocx(checkItems, false)}><Icon name="exportDoc" size={16} /> 导出学生版 Docx</button>
              <button className="wb-btn" onClick={() => exportClozeSheetDocx(checkItems, true)}><Icon name="exportDoc" size={16} /> 导出教师版 Docx</button>
            </div>
          </div>
          <ol className="wb-check-list">
            {checkItems.map((item, i) => (
              <li key={i}>
                <span className="wb-check-sentence">{item.sentence.includes('__________') ? item.sentence : `${item.sentence} __________`} <em>({item.hint})</em></span>
                {showAnswers && <span className="wb-check-answer">答案：{item.answer}</span>}
              </li>
            ))}
          </ol>
        </div>
      )}

      {costDialog}
    </div>
  );
}
