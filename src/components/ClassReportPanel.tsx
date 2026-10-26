import { useMemo, useState } from 'react';
import type { ApiConfig, ClassFeedbackReport, EssayType, GradeLevel, PromptSummary, Stage } from '../types';
import { getCohesionLabel, getEssayTypeLabel } from '../types';
import { buildClassReportSystemPrompt, buildClassReportUserContent } from '../prompts/handwritingPrompts';
import { generateClassFeedbackReport } from '../services/llm';
import { printClassReportPdf } from '../services/worksheetPdf';
import { exportClassReportDocx } from '../services/classReportDocx';
import { exportClassReportPptx } from '../services/classReportPptx';
import { buildStudentDigests, buildRoster, classReportFingerprint, classReportToPlainText, computeClassStats, pickHighlightTexts, type StatsStudent } from '../utils/classStats';
import { getEffectiveModel } from '../utils/model';
import { track } from '../utils/analytics';
import Spinner from './Spinner';
import { Icon } from './icons';
import './ClassReportPanel.css';

/** 生成时的轮播文案（整班叙事生成，耗时介于单生学案与整卷转写之间） */
const REPORT_STATUS_MESSAGES = [
  '正在汇总全班批改数据...',
  '正在提炼共性问题...',
  '正在挑选亮点例句...',
  '正在设计评讲课建议...',
  '即将完成，请耐心等待...',
];

const BAND_LABELS = ['一档', '二档', '三档', '四档', '五档'];
const SEV_LABELS: Record<ClassFeedbackReport['commonProblems'][number]['severity'], string> = { high: '高', medium: '中', low: '低' };
const clipText = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

interface Props {
  apiConfig: ApiConfig;
  stage: Stage;
  essayType: EssayType;
  gradeLevel: GradeLevel;
  essayPrompt: string;
  promptSummary: PromptSummary | null;
  /** StudentSheet[] 按结构传入（StatsStudent 最小接口） */
  students: StatsStudent[];
  report: ClassFeedbackReport | null;
  /** 父级按指纹判定：报告与当前学生数据是否一致（不一致 → 过期提示 + 导出前确认） */
  stale: boolean;
  /** 生成 busy 提升在父级（④ 卡收起会卸载本组件，busy 不能放内部） */
  busy: boolean;
  onBusyChange: (b: boolean) => void;
  /** 父级 useCostGate 的确认门（确认卡由父级渲染） */
  confirmSpend: (cost: number, what: string, note?: string) => Promise<boolean>;
  /** 登录/游客模式（显示额度与强制模型）；自带 key 为 false */
  serverMode: boolean;
  /** 第 ③ 步选的学案生成模型（自带 key 模式沿用） */
  genModel: string;
  onGenerated: (r: ClassFeedbackReport) => void;
  onError: (msg: string) => void;
}

