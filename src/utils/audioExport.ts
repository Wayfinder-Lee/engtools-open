/**
 * 听力剪辑 · 导出编码器
 * WAV：16bit PCM，手写 RIFF 头，无依赖；
 * MP3：@breezystack/lamejs（纯 JS 维护分支）动态 import 按需加载，128kbps。
 *      编码在主线程分块进行，每若干块让出一次事件循环，进度条才能刷新、页面不卡死。
 */
import { resampleBuffer } from './audioEdit';

export const MP3_KBPS = 128;

/** lamejs 只认这组采样率；其它采样率先重采样到 44100 再编码 */
const MP3_SUPPORTED_RATES = new Set([8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000]);

/** Float32 [-1, 1] → Int16（lamejs 的 encodeBuffer 入参是 Int16Array） */
function floatToInt16(src: Float32Array, start: number, count: number): Int16Array {
  const n = Math.max(0, Math.min(count, src.length - start));
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, src[start + i]));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

/** 16bit PCM WAV 编码 */
export function encodeWav(buffer: AudioBuffer): Blob {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const dataSize = frames * channels * 2;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt 块长度
  view.setUint16(20, 1, true); // 线性 PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true); // byteRate
  view.setUint16(32, channels * 2, true); // blockAlign
  view.setUint16(34, 16, true); // 位深
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  const data: Float32Array[] = [];
  for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));
  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, data[c][i]));
      view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

/** MP3 编码（128kbps）。onProgress 上报 0..1；采样率不受 lamejs 支持时自动重采样到 44100 */
export async function encodeMp3(buffer: AudioBuffer, onProgress?: (p: number) => void): Promise<Blob> {
  const { Mp3Encoder } = await import('@breezystack/lamejs');
  const rate = MP3_SUPPORTED_RATES.has(buffer.sampleRate) ? buffer.sampleRate : 44100;
  const source = buffer.sampleRate === rate ? buffer : await resampleBuffer(buffer, rate);
  const channels = Math.min(2, source.numberOfChannels);
  const encoder = new Mp3Encoder(channels, rate, MP3_KBPS);
  const left = source.getChannelData(0);
  const right = channels > 1 ? source.getChannelData(1) : null;
  const blockSize = 1152 * 20; // 每块约 0.5 秒音频
  const parts: BlobPart[] = [];
  let sinceYield = 0;
  for (let i = 0; i < source.length; i += blockSize) {
    const l = floatToInt16(left, i, blockSize);
    const chunk = right ? encoder.encodeBuffer(l, floatToInt16(right, i, blockSize)) : encoder.encodeBuffer(l);
    // 包一层新 Uint8Array（显式 ArrayBuffer 背书），同时满足 BlobPart 的类型要求
    if (chunk.length > 0) parts.push(new Uint8Array(chunk));
    onProgress?.(Math.min(1, (i + blockSize) / source.length));
    // 每 10 块（约 5 秒音频）让出主线程一次
    if (++sinceYield >= 10) {
      sinceYield = 0;
      await new Promise((resolve) => setTimeout(resolve));
    }
  }
  const tail = encoder.flush();
  if (tail.length > 0) parts.push(new Uint8Array(tail));
  return new Blob(parts, { type: 'audio/mpeg' });
}
