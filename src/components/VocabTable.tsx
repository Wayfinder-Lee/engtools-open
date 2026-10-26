import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import type { ApiConfig, DocxExportOptions, FieldSelection, Stage, VocabItem } from '../types';
import { DEFAULT_DOCX_OPTIONS, getSectionOrder } from '../types';
import { exportToDocx } from '../services/docxExport';
import { generateCloze, generateWordInfo } from '../services/llm';
import { buildClozePrompt } from '../prompts/vocabExtraction';
import { track } from '../utils/analytics';
import { Icon } from './icons';
import { addWords, exportDictationSheetDocx, exportFlashcardsDocx, exportAnkiTsv, freqClass, filterByFreq, FREQ_FILTERS, type FreqFilter } from './vocabTableExtras';
import './VocabTable.css';

interface Props {
  vocabList: VocabItem[];
  fieldSelection: FieldSelection;
  apiConfig: ApiConfig;
  model: string;
  stage: Stage;
  /** 额度确认门（W4）：语法填空生成前确认消耗，余额不足弹兑换引导 */
  confirmSpend: (cost: number, what: string, note?: string) => Promise<boolean>;
  onDelete: (id: number) => void;
  /** M1：词条级「换一个」——同词重新生成一份条目（word 操作免费） */
  onReplace?: (id: number, item: VocabItem) => void;
  /** M1：重生成失败的错误上抛（用页面错误条展示） */
  onError?: (msg: string) => void;
  onReorder: (newList: VocabItem[]) => void;
  onEdit: (id: number, field: keyof VocabItem, value: string) => void;
  onAddWord: (sectionName?: string) => void;
  /** 传入后每个分组块带上 id（`{prefix}-g{组序}`），供页面左侧目录锚点跳转 */
  groupAnchorPrefix?: string;
}

// ─── Section grouping ──────────────────────────────

function sectionSortOrder(name: string, order: string[]): number {
  const idx = order.indexOf(name);
  return idx >= 0 ? idx : order.length;
}

/** 按大题分组（供目录锚点计算复用） */
export function groupBySection(list: VocabItem[], stage: Stage): { name: string; items: VocabItem[] }[] {
  const order = getSectionOrder(stage);
  const groups = new Map<string, VocabItem[]>();
  for (const item of list) {
    const name = item.sectionName || '自定义';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name)!.push(item);
  }
  return Array.from(groups.entries())
    .sort((a, b) => sectionSortOrder(a[0], order) - sectionSortOrder(b[0], order))
    .map(([name, items]) => ({ name, items }));
}

// ─── Inline editable cell ─────────────────────────

function EditableCell({
  value,
  onSave,
  multiline = false,
  renderDisplay,
}: {
  value: string;
  onSave: (newValue: string) => void;
  multiline?: boolean;
  renderDisplay?: (rawValue: string) => React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (draft !== value) onSave(draft);
  };

  const cancel = () => {
    setEditing(false);
    setDraft(value);
  };

  if (editing) {
    const Tag = multiline ? 'textarea' : 'input';
    return (
      <Tag
        ref={inputRef as never}
        className={`cell-edit ${multiline ? 'cell-edit-textarea' : ''}`}
        value={draft}
        onChange={(e) => setDraft((e.target as HTMLInputElement).value)}
        onBlur={commit}
        onKeyDown={(e: React.KeyboardEvent) => {
          // isComposing/229 拦输入法选字确认（中文释义字段常见），避免拼音中途被提交
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        }}
      />
    );
  }

  return (
    <span
      className="cell-display"
      onClick={() => { setDraft(value); setEditing(true); }}
      title="点击编辑"
    >
      {renderDisplay
        ? renderDisplay(value)
        : (value || <span className="cell-empty">—</span>)}
    </span>
  );
}

// ─── Markdown → HTML ──────────────────────────────

function renderMarkdown(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}

// ─── CSV export ───────────────────────────────────