/** ④ 讲评报告：客观统计（实时现算）+ LLM 班级讲评报告（快照）+ 导出入口 */
export default function ClassReportPanel({ apiConfig, stage, essayType, gradeLevel, essayPrompt, promptSummary, students, report, stale, busy, onBusyChange, confirmSpend, serverMode, genModel, onGenerated, onError }: Props) {
  const [copied, setCopied] = useState(false);
  const [docBusy, setDocBusy] = useState(false);
  const [pptBusy, setPptBusy] = useState(false);

  // 统计永远对当前学生数据现算：老师改分后数字即时跟随（不耗额度）
  const stats = useMemo(() => computeClassStats(students), [students]);
  const essayTypeLabel = getEssayTypeLabel(stage, essayType);

  const handleGenerate = async () => {
    if (busy || stats.studentCount < 2) return;
    if (!(await confirmSpend(10, '生成班级讲评报告'))) return;
    onError(''); onBusyChange(true);
    try {
      const eligibleNames = [...new Set(students.filter(s => s.result && !s.genError).map(s => s.studentName).filter(n => n.length >= 2))];
      const params = {
        stage, essayType, gradeLevel, essayPrompt,
        promptSummary: promptSummary?.summary,
        opening1: promptSummary?.opening1,
        opening2: promptSummary?.opening2,
        stats,
        digests: buildStudentDigests(students, essayType),
        highlightTexts: pickHighlightTexts(students),
      };
      const r = await generateClassFeedbackReport(
        apiConfig, getEffectiveModel('class_report', genModel),
        buildClassReportSystemPrompt(params), buildClassReportUserContent(params),
        {
          essayType, studentCount: stats.studentCount,
          fingerprint: classReportFingerprint(students, essayType, essayPrompt, promptSummary?.summary),
          studentNames: eligibleNames, // 匿名铁律的 normalize 兜底名单
        },
      );
      onGenerated(r);
      track('generate_success', 'class_report');
    } catch (e) {
      track('generate_error', 'class_report');
      onError('讲评报告生成失败：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      onBusyChange(false);
    }
  };

  const handleCopy = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(classReportToPlainText(stats, report, { essayType, essayTypeLabel, gradeLevel }));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      onError('复制失败：浏览器未授权剪贴板，请手动选择文本复制');
    }
  };

  // 三种导出共用：名册只进老师私有的 PDF/Word，PPT 不带（课件投影给全班）；
  // 报告已过期时先确认（导出的是生成时快照，统计/名册是实时数据）
  const confirmStaleExport = () => !stale || window.confirm('成绩/学案在报告生成后有修改：将导出「生成时快照」的叙述与「实时」的统计/名册（两者可能不一致）。仍要导出吗？');

  const exportMeta = () => ({
    stats, report: report!, roster: buildRoster(students), essayType, essayTypeLabel, gradeLevel,
    essayPromptDigest: clipText(promptSummary?.summary || essayPrompt, 300),
    dateLabel: new Date(report!.generatedAt).toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
  });

  const handlePrint = () => {
    if (!report || !confirmStaleExport()) return;
    printClassReportPdf(exportMeta());
  };

  const handleDocx = async () => {
    if (!report || docBusy || !confirmStaleExport()) return;
    setDocBusy(true);
    try {
      const { dateLabel: _drop, ...docxParams } = exportMeta();
      await exportClassReportDocx(docxParams);
      track('export_success', 'class_report');
    } catch (e) {
      onError('Word 导出失败：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setDocBusy(false);
    }
  };

  const handlePptx = async () => {
    if (!report || pptBusy || !confirmStaleExport()) return;
    setPptBusy(true);
    try {
      await exportClassReportPptx(exportMeta());
      track('export_success', 'class_report');
    } catch (e) {
      onError('PPT 导出失败：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setPptBusy(false);
    }
  };

  const cohesionLabel = getCohesionLabel(essayType);
  const maxErrCount = Math.max(stats.errorCounts.grammar, stats.errorCounts.vocabulary, stats.errorCounts.sentence, stats.errorCounts.logic, 1);
  const generatedLabel = report ? new Date(report.generatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

  return (
    <div className="cr-panel">
      {/* 一、客观统计：实时现算，不耗额度 */}
      <div className="cr-stats">
        {stats.studentCount === 0 ? (
          <p className="sf-stage-hint">尚无已生成的学案——完成第 ③ 步后，这里会出现班级统计与讲评报告入口。</p>
        ) : (
          <>
            <div className="cr-tiles">
              <div className="cr-tile"><span className="cr-tile-num">{stats.studentCount}</span><span className="cr-tile-label">参与统计</span></div>
              <div className="cr-tile"><span className="cr-tile-num">{stats.avgScore ?? '—'}</span><span className="cr-tile-label">平均分{stats.scoreScale ? `（满分 ${stats.scoreScale}）` : ''}</span></div>
              <div className="cr-tile"><span className="cr-tile-num">{stats.maxScore ?? '—'}</span><span className="cr-tile-label">最高分</span></div>
              <div className="cr-tile"><span className="cr-tile-num">{stats.minScore ?? '—'}</span><span className="cr-tile-label">最低分</span></div>
            </div>
            {stats.excludedCount > 0 && (
              <p className="cr-excluded">另有 {stats.excludedCount} 份生成失败，未计入统计</p>
            )}
            {stats.pendingCount > 0 && (
              <p className="cr-excluded">另有 {stats.pendingCount} 份尚未生成（完成第 ③ 步后计入）</p>
            )}
            {stats.bandDistribution ? (
              <div className="cr-band-row">
                {stats.bandDistribution.map((n, i) => (
                  <div key={i} className="cr-band-chip"><b>{n}</b><span>{BAND_LABELS[i]}</span></div>
                ))}
              </div>
            ) : (
              <p className="cr-muted">分制非 15/25，未统计档位分布</p>
            )}
            <div className="cr-freq">
              {(['grammar', 'vocabulary', 'sentence', 'logic'] as const).map(key => (
                <div key={key} className="cr-freq-row">
                  <span className="cr-freq-label">{{ grammar: '语法', vocabulary: '词汇', sentence: '句式', logic: '逻辑' }[key]}</span>
                  <span className="cr-freq-bar-track"><span className="cr-freq-bar" style={{ width: `${(stats.errorCounts[key] / maxErrCount) * 100}%` }} /></span>
                  <span className="cr-freq-count">{stats.errorCounts[key]}</span>
                </div>
              ))}
            </div>
            <p className="cr-muted">
              分项均分：内容 {stats.avgBreakdown.content ?? '—'} · 语言 {stats.avgBreakdown.language ?? '—'} · {cohesionLabel} {stats.avgBreakdown.cohesion ?? '—'}
              {' · '}偏题 {stats.offTopicCount} 人 · 遗漏要点 {stats.missedPointCount} 处
            </p>
          </>
        )}
      </div>

      {/* 生成入口：≥2 份有效学案才可生成 */}
      <div className="sf-stage-footer cr-gen-row">
        {serverMode && <span className="model-label">模型: {getEffectiveModel('class_report', genModel)}</span>}
        <button className="btn-extract" onClick={handleGenerate} disabled={busy || stats.studentCount < 2}>
          {busy ? '生成中...' : (<><Icon name="sparkles" size={16} /> {report ? '重新生成讲评报告' : '生成讲评报告'}{serverMode ? '（10 额度）' : ''}</>)}
        </button>
        {stats.studentCount < 2 && <span className="sf-footer-hint">至少 2 份已生成学案后，才能提炼班级共性问题</span>}
      </div>

      {/* 二～五、LLM 讲评报告（生成时快照） */}
      {report && (
        <div className="cr-report">
          <div className="cr-report-head">
            <span className="cr-generated">生成于 {generatedLabel} · 参与统计 {report.studentCount} 人</span>
            {stale && <span className="cr-stale"><Icon name="warning" size={14} /> 生成后成绩/学案有修改：统计区为实时数据，以下叙述为生成时快照，可重新生成</span>}
          </div>

          <section className="cr-sec">
            <h4 className="cr-sec-title">共性问题</h4>
            {report.commonProblems.length === 0 && <p className="cr-muted">（本次未提炼出共性问题）</p>}
            {report.commonProblems.map((p, i) => (
              <div key={i} className="cr-problem">
                <div className="cr-problem-head">
                  <span className={`cr-sev cr-sev-${p.severity}`}>{SEV_LABELS[p.severity]}</span>
                  <h5>{p.title}</h5>
                </div>
                <p className="cr-problem-desc">{p.description}</p>
                {p.examples.map((e, j) => (
                  <div key={j} className="cr-example">
                    <div className="cr-ex-row"><span className="cr-ex-label">有同学写道</span><span className="cr-ex-quote">“{e.quote}”</span></div>
                    {e.corrected && <div className="cr-ex-row"><span className="cr-ex-label">改正</span><span className="cr-ex-corr">“{e.corrected}”</span></div>}
                    {e.note && <div className="cr-ex-row"><span className="cr-ex-label">点评</span><span className="cr-ex-note">{e.note}</span></div>}
                  </div>
                ))}
              </div>
            ))}
          </section>

          {report.suggestions.length > 0 && (
            <section className="cr-sec">
              <h4 className="cr-sec-title">建设性意见</h4>
              <ol className="cr-list">{report.suggestions.map((s, i) => <li key={i}>{s}</li>)}</ol>
            </section>
          )}

          {report.highlights.length > 0 && (
            <section className="cr-sec">
              <h4 className="cr-sec-title">亮点展示（具名表扬）</h4>
              {report.highlights.map((h, i) => (
                <div key={i} className="cr-highlight">
                  <p className="cr-hl-quote">“{h.sentence}”</p>
                  <p className="cr-hl-attr">—— {h.studentName}：{h.comment}</p>
                </div>
              ))}
            </section>
          )}

          {report.lessonPlan.length > 0 && (
            <section className="cr-sec">
              <h4 className="cr-sec-title">评讲课建议</h4>
              <ol className="cr-list">{report.lessonPlan.map((s, i) => <li key={i}>{s}</li>)}</ol>
            </section>
          )}

          <div className="sf-stage-footer cr-actions">
            <button className="hw-btn-sm" onClick={handleCopy}>{copied ? '✓ 已复制' : (<><Icon name="copy" size={16} /> 复制文本</>)}</button>
            <button className="hw-btn-sm" onClick={handlePrint}
              title="打开打印窗口：需要纸质版直接点「打印」；需要 PDF 文件请在目标打印机中选择「另存为 PDF」"><Icon name="print" size={16} /> 打印 / PDF</button>
            <button className="hw-btn-sm" onClick={handleDocx} disabled={docBusy}
              title="下载 .docx 文件（含成绩名册，仅供老师自用）">{docBusy ? '导出中…' : (<><Icon name="exportDoc" size={16} /> 导出 Word</>)}</button>
            <button className="hw-btn-sm" onClick={handlePptx} disabled={pptBusy}
              title="下载评讲课课件 .pptx（投影用，不含成绩名册）">{pptBusy ? '导出中…' : (<><Icon name="slideshow" size={16} /> 导出 PPT</>)}</button>
          </div>
        </div>
      )}

      {busy && <Spinner showProgress text="正在生成班级讲评报告..." messages={REPORT_STATUS_MESSAGES} />}
    </div>
  );
}
