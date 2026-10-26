import { useState, useEffect, useRef } from 'react';
import type { ApiConfig, ContinuationWritingResult, ContinuationState, SavedItem, WritingLevel } from '../types';
import { MODEL_OPTIONS, CW_LEVELS, WRITING_DEFAULT_MODEL, MODULE_LABELS } from '../types';
import { generateContinuationWriting, rewriteParagraph } from '../services/llm';
import { buildContinuationWritingPrompt, buildParagraphRewritePrompt, PARAGRAPH_REWRITE_SYSTEM } from '../prompts/writingPrompts';
import { getEffectiveModel } from '../utils/model';
import { exportContinuationWritingDocx } from '../services/docxExport';
import { autoSave, manualSave } from '../utils/history';
import { refreshAutoTitle } from '../utils/autoTitle';
import { takeHistoryHandoff } from '../utils/historyHandoff';
import { setFabCallbacks } from './FloatingActions';
import ModelSelect from './ModelSelect';
import HistoryModal from './HistoryModal';
import Spinner from './Spinner';
import ErrorBar from './ErrorBar';
import SampleFill from './SampleFill';
import { useCostGate } from './CostGate';
import { track } from '../utils/analytics';
import { Icon } from './icons';
import { SAMPLE_CONTINUATION } from '../data/samples';
import { listWords, type WordBankEntry } from '../utils/wordbank';
import WordPickerModal from './WordPickerModal';
import { StageStepper, StageToc, StageCard, useScrollspy, useStageFlow } from './StageFlow';
import type { FlowStageInfo, TocEntry } from './StageFlow';
import './PracticalWriting.css';

interface Props { apiConfig: ApiConfig; /** 登录用户当前余额；null = 自带 Key 模式 */ quota?: number | null; }

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
const STAGE_ANCHOR: Record<FlowStageId, string> = { input: 'cw-stage-input', result: 'cw-stage-result', export: 'cw-stage-export' };

