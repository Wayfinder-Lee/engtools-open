import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ApiConfig, CopybookConfig, CopybookLineType, CopybookMode, CopybookState, SavedItem, Stage } from '../types';
import {
  COPYBOOK_DEFAULT_MODEL,
  COPYBOOK_LINE_TYPES,
  COPYBOOK_MODES,
  DEFAULT_COPYBOOK_CONFIG,
  MODEL_OPTIONS,
  MODULE_LABELS,
} from '../types';
import { generateCopybook } from '../services/llm';
import { buildCopybookPrompt } from '../prompts/copybookPrompt';
import { getEffectiveModel } from '../utils/model';
import {
  layoutCopybook,
  lineGeometry,
  PAGE_W,
  PAGE_H,
  MARGIN_X,
  CONTENT_BOTTOM,
  type CopybookLayout,
  type CopybookPage,
} from '../utils/copybookLayout';
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
import { SAMPLE_COPYBOOK } from '../data/samples';
import { listWords, entryToCopybookLine, takeCopybookHandoff, type WordBankEntry } from '../utils/wordbank';
import WordPickerModal from './WordPickerModal';
import './Copybook.css';

interface Props { apiConfig: ApiConfig; stage: Stage; /** 登录用户当前余额；null = 自带 Key 模式 */ quota?: number | null; }

const FONT_FAMILY = 'Hengshui';
const SCALE = 2; // 打印分辨率倍率（逻辑坐标 ×2 渲染，打印时缩放到 A4 ≈192dpi）

type Settings = Omit<CopybookConfig, 'text'>;

const DEFAULT_SETTINGS: Settings = (() => {
  const { text: _text, ...rest } = DEFAULT_COPYBOOK_CONFIG;
  void _text;
  return rest;
})();

