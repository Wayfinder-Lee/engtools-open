import { useState, useEffect, useCallback, useRef } from 'react';
import type { ApiConfig, FieldSelection, SavedItem, Stage, VocabItem, VocabLevel, VocabState, WordLevel } from '../types';
import { MODEL_OPTIONS, getVocabLevels, DEFAULT_FIELD_SELECTION, VOCAB_DEFAULT_MODEL, WORD_LEVELS, MODULE_LABELS } from '../types';
import { extractVocab } from '../services/llm';
import { apiReportUsage } from '../services/api';
import { buildVocabExtractionPrompt } from '../prompts/vocabExtraction';
import { parseSections } from '../utils/sectionParser';
import { getEffectiveModel } from '../utils/model';
import { autoSave, manualSave } from '../utils/history';
import { refreshAutoTitle } from '../utils/autoTitle';
import { takeHistoryHandoff } from '../utils/historyHandoff';
import { setFabCallbacks } from './FloatingActions';
import ModelSelect from './ModelSelect';
import HistoryModal from './HistoryModal';
import VocabTable, { groupBySection } from './VocabTable';
import AddWordModal from './AddWordModal';
import ErrorBar from './ErrorBar';
import SampleFill from './SampleFill';
import { useCostGate } from './CostGate';
import { track } from '../utils/analytics';
import { Icon } from './icons';
import { SAMPLE_VOCAB_SENIOR, SAMPLE_VOCAB_JUNIOR } from '../data/samples';
import { StageStepper, StageToc, StageCard, useScrollspy, useStageFlow } from './StageFlow';
import type { FlowStageInfo, TocEntry } from './StageFlow';
import './VocabExtractor.css';

const MAX_WORDS_PER_SECTION = 2000;
/** 试卷原文本机自动保存（W6：此前只在内存，刷新未保存即丢） */
const INPUT_AUTOSAVE_KEY = 'vb_vocab_input';

/** 字段标签（examFrequency 随学段切换：中考频次/高考频次） */
function fieldLabels(stage: Stage): { key: keyof FieldSelection; label: string }[] {
  return [
    { key: 'phonetic', label: '音标' },
    { key: 'definition', label: '词性+释义' },
    { key: 'collocations', label: '常用搭配' },
    { key: 'memoryAid', label: '辅助记忆' },
    { key: 'examFrequency', label: stage === 'junior' ? '中考频次' : '高考频次' },
    { key: 'originalSentence', label: '文中原句' },
    { key: 'extraExample', label: '额外例句' },
  ];
}

interface Section {
  id: number;
  title: string;
  content: string;
  enabled: boolean;
  wordLevel: WordLevel;
  generating: boolean;
  generated: boolean;
  error?: string;
}

interface Props { apiConfig: ApiConfig; stage: Stage; /** 登录用户当前余额；null = 自带 Key 模式 */ quota?: number | null; }

// ─── 阶段流程定义 ───────────────────────────────────

type FlowStageId = 'input' | 'sections' | 'table';
const STAGE_ANCHOR: Record<FlowStageId, string> = { input: 'vf-stage-input', sections: 'vf-stage-sections', table: 'vf-stage-table' };
const GROUP_ANCHOR_PREFIX = 'vf-group';

