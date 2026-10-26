import { useEffect, useState } from 'react';
import type {
  ContinuationWritingResult, EssayType, ExamPaperState, FieldSelection, HandwritingState,
  ModuleKey, PracticalWritingResult, Stage, StudentSnapshot, VocabItem,
} from '../types';
import { DEFAULT_EXAM_LAYOUT, GRADE_LEVELS, MODULE_LABELS, defaultGradeLevel, getEssayTypeLabel } from '../types';
import { loadHistory } from '../utils/history';
import { track } from '../utils/analytics';
import { formatDateTime } from '../utils/usageStats';
import { computeClassStats } from '../utils/classStats';
import { exportCSV, groupBySection } from './VocabTable';
import { exportPracticalWritingDocx, exportContinuationWritingDocx } from '../services/docxExport';
import { exportExamPaperDocx } from '../services/examDocxExport';
import { printAllWorksheetsPdf } from '../services/worksheetPdf';
import { exportAllHandwritingWorksheetsDocx } from '../services/handwritingExport';
import { exportClassReportPptx } from '../services/classReportPptx';
import './UsageStats.css';

/**
 * 主页「最近生成」：跨模块合并 vb_history_* 最近记录（top 10）。
 * 每条可「打开」（经 historyHandoff 跳进工具并恢复）或直接导出（纯函数导出，
 * 不含任何 LLM 路径——词汇 Word 的语法填空 / 讲评报告生成请进工具页）。
 * PII：行内只显示模块徽章 + 记录名 + 时间，绝不渲染 payload 摘录（handwriting 含学生姓名）。
 */

const MODULES: ModuleKey[] = ['vocab', 'practical', 'continuation', 'handwriting', 'copybook', 'exampaper'];
const RECENT_COUNT = 10;

interface RecentRow {
  module: ModuleKey;
  id: string;
  name: string;
  /** LLM 生成的存档标题（显示在 Autosave+日期 之后） */
  autoTitle?: string;
  savedAt: string;
  data: Record<string, unknown>;
}

interface ExportBtn {
  kind: 'csv' | 'word' | 'pdf' | 'ppt';
  text: string;
  /** track('export_success') 的 label，与 tab 内一致 */
  label: string;
  title?: string;
}

const fmtTime = (iso: string): string => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? '—' : formatDateTime(ms);
};

/** 复制 HandwritingWorksheet.restoreState 的跨学段校验——直接导出绕过了 restoreState，防护必须在此重做。 */
function hwValidated(d: HandwritingState, stage: Stage): { gradeLevel: HandwritingState['gradeLevel']; essayType: EssayType } {
  const gradeLevel = GRADE_LEVELS[stage].includes(d.gradeLevel) ? d.gradeLevel : defaultGradeLevel(stage);
  const essayType: EssayType = d.essayType === 'continuation' && stage === 'junior' ? 'practical' : d.essayType;
  return { gradeLevel, essayType };
}

function buildRows(stage: Stage): RecentRow[] {
  const rows: RecentRow[] = [];
  for (const m of MODULES) {
    if (stage === 'junior' && m === 'continuation') continue; // 初中无续写 tab，记录不出现
    for (const it of loadHistory<Record<string, unknown>>(m)) {
      if (!it.data || typeof it.data !== 'object') continue;
      rows.push({ module: m, id: it.id, name: it.name, autoTitle: it.autoTitle, savedAt: it.savedAt, data: it.data });
    }
  }
  rows.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
  return rows.slice(0, RECENT_COUNT);
}

function exportButtons(row: RecentRow): ExportBtn[] {
  const d = row.data;
  switch (row.module) {
    case 'vocab':
      return Array.isArray(d.vocabList) && d.vocabList.length > 0
        ? [{ kind: 'csv', text: 'CSV', label: 'vocab', title: '导出词汇 CSV（完整 Word 学案请打开后导出）' }]
        : [];
    case 'practical':
      return d.result ? [{ kind: 'word', text: 'Word', label: 'practical' }] : [];
    case 'continuation':
      return d.result ? [{ kind: 'word', text: 'Word', label: 'continuation' }] : [];
    case 'handwriting': {
      const hasResult = Array.isArray(d.students) && d.students.some((s: StudentSnapshot) => s?.result);
      const btns: ExportBtn[] = [];
      if (hasResult) {
        btns.push({ kind: 'pdf', text: 'PDF 全部', label: 'worksheet', title: '整班学案打印预览（浏览器弹窗，若被拦截请允许弹窗）' });
        btns.push({ kind: 'word', text: 'Word 全部', label: 'worksheet' });
      }
      if (d.classReport) btns.push({ kind: 'ppt', text: '讲评PPT', label: 'class_report' });
      return btns;
    }
    case 'exampaper':
      return d.paper ? [{ kind: 'word', text: 'Word', label: 'exampaper' }] : [];
    case 'copybook':
      return [];
  }
}