function useDebounced<T>(value: T, delay: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ─── 图标 ───────────────────────────────────────────
const Svg = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
    strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

// 字号：一大一小两个 A
const ICON_FONT_SIZE = (
  <Svg>
    <path d="M2.5 13 L6 4 L9.5 13" />
    <path d="M3.7 9.5 H8.3" />
    <path d="M10 13 L11.8 7.5 L13.6 13" />
    <path d="M10.7 10.6 H12.9" />
  </Svg>
);

// 字距：三个竖条 + 水平伸缩箭头
const ICON_LETTER_SPACING = (
  <Svg>
    <path d="M2.5 4.5 V11.5" />
    <path d="M5 4.5 V11.5" />
    <path d="M7.5 4.5 V11.5" />
    <path d="M10 8 H13.5" />
    <path d="M10 8 L11.4 6.6 M10 8 L11.4 9.4" />
    <path d="M13.5 8 L12.1 6.6 M13.5 8 L12.1 9.4" />
  </Svg>
);

// 词间距：两组词 + 中间伸缩箭头
const ICON_WORD_SPACING = (
  <Svg>
    <path d="M2.5 4.5 V11.5 M4.5 4.5 V11.5" />
    <path d="M11.5 4.5 V11.5 M13.5 4.5 V11.5" />
    <path d="M6.2 8 H9.8" />
    <path d="M6.2 8 L7.6 6.6 M6.2 8 L7.6 9.4" />
    <path d="M9.8 8 L8.4 6.6 M9.8 8 L8.4 9.4" />
  </Svg>
);

// 行距：两条横线 + 竖直伸缩箭头
const ICON_LINE_SPACING = (
  <Svg>
    <path d="M3 4.5 H13" />
    <path d="M3 11.5 H13" />
    <path d="M7 2 V4.5 M7 2 L8.4 3.4 M7 2 L5.6 3.4" />
    <path d="M7 11.5 V14 M7 14 L8.4 12.6 M7 14 L5.6 12.6" />
  </Svg>
);

// 字色：字母 A
const ICON_INK = (
  <Svg>
    <path d="M3 13 L8 3.5 L13 13" />
    <path d="M5 9.5 H11" />
  </Svg>
);

// 线色：一条线段（两端带竖标）
const ICON_LINE = (
  <Svg>
    <path d="M3 8 H13" />
    <path d="M3 5 V11" />
    <path d="M13 5 V11" />
  </Svg>
);

// ─── 绘制 ───────────────────────────────────────────

function drawGuides(ctx: CanvasRenderingContext2D, top: number, geo: ReturnType<typeof lineGeometry>, color: string) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  for (const g of geo.guides) {
    ctx.setLineDash(g.dashed ? [6, 4] : []);
    ctx.beginPath();
    const y = top + g.y;
    ctx.moveTo(MARGIN_X, y);
    ctx.lineTo(PAGE_W - MARGIN_X, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

function drawPage(
  canvas: HTMLCanvasElement,
  page: CopybookPage,
  layout: CopybookLayout,
  config: CopybookConfig,
  pageIndex: number,
  totalPages: number,
) {
  canvas.width = PAGE_W * SCALE;
  canvas.height = PAGE_H * SCALE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(SCALE, SCALE);

  // 背景
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);

  // 标题
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#212529';
  ctx.font = 'bold 22px "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText(config.title, PAGE_W / 2, 36);

  // 学生姓名栏（可选，右上角）
  if (config.showStudentName) {
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#495057';
    ctx.font = '15px "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText('学生姓名：______________', PAGE_W - MARGIN_X, 42);
  }

  // 分隔线
  ctx.strokeStyle = '#dee2e6';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(MARGIN_X, 70);
  ctx.lineTo(PAGE_W - MARGIN_X, 70);
  ctx.stroke();

  // 行
  const guideColor = hexToRgba(config.lineColor, config.lineOpacity);
  const inkColor = hexToRgba(config.inkColor, config.inkOpacity);
  ctx.font = `${config.fontSize}px "${FONT_FAMILY}"`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  for (const row of page.rows) {
    drawGuides(ctx, row.top, layout.geo, guideColor);
    if (row.kind === 'text') {
      ctx.fillStyle = inkColor;
      const baseline = row.top + layout.geo.baseline;
      for (const glyph of row.glyphs) {
        ctx.fillText(glyph.ch, layout.content.left + glyph.x, baseline);
      }
    }
  }

  // 页码
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#adb5bd';
  ctx.font = '12px "Noto Sans SC", "PingFang SC", sans-serif';
  ctx.fillText(`${pageIndex + 1} / ${totalPages}`, PAGE_W / 2, CONTENT_BOTTOM + 36);
}

// ─── 组件 ───────────────────────────────────────────

export default function Copybook({ apiConfig, stage, quota }: Props) {
  const [text, setText] = useState('');
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [model, setModel] = useState(COPYBOOK_DEFAULT_MODEL);
  const [aiTopic, setAiTopic] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [fontReady, setFontReady] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  // R3：词库多选弹窗
  const [showWordPicker, setShowWordPicker] = useState(false);

  const previewRef = useRef<HTMLDivElement>(null);
  // R3：从「词库」tab 交接过来的多选练写内容（取一次即清空）
  useEffect(() => {
    const handoff = takeCopybookHandoff();
    if (handoff) setText(handoff);
  }, []);
  const debouncedText = useDebounced(text, 150);
  const config: CopybookConfig = { ...settings, text: debouncedText };

  // 加载字体（测量/绘制前必须就绪，否则回退字体字宽全错）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await document.fonts.load(`16px "${FONT_FAMILY}"`);
        await document.fonts.ready;
      } catch { /* ignore */ }
      if (!cancelled) setFontReady(true);
    })();
    return () => { cancelled = true; };
  }, []);

  // 打印 CSS 作用域：仅在字帖 tab 挂载期间生效，避免影响其它 tab 的浏览器打印
  useEffect(() => {
    document.body.classList.add('copybook-active');
    const style = document.createElement('style');
    style.id = 'copybook-page-css';
    style.textContent = '@page { size: A4; margin: 0; }';
    document.head.appendChild(style);
    return () => {
      document.body.classList.remove('copybook-active');
      style.remove();
    };
  }, []);

  // 排版 + 绘制预览
  useEffect(() => {
    const container = previewRef.current;
    if (!container || !fontReady) return;
    const layout = layoutCopybook(config, FONT_FAMILY);
    container.innerHTML = '';
    const frag = document.createDocumentFragment();
    layout.pages.forEach((page, i) => {
      const canvas = document.createElement('canvas');
      canvas.className = 'cb-page-canvas';
      drawPage(canvas, page, layout, config, i, layout.pageCount);
      frag.appendChild(canvas);
    });
    container.appendChild(frag);
  }, [config, fontReady]);

  const updateSettings = (patch: Partial<Settings>) => setSettings((prev) => ({ ...prev, ...patch }));

  const getState = (): CopybookState => ({ ...settings, text, model });

  const restoreState = (data: CopybookState) => {
    const { text: t, model: m, ...rest } = data;
    setText(t ?? '');
    setSettings({ ...DEFAULT_SETTINGS, ...rest });
    setModel(m ?? COPYBOOK_DEFAULT_MODEL);
  };

  // 主页「最近生成 → 打开」：挂载取走交给本模块的记录并恢复（无则 no-op）。
  // 独立 effect，不并入 wordbank 的 takeCopybookHandoff（两套交接互不相干）
  useEffect(() => {
    const item = takeHistoryHandoff('copybook');
    if (item) restoreState((item as SavedItem<CopybookState>).data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSave = () => {
    const name = window.prompt('保存名称：', `${MODULE_LABELS.copybook} ${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`);
    if (!name) return;
    if (!manualSave('copybook', name, getState())) {
      setError('保存失败：浏览器本地存储空间已满，请打开「历史记录」删除部分旧条目后重试');
    }
  };

  useEffect(() => {
    setFabCallbacks(handleSave, () => setShowHistory(true));
    return () => setFabCallbacks(null, null);
  });

  const { confirmSpend, costDialog } = useCostGate(quota);
  const serverMode = quota != null;

  const handleAiGenerate = async () => {
    if (!aiTopic.trim()) { setError('请输入 AI 生成的主题或要求'); return; }
    if (!apiConfig.apiKey.trim() && !serverMode) { setError('请先登录或填入 API Key'); return; }
    if (!(await confirmSpend(5, 'AI 生成字帖练习内容'))) return;
    setError(''); setLoading(true);
    try {
      const systemPrompt = buildCopybookPrompt(aiTopic, stage);
      const r = await generateCopybook(apiConfig, model, systemPrompt, aiTopic);
      const trimmed = r.text.trim();
      setText(trimmed);
      autoSave('copybook', { ...settings, text: trimmed, model });
      void refreshAutoTitle('copybook', apiConfig, model, trimmed);
      track('generate_success', 'copybook');
    } catch (e) {
      track('generate_error', 'copybook');
      setError(e instanceof Error ? e.message : '生成失败');
    } finally { setLoading(false); }
  };

  const handlePrint = () => {
    window.print();
    track('export_success', 'copybook');
  };

  const slider = (label: string, value: number, min: number, max: number, step: number, onChange: (n: number) => void, suffix = '', icon?: ReactNode) => (
    <div className="cb-slider">
      {icon && <span className="cb-slider-icon">{icon}</span>}
      <label>{label}</label>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="cb-slider-value">{value}{suffix}</span>
    </div>
  );

  return (
    <div className="copybook-module">
      <div className="intro-card">
        <h2><Icon name="copybook" size={20} /> 衡水体字帖制作</h2>
        <p>粘贴或 AI 生成英文内容，一键生成衡水体四线三格 / 两线 / 单线练习纸，浏览器打印（另存为 PDF）。</p>
      </div>

      <div className="cb-layout">
        {/* 左侧控制区 */}
        <div className="cb-controls">
          <div className="input-section">
            <label className="input-label" htmlFor="cb-text">英文内容</label>
            {!text.trim() && (
              <SampleFill toolName="衡水体字帖制作" onFill={() => setText(SAMPLE_COPYBOOK)} />
            )}
            <textarea id="cb-text" value={text} onChange={(e) => setText(e.target.value)}
              placeholder={'每行一句，回车换行。例如：\nPractice makes perfect.\nA good beginning is half the battle.'}
              rows={8} disabled={loading} />
            <div className="input-actions">
              <input className="cb-topic-input" value={aiTopic} onChange={(e) => setAiTopic(e.target.value)}
                placeholder={stage === 'junior' ? 'AI 生成主题/要求（如：中考书信常用句）' : 'AI 生成主题/要求（如：高考书信常用句）'} disabled={loading} />
              <button className="btn-ai" onClick={handleAiGenerate} disabled={loading || !aiTopic.trim()}>
                {loading ? '生成中...' : (<><Icon name="sparkles" size={16} /> AI 生成{quota != null ? ' · 5 额度' : ''}</>)}
              </button>
              <button
                className="btn-ai btn-bank-gen"
                onClick={() => {
                  if (listWords().length === 0) { setError('词库为空：先在「试卷词汇提取」里把词汇表「存入词库」或到「词汇学案」页手动添加'); return; }
                  setShowWordPicker(true);
                }}
                title="从共享词库多选词汇，用其例句生成练写内容（免费）"
              ><Icon name="wordbank" size={16} /> 词库生成</button>
              {serverMode ? (
                <span className="model-label">模型: {getEffectiveModel('copybook', model)}</span>
              ) : (
                <ModelSelect className="model-select" value={model} onChange={setModel} options={MODEL_OPTIONS} disabled={loading} />
              )}
            </div>
          </div>

          {/* 线格类型 & 生成模式 */}
          <div className="cb-control-block">
            <div className="cb-subgroup">
              <span className="cb-control-title">线格类型</span>
              <div className="level-pills">
                {COPYBOOK_LINE_TYPES.map((t) => (
                  <button key={t.value} className={`level-pill ${settings.lineType === t.value ? 'active' : ''}`}
                    onClick={() => updateSettings({ lineType: t.value as CopybookLineType })} title={t.description}>
                    {t.label}
                  </button>
                ))}
              </div>
              <span className="cb-control-hint">{COPYBOOK_LINE_TYPES.find((t) => t.value === settings.lineType)?.description}</span>
            </div>
            <div className="cb-subgroup">
              <span className="cb-control-title">生成模式</span>
              <div className="level-pills">
                {COPYBOOK_MODES.map((m) => (
                  <button key={m.value} className={`level-pill ${settings.mode === m.value ? 'active' : ''}`}
                    onClick={() => updateSettings({ mode: m.value as CopybookMode })} title={m.description}>
                    {m.label}
                  </button>
                ))}
              </div>
              <span className="cb-control-hint">{COPYBOOK_MODES.find((m) => m.value === settings.mode)?.description}</span>
            </div>
          </div>

          {/* 标题 */}
          <div className="cb-control-block">
            <label className="input-label" htmlFor="cb-title">字帖标题</label>
            <input id="cb-title" className="cb-text-input" value={settings.title}
              onChange={(e) => updateSettings({ title: e.target.value })} />
            <label className="cb-checkbox">
              <input type="checkbox" checked={settings.showStudentName}
                onChange={(e) => updateSettings({ showStudentName: e.target.checked })} />
              学生姓名：________
            </label>
          </div>

          {/* 排版 */}
          <div className="cb-control-block">
            <span className="cb-control-title">排版</span>
            {slider('字号', settings.fontSize, 12, 40, 1, (n) => updateSettings({ fontSize: n }), 'px', ICON_FONT_SIZE)}
            {slider('字距', settings.letterSpacing, -4, 12, 1, (n) => updateSettings({ letterSpacing: n }), 'px', ICON_LETTER_SPACING)}
            {slider('行距', settings.lineSpacing, 0, 40, 2, (n) => updateSettings({ lineSpacing: n }), 'px', ICON_LINE_SPACING)}
            {slider('词间距', settings.wordSpacing, 0, 3, 0.1, (n) => updateSettings({ wordSpacing: n }), '×o', ICON_WORD_SPACING)}
            <span className="cb-control-hint">词间距以字母 o 宽度为 1（1×o ≈ 一个 o 的大小）</span>
          </div>

          {/* 颜色 */}
          <div className="cb-control-block">
            <span className="cb-control-title">颜色与深浅</span>
            <div className="cb-color-row">
              <span className="cb-color-icon">{ICON_INK}</span>
              <label>字色</label>
              <input type="color" value={settings.inkColor} onChange={(e) => updateSettings({ inkColor: e.target.value })} />
              {slider('深浅', settings.inkOpacity, 0.1, 1, 0.05, (n) => updateSettings({ inkOpacity: n }))}
            </div>
            <div className="cb-color-row">
              <span className="cb-color-icon">{ICON_LINE}</span>
              <label>线色</label>
              <input type="color" value={settings.lineColor} onChange={(e) => updateSettings({ lineColor: e.target.value })} />
              {slider('深浅', settings.lineOpacity, 0.05, 0.9, 0.05, (n) => updateSettings({ lineOpacity: n }))}
            </div>
          </div>
        </div>

        {/* 右侧预览区 */}
        <div className="cb-preview-wrap">
          <div className="cb-toolbar">
            <button className="btn-extract" onClick={handlePrint}><Icon name="print" size={16} /> 打印 / 导出 PDF</button>
          </div>
          {error && <ErrorBar error={error} className="cb-error-bar" />}
          {loading && (
            <Spinner
              showProgress
              text="正在生成字帖内容..."
              messages={['正在根据主题挑选合适的句子...', '正在按学段调整句长与词汇...', '正在排成适合摹写的行距...', '即将完成，请耐心等待...']}
            />
          )}
          {!fontReady && <p className="cb-loading">正在加载衡水体字体…</p>}
          {fontReady && !text.trim() && settings.mode !== 'blank' && (
            <p className="cb-empty">粘贴或生成英文内容后，此处实时预览字帖。</p>
          )}
          {/* 预览容器仅由 draw effect 手动填充 canvas，React 不在此渲染子节点，
              否则 innerHTML 清空会与 React 的 DOM 协调冲突导致整页崩溃 */}
          <div className="cb-preview" ref={previewRef} />
        </div>
      </div>

      {showHistory && (
        <HistoryModal
          module="copybook"
          moduleLabel={MODULE_LABELS.copybook}
          onLoad={(item) => { restoreState((item as SavedItem<CopybookState>).data); setShowHistory(false); }}
          onClose={() => setShowHistory(false)}
        />
      )}
      {showWordPicker && (
        <WordPickerModal
          title="选择要练写的词汇"
          hint="默认建议 10-30 个词；练写内容 = 每词一条例句（无例句则用词条本身）"
          entries={listWords()}
          onConfirm={(picked: WordBankEntry[]) => {
            setShowWordPicker(false);
            setText(picked.slice(0, 40).map(entryToCopybookLine).join('\n'));
            setError('');
          }}
          onClose={() => setShowWordPicker(false)}
        />
      )}
      {costDialog}
    </div>
  );
}
