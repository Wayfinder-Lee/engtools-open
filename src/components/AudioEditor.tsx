/**
 * 听力剪辑（AudioEditor）—— 纯本地音频剪辑工具，不走 LLM、不耗额度。
 *
 * 波形显示的是「拼接后的时间线」：剪切 / 保留 / 插静音都作用在波形上看到的
 * 位置，跨越选区边界的片段自动拆开。播放直接用 wavesurfer 的媒体元素播拼接
 * 预览（每次编辑后用 WAV blob + 预计算 peaks 重载，跳过重复解码）；导出时
 * 再把片段拼成 AudioBuffer 编码成 MP3 / WAV。音频全程不出浏览器。
 *
 * 交互模型：波形上单击 = 定位播放头，横向拖动 = 框选区（dragToSeek 关掉后
 * 拖拽交给 regions 插件）；波形上方细标尺条上的时间标签可拖动改播放位置；
 * 长音频用缩放滑块 + 底部 minimap 总览导航。编辑进度（原始音频 Blob + 时间线）
 * 防抖自动存进 IndexedDB，切走再回来可恢复。
 *
 * 变速（不变调）：SoundTouch time-stretch，弹窗内实时试听（改速度立即生效），
 * 应用时离线拉伸成新 WAV 音源——选区模式只替换选区段，整段模式整条换新。
 */
import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { AUDIO_TEMPLATES, type AudioTemplate } from '../data/audioTemplates';
import {
  assembleTimeline,
  closeSharedAudioContext,
  getSharedAudioContext,
  insertSegmentAt,
  isSilence,
  makeSilence,
  removeRange,
  resolveRange,
  timelineDuration,
  type EditSegment,
  type SourceEntry,
} from '../utils/audioEdit';
import {
  clearAudioSession,
  loadAudioSession,
  saveAudioSession,
  type AudioSessionRecord,
} from '../utils/audioSession';
import { encodeMp3, encodeWav } from '../utils/audioExport';
import {
  clampTempo,
  createSpeedPreview,
  fmtTempo,
  MAX_TEMPO,
  MIN_TEMPO,
  sliceAudioBuffer,
  stretchAudioBuffer,
  type SpeedPreview,
} from '../utils/audioSpeed';
import { requestAudio } from '../services/api';
import { getToken } from '../utils/session';
import './AudioEditor.css';

// wavesurfer.js v8 运行时按需动态加载（主包零增重），这里只引类型
type WaveSurferMod = typeof import('wavesurfer.js');
type RegionsMod = typeof import('wavesurfer.js/dist/plugins/regions.esm.js');
type WsInstance = ReturnType<WaveSurferMod['default']['create']>;
type RegionsInstance = ReturnType<RegionsMod['default']['create']>;
type WsRegion = ReturnType<RegionsInstance['addRegion']>;

const REGION_ALPHA = 0.25;
/** 缩放上限：波形最宽时的 px/s（时长 × px/s = 波形像素宽度） */
const MAX_ZOOM = 200;
/** 缩放步进（0..1 因子），滑块与 ± 按钮共用指数映射，步进手感均匀 */
const ZOOM_STEP = 0.2;
/** 变速预设档位（0.8 慢速训练最常用；1.2/1.4 提速训练常用；默认 1.25 偏加速场景） */
const SPEED_PRESETS = [0.5, 0.75, 0.8, 1.0, 1.25, 1.5, 2.0];
const DEFAULT_SPEED_TEMPO = 1.25;

/** 合成语速档（云端 TTS speech_rate：-500~500，步进 50；-200 ≈ 0.8× 听感） */
const TTS_RATES = [
  { value: -200, label: '慢速' },
  { value: 0, label: '正常' },
  { value: 200, label: '稍快' },
] as const;
/** 合成文本上限（与后端钳制一致；官方超出即截断） */
const TTS_MAX_CHARS = 300;