/** 导出词汇 CSV（主页「最近生成」复用；文件名/列结构与 tab 内完全一致）。 */
export function exportCSV(list: VocabItem[], fields: FieldSelection, stage: Stage) {
  const headers: string[] = ['编号', '单词'];
  if (fields.phonetic) headers.push('音标');
  if (fields.examFrequency) headers.push(stage === 'junior' ? '中考频次' : '高考频次');
  headers.push('来源');
  if (fields.originalSentence) headers.push('文中例句');
  if (fields.definition) headers.push('释义（含词性）');
  if (fields.collocations) headers.push('常用搭配');
  if (fields.memoryAid) headers.push('辅助记忆');
  if (fields.extraExample) headers.push('额外例句');

  const rows = list.map((item) => {
    const row: (string | number)[] = [item.id, item.word];
    if (fields.phonetic) row.push(item.phonetic);
    if (fields.examFrequency) row.push(item.examFrequency);
    row.push(item.sourceLabel);
    if (fields.originalSentence) row.push(item.originalSentence);
    if (fields.definition) row.push(item.definition);
    if (fields.collocations) row.push(item.collocations);
    if (fields.memoryAid) row.push(item.memoryAid);
    if (fields.extraExample) row.push(item.extraExample);
    return row;
  });

  const escape = (val: string | number) => `"${String(val).replace(/"/g, '""')}"`;
  const csv = [headers.map(escape).join(','), ...rows.map((r) => r.map(escape).join(','))].join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'vocabulary.csv';
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Drag-and-drop helpers ────────────────────────

let dragSrcIndex: number | null = null;

// ─── Table row (used in desktop table) ────────────

interface RowProps {
  item: VocabItem;
  index: number;
  fields: FieldSelection;
  onEdit: (id: number, field: keyof VocabItem, value: string) => void;
  onDelete: (item: VocabItem) => void;
  onRegenerate?: (item: VocabItem) => void;
  regenerating?: boolean;
  onDragStart: (index: number) => void;
  onDragOver: (e: React.DragEvent, index: number) => void;
  onDrop: (index: number) => void;
}

function TableRow({ item, index, fields, onEdit, onDelete, onRegenerate, regenerating, onDragStart, onDragOver, onDrop }: RowProps) {
  return (
    <tr
      draggable
      onDragStart={() => onDragStart(index)}
      onDragOver={(e) => onDragOver(e, index)}
      onDrop={() => onDrop(index)}
      className="draggable-row"
    >
      <td className="col-drag">
        <span className="drag-handle" title="拖动排序">⋮⋮</span>
      </td>
      <td className="col-id">{item.id}</td>
      <td className="col-actions">
        {onRegenerate && (
          <button className="btn-regen-row" onClick={() => onRegenerate(item)} disabled={regenerating}
            title="同词重新生成一份条目（免费）">{regenerating ? '…' : '↻'}</button>
        )}
        <button className="btn-delete-row" onClick={() => onDelete(item)} title="删除"><Icon name="trash" size={14} /></button>
      </td>
      <td className="col-word"><strong>{item.word}</strong></td>
      {fields.phonetic && <td className="col-phonetic"><EditableCell value={item.phonetic} onSave={(v) => onEdit(item.id, 'phonetic', v)} /></td>}
      {fields.examFrequency && <td className="col-freq"><span className={`freq-tag ${freqClass(item.examFrequency)}`}>{item.examFrequency || '⚪'}</span></td>}
      <td className="col-source">
        <span className={`source-tag source-${item.source}`}>{item.sourceLabel}</span>
      </td>
      {fields.originalSentence && (
        <td className="col-original">
          <EditableCell
            value={item.originalSentence}
            onSave={(v) => onEdit(item.id, 'originalSentence', v)}
            multiline
            renderDisplay={(raw) => (
              <span dangerouslySetInnerHTML={{ __html: renderMarkdown(raw) }} />
            )}
          />
        </td>
      )}
      {fields.definition && <td className="col-def"><EditableCell value={item.definition} onSave={(v) => onEdit(item.id, 'definition', v)} multiline /></td>}
      {fields.collocations && <td className="col-coll"><EditableCell value={item.collocations} onSave={(v) => onEdit(item.id, 'collocations', v)} multiline /></td>}
      {fields.memoryAid && <td className="col-memory"><EditableCell value={item.memoryAid} onSave={(v) => onEdit(item.id, 'memoryAid', v)} multiline /></td>}
      {fields.extraExample && (
        <td className="col-example">
          <EditableCell
            value={item.extraExample}
            onSave={(v) => onEdit(item.id, 'extraExample', v)}
            multiline
            renderDisplay={(raw) => (
              <span dangerouslySetInnerHTML={{ __html: renderMarkdown(raw) }} />
            )}
          />
        </td>
      )}
    </tr>
  );
}

// ─── Desktop section block ────────────────────────

interface SectionBlockProps {
  group: { name: string; items: VocabItem[] };
  fields: FieldSelection;
  stage: Stage;
  onEdit: (id: number, field: keyof VocabItem, value: string) => void;
  onDelete: (item: VocabItem) => void;
  onRegenerate?: (item: VocabItem) => void;
  regenId: number | null;
  onAddWord: (sectionName?: string) => void;
  onReorderItems: (groupName: string, newItems: VocabItem[]) => void;
  /** 目录跳转锚点 id（由使用方按分组序号生成，可选） */
  anchorId?: string;
}

function SectionBlock({ group, fields, stage, onEdit, onDelete, onRegenerate, regenId, onAddWord, onReorderItems, anchorId }: SectionBlockProps) {
  const handleDragStart = useCallback((index: number) => {
    dragSrcIndex = index;
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, _index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDrop = useCallback((dropIndex: number) => {
    if (dragSrcIndex === null || dragSrcIndex === dropIndex) return;
    const newItems = [...group.items];
    const [moved] = newItems.splice(dragSrcIndex, 1);
    newItems.splice(dropIndex, 0, moved);
    dragSrcIndex = null;
    onReorderItems(group.name, newItems);
  }, [group.items, group.name, onReorderItems]);

  return (
    <div className="section-block" id={anchorId}>
      <div className="section-block-header">
        <span className="section-block-title">{group.name}</span>
        <span className="section-block-count">{group.items.length} 词</span>
      </div>
      <table className="section-table">
        <thead>
          <tr>
            <th className="col-drag"></th>
            <th className="col-id">编号</th>
            <th className="col-actions-th"></th>
            <th className="col-word">单词</th>
            {fields.phonetic && <th className="col-phonetic">音标</th>}
            {fields.examFrequency && <th className="col-freq">{stage === 'junior' ? '中考频次' : '高考频次'}</th>}
            <th className="col-source">来源</th>
            {fields.originalSentence && <th className="col-original">文中例句</th>}
            {fields.definition && <th className="col-def">释义</th>}
            {fields.collocations && <th className="col-coll">常用搭配</th>}
            {fields.memoryAid && <th className="col-memory">辅助记忆</th>}
            {fields.extraExample && <th className="col-example">额外例句</th>}
          </tr>
        </thead>
        <tbody>
          {group.items.map((item, index) => (
            <TableRow
              key={item.id}
              item={item}
              index={index}
              fields={fields}
              onEdit={onEdit}
              onDelete={onDelete}
              onRegenerate={onRegenerate}
              regenerating={regenId === item.id}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
            />
          ))}
        </tbody>
      </table>
      <button className="btn-section-add" onClick={() => onAddWord(group.name)}>
        + 添加词汇到「{group.name}」
      </button>
    </div>
  );
}

// ─── Mobile card (within a section) ────────────────

function MobileCard({ item, onEdit, onDelete, onRegenerate, regenerating, fields }: {
  item: VocabItem;
  onRegenerate?: (item: VocabItem) => void;
  regenerating?: boolean;
  onEdit: (id: number, field: keyof VocabItem, value: string) => void;
  onDelete: (item: VocabItem) => void;
  fields: FieldSelection;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="vocab-card">
      <div className="vocab-card-header" onClick={() => setExpanded(!expanded)}>
        <span className="drag-handle" title="拖动排序" onClick={(e) => e.stopPropagation()}>⋮⋮</span>
        <span className="card-id">{item.id}</span>
        <span className="card-word">{item.word}</span>
        {fields.examFrequency && <span className="card-freq">{item.examFrequency}</span>}
        <span className={`source-tag source-${item.source}`}>{item.sourceLabel}</span>
        <span className="card-expand">{expanded ? '▼' : '▶'}</span>
      </div>
      {expanded && (
        <div className="vocab-card-body">
          {fields.phonetic && <div className="card-field"><label>音标</label><EditableCell value={item.phonetic} onSave={(v) => onEdit(item.id, 'phonetic', v)} /></div>}
          {fields.definition && <div className="card-field"><label>释义</label><EditableCell value={item.definition} onSave={(v) => onEdit(item.id, 'definition', v)} multiline /></div>}
          {fields.originalSentence && <div className="card-field"><label>文中例句</label><span className="sentence-html" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.originalSentence) }} /></div>}
          {fields.collocations && <div className="card-field"><label>常用搭配</label><EditableCell value={item.collocations} onSave={(v) => onEdit(item.id, 'collocations', v)} multiline /></div>}
          {fields.memoryAid && <div className="card-field"><label>辅助记忆</label><EditableCell value={item.memoryAid} onSave={(v) => onEdit(item.id, 'memoryAid', v)} multiline /></div>}
          {fields.extraExample && <div className="card-field"><label>额外例句</label><span className="sentence-html" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.extraExample) }} /></div>}
        </div>
      )}
      <div className="vocab-card-footer">
        {onRegenerate && (
          <button className="btn-regen-row" onClick={() => onRegenerate(item)} disabled={regenerating}>
            {regenerating ? '重新生成中…' : '↻ 换一个'}
          </button>
        )}
        <button className="btn-delete-row" onClick={() => onDelete(item)}><Icon name="trash" size={16} /> 删除</button>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────

