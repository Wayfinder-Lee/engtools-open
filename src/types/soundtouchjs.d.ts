/**
 * soundtouchjs 0.3.0 未附带 TypeScript 类型声明，本文件按 dist/soundtouch.js
 * 的实际实现手写，只声明本项目用到的成员（变速不变调：离线 stretch + 实时试听）。
 * 注意其内部按交织立体声帧（左/右成对）处理样本；pitch/rate 保持 1 时仅 tempo 生效。
 */
declare module 'soundtouchjs' {
  /** 适配 AudioBuffer 的样本源：extract 把左右声道交织写入 target */
  export class WebAudioBufferSource {
    constructor(buffer: AudioBuffer);
    /** 返回实际可取的帧数（不足 numFrames 时为剩余数，耗尽后为 0） */
    extract(target: Float32Array, numFrames?: number, position?: number): number;
  }

  /** WSOLA 拉伸内核；sampleRate 影响序列 / 搜索窗口长度估计 */
  export class Stretch {
    setParameters(sampleRate: number, sequenceMs: number, seekWindowMs: number, overlapMs: number): void;
  }

  /** rate / tempo / pitch 三参滤波内核；pitch=1 且 rate=1 时仅做 time-stretch */
  export class SoundTouch {
    set tempo(value: number);
    set rate(value: number);
    set pitch(value: number);
    readonly stretch: Stretch;
  }

  /** 手动驱动的滤波链：循环 extract 直到返回 0（源耗尽） */
  export class SimpleFilter {
    constructor(sourceSound: WebAudioBufferSource, pipe: SoundTouch, callback?: () => void);
    /** 从输出缓冲取交织帧，返回实际取得的帧数 */
    extract(target: Float32Array, numFrames?: number): number;
    get sourcePosition(): number;
    set sourcePosition(position: number);
  }

  /** 实时试听链：ScriptProcessorNode 源节点，connect 到 destination 即自动播放 */
  export class PitchShifter {
    constructor(context: AudioContext, buffer: AudioBuffer, bufferSize: number, onEnd?: () => void);
    /** 播放中可实时修改，立即生效 */
    set tempo(value: number);
    set rate(value: number);
    set pitch(value: number);
    duration: number;
    timePlayed: number;
    /** 播放进度百分比（读写，写入即跳转源位置；按 context 采样率换算） */
    percentagePlayed: number;
    readonly node: AudioNode;
    connect(toNode: AudioNode): void;
    disconnect(): void;
    on(eventName: string, cb: (detail: unknown) => void): void;
    off(eventName?: string): void;
  }
}
