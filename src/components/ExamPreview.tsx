import { useEffect, useMemo, useState } from 'react';
import type { ExamPaper, ExamLayoutOptions } from '../types';
import { buildPreviewModel, type PreviewBlock, type PreviewModel, type PreviewRun } from '../services/examDocxExport';
import { Icon } from './icons';
import './ExamPreview.css';

interface Props {
  paper: ExamPaper;
  layout: ExamLayoutOptions;
  onClose: () => void;
}

/** twips → px（96dpi：1px = 15 twips） */
const px = (tw: number) => tw / 15;
/** 半点字号 → px（pt×96/72 = 半点×2/3） */
const fsPx = (fs: number) => (fs * 2) / 3;

function RunSpan({ r, fs }: { r: PreviewRun; fs: number }) {
  return (
    <span
      className={`ep-run ${r.b ? 'ep-bold' : ''} ${r.hei ? 'ep-hei' : ''}`}
      style={{ fontSize: fsPx(fs), textDecoration: r.u ? 'underline' : undefined, textDecorationSkipInk: 'none' }}
    >
      {r.t === '\t' ? '  ' : r.t}
    </span>
  );
}

function Block({ b, line, gap }: { b: PreviewBlock; line: number; gap: number }) {
  if (b.kind === 'rule') {
    return (
      <div className="ep-rules">
        {Array.from({ length: b.ruleCount ?? 0 }, (_, i) => (
          <div key={i} className="ep-rule" style={{ height: px(b.fs * 24) }} />
        ))}
      </div>
    );
  }
  if (b.kind === 'hr') {
    return <div className="ep-hr" style={{ marginTop: px(b.before) }} />;
  }
  const baseLine = (b.fs * 13 * line) / 240;
  return (
    <div
      className={`ep-block ${b.center ? 'ep-center' : ''}`}
      style={{
        marginTop: px(b.before),
        marginBottom: b.gapAfter ? px(gap) : 0,
        lineHeight: `${px(baseLine)}px`,
        textIndent: b.firstLine ? px(b.fs * 20) : undefined,
        paddingLeft: b.indentLeft ? px(b.fs * 20) : undefined,
      }}
    >
      {b.runs.map((r, i) => <RunSpan key={i} r={r} fs={b.fs} />)}
    </div>
  );
}

function Page({ pg, model, zoom }: { pg: PreviewPageView; model: PreviewModel; zoom: number }) {
  const examTotal = model.pages.filter((x) => x.kind === 'exam').length;
  const ansTotal = model.pages.filter((x) => x.kind === 'answer').length;
  const footer = pg.kind === 'answer'
    ? `答案第${pg.pageNo}页，共${ansTotal}页`
    : `试卷第${pg.pageNo}页，共${examTotal}页`;
  const line = pg.line ?? model.line; // 答案页固定行距（276/30），正文页用求解值
  const gap = pg.gap ?? model.gap;
  return (
    <div className={`ep-page ${pg.columns === 2 ? 'ep-page-2col' : ''}`}
      style={{ width: px(pg.w) * zoom, height: px(pg.h) * zoom }}>
      <div className="ep-body" style={{ transform: `scale(${zoom})`, transformOrigin: 'top left',
        width: px(pg.w), minHeight: px(pg.h), padding: `${px(720)}px ${px(720)}px` }}>
        {pg.headerBlocks && (
          <div className="ep-header-band">
            {pg.headerBlocks.map((b, i) => <Block key={i} b={b} line={line} gap={gap} />)}
          </div>
        )}
        <div className={`ep-cols ep-cols-${pg.columns}`}>
          {pg.colBlocks.map((col, i) => (
            <div key={i} className="ep-col">
              {col.map((b, j) => <Block key={j} b={b} line={line} gap={gap} />)}
            </div>
          ))}
        </div>
        <div className="ep-footer">{footer}</div>
      </div>
    </div>
  );
}

type PreviewPageView = PreviewModel['pages'][number];

/** 打印作用域样式（同 Copybook 方案）：挂载期间注入，只让预览页进打印机输出。 */
const PRINT_CSS = `@media print {
  body.exam-preview-active * { visibility: hidden !important; }
  body.exam-preview-active .ep-overlay, body.exam-preview-active .ep-overlay * { visibility: visible !important; }
  body.exam-preview-active .ep-overlay { position: static; background: none; }
  body.exam-preview-active .ep-modal { width: auto; height: auto; max-height: none; overflow: visible; }
  body.exam-preview-active .ep-toolbar { display: none !important; }
  body.exam-preview-active .ep-scroll { overflow: visible; max-height: none; padding: 0; }
  body.exam-preview-active .ep-page { box-shadow: none; margin: 0 auto; page-break-after: always; width: auto !important; height: auto !important; }
  body.exam-preview-active .ep-body { transform: none !important; width: auto !important; height: auto !important; min-height: 0; }
}`;

export default function ExamPreview({ paper, layout, onClose }: Props) {
  const model = useMemo(() => buildPreviewModel(paper, layout), [paper, layout]);
  const [zoom, setZoom] = useState(0.8);

  // 打印作用域：挂载期间给 body 打标记 + 注入 print CSS（@page 无法选择器限定，同 Copybook 方案）
  useEffect(() => {
    document.body.classList.add('exam-preview-active');
    const style = document.createElement('style');
    style.id = 'exam-preview-print-css';
    style.textContent = PRINT_CSS;
    document.head.appendChild(style);
    return () => {
      document.body.classList.remove('exam-preview-active');
      document.getElementById('exam-preview-print-css')?.remove();
    };
  }, []);

  return (
    <div className="ep-overlay" onClick={onClose}>
      <div className="ep-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ep-toolbar">
          <span className="ep-title">排版预览 · {model.pages.length} 页（试卷 {model.pages.filter((p) => p.kind === 'exam').length} / 答案 {model.pages.filter((p) => p.kind === 'answer').length || 0}）</span>
          <div className="ep-zoom">
            <button className="btn-mini" onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.1).toFixed(2)))}>−</button>
            <span className="ep-zoom-label">{Math.round(zoom * 100)}%</span>
            <button className="btn-mini" onClick={() => setZoom((z) => Math.min(1.6, +(z + 0.1).toFixed(2)))}>＋</button>
          </div>
          <button className="btn-mini" onClick={() => window.print()} title="在打印对话框中选择「另存为 PDF」可得到保排版的 PDF 文件"><Icon name="print" size={16} /> 打印 / 导出 PDF</button>
          <button className="btn-mini" onClick={onClose}>✕ 关闭</button>
        </div>
        <div className="ep-scroll">
          {model.pages.map((pg, i) => <Page key={i} pg={pg} model={model} zoom={zoom} />)}
        </div>
      </div>
    </div>
  );
}
