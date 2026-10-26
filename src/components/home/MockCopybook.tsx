import { useEffect, useState } from 'react';
import './MockCopybook.css';

type LineType = 'four' | 'double' | 'single';
type Mode = 'trace' | 'interleaved' | 'blank';

const LINE_TYPES: { value: LineType; label: string }[] = [
  { value: 'four', label: '四线三格' },
  { value: 'double', label: '两线' },
  { value: 'single', label: '单线' },
];
const MODES: { value: Mode; label: string }[] = [
  { value: 'trace', label: '描红' },
  { value: 'interleaved', label: '隔行临摹' },
  { value: 'blank', label: '纯空白' },
];

const FS = 22;                            // 字号（viewBox 逻辑 px）
const LETTER_SPACING = 1.5;
const LINE_SPACING = 10;                  // 行距（同产品默认）
const PAD = Math.max(2, Math.round(FS * 0.1));
const W = 360;                            // 预览区逻辑宽度

interface Metrics { xHeight: number; ascender: number; descender: number; }
interface Geometry { rowHeight: number; baseline: number; guides: { y: number; dashed: boolean }[]; }

/** 与 utils/copybookLayout.ts 同款几何：线格位置由字体实测度量反推，保证线与字形精确对应 */
function geometry(type: LineType, m: Metrics): Geometry {
  const baseline = m.ascender + PAD;
  const rowHeight = baseline + m.descender + PAD;
  if (type === 'four') return {
    rowHeight, baseline,
    guides: [
      { y: PAD, dashed: false },                    // 上格顶线（升部/大写顶）
      { y: baseline - m.xHeight, dashed: false },   // 中格顶线（x 高度顶）
      { y: baseline, dashed: false },               // 基线
      { y: baseline + m.descender, dashed: false }, // 下格底线（降部底）
    ],
  };
  if (type === 'double') return {
    rowHeight, baseline,
    guides: [
      { y: baseline - m.xHeight, dashed: true },    // x 高度线（虚线）
      { y: baseline, dashed: false },               // 基线（实线）
    ],
  };
  return { rowHeight, baseline, guides: [{ y: baseline, dashed: false }] };
}

/** 行内容：隔行临摹 = 材料行 + 空白行交替；描红 = 每句一行淡色字；纯空白 = 只给线 */
const LINES = ['Where there is a will,', 'there is a way.'];
type RowDef = null | { text: string; trace?: boolean };

/** Landing-page mock panel: 衡水体字帖 — 线格/模式可切换预览，无 API 调用 */
export default function MockCopybook() {
  const [lineType, setLineType] = useState<LineType>('double');
  const [mode, setMode] = useState<Mode>('interleaved');
  const [metrics, setMetrics] = useState<Metrics | null>(null);

  // 字体就绪后用 canvas 实测度量（同真实模块 createMeasurer 的口径），回退字体也能测
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await document.fonts.load(`${FS}px "Hengshui"`);
        await document.fonts.ready;
      } catch { /* ignore */ }
      if (cancelled) return;
      const ctx = document.createElement('canvas').getContext('2d');
      if (!ctx) return;
      ctx.font = `${FS}px "Hengshui"`;
      const asc = (s: string) => {
        const v = ctx.measureText(s).actualBoundingBoxAscent;
        return typeof v === 'number' && v > 0 ? v : 0;
      };
      const desc = (s: string) => {
        const v = ctx.measureText(s).actualBoundingBoxDescent;
        return typeof v === 'number' && v > 0 ? v : 0;
      };
      setMetrics({
        xHeight: asc('acemnorsuvwxz') || FS * 0.5,
        ascender: Math.max(asc('bdfhklt'), asc('ABCDEFGHIJKLMNOPQRSTUVWXYZ')) || FS * 0.72,
        descender: desc('gjpqy') || FS * 0.22,
      });
    })();
    return () => { cancelled = true; };
  }, []);

  const rowDefs: RowDef[] =
    mode === 'blank' ? [null, null, null, null]
    : mode === 'trace' ? [{ text: LINES[0], trace: true }, { text: LINES[1], trace: true }]
    : [{ text: LINES[0] }, null, { text: LINES[1] }, null];

  const geo = metrics ? geometry(lineType, metrics) : null;
  const H = geo ? rowDefs.length * (geo.rowHeight + LINE_SPACING) : 0;

  return (
    <div className="mock-copybook">
      <div className="mc-controls">
        <div className="mc-ctrl-group">
          <span className="mc-ctrl-title">线格类型</span>
          <div className="mock-pills">
            {LINE_TYPES.map((t) => (
              <button key={t.value} className={`mock-pill ${lineType === t.value ? 'active' : ''}`}
                onClick={() => setLineType(t.value)}>{t.label}</button>
            ))}
          </div>
        </div>
        <div className="mc-ctrl-group">
          <span className="mc-ctrl-title">生成模式</span>
          <div className="mock-pills">
            {MODES.map((m) => (
              <button key={m.value} className={`mock-pill ${mode === m.value ? 'active' : ''}`}
                onClick={() => setMode(m.value)}>{m.label}</button>
            ))}
          </div>
        </div>
        <label className="mc-checkbox">
          <input type="checkbox" defaultChecked readOnly />
          学生姓名：________
        </label>
        <button className="mock-fake-btn mc-ai-btn">AI 生成主题句</button>
        <p className="mc-hint">浏览器直接打印 / 另存 PDF</p>
      </div>

      <div className="mc-paper">
        <div className="mc-paper-head">
          <span className="mc-paper-title">衡水体字帖</span>
          <span className="mc-paper-name">学生姓名：______</span>
        </div>
        {geo ? (
          <svg className="mc-svg" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
            {rowDefs.map((r, i) => {
              const top = i * (geo.rowHeight + LINE_SPACING);
              return (
                <g key={i}>
                  {geo.guides.map((g, gi) => (
                    <line key={gi} x1={0} x2={W} y1={top + g.y} y2={top + g.y}
                      stroke="rgba(0,0,0,0.45)" strokeWidth={1}
                      strokeDasharray={g.dashed ? '5 4' : undefined} />
                  ))}
                  {r && (
                    /* SVG text 的 y 即文字基线（alphabetic），与参考线零误差对齐 */
                    <text x={8} y={top + geo.baseline}
                      fontFamily="'Hengshui', Georgia, serif" fontSize={FS}
                      letterSpacing={LETTER_SPACING}
                      fill={r.trace ? 'rgba(0,0,0,0.28)' : 'rgba(0,0,0,0.65)'}>
                      {r.text}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        ) : (
          <p className="mc-loading">正在加载衡水体字体…</p>
        )}
      </div>
    </div>
  );
}
