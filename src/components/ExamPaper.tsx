import { useState, useEffect, useMemo, useRef } from 'react';
import type {
  ApiConfig, ExamLayoutOptions, ExamPaper, ExamPaperMeta, ExamPaperState, ExamQuestion,
  ExamQuestionType, ExamSection, ExamSectionParseResult, SavedItem, Stage,
} from '../types';
import {
  DEFAULT_EXAM_LAYOUT, EXAM_DEFAULT_MODEL, EXAM_FONT_SIZES, EXAM_PAPERS, EXAM_TARGET_PAGES,
  MODEL_OPTIONS, MODULE_LABELS,
} from '../types';
import { parseExamSection, outlineExamSections, transcribeExamPage } from '../services/llm';
import { apiReportUsage } from '../services/api';
import { buildExamParsePrompt, buildExamAnswerKeyPrompt } from '../prompts/examPaperPrompt';
import { buildExamOutlinePrompt } from '../prompts/examOutlinePrompt';
import { parseSections } from '../utils/sectionParser';
import { locateOutline, locateAppendices, findAppendix, stripAnswerAppendix } from '../utils/examOutline';
import { isAnswerAppendix, mergeAnswerKey, type AnswerKeyEntry } from '../utils/examAnswers';
import { defaultManifest, diffManifest, hintForChunk, sanitizeManifestForStage } from '../utils/examManifest';
import { runQuestionGuard, type QuestionGuard } from '../utils/examGuard';
import { enrichSections, type SectionStructure } from '../utils/examStructure';
import { getEffectiveModel, CREDIT_COST_LABELS } from '../utils/model';
import { exportExamPaperDocx } from '../services/examDocxExport';
import { mergeReadingSections, sanitizeQuestions, dropInstructionEcho } from '../utils/examSanitize';
import { splitOversizedChunk, extractExamMeta, assemblePaper, type Chunk } from '../utils/examAssemble';
import { extractTextFromFile, renderPdfPageImages } from '../services/fileExtract';
import { isPhotoFile, photoToDataUrl, cleanTranscribedPage, joinTranscribedPages, PHOTO_ACCEPT } from '../services/visionExtract';
import { autoSave, manualSave } from '../utils/history';
import { refreshAutoTitle } from '../utils/autoTitle';
import { takeHistoryHandoff } from '../utils/historyHandoff';
import { setFabCallbacks } from './FloatingActions';
import ModelSelect from './ModelSelect';
import TypeManifestEditor from './TypeManifestEditor';
import HistoryModal from './HistoryModal';
import Spinner from './Spinner';
import ExamPreview from './ExamPreview';
import ErrorBar from './ErrorBar';
import { useCostGate } from './CostGate';
import { track } from '../utils/analytics';
import { Icon } from './icons';
import { StageStepper, StageToc, StageCard, useScrollspy, useStageFlow } from './StageFlow';
import type { FlowStageInfo, TocEntry } from './StageFlow';
import './ExamPaper.css';

interface Props { apiConfig: ApiConfig; stage: Stage; /** 登录用户当前余额；null = 自带 Key 模式 */ quota?: number | null; }

// ─── 阶段流程定义 ───────────────────────────────────

type FlowStageId = 'input' | 'edit' | 'export';
const STAGE_ANCHOR: Record<FlowStageId, string> = { input: 'ep-stage-input', edit: 'ep-stage-edit', export: 'ep-stage-export' };

// ─── EditableField（各模块按惯例各自持有一份）────────

function EditableField({ value, onChange, multiline, className, placeholder }: {
  value: string; onChange: (v: string) => void; multiline?: boolean; className?: string; placeholder?: string;
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
        rows={multiline ? 4 : 1} placeholder={placeholder} />
    );
  }

  return (
    <div className={`editable-display ${className || ''}`} onClick={start} title="点击编辑">
      {value ? (multiline ? <pre className="editable-pre">{value}</pre> : <span>{value}</span>)
        : <span className="cell-empty">{placeholder || '点击编辑...'}</span>}
    </div>
  );
}

// ─── 模块级纯函数 ──────────────────────────────────

const TYPE_LABELS: Record<ExamQuestionType, string> = {
  passage: '文章', choice: '选择', blank: '填空', essay: '写作', other: '其他',
};


/** 待解析的大题块结构见 utils/examAssemble.ts 的 Chunk（组卷纯函数也已抽出） */
interface ChunkState extends Chunk {
  status: 'pending' | 'parsing' | 'done' | 'error';
  message?: string;
  /** 题号守卫结果（null = 无可比性或无异常，UI 不显示） */
  guard?: QuestionGuard | null;
}

/** 视觉转写的单页（照片一图一页 / 扫描件 PDF 渲染一页） */
interface VisionPageItem {
  id: number;
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
  text: string;
  error?: string;
  /** 重试/单页识别用：压缩后的 JPEG dataUrl */
  dataUrl?: string;
}


// ─── 组件 ──────────────────────────────────────────