export default function VocabExtractor({ apiConfig, stage, quota }: Props) {
  const [inputText, setInputText] = useState('');
  const [level, setLevel] = useState<VocabLevel>('core');
  const [model, setModel] = useState(VOCAB_DEFAULT_MODEL);
  const [fieldSelection, setFieldSelection] = useState<FieldSelection>({ ...DEFAULT_FIELD_SELECTION });
  const [fieldsExpanded, setFieldsExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [vocabList, setVocabList] = useState<VocabItem[] | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [addWordSection, setAddWordSection] = useState<string | undefined>(undefined);
  const [showHistory, setShowHistory] = useState(false);

  // Section state
  const [sections, setSections] = useState<Section[]>([]);
  const [sectionsDetected, setSectionsDetected] = useState(false);

  // 额度确认门（W4）：小额按钮标价即确认，大额弹轻量确认卡，余额不足弹兑换引导
  const { confirmSpend, costDialog } = useCostGate(quota);
  /** 服务端计费模式（登录或游客）；false = 自带 Key */
  const serverMode = quota != null;

  // 试卷原文自动保存（W6）：debounce 600ms，三态指示器
  const [autosaveState, setAutosaveState] = useState('');
  useEffect(() => {
    try {
      const raw = localStorage.getItem(INPUT_AUTOSAVE_KEY);
      if (raw && raw.trim()) setInputText(raw);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    if (!inputText.trim()) {
      try { localStorage.removeItem(INPUT_AUTOSAVE_KEY); } catch { /* ignore */ }
      setAutosaveState('');
      return;
    }
    setAutosaveState('saving');
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(INPUT_AUTOSAVE_KEY, inputText);
        const d = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        setAutosaveState(`已自动保存 ${pad(d.getHours())}:${pad(d.getMinutes())}`);
      } catch { setAutosaveState(''); }
    }, 600);
    return () => clearTimeout(timer);
  }, [inputText]);

  // 阶段流程：① 粘贴试卷 → ② 分段提取 → ③ 词汇表与导出
  const { openStages, setOpenStages, toggleStage, openStage, scrollToId } = useStageFlow<FlowStageId>(['input']);

  const getState = (): VocabState => ({ inputText, level, fieldSelection, vocabList, model });

  const restoreState = (data: VocabState) => {
    setInputText(data.inputText);
    setLevel(data.level);
    setFieldSelection(data.fieldSelection);
    setVocabList(data.vocabList);
    setModel(data.model);
    // 有词汇表 → 直接展开③；分段会在粘贴防抖后自动重新检测
    setOpenStages(data.vocabList ? new Set<FlowStageId>(['table']) : new Set<FlowStageId>(['input']));
    window.scrollTo({ top: 0 });
  };

  // 主页「最近生成 → 打开」：挂载取走交给本模块的记录并恢复（无则 no-op）。
  // 声明在本文件输入草稿恢复 effect（:85-91）之后，记录的 inputText 才能覆盖本机草稿
  useEffect(() => {
    const item = takeHistoryHandoff('vocab');
    if (item) restoreState((item as SavedItem<VocabState>).data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSave = () => {
    const name = window.prompt('保存名称：', `${MODULE_LABELS.vocab} ${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`);
    if (!name) return;
    // W6：存储已满时明确告知，而不是静默失败让用户以为保存成功
    if (!manualSave('vocab', name, getState())) {
      setError('保存失败：浏览器本地存储空间已满，请打开「历史记录」删除部分旧条目后重试');
    }
  };

  useEffect(() => {
    setFabCallbacks(handleSave, () => setShowHistory(true));
    return () => setFabCallbacks(null, null);
  });

  // Auto-save when vocabList changes (after generation)
  useEffect(() => {
    if (vocabList && vocabList.length > 0) {
      autoSave('vocab', { inputText, level, fieldSelection, vocabList, model });
      void refreshAutoTitle('vocab', apiConfig, model, inputText);
    }
  }, [vocabList]);

  /** M1：词条级「换一个」——同词重新生成的条目原位替换（保留 id 与分组） */
  const handleReplaceWord = useCallback((id: number, item: VocabItem) => {
    setVocabList(prev => (prev ?? []).map(w => (w.id === id ? item : w)));
  }, []);

  // ─── Section detection ──────────────────────────
  const handleDetectSections = useCallback(() => {
    if (!inputText.trim()) return;
    // 写作题（应用文写作/书面表达/读后续写）的题干不适合做词汇提取来源
    const parsed = parseSections(inputText, stage).filter(s => !s.name.startsWith('应用文') && !s.name.startsWith('书面表达') && (stage === 'senior' || !s.name.startsWith('读后续写')));
    if (parsed.length === 0) { setError('未检测到有效的试卷段落'); return; }
    setError('');

    /** 根据题型名称决定默认选词量 */
    function defaultWordLevel(name: string): WordLevel {
      if (
        name.startsWith('听力') || name.startsWith('语法填空') || name.startsWith('读后续写') ||
        // 中考题型：小语境段落选词量偏少
        name.startsWith('短文填空') || name.startsWith('选词填空') || name.startsWith('综合填空') ||
        name.startsWith('词汇运用') || name.startsWith('完成句子') || name.startsWith('情景交际') || name.startsWith('单项选择')
      ) return 'fewer';
      if (name.startsWith('完形填空')) return 'more';
      return 'moderate';
    }

    const secs: Section[] = parsed.map((s, i) => ({
      id: i + 1,
      title: s.name,
      content: s.content,
      enabled: true,
      wordLevel: defaultWordLevel(s.name),
      generating: false,
      generated: false,
    }));
    setSections(secs);
    setSectionsDetected(true);
  }, [inputText, stage]);

  // Re-detect when inputText changes (after user stops typing for a bit)
  useEffect(() => {
    if (!inputText.trim()) { setSections([]); setSectionsDetected(false); return; }
    const timer = setTimeout(() => handleDetectSections(), 800);
    return () => clearTimeout(timer);
  }, [inputText, handleDetectSections]);

  // ─── Per-section generation ────────────────────
  const handleGenerateChecked = async () => {
    const checked = sections.filter(s => s.enabled && !s.generated);
    if (checked.length === 0) { setError('请至少勾选一个未生成的段落'); return; }
    if (!apiConfig.apiKey.trim() && !serverMode) { setError('请先登录或填入 API Key'); return; }

    if (!(await confirmSpend(checked.length * 5, `提取 ${checked.length} 段词汇`))) return;
    setError(''); setLoading(true);
    // 开始提取：收起第 ① 步，聚焦第 ② 步的逐段进度
    setOpenStages(prev => { const n = new Set(prev); n.delete('input'); n.add('sections'); return n; });

    let anySuccess = false;
    for (const sec of checked) {
      const wordCount = sec.content.split(/\s+/).length;
      if (wordCount > MAX_WORDS_PER_SECTION) {
        setSections(prev => prev.map(s => s.id === sec.id ? { ...s, error: `超过 ${MAX_WORDS_PER_SECTION} 词限制（当前约 ${wordCount} 词）` } : s));
        continue;
      }
      setSections(prev => prev.map(s => s.id === sec.id ? { ...s, generating: true, error: undefined } : s));

      try {
        const prompt = buildVocabExtractionPrompt(level, sec.wordLevel, fieldSelection, sec.title, stage);
        const result = await extractVocab(apiConfig, model, prompt, sec.content);
        setSections(prev => prev.map(s => s.id === sec.id ? { ...s, generating: false, generated: true } : s));
        anySuccess = true;
        apiReportUsage('vocab_words', result.vocabularies.length); // 看板「词库单词」：上报真实词数（静默）
        // Append result with section name tag
        setVocabList(prev => {
          const merged = result.vocabularies.map((item, idx) => ({ ...item, sectionName: sec.title, id: (prev?.length || 0) + idx + 1 }));
          const combined = [...(prev || []), ...merged];
          // Deduplicate
          const seen = new Map<string, VocabItem>();
          for (const item of combined) {
            const key = item.word.toLowerCase();
            if (!seen.has(key)) seen.set(key, item);
          }
          return Array.from(seen.values()).map((item, idx) => ({ ...item, id: idx + 1 }));
        });
      } catch (e) {
        track('generate_error', 'vocab');
        setSections(prev => prev.map(s => s.id === sec.id ? { ...s, generating: false, error: e instanceof Error ? e.message : '提取失败' } : s));
      }
    }
    setLoading(false);
    if (anySuccess) {
      track('generate_success', 'vocab');
    }
  };

  // 批量提取结束且有成品时，自动展开第 ③ 步词汇表
  const wasLoading = useRef(false);
  useEffect(() => {
    if (wasLoading.current && !loading && vocabList && vocabList.length > 0) {
      setOpenStages(prev => { const n = new Set(prev); n.add('table'); return n; });
      scrollToId(STAGE_ANCHOR.table);
    }
    wasLoading.current = loading;
  }, [loading, vocabList]);

  /** 重试单个失败段落 */
  const handleRetrySection = async (id: number) => {
    const sec = sections.find(s => s.id === id);
    if (!sec || sec.generating) return;
    if (!apiConfig.apiKey.trim() && !serverMode) { setError('请先登录或填入 API Key'); return; }
    setError('');

    const wordCount = sec.content.split(/\s+/).length;
    if (wordCount > MAX_WORDS_PER_SECTION) {
      setSections(prev => prev.map(s => s.id === id ? { ...s, error: `超过 ${MAX_WORDS_PER_SECTION} 词限制（当前约 ${wordCount} 词）` } : s));
      return;
    }

    setSections(prev => prev.map(s => s.id === id ? { ...s, generating: true, error: undefined } : s));

    try {
      const prompt = buildVocabExtractionPrompt(level, sec.wordLevel, fieldSelection, sec.title, stage);
      const result = await extractVocab(apiConfig, model, prompt, sec.content);
      setSections(prev => prev.map(s => s.id === id ? { ...s, generating: false, generated: true } : s));
      apiReportUsage('vocab_words', result.vocabularies.length); // 看板「词库单词」：上报真实词数（静默）
      setVocabList(prev => {
        const merged = result.vocabularies.map((item, idx) => ({ ...item, sectionName: sec.title, id: (prev?.length || 0) + idx + 1 }));
        const combined = [...(prev || []), ...merged];
        const seen = new Map<string, VocabItem>();
        for (const item of combined) {
          const key = item.word.toLowerCase();
          if (!seen.has(key)) seen.set(key, item);
        }
        return Array.from(seen.values()).map((item, idx) => ({ ...item, id: idx + 1 }));
      });
    } catch (e) {
      setSections(prev => prev.map(s => s.id === id ? { ...s, generating: false, error: e instanceof Error ? e.message : '提取失败' } : s));
    }
  };

  const toggleSection = (id: number) => {
    setSections(prev => prev.map(s => s.id === id ? { ...s, enabled: !s.enabled } : s));
  };
  const toggleAll = (on: boolean) => {
    setSections(prev => prev.map(s => ({ ...s, enabled: on })));
  };
  const updateSectionTitle = (id: number, title: string) => {
    setSections(prev => prev.map(s => s.id === id ? { ...s, title } : s));
  };
  const updateSectionContent = (id: number, content: string) => {
    setSections(prev => prev.map(s => s.id === id ? { ...s, content } : s));
  };
  const updateSectionWordLevel = (id: number, wl: WordLevel) => {
    setSections(prev => prev.map(s => s.id === id ? { ...s, wordLevel: wl } : s));
  };

  // ─── Table actions ─────────────────────────────
  const handleDelete = (id: number) => {
    if (!vocabList) return;
    const updated = vocabList.filter(item => item.id !== id).map((item, i) => ({ ...item, id: i + 1 }));
    setVocabList(updated.length > 0 ? updated : null);
  };
  const handleReorder = (newList: VocabItem[]) => {
    setVocabList(newList.map((item, i) => ({ ...item, id: i + 1 })));
  };
  const handleEdit = (id: number, field: keyof VocabItem, value: string) => {
    if (!vocabList) return;
    setVocabList(vocabList.map(item => item.id === id ? { ...item, [field]: value } : item));
  };
  const handleAddWord = (item: VocabItem, sectionName?: string) => {
    setVocabList(prev => {
      const list = prev ? [...prev] : [];
      const tagged = sectionName ? { ...item, sectionName } : item;
      list.push({ ...tagged, id: list.length + 1 });
      return list;
    });
  };
  const toggleField = (key: keyof FieldSelection) => {
    setFieldSelection(prev => ({ ...prev, [key]: !prev[key] }));
  };
  const handleReset = useCallback(() => {
    setInputText(''); setVocabList(null); setError('');
    setSections([]); setSectionsDetected(false);
    setLevel('core');
    setFieldSelection({ ...DEFAULT_FIELD_SELECTION });
    setOpenStages(new Set<FlowStageId>(['input']));
    localStorage.removeItem('vb_history_vocab');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const checkedCount = sections.filter(s => s.enabled).length;
  const pendingCount = sections.filter(s => s.enabled && !s.generated).length;
  const estCost = sections.filter(s => s.enabled && !s.generated).length * 5;
  const generatedCount = sections.filter(s => s.generated).length;
  const generatingAny = loading || sections.some(s => s.generating);

  // ─── 阶段流程派生状态 + 锚点导航 ──────────────────

  const flowStages: FlowStageInfo[] = [
    {
      id: 'input', label: '粘贴试卷',
      done: inputText.trim().length > 0 && sections.length > 0,
      sub: sections.length ? `${sections.length} 个段落` : undefined,
    },
    {
      id: 'sections', label: '分段提取',
      busy: generatingAny,
      done: sections.length > 0 && sections.every(s => s.generated),
      sub: sections.length ? `已生成 ${generatedCount}/${sections.length}` : undefined,
    },
    {
      id: 'table', label: '词汇表',
      ready: !!vocabList,
      sub: vocabList ? `${vocabList.length} 个词汇` : undefined,
    },
  ];

  const vocabGroups = vocabList ? groupBySection(vocabList, stage) : [];

  const tocItems: TocEntry[] = [
    {
      id: STAGE_ANCHOR.input, label: '① 粘贴试卷',
      ...(inputText.trim() && sections.length ? { status: 'done' as const, statusText: '✓' } : {}),
    },
    {
      id: STAGE_ANCHOR.sections, label: '② 分段提取',
      ...(generatingAny ? { status: 'busy' as const, statusText: '⏳' }
        : sections.length && sections.every(s => s.generated) ? { status: 'done' as const, statusText: '✓' } : {}),
    },
    ...sections.map((s): TocEntry => ({
      id: `vf-sec-${s.id}`, label: s.title, depth: 1, parentId: STAGE_ANCHOR.sections,
      ...(s.generating ? { status: 'busy' as const, statusText: '⏳' }
        : s.error ? { status: 'error' as const, statusText: '✕' }
        : s.generated ? { status: 'done' as const, statusText: '✓' } : {}),
    })),
    {
      id: STAGE_ANCHOR.table, label: '③ 词汇表与导出',
      ...(vocabList ? { statusText: `${vocabList.length} 词` } : {}),
    },
    ...vocabGroups.map((g, gi): TocEntry => ({
      id: `${GROUP_ANCHOR_PREFIX}-g${gi}`, label: g.name, depth: 1, parentId: STAGE_ANCHOR.table,
    })),
  ];

  // 滚动联动：阶段 + 段落/分组锚点（按文档顺序；阶段收起时其子锚点不存在，自动跳过）
  const spyIds = [
    STAGE_ANCHOR.input, STAGE_ANCHOR.sections,
    ...(openStages.has('sections') ? sections.map(s => `vf-sec-${s.id}`) : []),
    STAGE_ANCHOR.table,
    ...(openStages.has('table') && vocabList ? vocabGroups.map((_, gi) => `${GROUP_ANCHOR_PREFIX}-g${gi}`) : []),
  ];
  const activeAnchorId = useScrollspy(spyIds);
  const activeStageId = activeAnchorId == null ? null
    : activeAnchorId.startsWith('vf-sec-') ? 'sections'
    : activeAnchorId.startsWith('vf-group-') ? 'table'
    : activeAnchorId.replace('vf-stage-', '');

  /** 跳到任意锚点（阶段卡片 / 段落卡 / 词汇分组）：先展开所属阶段，再滚动 */
  const jumpToAnchor = (anchorId: string) => {
    const stageId: FlowStageId = anchorId.startsWith('vf-sec-') ? 'sections'
      : anchorId.startsWith('vf-group-') ? 'table'
      : (Object.values(STAGE_ANCHOR) as string[]).includes(anchorId) ? anchorId.replace('vf-stage-', '') as FlowStageId
      : 'input';
    openStage(stageId);
    scrollToId(anchorId);
  };

  return (
    <div className="vocab-extractor">
      {/* 页头：标题 + 醒目的保存/历史入口 */}
      <div className="sf-header">
        <div>
          <h2><Icon name="vocab" size={20} /> 试卷词汇提取</h2>
          <p>粘贴{stage === 'junior' ? '中考' : '高考'}英语试卷 → 自动识别题型分段 → 勾选提取词汇 → 编辑导出（每段 5 额度，失败不扣额度）</p>
        </div>
        <div className="sf-header-actions">
          <button className="sf-btn-sm" onClick={handleSave} title="保存当前试卷与词汇表，稍后可从历史记录载入"><Icon name="save" size={16} /> 保存进度</button>
          <button className="sf-btn-sm" onClick={() => setShowHistory(true)} title="载入之前保存的试卷与词汇表"><Icon name="history" size={16} /> 历史记录 / 载入</button>
        </div>
      </div>

      {/* 阶段流程条：吸顶展示 ①→②→③，点击跳转；错误提示常驻可见 */}
      <div className="sf-stepper-wrap">
        <StageStepper stages={flowStages} activeId={activeStageId} onJump={(id) => jumpToAnchor(`vf-stage-${id}`)} />
        {error && <ErrorBar error={error} />}
      </div>

      <div className="sf-layout">
        {/* 左侧跟随目录（窄屏隐藏，靠吸顶流程条导航） */}
        <aside className="sf-rail">
          <StageToc items={tocItems} activeId={activeAnchorId} onJump={jumpToAnchor} />
        </aside>

        <div className="sf-main">
          {/* ① 粘贴试卷 */}
          <StageCard anchorId={STAGE_ANCHOR.input} index={1} title="粘贴试卷"
            done={inputText.trim().length > 0 && sections.length > 0}
            meta={sections.length ? `已检测 ${sections.length} 个段落` : ''}
            summary={sections.length ? `${stage === 'junior' ? '中考' : '高考'}试卷 · 已检测 ${sections.length} 个段落` : '尚未粘贴'}
            open={openStages.has('input')} onToggle={() => toggleStage('input')}>
            <div className="level-bar">
              <span className="level-label">词汇等级</span>
              <div className="level-pills">
                {getVocabLevels(stage).map(lv => (
                  <button
                    key={lv.value}
                    className={`level-pill ${level === lv.value ? 'active' : ''}`}
                    onClick={() => setLevel(lv.value as VocabLevel)}
                    disabled={loading}
                    title={lv.description}
                  >
                    {lv.label}
                  </button>
                ))}
              </div>
              <span className="level-desc">{getVocabLevels(stage).find(l => l.value === level)?.description}</span>
            </div>

            {/* Field selection */}
            <div className="field-select-bar">
              <div className="field-select-header" onClick={() => setFieldsExpanded(!fieldsExpanded)}>
                <span className="field-select-arrow">{fieldsExpanded ? '▼' : '▶'}</span>
                <span>选择生成字段</span>
                <span className="field-select-count">{Object.values(fieldSelection).filter(Boolean).length}/{fieldLabels(stage).length} 项</span>
              </div>
              {fieldsExpanded && (
                <div className="field-select-body">
                  {fieldLabels(stage).map(f => (
                    <label key={f.key} className="field-checkbox">
                      <input type="checkbox" checked={fieldSelection[f.key]} onChange={() => toggleField(f.key)} disabled={loading} />
                      {f.label}
                    </label>
                  ))}
                </div>
              )}
            </div>

            {/* Input area */}
            <div className="input-section">
              <div className="input-label-row">
                <label className="input-label" htmlFor="exam-text">试卷内容</label>
                {autosaveState && (
                  <span className={`autosave-hint ${autosaveState === 'saving' ? 'saving' : ''}`}>
                    {autosaveState === 'saving' ? '保存中…' : autosaveState}
                  </span>
                )}
              </div>
              {!inputText.trim() && (
                <SampleFill toolName="试卷词汇提取" onFill={() => setInputText(stage === 'junior' ? SAMPLE_VOCAB_JUNIOR : SAMPLE_VOCAB_SENIOR)} />
              )}
              <textarea id="exam-text" value={inputText} onChange={e => setInputText(e.target.value)}
                placeholder={stage === 'junior'
                  ? `在此粘贴中考英语试卷内容（含题型标题）。例如：\n\n一、听力理解\nText 1\nW: Excuse me, could you tell me how to get to the museum?\nM: Sure. Go straight ahead and turn left at the second crossing...\n\n二、单项选择\n1. My brother is good at ______ basketball after school.\nA. play  B. plays  C. playing  D. played\n\n三、完形填空\nLast summer, I volunteered at a local animal shelter. It was an experience that ___ my life...\n\n四、阅读理解\nA\nWhen I was ten, my family moved to a small town in the mountains. At first I hated everything about it...\n\n五、任务型阅读\n阅读下面短文，根据短文内容完成表格。\n\n六、短文填空\n阅读下面短文，在空白处填入一个适当的单词或括号内单词的正确形式。\n\n七、书面表达\n假设你是李华，请根据以下要点用英语写一篇短文，词数 80-100。`
                  : `在此粘贴高考英语试卷内容（含题型标题）。例如：\n\n第一部分 听力\nText 1\nW: Excuse me, could you tell me how to get to the museum?\nM: Sure. Go straight ahead and turn left at the second crossing...\n\n第二部分 阅读理解\nA\nWhen I was ten, my family moved to a small town in the mountains. At first I hated everything about it...\n\n第三部分 语言运用\n第一节 完形填空\nLast summer, I volunteered at a local animal shelter. It was an experience that ___ my life...`}
                rows={14} disabled={loading} />
            </div>

            <div className="sf-stage-footer">
              {serverMode ? (
                <span className="model-label">模型: {getEffectiveModel('vocab', model)}</span>
              ) : (
                <ModelSelect className="model-select" value={model} onChange={setModel} options={MODEL_OPTIONS} disabled={loading} />
              )}
              <button className="btn-reset" onClick={handleReset} disabled={loading}><Icon name="eraser" size={16} /> 清空</button>
              {sections.length > 0 && (
                <button className="sf-next-btn" onClick={() => jumpToAnchor(STAGE_ANCHOR.sections)}>下一步：核对分段 ↓</button>
              )}
            </div>
          </StageCard>

          {/* ② 分段提取 */}
          <StageCard anchorId={STAGE_ANCHOR.sections} index={2} title="分段提取"
            busy={generatingAny}
            done={sections.length > 0 && sections.every(s => s.generated)}
            meta={sections.length ? `已生成 ${generatedCount}/${sections.length}` : ''}
            summary={sections.length ? `${sections.length} 个段落 · 已生成 ${generatedCount}/${sections.length}` : '尚未检测到段落'}
            open={openStages.has('sections')} onToggle={() => toggleStage('sections')}>
            {sections.length === 0 && (
              <p className="sf-stage-hint">在第 ① 步粘贴试卷后，这里会自动按题型分段（听力、完形填空、阅读理解等）；勾选需要提取的段落并点击「生成选中段落」。每段 ≤2000 词，标题与原文均可编辑。</p>
            )}
            {inputText.trim() && sections.length === 0 && sectionsDetected && (
              <div className="section-hint">未检测到有效段落。请检查文本是否包含题型标题。</div>
            )}

            {/* Section cards */}
            {sections.length > 0 && (
              <div className="section-cards">
                <div className="section-cards-header">
                  <span><Icon name="clipboard" size={16} /> 检测到 {sections.length} 个段落</span>
                  <div className="section-cards-actions">
                    <button className="btn-text" onClick={() => toggleAll(true)}>全选</button>
                    <button className="btn-text" onClick={() => toggleAll(false)}>全不选</button>
                    <span className="est-cost">
                      已选 {checkedCount} 段 · 待生成 {pendingCount} · 预计 {estCost} 额度
                      {quota != null && <> · 余额 {quota}</>}
                    </span>
                    <span className="retry-hint" title="生成失败的段落不会扣除额度，可点击重试">失败不扣额度</span>
                    <button className="btn-extract" onClick={handleGenerateChecked} disabled={loading || pendingCount === 0}>
                      {loading ? '生成中...' : (<><Icon name="sparkles" size={16} /> 生成选中段落 ({pendingCount}段 · {estCost} 额度)</>)}
                    </button>
                  </div>
                </div>

                {sections.map(sec => (
                  <div key={sec.id} id={`vf-sec-${sec.id}`} className={`section-card ${sec.generated ? 'generated' : ''} ${sec.generating ? 'generating' : ''} ${sec.enabled ? '' : 'disabled'}`}>
                    <div className="section-card-bar">
                      <label className="section-check">
                        <input type="checkbox" checked={sec.enabled} onChange={() => toggleSection(sec.id)} disabled={sec.generating} />
                      </label>
                      <input className="section-title-input" value={sec.title}
                        onChange={e => updateSectionTitle(sec.id, e.target.value)} disabled={sec.generating} />
                      <select className="section-count-select" value={sec.wordLevel}
                        onChange={e => updateSectionWordLevel(sec.id, e.target.value as WordLevel)} disabled={sec.generating}>
                        {WORD_LEVELS.map(wl => <option key={wl.value} value={wl.value}>{wl.label}</option>)}
                      </select>
                      {sec.generating && <span className="section-status generating">生成中...</span>}
                      {sec.generated && <span className="section-status done">✓ 已完成</span>}
                      {sec.error && <>
                        <span className="section-status err">✕ {sec.error}</span>
                        <button className="btn-retry-section" onClick={() => handleRetrySection(sec.id)} disabled={sec.generating}>重试</button>
                      </>}
                      {!sec.generating && !sec.generated && !sec.error && (
                        <span className="section-status pending">待生成</span>
                      )}
                      <span className="section-word-count">~{sec.content.split(/\s+/).length} 词</span>
                    </div>
                    <details className="section-details">
                      <summary className="section-summary">查看 / 编辑原文</summary>
                      <textarea className="section-content-textarea" value={sec.content}
                        onChange={e => updateSectionContent(sec.id, e.target.value)}
                        rows={4} disabled={sec.generating} />
                      {sec.content.split(/\s+/).length > MAX_WORDS_PER_SECTION && (
                        <p className="section-warn">该段落超过 {MAX_WORDS_PER_SECTION} 词限制，将无法生成。</p>
                      )}
                    </details>
                  </div>
                ))}
              </div>
            )}
          </StageCard>

          {/* ③ 词汇表与导出 */}
          <StageCard anchorId={STAGE_ANCHOR.table} index={3} title="词汇表与导出"
            meta={vocabList ? `${vocabList.length} 个词汇` : ''}
            summary={vocabList ? `${vocabList.length} 个词汇 · ${vocabGroups.length} 个分组 · 可导出 CSV / Docx` : '尚未生成'}
            open={openStages.has('table')} onToggle={() => toggleStage('table')}>
            {!vocabList && (
              <p className="sf-stage-hint">第 ② 步生成后，词汇表在这里：支持行内编辑、拖拽排序、自定义加词，并可导出 CSV 或 Docx 学案（Docx 可选自测 / 词汇表 / 语法填空 / 词汇清单 / 默写）。</p>
            )}
            {vocabList && (
              <VocabTable
                vocabList={vocabList}
                fieldSelection={fieldSelection}
                apiConfig={apiConfig}
                model={model}
                stage={stage}
                confirmSpend={confirmSpend}
                onReplace={handleReplaceWord}
                onError={setError}
                onDelete={handleDelete}
                onReorder={handleReorder}
                onEdit={handleEdit}
                onAddWord={(sectionName) => { setAddWordSection(sectionName); setShowAddModal(true); }}
                groupAnchorPrefix={GROUP_ANCHOR_PREFIX}
              />
            )}
          </StageCard>
        </div>
      </div>

      {showAddModal && (
        <AddWordModal apiConfig={apiConfig} model={model} sectionName={addWordSection} stage={stage} serverMode={serverMode} onAdd={handleAddWord} onClose={() => setShowAddModal(false)} />
      )}
      {showHistory && (
        <HistoryModal
          module="vocab"
          moduleLabel={MODULE_LABELS.vocab}
          onLoad={(item) => { restoreState((item as SavedItem<VocabState>).data); setShowHistory(false); }}
          onClose={() => setShowHistory(false)}
        />
      )}
      {costDialog}
    </div>
  );
}