export default function ContinuationWriting({ apiConfig, quota }: Props) {
  const [text, setText] = useState('');
  const [hints, setHints] = useState('');
  const [level, setLevel] = useState<WritingLevel>('formula');
  const [model, setModel] = useState(WRITING_DEFAULT_MODEL);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ContinuationWritingResult | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  // R4：生成要求补充默认折叠（载入历史/插话题词时自动展开）
  const [reqOpen, setReqOpen] = useState(false);
  // R3：词库多选弹窗
  const [showWordPicker, setShowWordPicker] = useState(false);

  // 阶段流程：① 输入前文 → ② 续写与讲解 → ③ 导出
  const { openStages, setOpenStages, toggleStage, openStage, scrollToId } = useStageFlow<FlowStageId>(['input']);

  const levelLabel = CW_LEVELS.find((l) => l.value === level)?.label ?? '';
  const textDone = text.trim().length > 0;

  const getState = (): ContinuationState => ({ text, hints, level, result, model });

  const restoreState = (data: ContinuationState) => {
    setText(data.text);
    setHints(data.hints);
    setReqOpen(!!data.hints?.trim());
    setLevel(data.level);
    setResult(data.result);
    setModel(data.model);
    // 有成品 → 直接展开②③核对/导出；否则停在①
    setOpenStages(data.result ? new Set<FlowStageId>(['result', 'export']) : new Set<FlowStageId>(['input']));
    window.scrollTo({ top: 0 });
  };

  // 主页「最近生成 → 打开」：挂载取走交给本模块的记录并恢复（无则 no-op）
  useEffect(() => {
    const item = takeHistoryHandoff('continuation');
    if (item) restoreState((item as SavedItem<ContinuationState>).data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSave = () => {
    const name = window.prompt('保存名称：', `${MODULE_LABELS.continuation} ${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`);
    if (!name) return;
    if (!manualSave('continuation', name, getState())) {
      setError('保存失败：浏览器本地存储空间已满，请打开「历史记录」删除部分旧条目后重试');
    }
  };

  useEffect(() => {
    setFabCallbacks(handleSave, () => setShowHistory(true));
    return () => setFabCallbacks(null, null);
  });

  const { confirmSpend, costDialog } = useCostGate(quota);
  const serverMode = quota != null;

  const handleGenerate = async () => {
    if (!text.trim()) { setError('请先粘贴读后续写前文'); return; }
    if (!apiConfig.apiKey.trim() && !serverMode) { setError('请先登录或填入 API Key'); return; }
    if (!(await confirmSpend(30, '生成读后续写学案'))) return;
    setError(''); setLoading(true);
    // 进入第 ② 步跟踪生成进度，收起第 ① 步
    setOpenStages(new Set<FlowStageId>(['result']));
    scrollToId(STAGE_ANCHOR.result);
    try {
      const systemPrompt = buildContinuationWritingPrompt(text, hints, level);
      const r = await generateContinuationWriting(apiConfig, model, systemPrompt, text);
      setResult(r);
      autoSave('continuation', { text, hints, level, result: r, model });
      void refreshAutoTitle('continuation', apiConfig, model, text);
      track('generate_success', 'continuation');
    } catch (e) {
      track('generate_error', 'continuation');
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
    exportContinuationWritingDocx(text, result);
    track('export_success', 'continuation');
  };

  // ─── M1 段落级「换一个」─────────────────────────
  const [rewritingPara, setRewritingPara] = useState<1 | 2 | null>(null);
  const cwLevelLabel = CW_LEVELS.find((l) => l.value === level)?.label ?? '';

  const handleRewriteContPara = async (which: 1 | 2) => {
    if (!result || rewritingPara != null) return;
    if (!(await confirmSpend(3, '重写本段续写范文（换一个）'))) return;
    setRewritingPara(which); setError('');
    try {
      const paragraph = which === 1 ? result.continuation.paragraph1 : result.continuation.paragraph2;
      const r = await rewriteParagraph(apiConfig, model, PARAGRAPH_REWRITE_SYSTEM,
        buildParagraphRewritePrompt({
          paragraph, index: which,
          fullEssay: [result.continuation.paragraph1, result.continuation.paragraph2],
          context: `读后续写：两段范文需衔接段首句与前文情节。原文梗概：${text.slice(0, 160)}`,
          levelLabel: cwLevelLabel, currentDictation: result.dictationSentences,
        }));
      const updated = which === 1
        ? { ...result, continuation: { ...result.continuation, paragraph1: r.paragraph! } }
        : { ...result, continuation: { ...result.continuation, paragraph2: r.paragraph! } };
      setResult({
        ...updated,
        ...(r.dictationSentences.length > 0 ? { dictationSentences: r.dictationSentences } : {}),
      });
      track('generate_success', 'rewrite');
    } catch (e) {
      track('generate_error', 'rewrite');
      setError(e instanceof Error ? e.message : '重写失败');
    } finally { setRewritingPara(null); }
  };

  // ─── 阶段流程派生状态 + 锚点导航 ──────────────────

  const flowStages: FlowStageInfo[] = [
    { id: 'input', label: '输入前文', done: textDone },
    { id: 'result', label: '续写与讲解', busy: loading, done: !!result },
    { id: 'export', label: '导出', ready: !!result },
  ];

  const RESULT_SEC_ANCHORS = ['cw-sec-essay', 'cw-sec-characters', 'cw-sec-conflict', 'cw-sec-tensentence', 'cw-sec-patterns', 'cw-sec-dictation'];

  const tocItems: TocEntry[] = [
    { id: STAGE_ANCHOR.input, label: '① 输入前文', ...(textDone ? { status: 'done' as const, statusText: '✓' } : {}) },
    {
      id: STAGE_ANCHOR.result, label: '② 续写与讲解',
      ...(loading ? { status: 'busy' as const, statusText: '⏳' } : result ? { status: 'done' as const, statusText: '✓' } : {}),
    },
    ...(result ? [
      { id: 'cw-sec-essay', label: '参考续写范文', depth: 1 as const, parentId: STAGE_ANCHOR.result },
      { id: 'cw-sec-characters', label: '人物分析', depth: 1 as const, parentId: STAGE_ANCHOR.result },
      { id: 'cw-sec-conflict', label: '剧情矛盾分析', depth: 1 as const, parentId: STAGE_ANCHOR.result },
      { id: 'cw-sec-tensentence', label: '十句五定法', depth: 1 as const, parentId: STAGE_ANCHOR.result },
      { id: 'cw-sec-patterns', label: '常用句式', depth: 1 as const, parentId: STAGE_ANCHOR.result },
      { id: 'cw-sec-dictation', label: '句式默写', depth: 1 as const, parentId: STAGE_ANCHOR.result },
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
    : activeAnchorId.startsWith('cw-sec-') ? 'result'
    : activeAnchorId.replace('cw-stage-', '');

  /** 跳到任意锚点（阶段卡片 / 结果分区）：先展开所属阶段，再滚动 */
  const jumpToAnchor = (anchorId: string) => {
    const stageId: FlowStageId = anchorId.startsWith('cw-sec-') ? 'result'
      : (Object.values(STAGE_ANCHOR) as string[]).includes(anchorId) ? anchorId.replace('cw-stage-', '') as FlowStageId
      : 'input';
    openStage(stageId);
    scrollToId(anchorId);
  };

  return (
    <div className="writing-module">
      {/* 页头：标题 + 醒目的保存/历史入口 */}
      <div className="sf-header">
        <div>
          <h2><Icon name="continuation" size={20} /> 读后续写学案制作</h2>
          <p>粘贴读后续写前文（含两段续写首句）→ 生成续写范文、人物/剧情分析、十句五定法、常用句式与默写 → 导出学案</p>
        </div>
        <div className="sf-header-actions">
          <button className="sf-btn-sm" onClick={handleSave} title="保存当前前文与结果，稍后可从历史记录载入"><Icon name="save" size={16} /> 保存进度</button>
          <button className="sf-btn-sm" onClick={() => setShowHistory(true)} title="载入之前保存的前文与结果"><Icon name="history" size={16} /> 历史记录 / 载入</button>
        </div>
      </div>

      {/* 阶段流程条：吸顶展示 ①→②→③，点击跳转；错误提示常驻可见 */}
      <div className="sf-stepper-wrap">
        <StageStepper stages={flowStages} activeId={activeStageId} onJump={(id) => jumpToAnchor(`cw-stage-${id}`)} />
        {error && <ErrorBar error={error} onRetry={handleGenerate} />}
      </div>

      <div className="sf-layout">
        {/* 左侧跟随目录（窄屏隐藏，靠吸顶流程条导航） */}
        <aside className="sf-rail">
          <StageToc items={tocItems} activeId={activeAnchorId} onJump={jumpToAnchor} />
        </aside>

        <div className="sf-main">
          {/* ① 输入前文 */}
          <StageCard anchorId={STAGE_ANCHOR.input} index={1} title="输入前文"
            done={textDone}
            meta={`层次「${levelLabel}」`}
            summary={`前文${textDone ? '已输入' : '未输入'} · 层次「${levelLabel}」`}
            open={openStages.has('input')} onToggle={() => toggleStage('input')}>
            <div className="level-bar">
              <span className="level-label">续写层次</span>
              <div className="level-pills">
                {CW_LEVELS.map((lv) => (
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
              <span className="level-desc">{CW_LEVELS.find((l) => l.value === level)?.description}</span>
            </div>

            <div className="input-section">
              <label className="input-label" htmlFor="cw-text">前文内容（含续写段落首句）</label>
              {!text.trim() && (
                <SampleFill toolName="读后续写学案" onFill={() => setText(SAMPLE_CONTINUATION)} />
              )}
              <textarea id="cw-text" value={text} onChange={(e) => setText(e.target.value)}
                placeholder={`粘贴读后续写的完整前文，包括最后给出的两个续写段落的首句。例如：\n\nWhen I was in Grade 9, my father lost his job. To help out, I began delivering newspapers before school. One freezing morning, my bike broke down halfway through my route, and an elderly man named Mr. Carter, whose paper I delivered every day, saw me struggling by the roadside...\n\n注意：续写词数应为 150 左右。\n\nParagraph 1: The next morning, I found a small toolbox sitting outside my door.\nParagraph 2: When I finished the route and returned home, Mr. Carter was waiting there with my father.`}
                rows={16} disabled={loading} />
              {/* R4：生成要求补充（可选），默认折叠 */}
              <button type="button" className="req-toggle" style={{ marginTop: 12 }}
                onClick={() => setReqOpen((o) => !o)} aria-expanded={reqOpen}>
                <span className="req-toggle-arrow">{reqOpen ? '▾' : '▶'}</span> 生成要求补充（可选）{hints.trim() ? <span className="req-toggle-badge">已填写</span> : <span className="req-toggle-hint">词数限制 / 话题词 / 特殊要求</span>}
                <span className="req-toggle-spacer" />
                <span
                  role="button" tabIndex={0} className="req-toggle-chip"
                  onClick={(e) => { e.stopPropagation(); setShowWordPicker(true); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setShowWordPicker(true); } }}
                  title="从共享词库多选话题词汇，插入到生成要求中"
                ><Icon name="wordbank" size={16} /> 从词库插要求</span>
              </button>
              {reqOpen && (
                <textarea id="cw-hints" value={hints} onChange={(e) => setHints(e.target.value)}
                  placeholder="如：词数 120 左右；多用动作描写；围绕「诚实」主题展开……" rows={3} disabled={loading} />
              )}
            </div>

            <div className="sf-stage-footer">
              {serverMode ? (
                <span className="model-label">模型: {getEffectiveModel('continuation', model)}</span>
              ) : (
                <ModelSelect className="model-select" value={model} onChange={setModel} options={MODEL_OPTIONS} disabled={loading} />
              )}
              <button className="btn-extract" onClick={handleGenerate} disabled={loading || !text.trim()}>
                {loading ? '生成中...' : (<><Icon name="sparkles" size={16} /> 生成学案{quota != null ? ' · 30 额度' : ''}</>)}
              </button>
            </div>
          </StageCard>

          {/* ② 续写与讲解 */}
          <StageCard anchorId={STAGE_ANCHOR.result} index={2} title="续写与讲解"
            busy={loading} done={!!result}
            meta={result ? '已生成' : ''}
            summary={result ? '续写范文 / 人物 / 矛盾 / 十句法 / 句式 / 默写（点击展开修改）' : '尚未生成'}
            open={openStages.has('result')} onToggle={() => toggleStage('result')}>
            {loading && (
              <Spinner
                showProgress
                text="正在生成读后续写学案..."
                messages={['正在梳理人物与情节线索...', '正在撰写两段续写范文...', '正在拆解十句五定法写作支架...', '正在整理描写句式与默写材料...', '即将完成，请耐心等待...']}
              />
            )}
            {!loading && !result && (
              <p className="sf-stage-hint">完成第 ① 步后点击「生成学案」，续写范文与完整讲解将在这里展示，全部内容均可点击修改。</p>
            )}
            {result && !loading && (
              <div className="result-sections">
                {/* 二、参考续写范文 */}
                <section className="result-section" id="cw-sec-essay">
                  <h3>二、参考续写范文</h3>
                  <div className="essay-block">
                    <strong>Paragraph 1:</strong>
                    <EditableField value={result.continuation.paragraph1} multiline
                      onChange={(v) => setResult({ ...result, continuation: { ...result.continuation, paragraph1: v } })} />
                    <button
                      className="para-rewrite-btn para-rewrite-inline"
                      onClick={() => handleRewriteContPara(1)}
                      disabled={rewritingPara != null || loading}
                      title="同功能、同水平，换一种表达（只替换本段）"
                    >
                      {rewritingPara === 1 ? '重写中…' : `↻ 换一个${serverMode ? ' · 3 额度' : ''}`}
                    </button>
                  </div>
                  <div className="essay-block" style={{ marginTop: 12 }}>
                    <strong>Paragraph 2:</strong>
                    <EditableField value={result.continuation.paragraph2} multiline
                      onChange={(v) => setResult({ ...result, continuation: { ...result.continuation, paragraph2: v } })} />
                    <button
                      className="para-rewrite-btn para-rewrite-inline"
                      onClick={() => handleRewriteContPara(2)}
                      disabled={rewritingPara != null || loading}
                      title="同功能、同水平，换一种表达（只替换本段）"
                    >
                      {rewritingPara === 2 ? '重写中…' : `↻ 换一个${serverMode ? ' · 3 额度' : ''}`}
                    </button>
                  </div>
                </section>

                {/* 三、人物分析 */}
                <section className="result-section" id="cw-sec-characters">
                  <h3>三、人物分析</h3>
                  <table className="simple-table">
                    <thead><tr><th>人物</th><th>性格</th><th>角色</th></tr></thead>
                    <tbody>
                      {result.characterAnalysis.characters.map((c, i) => (
                        <tr key={i}>
                          <td><EditableField value={c.name}
                            onChange={(v) => {
                              const arr = [...result.characterAnalysis.characters];
                              arr[i] = { ...arr[i], name: v };
                              setResult({ ...result, characterAnalysis: { ...result.characterAnalysis, characters: arr } });
                            }} /></td>
                          <td><EditableField value={c.traits.join('、')}
                            onChange={(v) => {
                              const arr = [...result.characterAnalysis.characters];
                              arr[i] = { ...arr[i], traits: v.split('、').map(s => s.trim()).filter(Boolean) };
                              setResult({ ...result, characterAnalysis: { ...result.characterAnalysis, characters: arr } });
                            }} /></td>
                          <td><EditableField value={c.role}
                            onChange={(v) => {
                              const arr = [...result.characterAnalysis.characters];
                              arr[i] = { ...arr[i], role: v };
                              setResult({ ...result, characterAnalysis: { ...result.characterAnalysis, characters: arr } });
                            }} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p style={{ fontSize: 13, marginTop: 8 }}><strong>人物关系：</strong>
                    <EditableField value={result.characterAnalysis.relationships}
                      onChange={(v) => setResult({ ...result, characterAnalysis: { ...result.characterAnalysis, relationships: v } })} />
                  </p>
                </section>

                {/* 四、剧情矛盾分析 */}
                <section className="result-section" id="cw-sec-conflict">
                  <h3>四、剧情矛盾分析</h3>
                  <div className="info-grid">
                    <div><strong>主要矛盾：</strong>
                      <EditableField value={result.conflictAnalysis.mainConflict}
                        onChange={(v) => setResult({ ...result, conflictAnalysis: { ...result.conflictAnalysis, mainConflict: v } })} />
                    </div>
                    <div><strong>情感弧线：</strong>
                      <EditableField value={result.conflictAnalysis.emotionalArc}
                        onChange={(v) => setResult({ ...result, conflictAnalysis: { ...result.conflictAnalysis, emotionalArc: v } })} />
                    </div>
                    <div><strong>转折点：</strong>
                      <EditableField value={result.conflictAnalysis.turningPoint}
                        onChange={(v) => setResult({ ...result, conflictAnalysis: { ...result.conflictAnalysis, turningPoint: v } })} />
                    </div>
                  </div>
                </section>

                {/* 五、十句五定法分析 */}
                <section className="result-section" id="cw-sec-tensentence">
                  <h3>五、十句五定法分析</h3>
                  <p style={{ fontSize: 13, color: 'var(--fg-2)', marginBottom: 12 }}>
                    <EditableField value={result.tenSentenceMethod.overview} multiline
                      onChange={(v) => setResult({ ...result, tenSentenceMethod: { ...result.tenSentenceMethod, overview: v } })} />
                  </p>
                  <h4>第一段（句 1-5）</h4>
                  <table className="simple-table">
                    <thead><tr><th>句</th><th>英文</th><th>功能</th></tr></thead>
                    <tbody>
                      {Object.entries(result.tenSentenceMethod.paragraph1).map(([key, val]) => (
                        <tr key={key}>
                          <td>{key.replace('sentence', '')}</td>
                          <td><EditableField value={val.en} multiline
                            onChange={(v) => setResult({ ...result, tenSentenceMethod: { ...result.tenSentenceMethod, paragraph1: { ...result.tenSentenceMethod.paragraph1, [key]: { ...val, en: v } } } })} /></td>
                          <td style={{ whiteSpace: 'nowrap' }}><EditableField value={val.function}
                            onChange={(v) => setResult({ ...result, tenSentenceMethod: { ...result.tenSentenceMethod, paragraph1: { ...result.tenSentenceMethod.paragraph1, [key]: { ...val, function: v } } } })} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <h4>第二段（句 6-10）</h4>
                  <table className="simple-table">
                    <thead><tr><th>句</th><th>英文</th><th>功能</th></tr></thead>
                    <tbody>
                      {Object.entries(result.tenSentenceMethod.paragraph2).map(([key, val]) => (
                        <tr key={key}>
                          <td>{key.replace('sentence', '')}</td>
                          <td><EditableField value={val.en} multiline
                            onChange={(v) => setResult({ ...result, tenSentenceMethod: { ...result.tenSentenceMethod, paragraph2: { ...result.tenSentenceMethod.paragraph2, [key]: { ...val, en: v } } } })} /></td>
                          <td style={{ whiteSpace: 'nowrap' }}><EditableField value={val.function}
                            onChange={(v) => setResult({ ...result, tenSentenceMethod: { ...result.tenSentenceMethod, paragraph2: { ...result.tenSentenceMethod.paragraph2, [key]: { ...val, function: v } } } })} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>

                {/* 六、读后续写常用句式 */}
                <section className="result-section" id="cw-sec-patterns">
                  <h3>六、读后续写常用句式</h3>
                  {result.commonPatterns.map((cat, ci) => (
                    <div key={ci} className="pattern-category">
                      <h4>{ci + 1}. {cat.category}</h4>
                      {cat.patterns.map((p, pi) => (
                        <div key={pi} className="pattern-item">
                          <div className="pattern-formula">
                            <EditableField value={p.formula}
                              onChange={(v) => {
                                const arr = [...result.commonPatterns];
                                arr[ci] = { ...arr[ci], patterns: arr[ci].patterns.map((pa, j) => j === pi ? { ...pa, formula: v } : pa) };
                                setResult({ ...result, commonPatterns: arr });
                              }} />
                          </div>
                          <div className="pattern-example">
                            <EditableField value={p.example} multiline
                              onChange={(v) => {
                                const arr = [...result.commonPatterns];
                                arr[ci] = { ...arr[ci], patterns: arr[ci].patterns.map((pa, j) => j === pi ? { ...pa, example: v } : pa) };
                                setResult({ ...result, commonPatterns: arr });
                              }} />
                          </div>
                          <div className="pattern-cn">
                            <EditableField value={p.cn}
                              onChange={(v) => {
                                const arr = [...result.commonPatterns];
                                arr[ci] = { ...arr[ci], patterns: arr[ci].patterns.map((pa, j) => j === pi ? { ...pa, cn: v } : pa) };
                                setResult({ ...result, commonPatterns: arr });
                              }} />
                            {p.note && <span className="pattern-note">（{p.note}）</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                </section>

                {/* 七、句式默写翻译练习 */}
                <section className="result-section" id="cw-sec-dictation">
                  <h3>七、句式默写翻译练习</h3>
                  <ol className="dictation-list">
                    {result.dictationSentences.map((ds, i) => (
                      <li key={i}>
                        <span className="dict-cn">{ds.cn}</span>
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
            <p className="sf-stage-hint">学案包含：前文回顾 / 参考续写范文 / 人物分析 / 剧情矛盾分析 / 十句五定法 / 常用句式 / 句式默写。</p>
          </StageCard>
        </div>
      </div>

      {showHistory && (
        <HistoryModal
          module="continuation"
          moduleLabel={MODULE_LABELS.continuation}
          onLoad={(item) => { restoreState((item as SavedItem<ContinuationState>).data); setShowHistory(false); }}
          onClose={() => setShowHistory(false)}
        />
      )}
      {showWordPicker && (
        <WordPickerModal
          title="选择话题词汇"
          hint="选中的词会追加到生成要求中，提示续写时自然使用这些词汇"
          entries={listWords()}
          onConfirm={(picked: WordBankEntry[]) => {
            setShowWordPicker(false);
            setReqOpen(true);
            const line = `请适当使用以下话题词汇：${picked.map((w) => w.word).join(', ')}。`;
            setHints((prev) => (prev.trim() ? `${prev.trimEnd()} ${line}` : line));
          }}
          onClose={() => setShowWordPicker(false)}
        />
      )}
      {costDialog}
    </div>
  );
}