export default function VocabTable({
  vocabList, fieldSelection: fields, apiConfig, model, stage, confirmSpend, onDelete, onReplace, onError, onReorder, onEdit, onAddWord, groupAnchorPrefix,
}: Props) {
  const [docxLoading, setDocxLoading] = useState(false);
  const [showDocxOptions, setShowDocxOptions] = useState(false);
  const [docxOptions, setDocxOptions] = useState<DocxExportOptions>({ ...DEFAULT_DOCX_OPTIONS });
  const [regenId, setRegenId] = useState<number | null>(null);
  // M3：词库 / 配套材料
  const [showExtras, setShowExtras] = useState(false);
  const [bankMsg, setBankMsg] = useState('');
  // M4：考试频次筛选
  const [freqFilter, setFreqFilter] = useState<FreqFilter>('all');

  /** M1：同词重新生成条目（word 操作免费，每日限次；失败不扣额度） */
  const handleRegenerate = async (item: VocabItem) => {
    if (regenId != null || !onReplace) return;
    setRegenId(item.id);
    try {
      const fresh = await generateWordInfo(apiConfig, model, item.word, stage);
      onReplace(item.id, { ...fresh, id: item.id, sectionName: item.sectionName });
    } catch (e) {
      onError?.(e instanceof Error ? e.message : '该词条重新生成失败，请稍后重试');
    } finally {
      setRegenId(null);
    }
  };

  const toggleDocxOption = (key: keyof DocxExportOptions) => {
    setDocxOptions((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  /** M2：导出页数预估（A4 双栏经验值，标注「预估」管理预期；语法填空生成后另行计入） */
  const estimatePages = (): number => {
    const n = vocabList.length;
    let lines = 0;
    if (docxOptions.selfTest) lines += n * 2.5 + 2;
    if (docxOptions.vocabTable) lines += n * 8 + 2;
    if (docxOptions.wordList) lines += n * 2 + grouped.length;
    if (docxOptions.dictation) lines += n * 2 + 2;
    const perPage = docxOptions.compact ? 82 : 64;
    return Math.max(1, Math.ceil(lines / perPage));
  };

  /** M3：当前词汇表全部存入共享词库（按词去重，字帖/应用文/配套材料共用） */
  const handleSaveToBank = () => {
    const [added, total] = addWords(vocabList);
    setBankMsg(added > 0 ? `已存入词库（新增 ${added}，词库共 ${total} 词）` : `词库已包含这些词（共 ${total} 词）`);
    window.setTimeout(() => setBankMsg(''), 4000);
  };

  /** M3：配套材料一键导出（零 LLM 额度） */
  const handleMaterial = async (kind: 'dictation' | 'flashcards' | 'anki') => {
    setShowExtras(false);
    try {
      if (kind === 'dictation') await exportDictationSheetDocx(flatSorted, stage);
      else if (kind === 'flashcards') await exportFlashcardsDocx(flatSorted);
      else await exportAnkiTsv(flatSorted);
      track('export_success', 'vocab_material');
    } catch (e) {
      onError?.(e instanceof Error ? e.message : '导出失败');
    }
  };

  const filteredList = useMemo(() => filterByFreq(vocabList, freqFilter), [vocabList, freqFilter]);
  const grouped = useMemo(() => groupBySection(filteredList, stage), [filteredList, stage]);

  const flatSorted = useMemo(() => grouped.flatMap(g => g.items), [grouped]);

  const handleDelete = (item: VocabItem) => {
    if (window.confirm(`确定删除「${item.word}」吗？此操作不可恢复。`)) onDelete(item.id);
  };

  // Called by SectionBlock when items are reordered within a group
  const handleReorderItems = useCallback((groupName: string, newItems: VocabItem[]) => {
    // Renumber by current display order: keep group order, items within group in new order
    const allGroups = groupBySection(vocabList, stage);
    const reordered: VocabItem[] = [];
    for (const g of allGroups) {
      if (g.name === groupName) {
        reordered.push(...newItems);
      } else {
        reordered.push(...g.items);
      }
    }
    onReorder(reordered.map((item, idx) => ({ ...item, id: idx + 1 })));
  }, [vocabList, stage, onReorder]);

  const handleExportDocx = async () => {
    setDocxLoading(true);
    setShowDocxOptions(false);
    try {
      let clozeResult = null;
      if (docxOptions.cloze) {
        if (!(await confirmSpend(20, '生成语法填空（随 Docx 学案导出）'))) { setDocxLoading(false); return; }
        const prompt = buildClozePrompt(flatSorted.map((v) => ({ word: v.word, definition: v.definition, originalSentence: v.originalSentence })), stage);
        clozeResult = await generateCloze(apiConfig, model, prompt);
      }
      await exportToDocx(flatSorted, clozeResult?.items, fields, docxOptions, stage);
      track('export_success', 'vocab');
    } catch {
      await exportToDocx(flatSorted, null, fields, docxOptions, stage);
      track('export_success', 'vocab');
    } finally { setDocxLoading(false); }
  };

  const anyFieldVisible = fields.phonetic || fields.definition || fields.collocations || fields.memoryAid || fields.examFrequency || fields.originalSentence || fields.extraExample;

  return (
    <div className="vocab-table-container">
      <div className="table-toolbar">
        <span className="table-count">共 <strong>{vocabList.length}</strong> 个词汇 · {grouped.length} 个分组</span>
        <div className="freq-filter" role="group" aria-label="按考试频次筛选">
          {FREQ_FILTERS.map((f) => (
            <button key={f.key} className={`freq-pill ${freqFilter === f.key ? 'active' : ''}`}
              onClick={() => setFreqFilter(f.key)} title={f.title}>{f.label}</button>
          ))}
        </div>
        <div className="table-toolbar-actions">
          <button className="btn-add-word" onClick={() => onAddWord()}><Icon name="pencil" size={16} /> 自定义添加词汇</button>
          <button className="btn-bank" onClick={handleSaveToBank} title="存入共享词库：字帖、应用文话题词与配套材料都会用到"><Icon name="wordbank" size={16} /> 存入词库</button>
          <div className="extras-group">
            <button className="btn-bank" onClick={() => setShowExtras(!showExtras)}><Icon name="clipboard" size={16} /> 配套材料 ▾</button>
            {showExtras && (
              <div className="extras-panel">
                <div className="extras-title">基于当前词汇表生成（不消耗额度）：</div>
                <button className="extras-item" onClick={() => handleMaterial('dictation')}><Icon name="worksheet" size={16} /> 词汇默写卷（中文提示 + 报词单）</button>
                <button className="extras-item" onClick={() => handleMaterial('flashcards')}><Icon name="cards" size={16} /> 单词闪卡纸（对折/剪开即成卡）</button>
                <button className="extras-item" onClick={() => handleMaterial('anki')}><Icon name="cards" size={16} /> Anki 词表（.txt 导入 Anki）</button>
              </div>
            )}
          </div>
          {bankMsg && <span className="bank-msg">{bankMsg}</span>}
          <div className="docx-export-group">
            <button className="btn-export-docx" onClick={() => setShowDocxOptions(!showDocxOptions)} disabled={docxLoading}>
              {docxLoading ? '生成中...' : (<><Icon name="exportDoc" size={16} /> 导出 Docx 学案</>)}
            </button>
            {showDocxOptions && (
              <div className="docx-options-panel">
                <div className="docx-options-title">选择要生成的内容：</div>
                <label className="docx-option"><input type="checkbox" checked={docxOptions.selfTest} onChange={() => toggleDocxOption('selfTest')} /> 原句理解自测</label>
                <label className="docx-option"><input type="checkbox" checked={docxOptions.vocabTable} onChange={() => toggleDocxOption('vocabTable')} /> 重点词汇表</label>
                <label className="docx-option"><input type="checkbox" checked={docxOptions.cloze} onChange={() => toggleDocxOption('cloze')} /> 语法填空·词汇检测</label>
                <label className="docx-option"><input type="checkbox" checked={docxOptions.wordList} onChange={() => toggleDocxOption('wordList')} /> 词汇清单</label>
                <label className="docx-option"><input type="checkbox" checked={docxOptions.dictation} onChange={() => toggleDocxOption('dictation')} /> 默写清单</label>
                <div className="docx-options-sub">
                  <span className="docx-options-label">导出版本：</span>
                  <label className="docx-option"><input type="radio" name="docx-variant" checked={docxOptions.variant !== 'student'} onChange={() => setDocxOptions((prev) => ({ ...prev, variant: 'teacher' }))} /> 教师卷（含答案）</label>
                  <label className="docx-option"><input type="radio" name="docx-variant" checked={docxOptions.variant === 'student'} onChange={() => setDocxOptions((prev) => ({ ...prev, variant: 'student' }))} /> 学生卷</label>
                </div>
                <label className="docx-option docx-option-compact">
                  <input type="checkbox" checked={!!docxOptions.compact} onChange={() => setDocxOptions((prev) => ({ ...prev, compact: !prev.compact }))} /> 紧凑模式（字号 86% + 窄边距，省纸）
                </label>
                <div className="docx-estimate">预计 {estimatePages()} 页（A4 双栏 · 预估值，语法填空生成后另计）</div>
                <button className="btn-export-docx-go" onClick={handleExportDocx} disabled={docxLoading}>
                  {docxLoading ? '生成中...' : (<><Icon name="sparkles" size={16} /> 开始生成</>)}
                </button>
              </div>
            )}
          </div>
          <button className="btn-export" onClick={() => exportCSV(flatSorted, fields, stage)}><Icon name="download" size={16} /> 导出 CSV</button>
        </div>
      </div>

      {/* Desktop tables — grouped by section */}
      <div className="table-desktop">
        {grouped.map((group, gi) => (
          <SectionBlock
            key={group.name}
            group={group}
            fields={fields}
            stage={stage}
            onEdit={onEdit}
            onDelete={handleDelete}
            onRegenerate={onReplace ? handleRegenerate : undefined}
            regenId={regenId}
            onAddWord={onAddWord}
            onReorderItems={handleReorderItems}
            anchorId={groupAnchorPrefix ? `${groupAnchorPrefix}-g${gi}` : undefined}
          />
        ))}
      </div>

      {/* Mobile cards — grouped by section */}
      <div className="table-mobile">
        {grouped.map(group => (
          <div key={group.name} className="section-block-mobile">
            <div className="section-block-header">
              <span className="section-block-title">{group.name}</span>
              <span className="section-block-count">{group.items.length} 词</span>
            </div>
            {group.items.map(item => (
              <MobileCard key={item.id} item={item} onEdit={onEdit} onDelete={handleDelete}
                onRegenerate={onReplace ? handleRegenerate : undefined} regenerating={regenId === item.id} fields={fields} />
            ))}
            <button className="btn-section-add" onClick={() => onAddWord(group.name)}>
              + 添加词汇到「{group.name}」
            </button>
          </div>
        ))}
      </div>

      {!anyFieldVisible && (
        <p className="no-fields-hint">未选择任何显示字段，请在提取参数中勾选需要的字段。</p>
      )}
    </div>
  );
}
