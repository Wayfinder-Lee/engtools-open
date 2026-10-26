/**
 * 听力剪辑 · 时间线模型与纯函数操作
 *
 * 片段（EditSegment）= 引用某个已解码音源的一段时间范围；静音片段没有音源，
 * 拼接时直接写 0。所有编辑操作都在「拼接后时间线」坐标上进行（即波形上看到的
 * 位置），跨越选区边界的片段会被拆开，保证片段数组与波形所见一一对应。
 */

export interface EditSegment {
  /** 对应 sources Map 的 key；静音片段固定为 SILENCE_ID */
  sourceId: string;
  /** 源内时间范围（秒） */
  start: number;
  end: number;
  /** 片段列表里显示的名字（文件名 / 模板名 / 静音） */
  label: string;
}

/** 静音片段的占位 sourceId：没有对应 AudioBuffer，拼接时写 0 */
export const SILENCE_ID = '__silence__';

export interface SourceEntry {
  /** 显示名（去扩展名的文件名 / 模板显示名） */
  name: string;
  buffer: AudioBuffer;
  /** 原始音频 Blob（用户文件 / 模板响应），用于本地会话自动保存；静默丢失时该源不可持久化 */
  blob?: Blob;
}

export const isSilence = (seg: EditSegment): boolean => seg.sourceId === SILENCE_ID;

/** 造一段静音片段 */
export function makeSilence(dur: number, label: string): EditSegment {
  return { sourceId: SILENCE_ID, start: 0, end: dur, label };
}

/** 时间线总时长（秒） */
export function timelineDuration(segments: EditSegment[]): number {
  return segments.reduce((acc, s) => acc + (s.end - s.start), 0);
}

/** 拆分片段时保留的最小长度（秒），避免产生不可见的碎片 */
const EPS = 1e-4;

/** 求 [t0, t1) 覆盖的片段（返回源坐标）——「保留所选」 */
export function resolveRange(segments: EditSegment[], t0: number, t1: number): EditSegment[] {
  const out: EditSegment[] = [];
  let off = 0;
  for (const s of segments) {
    const dur = s.end - s.start;
    const a = Math.max(t0, off);
    const b = Math.min(t1, off + dur);
    if (b - a > EPS) out.push({ ...s, start: s.start + (a - off), end: s.start + (b - off) });
    off += dur;
  }
  return out;
}

/** 从时间线挖掉 [t0, t1)，边界两侧的同一段拆开保留 ——「剪切删除所选」 */
export function removeRange(segments: EditSegment[], t0: number, t1: number): EditSegment[] {
  const out: EditSegment[] = [];
  let off = 0;
  for (const s of segments) {
    const dur = s.end - s.start;
    const a = Math.max(t0, off);
    const b = Math.min(t1, off + dur);
    if (b - a <= EPS) {
      out.push({ ...s }); // 与选区无交集，整段保留
    } else {
      if (a - off > EPS) out.push({ ...s, end: s.start + (a - off) });
      if (off + dur - b > EPS) out.push({ ...s, start: s.start + (b - off) });
    }
    off += dur;
  }
  return out;
}

/** 在时间线位置 t 插入一个片段（静音 / 模板素材）；t 超出总时长则追加到末尾 */
export function insertSegmentAt(segments: EditSegment[], t: number, seg: EditSegment): EditSegment[] {
  if (segments.length === 0) return [seg];
  const out: EditSegment[] = [];
  let off = 0;
  let inserted = false;
  for (const s of segments) {
    const dur = s.end - s.start;
    if (!inserted && t <= off + dur) {
      const cut = Math.min(Math.max(t - off, 0), dur);
      if (cut > EPS) out.push({ ...s, end: s.start + cut });
      out.push(seg);
      if (dur - cut > EPS) out.push({ ...s, start: s.start + cut });
      inserted = true;
    } else {
      out.push({ ...s });
    }
    off += dur;
  }
  if (!inserted) out.push(seg);
  return out;
}

