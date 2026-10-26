/**
 * 听力剪辑 · 变速不变调（SoundTouch time-stretch）
 *
 * soundtouchjs 按需动态 import（主包零增重）。两条通路共用同一算法内核：
 * - 正式应用：SimpleFilter + WebAudioBufferSource 手动全量离线处理（stretchAudioBuffer），
 *   输出长度 ≈ 原长 / tempo，采样率与声道数不变；CPU 密集，分块让出主线程；
 * - 弹窗试听：PitchShifter 实时滤波链接到 destination（createSpeedPreview），
 *   播放中改 tempo 立即生效，无需重播。
 *
 * 内部一律按交织立体声帧处理（左 / 右成对），单声道源会被复制成双声道再取左路，
 * 与库的实现保持一致；声道数封顶 2（>2 声道的源并前两路，与拼接逻辑口径相同）。
 */
import { getSharedAudioContext } from './audioEdit';

/** 允许的变速范围（ tempo < 1 放慢、> 1 加快，音高均不变） */
export const MIN_TEMPO = 0.5;
export const MAX_TEMPO = 2.0;

/** 钳到合法变速范围；非法输入按 1 处理 */
export function clampTempo(tempo: number): number {
  if (!Number.isFinite(tempo) || tempo <= 0) return 1;
  return Math.min(MAX_TEMPO, Math.max(MIN_TEMPO, tempo));
}

/** 速度显示：1.25 → "1.25"（去掉浮点噪声，用于按钮与输入框回显） */
export function fmtTempo(tempo: number): string {
  return String(parseFloat(tempo.toFixed(2)));
}

/** 取 AudioBuffer 的一段切片（秒），用于选区变速与试听起点 */
export function sliceAudioBuffer(buffer: AudioBuffer, startSec: number, endSec: number): AudioBuffer {
  const rate = buffer.sampleRate;
  const channels = Math.min(buffer.numberOfChannels, 2);
  const s = Math.max(0, Math.floor(startSec * rate));
  const e = Math.min(buffer.length, Math.ceil(endSec * rate));
  const len = Math.max(1, e - s);
  const out = getSharedAudioContext().createBuffer(channels, len, rate);
  for (let c = 0; c < channels; c++) {
    const src = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1)).subarray(s, e);
    out.copyToChannel(src, c);
  }
  return out;
}

/** 每次提取的帧数（≈0.19s@44.1kHz 的输出） */
const STRETCH_BLOCK = 8192;
/** 每处理多少块让出一次主线程（≈3s 音频一次，保证 UI 不卡） */
const YIELD_EVERY = 16;

/**
 * 离线变速不变调：SimpleFilter 全量处理，输出长度 ≈ 原长 / tempo。
 * 尾部不足一个处理窗口（约 0.1–0.2s）的样本不会吐出，属算法固有行为；
 * 输出按实际产出帧数精确裁剪，不会带静音尾巴。onProgress 上报 0..1。
 */
export async function stretchAudioBuffer(
  buffer: AudioBuffer,
  tempo: number,
  onProgress?: (p: number) => void,
): Promise<AudioBuffer> {
  const t = clampTempo(tempo);
  const ctx = getSharedAudioContext();
  const channels = Math.min(buffer.numberOfChannels, 2);
  if (t === 1) {
    // 1× 无需处理，直接拷贝（保持调用方「拿到新 buffer」的约定）
    const copy = ctx.createBuffer(channels, buffer.length, buffer.sampleRate);
    for (let c = 0; c < channels; c++) {
      copy.copyToChannel(buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1)), c);
    }
    return copy;
  }

  const { SoundTouch, WebAudioBufferSource, SimpleFilter } = await import('soundtouchjs');
  const st = new SoundTouch();
  // Stretch 构造时按 44100Hz 估计窗口长度，对齐到实际采样率更稳
  st.stretch.setParameters(buffer.sampleRate, 0, 0, 8);
  st.tempo = t;
  const filter = new SimpleFilter(new WebAudioBufferSource(buffer), st);

  // 预估输出帧数 + 0.3s 尾部留量（上限约 0.15s，见上），实际按产出裁剪
  const estFrames = Math.ceil(buffer.length / t) + Math.ceil(buffer.sampleRate * 0.3);
  const out = ctx.createBuffer(channels, estFrames, buffer.sampleRate);
  // 标注具体到 ArrayBuffer：copyToChannel 不收 ArrayBufferLike
  const chans: Float32Array<ArrayBuffer>[] = [];
  for (let c = 0; c < channels; c++) chans.push(out.getChannelData(c));
  const scratch = new Float32Array(STRETCH_BLOCK * 2); // 交织立体声
  let written = 0;
  let sinceYield = 0;
  while (written < estFrames) {
    const want = Math.min(STRETCH_BLOCK, estFrames - written);
    const got = filter.extract(scratch, want);
    if (got <= 0) break; // 源耗尽
    for (let i = 0; i < got; i++) {
      const at = written + i;
      chans[0][at] = scratch[i * 2];
      if (channels > 1) chans[1][at] = scratch[i * 2 + 1];
    }
    written += got;
    if (++sinceYield >= YIELD_EVERY) {
      sinceYield = 0;
      onProgress?.(written / estFrames);
      await new Promise((resolve) => setTimeout(resolve));
    }
  }
  onProgress?.(1);
  if (written >= estFrames) return out;
  // 实际产出略短于预估：裁掉尾部留量
  const trimmed = ctx.createBuffer(channels, Math.max(1, written), buffer.sampleRate);
  for (let c = 0; c < channels; c++) trimmed.copyToChannel(chans[c].subarray(0, written), c);
  return trimmed;
}

/** 实时试听控制器 */
export interface SpeedPreview {
  /** 播放中改速度，立即生效 */
  setTempo(tempo: number): void;
  /** 停止并断开音频节点（幂等） */
  stop(): void;
}

/** PitchShifter 实例类型（构造函数从动态 import 解构，类型名单独引以免被值遮蔽） */
type PitchShifterHandle = import('soundtouchjs').PitchShifter;

/**
 * 创建实时试听链：PitchShifter（ScriptProcessor 源节点）→ destination。
 * loop=true 时播完自动从头循环（选区试听）；否则播到结尾自然停止并回调 onEnded。
 */
export async function createSpeedPreview(
  buffer: AudioBuffer,
  tempo: number,
  loop: boolean,
  onEnded?: () => void,
): Promise<SpeedPreview> {
  const { PitchShifter } = await import('soundtouchjs');
  const ctx = getSharedAudioContext();
  // 共享 ctx 平时只用于解码，可能处于 suspended；试听来自用户手势，顺手唤醒
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});

  let stopped = false;
  let ended = false;
  let shifter: PitchShifterHandle | null = null;
  const stopInternal = () => {
    // ctx 可能已被组件卸载关闭，disconnect 包一层保护
    try {
      shifter?.disconnect();
    } catch {
      /* 上下文已关闭 */
    }
    shifter = null;
  };
  shifter = new PitchShifter(ctx, buffer, 2048, () => {
    if (stopped || !shifter) return;
    if (loop) {
      shifter.percentagePlayed = 0; // 回到开头继续（循环间隙约一个处理块）
    } else if (!ended) {
      ended = true;
      stopInternal();
      onEnded?.();
    }
  });
  shifter.tempo = clampTempo(tempo);
  shifter.connect(ctx.destination);
  return {
    setTempo(tempo: number) {
      if (!stopped && shifter) shifter.tempo = clampTempo(tempo);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      stopInternal();
    },
  };
}
