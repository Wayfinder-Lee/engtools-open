import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import type { ApiConfig, ClassFeedbackReport, EssayType, GradeLevel, HandwritingState, HandwritingWorksheetResult, ModelEssaySentence, ModelEssayTable, PrintSettings, PromptSummary, SavedItem, ScoreBreakdown, Stage, StudentSnapshot } from '../types';
import { ESSAY_TYPES, GRADE_LEVELS, MODEL_OPTIONS, OCR_MODEL_OPTIONS, WORKSHEET_DEFAULT_MODEL, OCR_DEFAULT_MODEL, defaultGradeLevel, defaultPrintSettings, MODULE_LABELS, getBandRanges, getEssayTypeLabel, getScoreDimensions, formatScoreBreakdown, isModelEssayTable } from '../types';
import { generateHandwritingWorksheet, normalizeHandwritingResult, ocrHandwriting, summarizeContinuationPrompt } from '../services/llm';
import { getMuPhotoData, markMuPhotosImported } from '../services/mupload';
import QrUploadPanel from './QrUploadPanel';
import { buildHandwritingWorksheetPrompt } from '../prompts/handwritingPrompts';
import { getEffectiveModel } from '../utils/model';
import { printWorksheetPdf, printAllWorksheetsPdf } from '../services/worksheetPdf';
import { exportHandwritingWorksheetDocx, exportAllHandwritingWorksheetsDocx, type WorksheetDocxParams } from '../services/handwritingExport';
import { autoSave, manualSave, loadHistory } from '../utils/history';
import { refreshAutoTitle } from '../utils/autoTitle';
import { takeHistoryHandoff } from '../utils/historyHandoff';
import { putHwImage, getHwImages, sweepHwImages } from '../utils/hwImageStore';
import { setFabCallbacks } from './FloatingActions';
import { classReportFingerprint } from '../utils/classStats';
import ModelSelect from './ModelSelect';
import ResultErrorBoundary from './ResultErrorBoundary';
import ClassReportPanel from './ClassReportPanel';
import HistoryModal from './HistoryModal';
import Spinner from './Spinner';
import ErrorBar from './ErrorBar';
import PromptImageReader from './PromptImageReader';
import { useCostGate } from './CostGate';
import { track } from '../utils/analytics';
import { Icon } from './icons';
import { StageStepper, StageToc, StageCard, useScrollspy } from './StageFlow';
import type { FlowStageInfo, TocEntry } from './StageFlow';
import './HandwritingWorksheet.css';

interface Props { apiConfig: ApiConfig; stage: Stage; /** 登录用户当前余额；null = 自带 Key 模式 */ quota?: number | null; }

// ─── EditableField ──────────────────────────────────

function EditableField({ value, onChange, multiline, className }: {
  value: string; onChange: (v: string) => void; multiline?: boolean; className?: string;
}) {
  // Defensive: if value is an object (LLM JSON error), stringify or extract text
  const safeValue = typeof value === 'string' ? value
    : (value && typeof value === 'object' && 'comment' in (value as any)) ? (value as any).comment
    : typeof value === 'object' ? JSON.stringify(value)
    : String(value ?? '');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(safeValue);
  const commit = () => { setEditing(false); if (draft !== safeValue) onChange(draft); };
  const cancel = () => { setEditing(false); setDraft(safeValue); };
  const start = () => { setDraft(safeValue); setEditing(true); };
  if (editing) {
    const Tag = multiline ? 'textarea' : 'input';
    return <Tag className={`editable-input ${multiline ? 'editable-textarea' : ''} ${className || ''}`}
      value={draft} onChange={(e) => setDraft((e.target as HTMLInputElement).value)}
      onBlur={commit} autoFocus
      onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey && !multiline && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); commit(); } if (e.key === 'Escape') { e.preventDefault(); cancel(); } }}
      rows={multiline ? 4 : 1} />;
  }
  return <div className={`editable-display ${className || ''}`} onClick={start} title="点击编辑">
    {safeValue ? (multiline ? <pre className="editable-pre">{safeValue}</pre> : <span>{safeValue}</span>) : <span className="cell-empty">点击编辑...</span>}
  </div>;
}

// ─── Collapsible section ────────────────────────────

function CollapsibleSection({ title, defaultOpen, children }: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen ?? true);
  return (
    <div className="hw-section">
      <div className="hw-section-header" onClick={() => setOpen(!open)}>
        <h3>{title}</h3>
        <span className={`hw-chevron ${open ? 'open' : ''}`}>▾</span>
      </div>
      {open && <div className="hw-section-body">{children}</div>}
    </div>
  );
}

// ─── Model essay table editor (读后续写) ─────────────