// ─── 解码与拼接 ───────────────────────────────────────────

let sharedCtx: AudioContext | null = null;

/** 共享 AudioContext：只用于解码文件与创建 AudioBuffer，播放走 wavesurfer 的媒体元素；
 *  组件卸载 close 后再次调用会自动重建（浏览器对并发 AudioContext 数有限制，用完即还） */
export function getSharedAudioContext(): AudioContext {
  if (!sharedCtx || sharedCtx.state === 'closed') sharedCtx = new AudioContext();
  return sharedCtx;
}

/** 关闭共享 AudioContext（组件卸载时调用，避免资源泄漏） */
export function closeSharedAudioContext(): void {
  const ctx = sharedCtx;
  sharedCtx = null;
  if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => {});
}

/** 用 OfflineAudioContext 把 buffer 重采样到目标采样率（不同采样率片段拼接前统一） */
export async function resampleBuffer(buffer: AudioBuffer, targetRate: number): Promise<AudioBuffer> {
  const frames = Math.max(1, Math.ceil(buffer.duration * targetRate));
  const offline = new OfflineAudioContext(Math.min(buffer.numberOfChannels, 2), frames, targetRate);
  const src = offline.createBufferSource();
  src.buffer = buffer;
  src.connect(offline.destination);
  src.start();
  return offline.startRendering();
}

/**
 * 把片段数组按序拼接成一个 AudioBuffer。
 * 采样率统一用第一个有声片段的源采样率，其余源自动重采样；
 * 声道数取各源最大值并封顶 2（单声道并入立体声复制两份，立体声并入单声道取左声道）。
 * 时间线为空或全是静音时返回 null。
 */
export async function assembleTimeline(
  segments: EditSegment[],
  sources: Map<string, SourceEntry>,
): Promise<AudioBuffer | null> {
  const anchorSeg = segments.find((s) => !isSilence(s));
  if (!anchorSeg) return null;
  const anchor = sources.get(anchorSeg.sourceId);
  if (!anchor) return null;
  const rate = anchor.buffer.sampleRate;

  let channels = 1;
  for (const s of segments) {
    const entry = sources.get(s.sourceId);
    if (entry) channels = Math.max(channels, Math.min(entry.buffer.numberOfChannels, 2));
  }

  // 逐段累计目标帧数，在累计值上取整，避免逐段取整产生的累积误差
  const frameLens: number[] = [];
  let total = 0;
  let acc = 0;
  for (const s of segments) {
    acc += (s.end - s.start) * rate;
    const rounded = Math.round(acc);
    frameLens.push(rounded - total);
    total = rounded;
  }

  const out = getSharedAudioContext().createBuffer(channels, Math.max(1, total), rate);
  const resampled = new Map<string, AudioBuffer>(); // sourceId → 已统一到目标采样率的 buffer
  let writePos = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const len = frameLens[i];
    if (!isSilence(seg)) {
      const entry = sources.get(seg.sourceId);
      if (entry) {
        let buf = entry.buffer;
        if (buf.sampleRate !== rate) {
          let hit = resampled.get(seg.sourceId);
          if (!hit) {
            hit = await resampleBuffer(buf, rate);
            resampled.set(seg.sourceId, hit);
          }
          buf = hit;
        }
        const startFrame = Math.round(seg.start * rate);
        const endFrame = Math.min(buf.length, Math.round(seg.end * rate));
        const copyLen = Math.max(0, Math.min(len, endFrame - startFrame, out.length - writePos));
        for (let ch = 0; ch < channels; ch++) {
          const data = buf.getChannelData(Math.min(ch, buf.numberOfChannels - 1));
          if (copyLen > 0) out.copyToChannel(data.subarray(startFrame, startFrame + copyLen), ch, writePos);
        }
      }
    }
    writePos += len;
  }
  return out;
}