/** 读根节点 CSS 变量：wavesurfer 画布不认 var()，需要取计算后的颜色值 */
function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** --accent（#rrggbb）→ rgba 字符串，用作选区底色 */
function accentRgba(alpha: number): string {
  const hex = cssVar('--accent', '#d97757').replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return `rgba(217,119,87,${alpha})`;
  const n = parseInt(hex, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** mm:ss.d 时长显示 */
function fmtDur(t: number): string {
  const s = Number.isFinite(t) && t > 0 ? t : 0;
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${String(m).padStart(2, '0')}:${rest < 10 ? '0' : ''}${rest.toFixed(1)}`;
}

/** mm:ss 整秒时长显示（变速弹窗的预计时长用，不带小数） */
function fmtClock(t: number): string {
  const s = Number.isFinite(t) && t > 0 ? t : 0;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return r === 60 ? `${String(m + 1).padStart(2, '0')}:00` : `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

/** 静音标签用的短时长：2 → "2s"，1.5 → "1.5s" */
function fmtShort(t: number): string {
  return `${parseFloat(t.toFixed(2))}s`;
}

/** 去扩展名 */
function trimExt(name: string): string {
  return name.replace(/\.[^.]+$/, '') || name;
}

export default function AudioEditor() {
  // ─── 音源注册表与时间线状态 ───
  const sourcesRef = useRef(new Map<string, SourceEntry>());
  const idRef = useRef(0);
  const [segments, setSegments] = useState<EditSegment[]>([]);
  const segmentsRef = useRef(segments); // 事件回调里读最新片段数组
  const [past, setPast] = useState<EditSegment[][]>([]);
  const [future, setFuture] = useState<EditSegment[][]>([]);
  /** 选区（拼接后时间线坐标），由波形上的 region 驱动 */
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const selectionRef = useRef(selection);

  // ─── wavesurfer 相关 ───
  const containerRef = useRef<HTMLDivElement | null>(null);
  /** minimap 独立容器：必须在 wavesurfer create 时就存在于 DOM（插件构造期挂载），
   *  且不能省——默认位置在主波形滚动容器内部，缩放后会跟着滚出视口 */
  const minimapRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WsInstance | null>(null);
  const regionsRef = useRef<RegionsInstance | null>(null);
  const activeRegionRef = useRef<WsRegion | null>(null);
  const dragDisposeRef = useRef<(() => void) | null>(null);
  /** 波形重建后要恢复的播放头位置 */
  const pendingSeekRef = useRef<number | null>(null);
  /** 播放头标尺拖拽中（拖拽期间标签位置跟随指针，不等信息事件回流） */
  const scrubbingRef = useRef(false);
  /** 当前缩放目标（px/s；0 = 适应容器）。持久保存在 wavesurfer options 里，波形重建后仍生效 */
  const zoomPxRef = useRef(0);
  const [wsReady, setWsReady] = useState(false);
  /** 「适应容器」的 px/s（容器宽 / 时长），随波形重建更新，用于缩放倍数显示 */
  const [fitZoom, setFitZoom] = useState(0);
  /** 缩放因子 0..1（0=适应容器），指数映射到 fit→MAX_ZOOM px/s */
  const [zoomFactor, setZoomFactor] = useState(0);

  // ─── UI 状态 ───
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rebuilding, setRebuilding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [exportFormat, setExportFormat] = useState<'mp3' | 'wav'>('mp3');
  const [fileName, setFileName] = useState('listening-edited');
  const [silenceSec, setSilenceSec] = useState('2');
  const [sourcesVersion, setSourcesVersion] = useState(0);

  // ─── 变速（不变调）弹窗 ───
  const [speedOpen, setSpeedOpen] = useState(false);
  /** 目标速度（始终是合法值）；输入框原文单独存，避免打字被回显打断 */
  const [speedTempo, setSpeedTempo] = useState(DEFAULT_SPEED_TEMPO);
  const [speedTempoInput, setSpeedTempoInput] = useState(fmtTempo(DEFAULT_SPEED_TEMPO));
  const [speedScope, setSpeedScope] = useState<'selection' | 'whole'>('whole');
  const [speedPreviewing, setSpeedPreviewing] = useState(false);
  const previewRef = useRef<SpeedPreview | null>(null);
  /** 试听链代际号：停止 / 关弹窗时 +1，让在途的异步创建作废 */
  const previewSeqRef = useRef(0);

  // ─── 合成语音（TTS）弹窗 ───
  const [ttsOpen, setTtsOpen] = useState(false);
  const [ttsText, setTtsText] = useState('');
  const [ttsVoice, setTtsVoice] = useState<'male' | 'female'>('male');
  const [ttsRate, setTtsRate] = useState<number>(0);
  const [ttsBusy, setTtsBusy] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);
  /** 生成成功的 mp3 结果（blob 供插入，url 供 <audio> 试听）；ref 供卸载时回收 URL */
  const [ttsResult, setTtsResult] = useState<{ blob: Blob; url: string; label: string } | null>(null);
  const ttsResultRef = useRef(ttsResult);

  // ─── 本地会话自动保存（IndexedDB） ───
  /** 挂载时检测到的待恢复记录；用户选择恢复 / 丢弃（或开始新编辑）前挂在那儿 */
  const [pendingRecord, setPendingRecord] = useState<AudioSessionRecord | null>(null);
  const pendingRecordRef = useRef(pendingRecord);
  /** 挂载检测完成前禁止写入，防止空时间线把待恢复记录冲掉 */
  const [sessionChecked, setSessionChecked] = useState(false);
  /** 有防抖中的挂起保存时为真，卸载时立即落盘 */
  const pendingSaveRef = useRef(false);

  useEffect(() => {
    segmentsRef.current = segments;
  }, [segments]);
  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);
  useEffect(() => {
    pendingRecordRef.current = pendingRecord;
  }, [pendingRecord]);

  const empty = segments.length === 0;
  const totalDur = timelineDuration(segments);
  const hasSelection = selection != null;
  const insertHint = hasSelection ? '选区起点' : '播放头';
  // 当前缩放倍数（相对「适应容器」），仅用于标签显示
  const zoomPx = fitZoom > 0 && zoomFactor > 0.001 ? fitZoom * Math.pow(MAX_ZOOM / fitZoom, zoomFactor) : 0;
  const zoomMultiple = zoomPx > 0 ? zoomPx / fitZoom : 1;
  // 变速弹窗的作用范围时长（选区模式无选区时回退整段，与试听 / 应用口径一致）
  const speedSel = speedScope === 'selection' ? selection : null;
  const speedScopeDur = speedSel ? speedSel.end - speedSel.start : totalDur;
  const speedAfterDur = speedScopeDur / speedTempo;

  // ─── wavesurfer 初始化（依赖动态加载，StrictMode 双挂载安全） ───
  useEffect(() => {
    let disposed = false;
    let instance: WsInstance | null = null;
    void (async () => {
      const [
        { default: WaveSurfer },
        { default: TimelinePlugin },
        { default: RegionsPlugin },
        { default: MinimapPlugin },
      ] = await Promise.all([
        import('wavesurfer.js'),
        import('wavesurfer.js/dist/plugins/timeline.esm.js'),
        import('wavesurfer.js/dist/plugins/regions.esm.js'),
        import('wavesurfer.js/dist/plugins/minimap.esm.js'),
      ]);
      if (disposed || !containerRef.current) return;

      const regions = RegionsPlugin.create();
      // minimap 颜色用固定中性色：minimap 内部实例不随主实例 setOptions 联动，
      // 主题切换后保持不变也可接受（--accent 两主题同值，灰阶双主题都可读）
      const minimap = MinimapPlugin.create({
        ...(minimapRef.current ? { container: minimapRef.current } : {}),
        height: 36,
        waveColor: '#98958d',
        progressColor: '#d97757',
        cursorColor: '#a64a28',
        overlayColor: 'rgba(127, 127, 127, 0.3)',
        dragToSeek: true,
      });
      instance = WaveSurfer.create({
        container: containerRef.current,
        height: 110,
        waveColor: cssVar('--fg-faint', '#98958d'),
        progressColor: cssVar('--accent', '#d97757'),
        cursorColor: cssVar('--accent-text', '#a64a28'),
        cursorWidth: 2,
        barWidth: 2,
        barGap: 1,
        // 拖拽波形 = 框选区（regions 接管）；单击仍是定位播放头
        dragToSeek: false,
        // 缩放后视口导航走 minimap + 播放头标尺，隐藏原生滚动条
        hideScrollbar: true,
        autoScroll: true,
        autoCenter: true,
        plugins: [
          TimelinePlugin.create({ height: 24, style: { color: 'var(--fg-faint)' } }),
          regions,
          minimap,
        ],
      });
      wsRef.current = instance;
      regionsRef.current = regions;
      // 拖拽波形出选区（v8 由 enableDragSelection 开启，返回解绑函数）
      dragDisposeRef.current = regions.enableDragSelection({ color: accentRgba(REGION_ALPHA) });
      // 单选区策略：新选区出现时移除旧的；空时间线上不允许出选区
      regions.on('region-created', (region) => {
        if (!wsRef.current || wsRef.current.getDuration() <= 0) {
          region.remove();
          return;
        }
        regions.getRegions().forEach((r) => {
          if (r.id !== region.id) r.remove();
        });
        activeRegionRef.current = region;
        setSelection({ start: region.start, end: region.end });
      });
      regions.on('region-update', (region) => {
        activeRegionRef.current = region;
        setSelection({ start: region.start, end: region.end });
      });
      regions.on('region-updated', (region) => {
        activeRegionRef.current = region;
        setSelection({ start: region.start, end: region.end });
      });
      // region-removed 只清引用不动选区状态：清区图形是重建流程的一部分，选区以 React 状态为准
      regions.on('region-removed', (region) => {
        if (activeRegionRef.current?.id === region.id) activeRegionRef.current = null;
      });
      // 点击选区 = 试听该段
      regions.on('region-clicked', (region, e) => {
        e.stopPropagation();
        region.play(true);
      });

      instance.on('ready', (dur) => {
        setDuration(dur);
        regionsRef.current?.clearRegions();
        const seek = pendingSeekRef.current;
        pendingSeekRef.current = null;
        if (seek != null) instance?.setTime(Math.min(seek, dur));
        restoreSelectionRegion();
        syncZoomAfterReady(dur);
      });
      instance.on('play', () => setPlaying(true));
      instance.on('pause', () => setPlaying(false));
      instance.on('finish', () => setPlaying(false));
      instance.on('timeupdate', (t) => {
        setCurrentTime((prev) => (Math.abs(prev - t) > 0.05 ? t : prev));
      });
      instance.on('seeking', (t) => setCurrentTime(t));
      instance.on('error', (err) => {
        setError(`音频出错：${err instanceof Error ? err.message : '未知错误'}`);
      });
      setWsReady(true);
    })();
    return () => {
      disposed = true;
      setWsReady(false);
      dragDisposeRef.current?.();
      dragDisposeRef.current = null;
      instance?.destroy();
      instance = null;
      wsRef.current = null;
      regionsRef.current = null;
      activeRegionRef.current = null;
      // 解码用的 AudioContext 一并归还（模块级单例，close 后下次调用自动重建）
      closeSharedAudioContext();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 波形重建完成后按当前选区（钳制到新时长）恢复选区图形 */
  function restoreSelectionRegion() {
    const regions = regionsRef.current;
    const ws = wsRef.current;
    const sel = selectionRef.current;
    if (!regions || !ws) return;
    const dur = ws.getDuration();
    if (!sel || dur <= 0) {
      setSelection(null);
      return;
    }
    const start = Math.min(sel.start, dur);
    const end = Math.min(sel.end, dur);
    if (end - start < 0.01) {
      setSelection(null);
      return;
    }
    regions.addRegion({ start, end, color: accentRgba(REGION_ALPHA), drag: true, resize: true });
    if (start !== sel.start || end !== sel.end) setSelection({ start, end });
  }

  // ─── 波形缩放 ───

  /** 「适应容器」的 px/s；无音频或容器不可测时返回 0 */
  function currentFit(): number {
    const ws = wsRef.current;
    const cw = containerRef.current?.clientWidth ?? 0;
    const dur = ws?.getDuration() ?? 0;
    if (!ws || cw <= 0 || dur <= 0) return 0;
    return cw / dur;
  }

  /** 把视口水平滚动到以时间点 t 为中心（缩放后保持视野不跳） */
  function centerViewOn(t: number) {
    const ws = wsRef.current;
    if (!ws) return;
    const dur = ws.getDuration();
    const view = ws.getWidth();
    const full = ws.getWrapper().clientWidth;
    if (dur <= 0 || view <= 0 || full <= view + 1) return;
    const target = t * (full / dur) - view / 2;
    ws.setScroll(Math.max(0, Math.min(target, full - view)));
  }

  /** 应用缩放（factor 0..1，0=适应容器），指数映射 fit→MAX_ZOOM；锚定播放头 / 视口中心 */
  function applyZoom(factor: number) {
    const ws = wsRef.current;
    const fit = currentFit();
    if (!ws || fit <= 0) return;
    const f = Math.max(0, Math.min(1, factor));
    const dur = ws.getDuration();
    const view = ws.getWidth();
    const full = ws.getWrapper().clientWidth;
    // 锚点：播放中锚播放头；静止且已滚动时锚当前视口中心
    let anchor: number | null = null;
    if (ws.isPlaying()) anchor = ws.getCurrentTime();
    else if (full > view + 1 && view > 0) anchor = ((ws.getScroll() + view / 2) * dur) / full;
    const px = f <= 0.001 ? 0 : fit * Math.pow(MAX_ZOOM / fit, f);
    zoomPxRef.current = px;
    ws.zoom(px);
    if (anchor != null) centerViewOn(anchor);
    setZoomFactor(f);
  }

  function zoomStep(dir: 1 | -1) {
    applyZoom(zoomFactor + dir * ZOOM_STEP);
  }

  /** 波形重建（ready）后同步缩放 UI；缩放状态下把视口对回播放头 */
  function syncZoomAfterReady(dur: number) {
    const cw = containerRef.current?.clientWidth ?? 0;
    if (dur <= 0 || cw <= 0) return;
    const fit = cw / dur;
    setFitZoom(fit);
    const px = zoomPxRef.current;
    if (px > fit) {
      setZoomFactor(Math.min(1, Math.log(px / fit) / Math.log(MAX_ZOOM / fit)));
      centerViewOn(wsRef.current?.getCurrentTime() ?? 0);
    } else {
      zoomPxRef.current = 0;
      setZoomFactor(0);
    }
  }

  // ─── 播放头标尺（波形上方的可拖动时间标签） ───

  /** 标尺上横向位置 → 时间并应用到 wavesurfer */
  function rulerSeekTo(clientX: number, el: HTMLDivElement) {
    const ws = wsRef.current;
    if (!ws || duration <= 0) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    const t = ratio * duration;
    setCurrentTime(t); // 拖拽期间标签直接跟随指针，不等 timeupdate 回流
    ws.setTime(t);
  }

  function onRulerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (duration <= 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    scrubbingRef.current = true;
    rulerSeekTo(e.clientX, e.currentTarget);
  }

  function onRulerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!scrubbingRef.current) return;
    rulerSeekTo(e.clientX, e.currentTarget);
  }

  function onRulerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!scrubbingRef.current) return;
    scrubbingRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }

  function onRulerKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const ws = wsRef.current;
    if (!ws || duration <= 0) return;
    const step = e.shiftKey ? 5 : 1;
    let t: number | null = null;
    if (e.key === 'ArrowLeft') t = Math.max(0, currentTime - step);
    else if (e.key === 'ArrowRight') t = Math.min(duration, currentTime + step);
    else if (e.key === 'Home') t = 0;
    else if (e.key === 'End') t = duration;
    if (t == null) return;
    e.preventDefault();
    setCurrentTime(t);
    ws.setTime(t);
  }

  // 主题切换（data-theme 属性变化）→ 更新波形画布颜色并重挂拖拽选区
  useEffect(() => {
    const applyTheme = () => {
      dragDisposeRef.current?.();
      dragDisposeRef.current =
        regionsRef.current?.enableDragSelection({ color: accentRgba(REGION_ALPHA) }) ?? null;
      const ws = wsRef.current;
      if (!ws) return;
      ws.setOptions({
        waveColor: cssVar('--fg-faint', '#98958d'),
        progressColor: cssVar('--accent', '#d97757'),
        cursorColor: cssVar('--accent-text', '#a64a28'),
      });
      activeRegionRef.current?.setOptions({ color: accentRgba(REGION_ALPHA) });
    };
    const observer = new MutationObserver(applyTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  // 时间线变化 → 重新拼接预览并喂给 wavesurfer（150ms 防抖合并连续操作）
  useEffect(() => {
    if (!wsReady) return;
    const ws = wsRef.current;
    if (!ws) return;
    if (segments.length === 0) {
      ws.stop();
      ws.empty();
      regionsRef.current?.clearRegions();
      setDuration(0);
      setPlaying(false);
      setCurrentTime(0);
      setRebuilding(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setRebuilding(true);
      void (async () => {
        try {
          const buffer = await assembleTimeline(segments, sourcesRef.current);
          if (cancelled) return;
          if (!buffer) {
            // 时间线只剩静音：清空波形显示
            ws.stop();
            ws.empty();
            regionsRef.current?.clearRegions();
            setDuration(0);
            return;
          }
          const peaks: Float32Array[] = [];
          for (let c = 0; c < buffer.numberOfChannels; c++) peaks.push(buffer.getChannelData(c));
          pendingSeekRef.current = Math.min(wsRef.current?.getCurrentTime() ?? 0, buffer.duration);
          await wsRef.current?.loadBlob(encodeWav(buffer), peaks, buffer.duration);
        } catch (err) {
          // 被更新的加载取代（连续操作）属正常流程，不报错
          if (!cancelled) {
            setError(err instanceof Error ? `波形更新失败：${err.message}` : '波形更新失败');
          }
        } finally {
          if (!cancelled) setRebuilding(false);
        }
      })();
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [segments, sourcesVersion, wsReady]);

  // ─── 本地会话自动保存（IndexedDB，防抖 500ms） ───

  /** 把当前会话写进 IndexedDB；时间线为空即删记录。只读 refs，卸载 flush 可复用 */
  function persistSession() {
    const segs = segmentsRef.current;
    if (segs.length === 0) return void clearAudioSession();
    // 只存时间线引用到的音源（编辑后可能留下孤儿源，没必要持久化）
    const used = new Set(segs.map((s) => s.sourceId));
    const sources = [];
    for (const [id, entry] of sourcesRef.current.entries()) {
      if (used.has(id) && entry.blob) sources.push({ id, name: entry.name, blob: entry.blob });
    }
    return void saveAudioSession({
      savedAt: Date.now(),
      duration: timelineDuration(segs),
      segments: segs,
      sources,
    });
  }

  // 挂载检测上次会话；检测完成前禁止写入，防止空时间线把待恢复记录冲掉
  useEffect(() => {
    let cancelled = false;
    void loadAudioSession().then((rec) => {
      if (cancelled) return;
      if (rec) setPendingRecord(rec);
      setSessionChecked(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 时间线 / 音源变化 → 500ms 防抖写回；恢复询问挂起且时间线为空时不动旧记录
  useEffect(() => {
    if (!sessionChecked) return;
    if (segments.length === 0 && pendingRecordRef.current) return;
    pendingSaveRef.current = true;
    const timer = window.setTimeout(() => {
      pendingSaveRef.current = false;
      persistSession();
    }, 500);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments, sourcesVersion, sessionChecked]);

  // 卸载时若还有未落盘的变更，立即写一次（异步写不阻塞卸载，fire-and-forget）
  useEffect(
    () => () => {
      if (pendingSaveRef.current) {
        pendingSaveRef.current = false;
        persistSession();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // 卸载时停掉变速试听链（断开 SoundTouch 节点；共享 AudioContext 由 wavesurfer 初始化 effect 一并归还）
  useEffect(
    () => () => {
      previewSeqRef.current++;
      previewRef.current?.stop();
      previewRef.current = null;
      if (ttsResultRef.current) URL.revokeObjectURL(ttsResultRef.current.url);
    },
    [],
  );

  // ─── 全局键盘控制：空格 = 播放/暂停，←/→ = 快退/快进 5 秒 ───
  // 弹窗打开时不接管；焦点在输入类控件 / 播放头标尺（自有方向键语义 ±1s / Shift±5s）时让位；
  // 无音频时不拦截，保留空格翻页等浏览器默认行为。按钮聚焦时空格播/放暂停而不是重复点按钮
  //（按钮仍可用回车激活），方向键允许按住连发 = 连续快进/快退
  useEffect(() => {
    if (speedOpen || ttsOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const target = e.target as HTMLElement | null;
      if (target && target.closest('input, textarea, select, [contenteditable="true"], [role="slider"]')) return;
      const ws = wsRef.current;
      if (!ws) return;
      const dur = ws.getDuration();
      if (dur <= 0) return;
      if (e.key === ' ') {
        if (e.repeat) return; // 按住空格只切换一次
        e.preventDefault();
        if (ws.isPlaying()) ws.pause();
        else void ws.play().catch(() => {});
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const t = Math.max(0, Math.min(dur, ws.getCurrentTime() + (e.key === 'ArrowLeft' ? -5 : 5)));
        setCurrentTime(t);
        ws.setTime(t);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [speedOpen, ttsOpen]);

  /** 恢复上次会话：重新解码各音源 Blob，重映射 sourceId 重建时间线（不入撤销栈） */
  async function restoreSession() {
    const rec = pendingRecordRef.current;
    if (!rec || busy) return;
    setError(null);
    setNotice(null);
    setBusy('正在恢复上次编辑…');
    try {
      const ctx = getSharedAudioContext();
      const idMap = new Map<string, string>();
      for (const s of rec.sources) {
        const buffer = await ctx.decodeAudioData(await s.blob.arrayBuffer());
        const id = `src-${++idRef.current}`;
        sourcesRef.current.set(id, { name: s.name, buffer, blob: s.blob });
        idMap.set(s.id, id);
      }
      const segs: EditSegment[] = [];
      for (const seg of rec.segments) {
        if (isSilence(seg)) {
          segs.push(seg);
          continue;
        }
        const newId = idMap.get(seg.sourceId);
        if (newId) segs.push({ ...seg, sourceId: newId });
      }
      if (segs.length === 0) throw new Error('时间线为空');
      setPast([]);
      setFuture([]);
      segmentsRef.current = segs;
      setSegments(segs);
      setSourcesVersion((v) => v + 1);
      checkMixedRates();
      setNotice(`已恢复上次编辑（共 ${segs.length} 段，时长 ${fmtDur(timelineDuration(segs))}）`);
    } catch {
      setError('恢复上次编辑失败：音频数据已无法解码，记录已丢弃');
      void clearAudioSession();
    } finally {
      setBusy(null);
      setPendingRecord(null);
    }
  }

  /** 丢弃上次会话记录 */
  function discardSession() {
    setPendingRecord(null);
    void clearAudioSession();
  }

  // ─── 编辑操作 ───

  /** 提交一次可撤销的编辑：旧片段数组快照入撤销栈 */
  function commit(next: EditSegment[]) {
    setPast((p) => [...p, segmentsRef.current].slice(-50));
    setFuture([]);
    segmentsRef.current = next;
    setSegments(next);
    setSelection(null);
  }

  function undo() {
    if (past.length === 0) return;
    const prev = past[past.length - 1];
    setPast(past.slice(0, -1));
    setFuture([segmentsRef.current, ...future]);
    segmentsRef.current = prev;
    setSegments(prev);
    setSelection(null);
  }

  function redo() {
    if (future.length === 0) return;
    const next = future[0];
    setPast([...past, segmentsRef.current]);
    setFuture(future.slice(1));
    segmentsRef.current = next;
    setSegments(next);
    setSelection(null);
  }

  /** 剪切所选：删掉选中区间，前后段自动拼接 */
  function cutSelection() {
    const sel = selectionRef.current;
    if (!sel || empty) return;
    commit(removeRange(segmentsRef.current, sel.start, sel.end));
  }

  /** 保留所选：只保留选中区间，删除其余全部 */
  function keepSelection() {
    const sel = selectionRef.current;
    if (!sel || empty) return;
    const kept = resolveRange(segmentsRef.current, sel.start, sel.end);
    if (kept.length === 0) {
      setError('选区内没有音频内容');
      return;
    }
    commit(kept);
  }

  /** 选区改为静音：把选中区间替换为等长静音（适合抹掉已讲的答案） */
  function silenceSelection() {
    const sel = selectionRef.current;
    if (!sel || empty) return;
    const dur = sel.end - sel.start;
    commit([makeSilence(dur, `静音 ${fmtShort(dur)}`)]);
  }

  /** 在播放头 / 选区起点插入指定秒数的静音 */
  function insertSilenceHere() {
    const dur = parseFloat(silenceSec);
    if (!Number.isFinite(dur) || dur <= 0) {
      setError('静音时长需要大于 0 秒');
      return;
    }
    if (empty) return;
    const at = selectionRef.current
      ? selectionRef.current.start
      : Math.min(Math.max(wsRef.current?.getCurrentTime() ?? 0, 0), totalDur);
    commit(insertSegmentAt(segmentsRef.current, at, makeSilence(dur, `静音 ${fmtShort(dur)}`)));
  }

  function deleteSegment(index: number) {
    commit(segmentsRef.current.filter((_, i) => i !== index));
  }

  // ─── 变速（不变调） ───

  /** 停止试听（幂等）：断开 SoundTouch 链，并作废在途的异步创建 */
  function stopSpeedPreview() {
    previewSeqRef.current++;
    previewRef.current?.stop();
    previewRef.current = null;
    setSpeedPreviewing(false);
  }

  function openSpeed() {
    if (empty) return;
    setSpeedOpen(true);
  }

  function closeSpeed() {
    stopSpeedPreview();
    setSpeedOpen(false);
  }

  /** 切换作用范围：试听起点随范围不同（选区开头 / 播放头），先停掉当前试听 */
  function changeSpeedScope(scope: 'selection' | 'whole') {
    stopSpeedPreview();
    setSpeedScope(scope);
  }

  /** 设定新速度（预设按钮或输入框合法值）：试听中改 tempo 立即生效，无需重播 */
  function applySpeedTempo(tempo: number) {
    const t = clampTempo(tempo);
    setSpeedTempo(t);
    setSpeedTempoInput(fmtTempo(t));
    previewRef.current?.setTempo(t);
  }

  /** 输入框原始文本：合法时同步速度，越界 / 半截数字只存文本，失焦时回显为当前速度 */
  function onSpeedInput(raw: string) {
    setSpeedTempoInput(raw);
    const v = parseFloat(raw);
    if (Number.isFinite(v) && v >= MIN_TEMPO && v <= MAX_TEMPO) {
      setSpeedTempo(v);
      previewRef.current?.setTempo(v);
    }
  }

  /** 试听：选区模式从选区开头循环播放；整段模式从播放头播到结尾 */
  async function startSpeedPreview() {
    if (busy || empty) return;
    const sel = speedScope === 'selection' ? selectionRef.current : null;
    if (speedScope === 'selection' && !sel) {
      setError('请先在波形上框选区段，或改用「整段时间线」');
      return;
    }
    stopSpeedPreview();
    setBusy('正在准备试听…');
    try {
      const full = await assembleTimeline(segmentsRef.current, sourcesRef.current);
      if (!full) throw new Error('时间线为空');
      const start = sel ? sel.start : Math.min(wsRef.current?.getCurrentTime() ?? 0, full.duration);
      const end = sel ? sel.end : full.duration;
      const slice = sliceAudioBuffer(full, start, end);
      wsRef.current?.pause(); // 避免与主波形播放叠音
      const token = previewSeqRef.current;
      const preview = await createSpeedPreview(slice, speedTempo, !!sel, () => setSpeedPreviewing(false));
      if (token !== previewSeqRef.current) {
        preview.stop(); // 准备期间弹窗被关 / 试听被停
        return;
      }
      previewRef.current = preview;
      setSpeedPreviewing(true);
    } catch (err) {
      setError(err instanceof Error ? `试听失败：${err.message}` : '试听失败');
    } finally {
      setBusy(null);
    }
  }

  /** 应用变速：离线拉伸成新 WAV 音源——选区模式只替换选区段，整段模式整条时间线换新 */
  async function applySpeed() {
    if (empty || busy) return;
    const tempo = speedTempo;
    stopSpeedPreview();
    setError(null);
    setNotice(null);
    setBusy('正在处理变速…');
    try {
      const sel = speedScope === 'selection' ? selectionRef.current : null;
      if (speedScope === 'selection' && !sel) throw new Error('选区已失效，请重新框选');
      const full = await assembleTimeline(segmentsRef.current, sourcesRef.current);
      if (!full) throw new Error('时间线为空');
      const source = sel ? sliceAudioBuffer(full, sel.start, sel.end) : full;
      const before = source.duration;
      const out = await stretchAudioBuffer(source, tempo, (p) =>
        setBusy(`正在处理变速… ${Math.round(p * 100)}%`),
      );
      // WAV Blob 作为新音源：IndexedDB 会话保存（存源 Blob + 片段表）天然兼容
      const blob = encodeWav(out);
      const id = `src-${++idRef.current}`;
      const label = `变速 ${fmtTempo(tempo)}×`;
      sourcesRef.current.set(id, { name: label, buffer: out, blob });
      const seg: EditSegment = { sourceId: id, start: 0, end: out.duration, label };
      if (sel) {
        // 选区外片段不动：挖掉选区，再把变速结果插回原位置
        commit(insertSegmentAt(removeRange(segmentsRef.current, sel.start, sel.end), sel.start, seg));
      } else {
        commit([seg]);
      }
      setSourcesVersion((v) => v + 1);
      setSpeedOpen(false);
      setNotice(`已应用变速 ${fmtTempo(tempo)}×：${fmtDur(before)} → ${fmtDur(out.duration)}`);
    } catch (err) {
      setError(err instanceof Error ? `变速失败：${err.message}` : '变速失败');
    } finally {
      setBusy(null);
    }
  }

  // ─── 合成语音（TTS） ───

  /** 释放当前预览结果（重新生成 / 关弹窗 / 插入成功后调用） */
  function clearTtsResult() {
    if (ttsResultRef.current) {
      URL.revokeObjectURL(ttsResultRef.current.url);
      ttsResultRef.current = null;
      setTtsResult(null);
    }
  }

  function openTts() {
    setTtsError(null);
    setTtsOpen(true);
  }

  function closeTts() {
    clearTtsResult();
    setTtsError(null);
    setTtsOpen(false);
  }

  /** 生成合成语音（需登录：免费，服务端日限流） */
  async function generateTts() {
    const text = ttsText.trim();
    if (!text || ttsBusy) return;
    const token = getToken();
    if (!token) {
      setTtsError('语音合成需登录后使用（右上角「登录」）');
      return;
    }
    setTtsBusy(true);
    setTtsError(null);
    try {
      const blob = await requestAudio('/api/tts', { text, voice: ttsVoice, speechRate: ttsRate }, token);
      clearTtsResult();
      const next = {
        blob,
        url: URL.createObjectURL(blob),
        label: ttsVoice === 'male' ? '合成男声' : '合成女声',
      };
      ttsResultRef.current = next;
      setTtsResult(next);
    } catch (err) {
      setTtsError(err instanceof Error ? err.message : '合成失败，请稍后重试');
    } finally {
      setTtsBusy(false);
    }
  }

  /** 合成结果插入到选区起点 / 播放头（与模板插入同一条管线） */
  async function insertTtsResult() {
    const result = ttsResultRef.current;
    if (!result || busy) return;
    setError(null);
    setNotice(null);
    setBusy('正在插入合成语音…');
    try {
      const raw = await result.blob.arrayBuffer();
      // decodeAudioData 会接管 ArrayBuffer，传副本解码，原 Blob 留给会话持久化
      const buffer = await getSharedAudioContext().decodeAudioData(raw.slice(0));
      const id = `src-${++idRef.current}`;
      sourcesRef.current.set(id, { name: result.label, buffer, blob: result.blob });
      const at = selectionRef.current
        ? selectionRef.current.start
        : Math.min(wsRef.current?.getCurrentTime() ?? 0, totalDur);
      commit(insertSegmentAt(segmentsRef.current, at, { sourceId: id, start: 0, end: buffer.duration, label: result.label }));
      setSourcesVersion((v) => v + 1);
      setPendingRecord(null);
      checkMixedRates();
      closeTts();
      setNotice(`已插入${result.label}（${fmtDur(buffer.duration)}）`);
    } catch {
      setError('合成音频解码失败，请重新生成');
    } finally {
      setBusy(null);
    }
  }

  // ─── 加载 / 导出 / 播放 ───

  /** 片段采样率不一致时提示（拼接与导出时会自动重采样统一） */
  function checkMixedRates() {
    const rates = new Set<number>();
    for (const seg of segmentsRef.current) {
      const entry = sourcesRef.current.get(seg.sourceId);
      if (entry) rates.add(entry.buffer.sampleRate);
    }
    if (rates.size > 1) {
      setNotice(`片段采样率不一致（${[...rates].sort((a, b) => a - b).join(' / ')} Hz），拼接与导出时会自动重采样统一`);
    }
  }

  /** 加载本地音频文件（可多选）：解码后按顺序追加到时间线末尾 */
  async function loadFiles(files: FileList | null) {
    const list = files ? Array.from(files) : [];
    if (list.length === 0 || busy) return;
    setError(null);
    setNotice(null);
    setBusy(`正在解码「${trimExt(list[0].name)}」…`);
    try {
      const ctx = getSharedAudioContext();
      const added: EditSegment[] = [];
      for (const file of list) {
        const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
        const id = `src-${++idRef.current}`;
        sourcesRef.current.set(id, { name: trimExt(file.name), buffer, blob: file });
        added.push({ sourceId: id, start: 0, end: buffer.duration, label: trimExt(file.name) });
      }
      commit([...segmentsRef.current, ...added]);
      setSourcesVersion((v) => v + 1);
      setPendingRecord(null); // 用户开始新编辑，撤掉恢复询问（旧记录由自动保存覆盖）
      checkMixedRates();
    } catch {
      setError('无法解码所选文件，请使用 mp3 / wav / m4a / ogg 格式的音频');
    } finally {
      setBusy(null);
    }
  }

  /** 加载站点静态资源里的模板音频，插入到选区起点 / 播放头 */
  async function insertTemplate(tpl: AudioTemplate) {
    if (busy) return;
    setError(null);
    setNotice(null);
    setBusy(`正在加载模板「${tpl.name}」…`);
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}audio-templates/${encodeURIComponent(tpl.file)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.arrayBuffer();
      // decodeAudioData 会接管 ArrayBuffer，传副本解码，原 buffer 留给 Blob 持久化
      const buffer = await getSharedAudioContext().decodeAudioData(raw.slice(0));
      const blob = new Blob([raw], { type: res.headers.get('content-type') ?? 'audio/mpeg' });
      const id = `src-${++idRef.current}`;
      sourcesRef.current.set(id, { name: tpl.name, buffer, blob });
      const at = selectionRef.current
        ? selectionRef.current.start
        : Math.min(wsRef.current?.getCurrentTime() ?? 0, totalDur);
      commit(insertSegmentAt(segmentsRef.current, at, { sourceId: id, start: 0, end: buffer.duration, label: tpl.name }));
      setSourcesVersion((v) => v + 1);
      setPendingRecord(null);
      checkMixedRates();
    } catch {
      setError(`模板「${tpl.name}」加载失败：文件不存在或浏览器无法解码（audio-templates/${tpl.file}）`);
    } finally {
      setBusy(null);
    }
  }

  /** 拼接时间线 → 编码 → 触发下载 */
  async function doExport() {
    if (empty || busy) return;
    wsRef.current?.pause();
    setError(null);
    setNotice(null);
    try {
      setBusy('正在拼接时间线…');
      setProgress(0);
      const buffer = await assembleTimeline(segmentsRef.current, sourcesRef.current);
      if (!buffer) throw new Error('时间线为空或全是静音');
      let blob: Blob;
      if (exportFormat === 'wav') {
        setBusy('正在编码 WAV…');
        blob = encodeWav(buffer);
      } else {
        setBusy('正在编码 MP3…');
        blob = await encodeMp3(buffer, setProgress);
      }
      const base = fileName.trim() || 'listening-edited';
      const name = `${base}.${exportFormat}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setNotice(`已导出 ${name}（${fmtDur(buffer.duration)}）`);
    } catch (err) {
      setError(err instanceof Error ? `导出失败：${err.message}` : '导出失败');
    } finally {
      setBusy(null);
      setProgress(0);
    }
  }

  /** 清空时间线、音源与本地自动保存记录，回到初始空白态（二次确认，不可撤销） */
  function resetAll() {
    if (segmentsRef.current.length === 0 && sourcesRef.current.size === 0) return;
    if (!window.confirm('确定清除当前音频与全部编辑记录？此操作不可撤销。')) return;
    wsRef.current?.stop();
    sourcesRef.current.clear();
    setPast([]);
    setFuture([]);
    segmentsRef.current = [];
    setSegments([]);
    setSelection(null);
    setError(null);
    setNotice(null);
    setPlaying(false);
    zoomPxRef.current = 0;
    setZoomFactor(0);
    setFitZoom(0);
    pendingSaveRef.current = false; // 作废挂起的保存，下面立即删记录
    setPendingRecord(null);
    void clearAudioSession();
  }

  function togglePlay() {
    const ws = wsRef.current;
    if (!ws || duration <= 0) return;
    if (ws.isPlaying()) ws.pause();
    else void ws.play().catch(() => {});
  }

  function stopPlayback() {
    const ws = wsRef.current;
    if (!ws) return;
    ws.stop();
    setCurrentTime(0);
    setPlaying(false);
  }

  return (
    <div className="ae-module">
      <header className="ae-head">
        <h2 className="ae-title"><Icon name="audio" size={20} /> 听力音频剪辑</h2>
        <p className="ae-sub">
          在波形上横向拖动即可框选区段，剪切长停顿、只保留目标段落或插入答题静音，还可对选区或整段
          变速不变调、输入文字合成指令语音，最后导出 MP3 / WAV。编辑进度自动保存在本机浏览器，切走再回来可以恢复；
          音频全程在本机处理，不会上传（「合成语音」输入的文字会发往服务器合成）。
        </p>
      </header>

      {error && (
        <div className="ae-banner ae-banner-error" role="alert">
          <span>{error}</span>
          <button className="ae-banner-close" aria-label="关闭错误提示" onClick={() => setError(null)}>✕</button>
        </div>
      )}
      {notice && (
        <div className="ae-banner ae-banner-info">
          <span>{notice}</span>
          <button className="ae-banner-close" aria-label="关闭提示" onClick={() => setNotice(null)}>✕</button>
        </div>
      )}
      {busy && (
        <div className="ae-banner ae-banner-busy" role="status">
          <span>{busy}</span>
        </div>
      )}
      {pendingRecord && (
        <div className="ae-banner ae-banner-restore">
          <span>检测到上次未完成的编辑（时长 {fmtDur(pendingRecord.duration)}），要继续吗？</span>
          <button className="ae-btn ae-tbtn ae-btn-primary" disabled={!!busy} onClick={() => void restoreSession()}>
            恢复
          </button>
          <button className="ae-btn ae-tbtn ae-btn-ghost" disabled={!!busy} onClick={discardSession}>
            丢弃
          </button>
        </div>
      )}

      {/* ① 加载 */}
      <section className="ae-card">
        <div className="ae-card-head">
          <h3>① 加载音频</h3>
          <span className="ae-card-hint">支持 mp3 / wav / m4a / ogg，可多选、可分次追加拼接</span>
        </div>
        <div className="ae-load-row">
          <label className="ae-btn ae-btn-primary">
            <input
              type="file"
              accept=".mp3,.wav,.m4a,.ogg,audio/*"
              multiple
              disabled={!!busy}
              onChange={(e) => {
                void loadFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <Icon name="folder" size={16} /> 选择音频文件
          </label>
          {AUDIO_TEMPLATES.length > 0 && (
            <div className="ae-templates">
              {AUDIO_TEMPLATES.map((tpl) => (
                <button
                  key={tpl.file}
                  className="ae-btn ae-btn-ghost"
                  disabled={!!busy}
                  title={tpl.description ?? `把「${tpl.name}」插入到${insertHint}`}
                  onClick={() => void insertTemplate(tpl)}
                >
                  <Icon name="plus" size={16} /> {tpl.name}
                </button>
              ))}
            </div>
          )}
          {!empty && (
            <button
              className="ae-btn ae-btn-danger"
              disabled={!!busy}
              title="清除当前音频、编辑记录与本机自动保存"
              onClick={resetAll}
            >
              <Icon name="trash" size={16} /> 清除音频
            </button>
          )}
        </div>
      </section>

      {/* ② 剪辑 */}
      <section className="ae-card">
        <div className="ae-card-head">
          <h3>② 剪辑</h3>
          <span className="ae-card-hint">
            在波形上横向拖动框选区，拖动选区或拉伸两端可微调，点击选区可试听；拖动上方时间标签改变播放位置
          </span>
          {rebuilding && <span className="ae-rebuilding">正在更新波形…</span>}
        </div>
        <div className="ae-editor-zone">
          <div className="ae-transport">
            <button className="ae-btn ae-tbtn" onClick={togglePlay} disabled={empty || duration <= 0}>
              {playing ? '⏸ 暂停' : '▶ 播放'}
            </button>
            <button className="ae-btn ae-tbtn" onClick={stopPlayback} disabled={empty || duration <= 0}>
              ⏹ 停止
            </button>
            <span className="ae-transport-sep" />
            <button className="ae-btn ae-tbtn" onClick={undo} disabled={past.length === 0}>↩ 撤销</button>
            <button className="ae-btn ae-tbtn" onClick={redo} disabled={future.length === 0}>↪ 重做</button>
            <span className="ae-time">
              {fmtDur(currentTime)} / {fmtDur(duration)}
            </span>
          </div>
          {duration > 0 && (
            <div
              className="ae-ph-ruler"
              onPointerDown={onRulerDown}
              onPointerMove={onRulerMove}
              onPointerUp={onRulerUp}
              onPointerCancel={onRulerUp}
            >
              <div
                className="ae-ph-handle"
                role="slider"
                tabIndex={0}
                aria-label="播放位置，可拖动或用左右方向键调整"
                aria-valuemin={0}
                aria-valuemax={Math.round(duration * 10) / 10}
                aria-valuenow={Math.round(currentTime * 10) / 10}
                aria-valuetext={fmtDur(currentTime)}
                style={{ left: `${(currentTime / duration) * 100}%` }}
                onKeyDown={onRulerKeyDown}
              >
                {fmtDur(currentTime)}
              </div>
            </div>
          )}
          <div className="ae-wave-holder">
            <div ref={containerRef} className="ae-wave" />
            {empty && (
              <div className="ae-empty">
                <p>加载听力音频后开始剪辑</p>
                <p>可在波形上横向拖动框选区，进行剪切 / 保留 / 插入静音</p>
              </div>
            )}
          </div>
          {!empty && (
            <div className="ae-zoom-row">
              <span className="ae-zoom-label">视图缩放</span>
              <button
                className="ae-btn ae-tbtn"
                onClick={() => zoomStep(-1)}
                disabled={duration <= 0 || zoomFactor <= 0}
                aria-label="缩小波形"
                title="缩小"
              >
                －
              </button>
              <input
                className="ae-zoom-slider"
                type="range"
                min={0}
                max={1000}
                step={1}
                value={Math.round(zoomFactor * 1000)}
                disabled={duration <= 0}
                aria-label="波形缩放级别"
                onChange={(e) => applyZoom(Number(e.target.value) / 1000)}
              />
              <button
                className="ae-btn ae-tbtn"
                onClick={() => zoomStep(1)}
                disabled={duration <= 0 || zoomFactor >= 1}
                aria-label="放大波形"
                title="放大"
              >
                ＋
              </button>
              <span className="ae-zoom-level">
                {zoomFactor <= 0.001 ? '适应容器' : `放大 ${zoomMultiple.toFixed(1)}×`}
              </span>
            </div>
          )}
          {/* minimap 总览：整段波形 + 当前视口阴影框，点击 / 拖动快速跳转。
              容器必须从首次挂载起常驻 DOM（插件构造期就挂进来，且不能落在主波形的
              滚动容器里——缩放后会被滚出视口），空态仅 display:none 隐藏 */}
          <div
            ref={minimapRef}
            className="ae-minimap"
            style={duration > 0 ? undefined : { display: 'none' }}
          />
          <div className="ae-ops">
            <button className="ae-btn ae-tbtn" onClick={cutSelection} disabled={!hasSelection} title="删掉选中区间，前后段自动拼接">
              <Icon name="scissors" size={16} /> 剪切所选
            </button>
            <button className="ae-btn ae-tbtn" onClick={keepSelection} disabled={!hasSelection} title="只保留选中区间，删除其余全部">
              <Icon name="pin" size={16} /> 保留所选
            </button>
            <button className="ae-btn ae-tbtn" onClick={silenceSelection} disabled={!hasSelection} title="把选中区间替换为等长静音">
              <Icon name="mute" size={16} /> 选区改为静音
            </button>
            <span className="ae-transport-sep" />
            <button
              className="ae-btn ae-tbtn"
              onClick={openTts}
              disabled={!!busy}
              title="输入文字（如考试指令）合成语音，插入到选区起点 / 播放头"
            >
              <Icon name="voice" size={16} /> 合成语音
            </button>
            <button className="ae-btn ae-tbtn" onClick={insertSilenceHere} disabled={empty} title="插入指定秒数的静音">
              <Icon name="plus" size={16} /> 插入静音
            </button>
            <span className="ae-silence-input">
              <input
                type="number"
                min={0.1}
                step={0.5}
                value={silenceSec}
                disabled={empty}
                onChange={(e) => setSilenceSec(e.target.value)}
              />
              秒
            </span>
            <span className="ae-ops-hint">插入到{insertHint}</span>
            <span className="ae-transport-sep" />
            <button
              className="ae-btn ae-tbtn"
              onClick={openSpeed}
              disabled={empty || !!busy}
              title="变速不变调：对选区或整段调整播放速度，音高不变"
            >
              <Icon name="speed" size={16} /> 变速
            </button>
          </div>
        </div>
      </section>

      {/* 时间线片段 */}
      {!empty && (
        <section className="ae-card">
          <div className="ae-card-head">
            <h3>时间线片段</h3>
            <span className="ae-card-hint">
              共 {segments.length} 段 · 总时长 {fmtDur(totalDur)}
            </span>
            <button className="ae-clear" onClick={resetAll}>清空全部</button>
          </div>
          <ol className="ae-segments">
            {segments.map((seg, i) => (
              <li key={`${i}-${seg.sourceId}-${seg.start}`} className={isSilence(seg) ? 'ae-seg ae-seg-silence' : 'ae-seg'}>
                <span className="ae-seg-idx">{i + 1}</span>
                <span className="ae-seg-label">{seg.label}</span>
                <span className="ae-seg-time">{fmtDur(seg.end - seg.start)}</span>
                <button className="ae-seg-del" aria-label={`删除片段 ${i + 1}`} title="删除此片段（可撤销）" onClick={() => deleteSegment(i)}>
                  <Icon name="trash" size={14} />
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* ③ 导出 */}
      <section className="ae-card">
        <div className="ae-card-head">
          <h3>③ 导出</h3>
          <span className="ae-card-hint">长音频 MP3 编码约需十几秒到几十秒，请等进度条走完</span>
        </div>
        <div className="ae-export-row">
          <input
            className="ae-filename"
            value={fileName}
            placeholder="listening-edited"
            onChange={(e) => setFileName(e.target.value)}
          />
          <span className="ae-ext">.{exportFormat}</span>
          <select
            className="ae-format"
            value={exportFormat}
            onChange={(e) => setExportFormat(e.target.value === 'wav' ? 'wav' : 'mp3')}
          >
            <option value="mp3">MP3（128kbps，推荐）</option>
            <option value="wav">WAV（无损，文件较大）</option>
          </select>
          <button className="ae-btn ae-btn-primary" disabled={empty || !!busy} onClick={() => void doExport()}>
            <Icon name="download" size={16} /> 导出音频
          </button>
        </div>
        {progress > 0 && (
          <div className="ae-progress">
            <div style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
        <p className="ae-footnote">
          提示：空格键播放 / 暂停，← / → 方向键快退 / 快进 5 秒；不同采样率的片段拼接与导出时会自动重采样统一；
          撤销 / 重做保留最近 50 步；编辑进度自动保存在本机浏览器（可随时「清除音频」）；
          音频只在本机处理，不会上传服务器（合成语音的文字输入除外）。
        </p>
      </section>

      {/* 变速（不变调）弹窗 */}
      {speedOpen && (
        <div
          className="ae-speed-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeSpeed();
          }}
        >
          <div className="ae-speed-pop" role="dialog" aria-modal="true" aria-label="变速（不变调）">
            <div className="ae-speed-head">
              <h3><Icon name="speed" size={16} /> 变速（不变调）</h3>
              <button className="ae-speed-close" aria-label="关闭变速" onClick={closeSpeed}>
                ✕
              </button>
            </div>
            <div className="ae-speed-body">
              <div className="ae-speed-row">
                <span className="ae-speed-label">作用范围</span>
                <label className={hasSelection ? 'ae-speed-radio' : 'ae-speed-radio is-disabled'}>
                  <input
                    type="radio"
                    name="ae-speed-scope"
                    checked={speedScope === 'selection'}
                    disabled={!hasSelection || !!busy}
                    onChange={() => changeSpeedScope('selection')}
                  />
                  当前选区
                </label>
                <label className="ae-speed-radio">
                  <input
                    type="radio"
                    name="ae-speed-scope"
                    checked={speedScope === 'whole'}
                    disabled={!!busy}
                    onChange={() => changeSpeedScope('whole')}
                  />
                  整段时间线
                </label>
                {!hasSelection && <span className="ae-speed-hint">未框选区段，仅可对整段变速</span>}
              </div>
              <div className="ae-speed-row">
                <span className="ae-speed-label">速度</span>
                <div className="ae-speed-presets">
                  {SPEED_PRESETS.map((p) => (
                    <button
                      key={p}
                      className={Math.abs(speedTempo - p) < 0.001 ? 'ae-speed-preset is-active' : 'ae-speed-preset'}
                      disabled={!!busy}
                      onClick={() => applySpeedTempo(p)}
                    >
                      {fmtTempo(p)}×
                    </button>
                  ))}
                </div>
                <span className="ae-speed-num-wrap">
                  <input
                    className="ae-speed-num"
                    type="number"
                    min={MIN_TEMPO}
                    max={MAX_TEMPO}
                    step={0.05}
                    value={speedTempoInput}
                    aria-label="自定义速度（0.5–2.0）"
                    disabled={!!busy}
                    onChange={(e) => onSpeedInput(e.target.value)}
                    onBlur={() => setSpeedTempoInput(fmtTempo(speedTempo))}
                  />
                  ×
                </span>
              </div>
              <div className="ae-speed-dur">
                预计时长：{fmtClock(speedScopeDur)} → {fmtClock(speedAfterDur)}
                （{speedAfterDur - speedScopeDur >= 0 ? '+' : ''}
                {Math.round(speedAfterDur - speedScopeDur)}s）
              </div>
              <div className="ae-speed-actions">
                <button
                  className="ae-btn ae-tbtn"
                  disabled={!!busy}
                  onClick={() => (speedPreviewing ? stopSpeedPreview() : void startSpeedPreview())}
                >
                  {speedPreviewing ? '⏹ 停止试听' : '▶ 试听'}
                </button>
                <button
                  className="ae-btn ae-tbtn ae-btn-primary"
                  disabled={!!busy || speedTempo === 1}
                  title={speedTempo === 1 ? '速度为 1× 时无需变速' : undefined}
                  onClick={() => void applySpeed()}
                >
                  应用变速
                </button>
                {speedPreviewing && <span className="ae-speed-hint">试听中，调整速度立即生效</span>}
              </div>
              <p className="ae-speed-note">
                变速只改变快慢，不改变音高。试听：选区模式从选区开头循环播放，整段模式从当前播放头播到结尾；
                试听中调整速度立即生效。应用后波形与时间轴按新时长重建，可撤销（↩），编辑进度自动保存。
              </p>
            </div>
          </div>
        </div>
      )}
      {/* 合成语音（TTS）弹窗：样式骨架复用变速弹窗（ae-speed-*） */}
      {ttsOpen && (
        <div
          className="ae-speed-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeTts();
          }}
        >
          <div className="ae-speed-pop" role="dialog" aria-modal="true" aria-label="合成语音">
            <div className="ae-speed-head">
              <h3><Icon name="voice" size={16} /> 合成语音</h3>
              <button className="ae-speed-close" aria-label="关闭合成语音" onClick={closeTts}>
                ✕
              </button>
            </div>
            <div className="ae-speed-body">
              <div>
                <textarea
                  className="ae-tts-text"
                  value={ttsText}
                  rows={4}
                  maxLength={TTS_MAX_CHARS}
                  placeholder="输入要合成的文字，如：某某学校高三上期第一次月考，英语听力部分。"
                  disabled={ttsBusy}
                  onChange={(e) => setTtsText(e.target.value)}
                />
                <div className="ae-tts-count">
                  {Array.from(ttsText).length} / {TTS_MAX_CHARS}
                </div>
              </div>
              <div className="ae-speed-row">
                <span className="ae-speed-label">声音</span>
                <label className="ae-speed-radio">
                  <input
                    type="radio"
                    name="ae-tts-voice"
                    checked={ttsVoice === 'male'}
                    disabled={ttsBusy}
                    onChange={() => setTtsVoice('male')}
                  />
                  男声 · 艾达
                </label>
                <label className="ae-speed-radio">
                  <input
                    type="radio"
                    name="ae-tts-voice"
                    checked={ttsVoice === 'female'}
                    disabled={ttsBusy}
                    onChange={() => setTtsVoice('female')}
                  />
                  女声 · 艾佳
                </label>
              </div>
              <div className="ae-speed-row">
                <span className="ae-speed-label">语速</span>
                <div className="ae-speed-presets">
                  {TTS_RATES.map((r) => (
                    <button
                      key={r.value}
                      className={ttsRate === r.value ? 'ae-speed-preset is-active' : 'ae-speed-preset'}
                      disabled={ttsBusy}
                      onClick={() => setTtsRate(r.value)}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>
              {ttsError && <p className="ae-tts-error" role="alert">{ttsError}</p>}
              {ttsResult && <audio className="ae-tts-preview" controls preload="auto" src={ttsResult.url} />}
              <div className="ae-speed-actions">
                <button
                  className="ae-btn ae-tbtn ae-btn-primary"
                  disabled={ttsBusy || !ttsText.trim()}
                  onClick={() => void generateTts()}
                >
                  {ttsBusy ? '正在合成…' : ttsResult ? '重新生成' : '生成预览'}
                </button>
                <button
                  className="ae-btn ae-tbtn"
                  disabled={ttsBusy || !ttsResult || !!busy}
                  title={`插入到${insertHint}`}
                  onClick={() => void insertTtsResult()}
                >
                  <Icon name="plus" size={16} /> 插入到{insertHint}
                </button>
              </div>
              <p className="ae-speed-note">
                合成后先试听，再插入到选区起点 / 播放头，插入后可撤销（↩）。输入的文字会发送到服务器合成音频；
                你的原始听力音频仍只在本机处理，不会上传。
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
