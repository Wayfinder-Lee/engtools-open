import { useState, useEffect, useRef } from 'react';
import type { ApiConfig, LevelCheckResult, PracticalWritingResult, PracticalState, SavedItem, Stage, VocabSection, WritingLevel } from '../types';
import { MODEL_OPTIONS, getPwLevels, WRITING_DEFAULT_MODEL, MODULE_LABELS } from '../types';
import { generatePracticalWriting, rewriteParagraph, rewriteEssayAtLevel, checkWritingLevel } from '../services/llm';
import { buildPracticalWritingPrompt, buildParagraphRewritePrompt, buildEssayLevelRewritePrompt, buildLevelCheckPrompt, PARAGRAPH_REWRITE_SYSTEM, ESSAY_REWRITE_SYSTEM, LEVEL_CHECK_SYSTEM } from '../prompts/writingPrompts';
import { getEffectiveModel } from '../utils/model';
import { exportPracticalWritingDocx } from '../services/docxExport';
import { autoSave, manualSave } from '../utils/history';
import { refreshAutoTitle } from '../utils/autoTitle';
import { takeHistoryHandoff } from '../utils/historyHandoff';
import { setFabCallbacks } from './FloatingActions';
import ModelSelect from './ModelSelect';
import HistoryModal from './HistoryModal';
import Spinner from './Spinner';
import ErrorBar from './ErrorBar';
import SampleFill from './SampleFill';
import PromptImageReader from './PromptImageReader';
import { useCostGate } from './CostGate';
import { track } from '../utils/analytics';
import { Icon } from './icons';
import { practicalSample, PRACTICAL_TEMPLATES } from '../data/samples';
import { listWords, type WordBankEntry } from '../utils/wordbank';
import WordPickerModal from './WordPickerModal';
import { StageStepper, StageToc, StageCard, useScrollspy, useStageFlow } from './StageFlow';
import type { FlowStageInfo, TocEntry } from './StageFlow';
import './PracticalWriting.css';

interface Props { apiConfig: ApiConfig; stage: Stage; /** 登录用户当前余额；null = 自带 Key 模式 */ quota?: number | null; }