/** 按模块分派纯函数导出（参数拼装与各 tab 内 handler 逐字段一致）。 */
async function runExport(module: ModuleKey, kind: ExportBtn['kind'], d: Record<string, unknown>, stage: Stage): Promise<void> {
  switch (module) {
    case 'vocab':
      exportCSV(groupBySection(d.vocabList as VocabItem[], stage).flatMap((g) => g.items), d.fieldSelection as FieldSelection, stage);
      break;
    case 'practical':
      await exportPracticalWritingDocx(d.prompt as string, d.result as PracticalWritingResult, stage);
      break;
    case 'continuation':
      await exportContinuationWritingDocx(d.text as string, d.result as ContinuationWritingResult);
      break;
    case 'handwriting': {
      const data = d as unknown as HandwritingState;
      const { gradeLevel, essayType } = hwValidated(data, stage);
      const ready = data.students.filter((s) => s.result);
      if (kind === 'pdf') {
        // 与 tab 内 handlePrintAll 一致：PDF 传原始 essayPrompt，promptSummary 单独作第 5 参
        printAllWorksheetsPdf(data.essayPrompt, ready.map((s) => ({
          studentName: s.studentName, gradeLevel, originalEssay: s.ocrText, result: s.result!,
        })), data.printSettings, data.promptSummary?.summary);
      } else if (kind === 'word') {
        // 与 tab 内 docxParams 一致：Word 的 essayPrompt 用概括回退
        await exportAllHandwritingWorksheetsDocx(ready.map((s) => ({
          studentName: s.studentName, gradeLevel, essayType,
          essayPrompt: data.promptSummary?.summary || data.essayPrompt, originalEssay: s.ocrText,
          r: s.result!, printSettings: data.printSettings,
        })));
      } else if (kind === 'ppt' && data.classReport) {
        // 与 tab 内 exportMeta 一致：dateLabel = 报告生成时间（非保存时间/今天）
        await exportClassReportPptx({
          stats: computeClassStats(data.students),
          report: data.classReport,
          essayType,
          essayTypeLabel: getEssayTypeLabel(stage, essayType),
          gradeLevel,
          dateLabel: new Date(data.classReport.generatedAt).toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
        });
      }
      break;
    }
    case 'exampaper': {
      const data = d as unknown as ExamPaperState;
      await exportExamPaperDocx(data.paper!, { ...DEFAULT_EXAM_LAYOUT, ...data.layout });
      break;
    }
    case 'copybook':
      break; // 无直接导出（打印依赖组件内 canvas 渲染）
  }
}

interface Props {
  stage: Stage;
  onOpenItem: (module: ModuleKey, id: string) => void;
}

export default function RecentPanel({ stage, onOpenItem }: Props) {
  const [rows, setRows] = useState<RecentRow[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [err, setErr] = useState('');

  // HomeTab 随 tab 切换卸载，每次回主页重挂载即重读——无需刷新按钮
  useEffect(() => {
    setRows(buildRows(stage));
  }, [stage]);

  const handleExport = async (row: RecentRow, btn: ExportBtn) => {
    if (busyKey) return;
    setBusyKey(`${row.id}:${btn.kind}`);
    setErr('');
    try {
      await runExport(row.module, btn.kind, row.data, stage);
      track('export_success', btn.label);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '导出失败，请稍后重试');
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <section className="us-recent">
      <h4 className="us-h4">最近生成</h4>
      {err && <p className="us-err">{err}</p>}
      {rows.length === 0 ? (
        <div className="us-empty">还没有保存记录。在各工具里点「保存」后，最近 {RECENT_COUNT} 条会出现在这里，可一键打开或导出。</div>
      ) : (
        <div className="us-recent-list">
          {rows.map((row) => {
            const btns = exportButtons(row);
            const displayName = row.autoTitle ? `${row.name} ${row.autoTitle}` : row.name;
            return (
              <div key={`${row.module}:${row.id}`} className="us-recent-row">
                <span className={`us-recent-badge ${row.module}`}>{MODULE_LABELS[row.module]}</span>
                <span className="us-recent-name" title={displayName}>{displayName}</span>
                <span className="us-recent-time">{fmtTime(row.savedAt)}</span>
                <span className="us-recent-actions">
                  {btns.map((b) => (
                    <button
                      key={b.kind}
                      type="button"
                      className="us-mini-btn"
                      disabled={busyKey !== null}
                      title={b.title}
                      onClick={() => handleExport(row, b)}
                    >
                      {busyKey === `${row.id}:${b.kind}` ? '导出中…' : b.text}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="us-mini-btn us-recent-open"
                    title={row.module === 'copybook' ? '打印需在字帖工具内渲染画布后进行，请先打开' : '打开该记录'}
                    onClick={() => onOpenItem(row.module, row.id)}
                  >打开</button>
                </span>
              </div>
            );
          })}
        </div>
      )}
      <p className="us-note">记录仅保存在本机浏览器；删除与备份请用各工具的「历史记录」。</p>
    </section>
  );
}