function ModelEssayTableEditor({ essay, onChange }: {
  essay: ModelEssayTable;
  onChange: (next: ModelEssayTable) => void;
}) {
  const updateSentence = (paraKey: 'paragraph1' | 'paragraph2', idx: number, patch: Partial<ModelEssaySentence>) => {
    const para = essay[paraKey].map((s, j) => j === idx ? { ...s, ...patch } : s);
    onChange({ ...essay, [paraKey]: para });
  };
  const renderPara = (paraKey: 'paragraph1' | 'paragraph2', startNum: number) => (
    <table className="hw-table">
      <thead><tr><th className="hw-col-num">句</th><th>英文</th><th className="hw-col-func">功能 / 技法</th></tr></thead>
      <tbody>
        {essay[paraKey].map((s, i) => (
          <tr key={i}>
            <td className="hw-col-num">{startNum + i}</td>
            <td><EditableField value={s.sentence} multiline onChange={v => updateSentence(paraKey, i, { sentence: v })} /></td>
            <td className="hw-col-func"><EditableField value={s.function} onChange={v => updateSentence(paraKey, i, { function: v })} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <div>
      <h4 className="hw-table-group-title">第一段</h4>
      {renderPara('paragraph1', 1)}
      <h4 className="hw-table-group-title">第二段</h4>
      {renderPara('paragraph2', essay.paragraph1.length + 1)}
    </div>
  );
}

// ─── Per-student sheet data ─────────────────────────

interface StudentSheet {
  id: string;
  filename: string;
  studentName: string;
  ocrText: string;
  imageDataUrl?: string;
  /** 待识别：已入列、尚未轮到（名单一次全部可见，识别逐张进行） */
  ocrPending: boolean;
  ocrLoading: boolean;
  ocrError?: string;
  result: HandwritingWorksheetResult | null;
  genLoading: boolean;
  genError?: string;
}

let _idCounter = 0;
function nextId(): string { return `s${++_idCounter}_${Date.now()}`; }

// ─── 逐名学生核对面板（第 ② 步） ────────────────────

const OCR_ZOOM_MIN = 40;
const OCR_ZOOM_MAX = 400;
const OCR_ZOOM_STEP = 20;

/** 一次只展示一位学生：大图 + 缩放（切换学生时保留）+ 识别文字核对 */
function StudentVerifyPanel({ students, index, onSelectIndex, zoom, onZoomChange, onUpdate, onRemoveAt, onClear, ocrBusy, genBusy }: {
  students: StudentSheet[];
  index: number;
  onSelectIndex: (i: number) => void;
  zoom: number;
  onZoomChange: (z: number) => void;
  onUpdate: (id: string, patch: Partial<StudentSheet>) => void;
  onRemoveAt: (i: number) => void;
  onClear: () => void;
  ocrBusy: boolean;
  genBusy: boolean;
}) {
  if (students.length === 0) return null;
  const curIdx = Math.min(index, students.length - 1);
  const cur = students[curIdx];
  const pillMark = (s: StudentSheet) =>
    s.ocrLoading ? { cls: 'st-busy', txt: '⏳' }
    : s.ocrPending ? { cls: 'st-pending', txt: '…' }
    : s.ocrError ? { cls: 'st-error', txt: '✕' }
    : s.ocrText ? { cls: 'st-done', txt: '✓' }
    : { cls: '', txt: '' };

  return (
    <div>
      {/* 学生切换胶囊：一眼看全班识别状态，点击直达 */}
      <div className="hw-student-pills">
        {students.map((s, i) => {
          const m = pillMark(s);
          return (
            <button key={s.id} type="button"
              className={`hw-student-pill ${i === curIdx ? 'active' : ''}`}
              onClick={() => onSelectIndex(i)} disabled={genBusy}
              title={s.filename}>
              {m.txt && <span className={m.cls}>{m.txt}</span>}
              {s.studentName || '未命名'}
            </button>
          );
        })}
        <button className="hw-btn-sm hw-pills-clear" onClick={onClear} disabled={ocrBusy || genBusy}>清空全部</button>
      </div>

      <div className="hw-verify-panel" id="hw-ocr-panel">
        <div className="hw-verify-head">
          <span className="hw-verify-count">第 {curIdx + 1} / {students.length} 位</span>
          <span className="hw-student-name-label">学生姓名:</span>
          <input className="hw-student-name-input" value={cur.studentName}
            onChange={e => onUpdate(cur.id, { studentName: e.target.value })}
            placeholder="学生姓名" disabled={genBusy} />
          <span className="hw-ocr-filename" title={cur.filename}>({cur.filename})</span>
          {!cur.ocrLoading && !genBusy && (
            <button className="hw-btn-xs" onClick={() => onRemoveAt(curIdx)}>移除</button>
          )}
          <div className="hw-verify-nav">
            <button className="hw-btn-sm" onClick={() => onSelectIndex(curIdx - 1)} disabled={curIdx <= 0 || genBusy}>← 上一位</button>
            <button className="hw-btn-sm" onClick={() => onSelectIndex(curIdx + 1)} disabled={curIdx >= students.length - 1 || genBusy}>下一位 →</button>
          </div>
        </div>

        <div className={`hw-verify-body ${cur.imageDataUrl ? '' : 'no-image'}`}>
          {cur.imageDataUrl && (
            <div className="hw-verify-img-col">
              <div className="hw-zoom-bar">
                <button className="hw-zoom-btn" onClick={() => onZoomChange(zoom - OCR_ZOOM_STEP)} disabled={zoom <= OCR_ZOOM_MIN} title="缩小">−</button>
                <span className="hw-zoom-value">{zoom}%</span>
                <button className="hw-zoom-btn" onClick={() => onZoomChange(zoom + OCR_ZOOM_STEP)} disabled={zoom >= OCR_ZOOM_MAX} title="放大">＋</button>
                <button className="hw-zoom-reset" onClick={() => onZoomChange(100)}>重置</button>
                <span>切换学生时保持此大小</span>
              </div>
              <div className="hw-verify-img-scroll">
                {cur.ocrLoading ? (
                  <div className="hw-verify-img-empty"><div className="hw-ocr-loading"><div className="spinner-sm" /> 正在识别...</div></div>
                ) : (
                  <img src={cur.imageDataUrl} alt={`${cur.studentName}手写照片`} style={{ width: `${zoom}%` }} />
                )}
              </div>
            </div>
          )}
          <div className="hw-verify-text-col">
            {cur.ocrLoading ? (
              <div className="hw-ocr-loading"><div className="spinner-sm" /> 正在识别，完成后可在此修改文字…</div>
            ) : cur.ocrPending ? (
              <div className="hw-ocr-queued">… 排队等待识别，轮到后自动开始（前面的识别完成后依次进行）</div>
            ) : cur.ocrError ? (
              <div className="hw-ocr-error">✕ {cur.ocrError}</div>
            ) : (
              <>
                <label className="input-label hw-label-nomargin">识别文字（可直接修改）</label>
                <textarea className="hw-ocr-textarea" value={cur.ocrText}
                  onChange={e => onUpdate(cur.id, { ocrText: e.target.value })}
                  placeholder="OCR 识别结果，可手动修改..." disabled={genBusy} />
              </>
            )}
          </div>
        </div>

        {(cur.genLoading || cur.genError) && (
          <div className="hw-verify-foot">
            {cur.genLoading && (
              <Spinner
                showProgress
                text={`正在为 ${cur.studentName} 生成学案...`}
                messages={['正在逐句诊断作文错误...', '正在归类时态、句式等问题类型...', '正在生成巩固默写与提升练习...', '即将完成，请耐心等待...']}
              />
            )}
            {cur.genError && <div className="error-msg"><span>✕</span> {cur.studentName}：{cur.genError}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Worksheet result renderer (reused per student) ─

/** 档次徽章：纯函数现算（不存储，老师改分后自动跟随）；maxScore 非 15/25 时返回 null。
 *  区间表单源在 types.getBandRanges（班级讲评报告统计共用），此处只负责档内上/中/下段与文案 */
function bandOf(maxScore: number | undefined, score: number): string | null {
  const bands = getBandRanges(maxScore);
  if (!bands) return null;
  const idx = bands.findIndex(([lo, hi]) => score >= lo && score <= hi);
  if (idx < 0) return null;
  const [lo, hi] = bands[idx];
  const pos = hi === lo ? '' : (score - lo) / (hi - lo) < 1 / 3 ? '下段' : (score - lo) / (hi - lo) > 2 / 3 ? '上段' : '中段';
  return `${['一', '二', '三', '四', '五'][4 - idx]}档${pos}（${lo}-${hi}）`;
}

/** 分数行内编辑：±1 微调 / 满分可改 / 档位徽章现算 / 维度分只读 + 求和修正。
 *  失焦或回车提交；只收整数并钳到 [0, max]；maxScore 缺失用题型默认补齐
 *  （PDF/docx 导出都以 score != null && maxScore 为显示条件，补齐后导出才有分数行） */
function ScoreEditor({ score, maxScore, breakdown, fallbackMax, onCommit }: {
  score?: number;
  maxScore?: number;
  breakdown?: ScoreBreakdown;
  fallbackMax: number;
  onCommit: (patch: { score?: number; maxScore?: number }) => void;
}) {
  const max = maxScore ?? fallbackMax;
  const [draft, setDraft] = useState(score != null ? String(score) : '');
  const [maxDraft, setMaxDraft] = useState(String(max));
  // 结果被重新生成/恢复时同步外部新值（提交发生在失焦后，不会打断输入中的编辑）
  useEffect(() => { setDraft(score != null ? String(score) : ''); }, [score]);
  useEffect(() => { setMaxDraft(String(max)); }, [max]);
  const commitScore = () => {
    const n = parseInt(draft, 10);
    if (!Number.isFinite(n)) { setDraft(score != null ? String(score) : ''); return; }
    const clamped = Math.max(0, Math.min(max, n));
    if (clamped !== n) setDraft(String(clamped));
    onCommit({ score: clamped, ...(maxScore == null ? { maxScore: max } : {}) });
  };
  const commitMax = () => {
    const n = parseInt(maxDraft, 10);
    if (!Number.isFinite(n)) { setMaxDraft(String(max)); return; }
    const clamped = Math.max(1, Math.min(100, n));
    if (String(clamped) !== maxDraft) setMaxDraft(String(clamped));
    onCommit({ maxScore: clamped });
  };
  const bump = (d: number) => {
    const cur = score ?? 0;
    onCommit({ score: Math.max(0, Math.min(max, cur + d)), ...(maxScore == null ? { maxScore: max } : {}) });
  };
  const dimsLine = formatScoreBreakdown({ scoreBreakdown: breakdown, maxScore });
  const sum = breakdown ? breakdown.content + breakdown.language + breakdown.cohesion : null;
  const sumMismatch = breakdown != null && score != null && sum !== score;
  return (
    <div className="hw-score-row" title="AI 评分仅供参考，可直接修改，导出 PDF / Word 使用修改后的分数">
      <span className="hw-score-label">参考分数</span>
      <button type="button" className="hw-score-bump" onClick={() => bump(-1)} title="减 1 分">−</button>
      <input className="hw-score-input" type="text" inputMode="numeric" value={draft} aria-label="参考分数"
        onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ''))}
        onBlur={commitScore}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }} />
      <button type="button" className="hw-score-bump" onClick={() => bump(1)} title="加 1 分">＋</button>
      <span className="hw-score-slash">/</span>
      <input className="hw-score-input hw-score-max-input" type="text" inputMode="numeric" value={maxDraft} aria-label="满分"
        onChange={(e) => setMaxDraft(e.target.value.replace(/[^\d]/g, ''))}
        onBlur={commitMax}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }}
        title="满分（按题型默认 15/25，可改为当地分制；非 15/25 时维度分与档位徽章自动隐藏）" />
      <span className="hw-score-max">分</span>
      {score != null && <span className="hw-score-badge">{bandOf(maxScore, score)}</span>}
      {dimsLine && <span className="hw-score-dims">{dimsLine}</span>}
      {sumMismatch && (
        <button type="button" className="hw-score-fix" onClick={() => onCommit({ score: sum as number })}>
          维度和 {sum} ≠ 总分 {score}，按维度和取 {sum}
        </button>
      )}
    </div>
  );
}

function WorksheetResultView({ r, updateResult, essayType }: {
  r: HandwritingWorksheetResult;
  updateResult: <K extends keyof HandwritingWorksheetResult>(key: K, value: HandwritingWorksheetResult[K]) => void;
  essayType: EssayType;
}) {
  return (
    <div className="result-sections">
      {/* 0. Prompt Analysis */}
      <CollapsibleSection title="审题分析" defaultOpen={true}>
        <div className="hw-prompt-analysis">
          <div className={`hw-offtopic-badge ${r.promptAnalysis.isOffTopic ? 'offtopic' : 'ontopic'}`}>
            {r.promptAnalysis.isOffTopic ? '偏题' : '✓ 未偏题'}
          </div>
          {r.promptAnalysis.isOffTopic && (
            <div className="hw-offtopic-detail">
              <strong>偏题说明：</strong>
              <EditableField value={r.promptAnalysis.offTopicDetail}
                onChange={v => updateResult('promptAnalysis', { ...r.promptAnalysis, offTopicDetail: v })} multiline />
            </div>
          )}
          <div className="hw-points-row">
            <div className="hw-points-col">
              <strong>已覆盖要点</strong>
              <ul>{r.promptAnalysis.coveredPoints.map((p, i) => (
                <li key={i}><EditableField value={p} onChange={v => { const arr = [...r.promptAnalysis.coveredPoints]; arr[i] = v; updateResult('promptAnalysis', { ...r.promptAnalysis, coveredPoints: arr }); }} /></li>
              ))}</ul>
            </div>
            {r.promptAnalysis.missedPoints.length > 0 && (
              <div className="hw-points-col">
                <strong>遗漏要点</strong>
                <ul>{r.promptAnalysis.missedPoints.map((p, i) => (
                  <li key={i}><EditableField value={p} onChange={v => { const arr = [...r.promptAnalysis.missedPoints]; arr[i] = v; updateResult('promptAnalysis', { ...r.promptAnalysis, missedPoints: arr }); }} /></li>
                ))}</ul>
              </div>
            )}
          </div>
          <EditableField value={r.promptAnalysis.overallComment} multiline
            onChange={v => updateResult('promptAnalysis', { ...r.promptAnalysis, overallComment: v })} />
        </div>
      </CollapsibleSection>

      <CollapsibleSection title={`一、作文总评${(r.score != null && r.maxScore) ? ` — ${r.score}/${r.maxScore} 分` : ''}`}>
        <ScoreEditor score={r.score} maxScore={r.maxScore} breakdown={r.scoreBreakdown}
          fallbackMax={getScoreDimensions(essayType).total}
          onCommit={(patch) => {
            if (patch.score !== undefined) updateResult('score', patch.score);
            if (patch.maxScore !== undefined) updateResult('maxScore', patch.maxScore);
          }} />
        <EditableField value={r.overallComment} multiline onChange={v => updateResult('overallComment', v)} />
      </CollapsibleSection>

      <CollapsibleSection title="二、错误分类诊断">
        {['grammar', 'vocabulary', 'sentence', 'logic'].map(cat => {
          const data = r.errorDiagnosis[cat as keyof typeof r.errorDiagnosis];
          if (!data.length) return null;
          const labels: Record<string, string> = { grammar: '语法错误', vocabulary: '词汇不当', sentence: '句式问题', logic: '逻辑/连贯问题' };
          return (
            <div key={cat}>
              <h4>{labels[cat]}</h4>
              <table className="simple-table">
                <thead><tr>{cat === 'logic' ? <><th>问题</th><th>说明</th></> : <><th>原文</th><th>{cat === 'grammar' ? '修正' : cat === 'vocabulary' ? '建议替换' : '改进方向'}</th><th>讲解</th></>}</tr></thead>
                <tbody>
                  {data.map((e: any, i: number) => (
                    <tr key={i}>
                      <td><EditableField value={e.original || e.issue} onChange={v => { const arr = [...data]; arr[i] = { ...arr[i], [cat === 'logic' ? 'issue' : 'original']: v }; updateResult('errorDiagnosis', { ...r.errorDiagnosis, [cat]: arr }); }} /></td>
                      <td className={cat === 'grammar' || cat === 'vocabulary' ? 'td-corrected' : ''}>
                        <EditableField value={e.corrected || e.suggestion || e.improvement || e.explanation} onChange={v => { const arr = [...data]; const key = cat === 'grammar' ? 'corrected' : cat === 'vocabulary' ? 'suggestion' : cat === 'sentence' ? 'improvement' : 'explanation'; arr[i] = { ...arr[i], [key]: v }; updateResult('errorDiagnosis', { ...r.errorDiagnosis, [cat]: arr }); }} />
                      </td>
                      {cat !== 'logic' && <td><EditableField value={e.explanation} onChange={v => { const arr = [...data]; arr[i] = { ...arr[i], explanation: v }; updateResult('errorDiagnosis', { ...r.errorDiagnosis, [cat]: arr }); }} /></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
      </CollapsibleSection>

      <CollapsibleSection title="三、重点语法突破">
        {r.grammarBreakthrough.rules.map((rule, ri) => (
          <div key={ri} className="hw-grammar-rule">
            <h4><EditableField value={rule.title} onChange={v => { const arr = [...r.grammarBreakthrough.rules]; arr[ri] = { ...arr[ri], title: v }; updateResult('grammarBreakthrough', { ...r.grammarBreakthrough, rules: arr }); }} /></h4>
            <EditableField value={rule.explanation} multiline onChange={v => { const arr = [...r.grammarBreakthrough.rules]; arr[ri] = { ...arr[ri], explanation: v }; updateResult('grammarBreakthrough', { ...r.grammarBreakthrough, rules: arr }); }} />
            {rule.examples.map((ex, ei) => (
              <div key={ei} className="hw-example">
                <EditableField value={ex.en} onChange={v => { const arr = [...r.grammarBreakthrough.rules]; arr[ri] = { ...arr[ri], examples: arr[ri].examples.map((e, j) => j === ei ? { ...e, en: v } : e) }; updateResult('grammarBreakthrough', { ...r.grammarBreakthrough, rules: arr }); }} />
                <EditableField value={ex.cn} onChange={v => { const arr = [...r.grammarBreakthrough.rules]; arr[ri] = { ...arr[ri], examples: arr[ri].examples.map((e, j) => j === ei ? { ...e, cn: v } : e) }; updateResult('grammarBreakthrough', { ...r.grammarBreakthrough, rules: arr }); }} />
              </div>
            ))}
          </div>
        ))}
      </CollapsibleSection>

      <CollapsibleSection title="四、词汇升级训练">
        {r.vocabularyUpgrade.items.map((item, ii) => (
          <div key={ii} className="hw-vocab-item">
            <span className="hw-vocab-original">{item.original}</span>
            <span className="hw-arrow">→</span>
            <span>{item.upgrades.map(u => `${u.word}（${u.context}）`).join(' / ')}</span>
          </div>
        ))}
      </CollapsibleSection>

      <CollapsibleSection title="五、句式提升工坊">
        {r.sentenceImprovement.items.map((item, ii) => (
          <div key={ii} className="hw-sentence-item">
            <div className="hw-sentence-step"><strong>原句：</strong><EditableField value={item.original} multiline onChange={v => { const arr = [...r.sentenceImprovement.items]; arr[ii] = { ...arr[ii], original: v }; updateResult('sentenceImprovement', { ...r.sentenceImprovement, items: arr }); }} /></div>
            <div className="hw-sentence-step"><strong>分析：</strong><EditableField value={item.analysis} multiline onChange={v => { const arr = [...r.sentenceImprovement.items]; arr[ii] = { ...arr[ii], analysis: v }; updateResult('sentenceImprovement', { ...r.sentenceImprovement, items: arr }); }} /></div>
            <div className="hw-sentence-step improved"><strong>改进：</strong><EditableField value={item.improved} multiline onChange={v => { const arr = [...r.sentenceImprovement.items]; arr[ii] = { ...arr[ii], improved: v }; updateResult('sentenceImprovement', { ...r.sentenceImprovement, items: arr }); }} /></div>
            <div className="hw-sentence-highlights"><strong>技法：</strong>{item.highlights}</div>
          </div>
        ))}
      </CollapsibleSection>

      <CollapsibleSection title="六、范文升级版">
        {isModelEssayTable(r.modelEssay) ? (
          <ModelEssayTableEditor essay={r.modelEssay} onChange={next => updateResult('modelEssay', next)} />
        ) : (
          <EditableField value={r.modelEssay as string} multiline onChange={v => updateResult('modelEssay', v)} />
        )}
      </CollapsibleSection>

      <CollapsibleSection title="七、巩固练习（范文默写）">
        {r.consolidationExercises.map((ex, i) => (
          <div key={i} className="hw-dictation-item">
            <div className="hw-dictation-header">
              <strong>{i + 1}. </strong>
              <EditableField value={ex.cn} onChange={v => { const arr = [...r.consolidationExercises]; arr[i] = { ...arr[i], cn: v }; updateResult('consolidationExercises', arr); }} />
              <span className="dict-pattern-hint">{ex.pattern}</span>
            </div>
            <div className="hw-answer-hint">EN：{ex.en}</div>
          </div>
        ))}
      </CollapsibleSection>
    </div>
  );
}

// ─── 阶段流程定义 ───────────────────────────────────

type FlowStageId = 'setup' | 'upload' | 'generate' | 'report' | 'export';
const STAGE_IDS: FlowStageId[] = ['setup', 'upload', 'generate', 'report', 'export'];
const stageAnchor = (id: FlowStageId) => `hw-stage-${id}`;

// ─── Main component ─────────────────────────────────

export default function HandwritingWorksheet({ apiConfig, stage, quota }: Props) {
  // Shared inputs
  const [essayType, setEssayType] = useState<EssayType>('practical');
  const [essayPrompt, setEssayPrompt] = useState('');
  const [gradeLevel, setGradeLevel] = useState<GradeLevel>(() => defaultGradeLevel(stage));

  // OCR
  const [ocrModel, setOcrModel] = useState(OCR_DEFAULT_MODEL);
  const [students, setStudents] = useState<StudentSheet[]>([]);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [wordBusy, setWordBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  // 逐名学生核对：当前核对的学生下标 + 手写图缩放（切换学生时保留用户的调整）
  const [currentStudentIdx, setCurrentStudentIdx] = useState(0);
  const [ocrZoom, setOcrZoom] = useState(100);
  const studentsCountRef = useRef(0);
  useEffect(() => { studentsCountRef.current = students.length; }, [students]);
  // OCR 队列执行期间被老师移除的学生 id：轮到时直接跳过，不再调用识别（不白花额度）
  const removedDuringOcrRef = useRef<Set<string>>(new Set());
  const selectStudent = (i: number) => setCurrentStudentIdx(Math.max(0, Math.min(i, students.length - 1)));
  const changeZoom = (z: number) => setOcrZoom(Math.max(OCR_ZOOM_MIN, Math.min(OCR_ZOOM_MAX, z)));

  // LLM
  const [genModel, setGenModel] = useState(WORKSHEET_DEFAULT_MODEL);
  const [genBusy, setGenBusy] = useState(false);
  const [error, setError] = useState('');
  const [promptSummary, setPromptSummary] = useState<PromptSummary | null>(null);
  // ④ 班级讲评报告快照（LLM 叙事）；统计区由 ClassReportPanel 对 students 实时现算
  const [classReport, setClassReport] = useState<ClassFeedbackReport | null>(null);
  // 报告生成 busy 提升到父级：④ 卡收起会卸载 panel（内部状态丢失），
  // busy 在父级才能让流程条持续显示 ⏳ 并防止收起再展开后重复触发计费调用
  const [reportBusy, setReportBusy] = useState(false);
  // 单份学案「备注重新生成」：展开备注框的学生 id + 备注草稿（全局一份草稿即可）
  const [regenNoteFor, setRegenNoteFor] = useState<string | null>(null);
  const [regenNote, setRegenNote] = useState('');

  // 报告是否仍然有效（live）：学生成绩/姓名/错例文本被编辑后指纹不一致 → done 状态、
  // 自动展开、导出确认都基于它判断，避免把过期快照当成品
  const liveFingerprint = useMemo(
    () => classReportFingerprint(students, essayType, essayPrompt, promptSummary?.summary),
    [students, essayType, essayPrompt, promptSummary],
  );
  const reportLive = !!classReport && classReport.fingerprint === liveFingerprint;

  // Print settings (title + subtitle only)
  const typeLabel = getEssayTypeLabel(stage, essayType);
  const [printSettings, setPrintSettings] = useState<PrintSettings>(() => defaultPrintSettings(typeLabel));
  const [showHistory, setShowHistory] = useState(false);

  // 阶段流程：各阶段展开/收起（完成后自动收起，腾出页面空间）
  const [openStages, setOpenStages] = useState<Set<FlowStageId>>(new Set(['setup']));

  const getState = (): HandwritingState => ({
    essayType,
    essayPrompt,
    gradeLevel,
    printSettings,
    students: students.map((s): StudentSnapshot => ({
      id: s.id, filename: s.filename, studentName: s.studentName,
      ocrText: s.ocrText, ocrError: s.ocrError,
      result: s.result, genError: s.genError,
    })),
    promptSummary,
    classReport,
  });

  const restoreState = (data: HandwritingState) => {
    // 跨学段恢复防护：年级/作文类型不在当前学段范围内时回退默认值
    const validGrades = GRADE_LEVELS[stage];
    // 跨学段防护先算恢复后的作文类型，normalize 用它纠偏 maxScore/钳制分数（旧存档脏值随恢复自动修复）
    const restoredType = data.essayType === 'continuation' && stage === 'junior' ? 'practical' : data.essayType;
    setEssayType(restoredType);
    setEssayPrompt(data.essayPrompt);
    setGradeLevel(validGrades.includes(data.gradeLevel) ? data.gradeLevel : defaultGradeLevel(stage));
    setPrintSettings(data.printSettings);
    setPromptSummary(data.promptSummary ?? null);
    // 讲评报告守卫式恢复：旧存档无此字段，畸形数据置 null（恢复路径绝不 throw）
    const restoredReport = data.classReport && typeof data.classReport === 'object' && Array.isArray(data.classReport.commonProblems) ? data.classReport : null;
    setClassReport(restoredReport);
    setStudents(data.students.map((s): StudentSheet => {
      // 存档里的学案也过一遍 normalize：旧版本存档可能含缺字段的脏数据（会白屏），坏到无法补全时转为 genError
      let result = s.result ?? null;
      let genError = s.genError;
      if (result) {
        try {
          result = normalizeHandwritingResult(result, { essayType: restoredType });
        } catch {
          result = null;
          genError = '历史存档中的该份学案数据不完整，请重新生成';
        }
      }
      return { ...s, imageDataUrl: undefined, ocrPending: false, ocrLoading: false, genLoading: false, result, genError };
    }));
    // 手写图本地存档（IndexedDB）：快照只存轻元数据，图按学生 id 从 IDB 异步取回合并——
    // 载入历史后核对面板即可对照学生手写原图。旧设备/清理过 IDB 时无图，走既有 no-image 分支
    if (data.students.length > 0) {
      getHwImages(data.students.map(s => s.id)).then((imgs) => {
        if (imgs.size === 0) return;
        setStudents(prev => prev.map(s => {
          const url = imgs.get(s.id);
          return url && !s.imageDataUrl ? { ...s, imageDataUrl: url } : s;
        }));
      });
    }
    setCurrentStudentIdx(0);
    // 恢复后直接展开最深入的阶段：有学案 → ③④⑤（核对/讲评报告/导出）；只有学生 → ②；否则 ①
    const restored = new Set<FlowStageId>(['setup']);
    if (data.students.length > 0) restored.add('upload');
    if (data.students.some(s => s.result)) { restored.add('generate'); restored.add('export'); }
    if (restoredReport) restored.add('report');
    setOpenStages(restored);
    window.scrollTo({ top: 0 });
  };

  // 主页「最近生成 → 打开」：挂载取走交给本模块的记录并恢复（无则 no-op）。
  // restoreState 内的 IDB 照片合并/跨学段校验照常工作
  useEffect(() => {
    const item = takeHistoryHandoff('handwriting');
    if (item) restoreState((item as SavedItem<HandwritingState>).data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSave = () => {
    const name = window.prompt('保存名称：', `${MODULE_LABELS.handwriting} ${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`);
    if (!name) return;
    if (!manualSave('handwriting', name, getState())) {
      setError('保存失败：浏览器本地存储空间已满，请打开「历史记录」删除部分旧条目后重试');
    }
  };

  useEffect(() => {
    setFabCallbacks(handleSave, () => setShowHistory(true));
    return () => setFabCallbacks(null, null);
  });

  // 挂载清扫 IDB 手写图孤儿：历史条目已删的学生图，超过 24h 宽限期后回收（宽限覆盖
  // 「已上传但尚未触发快照」的当天图片）；liveIds = 现存全部历史条目引用的学生 id
  useEffect(() => {
    const live = new Set<string>();
    for (const item of loadHistory<HandwritingState>('handwriting')) {
      for (const s of item.data?.students ?? []) live.add(s.id);
    }
    void sweepHwImages(live);
  }, []);

  // 编辑防丢：核对阶段的任何编辑（评语/分数/错题等）1.5s 防抖自动快照，
  // 与生成期 autoSave 同键覆盖、与手动保存并存——否则刷新页面会丢掉生成后的全部手改
  useEffect(() => {
    if (!students.some(s => s.result)) return;
    const t = setTimeout(() => {
      autoSave('handwriting', {
        essayType, essayPrompt, gradeLevel, printSettings,
        students: students.map((s): StudentSnapshot => ({
          id: s.id, filename: s.filename, studentName: s.studentName,
          ocrText: s.ocrText, ocrError: s.ocrError, result: s.result, genError: s.genError,
        })),
        promptSummary,
        classReport,
      });
    }, 1500);
    return () => clearTimeout(t);
  }, [students, essayType, essayPrompt, gradeLevel, printSettings, promptSummary, classReport]);

  const updateEssayType = (t: EssayType) => {
    setEssayType(t);
    // 离开读后续写时清掉旧的题干概括，避免上一个续写任务的 summary 污染应用文学案的 PDF 题干
    if (t !== 'continuation') setPromptSummary(null);
    const label = getEssayTypeLabel(stage, t);
    setPrintSettings({ title: '个性化书面表达提升学案', subtitle: `———  ${label}  ———` });
  };

  // 学段切换：年级不在新学段列表时重置默认；初中无读后续写，强制回到应用文（并清掉续写题干概括）
  useEffect(() => {
    if (!GRADE_LEVELS[stage].includes(gradeLevel)) setGradeLevel(defaultGradeLevel(stage));
    if (stage === 'junior' && essayType === 'continuation') updateEssayType('practical');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  // ─── 阶段流程：锚点跳转 + 滚动联动 ────────────────

  const rafThen = (fn: () => void) => { requestAnimationFrame(() => requestAnimationFrame(fn)); };

  /** 跳到任意锚点（阶段卡片 / 学生 / 学案卡片）：先展开所属阶段，再滚动；<details> 自动展开 */
  const jumpToAnchor = (anchorId: string) => {
    // 学生锚点（第 ② 步）：切换核对面板到该学生，再滚动到面板
    if (anchorId.startsWith('hw-ocr-')) {
      setOpenStages(prev => { const n = new Set(prev); n.add('upload'); return n; });
      const i = students.findIndex(s => `hw-ocr-${s.id}` === anchorId);
      if (i >= 0) setCurrentStudentIdx(i);
      rafThen(() => document.getElementById('hw-ocr-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      return;
    }
    const stageId: FlowStageId = anchorId.startsWith('hw-res-') ? 'generate'
      : STAGE_IDS.includes(anchorId.slice('hw-stage-'.length) as FlowStageId) ? anchorId.slice('hw-stage-'.length) as FlowStageId
      : 'setup';
    setOpenStages(prev => { const n = new Set(prev); n.add(stageId); return n; });
    rafThen(() => {
      const el = document.getElementById(anchorId);
      if (!el) return;
      if (el instanceof HTMLDetailsElement) el.open = true;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };
  const handleStageJump = (id: string) => jumpToAnchor(`hw-stage-${id}`);
  const toggleStage = (id: FlowStageId) =>
    setOpenStages(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // ─── OCR: process images, one student per image ───

  // 常见相机/截图/导出默认文件名：前缀 + 可选数字（IMG_2041、DSC0123、mmexport17…、微信图片_2024…、Screenshot_…）
  const GENERIC_FILENAME_RE = /^(img|dscn?|vid|pxl|mvimg|fbimg|mmexport|wxcamera|screenshot|photo|image|pic|picture|snapshot|微信图片|微信截图|屏幕截图|截图|图片|照片|相片|拍照|拍摄|未命名|新建)(\d+)?$/i;

  /** 文件名解析出的"姓名"是否无意义：空、纯数字（时间戳/序号）或常见默认名 → 应改用 OCR 识别的姓名 */
  const isGenericFilenameName = (rawName: string) => {
    const n = rawName.replace(/[\s._-]+/g, '');
    return !n || /^\d+$/.test(n) || GENERIC_FILENAME_RE.test(n);
  };

  const { confirmSpend, costDialog } = useCostGate(quota);
  const serverMode = quota != null;

  const processFiles = useCallback(async (files: FileList | File[]) => {
    if (!apiConfig.apiKey.trim() && !serverMode) { setError('请先登录或填入 API Key'); return; }
    setError('');
    const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;
    if (!(await confirmSpend(imageFiles.length, `OCR 识别 ${imageFiles.length} 张手写图片`))) return;
    setOcrBusy(true);
    // 进入第 ② 步：题干已填写时收起第 ① 步，自动滚到上传区；核对焦点跳到本批第一位学生
    setOpenStages(prev => { const n = new Set(prev); n.add('upload'); if (essayPrompt.trim()) n.delete('setup'); return n; });
    rafThen(() => document.getElementById(stageAnchor('upload'))?.scrollIntoView({ behavior: 'smooth', block: 'start' }));

    // 全部图片先入列（待识别）：名单立刻完整可见，识别逐张进行、完成后原位更新
    const queue = imageFiles.map((file) => {
      const id = nextId();
      const name = file.name.replace(/\.[^.]+$/, '').replace(/[_\-\s]+/g, '').trim();
      const sheet: StudentSheet = { id, filename: file.name, studentName: name, ocrText: '', ocrPending: true, ocrLoading: false, result: null, genLoading: false };
      return { id, file, sheet };
    });
    setStudents(prev => [...prev, ...queue.map(q => q.sheet)]);
    setCurrentStudentIdx(studentsCountRef.current); // 本批第一位（ref 此刻仍是入列前的长度）

    for (const { id, file } of queue) {
      if (removedDuringOcrRef.current.has(id)) continue; // 入列后被移除：跳过，不识别不扣额度
      setStudents(prev => prev.map(s => s.id === id ? { ...s, ocrPending: false, ocrLoading: true } : s));
      try {
        const { text, imageDataUrl, studentName } = await ocrHandwriting(apiConfig, ocrModel, file);
        void putHwImage(id, imageDataUrl); // 本地存档：载入历史时可回看手写原图
        setStudents(prev => prev.map(s => {
          if (s.id !== id) return s;
          // 文件名是相机/截图默认名或纯数字时，改用 OCR 从姓名栏识别到的姓名（老师已手改的姓名不覆盖）
          return {
            ...s, ocrText: text, imageDataUrl, ocrLoading: false,
            studentName: studentName && isGenericFilenameName(s.studentName) ? studentName : s.studentName,
          };
        }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'OCR 失败';
        setStudents(prev => prev.map(s => s.id === id ? { ...s, ocrLoading: false, ocrError: msg } : s));
      }
    }
    setOcrBusy(false);
  }, [apiConfig, ocrModel, essayPrompt, confirmSpend]);

  // Drag & drop
  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); setDragOver(true); };
  const handleDragLeave = () => setDragOver(false);
  const handleDrop = (e: React.DragEvent) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length) processFiles(e.dataTransfer.files); };
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => { if (e.target.files?.length) processFiles(e.target.files); if (e.target) e.target.value = ''; };

  /**
   * 扫码上传的照片 → 逐张取整图 → OCR（dataURL 已在手机端压缩，直接透传不再二次压缩）
   * → 每张成功后服务端打标 imported（防重复导入重复扣费）。
   * 文件名统一「拍照<seq>.jpg」——GENERIC_FILENAME_RE 含「拍照」，姓名交给 OCR 接管。
   * 返回 false = 未过确认门（取消/未配置）：QrUploadPanel 据此保留勾选。
   */
  const importQrPhotos = useCallback(async (selected: { photoId: string; seq: number }[], tid: string): Promise<boolean> => {
    if (!apiConfig.apiKey.trim() && !serverMode) { setError('请先登录或填入 API Key'); return false; }
    if (selected.length === 0) return false;
    if (!(await confirmSpend(selected.length, `OCR 识别 ${selected.length} 张扫码照片`))) return false;
    setError('');
    setOcrBusy(true);
    setOpenStages(prev => { const n = new Set(prev); n.add('upload'); if (essayPrompt.trim()) n.delete('setup'); return n; });
    rafThen(() => document.getElementById(stageAnchor('upload'))?.scrollIntoView({ behavior: 'smooth', block: 'start' }));

    // 与 processFiles 一致：全部先入列（待识别），名单立刻完整可见
    const queue = selected.map((sel) => {
      const id = nextId();
      const sheet: StudentSheet = { id, filename: `拍照${sel.seq}.jpg`, studentName: `拍照${sel.seq}`, ocrText: '', ocrPending: true, ocrLoading: false, result: null, genLoading: false };
      return { id, sel, sheet };
    });
    setStudents(prev => [...prev, ...queue.map(q => q.sheet)]);
    setCurrentStudentIdx(studentsCountRef.current); // 本批第一位（ref 此刻仍是入列前的长度）

    for (const { id, sel } of queue) {
      if (removedDuringOcrRef.current.has(id)) continue; // 入列后被移除：跳过，不识别不扣额度
      setStudents(prev => prev.map(s => s.id === id ? { ...s, ocrPending: false, ocrLoading: true } : s));
      try {
        const { dataUrl } = await getMuPhotoData(tid, sel.photoId);
        const { text, imageDataUrl, studentName } = await ocrHandwriting(apiConfig, ocrModel, dataUrl);
        void putHwImage(id, imageDataUrl); // 本地存档：载入历史时可回看手写原图
        setStudents(prev => prev.map(s => {
          if (s.id !== id) return s;
          // 「拍照N」是默认名，改用 OCR 从姓名栏识别到的姓名（老师已手改的姓名不覆盖）
          return {
            ...s, ocrText: text, imageDataUrl, ocrLoading: false,
            studentName: studentName && isGenericFilenameName(s.studentName) ? studentName : s.studentName,
          };
        }));
        void markMuPhotosImported(tid, [sel.photoId]).catch(() => { /* 打标失败下次 poll 仍显示未识别，可重新导入 */ });
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'OCR 失败';
        setStudents(prev => prev.map(s => s.id === id ? { ...s, ocrLoading: false, ocrError: msg } : s));
      }
    }
    setOcrBusy(false);
    return true;
  }, [apiConfig, ocrModel, essayPrompt, confirmSpend, serverMode]);

  // ─── Student management ───────────────────────────

  const updateStudent = (id: string, patch: Partial<StudentSheet>) => {
    setStudents(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s));
  };
  /** 按下标移除学生，并把核对焦点保持在原位置附近 */
  const removeStudentAt = (i: number) => {
    const gone = students[i];
    if (gone && (gone.ocrPending || gone.ocrLoading)) removedDuringOcrRef.current.add(gone.id);
    setStudents(prev => prev.filter((_, j) => j !== i));
    setCurrentStudentIdx(prev => Math.max(0, Math.min(i < prev ? prev - 1 : prev, students.length - 2)));
  };
  const clearAll = () => { setStudents([]); setCurrentStudentIdx(0); setClassReport(null); };

  // ─── Generate worksheets for all students ─────────

  const handleGenerateAll = async () => {
    const pending = students.filter(s => !s.result && !s.genLoading && s.ocrText.trim());
    if (pending.length === 0) { setError('没有可生成的学案（请先上传图片并完成 OCR）'); return; }
    if (!essayPrompt.trim()) { setError('请输入作文题干'); return; }
    if (!apiConfig.apiKey.trim() && !serverMode) { setError('请先登录或填入 API Key'); return; }
    if (!(await confirmSpend(pending.length * 30, `为 ${pending.length} 名学生生成个性化学案（每份 30 额度）`))) return;
    setError(''); setGenBusy(true);
    // 进入第 ③ 步：收起前两步，自动滚到学案区跟踪生成进度
    setOpenStages(new Set(['generate']));
    rafThen(() => document.getElementById(stageAnchor('generate'))?.scrollIntoView({ behavior: 'smooth', block: 'start' }));

    // For continuation writing: summarize the long essay prompt once
    let summary: PromptSummary | null = null;
    let genSuccessCount = 0;
    if (essayType === 'continuation') {
      try {
        summary = await summarizeContinuationPrompt(apiConfig, genModel, essayPrompt);
        setPromptSummary(summary);
      } catch (e) {
        setError('题干概括失败：' + (e instanceof Error ? e.message : String(e)));
        setGenBusy(false);
        return;
      }
    }

    for (const s of pending) {
      updateStudent(s.id, { genLoading: true, genError: undefined });
      try {
        const prompt = buildHandwritingWorksheetPrompt({
          studentName: s.studentName, gradeLevel, essayType, essayPrompt, essayText: s.ocrText,
          stage,
          promptSummary: summary?.summary,
          opening1: summary?.opening1,
          opening2: summary?.opening2,
        });
        const r = await generateHandwritingWorksheet(apiConfig, genModel, prompt, s.ocrText, essayType);
        updateStudent(s.id, { result: r, genLoading: false });
        // Auto-save after each student's worksheet is generated
        const snap: StudentSnapshot[] = students.map((st): StudentSnapshot => ({
          id: st.id, filename: st.filename, studentName: st.studentName,
          ocrText: st.ocrText, ocrError: st.ocrError,
          result: st.id === s.id ? r : st.result, genError: st.genError,
        }));
        autoSave('handwriting', { essayType, essayPrompt, gradeLevel, printSettings, students: snap, promptSummary, classReport });
        genSuccessCount += 1;
      } catch (e) {
        track('generate_error', 'worksheet');
        updateStudent(s.id, { genLoading: false, genError: e instanceof Error ? e.message : '生成失败' });
      }
    }
    setGenBusy(false);
    if (genSuccessCount > 0) {
      track('generate_success', 'worksheet');
      // 整批完成后起一次存档标题（按题干；单生重新生成不重复触发）
      void refreshAutoTitle('handwriting', apiConfig, genModel, essayPrompt);
    }
  };

  // 生成结束（genBusy true→false）且有成品时，自动展开下一步：报告仍有效（重生成学生）→ ⑤ 导出；
  // 否则 → ④ 讲评报告（新报告或过期重生成，流程上的下一站）
  const wasGenerating = useRef(false);
  useEffect(() => {
    if (wasGenerating.current && !genBusy && students.some(s => s.result)) {
      setOpenStages(prev => { const n = new Set(prev); n.add(reportLive ? 'export' : 'report'); return n; });
    }
    wasGenerating.current = genBusy;
  }, [genBusy, students, reportLive]);

  // ─── Individual print / export ────────────────────

  const handlePrintOne = (s: StudentSheet) => {
    if (!s.result) return;
    printWorksheetPdf(s.studentName, gradeLevel, essayPrompt, s.ocrText, s.result, printSettings, promptSummary?.summary);
  };

  // ─── Batch print / export ─────────────────────────

  const handlePrintAll = () => {
    const ready = students.filter(s => s.result);
    if (ready.length === 0) return;
    track('export_success', 'worksheet');
    printAllWorksheetsPdf(essayPrompt, ready.map(s => ({
      studentName: s.studentName, gradeLevel, originalEssay: s.ocrText, result: s.result!,
    })), printSettings, promptSummary?.summary);
  };

  // ─── Word export（设备打印服务无「另存为 PDF」时的导出通道）───

  const docxParams = (s: StudentSheet): WorksheetDocxParams => ({
    studentName: s.studentName, gradeLevel, essayType,
    essayPrompt: promptSummary?.summary || essayPrompt, originalEssay: s.ocrText,
    r: s.result!, printSettings,
  });

  const handleExportWordOne = async (s: StudentSheet) => {
    if (!s.result || wordBusy) return;
    try {
      await exportHandwritingWorksheetDocx(docxParams(s));
    } catch (e) {
      setError(`导出 Word 失败：${e instanceof Error ? e.message : '未知错误'}`);
    }
  };

  const handleExportWordAll = async () => {
    const ready = students.filter(s => s.result);
    if (ready.length === 0 || wordBusy) return;
    setWordBusy(true);
    setError('');
    try {
      await exportAllHandwritingWorksheetsDocx(ready.map(docxParams));
      track('export_success', 'worksheet');
    } catch (e) {
      setError(`导出 Word 失败：${e instanceof Error ? e.message : '未知错误'}`);
    } finally {
      setWordBusy(false);
    }
  };

  // ─── 阶段流程派生状态 ─────────────────────────────

  const hasResults = students.some(s => s.result);
  const allOcrDone = students.length > 0 && students.every(s => !s.ocrPending && !s.ocrLoading);
  const promptDone = essayPrompt.trim().length > 0;
  const ocrDoneCount = students.filter(s => !s.ocrPending && !s.ocrLoading && !s.ocrError).length;
  const ocrHasError = students.some(s => !!s.ocrError);
  const genDoneCount = students.filter(s => s.result).length;
  const generating = genBusy || students.some(s => s.genLoading);
  const allGenerated = students.length > 0 && students.every(s => !!s.result);

  // ─── 单份学案：删除 / 备注重新生成 ─────────────────

  /** 删除单个学生的学案：识别原文保留在第 ② 步（可修改后重新生成或在该步移除该生） */
  const handleDeleteResult = (s: StudentSheet) => {
    if (!s.result || s.genLoading) return;
    if (!window.confirm(`确定删除 ${s.studentName} 的学案？\n\n识别原文仍保留在第 ② 步，可修改后重新生成；如需彻底移除该生，请到第 ② 步点「移除」。`)) return;
    if (regenNoteFor === s.id) { setRegenNoteFor(null); setRegenNote(''); }
    updateStudent(s.id, { result: null });
  };

  /** 展开/收起单个学生的备注框：自动打开卡片、滚动到位并聚焦输入框 */
  const openRegenNote = (id: string) => {
    if (regenNoteFor === id) { setRegenNoteFor(null); return; }
    setRegenNote('');
    setRegenNoteFor(id);
    // 重开时清掉上一次失败残留的错误（有 result 的学生只可能因重新生成失败带 genError）
    updateStudent(id, { genError: undefined });
    rafThen(() => {
      const det = document.getElementById(`hw-res-${id}`);
      if (det instanceof HTMLDetailsElement) det.open = true;
      document.getElementById(`hw-regen-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      document.getElementById(`hw-regen-input-${id}`)?.focus();
    });
  };

  /** 按备注重新生成单个学生的学案（备注留空 = 按原要求整体重出一份；失败保留旧学案） */
  const handleRegenerateOne = async (s: StudentSheet, note: string) => {
    if (s.genLoading || generating) return;
    if (!s.ocrText.trim()) { setError(`${s.studentName}：识别原文为空，请回第 ② 步核对后再重新生成`); return; }
    if (!apiConfig.apiKey.trim() && !serverMode) { setError('请先登录或填入 API Key'); return; }
    if (!(await confirmSpend(30, `重新生成 ${s.studentName} 的个性化学案（30 额度）`))) return;
    setError('');
    updateStudent(s.id, { genLoading: true, genError: undefined });
    try {
      const prompt = buildHandwritingWorksheetPrompt({
        studentName: s.studentName, gradeLevel, essayType, essayPrompt, essayText: s.ocrText,
        stage,
        promptSummary: promptSummary?.summary,
        opening1: promptSummary?.opening1,
        opening2: promptSummary?.opening2,
        teacherNote: note.trim().slice(0, 800) || undefined,
      });
      const r = await generateHandwritingWorksheet(apiConfig, genModel, prompt, s.ocrText, essayType);
      updateStudent(s.id, { result: r, genLoading: false, genError: undefined });
      setRegenNoteFor(null); setRegenNote('');
      // 与批量生成一致：成功后立即快照（1.5s 防抖自动保存会兜底补齐期间的并发编辑）
      const snap: StudentSnapshot[] = students.map((st): StudentSnapshot => ({
        id: st.id, filename: st.filename, studentName: st.studentName,
        ocrText: st.ocrText, ocrError: st.ocrError,
        result: st.id === s.id ? r : st.result, genError: st.genError,
      }));
      autoSave('handwriting', { essayType, essayPrompt, gradeLevel, printSettings, students: snap, promptSummary, classReport });
      track('generate_success', 'worksheet');
    } catch (e) {
      track('generate_error', 'worksheet');
      updateStudent(s.id, { genLoading: false, genError: e instanceof Error ? e.message : '重新生成失败' });
    }
  };

  const flowStages: FlowStageInfo[] = [
    { id: 'setup', label: '设置题目', done: promptDone },
    {
      id: 'upload', label: '上传识别',
      busy: students.some(s => s.ocrLoading),
      done: allOcrDone && !ocrHasError,
      sub: students.length ? `已识别 ${ocrDoneCount}/${students.length}` : undefined,
    },
    {
      id: 'generate', label: '生成学案',
      busy: generating,
      done: allGenerated,
      sub: students.length
        ? (generating ? `生成中 ${genDoneCount}/${students.length}`
          : hasResults ? `已生成 ${genDoneCount}/${students.length}` : undefined)
        : undefined,
    },
    {
      id: 'report', label: '讲评报告',
      busy: reportBusy,
      done: reportLive,
      ready: hasResults,
      sub: reportBusy ? '生成中' : reportLive ? '已生成' : classReport ? '已过期' : hasResults ? `${genDoneCount} 份可统计` : undefined,
    },
    { id: 'export', label: '导出', ready: hasResults, sub: hasResults ? `${genDoneCount} 份可导出` : undefined },
  ];

  // 目录条目（含学生子项），锚点 id 与渲染处一致
  const tocItems: TocEntry[] = [
    { id: stageAnchor('setup'), label: '① 设置题目', ...(promptDone ? { status: 'done' as const, statusText: '✓' } : {}) },
    {
      id: stageAnchor('upload'), label: '② 上传识别',
      ...(students.some(s => s.ocrLoading) ? { status: 'busy' as const, statusText: '⏳' }
        : students.length && allOcrDone && !ocrHasError ? { status: 'done' as const, statusText: '✓' } : {}),
    },
    ...students.map((s): TocEntry => ({
      id: `hw-ocr-${s.id}`, label: s.studentName || '未命名', depth: 1, parentId: stageAnchor('upload'),
      ...(s.ocrLoading ? { status: 'busy' as const, statusText: '⏳' }
        : s.ocrPending ? { statusText: '…' }
        : s.ocrError ? { status: 'error' as const, statusText: '✕' }
        : s.ocrText ? { status: 'done' as const, statusText: '✓' } : {}),
    })),
    {
      id: stageAnchor('generate'), label: '③ 生成学案',
      ...(generating ? { status: 'busy' as const, statusText: '⏳' }
        : allGenerated ? { status: 'done' as const, statusText: '✓' } : {}),
    },
    ...students.filter(s => s.result || s.genError).map((s): TocEntry => ({
      id: `hw-res-${s.id}`, label: s.studentName || '未命名', depth: 1, parentId: stageAnchor('generate'),
      ...(s.genLoading ? { status: 'busy' as const, statusText: '⏳' }
        : s.result ? { status: 'done' as const, statusText: '✓' } : { status: 'error' as const, statusText: '✕' }),
    })),
    {
      id: stageAnchor('report'), label: '④ 讲评报告',
      ...(reportBusy ? { status: 'busy' as const, statusText: '⏳' }
        : reportLive ? { status: 'done' as const, statusText: '✓' }
        : hasResults ? { statusText: `${genDoneCount} 份` } : {}),
    },
    { id: stageAnchor('export'), label: '⑤ 批量导出', ...(hasResults ? { statusText: `${genDoneCount} 份` } : {}) },
  ];

  // 滚动联动：阶段 + 学案卡片锚点（按文档顺序）。第 ② 步为单一核对面板，
  // 由阶段锚点统一代表；学案卡片锚点随阶段收起而卸载，只跟踪实际存在的元素。
  const spyIds = [
    stageAnchor('setup'), stageAnchor('upload'),
    stageAnchor('generate'),
    ...(openStages.has('generate') ? students.filter(s => s.result || s.genError).map(s => `hw-res-${s.id}`) : []),
    stageAnchor('report'),
    stageAnchor('export'),
  ];
  const activeAnchorId = useScrollspy(spyIds);
  // 学生锚点归属其所在阶段，供流程条高亮（目录条目直接用锚点 id）
  const activeStageId = activeAnchorId == null ? null
    : activeAnchorId.startsWith('hw-ocr-') ? 'upload'
    : activeAnchorId.startsWith('hw-res-') ? 'generate'
    : activeAnchorId.replace('hw-stage-', '');
  // 逐名核对（第 ② 步）时隐藏左侧目录，腾出的宽度全部让给核对面板的手写大图；
  // 滚到其他阶段目录自动恢复。吸顶流程条始终保留，导航不受影响。
  const tocHidden = students.length > 0 && activeStageId === 'upload';

  // ─── Render ───────────────────────────────────────

  return (
    <div className="writing-module">
      {/* 页头：标题 + 醒目的保存/历史入口（原入口只在右下角悬浮球，不易发现） */}
      <div className="sf-header">
        <div>
          <h2><Icon name="handwriting" size={20} /> 书面表达批改学案</h2>
          <p>设置题干 → 上传手写图片识别 → 批量生成个性化学案 → 生成讲评报告 → 打印 / 导出</p>
        </div>
        <div className="sf-header-actions">
          <button className="hw-btn-sm" onClick={handleSave} title="保存当前题干与学案，稍后可从历史记录载入"><Icon name="save" size={16} /> 保存进度</button>
          <button className="hw-btn-sm" onClick={() => setShowHistory(true)} title="载入之前保存的题干与学案"><Icon name="history" size={16} /> 历史记录 / 载入</button>
        </div>
      </div>

      {/* 阶段流程条：吸顶展示 ①→②→③→④，点击跳转；错误提示常驻可见 */}
      <div className="sf-stepper-wrap">
        <StageStepper stages={flowStages} activeId={activeStageId} onJump={handleStageJump} />
        {error && <ErrorBar error={error} />}
      </div>

      <div className={`sf-layout ${tocHidden ? 'rail-off' : ''}`}>
        {/* 左侧跟随目录（窄屏隐藏；第 ② 步核对时临时隐藏让位大图，靠吸顶流程条导航） */}
        {!tocHidden && (
          <aside className="sf-rail">
            <StageToc items={tocItems} activeId={activeAnchorId} onJump={jumpToAnchor} />
          </aside>
        )}

        <div className="sf-main">
          {/* ① 设置题目 */}
          <StageCard anchorId={stageAnchor('setup')} index={1} title="设置题目"
            done={promptDone}
            meta={`${getEssayTypeLabel(stage, essayType)} · ${gradeLevel}`}
            summary={`${getEssayTypeLabel(stage, essayType)} · ${gradeLevel} · ${promptDone ? '题干已填写' : '题干未填写'}`}
            open={openStages.has('setup')} onToggle={() => toggleStage('setup')}>
            <div className="hw-input-grid">
              <div className="hw-input-group">
                <label className="input-label">作文类型</label>
                <div className="level-pills">
                  {ESSAY_TYPES.filter(t => stage === 'senior' || t.value === 'practical').map(t => (
                    <button key={t.value} className={`level-pill ${essayType === t.value ? 'active' : ''}`}
                      onClick={() => updateEssayType(t.value)} disabled={genBusy}>{getEssayTypeLabel(stage, t.value)}</button>
                  ))}
                </div>
              </div>
              <div className="hw-input-group">
                <label className="input-label">年级</label>
                <div className="level-pills">
                  {GRADE_LEVELS[stage].map(g => (
                    <button key={g} className={`level-pill ${gradeLevel === g ? 'active' : ''}`}
                      onClick={() => setGradeLevel(g)} disabled={genBusy}>{g}</button>
                  ))}
                </div>
              </div>
            </div>

            <div className="input-section">
              <label className="input-label" htmlFor="hw-prompt">作文题干（所有学生共用）</label>
              <textarea id="hw-prompt" value={essayPrompt} onChange={e => setEssayPrompt(e.target.value)}
                placeholder={stage === 'junior'
                  ? `粘贴作文原始题目，LLM 将对照题干分析每位学生是否偏题、遗漏要点。所有学生共用一个题干。例如：\n\n假定你是李华，你校将举办英语演讲比赛。请你给外教 Ms. Green 写一封邮件，邀请她担任评委，内容包括：\n1. 比赛时间与地点；\n2. 比赛主题；\n3. 邀请事由。\n注意：1. 词数 80-100；2. 可以适当增加细节，以使行文连贯。`
                  : `粘贴作文原始题目，LLM 将对照题干分析每位学生是否偏题、遗漏要点。所有学生共用一个题干。例如：\n\n假定你是李华，你校将举办英语演讲比赛。请你给外教 Ms. Green 写一封邮件，邀请她担任评委，内容包括：\n1. 比赛时间与地点；\n2. 比赛主题；\n3. 邀请事由。\n注意：1. 词数 100 左右；2. 可以适当增加细节，以使行文连贯。`}
                rows={6} disabled={genBusy} />
              {/* 看图/图表作文：配图 AI 读图转文字，核对后并入题干（空题干直接设值，不留前导空行） */}
              <PromptImageReader apiConfig={apiConfig} quota={quota} disabled={genBusy}
                onInsert={(block) => setEssayPrompt((prev) => prev.trimEnd() ? prev.trimEnd() + '\n\n' + block : block)} />
            </div>

            <div className="sf-stage-footer">
              <button className="sf-next-btn" onClick={() => jumpToAnchor(stageAnchor('upload'))}>下一步：上传手写作文 ↓</button>
            </div>
          </StageCard>

          {/* ② 上传识别 */}
          <StageCard anchorId={stageAnchor('upload')} index={2} title="上传识别"
            busy={students.some(s => s.ocrLoading)}
            done={allOcrDone && !ocrHasError}
            meta={students.length ? `已识别 ${ocrDoneCount}/${students.length}${ocrHasError ? ' · 部分失败' : ''}` : ''}
            summary={students.length ? `${students.length} 名学生 · 已识别 ${ocrDoneCount}/${students.length}${ocrHasError ? ' · 部分失败' : ''}` : '尚未上传'}
            open={openStages.has('upload')} onToggle={() => toggleStage('upload')}>
            <div className="hw-ocr-toolbar">
              <label className="input-label hw-label-nomargin">上传手写作文图片（每个学生一张）</label>
              <div className="hw-ocr-model-select">
                <span className="hw-ocr-model-label">OCR：</span>
                {serverMode ? (
                  <span className="model-label">{getEffectiveModel('ocr', ocrModel)}</span>
                ) : (
                  <ModelSelect className="model-select" value={ocrModel} onChange={setOcrModel} options={OCR_MODEL_OPTIONS} disabled={ocrBusy || genBusy} title="OCR 识别模型" />
                )}
              </div>
            </div>

            {/* 扫码拍照上传：手机拍 → 电脑实时收（仅登录后可用，面板内部处理 401） */}
            <QrUploadPanel importBusy={ocrBusy || genBusy} onImport={importQrPhotos} />

            <div className={`hw-drop-zone ${dragOver ? 'drag-over' : ''}`}
              onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}>
              <div className="hw-drop-icon"><Icon name="camera" size={32} /></div>
              <div className="hw-drop-text">拖拽手写图片到此处，或点击选择文件</div>
              <div className="hw-drop-hint">支持批量上传。每张图片对应一位学生，文件名自动解析为学生姓名；文件名为相机默认名或纯数字时，自动采用图片中识别到的姓名。</div>
              <div className="hw-drop-hint hw-drop-consent"><Icon name="warning" size={14} /> 上传前请确认已获得学生（或家长）同意；如需匿名，可先用铅笔遮挡姓名再拍摄。照片仅用于当次识别（扫码上传的照片至多暂存 24 小时后自动删除），详见「隐私与数据说明」。{serverMode && 'OCR 识别每张消耗 1 额度，失败不扣。'}</div>
              <input ref={fileInputRef} type="file" accept="image/*" multiple onChange={handleFileChange} style={{ display: 'none' }} />
            </div>

            {/* ── 逐名学生核对 ── */}
            <StudentVerifyPanel
              students={students}
              index={currentStudentIdx}
              onSelectIndex={selectStudent}
              zoom={ocrZoom}
              onZoomChange={changeZoom}
              onUpdate={updateStudent}
              onRemoveAt={removeStudentAt}
              onClear={clearAll}
              ocrBusy={ocrBusy}
              genBusy={genBusy}
            />

            {/* 阶段收尾：生成入口 */}
            {students.length > 0 && (
              <div className="sf-stage-footer">
                {serverMode ? (
                  <span className="model-label">模型: {getEffectiveModel('worksheet', genModel)}</span>
                ) : (
                  <ModelSelect className="model-select" value={genModel} onChange={setGenModel} options={MODEL_OPTIONS} disabled={genBusy} title="学案生成模型" />
                )}
                <button className="btn-extract" onClick={handleGenerateAll} disabled={generating || !allOcrDone}>
                  {genBusy
                    ? '生成中...'
                    : (<><Icon name="sparkles" size={16} /> 生成全部学案（{students.filter(s => !s.result).length} 份{serverMode ? ` · ${students.filter(s => !s.result).length * 30} 额度` : ''}）</>)}
                </button>
                {!allOcrDone && <span className="sf-footer-hint">等待识别完成…</span>}
              </div>
            )}
          </StageCard>

          {/* ③ 生成学案 */}
          <StageCard anchorId={stageAnchor('generate')} index={3} title="生成学案"
            busy={generating}
            done={allGenerated}
            meta={students.length ? `已生成 ${genDoneCount}/${students.length}` : ''}
            summary={hasResults ? `已生成 ${genDoneCount}/${students.length} 份学案（点击展开核对）` : '尚未生成'}
            open={openStages.has('generate')} onToggle={() => toggleStage('generate')}>
            {genBusy && (
              <div className="hw-gen-progress">
                <div className="spinner-sm" />
                <span>正在生成学案 {genDoneCount}/{students.length}，请稍候…</span>
              </div>
            )}
            {!hasResults && !genBusy && (
              <p className="sf-stage-hint">完成第 ② 步后点击「生成全部学案」，每位学生的个性化学案将出现在这里，所有内容均可点击修改。</p>
            )}
            {/* 生成失败的学生：与成品列表一起展示，便于定位重试 */}
            {students.filter(s => s.genError && !s.result).map(s => (
              <div key={s.id} id={`hw-res-${s.id}`} className="error-msg hw-gen-fail-row">
                <span>✕</span> {s.studentName}：{s.genError} — 可回第 ② 步检查原文后重新生成
              </div>
            ))}
            {hasResults && (
              <div className="hw-results-list">
                {students.filter(s => s.result).map((s) => (
                  <details key={s.id} id={`hw-res-${s.id}`} className="hw-student-details">
                    <summary className="hw-student-summary">
                      <span className="hw-student-name">{s.studentName}</span>
                      {s.result?.score != null && s.result?.maxScore != null && (
                        <span className={`hw-score-chip${(s.result.score / s.result.maxScore) < 0.5 ? ' low' : ''}`}>{s.result.score}/{s.result.maxScore}</span>
                      )}
                      <span className="hw-student-file">({s.filename})</span>
                      <span className="hw-summary-actions">
                        <button className="hw-btn-sm hw-dl-btn" onClick={(e) => { e.preventDefault(); handlePrintOne(s); }}
                          title="打开打印窗口：需要纸质版直接点「打印」；需要 PDF 文件请在目标打印机中选择「另存为 PDF」">
                          <Icon name="print" size={16} /> 打印 / 导出 PDF
                        </button>
                        <button className="hw-btn-sm hw-dl-btn" onClick={(e) => { e.preventDefault(); handleExportWordOne(s); }} disabled={wordBusy}
                          title="下载 .docx 文件；可用 WPS/Word 打开并另存为 PDF（适用于无法打印为 PDF 的设备）">
                          <Icon name="exportDoc" size={16} /> 导出 Word
                        </button>
                        <button className="hw-btn-sm hw-dl-btn" onClick={(e) => { e.preventDefault(); openRegenNote(s.id); }} disabled={genBusy || s.genLoading}
                          title="审核后需要修改？添加备注（修改要求），AI 将按备注重新生成这份学案">
                          <Icon name="worksheet" size={16} /> 备注重新生成
                        </button>
                        <button className="hw-btn-sm hw-dl-btn hw-del-btn" onClick={(e) => { e.preventDefault(); handleDeleteResult(s); }} disabled={genBusy || s.genLoading}
                          title="删除这份学案；识别原文保留在第 ② 步，可修改后重新生成">
                          <Icon name="trash" size={16} /> 删除
                        </button>
                      </span>
                    </summary>
                    <div className="hw-student-result">
                      {regenNoteFor === s.id && (
                        <div className="hw-regen-panel" id={`hw-regen-${s.id}`}>
                          <label className="input-label hw-label-nomargin" htmlFor={`hw-regen-input-${s.id}`}>备注：这份学案需要怎么改？（AI 将按备注重新生成）</label>
                          <textarea id={`hw-regen-input-${s.id}`} className="hw-ocr-textarea" rows={3}
                            value={regenNote} onChange={e => setRegenNote(e.target.value)}
                            placeholder="例：范文用词再简单一些；错误诊断重点看时态一致；多给两条巩固练习……（留空则按原要求整体重新生成）"
                            disabled={s.genLoading} />
                          {s.genError && <div className="error-msg hw-regen-error"><span>✕</span> {s.genError}</div>}
                          <div className="hw-regen-actions">
                            <button className="hw-btn-sm" onClick={() => { setRegenNoteFor(null); setRegenNote(''); }} disabled={s.genLoading}>取消</button>
                            <button className="hw-btn-sm hw-regen-confirm" onClick={() => handleRegenerateOne(s, regenNote)} disabled={generating}>
                              {s.genLoading ? '重新生成中…' : (<><Icon name="refresh" size={16} /> 按备注重新生成{serverMode ? '（30 额度）' : ''}</>)}
                            </button>
                          </div>
                        </div>
                      )}
                      {s.genLoading && (
                        <div className="hw-gen-progress">
                          <div className="spinner-sm" />
                          <span>正在重新生成 {s.studentName} 的学案，完成后将替换当前内容…</span>
                        </div>
                      )}
                      <ResultErrorBoundary label={s.studentName}
                        onReset={() => updateStudent(s.id, { result: null, genError: '学案数据异常已清除，请重新生成' })}>
                        <WorksheetResultView r={s.result!} essayType={essayType} updateResult={(key, value) => {
                          updateStudent(s.id, { result: { ...s.result!, [key]: value } });
                        }} />
                      </ResultErrorBoundary>
                    </div>
                  </details>
                ))}
              </div>
            )}
          </StageCard>

          {/* ④ 讲评报告：客观统计实时现算 + LLM 班级讲评报告快照（含导出，见 ClassReportPanel） */}
          <StageCard anchorId={stageAnchor('report')} index={4} title="讲评报告"
            busy={reportBusy}
            done={reportLive}
            meta={classReport
              ? (reportLive ? `已生成 · ${new Date(classReport.generatedAt).toLocaleDateString('zh-CN')}` : '报告已过期，可重新生成')
              : (hasResults ? `${genDoneCount} 份可统计` : '')}
            summary={classReport
              ? (reportLive ? '已生成班级讲评报告（点击展开查看）' : '成绩已修改，报告为过期快照（点击展开/重新生成）')
              : hasResults ? `${genDoneCount} 份学案可统计班级共性问题` : '生成学案后可生成班级讲评报告'}
            open={openStages.has('report')} onToggle={() => toggleStage('report')}>
            <ClassReportPanel
              apiConfig={apiConfig} stage={stage} essayType={essayType} gradeLevel={gradeLevel}
              essayPrompt={essayPrompt} promptSummary={promptSummary}
              students={students} report={classReport} stale={!!classReport && !reportLive}
              busy={reportBusy} onBusyChange={setReportBusy}
              confirmSpend={confirmSpend} serverMode={serverMode} genModel={genModel}
              onGenerated={setClassReport} onError={setError}
            />
          </StageCard>

          {/* ⑤ 批量导出 */}
          <StageCard anchorId={stageAnchor('export')} index={5} title="批量导出"
            meta={hasResults ? `${genDoneCount} 份可导出` : ''}
            summary={hasResults ? `${genDoneCount} 份学案可导出 PDF / Word` : '生成学案后可批量导出'}
            open={openStages.has('export')} onToggle={() => toggleStage('export')}>
            <div className="hw-settings-panel">
              <div className="hw-setting-item">
                <label className="input-label">学案标题</label>
                <input className="hw-text-input" value={printSettings.title}
                  onChange={e => setPrintSettings(prev => ({ ...prev, title: e.target.value }))} />
              </div>
              <div className="hw-setting-item">
                <label className="input-label">副标题</label>
                <input className="hw-text-input" value={printSettings.subtitle}
                  onChange={e => setPrintSettings(prev => ({ ...prev, subtitle: e.target.value }))} />
              </div>
            </div>
            <div className="input-actions">
              <button className="btn-export-docx" onClick={handlePrintAll} disabled={!hasResults}
                title="打开打印窗口：需要纸质版直接点「打印」；需要 PDF 文件请在目标打印机中选择「另存为 PDF」">
                <Icon name="package" size={16} /> 打印 / 导出全部 PDF（{genDoneCount} 份）
              </button>
              <button className="btn-export-docx" onClick={handleExportWordAll} disabled={!hasResults || wordBusy}
                title="下载 .docx 文件（zip 打包），可用 WPS/Word 打开并另存为 PDF">
                {wordBusy ? '导出 Word 中…' : (<><Icon name="exportDoc" size={16} /> 导出全部 Word（{genDoneCount} 份）</>)}
              </button>
            </div>
            <p className="sf-stage-hint">每位学生的单独导出按钮在其学案卡片（第 ③ 步）的标题行上；批量导出前可先修改上方标题与副标题。</p>
          </StageCard>
        </div>
      </div>

      {showHistory && (
        <HistoryModal
          module="handwriting"
          moduleLabel={MODULE_LABELS.handwriting}
          onLoad={(item) => { restoreState((item as SavedItem<HandwritingState>).data); setShowHistory(false); }}
          onClose={() => setShowHistory(false)}
        />
      )}
      {costDialog}
    </div>
  );
}