/** Click-to-edit field: display mode by default, click to reveal input */
function EditableField({ value, onChange, multiline, className }: {
  value: string; onChange: (v: string) => void; multiline?: boolean; className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  const commit = () => { setEditing(false); if (draft !== value) onChange(draft); };
  const cancel = () => { setEditing(false); setDraft(value); };
  const start = () => { setDraft(value); setEditing(true); };

  if (editing) {
    const Tag = multiline ? 'textarea' : 'input';
    return (
      <Tag className={`editable-input ${multiline ? 'editable-textarea' : ''} ${className || ''}`}
        value={draft} onChange={(e) => setDraft((e.target as HTMLInputElement).value)}
        onBlur={commit} autoFocus
        onKeyDown={(e: React.KeyboardEvent) => {
          // isComposing/229 拦输入法选字确认，避免中文内容拼音中途被提交
          if (e.key === 'Enter' && !e.shiftKey && !multiline && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        }}
        rows={multiline ? 6 : 1} />
    );
  }

  return (
    <div className={`editable-display ${className || ''}`} onClick={start} title="点击编辑">
      {value ? (multiline ? <pre className="editable-pre">{value}</pre> : <span>{value}</span>)
        : <span className="cell-empty">点击编辑...</span>}
    </div>
  );
}

// ─── 阶段流程定义 ───────────────────────────────────

type FlowStageId = 'input' | 'result' | 'export';
const STAGE_ANCHOR: Record<FlowStageId, string> = { input: 'pw-stage-input', result: 'pw-stage-result', export: 'pw-stage-export' };

export default function PracticalWriting({ apiConfig, stage, quota }: Props) {
  const [prompt, setPrompt] = useState('');
  const [level, setLevel] = useState<WritingLevel>('formula');
  const [model, setModel] = useState(WRITING_DEFAULT_MODEL);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<PracticalWritingResult | null>(null);
  const [essayWidth, setEssayWidth] = useState(680);
  const [showHistory, setShowHistory] = useState(false);
  // R4：生成要求补充（可选），默认折叠
  const [extraReq, setExtraReq] = useState('');
  const [reqOpen, setReqOpen] = useState(false);
  // R3：词库多选弹窗
  const [showWordPicker, setShowWordPicker] = useState(false);

  // 阶段流程：① 设置题目 → ② 范文与讲解 → ③ 导出
  const { openStages, setOpenStages, toggleStage, openStage, scrollToId } = useStageFlow<FlowStageId>(['input']);

  // 学段叫法：初中「书面表达」/ 高中「应用文」
  const subj = stage === 'junior' ? '书面表达' : '应用文';
  const moduleLabel = stage === 'junior' ? '书面表达学案' : MODULE_LABELS.practical;
  const levelLabel = getPwLevels(stage).find((l) => l.value === level)?.label ?? '';
  const promptDone = prompt.trim().length > 0;

  // Build state snapshot for save
  const getState = (): PracticalState => ({ prompt, level, result, model, extraReq });

  // Restore state from loaded item
  const restoreState = (data: PracticalState) => {
    setPrompt(data.prompt);
    setLevel(data.level);
    setResult(data.result);
    setModel(data.model);
    setExtraReq(data.extraReq ?? '');
    setReqOpen(!!data.extraReq?.trim());
    // 有成品 → 直接展开②③核对/导出；否则停在①
    setOpenStages(data.result ? new Set<FlowStageId>(['result', 'export']) : new Set<FlowStageId>(['input']));
    window.scrollTo({ top: 0 });
  };

  // 主页「最近生成 → 打开」：挂载取走交给本模块的记录并恢复（无则 no-op）
  useEffect(() => {
    const item = takeHistoryHandoff('practical');
    if (item) restoreState((item as SavedItem<PracticalState>).data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Manual save handler
  const handleSave = () => {
    const name = window.prompt('保存名称：', `${moduleLabel} ${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`);
    if (!name) return;
    if (!manualSave('practical', name, getState())) {
      setError('保存失败：浏览器本地存储空间已满，请打开「历史记录」删除部分旧条目后重试');
    }
  };

  // Register FAB callbacks
  useEffect(() => {
    setFabCallbacks(handleSave, () => setShowHistory(true));
    return () => setFabCallbacks(null, null);
  });

  const updateEssayPara = (i: number, v: string) => {
    if (!result) return;
    const arr = [...result.essay]; arr[i] = v;
    setResult({ ...result, essay: arr });
  };

  // ── 话题词汇与句式筛选（undefined = 选中，导出 Docx 时排除 selected === false）──

  const flipSelected = <T extends { selected?: boolean }>(items: T[], idx: number): T[] =>
    items.map((it, j) => (j === idx ? { ...it, selected: it.selected === false ? undefined : false } : it));

  const toggleVocabItem = (si: number, list: 'words' | 'phrases' | 'sentences', idx: number) => {
    if (!result) return;
    const sec = result.vocabSections[si];
    if (!sec) return;
    const next: VocabSection =
      list === 'words' ? { ...sec, words: flipSelected(sec.words ?? [], idx) }
        : list === 'phrases' ? { ...sec, phrases: flipSelected(sec.phrases, idx) }
          : { ...sec, sentences: flipSelected(sec.sentences, idx) };
    const arr = [...result.vocabSections]; arr[si] = next;
    setResult({ ...result, vocabSections: arr });
  };

  const toggleVocabGroup = (si: number, checked: boolean) => {
    if (!result) return;
    const mark = <T extends { selected?: boolean }>(xs: T[]): T[] => xs.map((x) => ({ ...x, selected: checked }));
    const sec = result.vocabSections[si];
    if (!sec) return;
    const arr = [...result.vocabSections];
    arr[si] = { ...sec, words: mark(sec.words ?? []), phrases: mark(sec.phrases), sentences: mark(sec.sentences) };
    setResult({ ...result, vocabSections: arr });
  };

  const vocabGroupAllSelected = (sec: VocabSection): boolean => {
    const all = [...(sec.words ?? []), ...sec.phrases, ...sec.sentences];
    return all.length > 0 && all.every((it) => it.selected !== false);
  };

  const { confirmSpend, costDialog } = useCostGate(quota);
  const serverMode = quota != null;

  const handleGenerate = async () => {
    if (!prompt.trim()) { setError(`请先粘贴${subj}题目题干`); return; }
    if (!apiConfig.apiKey.trim() && !serverMode) { setError('请先登录或填入 API Key'); return; }
    if (!(await confirmSpend(20, `生成${subj}学案`))) return;
    setError(''); setLoading(true);
    // 进入第 ② 步跟踪生成进度，收起第 ① 步
    setOpenStages(new Set<FlowStageId>(['result']));
    scrollToId(STAGE_ANCHOR.result);
    try {
      const systemPrompt = buildPracticalWritingPrompt(prompt, level, stage);
      const userInput = extraReq.trim() ? `${prompt}\n\n生成要求补充：${extraReq.trim()}` : prompt;
      const r = await generatePracticalWriting(apiConfig, model, systemPrompt, userInput);
      setResult(r);
      autoSave('practical', { prompt, level, result: r, model });
      void refreshAutoTitle('practical', apiConfig, model, userInput);
      track('generate_success', 'practical');
    } catch (e) {
      track('generate_error', 'practical');
      setError(e instanceof Error ? e.message : '生成失败');
    } finally { setLoading(false); }
  };

  // 生成结束且有成品时，自动展开第 ③ 步导出
  const wasLoading = useRef(false);
  useEffect(() => {
    if (wasLoading.current && !loading && result) {
      setOpenStages(prev => { const n = new Set(prev); n.add('export'); return n; });
    }
    wasLoading.current = loading;
  }, [loading, result]);

  const handleExport = () => {
    if (!result) return;
    exportPracticalWritingDocx(prompt, result, stage);
    track('export_success', 'practical');
  };

  // ─── M1 块级重新生成 ────────────────────────────
  const [rewritingIdx, setRewritingIdx] = useState<number | null>(null);
  const [rewritingAll, setRewritingAll] = useState(false);

  const essayArr = (): string[] => (Array.isArray(result?.essay) ? (result!.essay as string[]) : result ? [result.essay as unknown as string] : []);

  /** 段落级「换一个」：同功能同水平的另一种表达（3 额度，分句默写同步刷新） */
  const handleRewritePara = async (pi: number) => {
    if (!result || rewritingIdx != null || rewritingAll) return;
    if (!(await confirmSpend(3, '重写本段范文（换一个）'))) return;
    setRewritingIdx(pi); setError('');
    try {
      const r = await rewriteParagraph(apiConfig, model, PARAGRAPH_REWRITE_SYSTEM,
        buildParagraphRewritePrompt({
          paragraph: essayArr()[pi] ?? '', index: pi + 1, fullEssay: essayArr(),
          context: prompt.slice(0, 200), levelLabel, currentDictation: result.dictationSentences,
        }));
      const arr = [...essayArr()];
      arr[pi] = r.paragraph!;
      setResult({
        ...result,
        essay: arr,
        // R1：默写部分随新范文同步更换（模型返回空列表时保留原默写）
        ...(r.dictationSentences.length > 0 ? { dictationSentences: r.dictationSentences } : {}),
      });
      track('generate_success', 'rewrite');
    } catch (e) {
      track('generate_error', 'rewrite');
      setError(e instanceof Error ? e.message : '重写失败');
    } finally { setRewritingIdx(null); }
  };

  /** 整篇按当前层次重写（8 额度） */
  const handleRewriteEssayLevel = async () => {
    if (!result || rewritingAll || rewritingIdx != null) return;
    const paras = essayArr();
    if (paras.length === 0) return;
    if (!(await confirmSpend(8, `按「${levelLabel}」层次重写全篇范文`))) return;
    setRewritingAll(true); setError('');
    try {
      const rule = getPwLevels(stage).find((l) => l.value === level)?.description ?? '';
      const r = await rewriteEssayAtLevel(apiConfig, model, ESSAY_REWRITE_SYSTEM,
        buildEssayLevelRewritePrompt({
          paragraphs: paras, context: prompt.slice(0, 200), levelRule: rule, levelLabel,
          currentDictation: result.dictationSentences,
        }));
      setResult({
        ...result,
        essay: r.paragraphs!,
        ...(r.dictationSentences.length > 0 ? { dictationSentences: r.dictationSentences } : {}),
      });
      track('generate_success', 'rewrite_essay');
    } catch (e) {
      track('generate_error', 'rewrite_essay');
      setError(e instanceof Error ? e.message : '重写失败');
    } finally { setRewritingAll(false); }
  };

  // ─── M4 难度自检 ────────────────────────────────
  const [levelCheck, setLevelCheck] = useState<LevelCheckResult | null>(null);
  const [checking, setChecking] = useState(false);

  const handleLevelCheck = async () => {
    if (!result || checking) return;
    if (!(await confirmSpend(2, '难度自检'))) return;
    setChecking(true); setError(''); setLevelCheck(null);
    try {
      const r = await checkWritingLevel(apiConfig, model, LEVEL_CHECK_SYSTEM,
        buildLevelCheckPrompt({ stage, promptText: prompt, paragraphs: essayArr() }));
      setLevelCheck(r);
      track('generate_success', 'level_check');
    } catch (e) {
      track('generate_error', 'level_check');
      setError(e instanceof Error ? e.message : '难度自检失败');
    } finally { setChecking(false); }
  };

  // ─── 阶段流程派生状态 + 锚点导航 ──────────────────

  const flowStages: FlowStageInfo[] = [
    { id: 'input', label: '设置题目', done: promptDone },
    { id: 'result', label: '范文与讲解', busy: loading, done: !!result },
    { id: 'export', label: '导出', ready: !!result },
  ];

  const RESULT_SEC_ANCHORS = ['pw-sec-essay', 'pw-sec-analysis', 'pw-sec-vocab', 'pw-sec-template', 'pw-sec-dictation'];

  const tocItems: TocEntry[] = [
    { id: STAGE_ANCHOR.input, label: '① 设置题目', ...(promptDone ? { status: 'done' as const, statusText: '✓' } : {}) },
    {
      id: STAGE_ANCHOR.result, label: '② 范文与讲解',
      ...(loading ? { status: 'busy' as const, statusText: '⏳' } : result ? { status: 'done' as const, statusText: '✓' } : {}),
    },
    ...(result ? [
      { id: 'pw-sec-essay', label: '参考范文', depth: 1 as const, parentId: STAGE_ANCHOR.result },
      { id: 'pw-sec-analysis', label: '文章分析', depth: 1 as const, parentId: STAGE_ANCHOR.result },
      { id: 'pw-sec-vocab', label: '话题词汇与句式', depth: 1 as const, parentId: STAGE_ANCHOR.result },
      { id: 'pw-sec-template', label: '写作模板', depth: 1 as const, parentId: STAGE_ANCHOR.result },
      { id: 'pw-sec-dictation', label: '分句默写', depth: 1 as const, parentId: STAGE_ANCHOR.result },
    ] : []),
    { id: STAGE_ANCHOR.export, label: '③ 导出学案', ...(result ? { statusText: 'Docx' } : {}) },
  ];

  // 滚动联动：阶段 + 结果分区锚点（按文档顺序）
  const spyIds = [
    STAGE_ANCHOR.input, STAGE_ANCHOR.result,
    ...(result && !loading ? RESULT_SEC_ANCHORS : []),
    STAGE_ANCHOR.export,
  ];
  const activeAnchorId = useScrollspy(spyIds);
  const activeStageId = activeAnchorId == null ? null
    : activeAnchorId.startsWith('pw-sec-') ? 'result'
    : activeAnchorId.replace('pw-stage-', '');

  /** 跳到任意锚点（阶段卡片 / 结果分区）：先展开所属阶段，再滚动 */
  const jumpToAnchor = (anchorId: string) => {
    const stageId: FlowStageId = anchorId.startsWith('pw-sec-') ? 'result'
      : (Object.values(STAGE_ANCHOR) as string[]).includes(anchorId) ? anchorId.replace('pw-stage-', '') as FlowStageId
      : 'input';
    openStage(stageId);
    scrollToId(anchorId);
  };

  return (
    <div className="writing-module">
      {/* 页头：标题 + 醒目的保存/历史入口 */}
      <div className="sf-header">
        <div>
          <h2><Icon name="practical" size={20} /> 应用文学案制作</h2>
          <p>设置{stage === 'junior' ? '中考书面表达' : '高考应用文'}题目 → 生成范文与讲解 → 核对修改 → 导出学案</p>
        </div>
        <div className="sf-header-actions">
          <button className="sf-btn-sm" onClick={handleSave} title="保存当前题目与结果，稍后可从历史记录载入"><Icon name="save" size={16} /> 保存进度</button>
          <button className="sf-btn-sm" onClick={() => setShowHistory(true)} title="载入之前保存的题目与结果"><Icon name="history" size={16} /> 历史记录 / 载入</button>
        </div>
      </div>

      {/* 阶段流程条：吸顶展示 ①→②→③，点击跳转；错误提示常驻可见 */}
      <div className="sf-stepper-wrap">
        <StageStepper stages={flowStages} activeId={activeStageId} onJump={(id) => jumpToAnchor(`pw-stage-${id}`)} />
        {error && <ErrorBar error={error} onRetry={handleGenerate} />}
      </div>

      <div className="sf-layout">
        {/* 左侧跟随目录（窄屏隐藏，靠吸顶流程条导航） */}
        <aside className="sf-rail">
          <StageToc items={tocItems} activeId={activeAnchorId} onJump={jumpToAnchor} />
        </aside>

        <div className="sf-main">
          {/* ① 设置题目 */}
          <StageCard anchorId={STAGE_ANCHOR.input} index={1} title="设置题目"
            done={promptDone}
            meta={`${subj} · ${levelLabel}`}
            summary={`${subj}题目 · 层次「${levelLabel}」 · ${promptDone ? '题干已填写' : '题干未填写'}`}
            open={openStages.has('input')} onToggle={() => toggleStage('input')}>
            <div className="level-bar">
              <span className="level-label">范文层次</span>
              <div className="level-pills">
                {getPwLevels(stage).map((lv) => (
                  <button
                    key={lv.value}
                    className={`level-pill ${level === lv.value ? 'active' : ''}`}
                    onClick={() => setLevel(lv.value)}
                    disabled={loading}
                    title={lv.description}
                  >
                    {lv.label}
                  </button>
                ))}
              </div>
              <span className="level-desc">{getPwLevels(stage).find((l) => l.value === level)?.description}</span>
            </div>

            <div className="input-section">
              <label className="input-label" htmlFor="pw-prompt">{subj}题目题干</label>
              {/* 体裁模板（W3）：点选即填可再编辑 */}
              {!prompt.trim() && (
                <div className="pw-template-row">
                  <span className="pw-template-label">常见体裁：</span>
                  {PRACTICAL_TEMPLATES.map((t) => (
                    <button key={t.label} type="button" className="pw-template-chip"
                      onClick={() => setPrompt(t.text)} disabled={loading}>{t.label}</button>
                  ))}
                </div>
              )}
              {/* M3：从共享词库插入话题词（提示词末尾追加，可再编辑） */}
              <div className="pw-template-row">
                <button
                  type="button"
                  className="pw-template-chip pw-bank-chip"
                  disabled={loading}
                  title="把共享词库里的词作为话题词汇追加到题干提示中（LLM 会在范文里使用它们）"
                  onClick={() => {
                    const words = listWords().slice(0, 12);
                    if (words.length === 0) { setError('词库为空：先在「试卷词汇提取」里「存入词库」，再回来插入话题词'); return; }
                    const line = `\n\n请适当使用以下话题词汇：${words.map((w) => w.word).join(', ')}。`;
                    setPrompt((prev) => prev.trimEnd() + line);
                  }}
                ><Icon name="wordbank" size={16} /> 从词库插话题词</button>
                <span className="pw-template-label">把词库里存的词喂给范文（可先删减）</span>
              </div>
              {!prompt.trim() && (
                <SampleFill toolName="应用文学案" onFill={() => setPrompt(practicalSample(stage))} />
              )}
              <textarea id="pw-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)}
                placeholder={stage === 'junior'
                  ? `例如：假定你是李华，你的英国朋友 Peter 来信询问你校学生体育运动情况。请你给他回信，内容包括：\n1. 学校的体育场馆；\n2. 主要的运动项目；\n3. 你喜欢的项目。\n注意：1. 词数 80-100；2. 可以适当增加细节，以使行文连贯。`
                  : `例如：假定你是李华，你的英国朋友 Peter 来信询问你校学生体育运动情况。请你给他回信，内容包括：\n1. 学校的体育场馆；\n2. 主要的运动项目；\n3. 你喜欢的项目。\n注意：1. 词数 100 左右；2. 可以适当增加细节，以使行文连贯。`}
                rows={10} disabled={loading} />

              {/* 看图/图表作文：配图 AI 读图转文字，核对后并入题干（空题干直接设值，不留前导空行） */}
              <PromptImageReader apiConfig={apiConfig} quota={quota} disabled={loading}
                onInsert={(block) => setPrompt((prev) => prev.trimEnd() ? prev.trimEnd() + '\n\n' + block : block)} />

              {/* R4：生成要求补充（可选），默认折叠——与读后续写一致放在输入区内 */}
              <button type="button" className="req-toggle" style={{ marginTop: 12 }}
                onClick={() => setReqOpen((o) => !o)} aria-expanded={reqOpen}>
                <span className="req-toggle-arrow">{reqOpen ? '▾' : '▶'}</span> 生成要求补充（可选）{extraReq.trim() ? <span className="req-toggle-badge">已填写</span> : <span className="req-toggle-hint">词数 / 人称 / 话题词 / 特殊要求</span>}
                <span className="req-toggle-spacer" />
                <span
                  role="button" tabIndex={0} className="req-toggle-chip"
                  onClick={(e) => { e.stopPropagation(); setShowWordPicker(true); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setShowWordPicker(true); } }}
                  title="从共享词库多选话题词汇，插入到生成要求中"
                ><Icon name="wordbank" size={16} /> 从词库插要求</span>
              </button>
              {reqOpen && (
                <textarea
                  value={extraReq} onChange={(e) => setExtraReq(e.target.value)}
                  placeholder="如：词数 100 左右；用第一人称；正式语气；适当使用词库话题词……"
                  rows={3} disabled={loading} style={{ marginTop: 8 }}
                />
              )}
            </div>

            <div className="sf-stage-footer">
              {serverMode ? (
                <span className="model-label">模型: {getEffectiveModel('practical', model)}</span>
              ) : (
                <ModelSelect className="model-select" value={model} onChange={setModel} options={MODEL_OPTIONS} disabled={loading} />
              )}
              <button className="btn-extract" onClick={handleGenerate} disabled={loading || !prompt.trim()}>
                {loading ? '生成中...' : (<><Icon name="sparkles" size={16} /> 生成{subj}学案{quota != null ? ' · 20 额度' : ''}</>)}
              </button>
            </div>
          </StageCard>

          {/* ② 范文与讲解 */}
          <StageCard anchorId={STAGE_ANCHOR.result} index={2} title="范文与讲解"
            busy={loading} done={!!result}
            meta={result ? '已生成' : ''}
            summary={result ? '范文 / 分析 / 词汇句式 / 模板 / 默写（点击展开修改）' : '尚未生成'}
            open={openStages.has('result')} onToggle={() => toggleStage('result')}>
            {loading && (
              <Spinner
                showProgress
                text={`正在生成${subj}学案...`}
                messages={['正在审题并确定体裁与语气...', '正在撰写范文与逐段讲解...', '正在整理话题词汇与写作模板...', '正在生成分句默写材料...', '即将完成，请耐心等待...']}
              />
            )}
            {!loading && !result && (
              <p className="sf-stage-hint">完成第 ① 步后点击「生成学案」，参考范文与完整讲解将在这里展示，全部内容均可点击修改。</p>
            )}
            {result && !loading && (
              <div className="result-sections">
                {/* M4 难度自检：课标内/超纲点检查 */}
                <div className="level-check-row">
                  <button className="para-rewrite-btn" onClick={handleLevelCheck} disabled={checking}
                    title="检查范文词汇与语法是否匹配当前学段要求（2 额度）">
                    {checking ? '检查中…' : (<><Icon name="search" size={16} /> 难度自检（课标匹配）· 2 额度</>)}
                  </button>
                  {levelCheck && (
                    <div className={`level-check-panel ${levelCheck.verdict === 'ok' ? 'ok' : 'warn'}`}>
                      <strong>{levelCheck.verdict === 'ok' ? '✅ ' : '⚠️ '}{levelCheck.summary}</strong>
                      {levelCheck.warnings.length > 0 && (
                        <ul>{levelCheck.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
                      )}
                    </div>
                  )}
                </div>
                {/* Essay with width slider */}
                <section className="result-section" id="pw-sec-essay">
                  <div className="section-header-row">
                    <h3>二、参考范文</h3>
                    <button
                      className="para-rewrite-btn"
                      onClick={handleRewriteEssayLevel}
                      disabled={rewritingAll || rewritingIdx != null || loading}
                      title="保持段落结构，按当前选择的层次重写全篇"
                    >
                      {rewritingAll ? '重写中…' : (<><Icon name="refresh" size={16} /> 按「{levelLabel}」层次重写全篇{serverMode ? ' · 8 额度' : ''}</>)}
                    </button>
                    <div className="width-control">
                      <label>行宽</label>
                      <input type="range" min={360} max={960} step={40} value={essayWidth}
                        onChange={(e) => setEssayWidth(Number(e.target.value))} />
                      <span className="width-value">{essayWidth}px</span>
                    </div>
                  </div>
                  <div className="essay-blocks" style={{ maxWidth: essayWidth }}>
                    {(Array.isArray(result.essay) ? result.essay : [result.essay as unknown as string]).map((para, pi) => (
                      <div key={pi} className="essay-block">
                        <EditableField value={para} multiline onChange={(v) => updateEssayPara(pi, v)} />
                        <button
                          className="para-rewrite-btn para-rewrite-inline"
                          onClick={() => handleRewritePara(pi)}
                          disabled={rewritingIdx != null || rewritingAll || loading}
                          title="同功能、同水平，换一种表达（只替换本段）"
                        >
                          {rewritingIdx === pi ? '重写中…' : `↻ 换一个${serverMode ? ' · 3 额度' : ''}`}
                        </button>
                      </div>
                    ))}
                  </div>
                </section>

                {/* Analysis */}
                <section className="result-section" id="pw-sec-analysis">
                  <h3>三、文章分析</h3>
                  <div className="info-grid">
                    <div><strong>体裁：</strong>
                      <EditableField value={result.analysis.genre}
                        onChange={(v) => setResult({ ...result, analysis: { ...result.analysis, genre: v } })} />
                      {!!result.analysis.genreEn && (<>
                        <strong>EN：</strong>
                        <EditableField value={result.analysis.genreEn}
                          onChange={(v) => setResult({ ...result, analysis: { ...result.analysis, genreEn: v } })} />
                      </>)}
                    </div>
                    <div><strong>语气：</strong>
                      <EditableField value={result.analysis.tone}
                        onChange={(v) => setResult({ ...result, analysis: { ...result.analysis, tone: v } })} /></div>
                    <div><strong>结构：</strong>
                      <EditableField value={result.analysis.structure}
                        onChange={(v) => setResult({ ...result, analysis: { ...result.analysis, structure: v } })} /></div>
                  </div>
                  <div className="key-points">
                    <strong>信息点覆盖：</strong>
                    <EditableField value={result.analysis.keyPoints.join('\n')} multiline
                      onChange={(v) => setResult({ ...result, analysis: { ...result.analysis, keyPoints: v.split('\n').filter(Boolean) } })} />
                  </div>
                </section>

                {/* Vocab Sections */}
                <section className="result-section" id="pw-sec-vocab">
                  <h3>四、话题词汇与句式</h3>
                  <p className="vocab-hint">勾选的内容将导出到 Docx 学案；取消勾选的条目不会出现在导出的学案中。</p>
                  {result.vocabSections.map((section, si) => (
                    <div key={si} className="vocab-section">
                      <h4>
                        <span>{si + 1}. {section.title} — {section.description}</span>
                        <button className="group-toggle" onClick={() => toggleVocabGroup(si, !vocabGroupAllSelected(section))}>
                          {vocabGroupAllSelected(section) ? '全不选' : '全选'}
                        </button>
                      </h4>
                      {(section.words ?? []).length > 0 && (
                        <div className="vocab-sub">
                          <strong>【单词】</strong>
                          <ol className="phrase-list">
                            {(section.words ?? []).map((w, wi) => (
                              <li key={wi} className={w.selected === false ? 'item-unchecked' : ''}>
                                <input type="checkbox" className="item-check" checked={w.selected !== false}
                                  onChange={() => toggleVocabItem(si, 'words', wi)} />
                                <EditableField value={w.en}
                                  onChange={(v) => { const arr = [...result.vocabSections]; arr[si] = { ...arr[si], words: (arr[si].words ?? []).map((x, j) => j === wi ? { ...x, en: v } : x) }; setResult({ ...result, vocabSections: arr }); }} />
                                <span className="phrase-cn">{w.cn}</span>
                              </li>
                            ))}
                          </ol>
                        </div>
                      )}
                      <div className="vocab-sub">
                        <strong>【短语】</strong>
                        <ol className="phrase-list">
                          {section.phrases.map((p, pi) => (
                            <li key={pi} className={p.selected === false ? 'item-unchecked' : ''}>
                              <input type="checkbox" className="item-check" checked={p.selected !== false}
                                onChange={() => toggleVocabItem(si, 'phrases', pi)} />
                              <EditableField value={p.en}
                                onChange={(v) => { const arr = [...result.vocabSections]; arr[si] = { ...arr[si], phrases: arr[si].phrases.map((ph, j) => j === pi ? { ...ph, en: v } : ph) }; setResult({ ...result, vocabSections: arr }); }} />
                              <span className="phrase-cn">{p.cn}</span>
                            </li>
                          ))}
                        </ol>
                      </div>
                      <div className="vocab-sub">
                        <strong>【句式】</strong>
                        {section.sentences.map((s, ssi) => (
                          <div key={ssi} className={`sentence-item${s.selected === false ? ' item-unchecked' : ''}`}>
                            <div className="sentence-en-row">
                              <input type="checkbox" className="item-check" checked={s.selected !== false}
                                onChange={() => toggleVocabItem(si, 'sentences', ssi)} />
                              <EditableField value={s.en} multiline
                                onChange={(v) => { const arr = [...result.vocabSections]; arr[si] = { ...arr[si], sentences: arr[si].sentences.map((se, j) => j === ssi ? { ...se, en: v } : se) }; setResult({ ...result, vocabSections: arr }); }} />
                            </div>
                            <EditableField value={s.cn}
                              onChange={(v) => { const arr = [...result.vocabSections]; arr[si] = { ...arr[si], sentences: arr[si].sentences.map((se, j) => j === ssi ? { ...se, cn: v } : se) }; setResult({ ...result, vocabSections: arr }); }} />
                            {s.note && <span className="sentence-note">（{s.note}）</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </section>

                {/* Template */}
                <section className="result-section" id="pw-sec-template">
                  <h3>五、写作模板</h3>
                  {(Array.isArray(result.template) ? result.template : [result.template as unknown as string]).map((para, pi) => (
                    <div key={pi} className="essay-block">
                      <EditableField value={para} multiline
                        onChange={(v) => {
                          const arr = Array.isArray(result.template) ? [...result.template] : [result.template as unknown as string];
                          arr[pi] = v;
                          setResult({ ...result, template: arr });
                        }} />
                    </div>
                  ))}
                </section>

                {/* Dictation */}
                <section className="result-section" id="pw-sec-dictation">
                  <h3>六、分句默写翻译</h3>
                  <ol className="dictation-list">
                    {result.dictationSentences.map((ds, i) => (
                      <li key={i}>
                        <span className="dict-cn">{ds.cn}
                          {ds.pattern && <span className="dict-pattern-hint"> [{ds.pattern}]</span>}
                        </span>
                        <EditableField value={ds.en}
                          onChange={(v) => {
                            const arr = [...result.dictationSentences];
                            arr[i] = { ...arr[i], en: v };
                            setResult({ ...result, dictationSentences: arr });
                          }} />
                      </li>
                    ))}
                  </ol>
                </section>
              </div>
            )}
          </StageCard>

          {/* ③ 导出学案 */}
          <StageCard anchorId={STAGE_ANCHOR.export} index={3} title="导出学案"
            meta={result ? 'Docx 可导出' : ''}
            summary={result ? '可导出 Docx 学案' : '生成后可导出'}
            open={openStages.has('export')} onToggle={() => toggleStage('export')}>
            <div className="input-actions">
              <button className="btn-export-docx" onClick={handleExport} disabled={!result}><Icon name="exportDoc" size={16} /> 导出 Docx 学案</button>
            </div>
            <p className="sf-stage-hint">学案包含：题目回顾 / 参考范文 / 文章分析 / 勾选的话题词汇与句式 / 写作模板 / 分句默写。第 ② 步中取消勾选的条目不会导出。</p>
          </StageCard>
        </div>
      </div>

      {showHistory && (
        <HistoryModal
          module="practical"
          moduleLabel={moduleLabel}
          onLoad={(item) => { restoreState((item as SavedItem<PracticalState>).data); setShowHistory(false); }}
          onClose={() => setShowHistory(false)}
        />
      )}
      {showWordPicker && (
        <WordPickerModal
          title="选择话题词汇"
          hint="选中的词会以「请适当使用以下话题词汇」追加到生成要求中，生成后可再修改"
          entries={listWords()}
          onConfirm={(picked: WordBankEntry[]) => {
            setShowWordPicker(false);
            setReqOpen(true);
            const line = `请适当使用以下话题词汇：${picked.map((w) => w.word).join(', ')}。`;
            setExtraReq((prev) => (prev.trim() ? `${prev.trimEnd()} ${line}` : line));
          }}
          onClose={() => setShowWordPicker(false)}
        />
      )}
      {costDialog}
    </div>
  );
}