export default function ExamPaper({ apiConfig, stage, quota }: Props) {
  const [inputText, setInputText] = useState('');
  const [model, setModel] = useState(EXAM_DEFAULT_MODEL);
  const [paper, setPaper] = useState<ExamPaper | null>(null);
  const [layout, setLayout] = useState<ExamLayoutOptions>({ ...DEFAULT_EXAM_LAYOUT });
  const [loading, setLoading] = useState(false);
  const [progressText, setProgressText] = useState('');
  const [error, setError] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [chunks, setChunks] = useState<ChunkState[]>([]);
  const [detected, setDetected] = useState<{ name: string; words: number }[]>([]);
  const [extracting, setExtracting] = useState(false);
  /** 题型清单（软先验）：大纲切块 + 逐块解析 prompt + 题型比对守卫共用 */
  const [manifest, setManifest] = useState<string[]>(() => defaultManifest(stage));
  /** 大纲切块结果说明（一次性提示，不持久化） */
  const [outlineNote, setOutlineNote] = useState('');
  /** 题型清单 vs 实际识别的大题比对（null = 无差异或清单为空） */
  const [manifestReport, setManifestReport] = useState<{ missing: string[]; extra: string[] } | null>(null);
  /** 照片/扫描件逐页视觉转写（M2）：页列表 + 进行中标记 */
  const [visionPages, setVisionPages] = useState<VisionPageItem[]>([]);
  const [transcribing, setTranscribing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** 取消进行中的转写批次（runVisionPages 每页循环头部检查） */
  const visionCancelRef = useRef(false);
  /** 最近一次合并进原文框的文本：识别「原文框在转写后是否被手动改过」，避免重试/移除页时覆盖用户修改 */
  const lastMergedRef = useRef('');
  const visionIdRef = useRef(0);
  /** 历史恢复代数：restoreState 时自增；提取/解析中的异步任务完成后比对，不一致则丢弃结果，避免覆盖刚恢复的状态 */
  const restoreRef = useRef(0);
  /** 重新解析后暂不暂存原文（suppressTextRef 记住触发时的原文）：成卷快照里已含同一份
   *  原文，此时 paper:null 暂存只会把当日成卷快照毁掉；用户真正改动原文后才恢复暂存 */
  const suppressStashRef = useRef(false);
  const suppressTextRef = useRef('');
  /** 最近一次解析提取到的附录答案清单：重试补齐的失败块同样按题号回填（主解析回填只跑一次） */
  const answerKeyRef = useRef<readonly AnswerKeyEntry[] | null>(null);

  // 阶段流程：① 输入与解析 → ② 编辑试卷 → ③ 排版与导出
  const { openStages, setOpenStages, toggleStage, openStage, scrollToId } = useStageFlow<FlowStageId>(['input']);

  // 学段切换：清单重置为该学段默认（默认值本身已剔除 junior 不存在的题型）
  useEffect(() => { setManifest(defaultManifest(stage)); }, [stage]);

  const getState = (): ExamPaperState => ({ inputText, model, paper, layout, manifest });

  const restoreState = (data: ExamPaperState) => {
    restoreRef.current += 1;
    setInputText(data.inputText ?? '');
    setModel(data.model ?? EXAM_DEFAULT_MODEL);
    setPaper(data.paper ?? null);
    setLayout({ ...DEFAULT_EXAM_LAYOUT, ...data.layout });
    // 旧快照无 manifest = 当年未存，补学段默认；有则按学段净化（junior 剔除七选五/读后续写）。
    // 空数组是用户主动清空，尊重保留。
    setManifest(sanitizeManifestForStage(data.manifest ?? defaultManifest(stage), stage));
    setChunks([]);
    setOutlineNote('');
    setManifestReport(null);
    setVisionPages([]);
    setTranscribing(false);
    visionCancelRef.current = true; // 恢复瞬间作废在途转写批次（异步页完成后比对 gen 丢弃）
    lastMergedRef.current = '';
    setError(''); // 恢复的是好快照：清掉上一轮解析失败留下的错误横幅
    // 有成卷 → 直接展开②③编辑/导出；否则停在①
    setOpenStages(data.paper ? new Set<FlowStageId>(['edit', 'export']) : new Set<FlowStageId>(['input']));
    window.scrollTo({ top: 0 });
  };

  // 主页「最近生成 → 打开」：挂载取走交给本模块的记录并恢复（无则 no-op）。
  // 声明在 manifest 重置 effect（学段切换）之后，恢复的 manifest 才不被冲掉；挂载时
  // restoreRef 递增无在途任务可作废，与 HistoryModal 恢复路径语义一致
  useEffect(() => {
    const item = takeHistoryHandoff('exampaper');
    if (item) restoreState((item as SavedItem<ExamPaperState>).data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSave = () => {
    const name = window.prompt('保存名称：', `${MODULE_LABELS.exampaper} ${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`);
    if (!name) return;
    if (!manualSave('exampaper', name, getState())) {
      setError('保存失败：浏览器本地存储空间已满，请打开「历史记录」删除部分旧条目后重试');
    }
  };

  useEffect(() => {
    setFabCallbacks(handleSave, () => setShowHistory(true));
    return () => setFabCallbacks(null, null);
  });

  // Auto-save when paper/layout changes
  useEffect(() => {
    if (paper && paper.sections.length > 0) {
      autoSave('exampaper', { inputText, model, paper, layout, manifest });
      // 成卷后起存档标题（同原文去重，排版调整不会重复请求）
      void refreshAutoTitle('exampaper', apiConfig, model, inputText);
    }
    // 在试卷/排版/题型清单变化时保存；inputText/model 变化无需触发（同 VocabExtractor 模式）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paper, layout, manifest]);

  // 未解析时也暂存原文（切走标签页/刷新不丢粘贴或上传的内容；解析成功后由上面的自动保存接管）。
  // loading/paper 进依赖：解析开始（loading 升起）即清掉已武装的定时器——粘贴时武装的定时器
  // 若穿透解析期、在成卷快照落盘后触发，会把当日自动保存覆盖回 paper:null；解析全败
  // （loading 落回且 paper 仍 null）时重新武装，截断答案附录后提交的原文也能暂存不丢。
  // 重新解析（handleReparse）后抑制暂存直到原文被真正编辑：成卷快照已含同一份原文，
  // 800ms 后的 paper:null 暂存只会覆盖毁掉当日成卷快照（原为回归，S8 系列）
  useEffect(() => {
    if (suppressStashRef.current) {
      if (inputText === suppressTextRef.current) return;
      suppressStashRef.current = false; // 原文被真正改动：恢复暂存
    }
    if (paper || loading || !inputText.trim()) return;
    const timer = setTimeout(() => autoSave('exampaper', { inputText, model, paper: null, layout, manifest }), 800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputText, manifest, loading, paper]);

  // 大题检测预览（debounce 800ms，同 VocabExtractor）；末尾答案附录默认不计入预览
  useEffect(() => {
    if (paper || !inputText.trim()) { setDetected([]); return; }
    const timer = setTimeout(() => {
      const parsed = parseSections(stripAnswerAppendix(inputText), stage);
      setDetected(parsed.map((s) => ({ name: s.name, words: s.content.split(/\s+/).filter(Boolean).length })));
    }, 800);
    return () => clearTimeout(timer);
  }, [inputText, paper, stage]);

  // ─── 额度确认门（W4）+ 解析成本预估 ─────────────
  const { confirmSpend, costDialog } = useCostGate(quota);
  const serverMode = quota != null;
  // 按钮标价：正则切块数 + 大纲识别 1 次（附录答案提取 ±1 由确认卡兜底，此处为预估）
  const estParseCost = useMemo(() => {
    if (!inputText.trim()) return 0;
    const cost = CREDIT_COST_LABELS.exampaper ?? 5;
    const parts = parseSections(inputText, stage).filter((s) => s.content.trim()).length;
    return (parts + 1) * cost;
  }, [inputText, stage]);

  // ─── 文档上传提取（docx / pdf / txt）────────────

  const handleFile = async (f: File | null | undefined) => {
    if (!f || loading || extracting || transcribing) return;
    setError('');
    setExtracting(true);
    const gen = restoreRef.current;
    try {
      const text = await extractTextFromFile(f);
      // 提取期间恢复了历史：丢弃提取结果（不覆盖恢复内容）
      if (gen === restoreRef.current) setInputText(text);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '文件读取失败';
      // 扫描件 PDF：文字层提取走不通，转视觉识别管线（登录或自备 Key 均可）
      if (msg.includes('未检测到文字层') && gen === restoreRef.current) {
        try {
          if (!apiConfig.apiKey.trim() && !serverMode) { setError('请先登录或填入 API Key 后再用视觉识别'); return; }
          const results = await renderPdfPageImages(await f.arrayBuffer());
          if (results.length === 0) { setError('该 PDF 没有可识别的页面（页数为 0）'); return; }
          const cost = CREDIT_COST_LABELS.exampaper_vision ?? 5;
          const failed = results.filter((r) => !r.dataUrl).length;
          if (failed > 0) {
            setError(`其中 ${failed} 页渲染失败，转写时会跳过。`);
          }
          const ok = await confirmSpend(
            (results.length - failed) * cost,
            `视觉转写扫描件 PDF（${results.length - failed} 页 · 每页 ${cost} 额度）`,
            inputText.trim() ? '注意：原文框已有内容，转写结果将替换原文框全部内容（如需保留请先复制）。' : undefined,
          );
          if (ok) {
            // 自带 Key 模式不经过额度门，覆盖警示单独确认
            if (!serverMode && inputText.trim() && !window.confirm('注意：原文框已有内容，转写结果将替换原文框全部内容（如需保留请先复制）。确定开始？')) return;
            const pages: VisionPageItem[] = results.map((r, i) => (r.dataUrl
              ? { id: ++visionIdRef.current, label: `PDF 第 ${i + 1} 页`, status: 'pending', text: '', dataUrl: r.dataUrl }
              : { id: ++visionIdRef.current, label: `PDF 第 ${i + 1} 页`, status: 'error', text: '', error: r.error ?? '页面渲染失败' }));
            setVisionPages(pages);
            await runVisionPages(pages);
          }
        } catch (renderErr) {
          setError(renderErr instanceof Error ? renderErr.message : 'PDF 页面渲染失败');
        }
      } else if (gen === restoreRef.current) {
        setError(msg);
      }
    } finally {
      setExtracting(false); // 任何路径都要复位（提取中恢复历史不会开启新提取，不能把输入区锁死）
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // ─── 照片 / 扫描件视觉转写（M2）────────────────

  /** 已完成页合并进原文框。interactive = 用户点击触发的合并（重试/移除后）：
   *  原文框若已被手动改过，先确认再覆盖；转写批次内的渐进合并静默执行 */
  const mergeVisionPages = (pages: readonly VisionPageItem[], interactive: boolean) => {
    const joined = joinTranscribedPages(pages.filter((p) => p.status === 'done').map((p) => p.text));
    if (interactive && lastMergedRef.current !== '' && inputText !== lastMergedRef.current
      && !window.confirm('原文框在转写后已被手动修改，重新合并会覆盖这些修改。继续？')) return;
    lastMergedRef.current = joined;
    setInputText(joined);
  };

  /** 顺序转写批次：逐页调视觉识别，每页完成即合并进原文框（渐进可见）。
   *  失败即中断批次（避免连续烧 credits），已完成的页保留，失败页可单页重试 */
  const runVisionPages = async (pages: VisionPageItem[]) => {
    setTranscribing(true);
    visionCancelRef.current = false;
    const gen = restoreRef.current;
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      if (p.status === 'done' || !p.dataUrl) continue; // 图片读取失败的页已带 error，不在批次内重试
      if (visionCancelRef.current) break;
      p.status = 'running';
      p.error = undefined;
      setVisionPages([...pages]);
      try {
        const text = await transcribeExamPage(apiConfig, getEffectiveModel('exampaper_vision', model), p.dataUrl!);
        // 恢复历史时 restoreState 已复位 transcribing；共享标志可能已归新批次，这里不再动
        if (gen !== restoreRef.current) return;
        p.text = cleanTranscribedPage(text);
        p.status = 'done';
      } catch (e) {
        if (gen !== restoreRef.current) return;
        p.status = 'error';
        p.error = e instanceof Error ? e.message : '转写失败';
        setVisionPages([...pages]);
        setError(`「${p.label}」转写失败：${p.error}。已完成的页已填入原文框，失败页可点击「重试」`);
        break;
      }
      setVisionPages([...pages]);
      mergeVisionPages(pages, false);
    }
    setTranscribing(false);
  };

  /** 照片文件 → 逐页视觉转写。文件名即页序（拍摄时间戳命名自然有序） */
  const handleVisionPhotos = async (photos: File[]) => {
    if (loading || extracting || transcribing) return;
    setError('');
    if (!apiConfig.apiKey.trim() && !serverMode) { setError('请先登录或填入 API Key'); return; }
    const cost = CREDIT_COST_LABELS.exampaper_vision ?? 5;
    const ok = await confirmSpend(
      photos.length * cost,
      `视觉识别 ${photos.length} 张照片（每页 ${cost} 额度，后续 AI 解析按大题块数另计）`,
      inputText.trim() ? '注意：原文框已有内容，转写结果将替换原文框全部内容（如需保留请先复制）。' : undefined,
    );
    if (!ok) return;
    // 自带 Key 模式不经过额度门，覆盖警示单独确认
    if (!serverMode && inputText.trim() && !window.confirm('注意：原文框已有内容，转写结果将替换原文框全部内容（如需保留请先复制）。确定开始？')) return;
    // 确认后立即占用互斥位：下方压缩循环可持续数秒，窗口内不能让第二批照片/文档并发进入
    // （runVisionPages 里会再置一次，幂等）
    setTranscribing(true);
    const gen = restoreRef.current;
    const pages: VisionPageItem[] = [];
    for (const f of photos) {
      const item: VisionPageItem = { id: ++visionIdRef.current, label: f.name, status: 'pending', text: '' };
      try {
        item.dataUrl = await photoToDataUrl(f);
      } catch {
        item.status = 'error';
        item.error = '图片读取失败';
      }
      pages.push(item);
    }
    // 压缩期间恢复了历史：丢弃本批（restoreState 已清页列表与 transcribing）
    if (gen !== restoreRef.current) { setTranscribing(false); return; }
    setVisionPages(pages);
    await runVisionPages(pages);
  };

  /** 单页（重试/补识别） */
  const runOneVisionPage = async (id: number) => {
    if (loading || extracting || transcribing) return;
    const page = visionPages.find((p) => p.id === id);
    if (!page || !page.dataUrl) return;
    const pages = [...visionPages];
    page.status = 'running';
    page.error = undefined;
    setVisionPages(pages);
    setTranscribing(true);
    const gen = restoreRef.current;
    try {
      const text = await transcribeExamPage(apiConfig, getEffectiveModel('exampaper_vision', model), page.dataUrl);
      if (gen !== restoreRef.current) return; // restoreState 已复位 transcribing，不再动共享标志
      page.text = cleanTranscribedPage(text);
      page.status = 'done';
    } catch (e) {
      if (gen !== restoreRef.current) return;
      page.status = 'error';
      page.error = e instanceof Error ? e.message : '转写失败';
      setError(`「${page.label}」转写失败：${page.error}`);
      setVisionPages([...pages]);
      setTranscribing(false);
      return; // 失败无新内容可合并；也避免误弹「覆盖手动修改」确认
    }
    setVisionPages([...pages]);
    setTranscribing(false);
    mergeVisionPages(pages, true);
  };

  /** 移除一页（连拍重叠页/废片），其余页重新合并 */
  const removeVisionPage = (id: number) => {
    if (transcribing) return;
    const pages = visionPages.filter((p) => p.id !== id);
    setVisionPages(pages);
    mergeVisionPages(pages, true);
  };

  /** 上传入口分流：有照片走视觉转写，其余按单文档提取 */
  const handleIncomingFiles = (list: FileList | File[]) => {
    const files = [...list];
    const photos = files
      .filter(isPhotoFile)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (photos.length > 0) { void handleVisionPhotos(photos); return; }
    const doc = files.find((f) => !isPhotoFile(f));
    if (doc) void handleFile(doc);
  };

  // ─── AI 解析 ────────────────────────────────────

  const handleParse = async () => {
    if (loading || extracting || transcribing) return;
    if (!inputText.trim()) { setError('请先粘贴试卷原文'); return; }
    if (!apiConfig.apiKey.trim() && !serverMode) { setError('请先登录或填入 API Key'); return; }
    const cost = CREDIT_COST_LABELS.exampaper ?? 5;
    // ① 正则附录检测（现状弹窗）：确定 = 截断；取消 = 保留（regexApIdx 记住位置，
    //    答案类附录走切块提取回填，听力类维持粘卷尾）
    let text = inputText;
    const appendix = findAppendix(text);
    let apIdx: number | null = null;
    let apLabel = '';
    if (appendix) {
      const tailWords = text.slice(appendix.index).split(/\s+/).filter(Boolean).length;
      // 承诺按类型给：命中已是答案类 → 必回填并多耗 1 块；听力类 → 仅当其后还藏答案类附录才回填
      const answerHit = isAnswerAppendix(appendix.label);
      const strip = window.confirm(
        `检测到文档末尾有「${appendix.label}」等附加部分（约 ${tailWords} 词）。\n\n` +
        '「确定」= 去除答案/听力原文，只解析试题；\n「取消」= 保留全文解析' +
        (answerHit
          ? `，并自动提取答案回填（约多耗 ${cost} 额度）。`
          : '（若检出其后的答案附录将自动提取回填）。'));
      if (strip) text = stripAnswerAppendix(text);
      else { apIdx = appendix.index; apLabel = appendix.label; }
    }
    // ② 正则切块（回退基座）
    const parsed = parseSections(text, stage).filter((s) => s.content.trim());
    if (parsed.length === 0) { setError('未检测到有效内容'); return; }
    // 结构行（卷/部分/节）挂回各块并从 content 剥离（听力段中节行切块），LLM 只见纯题目内容
    let enriched: SectionStructure[] = enrichSections(text, parsed);
    // ③ credits 预估：保留的答案类附录多一次答案提取调用
    const estParts = enriched.flatMap((s) => splitOversizedChunk(s));
    // 大纲切块算 1 块：按正则切块数预估（大纲定位后实际块数可能略有出入，此处为预估提示）
    const estBlocks = estParts.length + 1 + (apIdx !== null && isAnswerAppendix(apLabel) ? 1 : 0);
    if (!(await confirmSpend(
      estBlocks * cost,
      `AI 解析试卷（约 ${estBlocks} 个块${estBlocks > estParts.length + 1 ? '，含答案提取' : ''}）`,
    ))) return;

    setError('');
    setInputText(text); // 两轮确认都通过后才提交截断（取消任一弹窗时原文保持不变）
    setOutlineNote('');
    setManifestReport(null);
    answerKeyRef.current = null; // 上一次解析的答案清单作废（本轮是否回填由本轮附录决定）
    setLoading(true);
    setProgressText('识别试卷大纲…');
    const gen = restoreRef.current;

    // ④ LLM 大纲切块 + 附录识别：全文喂给大纲（附录在场 LLM 才能识别 appendices），
    //    附加部分内容不列入 sections（prompt 规则 + locateOutline 只跑正文双保险）
    let base: SectionStructure[] = enriched;
    let bodyText = text;
    let appendixText = '';
    try {
      const outline = await outlineExamSections(
        apiConfig, getEffectiveModel('exampaper', model),
        buildExamOutlinePrompt(manifest, [...new Set(parsed.map((s) => s.name))]),
        text,
      );
      if (gen !== restoreRef.current) { setLoading(false); return; }
      // 正则漏检 + LLM 检出 → 补救弹窗（本地免费重跑正则基座）。
      // 答案类条目优先（混合附录「听力材料 → 参考答案」最早的条目是听力类，答案类在其后）
      if (apIdx === null) {
        const locatedAp = locateAppendices(text, outline?.appendices ?? []);
        if (locatedAp.length > 0) {
          const target = locatedAp.find((x) => isAnswerAppendix(x.label)) ?? locatedAp[0];
          const tailWords = text.slice(target.index).split(/\s+/).filter(Boolean).length;
          const answerType = isAnswerAppendix(target.label);
          const strip = window.confirm(
            `文档末尾检测到「${target.label}」附加部分（约 ${tailWords} 词，本地规则未识别到）。\n\n` +
            `「确定」= 去除后只解析试题${answerType ? `，并自动提取答案回填（约多耗 ${cost} 额度）` : ''}；\n「取消」= 保留全文解析。`);
          if (strip) {
            apIdx = target.index;
            apLabel = target.label;
            if (answerType) {
              appendixText = text.slice(apIdx);
              // 混合附录：答案条目前还有听力附录段——正文从最早的附录条目起全部去除
              //（兑现「去除后只解析试题」），答案提取只喂答案段（听力原文对题号提取无用）
              bodyText = text.slice(0, Math.min(locatedAp[0].index, apIdx)).trimEnd();
            } else {
              bodyText = text.slice(0, apIdx).trimEnd();
            }
            setInputText(bodyText);
          }
        }
      } else {
        // confirm-A 保留：答案类附录正文/附录分家（answer key 单独提取回填）；听力类不切（粘卷尾维持现状）。
        // 混合附录（听力材料在前、参考答案在后）正则最靠前命中的是听力标题——再从 LLM 附录里
        // 找答案类条目定位切点；听力材料仍留在正文。顺序护栏：答案附录物理上必在听力附录之后
        // （更早的话正则首中就是它了），LLM 锚点落在 apIdx 之前 = 正文中部提及行/幻觉，拒绝重定位
        let keptIdx = apIdx as number;
        if (!isAnswerAppendix(apLabel)) {
          const ansAp = locateAppendices(text, outline?.appendices ?? []).find((x) => isAnswerAppendix(x.label) && x.index >= (apIdx as number));
          if (ansAp) { keptIdx = ansAp.index; apLabel = ansAp.label; }
        }
        if (isAnswerAppendix(apLabel)) {
          appendixText = text.slice(keptIdx);
          bodyText = text.slice(0, keptIdx).trimEnd();
        }
      }
      // 附录被切开时正则回退基座按正文重算（enriched 还是全文本），避免附录粘进回退块
      if (bodyText !== text) {
        const parsedB = parseSections(bodyText, stage).filter((s) => s.content.trim());
        if (parsedB.length > 0) enriched = enrichSections(bodyText, parsedB);
        base = enriched;
        text = bodyText; // 下游统一按正文
      }
      // ⑤ 大纲定位跑正文（覆盖率按正文算，答案占比大的卷不再废大纲）
      const located = locateOutline(bodyText, outline?.sections ?? [], stage);
      if (located) {
        base = enrichSections(bodyText, located);
        setOutlineNote(`已按 LLM 大纲识别出 ${located.length} 个大题`);
      } else {
        setOutlineNote('LLM 大纲定位失败，已改用本地规则切块');
      }
    } catch {
      if (gen !== restoreRef.current) { setLoading(false); return; }
      // 大纲不可用时 LLM 附录识别一并失效：用户若在 ① 选了保留（尤其是听力类命中、
      // 真答案附录藏在其后的混合卷），自动回填不会发生——明确告知而非静默落空
      setOutlineNote(apIdx !== null && !isAnswerAppendix(apLabel)
        ? '大纲识别不可用，已改用本地规则切块；若文末附有答案，未能自动提取，请手动填写'
        : '大纲识别不可用，已改用本地规则切块');
    }

    const parts = base.flatMap((s) => splitOversizedChunk(s));
    // 题型比对守卫：清单 vs 实际切块名（清单空 = 用户主动不给先验，不比对）
    if (manifest.length > 0) {
      try {
        const rep = diffManifest(manifest, parts.map((p) => p.name));
        setManifestReport(rep.missing.length > 0 || rep.extra.length > 0 ? rep : null);
      } catch { setManifestReport(null); } // 比对守卫自身异常只放弃提示，不中断解析主流程（loading 不卡死）
    }
    setChunks(parts.map((p) => ({ ...p, status: 'pending' })));
    const ok: (Chunk & { data: ExamSectionParseResult; ci: number })[] = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      setProgressText(`解析中 (${i + 1}/${parts.length})：${p.name}…`);
      setChunks((prev) => prev.map((c, j) => (j === i ? { ...c, status: 'parsing', message: undefined } : c)));
      try {
        const data = await parseExamSection(apiConfig, getEffectiveModel('exampaper', model), buildExamParsePrompt(p.name, stage, hintForChunk(p.name, manifest)), p.content);
        // 解析期间恢复了历史：立即中止，不再写入任何状态（chunks 已被 restoreState 清空）
        if (gen !== restoreRef.current) { setLoading(false); return; }
        ok.push({ name: p.name, volume: p.volume, partTitle: p.partTitle, subHeaders: p.subHeaders, content: p.content, data, ci: i });
        // 题号守卫：块原文行首题号 vs 解析输出题号，比对用与卷面同口径的 sanitize 后题号
        // （sanitize 能救回 "41." 这类脏题号，直接用原始输出会误报漏题）
        setChunks((prev) => prev.map((c, j) => (j === i ? { ...c, status: 'done', guard: runQuestionGuard(p.content, sanitizeQuestions(data.questions)) } : c)));
      } catch (e) {
        if (gen !== restoreRef.current) { setLoading(false); return; }
        setChunks((prev) => prev.map((c, j) => (j === i ? { ...c, status: 'error', message: e instanceof Error ? e.message : '解析失败' } : c)));
      }
    }
    let paperOut: ExamPaper | null = ok.length > 0 ? assemblePaper(ok, bodyText, stage) : null;
    // ⑦ 附录答案提取：无论正文块是否全部失败都提取（answerKeyRef 供失败块逐个重试后整卷回填）；
    //    附录块不进 chunks/assemblePaper，单独解析成 {number, answer} 清单按题号回填
    //    （绝不覆盖正文已有答案）；失败非致命，提示手填。LLM 偶发裸数字 JSON，String 防抛
    if (appendixText) {
      setProgressText('提取附录答案…');
      try {
        const data = await parseExamSection(apiConfig, getEffectiveModel('exampaper', model), buildExamAnswerKeyPrompt(), appendixText);
        if (gen !== restoreRef.current) { setLoading(false); return; }
        const key = (data.questions ?? []).filter((q) =>
          String(q.answer ?? '').trim() && String(q.number ?? '').replace(/\D/g, '') && !/[-‐‑–—~～]/.test(String(q.number ?? '')));
        answerKeyRef.current = key;
        if (paperOut) {
          // 有失败块时同号题跳过自动回填（防缺位串块），重试补齐后整卷重放补上
          const res = mergeAnswerKey(paperOut.sections, key, { complete: ok.length === parts.length });
          if (res.filled > 0) {
            paperOut = { ...paperOut, sections: res.merged };
            setOutlineNote((n) => `${n}；已从附录合并 ${res.filled} 个答案${res.unmatched > 0 ? `（${res.unmatched} 个未匹配）` : ''}`);
          } else {
            setOutlineNote((n) => `${n}；附录答案未能匹配回填，请在答案栏手动填写`);
          }
        }
      } catch {
        if (gen !== restoreRef.current) { setLoading(false); return; }
        setOutlineNote((n) => `${n}；附录答案提取失败，请在答案栏手动填写`);
      }
    }
    if (paperOut) {
      setPaper(paperOut);
      track('generate_success', 'exampaper');
      apiReportUsage('exampaper_done', 1); // 看板「试卷排版」：计费按解析块，整卷份数在此上报（静默）
      // 全部成功 → 进入②编辑并展开③导出；有失败块 → ①②同开（① 的失败块重试按钮需可见）
      setOpenStages(ok.length === parts.length ? new Set<FlowStageId>(['edit', 'export']) : new Set<FlowStageId>(['input', 'edit']));
      scrollToId(STAGE_ANCHOR.edit);
    } else {
      track('generate_error', 'exampaper');
      setError('所有部分解析失败，请检查网络 / API Key 后重试');
    }
    setLoading(false);
  };

  /** 重试单个失败块：解析后追加进试卷 */
  const retryChunk = async (index: number) => {
    const c = chunks[index];
    if (!c || c.status !== 'error' || loading || extracting) return;
    if (!apiConfig.apiKey.trim() && !serverMode) { setError('请先登录或填入 API Key'); return; }
    setError('');
    setChunks((prev) => prev.map((x, j) => (j === index ? { ...x, status: 'parsing', message: undefined } : x)));
    setLoading(true);
    setProgressText(`重试：${c.name}…`);
    const gen = restoreRef.current;
    try {
      const data = await parseExamSection(apiConfig, getEffectiveModel('exampaper', model), buildExamParsePrompt(c.name, stage, hintForChunk(c.name, manifest)), c.content);
      if (gen !== restoreRef.current) { setLoading(false); return; } // 重试期间恢复了历史：丢弃结果
      // 题号守卫与卷面同口径：比对 sanitize 后的题号（下方 section 复用同一份）
      const sanitized = sanitizeQuestions(data.questions);
      setChunks((prev) => prev.map((x, j) => (j === index ? { ...x, status: 'done', guard: runQuestionGuard(c.content, sanitized) } : x)));
      const section: ExamSection = {
        id: crypto.randomUUID(),
        title: c.name,
        chunkIndex: index,
        ...(c.volume ? { volumeDivider: c.volume } : {}),
        ...(c.partTitle ? { partTitle: c.partTitle } : {}),
        ...(c.subHeaders.length > 0 ? { subHeaders: c.subHeaders } : {}),
        instruction: (data.instruction || '').trim() || undefined,
        questions: dropInstructionEcho(sanitized, (data.instruction || '').trim()),
      };
      // 附录答案回填：主解析时提取的 key 存在 ref——插入后**整卷重放**（而非单块重放），
      // 同号消耗按完整卷面对齐；主解析因失败块跳过的同号题也在此补上。已有答案冲突保正文
      const key = answerKeyRef.current;
      const baseSections = paper ? paper.sections : [];
      // 按原切块序插回原位（无序号/手动添加的大题排最后），不再追加到卷尾
      const at = baseSections.findIndex((s) => (s.chunkIndex ?? Infinity) > index);
      const inserted = at < 0 ? [...baseSections, section] : [...baseSections.slice(0, at), section, ...baseSections.slice(at)];
      let finalSections = mergeReadingSections(inserted);
      if (key && key.length > 0) {
        const allDone = chunks.map((x, j) => (j === index ? { ...x, status: 'done' as const } : x)).every((x) => x.status === 'done');
        const r = mergeAnswerKey(finalSections, key, { complete: allDone });
        if (r.filled > 0) {
          finalSections = r.merged;
          setOutlineNote((n) => `${n}；重试块已回填 ${r.filled} 个答案`);
        }
      }
      setPaper(paper ? { ...paper, sections: finalSections } : { meta: extractExamMeta(inputText, stage), sections: finalSections });
    } catch (e) {
      if (gen !== restoreRef.current) { setLoading(false); return; }
      setChunks((prev) => prev.map((x, j) => (j === index ? { ...x, status: 'error', message: e instanceof Error ? e.message : '解析失败' } : x)));
    }
    setLoading(false);
  };

  const handleReparse = () => {
    if (paper && !window.confirm('重新解析将丢弃当前试卷内容（原文保留）。确定继续？')) return;
    // 递增恢复代数：在途的解析/重试回调据此丢弃结果，不再把旧块写回刚清空的试卷
    restoreRef.current += 1;
    // 抑制原文暂存（见上方 effect 注释）：当日成卷快照已含这份原文，paper:null 的
    // 暂存会把它毁掉；原文再次被编辑后自动恢复暂存
    suppressStashRef.current = true;
    suppressTextRef.current = inputText;
    setPaper(null);
    setChunks([]);
    setOutlineNote('');
    setManifestReport(null);
    setError('');
    // 回到第 ① 步修改原文
    setOpenStages(new Set<FlowStageId>(['input']));
    scrollToId(STAGE_ANCHOR.input);
  };

  // ─── 编辑 handlers（全部不可变更新）────────────

  const updateMeta = (patch: Partial<ExamPaperMeta>) => {
    setPaper((prev) => (prev ? { ...prev, meta: { ...prev.meta, ...patch } } : prev));
  };

  const updateNotice = (i: number, v: string) => {
    setPaper((prev) => (prev ? { ...prev, meta: { ...prev.meta, notices: prev.meta.notices.map((n, j) => (j === i ? v : n)) } } : prev));
  };
  const addNotice = () => {
    setPaper((prev) => (prev ? { ...prev, meta: { ...prev.meta, notices: [...prev.meta.notices, ''] } } : prev));
  };
  const deleteNotice = (i: number) => {
    setPaper((prev) => (prev ? { ...prev, meta: { ...prev.meta, notices: prev.meta.notices.filter((_, j) => j !== i) } } : prev));
  };

  const updateSection = (si: number, patch: Partial<ExamSection>) => {
    setPaper((prev) => (prev ? { ...prev, sections: prev.sections.map((s, i) => (i === si ? { ...s, ...patch } : s)) } : prev));
  };
  const updateSubHeader = (si: number, hi: number, v: string) => {
    setPaper((prev) => (prev ? {
      ...prev,
      sections: prev.sections.map((s, i) => (i === si
        ? { ...s, subHeaders: (s.subHeaders ?? []).map((h, j) => (j === hi ? v : h)) }
        : s)),
    } : prev));
  };
  const addSubHeader = (si: number) => {
    setPaper((prev) => (prev ? {
      ...prev,
      sections: prev.sections.map((s, i) => (i === si ? { ...s, subHeaders: [...(s.subHeaders ?? []), ''] } : s)),
    } : prev));
  };
  const deleteSubHeader = (si: number, hi: number) => {
    setPaper((prev) => (prev ? {
      ...prev,
      sections: prev.sections.map((s, i) => (i === si ? { ...s, subHeaders: (s.subHeaders ?? []).filter((_, j) => j !== hi) } : s)),
    } : prev));
  };
  const moveSection = (si: number, dir: -1 | 1) => {
    setPaper((prev) => {
      if (!prev) return prev;
      const next = [...prev.sections];
      const j = si + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[si], next[j]] = [next[j], next[si]];
      return { ...prev, sections: next };
    });
  };
  const deleteSection = (si: number) => {
    if (!window.confirm('确定删除整个大题？')) return;
    setPaper((prev) => (prev ? { ...prev, sections: prev.sections.filter((_, i) => i !== si) } : prev));
  };
  const addSection = () => {
    setPaper((prev) => (prev
      ? { ...prev, sections: [...prev.sections, { id: crypto.randomUUID(), title: '新大题', questions: [] }] }
      : prev));
  };

  const updateQuestion = (si: number, qi: number, patch: Partial<ExamQuestion>) => {
    setPaper((prev) => (prev ? {
      ...prev,
      sections: prev.sections.map((s, i) => (i === si
        ? { ...s, questions: s.questions.map((q, j) => (j === qi ? { ...q, ...patch } : q)) }
        : s)),
    } : prev));
  };
  const moveQuestion = (si: number, qi: number, dir: -1 | 1) => {
    setPaper((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        sections: prev.sections.map((s, i) => {
          if (i !== si) return s;
          const next = [...s.questions];
          const j = qi + dir;
          if (j < 0 || j >= next.length) return s;
          [next[qi], next[j]] = [next[j], next[qi]];
          return { ...s, questions: next };
        }),
      };
    });
  };
  const deleteQuestion = (si: number, qi: number) => {
    setPaper((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        sections: prev.sections.map((s, i) => (i === si ? { ...s, questions: s.questions.filter((_, j) => j !== qi) } : s)),
      };
    });
  };
  const addQuestion = (si: number, type: ExamQuestionType) => {
    setPaper((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        sections: prev.sections.map((s, i) => {
          if (i !== si) return s;
          const lastNum = [...s.questions].reverse().find((q) => /^\d+$/.test(q.number));
          const number = lastNum ? String(Number(lastNum.number) + 1) : '';
          const q: ExamQuestion = {
            id: crypto.randomUUID(),
            number,
            type,
            stem: '',
            options: type === 'choice'
              ? [{ label: 'A', text: '' }, { label: 'B', text: '' }, { label: 'C', text: '' }, { label: 'D', text: '' }]
              : undefined,
            answer: '',
          };
          return { ...s, questions: [...s.questions, q] };
        }),
      };
    });
  };

  const updateOption = (si: number, qi: number, oi: number, label: string, text: string) => {
    updateQuestion(si, qi, {
      options: (paper?.sections[si].questions[qi].options ?? []).map((o, j) => (j === oi ? { label, text } : o)),
    });
  };
  const addOption = (si: number, qi: number) => {
    const opts = paper?.sections[si].questions[qi].options ?? [];
    const label = String.fromCharCode(65 + opts.length);
    updateQuestion(si, qi, { options: [...opts, { label, text: '' }] });
  };
  const deleteOption = (si: number, qi: number, oi: number) => {
    updateQuestion(si, qi, {
      options: (paper?.sections[si].questions[qi].options ?? []).filter((_, j) => j !== oi),
    });
  };

  const handleExport = async () => {
    if (!paper || paper.sections.length === 0) { setError('没有可导出的内容'); return; }
    setError('');
    try {
      await exportExamPaperDocx(paper, layout);
      track('export_success', 'exampaper');
    } catch (e) {
      setError(e instanceof Error ? e.message : '导出失败');
    }
  };

  const failedCount = chunks.filter((c) => c.status === 'error').length;

  // ─── 阶段流程派生状态 + 锚点导航 ──────────────────

  const busyInput = loading || extracting || transcribing;

  const flowStages: FlowStageInfo[] = [
    { id: 'input', label: '输入试卷', done: !!paper, busy: busyInput, sub: busyInput ? '处理中…' : undefined },
    { id: 'edit', label: '编辑试卷', busy: loading, done: !!paper, sub: paper ? `${paper.sections.length} 个大题` : undefined },
    { id: 'export', label: '排版导出', ready: !!paper },
  ];

  const tocItems: TocEntry[] = [
    {
      id: STAGE_ANCHOR.input, label: '① 输入与解析',
      ...(paper ? { status: 'done' as const, statusText: '✓' } : busyInput ? { status: 'busy' as const, statusText: '⏳' } : {}),
    },
    {
      id: STAGE_ANCHOR.edit, label: '② 编辑试卷',
      ...(busyInput && paper ? { status: 'busy' as const, statusText: '⏳' } : paper ? { status: 'done' as const, statusText: '✓' } : {}),
    },
    ...(paper ? paper.sections.map((sec, si): TocEntry => ({
      id: `ep-sec-${si}`, label: sec.title, depth: 1, parentId: STAGE_ANCHOR.edit,
    })) : []),
    { id: STAGE_ANCHOR.export, label: '③ 排版与导出', ...(paper ? { statusText: 'Word' } : {}) },
  ];

  // 滚动联动：阶段 + 大题锚点（按文档顺序；阶段收起时其子锚点不存在，自动跳过）
  const spyIds = [
    STAGE_ANCHOR.input, STAGE_ANCHOR.edit,
    ...(openStages.has('edit') && paper ? paper.sections.map((_, si) => `ep-sec-${si}`) : []),
    STAGE_ANCHOR.export,
  ];
  const activeAnchorId = useScrollspy(spyIds);
  const activeStageId = activeAnchorId == null ? null
    : activeAnchorId.startsWith('ep-sec-') ? 'edit'
    : activeAnchorId.replace('ep-stage-', '');

  /** 跳到任意锚点（阶段卡片 / 大题卡片）：先展开所属阶段，再滚动 */
  const jumpToAnchor = (anchorId: string) => {
    const stageId: FlowStageId = anchorId.startsWith('ep-sec-') ? 'edit'
      : (Object.values(STAGE_ANCHOR) as string[]).includes(anchorId) ? anchorId.replace('ep-stage-', '') as FlowStageId
      : 'input';
    openStage(stageId);
    scrollToId(anchorId);
  };

  // ─── 渲染 ──────────────────────────────────────

  return (
    <div className="exam-module">
      {/* 页头：标题 + 醒目的保存/历史入口 */}
      <div className="sf-header">
        <div>
          <h2><Icon name="exampaper" size={20} /> 试卷排版助手</h2>
          <p>粘贴或上传试卷 → AI 按大题解析 → 逐项调整 → 排版导出 Word 试卷（A4 / 8K / A3，附答案页）</p>
        </div>
        <div className="sf-header-actions">
          <button className="sf-btn-sm" onClick={handleSave} title="保存当前试卷与排版，稍后可从历史记录载入"><Icon name="save" size={16} /> 保存进度</button>
          <button className="sf-btn-sm" onClick={() => setShowHistory(true)} title="载入之前保存的试卷"><Icon name="history" size={16} /> 历史记录 / 载入</button>
        </div>
      </div>

      {/* 阶段流程条：吸顶展示 ①→②→③，点击跳转；错误提示常驻可见 */}
      <div className="sf-stepper-wrap">
        <StageStepper stages={flowStages} activeId={activeStageId} onJump={(id) => jumpToAnchor(`ep-stage-${id}`)} />
        {error && <ErrorBar error={error} onRetry={handleParse} />}
      </div>

      <div className="sf-layout">
        {/* 左侧跟随目录（窄屏隐藏，靠吸顶流程条导航） */}
        <aside className="sf-rail">
          <StageToc items={tocItems} activeId={activeAnchorId} onJump={jumpToAnchor} />
        </aside>

        <div className="sf-main">
          {/* ① 输入与解析 */}
          <StageCard anchorId={STAGE_ANCHOR.input} index={1} title="输入与解析"
            busy={busyInput} done={!!paper}
            meta={paper ? '已解析成卷' : inputText.trim() ? `${inputText.length} 字` : ''}
            summary={paper ? '已解析成卷（如需改原文：第 ③ 步「重新解析」）' : inputText.trim() ? '原文已就绪，点击「AI 解析」' : '尚未输入'}
            open={openStages.has('input')} onToggle={() => toggleStage('input')}>
            {!paper && (
              <div className="input-section"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  if (e.dataTransfer?.files?.length) { e.preventDefault(); handleIncomingFiles(e.dataTransfer.files); }
                }}>
                <label className="input-label" htmlFor="exam-text">试卷原文</label>
                <div className="exam-upload-row">
                  <input ref={fileInputRef} type="file" accept={`.docx,.pdf,.txt,${PHOTO_ACCEPT}`} multiple hidden
                    onChange={(e) => { handleIncomingFiles(e.target.files ?? []); }} />
                  <button className="btn-mini" onClick={() => fileInputRef.current?.click()}
                    disabled={extracting || loading || transcribing}>
                    {extracting ? '提取文字中...' : transcribing ? '转写中...' : (<><Icon name="attach" size={16} /> 上传 Word / PDF / 照片</>)}
                  </button>
                  <span className="exam-upload-hint">支持 .docx / .pdf / .txt / 照片（jpg/png/webp 可多选，按文件名排序逐页视觉识别）；扫描件 PDF 自动转视觉识别</span>
                </div>
                {visionPages.length > 0 && (
                  <div className="vision-pages">
                    <div className="vision-head">
                      <span><Icon name="camera" size={14} /> 照片转写 {visionPages.filter((p) => p.status === 'done').length}/{visionPages.length} 页完成</span>
                      {transcribing ? (
                        <button className="btn-mini" onClick={() => { visionCancelRef.current = true; }}>取消后续页</button>
                      ) : (
                        <button className="btn-mini" onClick={() => { setVisionPages([]); lastMergedRef.current = ''; }}>清除页列表</button>
                      )}
                    </div>
                    <div className="vision-list">
                      {visionPages.map((p) => (
                        <div key={p.id} className={`vision-item vision-${p.status}`}>
                          <span className="vision-label" title={p.label}>{p.label}</span>
                          <span className="vision-status">
                            {p.status === 'pending' && '待识别'}
                            {p.status === 'running' && '识别中…'}
                            {p.status === 'done' && `${p.text.length} 字`}
                            {p.status === 'error' && `失败：${(p.error ?? '').slice(0, 40)}`}
                          </span>
                          {!transcribing && p.status !== 'done' && p.dataUrl && (
                            <button className="btn-mini" onClick={() => void runOneVisionPage(p.id)}>{p.status === 'error' ? '重试' : '识别'}</button>
                          )}
                          {!transcribing && p.status === 'done' && (
                            <button className="btn-mini" onClick={() => removeVisionPage(p.id)}>移除</button>
                          )}
                          {p.status === 'done' && (
                            <details className="vision-preview">
                              <summary>预览</summary>
                              <pre>{p.text}</pre>
                            </details>
                          )}
                        </div>
                      ))}
                    </div>
                    {!transcribing && visionPages.some((p) => p.status === 'done') && (
                      <p className="vision-hint">转写结果已填入原文框（可编辑）。连拍重叠、废片可在此「移除」，失败页可「重试」，完成后自动重新合并。</p>
                    )}
                  </div>
                )}
                <textarea
                  id="exam-text"
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  placeholder={stage === 'junior'
                    ? '粘贴整份试卷文字，或点击上方按钮 / 拖拽上传 Word、PDF 文档。\n\n示例：\n2026年初三英语模拟试卷\n第一部分 听力（共两节，满分20分）\n…\n第二部分 阅读理解（共两节，满分40分）\n…\n第五部分 书面表达（满分15分）\n…'
                    : '粘贴整份试卷文字，或点击上方按钮 / 拖拽上传 Word、PDF 文档。\n\n示例：\n2026届高三英语模拟试卷\n第一部分 听力（共两节，满分30分）\n…\n第二部分 阅读理解（共两节，满分50分）\n…'}
                  rows={12}
                  disabled={loading || extracting || transcribing}
                />
                {detected.length > 0 && (
                  <div className="exam-detect">
                    <span className="exam-detect-label">检测到 {detected.length} 个大题：</span>
                    {detected.map((d, i) => (
                      <span key={i} className="exam-chip">{d.name} · {d.words}词</span>
                    ))}
                  </div>
                )}
                <TypeManifestEditor stage={stage} value={manifest} onChange={setManifest} disabled={loading || extracting || transcribing} />
                <div className="input-actions">
                  <button className="btn-extract" onClick={handleParse} disabled={loading || extracting || transcribing || !inputText.trim()}>
                    {loading ? '解析中...' : (<><Icon name="sparkles" size={16} /> AI 解析{quota != null && estParseCost > 0 ? ` · 约 ${estParseCost} 额度` : ''}</>)}
                  </button>
                  {serverMode ? (
                    <span className="model-label">模型: {getEffectiveModel('exampaper', model)}</span>
                  ) : (
                    <ModelSelect className="model-select" value={model} onChange={setModel} options={MODEL_OPTIONS} disabled={loading} />
                  )}
                </div>
              </div>
            )}
            {paper && (
              <p className="sf-stage-hint">试卷已解析完成，编辑在第 ② 步；如需修改原文或换一份试卷，请点第 ③ 步的「↺ 重新解析」。</p>
            )}

            {/* 大纲切块说明 + 题型比对提示（软先验，仅提示不阻断） */}
            {outlineNote && <p className="exam-chunk-hint">{outlineNote}</p>}
            {manifestReport && (
              <div className="exam-manifest-report" title="题型清单是辅助识别的软先验；此比对仅供人工核对，不影响解析结果。">
                {manifestReport.missing.length > 0 && (
                  <span>清单中有但未识别到：<b>{manifestReport.missing.join('、')}</b></span>
                )}
                {manifestReport.extra.length > 0 && (
                  <span>识别到但不在清单：<b>{manifestReport.extra.join('、')}</b></span>
                )}
              </div>
            )}

            {/* 解析进度/重试条：独立于输入区渲染——部分成功出卷后失败的块仍可单独重试 */}
            {chunks.length > 0 && (
              <div className="exam-chunk-list">
                {chunks.map((c, i) => (
                  <div key={i} className={`exam-chunk exam-chunk-${c.status}`}>
                    <span className="exam-chunk-title">
                      <span className={`exam-chunk-icon ${c.status}`}>
                        {c.status === 'done' ? '✓' : c.status === 'error' ? '✕' : c.status === 'parsing' ? '⋯' : '○'}
                      </span> {c.name}
                    </span>
                    {c.status === 'done' && c.guard && (
                      <span className="exam-chunk-guard"
                        title="题号守卫：解析输出的题号与该块原文行首题号比对。缺号 = 疑似漏题（LLM 省略或输出截断），多出 = 疑似幻觉编号。仅提示，请人工核对后可编辑修正。">
                        <Icon name="warning" size={14} /> {c.guard.missing.length > 0 && `疑似漏题：${c.guard.missing.join('、')}`}
                        {c.guard.missing.length > 0 && c.guard.extra.length > 0 && '；'}
                        {c.guard.extra.length > 0 && `多出题号：${c.guard.extra.join('、')}`}
                      </span>
                    )}
                    {c.status === 'error' && (
                      <>
                        <span className="exam-chunk-msg">{c.message}</span>
                        <button className="btn-mini" onClick={() => retryChunk(i)} disabled={loading || extracting}>重试</button>
                      </>
                    )}
                  </div>
                ))}
                {failedCount > 0 && <p className="exam-chunk-hint">{failedCount} 个部分解析失败，可点击「重试」单独补齐。</p>}
              </div>
            )}
            {loading && (
              <Spinner
                showProgress
                text={progressText || '正在解析试卷...'}
                messages={['正在识别试卷大纲与题型结构...', '正在逐块解析题目与选项...', '正在整理答案与解析位置...', '即将完成，请耐心等待...']}
              />
            )}
          </StageCard>

          {/* ② 编辑试卷 */}
          <StageCard anchorId={STAGE_ANCHOR.edit} index={2} title="编辑试卷"
            busy={loading} done={!!paper}
            meta={paper ? `${paper.sections.length} 个大题` : ''}
            summary={paper ? `${paper.sections.length} 个大题 · 试卷头 / 题目 / 答案（点击展开编辑）` : '解析后在此编辑'}
            open={openStages.has('edit')} onToggle={() => toggleStage('edit')}>
            {!paper && (
              <p className="sf-stage-hint">完成第 ① 步解析后，试卷头与每道大题会在这里展示，可编辑标题、卷别行、节标题、题干、选项与答案。</p>
            )}
            {paper && (
              <>
                {/* 试卷头 */}
                <div className="result-section">
                  <h3>试卷头</h3>
                  <div className="exam-meta-grid">
                    <div className="exam-field">
                      <label>试卷标题</label>
                      <EditableField value={paper.meta.title} onChange={(v) => updateMeta({ title: v })} />
                    </div>
                    <div className="exam-field">
                      <label>满分 / 考试时间</label>
                      <EditableField value={paper.meta.subTitle} onChange={(v) => updateMeta({ subTitle: v })} />
                    </div>
                  </div>
                  <div className="exam-field">
                    <label>注意事项</label>
                    {paper.meta.notices.map((n, i) => (
                      <div key={i} className="exam-notice-row">
                        <EditableField value={n} onChange={(v) => updateNotice(i, v)} className="exam-notice-field" />
                        <button className="btn-mini" onClick={() => deleteNotice(i)}>✕</button>
                      </div>
                    ))}
                    <button className="btn-mini" onClick={addNotice}>+ 添加注意事项</button>
                  </div>
                </div>

                {/* 大题列表 */}
                {paper.sections.map((sec, si) => (
                  <div key={sec.id} id={`ep-sec-${si}`} className="result-section exam-section-card">
              <div className="exam-section-head">
                <span className="exam-type-badge exam-badge-section">大题</span>
                <EditableField value={sec.title} onChange={(v) => updateSection(si, { title: v })} className="exam-section-title" />
                <div className="exam-controls">
                  <button className="btn-mini" onClick={() => moveSection(si, -1)} disabled={si === 0}>▲</button>
                  <button className="btn-mini" onClick={() => moveSection(si, 1)} disabled={si === paper.sections.length - 1}>▼</button>
                  <button className="btn-mini" onClick={() => deleteSection(si)}><Icon name="trash" size={14} /></button>
                </div>
              </div>
              <div className="exam-structure-grid">
                <div className="exam-field">
                  <label>卷别行（如：第Ⅰ卷）</label>
                  <EditableField value={sec.volumeDivider ?? ''} onChange={(v) => updateSection(si, { volumeDivider: v || undefined })}
                    placeholder="无" />
                </div>
                <div className="exam-field">
                  <label>部分完整标题</label>
                  <EditableField value={sec.partTitle ?? ''} onChange={(v) => updateSection(si, { partTitle: v || undefined })}
                    placeholder="如：第一部分：听力理解（共两节，满分30分）" />
                </div>
              </div>
              <div className="exam-field">
                <label>节标题</label>
                {(sec.subHeaders ?? []).map((h, hi) => (
                  <div key={hi} className="exam-notice-row">
                    <EditableField value={h} onChange={(v) => updateSubHeader(si, hi, v)} className="exam-notice-field"
                      placeholder="如：第一节（共5小题；每小题1.5分，满分7.5分）" />
                    <button className="btn-mini" onClick={() => deleteSubHeader(si, hi)}>✕</button>
                  </div>
                ))}
                <button className="btn-mini" onClick={() => addSubHeader(si)}>+ 添加节标题</button>
              </div>
              <div className="exam-field">
                <label>大题说明</label>
                <EditableField value={sec.instruction ?? ''} onChange={(v) => updateSection(si, { instruction: v || undefined })} multiline />
              </div>
              {sec.questions.map((q, qi) => (
                <div key={q.id} className="exam-question">
                  <div className="exam-question-head">
                    <span className={`exam-type-badge exam-badge-${q.type}`}>{TYPE_LABELS[q.type]}</span>
                    <div className="exam-question-number">
                      <EditableField value={q.number} onChange={(v) => updateQuestion(si, qi, { number: v })} placeholder="题号" />
                    </div>
                    {q.type === 'passage' && (
                      <div className="exam-question-number">
                        <EditableField value={q.label ?? ''} onChange={(v) => updateQuestion(si, qi, { label: v || undefined })} placeholder="标号" />
                      </div>
                    )}
                    <div className="exam-controls">
                      <button className="btn-mini" onClick={() => moveQuestion(si, qi, -1)} disabled={qi === 0}>▲</button>
                      <button className="btn-mini" onClick={() => moveQuestion(si, qi, 1)} disabled={qi === sec.questions.length - 1}>▼</button>
                      <button className="btn-mini" onClick={() => deleteQuestion(si, qi)}>✕</button>
                    </div>
                  </div>
                  <EditableField value={q.stem} onChange={(v) => updateQuestion(si, qi, { stem: v })} multiline
                    placeholder={q.type === 'passage' ? '文章正文（可多段）' : '题干'} />
                  {q.type === 'choice' && (q.options ?? []).length > 0 && (
                    <div className="exam-options">
                      {(q.options ?? []).map((o, oi) => (
                        <div key={oi} className="exam-option-row">
                          <div className="exam-option-label">
                            <EditableField value={o.label} onChange={(v) => updateOption(si, qi, oi, v, o.text)} />
                          </div>
                          <EditableField value={o.text} onChange={(v) => updateOption(si, qi, oi, o.label, v)}
                            className="exam-option-text" placeholder="选项内容" />
                          <button className="btn-mini" onClick={() => deleteOption(si, qi, oi)}>✕</button>
                        </div>
                      ))}
                      <button className="btn-mini" onClick={() => addOption(si, qi)}>+ 添加选项</button>
                    </div>
                  )}
                  <div className="exam-answer-row">
                    <span className="exam-answer-label">答案</span>
                    <EditableField value={q.answer ?? ''} onChange={(v) => updateQuestion(si, qi, { answer: v })}
                      className="exam-answer-field" placeholder="未填" />
                  </div>
                </div>
              ))}
              <div className="exam-add-question">
                {(['passage', 'choice', 'blank', 'essay', 'other'] as ExamQuestionType[]).map((t) => (
                  <button key={t} className="btn-mini" onClick={() => addQuestion(si, t)}>+ {TYPE_LABELS[t]}</button>
                ))}
              </div>
            </div>
          ))}
          <button className="btn-mini exam-add-section" onClick={addSection}>+ 添加大题</button>
              </>
            )}
          </StageCard>

          {/* ③ 排版与导出 */}
          <StageCard anchorId={STAGE_ANCHOR.export} index={3} title="排版与导出"
            meta={paper ? 'Word 可导出' : ''}
            summary={paper ? '纸张 / 字号 / 页数 · 预览 / 导出 Word' : '解析后可排版导出'}
            open={openStages.has('export')} onToggle={() => toggleStage('export')}>
            {!paper && (
              <p className="sf-stage-hint">解析成卷后，可在这里选择纸张、字号与目标页数，预览排版并导出 Word；「↺ 重新解析」可返回第 ① 步修改原文。</p>
            )}
            <div className="result-section">
              <h3>排版选项</h3>
              <div className="exam-subgroup">
                <span className="exam-control-title">纸张</span>
                <div className="level-pills">
                  {EXAM_PAPERS.map((p) => (
                    <button key={p.value} className={`level-pill ${layout.paper === p.value ? 'active' : ''}`}
                      onClick={() => setLayout((prev) => ({ ...prev, paper: p.value }))} title={p.description}>
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="exam-subgroup exam-layout-row">
                <div>
                  <span className="exam-control-title">正文字号</span>
                  <select className="model-select" value={layout.fontSize}
                    onChange={(e) => setLayout((prev) => ({ ...prev, fontSize: Number(e.target.value) }))}>
                    {EXAM_FONT_SIZES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </div>
                <div>
                  <span className="exam-control-title" title="自动调节行距/段距使正文贴近目标页数（答案页另计）；8K/A3 双面打印 1 张纸 = 2 页">目标页数</span>
                  <select className="model-select" value={layout.targetPages}
                    onChange={(e) => setLayout((prev) => ({ ...prev, targetPages: Number(e.target.value) }))}>
                    {EXAM_TARGET_PAGES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
                <label className="exam-checkbox">
                  <input type="checkbox" checked={layout.withHeader}
                    onChange={(e) => setLayout((prev) => ({ ...prev, withHeader: e.target.checked }))} />
                  试卷头
                </label>
                <label className="exam-checkbox">
                  <input type="checkbox" checked={layout.withAnswerPage}
                    onChange={(e) => setLayout((prev) => ({ ...prev, withAnswerPage: e.target.checked }))} />
                  附答案页
                </label>
              </div>
              <div className="input-actions">
                <button className="btn-extract" onClick={handleExport} disabled={!paper}><Icon name="exportDoc" size={16} /> 导出 Word</button>
                <button className="btn-mini" onClick={() => setShowPreview(true)} disabled={!paper}><Icon name="search" size={16} /> 排版预览</button>
                <button className="btn-mini" onClick={handleReparse}>↺ 重新解析</button>
              </div>
              <p className="sf-stage-hint">「重新解析」保留原文并返回第 ① 步；排版选项可随时调整，导出与预览使用同一设置。</p>
            </div>
          </StageCard>
        </div>
      </div>

      {showPreview && paper && (
        <ExamPreview paper={paper} layout={layout} onClose={() => setShowPreview(false)} />
      )}

      {showHistory && (
        <HistoryModal
          module="exampaper"
          moduleLabel={MODULE_LABELS.exampaper}
          onLoad={(item) => { restoreState((item as SavedItem<ExamPaperState>).data); setShowHistory(false); }}
          onClose={() => setShowHistory(false)}
        />
      )}
      {costDialog}
    </div>
  );
}
